// Stress the real component without replacing its parser or projection path.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const kind=process.env.JOT_CAPACITY_CASE??'code',count=Number(process.env.JOT_CAPACITY_COUNT??110000);
assert(['code','ordered','deep'].includes(kind));assert(Number.isSafeInteger(count)&&count>0);
const port=Number(process.env.JOT_CAPACITY_PORT??4334),debugPort=Number(process.env.JOT_CAPACITY_DEBUG_PORT??9534);
const profile=mkdtempSync(resolve(tmpdir(),'jot-capacity-audit-'));
let server,chrome,c;
try {
  server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${port}/`,15000);
  chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking','--disable-renderer-backgrounding','--enable-precise-memory-info',...(process.env.JOT_CAPACITY_GC==='1'?['--js-flags=--expose-gc']:[]),`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
  const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  c=await connectCdp(pages.find(page=>page.type==='page'&&page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  await c.command('Runtime.enable');
  await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
  const wait=(expr,timeout=120000)=>waitForEvaluation(c,expr,timeout);
  const frame=()=>c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await wait(`document.readyState==='complete'&&document.title==='Jot native component integration fixture'`,15000);
  await c.evaluate(String.raw`(()=>{window.capacity={stage:'start',errors:[],longTasks:[],commits:[],plans:[]};(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.style.cssText='width:900px;height:700px;margin:10px';document.body.replaceChildren(root);
    const kind=${JSON.stringify(kind)},count=${count},fence='\x60\x60\x60';
    const source=kind==='code'?'开头\n\n'+fence+' ts\n'+Array.from({length:count},(_,i)=>'L'+String(i+1).padStart(6,'0')).join('\n')+'\n'+fence+'\n\nTAIL_SENTINEL':
      kind==='ordered'?Array.from({length:count},(_,i)=>(i+1)+'. item_'+String(i+1).padStart(6,'0')).join('\n')+'\n\nTAIL_SENTINEL':
      '前文\n\n'+Array.from({length:count},(_,i)=>' '.repeat(i%1000)+'- deep_'+i).join('\n')+'\n\nTAIL_SENTINEL';
    window.source=source;window.worker=new Worker('/src/worker.ts',{type:'module'});
    const observer=new PerformanceObserver(list=>capacity.longTasks.push(...list.getEntries().map(x=>x.duration)));observer.observe({type:'longtask'});window.observer=observer;
    capacity.started=performance.now();window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:worker,documentId:'capacity-'+kind,generation:1,source,syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},livePreview:{onCommit:event=>{if(capacity.commits.length<1000)capacity.commits.push({at:performance.now(),duration:event.planDurationMs,blocks:event.visibleBlocks,truncated:event.truncated,viewport:window.view?{...view.viewport}:null,scroll:window.view?.scrollDOM.scrollTop})}},onError:e=>capacity.errors.push(String(e))});
    window.view=editor.input.view;
    if(${process.env.JOT_CAPACITY_TRACE==='1'}){
      const dispatch=view.dispatch;view.dispatch=(...args)=>{
        for(const arg of args){const effects=Array.isArray(arg?.effects)?arg.effects:[arg?.effects];for(const effect of effects){
          const set=effect?.value?.decorations;if(!set?.between)continue;
          let first=null,last=null,count=0;set.between(0,view.state.doc.length,(from,to,deco)=>{if(deco.spec?.class?.includes('jot-live-preview-list-item')){first??=from;last=from;count++}});
          capacity.plans.push({at:performance.now(),head:view.state.selection.main.head,viewport:{...view.viewport},first,last,count});
        }}
        return dispatch(...args);
      };
    }
    await editor.open();capacity.openMs=performance.now()-capacity.started;capacity.stage='open';
    while(editor.session.adapter.analysis?.state!=='complete')await new Promise(resolve=>setTimeout(resolve,20));
    capacity.analysisMs=performance.now()-capacity.started;capacity.stage='complete';
  })().catch(error=>{capacity.errors.push(String(error.stack??error));capacity.stage='failed'})})()`);
  await wait(`capacity.stage==='complete'||capacity.stage==='failed'`);
  assert.equal(await c.evaluate('capacity.stage'),'complete',JSON.stringify(await c.evaluate('capacity.errors')));
  await wait('editor.confirmedValue===source');
  const snapshots=[];
  if(kind==='code'||kind==='ordered'){
    const cycles=Number(process.env.JOT_CAPACITY_CYCLES??1);
    assert(Number.isSafeInteger(cycles)&&cycles>0);
    const points=Array.from({length:cycles},()=>[1,Math.max(1,Math.floor(count/2)),count]).flat();
    for(const index of points){
      const token=kind==='code'?'L'+String(index).padStart(6,'0'):'item_'+String(index).padStart(6,'0');
      const position=await c.evaluate(`source.indexOf(${JSON.stringify(token)})`);
      assert(position>=0,`fixture token ${token} exists`);
      await c.evaluate(`view.dispatch({selection:{anchor:${position}},scrollIntoView:true});view.focus()`);
      try {
        await wait(`(()=>{const n=view.domAtPos(${position}).node,e=n.nodeType===1?n:n.parentElement,row=e?.closest('.cm-line');return !!row&&row.textContent.includes(${JSON.stringify(token)})&&${kind==='code'?`row.dataset.jotLineNumber===${JSON.stringify(String(index))}`:`row.dataset.jotLiveListMarker===${JSON.stringify(`${index}.`)}`}})()`,Number(process.env.JOT_CAPACITY_WAIT_MS??60000));
      } catch(error) {
        console.error(JSON.stringify(await c.evaluate(`(()=>{const head=view.state.selection.main.head,index=editor.session.adapter.blocks.blockAt(head),blocks=editor.session.adapter.blocks.blocks,store=editor.session.adapter.projection;return{head,index,metadata:index===undefined?null:blocks[index],cached:index===undefined?null:store.nodeAt('0','syntax-children',index),total:store.totalChildren('0','syntax-children'),viewport:{...view.viewport},ranges:view.visibleRanges.map(r=>({...r})),scroll:view.scrollDOM.scrollTop,snapshot:editor.livePreview.snapshot,commits:capacity.commits,plans:capacity.plans,rows:[...view.contentDOM.querySelectorAll('.cm-line')].slice(0,5).map(n=>({pos:view.posAtDOM(n,0),text:n.textContent,classes:n.className}))}})()`)));
        throw error;
      }
      await frame();
      const snap=await c.evaluate(`(()=>{
        const pos=${position},node=view.domAtPos(pos).node,element=node.nodeType===1?node:node.parentElement,row=element?.closest('.cm-line'),r=row?.getBoundingClientRect(),s=row?getComputedStyle(row):null;
        return{position:pos,head:view.state.selection.main.head,viewport:{from:view.viewport.from,to:view.viewport.to},row:row?{text:row.textContent,line:row.dataset.jotLineNumber,marker:row.dataset.jotLiveListMarker,class:row.className,left:r.left,padding:parseFloat(s.paddingInlineStart)}:null,mounted:view.contentDOM.querySelectorAll('*').length,scroll:view.scrollDOM.scrollTop,heap:performance.memory?.usedJSHeapSize};
      })()`);
      assert.equal(snap.head,position,'jump preserves exact source selection');
      assert(snap.row?.text.includes(token),`the target ${token} is actually painted: ${JSON.stringify(snap)}`);
      assert(snap.mounted<6000,'the DOM stays bounded independently of source length');
      if(kind==='code')assert.equal(Number(snap.row.line),index,`code line number for ${token}: ${JSON.stringify(snap)}`);
      else assert.equal(snap.row.marker,`${index}.`,`ordered marker for ${token}: ${JSON.stringify(snap)}`);
      snapshots.push({index,...snap});
    }
  }else{
    const token='deep_'+(count-1),position=await c.evaluate(`source.indexOf(${JSON.stringify(token)})`);
    await c.evaluate(`view.dispatch({selection:{anchor:${position}},scrollIntoView:true});view.focus()`);
    await wait(`view.contentDOM.textContent.includes(${JSON.stringify(token)})`,60000);await frame();
    snapshots.push(await c.evaluate(`(()=>{const n=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes(${JSON.stringify(token)})),s=getComputedStyle(n);return{marker:n.dataset.jotLiveListMarker,padding:parseFloat(s.paddingInlineStart),width:n.getBoundingClientRect().width,mounted:view.contentDOM.querySelectorAll('*').length}})()`));
    assert(snapshots[0].mounted<6000,'deep nesting remains virtualized');
  }
  if(kind==='code'||kind==='ordered'){
    const repetitions=Number(process.env.JOT_CAPACITY_EDITS??1);
    assert(Number.isSafeInteger(repetitions)&&repetitions>0);
    const index=Math.max(1,Math.floor(count/2)),token=kind==='code'?'L'+String(index).padStart(6,'0'):'item_'+String(index).padStart(6,'0');
    const position=await c.evaluate(`source.indexOf(${JSON.stringify(token)})+${token.length}`);
    const modifiers=await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')?4:2;
    if(process.env.JOT_CAPACITY_LANGUAGE_DIAG==='1'){
      await c.evaluate(`(async()=>{const diagnostic=await import('/@fs${process.cwd()}/packages/editor/tests/browser-support/editor-language-diagnostic.ts');window.languageFragmentStats=diagnostic.languageFragmentStats;window.compareMarkdownTree=diagnostic.compareMarkdownTree;window.languageBefore=languageFragmentStats(view.state)})()`);
    }
    if(process.env.JOT_CAPACITY_GC==='1')await c.evaluate(`gc();window.heapBeforeEdits=performance.memory.usedJSHeapSize`);
    if(process.env.JOT_CAPACITY_HEAP_PROFILE==='1'){
      await c.command('HeapProfiler.enable');await c.command('HeapProfiler.startSampling',{samplingInterval:32768});
    }
    const editMs=[];
    for(let iteration=0;iteration<repetitions;iteration++){
      await c.evaluate(`view.dispatch({selection:{anchor:${position}},scrollIntoView:true});view.focus();window.editStarted=performance.now()`);
      await c.command('Input.insertText',{text:'X'});
      await wait(`editor.value===source.slice(0,${position})+'X'+source.slice(${position})&&editor.confirmedValue===editor.value&&editor.session.adapter.analysis?.state==='complete'`);
      editMs.push(await c.evaluate('performance.now()-editStarted'));
      for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers});
      await wait(`editor.value===source&&editor.confirmedValue===source&&editor.session.adapter.analysis?.state==='complete'`);
      if(repetitions>=10&&(iteration+1)%5===0)console.log(JSON.stringify({kind,completedEdits:iteration+1}));
    }
    if(process.env.JOT_CAPACITY_GC==='1')await c.evaluate(`gc();window.heapAfterEdits=performance.memory.usedJSHeapSize`);
    const observeMs=Number(process.env.JOT_CAPACITY_OBSERVE_MS??0);
    if(observeMs>0&&process.env.JOT_CAPACITY_GC==='1'){
      await c.evaluate(`new Promise(resolve=>setTimeout(resolve,${observeMs}))`);
      await c.evaluate(`gc();window.heapAfterIdle=performance.memory.usedJSHeapSize`);
    }
    let traceDiagnostic;
    if(process.env.JOT_CAPACITY_CLEAR_EVENTS==='1'&&process.env.JOT_CAPACITY_GC==='1'){
      traceDiagnostic=await c.evaluate(`(()=>{const traces=editor.events.snapshot;const inserted=traces.flatMap(t=>[...(t.analysisUpdates??[]).map(u=>u.syntax),t.documentPatch?.syntax].filter(Boolean).flatMap(s=>s.blockChanges.map(c=>c.inserted.length)));const stats={operations:traces.length,syntaxPatches:inserted.length,maxInserted:Math.max(0,...inserted),totalInserted:inserted.reduce((a,b)=>a+b,0)};editor.events.clear();return stats})()`);
      await c.evaluate('gc()');traceDiagnostic.heapAfterClear=await c.evaluate('performance.memory.usedJSHeapSize');
    }
    let heapProfile;
    if(process.env.JOT_CAPACITY_HEAP_PROFILE==='1'){
      const {profile}=await c.command('HeapProfiler.stopSampling'),hot=[];
      const visit=(node,stack)=>{const next=[...stack,node.callFrame.functionName||'(anonymous)'];if(node.selfSize)hot.push({bytes:node.selfSize,stack:next.slice(-8),url:node.callFrame.url,line:node.callFrame.lineNumber+1});for(const child of node.children??[])visit(child,next)};
      visit(profile.head,[]);heapProfile=hot.sort((a,b)=>b.bytes-a.bytes).slice(0,25);
    }
    const languageDiagnostic=process.env.JOT_CAPACITY_LANGUAGE_DIAG==='1'?await c.evaluate(`({before:languageBefore,after:languageFragmentStats(view.state)})`):undefined;
    if(languageDiagnostic?.after)assert(languageDiagnostic.after.fragments<=9,'the Markdown reuse-fragment cache stays bounded');
    snapshots.push({case:'edit-and-undo',position,repetitions,editMs,heapBefore:process.env.JOT_CAPACITY_GC==='1'?await c.evaluate('heapBeforeEdits'):undefined,heapAfter:process.env.JOT_CAPACITY_GC==='1'?await c.evaluate('heapAfterEdits'):undefined,heapAfterIdle:observeMs>0&&process.env.JOT_CAPACITY_GC==='1'?await c.evaluate('heapAfterIdle'):undefined,traceDiagnostic,heapProfile,languageDiagnostic});
    if(kind==='ordered'){
      // 等撤销后的目标行恢复已确认的列表装饰。这里测的是列表命令，未投影行会走原生回退。
      for(const shift of [false,true]){
        await c.evaluate(`view.dispatch({selection:{anchor:${position}},scrollIntoView:true});view.focus();editor.livePreview.settled()`);
        await wait(`(()=>{
          const node=view.domAtPos(${position}-1).node;
          const element=node.nodeType===1?node:node.parentElement;
          return view.state.selection.main.head===${position} &&
            element?.closest('.cm-line')?.dataset.jotLiveListMarker===${JSON.stringify(index+'.')};
        })()`,10000);
        const insertion=shift?'  \n'+' '.repeat(String(index).length+2):'\n'+(index+1)+'. ';
        for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:shift?8:0});
        await wait(`editor.value===source.slice(0,${position})+${JSON.stringify(insertion)}+source.slice(${position})&&editor.confirmedValue===editor.value`);
        for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers});
        await wait(`editor.value===source&&editor.confirmedValue===source`);
        snapshots.push({case:shift?'list-shift-enter-undo':'list-enter-undo',position});
      }
      if(process.env.JOT_CAPACITY_GC==='1'){
        await wait(`editor.session.adapter.analysis?.state==='complete'`);
        await c.evaluate('gc()');snapshots.push({case:'list-commands-post-gc',heap:await c.evaluate('performance.memory.usedJSHeapSize')});
      }
      if(process.env.JOT_CAPACITY_LANGUAGE_DIAG==='1'&&process.env.JOT_CAPACITY_COMPARE_LANGUAGE==='1'){
        const comparison=await c.evaluate(`compareMarkdownTree(view.state,[1,${position},source.length-1])`);
        assert(comparison.complete,'the trimmed incremental grammar can finish parsing the document');
        for(const item of comparison.positions)assert.deepEqual(item.incremental,item.full,`incremental and fresh Markdown parse agree at ${item.position}`);
        snapshots.push({case:'incremental-grammar-matches-fresh',positions:comparison.positions.map(p=>p.position)});
      }
    }
  }
  assert.equal(await c.evaluate('editor.value===source&&editor.confirmedValue===source'),true,'navigation preserves all source text');
  assert.deepEqual(await c.evaluate('capacity.errors'),[]);
  const summary=await c.evaluate(`({bytes:new TextEncoder().encode(source).length,utf16:source.length,lines:view.state.doc.lines,openMs:capacity.openMs,analysisMs:capacity.analysisMs,rootBlocks:editor.session.adapter.blocks.blocks.length,longTasks:capacity.longTasks.length,maxLongTaskMs:Math.max(0,...capacity.longTasks),maxPlanMs:Math.max(0,...capacity.commits.map(c=>c.duration??0)),commits:capacity.commits.length,heap:performance.memory?.usedJSHeapSize})`);
  console.log(JSON.stringify({status:'pass',kind,count,summary,snapshots}));
} finally {
  try{if(c){await c.evaluate('observer?.disconnect();editor?.dispose();worker?.terminate()');c.socket.close()}}catch{}
  await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
