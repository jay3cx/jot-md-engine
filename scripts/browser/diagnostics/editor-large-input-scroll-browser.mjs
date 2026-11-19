import { largeInputFixture } from '../support/large-input-fixture.mjs';
// E2E regression: a single browser input/drop or session.source initialization
// followed immediately by wheel gestures, using the exported editor + worker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const bytesTarget = Number(process.env.JOT_LARGE_INPUT_BYTES ?? 1048576);
const port = Number(process.env.JOT_LARGE_INPUT_PORT ?? 4198);
const debugPort = Number(process.env.JOT_LARGE_INPUT_DEBUG_PORT ?? 9347);
const inputMethod = process.env.JOT_LARGE_INPUT_METHOD ?? 'insertText';
const passive = process.env.JOT_LARGE_NO_SETTLED === '1';
assert(Number.isSafeInteger(bytesTarget) && bytesTarget >= 16384, 'fixture target must be at least 16 KiB');
assert(['insertText', 'drop', 'open', 'syntheticPaste'].includes(inputMethod), 'input method must be insertText, drop, open, or syntheticPaste');
const output = resolve(process.env.JOT_LARGE_INPUT_REPORT ?? 'dist/large-input-scroll-report');
const fixture = resolve(`.tmp/large-input-scroll-${port}`);
mkdirSync(output, { recursive: true });
mkdirSync(fixture, { recursive: true });
const fsUrl = path => '/@fs' + path;
const workerEntry = fsUrl(resolve('packages/editor/src/worker/index.ts'));
const wasm = fsUrl(resolve('apps/demo/src/generated/editor_wasm.js'));
writeFileSync(resolve(fixture, 'worker.mjs'), `import {bootstrapEditorWorker} from ${JSON.stringify(workerEntry)};\nawait bootstrapEditorWorker({endpoint:self,loadWasm:()=>import(${JSON.stringify(wasm)}),onError:e=>self.postMessage({type:'consumer-fatal',message:String(e)}),onFatalError:e=>self.postMessage({type:'consumer-fatal',message:String(e)})});\n`);
writeFileSync(resolve(fixture, 'vite.config.mjs'), `export default {root:${JSON.stringify(process.cwd())},cacheDir:${JSON.stringify(resolve(fixture, 'vite-cache'))},optimizeDeps:{noDiscovery:true},worker:{format:'es'},server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[${JSON.stringify(process.cwd())}]}}};\n`);

