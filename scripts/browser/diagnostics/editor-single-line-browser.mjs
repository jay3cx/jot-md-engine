// Browser E2E for pasting and editing one very long physical line.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port = Number(process.env.JOT_SINGLE_LINE_PORT ?? 4270);
const debugPort = Number(process.env.JOT_SINGLE_LINE_DEBUG_PORT ?? 9470);
const units = Number(process.env.JOT_SINGLE_LINE_UNITS ?? 65_536);
const timeout = Number(process.env.JOT_SINGLE_LINE_TIMEOUT ?? 30_000);
const method = process.env.JOT_SINGLE_LINE_METHOD ?? 'insertText';
if (!Number.isSafeInteger(units) || units < 4 || units % 4 !== 0) throw new Error('JOT_SINGLE_LINE_UNITS must be a positive multiple of four');
if (!['insertText', 'open', 'paste-event'].includes(method)) throw new Error('JOT_SINGLE_LINE_METHOD must be insertText, open or paste-event');
const source = '中a😀'.repeat(units / 4);
const output = resolve(process.env.JOT_SINGLE_LINE_REPORT ?? 'dist/single-line-browser-report');
const profile = mkdtempSync(resolve(tmpdir(), 'jot-single-line-'));
mkdirSync(output, { recursive: true });
rmSync(resolve(output, 'vite.log'), { force: true });
const config = resolve(profile, 'vite.config.mjs');
writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(resolve('apps/demo/vite.config.mjs')).href)}; export default {...base,cacheDir:${JSON.stringify(resolve(profile, 'vite-cache'))}}`);
let server, chrome, client;
let viteLog = '';
const evidence = [], errors = [];
try {
  server = spawn(resolve('node_modules/.bin/vite'), ['--config', config, '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { viteLog += chunk.toString(); });
  await waitForHttp(`http://127.0.0.1:${port}/`, 15_000);
  chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ['--headless=new', '--no-first-run', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`], { stdio: 'ignore' });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  client = await connectCdp(pages.find((page) => page.type === 'page' && page.url.includes(`:${port}`)).webSocketDebuggerUrl);
  client.socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)); if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); });
  await client.command('Runtime.enable');
  await client.command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await waitForEvaluation(client, `location.origin==='http://127.0.0.1:${port}' && document.readyState==='complete' && document.title==='Jot native component integration fixture'`, 15_000);
  await client.evaluate(`(async()=>{
    const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
    const root=document.createElement('div');root.style.cssText='height:700px;width:900px';document.body.replaceChildren(root);
    window.worker=new Worker('/src/worker.ts',{type:'module'});window.editorErrors=[];
    const originalPost=worker.postMessage.bind(worker);worker.postMessage=(request,...rest)=>{const t=request?.body?.transaction;if(t)window.lastTransaction={analysis:t.analysis,edits:t.edits.map(e=>({range:e.range,insertLength:e.insert.length})),selectionAfter:t.selectionAfter};return originalPost(request,...rest)};
    window.expectedSource='中a😀'.repeat(${units / 4});window.started=performance.now();
    document.addEventListener('beforeinput',event=>{if(event.isTrusted&&event.data?.length>1)window.firstInputEvent={ms:performance.now()-started,units:event.data.length,type:event.inputType}},true);
    window.editor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:worker,documentId:'single-line',generation:1,source:${method === 'open' ? 'expectedSource' : "''"},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>editorErrors.push(String(e))});
    await editor.open();editor.focus();${method === 'open' ? '' : 'window.started=performance.now();'}
  })()`);
  if (process.env.JOT_SINGLE_LINE_PROFILE === '1') {
    await client.command('Profiler.enable');
    await client.command('Profiler.start');
  }
  if (method === 'insertText') await client.command('Input.insertText', { text: source });
  if (method === 'paste-event') await client.evaluate(`(()=>{const transfer=new DataTransfer();transfer.setData('text/plain',expectedSource);const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});editor.input.view.contentDOM.dispatchEvent(event);return event.defaultPrevented})()`);
  await waitForEvaluation(client, `editor.value.length===${units} && editor.confirmedValue===editor.value && editor.session.adapter.analysis?.state==='complete'`, timeout);
  if (process.env.JOT_SINGLE_LINE_PROFILE === '1') {
    const { profile: cpuProfile } = await client.command('Profiler.stop');
    writeFileSync(resolve(output, 'cpu-profile.json'), JSON.stringify(cpuProfile));
  }
  const pasted = await client.evaluate(`({ms:performance.now()-started,units:editor.value.length,lines:editor.input.view.state.doc.lines,match:editor.value==='中a😀'.repeat(${units / 4}),rendered:editor.input.view.contentDOM.textContent.length,firstInputEvent:window.firstInputEvent??null,errors:editorErrors})`);
  assert.equal(pasted.lines, 1);
  assert.equal(pasted.match, true);
  assert(pasted.rendered > 0, 'the editor displays a visible portion of the line');
  assert.deepEqual(pasted.errors, []);
  evidence.push({ case: `${method}-one-physical-line`, ...pasted, utf8Bytes: Buffer.byteLength(source) });
  if (process.env.JOT_SINGLE_LINE_PREVIEW === '1') {
    if (process.env.JOT_SINGLE_LINE_PREVIEW_NOWRAP === '1') await client.evaluate(`(()=>{const style=document.createElement('style');style.textContent='.jot-editor-content [data-jot-kind="paragraph"]{overflow-x:auto;white-space:pre;overflow-wrap:normal;word-break:normal}.jot-editor-content [data-jot-kind="paragraph"] .jot-inline-text{white-space:inherit}';document.head.append(style)})()`);
    if (process.env.JOT_SINGLE_LINE_PROFILE === '1') await client.command('Profiler.start');
    const started = performance.now();
    await client.evaluate(`editor.setMode('preview')`);
    await client.evaluate(`editor.surface.settled()`);
    await waitForEvaluation(client, `editor.value===editor.confirmedValue && (document.querySelector('.jot-editor-content')?.textContent.length??0)>0`, timeout);
    assert(await client.evaluate(`document.querySelector('.jot-editor-content').textContent.includes(expectedSource)`), 'preview contains the complete line');
    if (process.env.JOT_SINGLE_LINE_PROFILE === '1') {
      const { profile: cpuProfile } = await client.command('Profiler.stop');
      writeFileSync(resolve(output, 'cpu-preview.json'), JSON.stringify(cpuProfile));
    }
    evidence.push({ case: 'preview-long-line', ms: performance.now() - started });
    await client.evaluate(`(async()=>{await editor.setMode('live-preview');editor.focus()})()`);
  }
  if (process.env.JOT_SINGLE_LINE_EDIT_END === '1') await client.evaluate(`editor.input.setSelection(${units});editor.focus()`);
  const head = await client.evaluate(`editor.input.view.state.selection.main.head`);
  await client.command('Input.insertText', { text: '尾' });
  await waitForEvaluation(client, `editor.value.length===${units + 1} && editor.confirmedValue===editor.value`, 60_000);
  assert.equal(await client.evaluate(`editor.value===expectedSource.slice(0,${head})+'尾'+expectedSource.slice(${head}) && editor.input.view.state.doc.lines===1`), true);
  evidence.push({ case: 'edit-after-input', head });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ passed: true, evidence, errors }, null, 2));
  console.log(`Single-line browser checks passed: ${output}`);
} catch (error) {
  let state;
  try { state = await client?.evaluate(`({valueLength:window.editor?.value.length,confirmedLength:window.editor?.confirmedValue.length,analysis:window.editor?.session.adapter.analysis,transaction:window.lastTransaction,focus:window.editor?.input.view.hasFocus,active:document.activeElement?.outerHTML.slice(0,300),editorErrors:window.editorErrors})`); } catch {}
  writeFileSync(resolve(output, 'vite.log'), viteLog);
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ passed: false, error: String(error.stack ?? error), state, evidence, errors }, null, 2));
  throw error;
} finally {
  try { await client?.evaluate(`window.editor?.dispose();window.worker?.terminate()`); } catch {}
  client?.socket.close();
  await stopProcess(chrome);
  await stopProcess(server);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
