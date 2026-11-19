// Real browser/Worker/Wasm regression for the public component, not Demo glue.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_FOLD_PORT??4273), debugPort=Number(process.env.JOT_FOLD_DEBUG_PORT??9473);
const profile=mkdtempSync(resolve(tmpdir(),'jot-fold-browser-'));
const source='# A\nbody α\n## Sub\nsub body 😀\n# B\nlast body\n';
let server,chrome,c;
const errors=[];
let serverLog='';
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr]) stream.on('data',chunk=>{serverLog=(serverLog+chunk).slice(-12000)});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}`)).webSocketDebuggerUrl);
  c.socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text)});
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
  await waitForEvaluation(c,`document.readyState==='complete' && document.title==='Jot native component integration fixture'`,15000);
  await c.evaluate(`(async()=>{window.foldModule=await import('/@fs${process.cwd()}/packages/editor/src/index.ts')})()`);
  await c.evaluate(`(()=>{
    const {MarkdownEditor,createHeadingFoldPlugin,createMermaidPlugin}=window.foldModule;
    const root=document.createElement('div');root.id='fold-test';root.style.cssText='width:900px;height:650px;margin:30px';document.body.replaceChildren(root);
    window.worker=new Worker('/src/worker.ts',{type:'module'});window.testErrors=[];
    window.testClickSequence=0;document.addEventListener('click',event=>{window.lastTestClick={sequence:++testClickSequence,tag:event.target?.tagName,id:event.target?.dataset?.jotFoldId,html:event.target?.outerHTML?.slice(0,180)}},true);
    window.editor=new MarkdownEditor({root,mode:'live-preview',plugins:[createHeadingFoldPlugin(),createMermaidPlugin({load:()=>import('/src/mermaid-loader.ts').then(m=>m.loadMermaid())})],session:{endpoint:worker,documentId:'fold-test',generation:1,source:${JSON.stringify(source)},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:error=>testErrors.push(String(error))});
    window.view=editor.input.view; window.openState='pending';window.foldLog=[];
    editor.headingFolds.subscribe(()=>{foldLog.push({folds:editor.headingFolds.ranges.map(f=>f.id),mode:editor.mode,head:view.state.selection.main.head,button:document.querySelector('.jot-editor-surface button[data-jot-fold-id="1"]')?.getAttribute('aria-expanded')});if(foldLog.length>30)foldLog.shift()});
    editor.open().then(()=>window.openState='ready').catch(error=>window.openState=String(error));
  })()`);
  const wait=async (expression,timeout=15000)=>{
    try { return await waitForEvaluation(c,expression,timeout); }
    catch(error) { console.error('browser state:',JSON.stringify(await c.evaluate(`({mode:editor.mode,folds:editor.headingFolds.ranges,foldLog,lastClick:window.lastTestClick,sourceLength:editor.value.length,sourceStart:editor.value.slice(0,500),head:view.state.selection.main.head,scroll:view.scrollDOM.scrollTop,viewport:view.viewport,liveText:document.querySelector('.cm-content')?.innerText.slice(0,1200),headingBlocks:editor.session.adapter.blocks.blocks.filter(b=>b.kind==='heading').map(b=>({id:b.id,from:b.sourceRange.from,to:b.sourceRange.to})),gutter:[...document.querySelectorAll('.jot-heading-fold-gutter button')].map(b=>({id:b.dataset.jotFoldId,html:b.outerHTML,rect:b.getBoundingClientRect().toJSON()})),images:document.querySelectorAll('.cm-content img.jot-image').length,tables:document.querySelectorAll('.cm-content .jot-table').length,diagrams:document.querySelectorAll('.cm-content .jot-plugin-block svg').length,body:document.querySelector('.jot-editor-surface')?.innerText.slice(0,1000),html:document.querySelector('.jot-editor-surface')?.innerHTML.slice(0,2500),errors:testErrors})`),null,2)); throw error; }
  };
  await wait(`window.openState==='ready' && editor.session.adapter.analysis?.state==='complete' && document.querySelectorAll('.jot-heading-fold-gutter button[data-jot-fold-id]').length===3`);
  assert.equal(await c.evaluate(`getComputedStyle(document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id]'),'::before').content`),'"⌄"','the default expanded icon is a chevron');
  const modifier=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`)?4:2;
  const foldKey=modifier===4
    ? {key:'O',code:'KeyO',windowsVirtualKeyCode:79,modifiers:2|8}
    : {key:'f',code:'KeyF',windowsVirtualKeyCode:70,modifiers:modifier|1};
  const ids=await c.evaluate(`Object.fromEntries(editor.session.adapter.blocks.blocks.filter(b=>b.kind==='heading').map(b=>[editor.value.slice(Number(b.sourceRange.from),Number(b.sourceRange.to)),b.id]))`);
  async function click(id, selector='.jot-heading-fold-gutter') {
    const expression=`(async()=>{const b=document.querySelector(${JSON.stringify(selector)}+' button[data-jot-fold-id="'+${JSON.stringify(id)}+'"]');if(!b)return null;const a=b.getBoundingClientRect();await new Promise(requestAnimationFrame);const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return b.isConnected&&Math.abs(a.top-r.top)<1&&Math.abs(a.left-r.left)<1&&document.elementFromPoint(x,y)===b?{x,y}:null})()`;
    for(let attempt=0;attempt<3;attempt++) {
      await wait(`(${expression}).then(Boolean)`); const point=await c.evaluate(expression);
      if(!point) continue;
      const sequence=await c.evaluate('testClickSequence');
      for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
      const actual=await c.evaluate('lastTestClick');
      if(actual?.sequence>sequence) {
        if(actual.id===id) return;
        assert(!actual.id,`click hit the wrong heading: ${JSON.stringify(actual)}`);
      }
    }
    assert.fail(`fold control did not receive a real click for heading ${id}`);
  }
  await click(ids['## Sub']);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['## Sub'])})`);
  assert.equal(await c.evaluate(`getComputedStyle(document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(ids['## Sub'])}+'"]'),'::before').content`),'"›"','the default folded icon is a chevron');
  await wait(`!document.querySelector('.cm-content').innerText.includes('sub body')`);
  assert.equal(await c.evaluate('editor.value'),source);
  await click(ids['# A']);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await wait(`!document.querySelector('.cm-content').innerText.includes('body α')`);
  await click(ids['# A']);
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])}) && editor.headingFolds.isFolded(${JSON.stringify(ids['## Sub'])})`);
  await wait(`document.querySelector('.cm-content').innerText.includes('body α') && !document.querySelector('.cm-content').innerText.includes('sub body')`);

  // Shift-click selects across a folded chapter; its contents are revealed only
  // after the pointer gesture and the original source selection is retained.
  await c.evaluate(`editor.input.setSelection(${source.indexOf('## Sub')});editor.focus()`);
  const shiftPoint=await c.evaluate(`(()=>{const r=view.coordsAtPos(${source.indexOf('# B')+3});return{x:r.left,y:(r.top+r.bottom)/2}})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,modifiers:8,...shiftPoint});
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['## Sub'])}) && !view.state.selection.main.empty`);
  const selected=await c.evaluate(`view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to)`);
  assert(selected.includes('sub body'),'cross-fold selection preserves hidden source');
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);
  await click(ids['## Sub']);await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['## Sub'])})`);

  await c.evaluate(`editor.setSearchQuery({search:'sub body'}); editor.findNext()`);
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['## Sub'])}) && view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to)==='sub body'`);
  assert.equal(await c.evaluate('editor.value'),source);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);await click(ids['## Sub']);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['## Sub'])})`);
  assert.equal(await c.evaluate(`editor.setSearchQuery({search:'sub body',replace:'替换'});editor.replaceAll()`),true);
  await wait(`editor.value===${JSON.stringify(source.replace('sub body','替换'))} && editor.value===editor.confirmedValue`);
  await c.evaluate(`editor.focus()`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue`);

  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);
  await click(ids['# A']);await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await c.evaluate(`editor.input.setSelection(editor.value.indexOf('# B'));editor.focus()`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  assert.equal(await c.evaluate('editor.value'),source,'first boundary deletion unfolds without deleting text');

  await click(ids['# A']);await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await c.evaluate(`editor.input.setSelection(3);editor.focus()`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  assert.equal(await c.evaluate('editor.value'),source,'forward boundary deletion also unfolds before deleting text');

  await click(ids['# A']);await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await c.evaluate(`editor.setMode('preview')`);
  await wait(`!!document.querySelector('.jot-editor-surface [data-jot-kind="heading"] .jot-heading-fold-button')`);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])}) && document.querySelector('.jot-editor-surface button[data-jot-fold-id="'+${JSON.stringify(ids['# A'])}+'"]')?.getAttribute('aria-expanded')==='false' && !document.querySelector('.jot-editor-surface').innerText.includes('body α') && document.querySelector('.jot-editor-surface').innerText.includes('last body')`);
  assert.equal(await c.evaluate(`document.querySelector('.jot-editor-surface [data-jot-kind="heading"]').textContent`),'A','fold affordance is not part of heading text');
  await click(ids['# A'],'.jot-editor-surface');
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])}) && document.querySelector('.jot-editor-surface').innerText.includes('body α')`);
  await click(ids['# A'],'.jot-editor-surface');
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await c.evaluate(`editor.setMode('source')`);
  await wait(`!document.querySelector('.cm-content').innerText.includes('body α')`);
  assert.equal(await c.evaluate('editor.value'),source,'source mode retains the complete document');
  await c.evaluate(`editor.setMode('split')`);
  await wait(`document.querySelector('.jot-editor-surface button[data-jot-fold-id="'+${JSON.stringify(ids['# A'])}+'"]')?.getAttribute('aria-expanded')==='false' && !document.querySelector('.jot-editor-surface').innerText.includes('body α')`);
  await c.evaluate(`editor.setMode('pretext')`);
  await wait(`document.querySelector('.jot-editor-surface button[data-jot-fold-id="'+${JSON.stringify(ids['# A'])}+'"]')?.getAttribute('aria-expanded')==='false'`);
  await click(ids['# A'],'.jot-editor-surface');
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);

  await c.evaluate(`editor.setMode('live-preview')`);
  await wait(`document.querySelectorAll('.jot-heading-fold-gutter button[data-jot-fold-id]').length===3`);
  await c.evaluate(`editor.input.setSelection(3);editor.focus()`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,...foldKey});
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,...foldKey});
  await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await click(ids['# B']);await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# B'])})`);
  await wait(`!document.querySelector('.cm-content').innerText.includes('last body')`);
  assert.equal(await c.evaluate('editor.value'),source,'folding to EOF does not remove the terminal newline');
  await click(ids['# B']);await wait(`!editor.headingFolds.isFolded(${JSON.stringify(ids['# B'])})`);
  await c.evaluate(`editor.input.setSelection(3);editor.focus()`);
  await click(ids['# A']);await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});
  await wait(`view.composing && editor.value.startsWith('# A')`);
  assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`),true,'IME candidate keeps the folded presentation stable');
  assert.equal(await c.evaluate('editor.confirmedValue'),source,'IME candidate is not committed to Rust');
  await c.command('Input.insertText',{text:'是'});
  await wait(`editor.value===editor.confirmedValue && editor.value.startsWith('# A是')`);
  assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`),true,'editing title content keeps the fold');
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue`);

  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);
  if(!await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`)) await click(ids['# A']);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:modifier});
  await wait(`view.state.selection.main.from===0 && view.state.selection.main.to===editor.value.length`);
  assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(ids['# A'])})`),true,'select all retains fold presentation');
  await c.command('Input.insertText',{text:'替换全文'});
  await wait(`editor.value==='替换全文' && editor.value===editor.confirmedValue`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue`);

  // A local body edit after a collapsed section must not discard that fold.
  await wait(`editor.session.adapter.analysis?.state==='complete' && editor.session.adapter.blocks.blocks.some(b=>b.kind==='heading' && Number(b.sourceRange.from)===0)`);
  const currentA=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading' && Number(b.sourceRange.from)===0).id`);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);
  if(!await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(currentA)})`)) await click(currentA);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(currentA)})`);
  const localPosition=source.indexOf('last body')+5;
  await c.evaluate(`editor.input.replaceRange(${localPosition},${localPosition},'X','api')`);
  const localEdited=source.slice(0,localPosition)+'X'+source.slice(localPosition);
  await wait(`editor.value===${JSON.stringify(localEdited)} && editor.value===editor.confirmedValue`);
  assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(currentA)})`),true,'unrelated same-line edit retains folded section');
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue`);

  // Changing a later heading changes its preceding section even though # A did not change.
  const laterHeading=source.indexOf('# B');
  await c.evaluate(`editor.input.replaceRange(${laterHeading},${laterHeading+1},'##','api')`);
  const changedLevel=source.slice(0,laterHeading)+'##'+source.slice(laterHeading+1);
  await wait(`editor.value===${JSON.stringify(changedLevel)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  assert.equal(await c.evaluate('editor.headingFolds.ranges.length'),0,'structural edits invalidate old fold boundaries');
  const changedA=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading' && Number(b.sourceRange.from)===0).id`);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);await click(changedA);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(changedA)})`);
  assert.equal(await c.evaluate(`editor.headingFolds.ranges.find(f=>f.id===${JSON.stringify(changedA)}).to`),changedLevel.length,'lower-level later heading belongs to A');
  await c.evaluate(`editor.setValue(${JSON.stringify(source)})`);
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);

  const fence='```';
  const unclosed=`# A\n${fence} ts\n# B\nbody\n`;
  await c.evaluate(`editor.setValue(${JSON.stringify(unclosed)})`);
  await wait(`editor.value===${JSON.stringify(unclosed)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const unclosedA=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading' && Number(b.sourceRange.from)===0).id`);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);await click(unclosedA);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(unclosedA)})`);
  assert.equal(await c.evaluate(`editor.headingFolds.ranges.find(f=>f.id===${JSON.stringify(unclosedA)}).to`),unclosed.indexOf('# B'),'unclosed fence does not swallow later heading');
  await c.evaluate(`editor.input.replaceRange(editor.value.length,editor.value.length,${JSON.stringify(fence+'\n')},'api')`);
  const closed=unclosed+fence+'\n';
  await wait(`editor.value===${JSON.stringify(closed)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  assert.equal(await c.evaluate('editor.headingFolds.ranges.length'),0);
  assert.equal(await c.evaluate(`editor.session.adapter.blocks.blocks.filter(b=>b.kind==='heading').length`),1,'closed fence owns its inner heading-like line');
  await c.evaluate(`editor.setValue(${JSON.stringify(source)})`);
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);

  // Characterize actual keyboard editing below an already folded section.
  // A later section must remain intact regardless of whether the conservative
  // boundary policy keeps the fold or temporarily reveals it.
  const belowSource='# 上方\n隐藏章节正文\n# 下方\n这一段普通正文足够长，用于验证编辑位置。\n';
  const lineStart=belowSource.indexOf('这一段');
  const lineEnd=belowSource.indexOf('\n',lineStart);
  for(const scenario of [
    {name:'middle',position:lineStart+8,insert:'文',staysFolded:true},
    {name:'line-start',position:lineStart,insert:'文',staysFolded:false},
    {name:'line-end',position:lineEnd,insert:'文',staysFolded:false},
    {name:'enter',position:lineStart+8,insert:'\n',staysFolded:false},
  ]) {
    await c.evaluate(`editor.setValue(${JSON.stringify(belowSource)})`);
    // setValue can enqueue a full reset even when Undo has just restored the
    // same string. Wait for that transaction before retaining a heading ID.
    await c.evaluate(`editor.settled()`);
    await wait(`editor.value===${JSON.stringify(belowSource)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
    const upperId=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading'&&Number(b.sourceRange.from)===0).id`);
    await c.evaluate(`editor.input.setSelection(0);editor.focus()`);await click(upperId);
    await wait(`editor.headingFolds.isFolded(${JSON.stringify(upperId)}) && !view.contentDOM.innerText.includes('隐藏章节正文')`);
    await c.evaluate(`editor.input.setSelection(${scenario.position});editor.focus()`);
    assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(upperId)})`),true,`${scenario.name}: selecting the lower paragraph does not reveal the upper section`);
    if(scenario.name==='enter') {
      for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    } else {
      await c.command('Input.insertText',{text:scenario.insert});
    }
    const expected=belowSource.slice(0,scenario.position)+scenario.insert+belowSource.slice(scenario.position);
    await wait(`editor.value===${JSON.stringify(expected)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
    await wait(`editor.headingFolds.isFolded(${JSON.stringify(upperId)})===${scenario.staysFolded}`);
    assert.equal(await c.evaluate('editor.value'),expected,`${scenario.name}: hidden and visible text are preserved exactly`);
    await wait(`view.contentDOM.innerText.includes('隐藏章节正文')===${!scenario.staysFolded}`);
    if(scenario.name==='line-end') {
      for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
      await wait(`editor.value===${JSON.stringify(belowSource)} && editor.value===editor.confirmedValue`);
      assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(upperId)})`),false,'undo restores the text but does not resurrect view-only fold state');
    }
  }

  // Editing a quote below a folded chapter must preserve both the hidden
  // source and the selected quote text even if a structural edit reveals it.
  const belowQuote='# 上方\n隐藏章节正文\n# 下方\n>>>> 引用正文\n\n尾部\n';
  await c.evaluate(`editor.setValue(${JSON.stringify(belowQuote)})`);
  await c.evaluate(`editor.settled()`);
  await wait(`editor.value===${JSON.stringify(belowQuote)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const quoteUpper=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading'&&Number(b.sourceRange.from)===0).id`);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);await click(quoteUpper);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(quoteUpper)}) && !view.contentDOM.innerText.includes('隐藏章节正文')`);
  await c.evaluate(`editor.input.setSelection(${belowQuote.indexOf('引用正文')});editor.focus()`);
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  const outdentedQuote=belowQuote.replace('>>>> ', '>>> ');
  await wait(`editor.value===${JSON.stringify(outdentedQuote)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  await wait(`!![...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="3"]')].find(n=>n.innerText.includes('引用正文'))`);
  assert.equal(await c.evaluate('editor.value'),outdentedQuote,'quote outdent below a folded section preserves hidden and visible source');
  for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
  await wait(`editor.value===${JSON.stringify(belowQuote)} && editor.value===editor.confirmedValue`);

  await c.evaluate(`editor.setValue(${JSON.stringify(belowSource)})`);
  await c.evaluate(`editor.settled()`);
  await wait(`editor.value===${JSON.stringify(belowSource)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const imeUpper=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading'&&Number(b.sourceRange.from)===0).id`);
  await c.evaluate(`editor.input.setSelection(0);editor.focus()`);await click(imeUpper);
  await wait(`editor.headingFolds.isFolded(${JSON.stringify(imeUpper)})`);
  await c.evaluate(`editor.input.setSelection(${lineEnd});editor.focus()`);
  await c.command('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
  await wait('view.composing');
  assert.equal(await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(imeUpper)})`),true,'IME candidates do not prematurely expand a folded chapter');
  assert.equal(await c.evaluate('editor.confirmedValue'),belowSource,'uncommitted IME candidates are not stored as confirmed source');
  await c.command('Input.insertText',{text:'你'});
  const imeExpected=belowSource.slice(0,lineEnd)+'你'+belowSource.slice(lineEnd);
  await wait(`editor.value===${JSON.stringify(imeExpected)} && editor.value===editor.confirmedValue && !editor.headingFolds.isFolded(${JSON.stringify(imeUpper)})`);
  const severalFolds='# 第一章\n隐藏第一章\n# 第二章\n隐藏第二章\n# 第三章\n下一章末尾\n';
  await c.evaluate(`editor.setValue(${JSON.stringify(severalFolds)})`);
  await wait(`editor.value===${JSON.stringify(severalFolds)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  const upperIds=await c.evaluate(`editor.session.adapter.blocks.blocks.filter(b=>b.kind==='heading').slice(0,2).map(b=>b.id)`);
  await c.evaluate('editor.input.setSelection(0);editor.focus()');
  for(const id of upperIds) { await click(id);await wait(`editor.headingFolds.isFolded(${JSON.stringify(id)})`); }
  const lastLineEnd=severalFolds.lastIndexOf('\n');
  await c.evaluate(`editor.input.setSelection(${lastLineEnd});editor.focus()`);
  await c.command('Input.insertText',{text:'字'});
  const severalExpected=severalFolds.slice(0,lastLineEnd)+'字'+severalFolds.slice(lastLineEnd);
  await wait(`editor.value===${JSON.stringify(severalExpected)} && editor.value===editor.confirmedValue && editor.headingFolds.ranges.length===0`);
  await wait(`view.contentDOM.innerText.includes('隐藏第一章') && view.contentDOM.innerText.includes('隐藏第二章')`);
  await c.evaluate(`editor.setValue(${JSON.stringify(source)})`);
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);

  if (process.env.JOT_FOLD_FUZZ==='1') {
    await wait(`editor.session.adapter.analysis?.state==='complete'`);
    const fuzzIds=await c.evaluate(`Object.fromEntries(editor.session.adapter.blocks.blocks.filter(b=>b.kind==='heading').map(b=>[editor.value.slice(Number(b.sourceRange.from),Number(b.sourceRange.to)),b.id]))`);
    let seed=6210457;
    const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*max)};
    for(let step=0;step<80;step++) {
      const id=random(2)===0?fuzzIds['# A']:fuzzIds['# B'];
      const action=random(4);
      await c.evaluate(`editor.input.setSelection(0);editor.focus()`);
      if(action<2) {
        const was=await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(id)})`);
        await click(id);
        await wait(`editor.headingFolds.isFolded(${JSON.stringify(id)})===${!was}`);
      } else if(action===2) {
        const was=await c.evaluate(`editor.headingFolds.isFolded(${JSON.stringify(id)})`);
        await click(id);await click(id);
        await wait(`editor.headingFolds.isFolded(${JSON.stringify(id)})===${was}`);
      } else {
        for(const type of ['keyDown','keyUp']) await c.command('Input.dispatchKeyEvent',{type,key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      }
      assert.equal(await c.evaluate('editor.value'),source,`source changed during random step ${step}`);
      assert.equal(await c.evaluate('editor.value===editor.confirmedValue'),true,`source diverged during random step ${step}`);
    }
    console.log(JSON.stringify({case:'random-fold-interactions',initialSeed:6210457,steps:80}));
  }

  // The controls are component styles: per-editor tokens must affect both
  // CodeMirror and Preview without stealing title text or pointer selection.
  const styleA=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading'&&Number(b.sourceRange.from)===0).id`);
  await c.evaluate(`(async()=>{
    editor.headingFolds.unfoldAll();editor.input.setSelection(0);editor.focus();
    const root=document.querySelector('#fold-test');
    for(const [name,value] of Object.entries({'--jot-heading-fold-gutter-width':'32px','--jot-heading-fold-button-size':'24px','--jot-heading-fold-font-size':'16px','--jot-heading-fold-offset':'40px','--jot-heading-fold-color':'rgb(12, 80, 120)','--jot-heading-fold-expanded-icon':'"−"','--jot-heading-fold-collapsed-icon':'"+"'}))root.style.setProperty(name,value);
    view.contentDOM.style.paddingInlineStart='48px';await editor.invalidateLayout();
  })()`);
  await wait(`!!document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]')`);
  const styleGeometry=await c.evaluate(`(()=>{const gutter=document.querySelector('.jot-heading-fold-gutter'),button=gutter.querySelector('button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]'),line=[...view.contentDOM.querySelectorAll('.cm-line')].find(node=>node.textContent.includes('A')),g=gutter.getBoundingClientRect(),b=button.getBoundingClientRect(),l=line.getBoundingClientRect();return{gutter:g.width,button:b.width,offset:b.left-g.left,gap:l.left-b.right,color:getComputedStyle(button).color,icon:getComputedStyle(button,'::before').content}})()`);
  assert(Math.abs(styleGeometry.gutter-32)<1 && Math.abs(styleGeometry.button-24)<1 && Math.abs(styleGeometry.offset-40)<1,JSON.stringify(styleGeometry));
  assert(styleGeometry.gap>=0 && styleGeometry.gap<32,`fold control must remain beside and outside heading text: ${JSON.stringify(styleGeometry)}`);
  assert.equal(styleGeometry.color,'rgb(12, 80, 120)');assert.equal(styleGeometry.icon,'"−"');
  await click(styleA);await wait(`editor.headingFolds.isFolded(${JSON.stringify(styleA)})`);
  assert.equal(await c.evaluate(`getComputedStyle(document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]'),'::before').content`),'"+"');
  await c.evaluate(`editor.setMode('preview')`);
  await wait(`document.querySelector('.jot-editor-surface button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]')?.getAttribute('aria-expanded')==='false'`);
  const previewStyle=await c.evaluate(`(()=>{const content=document.querySelector('.jot-editor-content'),button=content.querySelector('button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]');return{padding:parseFloat(getComputedStyle(content).paddingInlineStart),width:button.getBoundingClientRect().width,color:getComputedStyle(button).color,icon:getComputedStyle(button,'::before').content}})()`);
  assert(Math.abs(previewStyle.padding-32)<1 && Math.abs(previewStyle.width-24)<1,JSON.stringify(previewStyle));
  assert.equal(previewStyle.color,'rgb(12, 80, 120)');assert.equal(previewStyle.icon,'"+"');
  const svgIcon='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M4 2 L8 6 L4 10" fill="none" stroke="#0c5078" stroke-width="1.5"/></svg>');
  await c.evaluate(`document.querySelector('#fold-test').style.setProperty('--jot-heading-fold-collapsed-icon',${JSON.stringify(`url("${svgIcon}")`)})`);
  await wait(`(()=>{const button=document.querySelector('.jot-editor-surface button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]'),s=getComputedStyle(button,'::before');return s.content.includes('data:image/svg+xml,') && parseFloat(s.width)>0 && parseFloat(s.width)<=24})()`);
  const maskCss=`#fold-test .jot-heading-fold-button::before{content:"";display:block;width:12px;height:12px;background:currentColor;mask:url("${svgIcon}") center / contain no-repeat}`;
  await c.evaluate(`(()=>{const s=document.createElement('style');s.dataset.foldMaskTest='';s.textContent=${JSON.stringify(maskCss)};document.head.append(s)})()`);
  const maskStyle=await c.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.jot-editor-surface button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]'),'::before');return{mask:s.maskImage,color:s.backgroundColor,width:parseFloat(s.width)}})()`);
  assert(maskStyle.mask.includes('data:image/svg+xml,') && maskStyle.color==='rgb(12, 80, 120)' && maskStyle.width===12,`custom SVG mask follows the configured color: ${JSON.stringify(maskStyle)}`);
  await click(styleA,'.jot-editor-surface');await wait(`!editor.headingFolds.isFolded(${JSON.stringify(styleA)})`);
  await c.evaluate(`editor.setMode('live-preview')`);
  await wait(`!!document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]')`);
  assert(await c.evaluate(`getComputedStyle(document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]'),'::before').maskImage.includes('data:image/svg+xml,')`),'custom SVG mask applies to the editing gutter as well as Preview');
  await c.evaluate(`(async()=>{
    document.querySelector('style[data-fold-mask-test]').remove();const root=document.querySelector('#fold-test');
    for(const name of ['--jot-heading-fold-gutter-width','--jot-heading-fold-button-size','--jot-heading-fold-font-size','--jot-heading-fold-offset','--jot-heading-fold-color','--jot-heading-fold-expanded-icon','--jot-heading-fold-collapsed-icon'])root.style.removeProperty(name);
    view.contentDOM.style.removeProperty('padding-inline-start');
    await editor.setTheme({colors:{text:'#e5e7eb',background:'#202322'}});
  })()`);
  await wait(`!!document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]')`);
  assert.equal(await c.evaluate(`getComputedStyle(document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(styleA)}+'"]')).color`),'rgb(229, 231, 235)','default marker follows the editor text theme');
  await c.evaluate(`editor.setTheme({colors:{text:null,background:null}})`);
  assert.equal(await c.evaluate('editor.value'),source);

  // Concurrent layout work must not bring the view back to an older anchor.
  // Use the mounted DOM rather than CodeMirror's measurement-forcing helpers.
  const scrollSource='# 开头\n'+Array.from({length:1200},(_,i)=>`前段 ${i} 文字内容`).join('\n')+'\n# SEEK_A\n'+Array.from({length:1200},(_,i)=>`中段 ${i} 文字内容`).join('\n')+'\n# SEEK_B\n'+Array.from({length:200},(_,i)=>`后段 ${i} 文字内容`).join('\n')+'\n';
  await c.evaluate(`window.scrollSource=${JSON.stringify(scrollSource)};editor.setValue(scrollSource)`);
  await wait(`editor.value===scrollSource && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,60000);
  const visible=marker=>`(()=>{const node=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes(${JSON.stringify(marker)})),r=node?.getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();return !!r&&r.bottom>p.top&&r.top<p.bottom})()`;
  await c.evaluate(`editor.input.setSelection(0);editor.focus();view.scrollDOM.scrollTop=0`);
  await c.evaluate(`window.refresh=editor.livePreview.invalidateLayout();editor.input.setSelection(scrollSource.indexOf('# SEEK_A'));editor.input.setSelection(scrollSource.indexOf('# SEEK_B'))`);
  await c.evaluate(`(async()=>{await refresh;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
  await wait(visible('SEEK_B'));
  assert.equal(await c.evaluate('view.state.selection.main.head'),scrollSource.indexOf('# SEEK_B'),'the latest selection wins');

  // A real wheel gesture after a refresh request must retain the user's scroll.
  const wheelStart=await c.evaluate(`(()=>{const r=view.scrollDOM.getBoundingClientRect();window.refresh=editor.livePreview.invalidateLayout();return {top:view.scrollDOM.scrollTop,x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',x:wheelStart.x,y:wheelStart.y,deltaX:0,deltaY:-480});
  await wait(`view.scrollDOM.scrollTop<${wheelStart.top}-100`);
  await c.evaluate(`(async()=>{await refresh;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
  assert(await c.evaluate(`view.scrollDOM.scrollTop<${wheelStart.top}-100`),'layout restoration must not undo wheel scrolling');

  // Re-requesting the same head still asks CodeMirror to bring it into view.
  await c.evaluate(`window.refresh=editor.livePreview.invalidateLayout();editor.input.setSelection(scrollSource.indexOf('# SEEK_B'))`);
  await c.evaluate(`(async()=>{await refresh;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
  await wait(visible('SEEK_B'));
  await c.evaluate(`window.refresh=editor.livePreview.invalidateLayout();editor.input.setSelection(scrollSource.indexOf('# SEEK_A'),scrollSource.indexOf('# SEEK_B')+8)`);
  await c.evaluate(`(async()=>{await refresh;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
  await wait(visible('SEEK_B'));
  assert.deepEqual(await c.evaluate(`({anchor:view.state.selection.main.anchor,head:view.state.selection.main.head})`),{anchor:scrollSource.indexOf('# SEEK_A'),head:scrollSource.indexOf('# SEEK_B')+8},'selection direction and range survive the scroll');
  for(const mode of ['source','split']) {
    await c.evaluate(`(async()=>{await editor.setMode(${JSON.stringify(mode)});editor.input.setSelection(scrollSource.indexOf('# SEEK_A'));editor.focus()})()`);
    await wait(visible('SEEK_A'));
    assert.equal(await c.evaluate('editor.value'),scrollSource,`${mode} navigation preserves source`);
  }
  await c.evaluate(`(async()=>{await editor.setMode('live-preview');editor.setValue(${JSON.stringify(source)})})()`);
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);

  await c.evaluate(`editor.setPluginEnabled('heading-fold',false)`);
  await wait(`!document.querySelector('.jot-heading-fold-gutter')`);
  assert.equal(await c.evaluate('editor.value'),source);
  await c.evaluate(`editor.setValue(scrollSource)`);
  await wait(`editor.value===scrollSource && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`,60000);
  await c.evaluate(`editor.input.setSelection(0);editor.focus();view.scrollDOM.scrollTop=0`);
  await c.evaluate(`window.refresh=editor.livePreview.invalidateLayout();editor.input.setSelection(scrollSource.indexOf('# SEEK_B'))`);
  await c.evaluate(`(async()=>{await refresh;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
  await wait(visible('SEEK_B'));
  assert.equal(await c.evaluate('editor.value'),scrollSource,'selection navigation also works with folding disabled');
  await c.evaluate(`editor.setValue(${JSON.stringify(source)})`);
  await wait(`editor.value===${JSON.stringify(source)} && editor.value===editor.confirmedValue && editor.session.adapter.analysis?.state==='complete'`);
  if (process.env.JOT_FOLD_STRESS==='1') {
    await c.evaluate(`(async()=>{
      await editor.setPluginEnabled('heading-fold',true);
      const fence='\x60\x60\x60';
      const prefix=Array.from({length:180},(_,i)=>'前文 '+i).join('\\n')+'\\n';
      const header=prefix+'# 大文档\\n\\n![图片](/pretext-layout.svg)\\n\\n| 名称 | 值 |\\n| --- | --- |\\n| 测试 | 42 |\\n\\n'+fence+' mermaid\\nflowchart LR\\n A[开始] --> B[结束]\\n'+fence+'\\n\\n';
      const line='普通段落，包含中文、emoji 😀、**加粗**、[链接](https://example.com) 与足够长的说明文字，用来验证折叠和虚拟化。';
      const suffix=Array.from({length:100},(_,i)=>'后文 '+i).join('\\n');
      window.largeSource=header+Array.from({length:9000},(_,i)=>String(i)+' '+line).join('\\n')+'\\n# 结尾\\nTAIL-END\\n'+suffix;
      editor.input.replaceRange(0,editor.value.length,largeSource,'api');
    })()`);
    await wait(`editor.value===window.largeSource && editor.confirmedValue===window.largeSource && editor.session.adapter.analysis?.state==='complete'`,120000);
    const bytes=await c.evaluate(`new TextEncoder().encode(largeSource).length`);
    assert(bytes>=1048576,`mixed fixture must be at least 1 MiB, got ${bytes}`);
    // A selection requested during layout refresh must beat its old anchor.
    // Inspect only DOM geometry: CodeMirror geometry helpers flush its pending
    // measurement and can accidentally conceal this race in the test itself.
    await c.evaluate(`window.seekLayout=editor.livePreview.invalidateLayout();editor.input.setSelection(largeSource.indexOf('# 大文档'));editor.focus()`);
    await c.evaluate(`(async()=>{await seekLayout;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
    await wait(`(()=>{const line=[...document.querySelectorAll('.cm-content .cm-line')].find(node=>node.textContent.includes('大文档')),rect=line?.getBoundingClientRect(),pane=view.scrollDOM.getBoundingClientRect();return !!rect&&rect.bottom>pane.top&&rect.top<pane.bottom})()`,10000);
    assert.equal(await c.evaluate(`view.state.selection.main.head`),await c.evaluate(`largeSource.indexOf('# 大文档')`),'programmatic selection remains at its target');
    await c.evaluate(`view.scrollDOM.scrollTop=Math.max(0,view.lineBlockAt(largeSource.indexOf('# 大文档')).top-view.scrollDOM.clientHeight/3)`);
    await wait(`!!document.querySelector('.jot-table') && !!document.querySelector('.jot-plugin-block svg') && !!document.querySelector('.cm-content img.jot-image')`,60000);
    const largeId=await c.evaluate(`editor.session.adapter.blocks.blocks.find(b=>b.kind==='heading' && Number(b.sourceRange.from)===largeSource.indexOf('# 大文档')).id`);
    await wait(`!!document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(largeId)}+'"]')`,30000);
    await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const before=await c.evaluate('view.scrollDOM.scrollHeight');
    const timings=[];
    for(let i=0;i<20;i++) {
      const anchorBefore=await c.evaluate(`({top:document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(largeId)}+'"]').getBoundingClientRect().top,scroll:view.scrollDOM.scrollTop,height:view.scrollDOM.scrollHeight,client:view.scrollDOM.clientHeight})`);
      await c.evaluate(`(()=>{
        window.foldMeasure={start:0,end:0};
        const id=${JSON.stringify(largeId)};
        const button=document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+id+'"]');
        button.addEventListener('click',()=>foldMeasure.start=performance.now(),{once:true});
        const stop=editor.headingFolds.subscribe(()=>{if(foldMeasure.start && editor.headingFolds.isFolded(id)){foldMeasure.end=performance.now();stop()}});
      })()`);
      await click(largeId);
      await wait(`editor.headingFolds.isFolded(${JSON.stringify(largeId)})`);
      await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const anchorAfter=await c.evaluate(`({top:document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(largeId)}+'"]').getBoundingClientRect().top,scroll:view.scrollDOM.scrollTop,height:view.scrollDOM.scrollHeight,client:view.scrollDOM.clientHeight})`);
      assert(Math.abs(anchorBefore.top-anchorAfter.top)<=2,`heading moved during fold: ${JSON.stringify({anchorBefore,anchorAfter})}`);
      timings.push(await c.evaluate('foldMeasure.end-foldMeasure.start'));
      assert.equal(await c.evaluate('editor.value===largeSource'),true);
      await click(largeId);await wait(`!editor.headingFolds.isFolded(${JSON.stringify(largeId)})`);
    }
    await wait(`!!document.querySelector('.cm-content img.jot-image')`,30000);
    const blank=await c.evaluate(`(()=>{
      const pos=view.state.doc.lineAt(largeSource.indexOf('![图片]')-1).from;
      const rect=view.coordsAtPos(pos),img=document.querySelector('.cm-content img.jot-image').getBoundingClientRect();
      const x=rect.left+2,y=(rect.top+rect.bottom)/2,scroll=view.scrollDOM.getBoundingClientRect();
      const rows=[...document.querySelectorAll('.cm-content > *')].map(e=>({html:e.outerHTML.slice(0,180),top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height})).filter(e=>e.top>y-60&&e.top<y+500);
      return {pos,x,y,imageTop:img.top,scrollTop:view.scrollDOM.scrollTop,scrollHeight:view.scrollDOM.scrollHeight,scrollBounds:{top:scroll.top,bottom:scroll.bottom},hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,200),rows};
    })()`);
    for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:blank.x,y:blank.y});
    await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await c.evaluate('view.state.selection.main.head'),blank.pos,'blank line beside image keeps its own source position');
    const imageAfter=await c.evaluate(`({top:document.querySelector('.cm-content img.jot-image').getBoundingClientRect().top,scrollTop:view.scrollDOM.scrollTop,scrollHeight:view.scrollDOM.scrollHeight})`);
    assert(Math.abs(imageAfter.top-blank.imageTop)<=2,`clicking empty line moved image: ${JSON.stringify({blank,imageAfter})}`);
    await c.evaluate(`editor.input.setSelection(largeSource.indexOf('# 大文档'));editor.focus()`);
    await click(largeId);await wait(`editor.headingFolds.isFolded(${JSON.stringify(largeId)})`);
    await wait(`document.querySelector('.cm-content').innerText.includes('TAIL-END')`,30000);
    await wait(`!document.querySelector('.cm-content img.jot-image, .cm-content .jot-table, .cm-content .jot-plugin-block')`,30000);
    const after=await c.evaluate('view.scrollDOM.scrollHeight');
    assert(after<before/2,`folded physical height should shrink: ${before} -> ${after}`);
    await c.evaluate(`editor.setMode('preview')`);
    await c.evaluate(`(()=>{const offset=largeSource.indexOf('# 结尾');editor.surface.applyScrollAnchor({blockIndex:editor.session.adapter.blocks.blockAt(offset),sourceOffset:offset,progress:0})})()`);
    await wait(`document.querySelector('.jot-editor-surface').innerText.includes('TAIL-END')`,30000);
    assert(!await c.evaluate(`document.querySelector('.jot-editor-surface').innerText.includes('普通段落')`));
    assert.equal(await c.evaluate(`!!document.querySelector('.jot-editor-surface img.jot-image, .jot-editor-surface .jot-table, .jot-editor-surface .jot-plugin-block')`),false,'folded components are not mounted in Preview');
    timings.sort((a,b)=>a-b);
    console.log(JSON.stringify({case:'mixed-large-document',bytes,roots:await c.evaluate('editor.session.adapter.blocks.blocks.length'),beforeHeight:before,foldedHeight:after,clickToStateMsP50:timings[9],clickToStateMsP95:timings[18]}));
  }
  assert.deepEqual(await c.evaluate('testErrors'),[]);
  assert.deepEqual(errors,[]);
  console.log('PASS: heading folding, nested state, search reveal, deletion protection, preview, IME, select-all/undo, plugin lifecycle');
} catch(error) {
  if(serverLog) console.error('Vite output:',serverLog);
  throw error;
} finally {
  c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true});
}