const inlineTask = process.env.JOT_LARGE_INLINE_TASK === '1';
const fenceCompat = process.env.JOT_LARGE_FENCE_COMPAT === '1';
const { source, sections } = largeInputFixture(bytesTarget, { inlineTask, fenceCompat });
const expectedBytes = Buffer.byteLength(source, 'utf8');
const expectedHash = createHash('sha256').update(source).digest('hex');
const profile = mkdtempSync(resolve(tmpdir(), 'jot-large-input-'));
const report = { inputMethod, passive, inlineTask, fenceCompat, bytes: expectedBytes, utf16: source.length, sections, expectedHash, operations: [], snapshots: [], passiveWaits: [], errors: [] };
const diagnose = process.env.JOT_LARGE_INPUT_DIAG === '1';
const traceFrames = process.env.JOT_LARGE_TRACE_FRAMES === '1';
if (diagnose) report.diagnostics = [];
let server, chrome, client;
const origin = `http://127.0.0.1:${port}`, debugOrigin = `http://127.0.0.1:${debugPort}`;
const started = performance.now();
async function input(method, params) {
  const record = { method, ...(method === 'Input.insertText' || method === 'Input.dispatchDragEvent'
    ? { textBytes: expectedBytes, sha256: expectedHash, ...(params.type === undefined ? {} : { type: params.type }) }
    : { params }), startedMs: Math.round(performance.now() - started) };
  report.operations.push(record);
  const diagnosticTimer = diagnose && method === 'Input.insertText' ? setTimeout(() => {
    report.diagnostics.push({ type: 'request', atMs: Math.round(performance.now() - started) });
    for (const name of ['Performance.getMetrics', 'Debugger.pause']) {
      void client.command(name).then(result => {
        report.diagnostics.push({ type: name, atMs: Math.round(performance.now() - started), result });
        writeFileSync(resolve(output, 'partial.json'), JSON.stringify(report, null, 2) + '\n');
      }).catch(error => {
        report.diagnostics.push({ type: name, error: String(error) });
      });
    }
  }, 8000) : undefined;
  if (diagnosticTimer !== undefined) diagnosticTimer.unref();
  await client.command(method, params);
  if (diagnosticTimer !== undefined) clearTimeout(diagnosticTimer);
  record.finishedMs = Math.round(performance.now() - started);
}
async function wheel(deltaY) {
  await input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 440, y: 300, deltaX: 0, deltaY });
}
async function settle() {
  if (!passive) {
    await client.evaluate('editor.livePreview.settled()');
    await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    return;
  }
  // Observe ordinary browser frames and the real DOM only: do not invoke the
  // component's settled helper or request a projection. Every viewport still
  // receives the same strict source/ID/component assertions in snapshot().
  const started = performance.now();
  await waitForEvaluation(client, `(async()=>{
    const signature=()=>JSON.stringify([view.viewport.from,view.viewport.to,view.scrollDOM.scrollTop,view.scrollDOM.scrollHeight,...view.visibleRanges.flatMap(r=>[r.from,r.to])]);
    const before=signature();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(before!==signature())return false;
    if(editor.session.adapter.analysis?.state!=='complete'||editor.confirmedValue!==expected||view.state.doc.length!==expected.length)return false;
    const pane=view.scrollDOM.getBoundingClientRect(),visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>pane.top&&r.top<pane.bottom&&r.right>pane.left&&r.left<pane.right};
    const lines=[...view.contentDOM.querySelectorAll('.cm-line')].filter(visible);
    const nodes=[...view.contentDOM.querySelectorAll('[data-jot-kind],.jot-table')].filter(visible);
    const content=lines.map(n=>n.textContent??'').join(' ')+' '+nodes.map(n=>(n.textContent??'')+' '+(n.getAttribute('alt')??'')).join(' ');
    const marker=String.fromCharCode(96).repeat(3);
    const raw=lines.some(n=>{const s=(n.textContent??'').trim();return !n.classList.contains('jot-live-preview-active-line')&&(/^(?:# SECTION_|!\\[IMG_|\\| (?:Column|TABLE_)|\\$\\$)/.test(s)||s===marker+' rust begin'||s===marker+' end'||(${fenceCompat}&&(s===marker+'rust'||s===marker)))});
    return /SECTION_|BOLD_|IMG_|TABLE_|LIST_|QUOTE_|CODE_|FINAL_SENTINEL/.test(content)&&!raw;
  })()`, 15000);
  report.passiveWaits.push({ durationMs: Math.round(performance.now() - started) });
}
async function snapshot(label) {
  const state = await client.evaluate(`(()=>{
    const pane=view.scrollDOM.getBoundingClientRect();
    const visible=node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>pane.top&&r.top<pane.bottom&&r.right>pane.left&&r.left<pane.right;};
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    const labels=text=>[...new Set((text??'').match(/(?:SECTION|BOLD|IMG|TABLE|LIST|QUOTE|CODE)_\\d{5}|FINAL_SENTINEL/g)??[])];
    const position=n=>{try{return view.posAtDOM(n,0);}catch{return null;}};
    const anchor=n=>{const e=n.closest('[data-jot-source-from][data-jot-source-to]');return e?{from:Number(e.dataset.jotSourceFrom),to:Number(e.dataset.jotSourceTo)}:null;};
    const lines=[...view.contentDOM.querySelectorAll('.cm-line')].filter(visible).map(n=>{
      const pos=position(n),line=pos===null?null:view.state.doc.lineAt(pos);
      return {text:n.textContent,classes:n.className,rect:rect(n),pos,sourceRange:line?{from:line.from,to:line.to}:null,source:line?.text,labels:labels(n.textContent)};
    });
    const nodes=[...view.contentDOM.querySelectorAll('[data-jot-kind]')].filter(visible).map(n=>{
      const range=anchor(n),text=n.textContent?.slice(0,100),alt=n.getAttribute('alt');
      return {kind:n.dataset.jotKind,from:range?.from,to:range?.to,source:range?view.state.sliceDoc(range.from,range.to):null,labels:labels((text??'')+' '+(alt??'')),text,alt,src:n.getAttribute('src')?.slice(0,30),complete:n instanceof HTMLImageElement?n.complete:undefined,naturalWidth:n instanceof HTMLImageElement?n.naturalWidth:undefined,rect:rect(n)};
    });
    const tables=[...view.contentDOM.querySelectorAll('.jot-table')].filter(visible).map(n=>{
      const range=anchor(n),text=n.textContent?.slice(0,100);
      return {text,rect:rect(n),sourceRange:range,source:range?view.state.sliceDoc(range.from,range.to):null,labels:labels(text)};
    });
    const strong=[...view.contentDOM.querySelectorAll('.jot-live-preview-strong,strong')].filter(visible).map(n=>n.textContent);
    const tasks=[...view.contentDOM.querySelectorAll('.jot-live-preview-task-checkbox')].filter(visible).map(n=>{const pos=position(n);return{source:pos===null?null:view.state.sliceDoc(pos,pos+3),line:n.closest('.cm-line')?.textContent}});
    const strikes=[...view.contentDOM.querySelectorAll('.jot-live-preview-strikethrough')].filter(visible).map(n=>n.textContent);
    const sourceWindow=largeProjectionWindow.visibleSourceWindow(view);
    const top=(pane.top+view.scrollDOM.clientTop*view.scaleY-view.documentTop)/view.scaleY;
    const screenBlocks=view.viewportLineBlocks.filter(block=>block.bottom>top&&block.top<top+view.scrollDOM.clientHeight);
    const screenRange=screenBlocks.length?{from:screenBlocks[0].from,to:screenBlocks.at(-1).to}:{from:view.viewport.from,to:view.viewport.to};
    const projectionRoots=largeProjectionWindow.visibleRootNodes(editor.session,sourceWindow).map(n=>({id:n.id,kind:n.kind,from:Number(n.sourceRange.from),to:Number(n.sourceRange.to),content:n.content.type,children:n.childCount,loadedChildren:n.content.type==='structured'?n.content.children.length:0}));
    const remainingDetailSlices=largeProjectionWindow.visibleDetailSlices(editor.session,sourceWindow,48,view.state.selection.main.head);
    const remainingRootSlices=largeProjectionWindow.missingVisibleRootSlices(editor.session,sourceWindow,32);
    const actualSource=view.state.doc.toString();
    const sourceMatches=actualSource===expected&&editor.confirmedValue===expected;
    return {sourceMatches,revision:Number(editor.revision),analysis:editor.session.adapter.analysis?.state,scrollTop:view.scrollDOM.scrollTop,scrollHeight:view.scrollDOM.scrollHeight,clientHeight:view.scrollDOM.clientHeight,pane:{top:pane.top,bottom:pane.bottom},viewport:{from:view.viewport.from,to:view.viewport.to},visibleRanges:view.visibleRanges.map(r=>({from:r.from,to:r.to})),sourceWindow,screenRange,projectionRoots,remainingDetailSlices,remainingRootSlices,lines,nodes,tables,strong,tasks,strikes,plan:{...editor.livePreview.snapshot},errors:[...largeErrors],inputEvents:[...largeInputEvents]};
  })()`);
  report.snapshots.push({ label, ...state });
  assert(state.sourceMatches, `${label}: confirmed and live documents exactly equal the single inserted text`);
  assert.equal(state.analysis, 'complete', `${label}: Rust syntax analysis completed`);
  assert.deepEqual(state.errors, [], `${label}: editor and worker report no errors`);
  assert(state.plan.visibleBlocks > 0 && !state.plan.truncated, `${label}: confirmed viewport has a nonempty untruncated plan`);
  const visibleText = state.lines.map(line => line.text).join(' ') + ' ' + state.nodes.map(node => node.text ?? node.alt ?? '').join(' ') + ' ' + state.tables.map(table => table.text).join(' ');
  assert(/SECTION_|BOLD_|IMG_|TABLE_|LIST_|QUOTE_|CODE_|FINAL_SENTINEL/u.test(visibleText), `${label}: actual visible DOM must contain this fixture's real content, not an empty geometry placeholder`);
  // Check the *specific* displayed IDs against their actual source ranges.
  // A stale widget or line containing some other section's plausible text
  // must not pass simply because it has the same fixture prefix.
  const identified = [
    ...state.lines.filter(line => line.labels.length).map(line => ({ ...line, range: line.sourceRange, kind: 'native line' })),
    ...state.nodes.filter(node => node.labels.length).map(node => ({ ...node, range: { from: node.from, to: node.to }, kind: `widget ${node.kind}` })),
    ...state.tables.filter(table => table.labels.length).map(table => ({ ...table, range: table.sourceRange, kind: 'table' })),
  ];
  assert(identified.length > 0, `${label}: visible fixture IDs must have source-position evidence`);
  for (const item of identified) {
    assert(item.range && Number.isInteger(item.range.from) && Number.isInteger(item.range.to) &&
      item.range.from >= 0 && item.range.from <= item.range.to && item.range.to <= source.length,
    `${label}: ${item.kind} ${item.labels.join(', ')} has a valid source range`);
    assert(item.range.from <= state.viewport.to && item.range.to >= state.viewport.from,
      `${label}: ${item.kind} ${item.labels.join(', ')} belongs to the current viewport`);
    for (const id of item.labels) assert(item.source?.includes(id),
      `${label}: ${item.kind} shows ${id} but its mapped source does not contain that ID`);
  }
  const rawLines = state.lines.filter(line => !line.classes.includes('jot-live-preview-active-line') && /^(?:# SECTION_|!\[IMG_|\| (?:Column|TABLE_)|```(?: rust begin| end)$|\$\$$)/u.test(line.text.trim()));
  if (fenceCompat) rawLines.push(...state.lines.filter(line => !line.classes.includes('jot-live-preview-active-line') && ['```rust', '```'].includes(line.text.trim())));
  assert.deepEqual(rawLines, [], `${label}: visible confirmed Markdown block syntax must not remain unrendered after scrolling`);
  return state;
}
try {
  server = spawn(resolve('node_modules/.bin/vite'), ['--config', resolve(fixture, 'vite.config.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => {
    viteLog += String(chunk);
    writeFileSync(resolve(output, 'vite.log'), viteLog);
  });
  const fixtureUrl = origin + fsUrl(resolve('scripts/browser/support/editor-browser-fixture.html'));
  await waitForHttp(fixtureUrl, 15000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, fixtureUrl], { stdio: 'ignore' });
  await waitForHttp(debugOrigin + '/json/version', 15000);
  const pages = await fetch(debugOrigin + '/json/list').then(response => response.json());
  client = await connectCdp(pages.find(page => page.type === 'page' && page.url.startsWith(origin + '/')).webSocketDebuggerUrl);
  client.socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params);
    if (message.method === 'Runtime.consoleAPICalled' && ['warning','error'].includes(message.params.type)) {
      (report.consoleWarnings ??= []).push({type:message.params.type,args:message.params.args.map(arg=>arg.value??arg.description)});
    }
    if (diagnose && message.method === 'Debugger.paused') {
      report.diagnostics.push({ type: 'paused', atMs: Math.round(performance.now() - started), reason: message.params.reason,
        callFrames: message.params.callFrames.slice(0, 30).map(frame => ({ functionName: frame.functionName, url: frame.url, location: frame.location })) });
      writeFileSync(resolve(output, 'partial.json'), JSON.stringify(report, null, 2) + '\n');
      void client.command('Debugger.resume').catch(error => { report.diagnostics.push({ type: 'resume', error: String(error) }); });
    }
  });
  await client.command('Runtime.enable');
  await client.command('Page.enable');
  if (diagnose) {
    await client.command('Debugger.enable');
    await client.command('Performance.enable');
  }
  await client.command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await waitForEvaluation(client, `document.readyState==='complete' && document.title==='Jot native component integration fixture'`, 15000);
  await client.evaluate(`window.expected=${JSON.stringify(source)};true`);
  await client.evaluate(`(async()=>{
    window.largeErrors=[];window.largeInputEvents=[];window.largeWheelEvents=[];window.largeDropEvents=[];window.largePasteEvents=[];window.largeProjectionRequests=[];window.largeFrameTrace=[];window.largeScrollWrites=[];window.largeRafTrace=[];window.largeAnchorTrace=[];
    addEventListener('error',event=>largeErrors.push(String(event.error?.stack??event.message)));
    addEventListener('unhandledrejection',event=>largeErrors.push(String(event.reason?.stack??event.reason)));
    const {MarkdownEditor,createKaTeXRenderer}=await import(${JSON.stringify(fsUrl(resolve('packages/editor/src/index.ts')))});
    window.largeProjectionWindow=await import(${JSON.stringify(fsUrl(resolve('packages/editor/src/hosts/live-preview/projection-window.ts')))});
    await import(${JSON.stringify(fsUrl(resolve('packages/editor/node_modules/katex/dist/katex.min.css')))});
    const root=document.createElement('div');root.id='integration';root.style.cssText='width:900px;height:700px;margin:10px';document.body.replaceChildren(root);
    window.worker=new Worker(${JSON.stringify(fsUrl(resolve(fixture, 'worker.mjs')))},{type:'module'});
    worker.addEventListener('error',event=>largeErrors.push('worker:'+event.message));
    worker.addEventListener('message',event=>{if(event.data?.type==='consumer-fatal')largeErrors.push(event.data.message);});
    const captureFrame=reason=>{if(!${traceFrames}||!window.view)return;largeFrameTrace.push({reason,at:performance.now(),scrollTop:view.scrollDOM.scrollTop,scrollHeight:view.scrollDOM.scrollHeight,documentTop:view.documentTop,viewport:{from:view.viewport.from,to:view.viewport.to},scrollTarget:view.viewState?.scrollTarget?.range?.head??null,plan:editor.livePreview.snapshot.projectionRequests,defaultLineHeight:view.defaultLineHeight,oracleLineHeight:view.viewState?.heightOracle?.lineHeight,oracleLineLength:view.viewState?.heightOracle?.lineLength,heightMap:view.viewState?.heightMap?.height});};
    window.editor=new MarkdownEditor({root,mode:'live-preview',surface:{renderMath:createKaTeXRenderer()},livePreview:{onCommit:()=>captureFrame('commit')},session:{endpoint:worker,documentId:'one-shot-large-scroll',generation:1,source:${inputMethod === 'open' ? 'expected' : "''"},syntaxProfile:{id:'default',version:1,enabledExtensions:${JSON.stringify(fenceCompat ? [{id:'commonmark-fence-language',version:'1.0.0'}] : [])}},onProtocolEvent:event=>{
      const slices=event.direction==='request'?event.message.body.projection?.slices:undefined;if(!slices)return;
      const sourceWindow=window.view?largeProjectionWindow.visibleSourceWindow(view):null;
      largeProjectionRequests.push({at:performance.now(),sourceWindow,slices:slices.map(s=>({parentId:s.parentId,window:s.window,maxDepth:s.maxDepth}))});
    }},onError:error=>largeErrors.push(String(error.stack??error))});
    window.largeOpenTiming={started:performance.now()};await editor.open();largeOpenTiming.finished=performance.now();window.view=editor.input.view;
    if(${traceFrames}){
      const property=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
      if(property?.get&&property.set)Object.defineProperty(view.scrollDOM,'scrollTop',{configurable:true,get(){return property.get.call(this)},set(value){if(largeScrollWrites.length<500)largeScrollWrites.push({at:performance.now(),from:property.get.call(this),to:value,scrollTarget:view.viewState?.scrollTarget?.range?.head??null,stack:new Error().stack});property.set.call(this,value)}});
      const byHeight=view.lineBlockAtHeight.bind(view),byPosition=view.lineBlockAt.bind(view);
      view.lineBlockAtHeight=height=>{const stack=new Error().stack,result=byHeight(height);if(stack.includes('captureLivePreviewViewport'))largeAnchorTrace.push({at:performance.now(),method:'capture',height,from:result.from,to:result.to,top:result.top,scrollTop:view.scrollDOM.scrollTop,viewport:{from:view.viewport.from,to:view.viewport.to}});return result};
      view.lineBlockAt=position=>{const stack=new Error().stack,result=byPosition(position);if(stack.includes('restoreLivePreviewViewport'))largeAnchorTrace.push({at:performance.now(),method:'restore',position,from:result.from,to:result.to,top:result.top,scrollTop:view.scrollDOM.scrollTop,viewport:{from:view.viewport.from,to:view.viewport.to}});return result};
      const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>{const stack=new Error().stack;if(!stack.includes('viewport.ts'))return raf(callback);const entry={queuedAt:performance.now(),queuedTop:view.scrollDOM.scrollTop,queuedPlan:editor.livePreview.snapshot.projectionRequests,stack};largeRafTrace.push(entry);return raf(time=>{entry.runAt=performance.now();entry.runTop=view.scrollDOM.scrollTop;entry.runPlan=editor.livePreview.snapshot.projectionRequests;callback(time)})};
      const frame=()=>{captureFrame('frame');requestAnimationFrame(frame)};requestAnimationFrame(frame);view.scrollDOM.addEventListener('scroll',()=>captureFrame('scroll'),{passive:true});
    }
    root.addEventListener('beforeinput',event=>largeInputEvents.push({type:event.inputType,length:event.data?.length??0,isTrusted:event.isTrusted}),true);
    root.addEventListener('drop',event=>largeDropEvents.push({length:event.dataTransfer?.getData('text/plain').length??0,isTrusted:event.isTrusted,types:[...(event.dataTransfer?.types??[])]}),true);
    root.addEventListener('paste',event=>largePasteEvents.push({length:event.clipboardData?.getData('text/plain').length??0,isTrusted:event.isTrusted}),true);
    root.addEventListener('wheel',event=>largeWheelEvents.push({deltaY:event.deltaY,analysis:editor.session.adapter.analysis?.state,revision:Number(editor.revision),docLength:view.state.doc.length,confirmedLength:editor.confirmedValue.length,at:performance.now()}),true);
  })()`);
  report.openTiming = await client.evaluate('largeOpenTiming');
  if (inputMethod !== 'open') {
    await input('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 20, y: 21 });
    await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 20, y: 21 });
    assert(await client.evaluate('view.hasFocus'), 'real pointer activated the native editor input');
  }
  if (inputMethod === 'insertText') {
    await input('Input.insertText', { text: source });
  } else if (inputMethod === 'drop') {
    // CDP dispatches a browser drag/drop sequence with text/plain. This does
    // not read, replace, or write the user's system clipboard.
    const data = { items: [{ mimeType: 'text/plain', data: source }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await input('Input.dispatchDragEvent', { type, x: 20, y: 21, data });
    }
  } else if (inputMethod === 'syntheticPaste') {
    // A page-created event does not touch the system clipboard and avoids
    // sending megabytes through Chrome's CDP Input command. It exercises the
    // browser/CodeMirror paste path but is explicitly not a trusted OS paste.
    const record={method:'syntheticPaste',startedMs:Math.round(performance.now()-started)};
    report.operations.push(record);
    await client.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain',expected);view.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`);
    record.finishedMs=Math.round(performance.now()-started);
  }
  // These are genuine wheel events immediately after the single input; there
  // is intentionally no wait for the Worker / syntax confirmation here.
  for (const delta of [400000, -400000, 400000, -400000, 400000, -400000]) await wheel(delta);
  await waitForEvaluation(client, `editor.session.adapter.analysis?.state==='complete' && editor.confirmedValue===expected && view.state.doc.length===expected.length`, 180000);
  await settle();
  report.firstSettledMs = Math.round(performance.now() - started);
  report.wheelEvents = await client.evaluate('largeWheelEvents');
  report.projectionRequests = await client.evaluate('largeProjectionRequests');
  assert(report.wheelEvents.length >= 6, 'real wheel events reached the editor immediately after insertion');
  if (inputMethod === 'insertText') {
    assert((await client.evaluate('largeInputEvents')).some(event => event.isTrusted && event.length === source.length), 'one trusted browser beforeinput delivered the whole fixture');
  } else if (inputMethod === 'drop') {
    report.dropEvents = await client.evaluate('largeDropEvents');
    assert(report.dropEvents.some(event => event.isTrusted && event.length === source.length), 'one trusted browser drop delivered the whole fixture');
  } else if (inputMethod === 'syntheticPaste') {
    report.pasteEvents = await client.evaluate('largePasteEvents');
    assert(report.pasteEvents.some(event => !event.isTrusted && event.length === source.length), 'one synthetic paste delivered the whole fixture');
  } else {
    assert.deepEqual(await client.evaluate('largeInputEvents'), [], 'session.source open does not simulate browser text input');
    assert.deepEqual(await client.evaluate('largeDropEvents'), [], 'session.source open does not simulate browser drop');
  }
  await snapshot('after-immediate-burst');

  // Scroll in both directions without a text edit. Every sampled viewport must
  // contain mounted, correctly rendered fixture content. The samples together
  // must include actual images, tables, strong text, code and list components.
  await wheel(-4000000);
  await settle();
  await snapshot('top');
  for (let index = 0; index < 18; index++) {
    await wheel(650);
    await wheel(650);
    await settle();
    await snapshot(`down-${index}`);
  }
  for (let index = 0; index < 4; index++) {
    await wheel(-1300);
    await settle();
    await snapshot(`up-${index}`);
  }
  // Exercise the last viewport as well as the nearby samples above. The
  // unique tail marker proves that the wheel reached the actual document end
  // and that the visible DOM corresponds to that end without another edit.
  let reachedEnd = false;
  for (let attempt = 0; attempt < 4 && !reachedEnd; attempt++) {
    // The first gesture can hit the currently estimated end before image and
    // table heights arrive. A bounded series of real gestures reaches the
    // actual end without setting scrollTop or editing the document.
    await wheel(4000000);
    await settle();
    const bottom = await snapshot(`bottom-${attempt}`);
    reachedEnd = bottom.lines.some(line => line.labels.includes('FINAL_SENTINEL')) ||
      bottom.nodes.some(node => node.labels.includes('FINAL_SENTINEL'));
  }
  assert(reachedEnd, 'final document sentinel is visible after bounded real wheels to the end');
  const has = predicate => report.snapshots.some(predicate);
  assert(has(s => s.nodes.some(n => n.kind === 'image' && n.src?.startsWith('data:image/') && n.complete && n.naturalWidth > 0)), 'real decoded data images appear in the visible scrolled viewport');
  assert(has(s => s.tables.some(n => n.text.includes('TABLE_'))), 'actual rendered table cells appear in the visible viewport');
  assert(has(s => s.strong.some(text => text?.includes('BOLD_'))), 'actual strong inline styling appears in the visible viewport');
  assert(has(s => s.lines.some(line => line.text.includes('CODE_') && line.classes.includes('fenced-code'))), 'actual fenced code lines appear in the visible viewport');
  assert(has(s => s.lines.some(line => line.text.includes('LIST_') && line.classes.includes('list'))), 'actual rendered list lines appear in the visible viewport');
  assert(has(s => s.nodes.some(n => n.kind === 'math-block') || s.nodes.some(n => n.kind === 'inline-math')), 'actual math components appear in the visible viewport');
  if (inlineTask) {
    assert(has(s => s.tasks.some(task => task.source === '[ ]' && task.line?.includes('TASK_'))), 'rendered tasks retain their exact marker mapping');
    assert(has(s => s.strikes.some(value => value?.includes('STRIKE_'))), 'strikethrough is actually rendered in the large document');
    assert(has(s => s.lines.some(line => line.text.includes('https://example.invalid/a_~~b~~'))), 'autolink address delimiters stay literal in the large document');
  }
  assert(report.snapshots.some(s => s.scrollTop > 1000), 'real user wheel input moves away from the top');
  assert.deepEqual(report.errors, [], 'browser has no uncaught runtime exceptions');
  if (traceFrames) report.measurementSummary = await client.evaluate(`(()=>({lineHeights:[...new Set(largeFrameTrace.map(f=>f.oracleLineHeight))],lineLengths:[...new Set(largeFrameTrace.map(f=>Math.round(f.oracleLineLength*100)/100))],frames:largeFrameTrace.length}))()`);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack ?? error);
  if (client !== undefined) {
    try { report.diagnostic = await client.evaluate(`(()=>{const pane=window.view?.scrollDOM.getBoundingClientRect(),visible=n=>{const r=n.getBoundingClientRect();return !!pane&&r.height>0&&r.bottom>pane.top&&r.top<pane.bottom};const sourceWindow=window.view?largeProjectionWindow.visibleSourceWindow(view):null;return {errors:window.largeErrors??[],events:window.largeWheelEvents??[],input:window.largeInputEvents??[],analysis:window.editor?.session.adapter.analysis,revision:Number(window.editor?.revision),snapshot:window.editor?.livePreview.snapshot,viewport:window.view?{from:view.viewport.from,to:view.viewport.to,scrollTop:view.scrollDOM.scrollTop,scrollHeight:view.scrollDOM.scrollHeight,documentTop:view.documentTop,visibleRanges:view.visibleRanges.map(r=>({from:r.from,to:r.to}))}:null,sourceWindow,screenWindow:window.view?largeProjectionWindow.screenSourceWindow(view):null,roots:sourceWindow?largeProjectionWindow.visibleRootNodes(editor.session,sourceWindow).map(n=>({id:n.id,kind:n.kind,from:Number(n.sourceRange.from),to:Number(n.sourceRange.to),content:n.content.type})):[],missingRoots:sourceWindow?largeProjectionWindow.missingVisibleRootSlices(editor.session,sourceWindow,32):[],detail:sourceWindow?largeProjectionWindow.visibleDetailSlices(editor.session,sourceWindow,48,view.state.selection.main.head):[],visible:window.view?[...view.contentDOM.querySelectorAll('.cm-line,.jot-live-preview-widget--block,.jot-table')].filter(visible).slice(0,30).map(n=>{let pos=null,actual=null;try{pos=view.posAtDOM(n,0);actual=view.state.doc.lineAt(pos).text.slice(0,100)}catch{}return{text:n.textContent.slice(0,100),class:n.className,source:n.dataset.jotSourceFrom,pos,actual}}):[],requests:window.largeProjectionRequests?.slice(-12)};})()`); } catch (captureError) { report.captureError = String(captureError); }
    if (traceFrames) {
      try { const trace = await client.evaluate(`(async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>requestAnimationFrame(resolve));return {frames:largeFrameTrace,writes:largeScrollWrites,raf:largeRafTrace,anchors:largeAnchorTrace}})()`);report.frameTrace=trace.frames;report.scrollWrites=trace.writes;report.rafTrace=trace.raf;report.anchorTrace=trace.anchors; } catch (captureError) { report.frameCaptureError = String(captureError); }
    }
    try { const image = await client.command('Page.captureScreenshot'); writeFileSync(resolve(output, 'failure.png'), Buffer.from(image.data, 'base64')); } catch { /* preserve original failure */ }
  }
  process.exitCode = 1;
} finally {
  report.elapsedMs = Math.round(performance.now() - started);
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
if (report.passed) console.log(JSON.stringify({ passed: true, bytes: expectedBytes, sections, snapshots: report.snapshots.length, firstSettledMs: report.firstSettledMs, elapsedMs: report.elapsedMs, output }));
else console.error(report.failure);
