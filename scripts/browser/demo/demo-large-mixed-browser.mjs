// End-to-end coverage for the actual Demo's 1 MiB sample and controls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_MIXED_PORT??4298),debugPort=Number(process.env.JOT_MIXED_DEBUG_PORT??9498);
const output=resolve(process.env.JOT_MIXED_REPORT??'dist/demo-mixed-browser-report');
const profile=mkdtempSync(resolve(tmpdir(),'jot-demo-mixed-'));
const errors=[],evidence=[];
let server,chrome,c,original;
mkdirSync(output,{recursive:true});
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}`)).webSocketDebuggerUrl);
  c.socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text)});
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const wait=(expression,timeout=30000)=>waitForEvaluation(c,expression,timeout);
  const getSource=()=>c.evaluate(`view.state.doc.toString()`);
  const screenshot=async name=>{const shot=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,`${name}.png`),Buffer.from(shot.data,'base64'))};
  const frame=()=>c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const modifier=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`)?4:2;
  const key=async(name,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:name,code:`Key${name.toUpperCase()}`,windowsVirtualKeyCode:name.toUpperCase().charCodeAt(0),modifiers})};
  const pointer=async point=>{for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})};
  await wait(`document.querySelector('#mode')?.disabled===false && document.querySelector('#editor-root').dataset.jotEditorMode==='live-preview'`,30000);
  await c.evaluate(`(()=>{const select=document.querySelector('#sample');select.value='text';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#load').click();window.view=document.querySelector('#editor-root .cm-content').cmTile.root.view})()`);
  // A user may scroll immediately after replacing the source, while the
  // worker is still analysing it. Do not request a manual render/settle.
  const wheelPoint=await c.evaluate(`(()=>{const r=view.scrollDOM.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  for(let index=0;index<3;index++)await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:900});
  await wait(`view.state.doc.length>400000 && document.querySelector('#status').textContent==='正文已确认'`,180000);
  original=await getSource();
  const bytes=Buffer.byteLength(original,'utf8');
  const count=pattern=>[...original.matchAll(pattern)].length;
  const shape={bytes,utf16:original.length,lines:original.split('\n').length,sections:count(/^## 混合记录 /gm),quotes:count(/^> >>>>/gm),tables:count(/^\| 名称 \| 状态 \| 备注 \|/gm),images:count(/!\[/g),diagrams:count(/^``` ?mermaid$/gm),hash:createHash('sha256').update(original).digest('hex')};
  assert(bytes>=1_048_576 && bytes<1_060_000,`the sample must be approximately 1 MiB: ${JSON.stringify(shape)}`);
  assert(shape.sections>50 && shape.quotes>50 && shape.tables>50 && shape.images>2 && shape.diagrams>2,`mixed content must recur across the document: ${JSON.stringify(shape)}`);
  for(const text of ['###### 六级标题','~~*嵌套斜体*~~','- [ ] 待办事项','> >>>>适用范围','引用中的代码','不齐的短行','表格记录 120','const codeLine160','单行开始','单行结束','``` mermaid','```mermaid','```rust begin','### 未闭合围栏后仍可识别的标题','长文档结束。'])assert(original.includes(text),`missing mixed fixture case: ${text}`);
  assert.equal(await c.evaluate(`(async()=>(await import('/src/sample.ts')).sample('text')===view.state.doc.toString())()`),true,'the generated sample is deterministic');
  evidence.push({case:'fixture',...shape});

  const scrollTo=async(marker)=>{
    const position=original.indexOf(marker);assert(position>=0,`missing marker ${marker}`);
    await c.evaluate(`view.scrollDOM.scrollTop=Math.max(0,view.lineBlockAt(${position}).top-view.scrollDOM.clientHeight/3)`);
    return position;
  };
  const visible=`n=>{const a=n.getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();return a.width>0&&a.height>0&&a.bottom>p.top&&a.top<p.bottom}`;
  const undo=async()=>{await c.evaluate(`view.focus()`);await key('z',modifier);await wait(`document.querySelector('#status').textContent==='正文已确认'`);assert.equal(await getSource(),original,'one undo restores the exact mixed document')};

  if(!process.env.JOT_MIXED_FOLD_ONLY){
  await scrollTo('适用范围：');
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="5"]')].some(n=>n.textContent.includes('适用范围：'))`,60000);
  const quotePoint=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="5"]')].find(n=>n.textContent.includes('适用范围：')),r=n.getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();return{x:Math.max(r.left+8,Math.min(r.right-8,r.left+100)),y:Math.max(p.top+3,Math.min(p.bottom-3,(r.top+r.bottom)/2))}})()`);
  await pointer(quotePoint);
  const quoteCaret=await c.evaluate('view.state.selection.main.head');
  assert(quoteCaret>=original.indexOf('> >>>>适用范围') && quoteCaret<original.indexOf('> >>>>适用范围')+120,'pointer enters the actual nested quote');
  await c.command('Input.insertText',{text:'测'});
  await wait(`document.querySelector('#status').textContent==='正文已确认'`);
  assert.equal(await getSource(),original.slice(0,quoteCaret)+'测'+original.slice(quoteCaret),'typing changes only the selected quote position');
  await undo();
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="7"]')].some(n=>n.textContent.includes('七层引用'))`,60000);
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="1"]')].some(n=>n.textContent.includes('> 前缀后四个空格'))`,60000);
  evidence.push({case:'nested-quote-pointer-and-undo'});

  // The mixed fixture has a nested marker-only row between two text rows.
  // It must be a real navigation stop even in the virtualized Demo.
  await c.evaluate(`view.dispatch({selection:{anchor:${original.indexOf('状态：上层引用。')}},scrollIntoView:true});view.focus()`);
  await frame();
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await frame();
  const quoteBlank=await c.evaluate(`(()=>{const head=view.state.selection.main.head,line=view.state.doc.lineAt(head),r=view.coordsAtPos(head);return{text:line.text,head,to:line.to,caret:r&&{top:r.top,bottom:r.bottom}}})()`);
  assert.equal(quoteBlank.text,'> >>>','Down visits the blank quote row in the mixed Demo');
  assert.equal(quoteBlank.head,quoteBlank.to,'the empty quote caret follows its hidden marker');
  assert(quoteBlank.caret && quoteBlank.caret.bottom>quoteBlank.caret.top,'the empty quote has a real caret box');
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await frame();
  assert((await c.evaluate('view.state.doc.lineAt(view.state.selection.main.head).text')).includes('适用范围'), 'a second Down visits the next quote row');
  for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  await frame();
  assert.equal(await c.evaluate('view.state.doc.lineAt(view.state.selection.main.head).text'),'> >>>','Up returns to the same blank quote row');
  evidence.push({case:'nested-quote-empty-row-navigation',...quoteBlank});

  await scrollTo('保留这个属于代码内容的大于号');
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line[data-jot-quote-depth="2"].jot-code-line')].some(n=>n.textContent.includes('> 保留这个属于代码内容的大于号'))`,60000);
  evidence.push({case:'quoted-code-literal-marker'});

  const listOffset=await scrollTo('首个字可使用中文输入法');
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line.jot-live-preview-list-item')].some(n=>n.textContent.includes('首个字可使用中文输入法') && (${visible})(n))`,60000);
  const listPoint=await c.evaluate(`(()=>{const r=view.coordsAtPos(${listOffset});return{x:r.left+1,y:(r.top+r.bottom)/2}})()`);
  await pointer(listPoint);
  const imeOffset=await c.evaluate('view.state.selection.main.head');
  assert(imeOffset>=listOffset && imeOffset<=listOffset+1,'the pointer reaches the beginning of the list text');
  await c.command('Input.imeSetComposition',{text:'shou',selectionStart:4,selectionEnd:4});
  await wait('view.composing');
  const imeLine=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line.jot-live-preview-list-item')].find(n=>n.textContent.includes('首个字可使用中文输入法'));return{text:n?.textContent,marker:n&&getComputedStyle(n,'::before').content}})()`);
  assert(imeLine.text && !imeLine.text.trimStart().startsWith('-') && imeLine.marker && imeLine.marker!=='none',`IME composition keeps one rendered list marker: ${JSON.stringify(imeLine)}`);
  await c.command('Input.insertText',{text:'首'});
  await wait(`document.querySelector('#status').textContent==='正文已确认'`,60000);
  assert.equal(await getSource(),original.slice(0,imeOffset)+'首'+original.slice(imeOffset),'IME commit updates the intended list position');
  await undo();
  evidence.push({case:'mixed-list-ime-and-undo'});

  await scrollTo('- [ ] 待办事项');
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('待办事项') && n.querySelector('.jot-live-preview-task-checkbox'))`,60000);
  const taskPoint=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('待办事项')).querySelector('.jot-live-preview-task-checkbox'),r=n.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  await pointer(taskPoint);
  await wait(`document.querySelector('#status').textContent==='正文已确认' && view.state.doc.toString().includes('- [x] 待办事项')`);
  assert.equal(await getSource(),original.replace('- [ ] 待办事项','- [x] 待办事项'),'the checkbox changes its own source marker');
  await undo();
  evidence.push({case:'mixed-task-toggle-and-undo'});

  const tableOffset=await scrollTo('| 名称 | 对齐 | 说明 |');
  const tableExpression=`[...view.contentDOM.querySelectorAll('.jot-table')].find(n=>Number(n.dataset.jotSourceFrom)===${tableOffset})`;
  await wait(`!!${tableExpression}?.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="1"]')`,60000);
  const cellPoint=await c.evaluate(`(()=>{const n=${tableExpression}.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="1"]'),r=n.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  await pointer(cellPoint);
  await wait(`!${tableExpression}?.querySelector('[data-jot-table-command="table.delete-column"]')?.disabled`);
  const deletePoint=await c.evaluate(`(()=>{const r=${tableExpression}.querySelector('[data-jot-table-command="table.delete-column"]').getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  await pointer(deletePoint);
  await wait(`document.querySelector('#status').textContent==='正文已确认' && ${tableExpression}?.getAttribute('aria-colcount')==='2'`,60000);
  assert.notEqual(await getSource(),original,'deleting a column changes the actual Markdown');
  await undo();
  evidence.push({case:'mixed-table-delete-column-and-undo'});

  await scrollTo('![布局示意图]');
  await wait(`(()=>{const n=view.contentDOM.querySelector('img.jot-image[alt="布局示意图"]');return !!n&&n.complete&&n.naturalWidth>0&&(${visible})(n)})()`,60000);
  const image=await c.evaluate(`(()=>{const n=view.contentDOM.querySelector('img.jot-image[alt="布局示意图"]'),r=n.getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,paneLeft:p.left,paneRight:p.right}})()`);
  assert(image.left>=image.paneLeft-1 && image.right<=image.paneRight+1,'the image fits the actual editor viewport');
  const blank=await c.evaluate(`(()=>{const line=view.contentDOM.querySelector('img.jot-image[alt="布局示意图"]').closest('.cm-line'),n=line.previousElementSibling,r=n?.getBoundingClientRect();return n?.classList.contains('jot-live-preview-blank-line')&&r?{x:r.left+8,y:(r.top+r.bottom)/2,position:view.posAtDOM(n,0),scroll:view.scrollDOM.scrollTop}:null})()`);
  assert(blank,'the mixed image has an adjacent real empty line');
  await pointer({x:blank.x,y:blank.y});await frame();
  const imageAfter=await c.evaluate(`(()=>{const r=view.contentDOM.querySelector('img.jot-image[alt="布局示意图"]').getBoundingClientRect();return{top:r.top,bottom:r.bottom,scroll:view.scrollDOM.scrollTop,head:view.state.selection.main.head}})()`);
  assert.equal(imageAfter.head,blank.position,'the blank line owns the caret');
  // Offscreen height estimates may change scrollTop while the viewport
  // preserves its anchor; the actual image box must remain stationary.
  assert(Math.abs(imageAfter.top-image.top)<=1 && Math.abs(imageAfter.bottom-image.bottom)<=1,`activating the blank must not move the image: ${JSON.stringify({image,blank,imageAfter})}`);
  await screenshot('image');evidence.push({case:'mixed-image',...image});

  await scrollTo('``` mermaid\nflowchart');
  await wait(`(()=>{const n=view.contentDOM.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg');return !!n&&(${visible})(n)})()`,60000);
  await screenshot('mermaid');evidence.push({case:'mixed-mermaid'});
  await scrollTo('```mermaid\ngantt');
  await wait(`[...view.contentDOM.querySelectorAll('.jot-plugin-block[data-jot-plugin-state="ready"] svg')].some(n=>n.textContent.includes('设计与准备') && (${visible})(n))`,60000);
  evidence.push({case:'mixed-unspaced-gantt'});

  const codeOffset=await scrollTo('const codeLine80');
  await wait(`[...view.contentDOM.querySelectorAll('.jot-code-line[data-jot-line-number="80"]')].some(n=>n.textContent.includes('const codeLine80') && (${visible})(n))`,60000);
  const codeBefore=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.jot-code-line')].find(n=>n.textContent.includes('const codeLine81'));return n?.getBoundingClientRect().top})()`);
  const codePoint=await c.evaluate(`(()=>{const r=view.coordsAtPos(${codeOffset+8});return{x:r.left+1,y:(r.top+r.bottom)/2}})()`);
  await pointer(codePoint);
  const codeCaret=await c.evaluate('view.state.selection.main.head');
  assert(codeCaret>=codeOffset && codeCaret<original.indexOf('\n',codeOffset),'the pointer enters the intended code row');
  await c.command('Input.insertText',{text:'新'});
  await wait(`document.querySelector('#status').textContent==='正文已确认'`,60000);
  assert.equal(await getSource(),original.slice(0,codeCaret)+'新'+original.slice(codeCaret),'code editing changes only the intended source position');
  await frame();
  const codeAfter=await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.jot-code-line')].find(n=>n.textContent.includes('const codeLine81'));return n?.getBoundingClientRect().top})()`);
  assert(Number.isFinite(codeBefore) && Number.isFinite(codeAfter) && Math.abs(codeBefore-codeAfter)<=1,'editing the middle of the code block keeps the next line in place');
  await undo();
  evidence.push({case:'long-code-middle-edit-and-undo'});

  await scrollTo('单行开始');
  await wait(`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('单行开始') && (${visible})(n))`,60000);
  const longFrom=original.indexOf('单行开始'),longEnd=original.indexOf('单行结束');
  const longLine=await c.evaluate(`view.state.doc.lineAt(${longFrom}).length`);
  assert(longLine>20000 && longEnd-longFrom>20000,'the source really contains a long physical line');
  // CodeMirror can mount only the visible part of a very long wrapped line.
  // Move to the other end and type there rather than requiring one giant DOM.
  await c.evaluate(`view.focus();view.dispatch({selection:{anchor:${longEnd}},scrollIntoView:true})`);
  await wait(`view.state.selection.main.head===${longEnd} && view.visibleRanges.some(r=>r.from<=${longEnd} && ${longEnd}<=r.to)`,60000);
  await c.command('Input.insertText',{text:'末'});
  await wait(`document.querySelector('#status').textContent==='正文已确认'`,60000);
  assert.equal(await getSource(),original.slice(0,longEnd)+'末'+original.slice(longEnd),'typing at the long line end updates its exact source position');
  await undo();
  evidence.push({case:'long-physical-line',utf16:longLine});
  }

  const foldOffset=original.indexOf('## 混合记录 0140');
  assert(foldOffset>=0,'the mixed document contains the fold target');
  // 先展开目标位置的虚拟窗口。视口上方的表格和引用会在挂载后重新测量。
  await c.evaluate(`view.dispatch({selection:{anchor:${foldOffset}},effects:view.constructor.scrollIntoView(${foldOffset},{y:'center'})});window.mixedFoldScrolls=0`);
  await wait(`(async()=>{
    const measure=()=>{
      const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes('混合记录 0140'));
      const row=line?.getBoundingClientRect(),pane=view.scrollDOM.getBoundingClientRect();
      if(!row)return;
      const button=[...document.querySelectorAll('.jot-heading-fold-gutter button[data-jot-fold-id]')].find(n=>{
        const r=n.getBoundingClientRect(),y=r.top+r.height/2;
        return y>=row.top&&y<=row.bottom;
      });
      if(button?.getAttribute('aria-expanded')!=='true')return;
      const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      return {id:button.dataset.jotFoldId,x,y,delta:row.top-(pane.top+pane.height/3),
        inside:row.top>pane.top+20&&row.bottom<pane.bottom-20&&r.top>=pane.top&&r.bottom<=pane.bottom,
        hit:document.elementFromPoint(x,y)===button};
    };
    const first=measure();
    if(!first)return false;
    for(let frame=0;frame<2;frame++){
      await new Promise(requestAnimationFrame);
      const next=measure();
      if(!next||next.id!==first.id||next.hit!==first.hit||next.inside!==first.inside||Math.abs(next.x-first.x)>=1||Math.abs(next.y-first.y)>=1||Math.abs(next.delta-first.delta)>=1)return false;
    }
    // 只在准备视口时修正滚动。标题和按钮到位后，由下方的真实鼠标事件点击一次。
    if(Math.abs(first.delta)>=48||!first.inside){
      if(window.mixedFoldScrolls<3){
        window.mixedFoldScrolls++;
        view.scrollDOM.scrollTop+=first.delta;
      }
      return false;
    }
    if(!first.hit)return false;
    window.mixedFoldPoint=first;
    document.addEventListener('click',event=>{
      window.mixedFoldHit=event.target.closest?.('button[data-jot-fold-id]')?.dataset.jotFoldId??null;
    },{capture:true,once:true});
    return true;
  })()`,60000);
  const foldPoint=await c.evaluate('mixedFoldPoint');
  const foldButton=`document.querySelector('.jot-heading-fold-gutter button[data-jot-fold-id="'+${JSON.stringify(foldPoint.id)}+'"]')`;
  await pointer({x:foldPoint.x,y:foldPoint.y});
  assert.equal(await c.evaluate('window.mixedFoldHit'),foldPoint.id,'the real click reaches the intended section heading');
  await wait(`${foldButton}?.getAttribute('aria-expanded')==='false'`,60000);
  await wait(`view.contentDOM.innerText.includes('混合记录 0141') && !view.contentDOM.innerText.includes('列表 0140')`,60000);
  assert.equal(await getSource(),original,'folding hides the section without modifying the mixed document');
  // Folding can correct earlier estimated heights; bring the control back
  // inside the actual pane before issuing a real pointer click to unfold.
  await c.evaluate(`(()=>{const r=${foldButton}.getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();if(r.bottom>p.bottom-20)view.scrollDOM.scrollTop+=r.bottom-p.bottom+60;else if(r.top<p.top+20)view.scrollDOM.scrollTop-=p.top-r.top+60})()`);
  await wait(`(()=>{const r=${foldButton}?.getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();return !!r&&r.top>=p.top&&r.bottom<=p.bottom})()`,30000);
  const unfoldPoint=await c.evaluate(`(()=>{const r=${foldButton}.getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
  await pointer(unfoldPoint);
  await wait(`${foldButton}?.getAttribute('aria-expanded')==='true'`,60000);
  assert.equal(await getSource(),original,'unfolding preserves the mixed document');
  evidence.push({case:'mixed-heading-fold-and-expand'});

  for(const ratio of [.13,.5,.87,.25]) {
    if(process.env.JOT_MIXED_TRACE)console.log('mixed scroll',ratio);
    await c.evaluate(`view.scrollDOM.scrollTop=(view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight)*${ratio}`);
    await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:650});
    try{await wait(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),visible=n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>p.top&&r.top<p.bottom},nodes=[...view.contentDOM.querySelectorAll('.cm-line,.jot-table,.jot-live-preview-widget--block')].filter(visible);if(!nodes.some(n=>n.textContent.trim().length>0))return false;const ticks=String.fromCharCode(96).repeat(3);return nodes.filter(n=>n.classList.contains('cm-line')&&!n.classList.contains('jot-live-preview-active-line')).every(n=>{const s=n.textContent.trim();return !s.startsWith('## 混合记录 ')&&!s.startsWith('> >>>>')&&s!=='| 名称 | 状态 | 备注 |'&&s!==ticks+' ts'&&s!==ticks+' mermaid'&&s!=='$$'})})()`,60000)}catch(error){
      if(process.env.JOT_MIXED_TRACE){console.error('mixed scroll unavailable',ratio,await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return{scroll:view.scrollDOM.scrollTop,height:view.scrollDOM.scrollHeight,status:document.querySelector('#status').textContent,selection:view.state.selection.main.head,lines:[...view.contentDOM.querySelectorAll('.cm-line')].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>p.top&&r.top<p.bottom}).map(n=>({text:n.textContent.slice(0,100),class:n.className,html:n.outerHTML.slice(0,600)})).slice(0,30)}})()`));await screenshot(`scroll-failure-${ratio}`)}
      throw error;
    }
    await frame();
    const state=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect(),nodes=[...view.contentDOM.querySelectorAll('.cm-line,.jot-table,.jot-live-preview-widget--block')].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>p.top&&r.top<p.bottom&&n.textContent.trim().length>0});return{scroll:view.scrollDOM.scrollTop,height:view.scrollDOM.scrollHeight,visible:nodes.length,mounted:view.contentDOM.querySelectorAll('.cm-line').length,text:nodes.map(n=>n.textContent).join(' ').slice(0,120)}})()`);
    assert(state.visible>0 && state.mounted<500,`scroll ${ratio} must show virtualized document content: ${JSON.stringify(state)}`);
    evidence.push({case:'mixed-fast-scroll',ratio,...state});
  }

  await scrollTo('长文档结束。');
  await c.evaluate(`view.scrollDOM.scrollTop=view.scrollDOM.scrollHeight`);
  const endVisible=`[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent.includes('长文档结束。') && (${visible})(n))`;
  let reachedEnd=false,endScrollAttempts=0;
  // Newly measured virtual blocks can extend the scroll range after an
  // initial jump. Continue with real wheel input as a reader would.
  for(let attempt=0;attempt<8 && !reachedEnd;attempt++) {
    endScrollAttempts+=1;
    await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:1600});
    try { await wait(endVisible,3000);reachedEnd=true; }
    catch(error) { if(!String(error).includes('timed out waiting for browser expression')) throw error; }
  }
  assert(reachedEnd,'repeated scrolling must reach the actual visible document end');
  assert.equal(await getSource(),original,'scrolling and rendering never change the mixed source');
  evidence.push({case:'mixed-unclosed-tail',wheelAttempts:endScrollAttempts});
  await screenshot('end');
  if (!process.env.JOT_MIXED_FOLD_ONLY) {
    // Inserting at the start used to scan the old suffix for every new block.
    const payload = '\n' + original + '\n';
    for (const kind of ['insert-button','paste-event']) {
      await c.evaluate(`view.dispatch({selection:{anchor:0},scrollIntoView:true});view.focus();window.insertionStarted=performance.now()`);
      if (kind === 'insert-button') {
        await pointer(await c.evaluate(`(()=>{const r=document.querySelector('#insert').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`));
      } else {
        await c.evaluate(`(()=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',${JSON.stringify(payload)});
          view.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
        })()`);
      }
      await wait(`view.state.doc.length===${payload.length+original.length} && document.querySelector('#status').textContent==='正文已确认'`,5000);
      const elapsed = await c.evaluate('performance.now()-insertionStarted');
      assert.equal(await c.evaluate('view.state.selection.main.head'),payload.length,'the caret follows the inserted text');
      assert.equal(await getSource(),payload+original,'the sample and unchanged suffix survive exactly');
      await c.evaluate('view.scrollDOM.scrollTop=0');
      await wait(`[...view.contentDOM.querySelectorAll('.cm-line.jot-md-heading')].some(line=>line.textContent.trim()==='大文本')`);
      await c.evaluate('view.focus()');
      await key('z',modifier);
      await wait(`view.state.doc.length===${original.length} && document.querySelector('#status').textContent==='正文已确认'`);
      assert.equal(await getSource(),original,'one undo restores the original document');
      evidence.push({case:kind,elapsedMs:elapsed});
    }
  }
  assert.equal(await c.evaluate(`document.querySelector('#status').hasAttribute('data-error')`),false);
  assert.deepEqual(errors,[]);
  const scope=process.env.JOT_MIXED_FOLD_ONLY?'fold-and-scroll':'full';
  writeFileSync(resolve(output,'report.json'),JSON.stringify({status:'pass',scope,evidence},null,2));
  console.log(`PASS: Demo mixed 1 MiB ${scope} browser checks: ${output}`);
} catch(error) {
  if(c) { try {const shot=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,'failure.png'),Buffer.from(shot.data,'base64'))} catch {} }
  writeFileSync(resolve(output,'report.json'),JSON.stringify({status:'fail',error:String(error),evidence},null,2));
  throw error;
} finally {
  c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
