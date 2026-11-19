// Component-level browser audit for table boundaries, Unicode and list marker geometry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_AUDIT_PORT??4333),debugPort=Number(process.env.JOT_AUDIT_DEBUG_PORT??9533);
const diagnostic=process.env.JOT_AUDIT_DIAG==='1';
const profile=mkdtempSync(resolve(tmpdir(),'jot-boundary-audit-'));
let server,chrome,c;
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(page=>page.type==='page'&&page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
  const wait=(expr,timeout=30000)=>waitForEvaluation(c,expr,timeout);
  const frame=()=>c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await wait(`document.readyState==='complete'&&document.title==='Jot native component integration fixture'`);
  await c.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.id='boundary-audit';root.style.cssText='width:800px;height:700px;margin:10px';document.body.replaceChildren(root);
    window.errors=[];window.worker=new Worker('/src/worker.ts',{type:'module'});
    window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:worker,documentId:'boundary-audit',generation:1,source:'',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>errors.push(String(e))});
    await editor.open();window.view=editor.input.view;
  })()`);
  const load=async source=>{
    await c.evaluate(`(async()=>{await editor.setMode('live-preview');editor.setValue(${JSON.stringify(source)})})()`);
    await wait(`editor.value===${JSON.stringify(source)}&&editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state==='complete'`);
    await c.evaluate('editor.livePreview.settled()');await frame();
  };
  const select=async at=>{await c.evaluate(`editor.input.setSelection(${at});editor.focus()`);await frame()};
  const key=async(name,modifiers=0)=>{
    const code=name==='z'?'KeyZ':name,virtual={Backspace:8,Delete:46,Enter:13,z:90}[name]??0;
    for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:virtual,modifiers});
  };
  const settle=async()=>{await wait('editor.value===editor.confirmedValue&&editor.session.adapter.analysis?.state===\'complete\'');await c.evaluate('editor.livePreview.settled()');await frame()};
  const state=()=>c.evaluate(`(()=>({value:editor.value,confirmed:editor.confirmedValue,head:view.state.selection.main.head,focus:document.activeElement?.className,roots:editor.session.adapter.blocks.blocks.map(b=>({kind:b.kind,from:Number(b.sourceRange.from),to:Number(b.sourceRange.to)})),errors:[...errors]}))()`);
  const mod=await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')?4:2;
  const results=[];
  for(const mode of ['live-preview','split']){
    const table='| A | B |\n| --- | --- |\n| x | y |';
    const source=table+'\n\n之后', at=table.length+1;
    await load(source);
    await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);await select(at);
    await wait("document.querySelector('.jot-table-grid-body .jot-table-row')?.textContent==='xy'");
    await c.evaluate("window.widthGrid=document.querySelector('.jot-table');window.widthRow=widthGrid.querySelector('.jot-table-grid-body .jot-table-row');");
    const dimensions=()=>c.evaluate(`(()=>{const grid=document.querySelector('.jot-table'),row=grid.querySelector('.jot-table-grid-body .jot-table-row');return {sameGrid:grid===widthGrid,sameRow:row===widthRow,cols:grid.getAttribute('aria-colcount'),widths:[...row.querySelectorAll('.jot-table-cell')].map(cell=>cell.getBoundingClientRect().width),rows:grid.getAttribute('aria-rowcount'),overflow:grid.scrollWidth-grid.clientWidth,visible:modeSource()};function modeSource(){return document.querySelector('#boundary-audit').textContent.includes('||||')}})()`);
    const before=await dimensions();
    await c.command('Input.insertText',{text:'||||'});await settle();await c.evaluate('editor.settled()');await frame();
    const draft=await dimensions();
    assert.equal((await state()).value,table+'\n||||\n之后');
    assert.equal(draft.cols,'2');assert.equal(draft.rows,before.rows);assert(draft.visible);
    assert.deepEqual(draft.widths,before.widths);assert.equal(draft.overflow,before.overflow);
    assert(draft.sameGrid&&draft.sameRow);
    await key('Backspace');await settle();await c.evaluate('editor.settled()');
    await wait("document.querySelector('.jot-table')?.getAttribute('aria-rowcount')==='3'");
    const appended=await dimensions();
    assert.equal((await state()).value,table+'\n|||\n之后');
    assert.deepEqual(appended.widths,before.widths);assert.equal(appended.overflow,before.overflow);
    assert(appended.sameGrid&&appended.sameRow);
    if(mode==='live-preview'){
      assert.equal((await state()).head,at+2,'correction places the visual caret before the final hidden pipe');
      await c.command('Input.insertText',{text:'新'});await settle();
      assert.equal((await state()).value,table+'\n||新|\n之后');
    }
    results.push({case:`table-oversized-draft-${mode}`,before,draft,appended});
  }
  {
    const source='| A | B |\n| --- | --- |\n|x|y|';
    const end=source.lastIndexOf('x')+1;
    await load(source);
    const point=await c.evaluate(`(()=>{const cell=document.querySelector('.jot-table-grid-body .jot-table-cell'),r=cell.getBoundingClientRect();return{x:r.left+5,y:r.top+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await wait("document.activeElement?.classList.contains('jot-live-preview-table-ime--active')");
    await c.evaluate(`editor.input.setSelection(${end})`);
    const body=()=>c.evaluate(`[...document.querySelectorAll('.jot-table-grid-body .jot-table-row')].map(row=>[...row.querySelectorAll('.jot-table-cell')].map(cell=>cell.textContent))`);
    await c.command('Input.insertText',{text:'\\'});await settle();
    await wait(`document.querySelector('.jot-table-grid-body .jot-table-cell')?.textContent===${JSON.stringify('x\\')}`);
    assert.equal((await state()).value,source.replace('|x|','|x\\\\|'));
    assert.deepEqual(await body(),[['x\\','y']]);
    await c.command('Input.insertText',{text:'|'});await settle();
    await wait(`document.querySelector('.jot-table-grid-body .jot-table-cell')?.textContent===${JSON.stringify('x\\|')}`);
    assert.equal((await state()).value,source.replace('|x|','|x\\\\\\||'));
    assert.deepEqual(await body(),[['x\\|','y']]);
    await key('Backspace');await settle();
    assert.equal((await state()).value,source.replace('|x|','|x\\\\|'));
    await key('Backspace',1|8);await settle();
    assert.equal((await state()).value,source.replace('|x|','||'),'Alt+Shift+Backspace empties the current cell without deleting its column');
    await wait(`document.querySelector('.jot-table-grid-body .jot-table-cell')?.textContent===''`);
    assert.deepEqual(await body(),[['','y']]);
    await key('z',mod);await settle();
    assert.equal((await state()).value,source.replace('|x|','|x\\\\|'));
    results.push({case:'table-escape-and-clear-shortcut'});
  }
  // A blank source line immediately below a table is an ordinary text line,
  // even when its first character happens to be a table delimiter.
  for(const mode of ['live-preview','split']){
    const table='| A | B |\n| --- | --- |\n| x | y |';
    const prefix='前文\n\n'.repeat(26)+table+'\n';
    const code='\n``` rust\nfn main() {}\n```\n\n'+('尾部\n\n'.repeat(44));
    const source=prefix+code, at=prefix.length;
    for(const operation of ['pipe','enter','append']){
      await load(source);
      await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);
      await select(at);
      await c.evaluate('editor.settled()');
      await wait(`!!document.querySelector(${JSON.stringify(mode==='split'?'.jot-editor-surface .jot-table':'.jot-live-preview-widget--table.jot-table')})`);
      const initial=await c.evaluate(`(()=>{
        window.seamGrid=document.querySelector('.jot-table');
        window.seamRow=seamGrid.querySelector('.jot-table-grid-body .jot-table-row');
        window.seamDetach=0;
        window.seamObserver=new MutationObserver(records=>{for(const record of records)for(const n of record.removedNodes)if(n===seamGrid||n.contains(seamGrid))seamDetach++});
        seamObserver.observe(document.querySelector('#boundary-audit'),{subtree:true,childList:true});
        window.seamSnapshot=()=>{
          const head=view.state.selection.main.head, caret=view.coordsAtPos(head,1), rect=seamGrid.getBoundingClientRect();
          return {head, line:view.state.doc.lineAt(head).text,
            visibleLine:[...view.contentDOM.querySelectorAll('.cm-line')].some(n=>n.textContent===view.state.doc.lineAt(head).text),
            caret:caret===null?null:{top:caret.top,bottom:caret.bottom}, viewportTop:view.scrollDOM.getBoundingClientRect().top,
            viewportBottom:view.scrollDOM.getBoundingClientRect().bottom, windowY:window.scrollY,
            tableTop:rect.top, tableId:seamGrid.dataset.jotNodeId, currentId:document.querySelector('.jot-table')?.dataset.jotNodeId,
            tableEnd:document.querySelector('.jot-table')?.dataset.jotSourceTo, sameGrid:seamGrid===document.querySelector('.jot-table'),removals:seamDetach,
            sameRow:seamRow===seamGrid.querySelector('.jot-table-grid-body .jot-table-row')};
        };
        return seamSnapshot();
      })()`);
      const input=operation==='enter'?'\n':'|';
      if(operation==='enter')await key('Enter');else await c.command('Input.insertText',{text:input});
      const pending=await c.evaluate('seamSnapshot()');
      await settle();await c.evaluate('editor.settled()');await frame();
      const after=await c.evaluate('seamSnapshot()');
      const value=await state();
      results.push({case:`table-seam-${mode}-${operation}`,initial,pending,after,value});
      if(!diagnostic){
        assert.equal(value.value,prefix+input+code);
        assert.equal(value.head,at+1);
        for(const snapshot of [pending,after]){
          assert(snapshot.sameGrid&&snapshot.sameRow&&snapshot.removals===0,`the grid survives an unrelated edit: ${JSON.stringify({mode,operation,initial,pending,after})}`);
          assert.equal(snapshot.windowY,initial.windowY,'typing must not scroll the embedding page');
          assert(Math.abs(snapshot.tableTop-initial.tableTop)<40,'only the normal one-line reveal may move the viewport');
          assert(snapshot.caret&&snapshot.caret.top>=snapshot.viewportTop-1&&snapshot.caret.bottom<=snapshot.viewportBottom+1,'the source caret remains visible in the pane');
        }
        assert(after.visibleLine,'the typed pipe or new blank line remains on a physical source line');
        assert.equal(value.roots.find(b=>b.kind==='table')?.to,at-1,'the following physical line does not join the table');
      }
      if(operation==='append'){
        await c.command('Input.insertText',{text:'新增'});await settle();
        if(!diagnostic){
          assert.equal((await state()).roots.find(b=>b.kind==='table')?.to,at-1,'a leading pipe with text is still a draft');
          assert((await c.evaluate('seamSnapshot()')).sameGrid);
        }
        await c.command('Input.insertText',{text:'|'});await settle();await c.evaluate('editor.settled()');await frame();
        const appended=await c.evaluate(`({...seamSnapshot(),focus:document.activeElement?.className,
          active:document.querySelector('.jot-live-preview-table-cell--active')?.textContent,
          rows:[...seamGrid.querySelectorAll('.jot-table-grid-body .jot-table-row')].map(r=>r.textContent)})`);
        results.push({case:`table-keyboard-append-${mode}`,appended});
        if(!diagnostic){
          assert(appended.sameGrid&&appended.sameRow&&appended.removals===0,`appending reuses the existing grid and row: ${JSON.stringify(appended)}`);
          assert.deepEqual(appended.rows,['xy','新增']);
          assert.equal((await state()).roots.find(b=>b.kind==='table')?.to,at+'|新增|'.length);
          assert.equal(appended.windowY,initial.windowY);
          if(mode==='live-preview'){
            assert.equal(appended.active,'新增');
            assert.equal(appended.head,at+'|新增'.length,'caret lands before the hidden closing pipe');
            assert.match(appended.focus,/jot-live-preview-table-ime--active/);
          }
        }
        if(mode==='live-preview'){
          await c.command('Input.insertText',{text:'结果'});await settle();
          if(!diagnostic)assert.equal((await state()).value,prefix+'|新增结果|'+code,'typing after row confirmation edits its cell');
        }
      }
      await c.evaluate('seamObserver.disconnect()');
    }
  }
  for(const pipes of [true,false]){
    const table=pipes?'| A | B |\n| --- | --- |\n| x | y |':'A | B\n--- | ---\nx | y';
    const source='before\n\n'+table+'\n\nafter',afterTable=source.indexOf('\n\nafter')+1;
    await load(source);await select(afterTable);const before=await state();await key('Backspace');await settle();const after=await state();
    results.push({case:`table-external-backspace-${pipes?'outer-pipes':'no-outer-pipes'}`,before,after});
    if(!diagnostic)assert.equal(after.value,'before\n\n\nafter','Backspace at the external table boundary removes the root and preserves the blank lines on both sides');
  }
  for(const focus of ['cell','source']){
    const source='A | B\n--- | ---\nx | y';
    await load(source);
    if(focus==='cell'){
      const point=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="1"]'),r=n.getBoundingClientRect();return{x:r.left+Math.min(10,r.width/2),y:r.top+r.height/2}})()`);
      for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
      await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`);
      await c.evaluate(`editor.input.setSelection(${source.length})`);await frame();
    }else await select(source.length);
    const before=await state();await key('Backspace');await settle();const after=await state();
    results.push({case:`table-eof-last-cell-backspace-${focus}`,before,after});
    if(!diagnostic)assert.equal(after.value,source.slice(0,-1),'Backspace at the last cell of an unterminated table edits that cell, never the whole root');
    if(!diagnostic){await key('z',mod);await settle();assert.equal((await state()).value,source,'the cell edit is undoable');}
  }
  for(const [source,expected] of [
    ['A | B\n--- | ---\nx | y',' | B\n--- | ---\nx | y'],
    ['| A | B |\n| --- | --- |\n| x | y |',''],
  ]){
    await load(source);await select(0);const before=await state();await key('Delete');await settle();const after=await state();
    results.push({case:'table-start-forward-delete',before,after});
    if(!diagnostic)assert.equal(after.value,expected,'a cell sharing the root start keeps character deletion while an external pipe boundary deletes the table');
  }
  for(const cluster of ['😀','e\u0301','👨‍👩‍👧‍👦','🇨🇳','👍🏽']){
    const source=`before\n\n| A | B |\n| --- | --- |\n| a${cluster}b | y |\n\nafter`,at=source.indexOf(cluster)+cluster.length;
    await load(source);
    const point=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="0"]'),r=n.getBoundingClientRect();return{x:r.left+Math.min(10,r.width/2),y:r.top+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`);
    await c.evaluate(`editor.input.setSelection(${at})`);await frame();
    const before=await state();await key('Backspace');await settle();const after=await state();
    results.push({case:`table-grapheme-backspace-${cluster}`,before,after});
    if(!diagnostic)assert.equal(after.value,source.replace(cluster,''),'deleting one displayed grapheme preserves the rest of the cell');
  }
  // Compare the painted caret with the actual DOM text boundary, including
  // source delimiters hidden by inline formatting. Input still goes through
  // the same focused table IME surface and the canonical source transaction.
  const inlineTable='| A | B |\n| --- | --- |\n| a**bc**d | `xy` |';
  for(const [text,sourceOffset,column] of [['bc',inlineTable.indexOf('bc')+1,0],['xy',inlineTable.indexOf('xy')+1,1]]){
    await load(inlineTable);
    const point=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="${column}"]'),r=n.getBoundingClientRect();return{x:r.left+Math.min(10,r.width/2),y:r.top+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`);
    await c.evaluate(`editor.input.setSelection(${sourceOffset})`);await frame();
    const geometry=await c.evaluate(`(()=>{const cell=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="${column}"]'),walk=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let n;while((n=walk.nextNode())&&!n.nodeValue.includes(${JSON.stringify(text)})){}if(!n)return{html:cell.innerHTML};const range=new Range();range.setStart(n,n.nodeValue.indexOf(${JSON.stringify(text)})+1);range.collapse(true);return{actual:cell.getBoundingClientRect().left+parseFloat(cell.style.getPropertyValue('--jot-live-table-caret-inline-start')),expected:range.getBoundingClientRect().left,html:cell.innerHTML,head:view.state.selection.main.head}})()`);
    results.push({case:`table-inline-caret-${text}`,geometry});
    if(!diagnostic)assert(Math.abs(geometry.actual-geometry.expected)<1,`the visible caret follows the ${text} text boundary: ${JSON.stringify(geometry)}`);
    await c.command('Input.insertText',{text:'X'});await settle();
    if(!diagnostic)assert.equal((await state()).value,inlineTable.slice(0,sourceOffset)+'X'+inlineTable.slice(sourceOffset),'input follows the caret source position');
  }
  for(const [side,offset,visibleOffset] of [
    ['open',inlineTable.indexOf('**')+1,0],
    ['close',inlineTable.lastIndexOf('**')+1,2],
  ]){
    await load(inlineTable);
    const point=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="0"]'),r=n.getBoundingClientRect();return{x:r.left+Math.min(10,r.width/2),y:r.top+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`);
    await c.evaluate(`editor.input.setSelection(${offset})`);await frame();
    const geometry=await c.evaluate(`(()=>{const cell=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="0"]'),walk=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let n;while((n=walk.nextNode())&&!n.nodeValue.includes('bc')){}const range=new Range();range.setStart(n,n.nodeValue.indexOf('bc')+${visibleOffset});range.collapse(true);return{actual:cell.getBoundingClientRect().left+parseFloat(cell.style.getPropertyValue('--jot-live-table-caret-inline-start')),expected:range.getBoundingClientRect().left,html:cell.innerHTML}})()`);
    results.push({case:`table-hidden-delimiter-caret-${side}`,geometry});
    if(!diagnostic)assert(Math.abs(geometry.actual-geometry.expected)<1,`hidden ${side} delimiter maps to the nearest visible boundary: ${JSON.stringify(geometry)}`);
  }
  const mixedInline='| A | B |\n| --- | --- |\n| [link](https://example.test) | a $x^2$ z |';
  for(const [label,column,offset,selector,edge] of [
    ['link-destination',0,mixedInline.indexOf('example'), '[data-jot-kind="text"]','end'],
    ['opaque-math',1,mixedInline.indexOf('x^2')+1, '[data-jot-kind="inline-math"]','start'],
  ]){
    await load(mixedInline);
    const point=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="${column}"]'),r=n.getBoundingClientRect();return{x:r.right-2,y:r.top+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    try{await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`,4000)}catch(error){
      console.error('mixed caret focus diagnostic',label,await c.evaluate(`({url:location.href,active:document.activeElement?.outerHTML?.slice(0,500),table:document.querySelector('.jot-table-grid-body')?.outerHTML?.slice(0,1500)})`).catch(String));throw error;
    }
    await c.evaluate(`editor.input.setSelection(${offset})`);await frame();
    const geometry=await c.evaluate(`(()=>{const cell=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="${column}"]'),item=cell.querySelector(${JSON.stringify(selector)}),r=item?.getBoundingClientRect();return{actual:cell.getBoundingClientRect().left+parseFloat(cell.style.getPropertyValue('--jot-live-table-caret-inline-start')),expected:r?.[${JSON.stringify(edge==='start'?'left':'right')}],html:cell.innerHTML}})()`);
    results.push({case:`table-mixed-caret-${label}`,geometry});
    if(!diagnostic)assert(Math.abs(geometry.actual-geometry.expected)<1.5,`the ${label} caret maps to its semantic edge: ${JSON.stringify(geometry)}`);
  }
  for(const mode of ['live-preview','split','preview']){
    const address=`http://127.0.0.1:${port}/?jot-link=${mode}`;
    await load(`开头\n\n[正文链接](${address}-inline)\n\n| A | B |\n| --- | --- |\n| [单元格链接](${address}-cell) | b |`);
    await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);await select(0);await c.evaluate('editor.settled()');
    for(const location of ['inline','cell']){
      const href=address+'-'+location, previousUrl=await c.evaluate('window.location.href');
      const point=await c.evaluate(`(()=>{const a=document.querySelector('a[href="${href}"]');const range=new Range();range.selectNodeContents(a);const r=range.getClientRects()[0];const x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,target:a.target,rel:a.rel,hit:document.elementFromPoint(x,y)?.outerHTML?.slice(0,180)}})()`);
      for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:point.x,y:point.y});
      let opened;
      for(let i=0;i<30&&!opened;i++){
        opened=(await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json())).find(page=>page.type==='page'&&page.url===href);
        if(!opened)await new Promise(resolve=>setTimeout(resolve,50));
      }
      results.push({case:`link-new-tab-${mode}-${location}`,opened:!!opened,target:point.target});
      if(!diagnostic){
        assert(opened,`${mode} ${location}: the browser opens the link in a new tab: ${JSON.stringify(point)}`);
        assert.equal(point.target,'_blank');assert.match(point.rel,/noopener/);
        assert.equal(await c.evaluate('window.location.href'),previousUrl);
      }
      if(opened)await c.command('Target.closeTarget',{targetId:opened.id});
      await c.command('Page.bringToFront');
    }
  }
  const escapedOnly='| A |\n| --- |\n| \\~ |';
  await load(escapedOnly);
  const escapePoint=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell'),r=n.getBoundingClientRect();return{x:r.left+1,y:r.top+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...escapePoint});
  await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`);
  await c.evaluate(`editor.input.setSelection(${escapedOnly.indexOf('\\~')+1})`);await frame();
  const escapeGeometry=await c.evaluate(`(()=>{const cell=document.querySelector('.jot-table-grid-body .jot-table-cell'),item=cell.querySelector('[data-jot-kind="escaped-text"]');return{actual:cell.getBoundingClientRect().left+parseFloat(cell.style.getPropertyValue('--jot-live-table-caret-inline-start')),expected:item?.getBoundingClientRect().left,html:cell.innerHTML}})()`);
  results.push({case:'table-escaped-text-caret',geometry:escapeGeometry});
  if(!diagnostic)assert(Math.abs(escapeGeometry.actual-escapeGeometry.expected)<1.5,`a lone escaped glyph maps to its semantic boundary: ${JSON.stringify(escapeGeometry)}`);
  // Browser-dispatched synthetic clipboard event exercises the real table
  // input listener without changing the user's system clipboard.
  const pasteSource='| A | B |\n| --- | --- |\n| a | z |',pasteAt=pasteSource.indexOf('a | z')+1;
  await load(pasteSource);
  const pastePoint=await c.evaluate(`(()=>{const n=document.querySelector('.jot-table-grid-body .jot-table-cell[data-jot-column-index="0"]'),r=n.getBoundingClientRect();return{x:r.left+10,y:r.top+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...pastePoint});
  await wait(`document.activeElement?.classList.contains('jot-live-preview-table-ime')`);
  await c.evaluate(`editor.input.setSelection(${pasteAt})`);
  const pastePrevented=await c.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain','x|y\\nz\\\\|q\\r\\n');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});document.activeElement.dispatchEvent(event);return event.defaultPrevented})()`);
  await settle();const pasted=await state();
  results.push({case:'table-synthetic-clipboard-paste',pastePrevented,after:pasted});
  if(!diagnostic){
    assert(pastePrevented,'table paste consumes the browser paste event');
    assert.equal(pasted.value,pasteSource.slice(0,pasteAt)+'x\\|y z\\|q '+pasteSource.slice(pasteAt),'newlines and pipes stay inside one table cell');
    assert.equal(await c.evaluate(`document.querySelectorAll('.jot-table-grid-header .jot-table-cell').length`),2,'paste does not add a column');
    await key('z',mod);await settle();assert.equal((await state()).value,pasteSource,'pasted cell content is undoable');
  }
  const unchanged='前文\n\n> ``` ts\n> const x = 1;\n> ```\n\n尾部';
  await load(unchanged);await c.evaluate(`editor.setMode('split')`);
  await wait(`!!document.querySelector('.jot-editor-surface blockquote .jot-code .jot-source-line')`);
  await c.evaluate('editor.settled()');await frame();
  const beforeSame=await c.evaluate(`(()=>{window.sameQuote=document.querySelector('.jot-editor-surface blockquote');window.sameQuoteRemovals=0;window.sameQuoteObserver=new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(node===sameQuote||node.contains(sameQuote))sameQuoteRemovals++});sameQuoteObserver.observe(document.querySelector('.jot-editor-surface'),{subtree:true,childList:true});return{revision:Number(editor.revision),head:view.state.selection.main.head,connected:sameQuote?.isConnected}})()`);
  await c.evaluate(`editor.setValue(${JSON.stringify(unchanged)})`);await c.evaluate('editor.settled()');await frame();
  const afterSame=await c.evaluate(`({revision:Number(editor.revision),head:view.state.selection.main.head,connected:sameQuote?.isConnected,same:sameQuote===document.querySelector('.jot-editor-surface blockquote'),removals:sameQuoteRemovals})`);
  results.push({case:'set-unchanged-value-preserves-preview',before:beforeSame,after:afterSame});
  if(!diagnostic){assert.equal(afterSame.revision,beforeSame.revision,'setting the same source does not create a Rust revision');assert(afterSame.same&&afterSame.connected&&afterSame.removals===0,'setting the same source never unmounts the Preview component');assert.equal(afterSame.head,beforeSame.head,'an unchanged value preserves the selection');}
  await c.evaluate(`editor.setValue(${JSON.stringify(unchanged.replace(/\n/g,'\r\n'))})`);await c.evaluate('editor.settled()');await frame();
  const afterSameCrlf=await c.evaluate(`(()=>{sameQuoteObserver.disconnect();return{revision:Number(editor.revision),same:sameQuote===document.querySelector('.jot-editor-surface blockquote'),removals:sameQuoteRemovals}})()`);
  results.push({case:'set-equivalent-crlf-value',after:afterSameCrlf});
  if(!diagnostic){assert.equal(afterSameCrlf.revision,beforeSame.revision,'equivalent CRLF source is not a new document');assert(afterSameCrlf.same&&afterSameCrlf.removals===0,'equivalent line endings never unmount the Preview');}
  // Dispatch the selection and key in one browser task to exercise the brief
  // period before the asynchronous presentation refresh replaces widgets.
  // The synthetic key deliberately targets that race; other scenarios use
  // trusted CDP keyboard and pointer events.
  const image='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIxMCIvPg==';
  const adjacent=`before\n\n![a](${image})![b](${image})\n\nafter`,seam=adjacent.indexOf('![b]');
  for(const direction of ['Backspace','Delete']){
    await load(adjacent);await select(0);await c.evaluate('editor.livePreview.settled()');
    await wait(`view.contentDOM.querySelectorAll('img').length>=2`);
    const after=await c.evaluate(`(()=>{view.dispatch({selection:{anchor:${seam}}});view.focus();const event=new KeyboardEvent('keydown',{key:${JSON.stringify(direction)},bubbles:true,cancelable:true});view.contentDOM.dispatchEvent(event);return{head:view.state.selection.main.head,value:editor.value,prevented:event.defaultPrevented}})()`);
    results.push({case:`adjacent-image-seam-${direction}`,seam,after});
    if(!diagnostic){assert(after.prevented,`${direction} first reveals an adjacent atomic image`);assert.equal(after.head,seam,`${direction} preserves the shared source boundary`);assert.equal(after.value,adjacent,'the reveal does not delete source');}
  }
  const list='1. 一\n10. 十\n1000. 千\n999999999. 九\n\n尾部';
  const listGeometry=()=>c.evaluate(`(()=>{
    const rows=[...view.contentDOM.querySelectorAll('.jot-live-preview-list-item')],pane=view.scrollDOM.getBoundingClientRect();
    return rows.map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n),p=getComputedStyle(n,'::before'),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=s.font;
      const marker=n.dataset.jotLiveListMarker??'',width=ctx.measureText(marker).width,pseudoLeft=parseFloat(p.insetInlineStart),pseudoWidth=parseFloat(p.inlineSize);
      return{marker,raw:view.state.doc.lineAt(view.posAtDOM(n,0)).text,left:r.left,paneLeft:pane.left,padding:parseFloat(s.paddingInlineStart),pseudoLeft,pseudoWidth,textWidth:width,markerLeft:r.left+pseudoLeft+pseudoWidth-width,markerRight:r.left+pseudoLeft+pseudoWidth};});
  })()`);
  for(const [fontSize,fontFamily] of [[14,'sans-serif'],[24,'serif'],[36,'monospace']]){
    await c.evaluate(`editor.setLayoutStyle({fontSize:${fontSize},fontFamily:${JSON.stringify(fontFamily)}})`);
    for(const quoted of [false,true]){
      const value=quoted?'>>> '+list.split('\n').slice(0,4).join('\n>>> ')+'\n\n尾部':list;
      await load(value);await select(value.length);await frame();const geometry=await listGeometry();
      results.push({case:`ordered-list-marker-${fontSize}-${fontFamily}-${quoted?'quote':'plain'}`,geometry});
      if(!diagnostic){
        assert(geometry.length>=4,'all four ordered items are rendered');
        for(const row of geometry)assert(row.markerLeft>=row.left-1,`ordered marker must remain inside its row: ${JSON.stringify(row)}`);
      }
    }
  }
  await c.evaluate(`(async()=>{await editor.setLayoutStyle({fontSize:14,fontFamily:'sans-serif'});document.querySelector('#boundary-audit').style.width='300px'})()`);
  const deep=' '.repeat(120)+'- 深层列表';await load(deep);await select(deep.length);await frame();
  const liveDeep=await c.evaluate(`(()=>{const n=view.contentDOM.querySelector('.jot-live-preview-list-item'),r=n.getBoundingClientRect(),s=getComputedStyle(n),pane=view.scrollDOM.getBoundingClientRect(),w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while((t=w.nextNode())&&!t.nodeValue.includes('深层列表')){}const range=new Range();range.setStart(t,t.nodeValue.indexOf('深层列表'));range.setEnd(t,t.nodeValue.indexOf('深层列表')+4);const glyph=range.getBoundingClientRect();return{left:r.left,right:r.right,paneLeft:pane.left,paneRight:pane.right,padding:parseFloat(s.paddingInlineStart),indent:n.style.getPropertyValue('--jot-live-list-indent'),scrollLeft:view.scrollDOM.scrollLeft,glyphLeft:glyph.left,glyphRight:glyph.right,text:n.textContent}})()`);
  await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');await frame();
  const previewDeep=await c.evaluate(`(()=>{const n=document.querySelector('.jot-editor-surface .jot-list-item'),r=n?.getBoundingClientRect(),s=n?getComputedStyle(n):null,pane=document.querySelector('#boundary-audit').getBoundingClientRect();return n?{left:r.left,right:r.right,width:r.width,paneLeft:pane.left,paneRight:pane.right,margin:s.marginInlineStart,indent:n.dataset.jotListIndent,text:n.textContent}:null})()`);
  await c.evaluate(`editor.setMode('pretext')`);await c.evaluate('editor.surface.settled()');await frame();
  const pretextDeep=await c.evaluate(`(()=>{const n=document.querySelector('.jot-pretext-block[data-jot-kind="list-item"]'),r=n?.getBoundingClientRect(),pane=document.querySelector('#boundary-audit').getBoundingClientRect();return n?{left:r.left,right:r.right,width:r.width,paneRight:pane.right,indent:n.dataset.jotListIndent}:null})()`);
  results.push({case:'deep-list-cross-mode-narrow',live:liveDeep,preview:previewDeep,pretext:pretextDeep});
  if(!diagnostic){
    assert.equal(liveDeep.indent,'48ch','live list indentation respects its documented cap');
    assert(liveDeep.glyphLeft>=liveDeep.paneLeft-1&&liveDeep.glyphRight<=liveDeep.paneRight+1&&liveDeep.scrollLeft<=1,'deep live list keeps its text inside the narrow viewport');
    assert(previewDeep&&previewDeep.width>=64&&previewDeep.right<=previewDeep.paneRight+1,'Preview preserves usable content width for a deeply indented list');
    assert(pretextDeep&&pretextDeep.width>=64&&pretextDeep.right<=pretextDeep.paneRight+1,'PreText preserves usable width for the same list');
  }
  await c.evaluate(`(async()=>{await editor.setLayoutStyle({metrics:{listMinContentWidth:120}});await editor.setMode('live-preview')})()`);
  await c.evaluate('editor.livePreview.settled()');await frame();
  const customLive=await c.evaluate(`(()=>{const row=view.contentDOM.querySelector('.jot-live-preview-list-item');return{minimum:getComputedStyle(view.contentDOM).getPropertyValue('--jot-list-min-content').trim(),padding:parseFloat(getComputedStyle(row).paddingInlineStart)}})()`);
  await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');await frame();
  const customPreview=await c.evaluate(`document.querySelector('.jot-editor-surface .jot-list-item').getBoundingClientRect().width`);
  await c.evaluate(`editor.setMode('pretext')`);await c.evaluate('editor.surface.settled()');await frame();
  const customPretext=await c.evaluate(`document.querySelector('.jot-pretext-block[data-jot-kind="list-item"]').getBoundingClientRect().width`);
  results.push({case:'deep-list-configured-width',live:customLive,previewWidth:customPreview,pretextWidth:customPretext});
  if(!diagnostic){assert.equal(customLive.minimum,'120px');assert(customLive.padding<liveDeep.padding-40,'configured minimum changes live list geometry');assert(customPreview>=120&&customPretext>=120,'the same minimum reaches both other modes');}
  await c.evaluate(`(async()=>{document.querySelector('#boundary-audit').style.direction='rtl';await editor.setLayoutStyle({fontSize:18,metrics:{listMinContentWidth:64}})})()`);
  const rtl='999999999. نص عربي';await load(rtl);await select(rtl.length);await frame();
  const rtlBox=await c.evaluate(`(()=>{const n=view.contentDOM.querySelector('.jot-live-preview-list-item'),pane=view.scrollDOM.getBoundingClientRect(),row=n.getBoundingClientRect(),s=getComputedStyle(n),p=getComputedStyle(n,'::before'),w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while((t=w.nextNode())&&!t.nodeValue.includes('نص')){}const range=new Range();range.setStart(t,t.nodeValue.indexOf('نص'));range.setEnd(t,t.nodeValue.indexOf('نص')+2);const glyph=range.getBoundingClientRect(),inset=parseFloat(p.insetInlineStart),width=parseFloat(p.inlineSize);return{direction:s.direction,markerLeft:row.right-inset-width,markerRight:row.right-inset,paneLeft:pane.left,paneRight:pane.right,glyphLeft:glyph.left,glyphRight:glyph.right,scrollWidth:view.scrollDOM.scrollWidth,clientWidth:view.scrollDOM.clientWidth}})()`);
  results.push({case:'rtl-ordered-list-geometry',geometry:rtlBox});
  if(!diagnostic){assert.equal(rtlBox.direction,'rtl');assert(rtlBox.markerLeft>=rtlBox.paneLeft-1&&rtlBox.markerRight<=rtlBox.paneRight+1,'RTL marker stays inside the viewport');assert(rtlBox.glyphLeft>=rtlBox.paneLeft-1&&rtlBox.glyphRight<=rtlBox.paneRight+1&&rtlBox.scrollWidth<=rtlBox.clientWidth+1,'RTL list text stays inside the viewport');}
  await c.evaluate(`document.querySelector('#boundary-audit').style.direction='ltr'`);
  const longList='- '+('x'.repeat(300))+'尾';await load(longList);
  await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');await frame();
  const longListBox=await c.evaluate(`(()=>{const surface=document.querySelector('.jot-editor-surface'),item=surface.querySelector('.jot-list-item'),p=item.querySelector('p'),sr=surface.getBoundingClientRect(),pr=p.getBoundingClientRect();return{clientWidth:surface.clientWidth,scrollWidth:surface.scrollWidth,paneRight:sr.right,paragraphRight:pr.right,paragraphWidth:pr.width,paragraphHeight:pr.height,overflowWrap:getComputedStyle(p).overflowWrap}})()`);
  results.push({case:'preview-list-long-unbroken-word',geometry:longListBox});
  if(!diagnostic)assert(longListBox.scrollWidth<=longListBox.clientWidth+1&&longListBox.paragraphRight<=longListBox.paneRight+1,`long list text wraps within its Preview viewport: ${JSON.stringify(longListBox)}`);
  const longCode='``` text\n'+('x'.repeat(300))+'\n```';
  const codeBoxes=[];
  for(const mode of ['scroll','wrap']){
    await load(longCode);await c.evaluate(`editor.setLayoutStyle({codeBlockWrap:${JSON.stringify(mode)}})`);
    await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');await frame();
    codeBoxes.push(await c.evaluate(`(()=>{const code=document.querySelector('.jot-editor-surface .jot-code'),line=code?.querySelector('.jot-source-line');return{mode:${JSON.stringify(mode)},width:code?.clientWidth,scrollWidth:code?.scrollWidth,height:line?.getBoundingClientRect().height,whiteSpace:line&&getComputedStyle(line).whiteSpace}})()`));
  }
  results.push({case:'preview-code-wrap-versus-scroll',geometry:codeBoxes});
  if(!diagnostic){
    assert(codeBoxes[0].scrollWidth>codeBoxes[0].width+10,'scroll mode preserves independent horizontal code scrolling');
    assert(codeBoxes[1].scrollWidth<=codeBoxes[1].width+1&&codeBoxes[1].height>codeBoxes[0].height*2,'wrap mode expands code rows inside their viewport');
  }
  for(const [kind,prefix] of [['paragraph',''],['heading','## '],['quote','>>> ']]){
    await load(prefix+('x'.repeat(300))+'尾');await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');await frame();
    const box=await c.evaluate(`(()=>{const surface=document.querySelector('.jot-editor-surface');return{clientWidth:surface.clientWidth,scrollWidth:surface.scrollWidth}})()`);
    results.push({case:`preview-${kind}-long-unbroken-word`,geometry:box});
    if(!diagnostic)assert(box.scrollWidth<=box.clientWidth+1,`${kind} text does not widen the Preview surface: ${JSON.stringify(box)}`);
  }
  if(process.env.JOT_AUDIT_AX==='1'){
    await load('- 苹果\n- 橙子');await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');await frame();
    const ax=await c.command('Accessibility.getFullAXTree'),byId=new Map(ax.nodes.map(n=>[n.nodeId,n]));
    const items=ax.nodes.filter(n=>n.role?.value==='listitem').map(node=>{
      const parents=[];let current=node;for(let i=0;i<6&&current?.parentId;i++){current=byId.get(current.parentId);if(current)parents.push(current.role?.value)}
      return{name:node.name?.value,parents};
    });
    const dom=await c.evaluate(`document.querySelector('.jot-editor-surface .jot-list-item')?.outerHTML`);
    const relevant=ax.nodes.filter(n=>n.name?.value?.includes('苹果')||n.name?.value?.includes('橙子')||n.role?.value==='list').map(n=>({role:n.role?.value,name:n.name?.value,ignored:n.ignored}));
    results.push({case:'preview-list-accessibility-diagnostic',items,relevant,dom});
  }
  assert.deepEqual(await c.evaluate('errors'),[]);
  console.log(JSON.stringify({status:'pass',results}));
} finally {
  try{if(c){await c.evaluate('editor?.dispose();worker?.terminate()');c.socket.close()}}catch{}
  await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
