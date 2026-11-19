// Real keyboard and pointer navigation across quote rows in the public editor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_QUOTE_NAV_PORT ?? 4323), debugPort=Number(process.env.JOT_QUOTE_NAV_DEBUG_PORT ?? 9523);
const profile=mkdtempSync(resolve(tmpdir(),'jot-quote-nav-'));
let server,chrome,c;
const browserErrors=[];
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}`)).webSocketDebuggerUrl);
  c.socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.method==='Runtime.exceptionThrown')browserErrors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text)});
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
  const wait=(expression,timeout=30000)=>waitForEvaluation(c,expression,timeout);
  const frame=()=>c.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await wait(`document.readyState==='complete' && document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor,createHeadingFoldPlugin}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='quote-nav';root.style.cssText='width:800px;height:700px;margin:10px';document.body.replaceChildren(root);
    window.errors=[];window.worker=new Worker('/src/worker.ts',{type:'module'});
    window.editor=new MarkdownEditor({root,mode:'live-preview',plugins:[createHeadingFoldPlugin()],session:{endpoint:worker,documentId:'quote-nav',generation:1,source:'',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>errors.push(String(e))});
    await editor.open();await editor.setPluginEnabled('heading-fold',false);window.view=editor.input.view;
  })()`);
  const load=async source=>{
    await c.evaluate(`editor.setValue(${JSON.stringify(source)})`);
    await c.evaluate('editor.settled()');
    await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
    await frame();
  };
  const position=async at=>{await c.evaluate(`editor.input.setSelection(${at});editor.focus()`);await frame()};
  const key=async(name,modifiers=0)=>{
    for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:name,code:name,modifiers});
    await frame();
  };
  const state=()=>c.evaluate(`(()=>{const s=view.state.selection.main,l=view.state.doc.lineAt(s.head),r=view.coordsAtPos(s.head),u=view.moveVertically(s,false),d=view.moveVertically(s,true);return{head:s.head,anchor:s.anchor,line:l.number,text:l.text,caret:r&&{left:r.left,top:r.top,bottom:r.bottom},up:{head:u.head,line:view.state.doc.lineAt(u.head).number},down:{head:d.head,line:view.state.doc.lineAt(d.head).number},rows:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>{const q=n.getBoundingClientRect(),p=view.state.doc.lineAt(view.posAtDOM(n,0)),coord=view.coordsAtPos(p.to);return{line:p.number,text:p.text,visible:n.innerText,depth:n.dataset.jotQuoteDepth,top:q.top,height:q.height,padding:getComputedStyle(n).paddingInlineStart,coordinate:coord&&{left:coord.left,top:coord.top,bottom:coord.bottom},point:view.posAtCoords({x:q.left+parseFloat(getComputedStyle(n).paddingInlineStart),y:q.top+q.height/2},false),html:n.dataset.jotQuoteMarkerOnly?n.outerHTML:undefined}})}})()`);

  const source='前文\n\n> 第一行\n>>>> 第二行\n> 第三行\n>>>> 第四行\n> 第五行\n\n后文';
  await load(source);
  const cases=[
    {from:'第三行',key:'ArrowUp',to:'第二行'},
    {from:'第三行',key:'ArrowDown',to:'第四行'},
    {from:'第二行',key:'ArrowUp',to:'第一行'},
    {from:'第四行',key:'ArrowDown',to:'第五行'},
  ];
  for(const item of cases){
    await position(source.indexOf(item.from));
    const before=await state();await key(item.key);const after=await state();
    if(process.env.JOT_QUOTE_NAV_TRACE)console.log(JSON.stringify({item,before,after}));
    assert(after.text.includes(item.to),`${item.from} ${item.key} should visit ${item.to}: ${JSON.stringify({before,after})}`);
  }

  // An empty nested quote is still a visible, editable physical row.
  await c.evaluate(`editor.setLayoutStyle({fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',fontSize:16,metrics:{paragraphLineHeight:26,blankLineHeight:22,listIndent:26}})`);
  const empty='前文\n\n> 状态：上层引用。\n> >>>\n> >>>>适用范围：**多层引用**、`TableGrid` 和中文输入。\n> >>>>>>七层引用\n> > - [ ] 引用中的任务\n> 回到第一层。\n\n后文';
  await load(empty);
  for(const item of [
    {from:'状态：',key:'ArrowDown',to:'> >>>'},
    {from:'适用范围',key:'ArrowUp',to:'> >>>'},
  ]){
    await position(empty.indexOf(item.from));const before=await state();await key(item.key);const after=await state();
    if(process.env.JOT_QUOTE_NAV_TRACE)console.log(JSON.stringify({empty:item,before,after}));
    assert.equal(after.text,item.to,`${item.from} ${item.key} should visit the empty quote: ${JSON.stringify({before,after})}`);
    const row=after.rows.find(row=>row.text===item.to);
    assert.equal(after.head,empty.indexOf(item.to)+item.to.length,'the caret lands after the hidden prefix');
    assert(row && Math.abs(row.height-26)<1,'a blank quote uses the configured paragraph line height');
    assert(after.caret && after.caret.bottom>after.caret.top && after.caret.top>=row.top && after.caret.bottom<=row.top+row.height,
      `the blank quote owns an actual caret box: ${JSON.stringify(after)}`);
  }

  const clickRow=async text=>{
    const point=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>view.state.doc.lineAt(view.posAtDOM(n,0)).text===${JSON.stringify(text)}),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{x:r.left+parseFloat(s.paddingInlineStart)+1,y:(r.top+r.bottom)/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await frame();
  };
  const beforeClick=await state();await clickRow('> >>>');
  let clicked=await state();
  assert.equal(clicked.head,empty.indexOf('> >>>\n')+'> >>>'.length,'a real mouse click lands in the empty quote');
  assert(clicked.caret && clicked.caret.bottom>clicked.caret.top,'a clicked empty quote has nonzero caret geometry');
  assert.deepEqual(clicked.rows.map(row=>[row.text,row.top,row.height]),beforeClick.rows.map(row=>[row.text,row.top,row.height]),'clicking a blank quote does not move any row');
  await c.command('Input.insertText',{text:'字'});
  await wait(`editor.value.includes('> >>>字\\n') && editor.value===editor.confirmedValue`);
  assert.equal(await c.evaluate('editor.value'),empty.replace('> >>>\n','> >>>字\n'),'typing in a clicked blank quote changes only that row');
  const mod=await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')?4:2;
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:mod});
  await wait(`editor.value===${JSON.stringify(empty)} && editor.value===editor.confirmedValue`);
  await frame();
  const restored=await state();
  assert.deepEqual(restored.rows.map(row=>[row.text,row.top,row.height]),beforeClick.rows.map(row=>[row.text,row.top,row.height]),'undo restores the blank quote geometry');

  await position(empty.indexOf('状态：'));const anchor=(await state()).head;
  await key('ArrowDown',8);const selectedEmpty=await state();
  assert.equal(selectedEmpty.anchor,anchor,'Shift+Down preserves the selection anchor');
  assert.equal(selectedEmpty.text,'> >>>','Shift+Down extends to the empty quote');
  await key('ArrowDown',8);const selectedNext=await state();
  assert.equal(selectedNext.anchor,anchor,'a second Shift+Down preserves the selection anchor');
  assert(selectedNext.text.includes('适用范围'),'a second Shift+Down extends to the next quote');
  await position(empty.indexOf('适用范围')+2);const reverseAnchor=(await state()).head;
  await key('ArrowUp',8);const selectedUp=await state();
  assert.equal(selectedUp.anchor,reverseAnchor,'Shift+Up preserves the selection anchor');
  assert.equal(selectedUp.text,'> >>>','Shift+Up extends to the empty quote');

  const consecutive='前文\n\n> 开始\n>\n>>\n>>   \n>>>\n>>>>\n> 结束\n\n后文';
  await load(consecutive);await position(consecutive.indexOf('开始'));
  for(const expected of ['>','>>','>>   ','>>>','>>>>','> 结束']){
    await key('ArrowDown');const current=await state();
    assert.equal(current.text,expected,`Down visits consecutive quote row ${expected}: ${JSON.stringify(current)}`);
    assert(current.caret && current.caret.bottom>current.caret.top,'every quote row has a caret box');
  }
  for(const expected of ['>>>>','>>>','>>   ','>>','>','> 开始']){
    await key('ArrowUp');const current=await state();
    assert.equal(current.text,expected,`Up visits consecutive quote row ${expected}: ${JSON.stringify(current)}`);
  }

  // The single empty quote includes outer padding once, with the same height
  // in Live Preview and Preview even when blank and paragraph metrics differ.
  const emptyRoot='前文\n\n>>>>\n\n后文';
  await load(emptyRoot);await position(emptyRoot.indexOf('>>>>')+4);
  const liveEmpty=(await state()).rows.find(row=>row.text==='>>>>');
  await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.settled()');
  await wait(`!!document.querySelector('.jot-editor-surface blockquote')`);await frame();
  const previewEmpty=await c.evaluate(`document.querySelector('.jot-editor-surface blockquote').getBoundingClientRect().height`);
  assert(liveEmpty && Math.abs(liveEmpty.height-previewEmpty)<1,`empty root geometry agrees with Preview: ${JSON.stringify({liveEmpty,previewEmpty})}`);
  await c.evaluate(`editor.setMode('live-preview')`);await c.evaluate('editor.settled()');

  // Long text stays one source line but several visual rows. Navigate the
  // actual DOM line boxes, not an assumed number of source characters.
  const body='长引用文本不能跳行'.repeat(18), wrapped=`前文\n\n>>>> ${body}\n\n后文`;
  await c.evaluate(`document.querySelector('#quote-nav').style.width='340px'`);
  for(const fontFamily of ['sans-serif','serif','monospace']){
    await c.evaluate(`editor.setLayoutStyle({fontFamily:${JSON.stringify(fontFamily)}})`);
    await load(wrapped);await position(wrapped.indexOf(body)+2);
    const rects=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes(${JSON.stringify(body)})),w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while((t=w.nextNode()))if(t.nodeValue.includes(${JSON.stringify(body)}))break;if(!t)throw Error('missing wrapped quote text');const r=document.createRange();r.selectNodeContents(t);return [...r.getClientRects()].filter(q=>q.width>0).map(q=>({top:q.top,bottom:q.bottom}))})()`);
    assert(rects.length>=3,`${fontFamily}: fixture must wrap into at least three visual rows`);
    let current=await state();
    assert(Math.abs(current.caret.top-rects[0].top)<1,`${fontFamily}: caret starts on the first visual row`);
    for(let index=1;index<rects.length;index++){
      await key('ArrowDown');current=await state();
      assert.equal(current.text,`>>>> ${body}`,`${fontFamily}: wrapped rows share one physical quote`);
      assert(Math.abs(current.caret.top-rects[index].top)<1,`${fontFamily}: Down skips a visual row: ${JSON.stringify({index,rects,current})}`);
    }
    for(let index=rects.length-2;index>=0;index--){
      await key('ArrowUp');current=await state();
      assert(Math.abs(current.caret.top-rects[index].top)<1,`${fontFamily}: Up skips a visual row: ${JSON.stringify({index,rects,current})}`);
    }
  }

  // Demo enables the fold plugin. Its gutter must not change quote hit-testing.
  await c.evaluate(`editor.setPluginEnabled('heading-fold',true)`);
  const withFold='# 标题\n> 上方正文\n>>>>\n> 下方正文\n';
  await load(withFold);await position(withFold.indexOf('上方正文'));
  await key('ArrowDown');assert.equal((await state()).text,'>>>>','Down enters the empty quote with a fold gutter');
  await key('ArrowDown');assert.equal((await state()).text,'> 下方正文','Down leaves the empty quote with a fold gutter');
  await key('ArrowUp');assert.equal((await state()).text,'>>>>','Up re-enters the empty quote with a fold gutter');
  await clickRow('>>>>');clicked=await state();
  assert.equal(clicked.head,withFold.indexOf('>>>>')+4,'mouse placement is correct with a fold gutter');
  assert.deepEqual(await c.evaluate('errors'),[]);
  assert.deepEqual(browserErrors,[]);
  console.log('PASS: native quote navigation visits each visible row');
} finally {
  try {await c?.evaluate('editor?.dispose();worker?.terminate()')}catch{}
  c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true});
}
