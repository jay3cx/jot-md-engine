// 每组使用独立的 Chrome 会话，通过一次 CDP insertText 输入与组件测试相同的文档。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { largeInputFixture } from '../support/large-input-fixture.mjs';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

// 这个函数在浏览器页面中执行。分别读取 beforeinput 收到的文本和编辑区最终保存的文本。
async function mountControl(mode, viewModule) {
  document.body.replaceChildren();
  let surface, cm;
  let transactions = 0;
  if (mode === 'codemirror') {
    const { EditorView } = await import(viewModule);
    cm = new EditorView({
      extensions: [EditorView.updateListener.of(update => {
        if (update.docChanged) transactions++;
      })],
      parent: document.body,
    });
    cm.dom.style.cssText = 'width:900px;height:700px;margin:10px';
    surface = cm.contentDOM;
  } else {
    surface = document.createElement('div');
    surface.contentEditable = 'true';
    surface.style.cssText = 'width:900px;height:700px;overflow:auto;margin:10px;white-space:pre-wrap';
    document.body.append(surface);
  }
  surface.addEventListener('beforeinput', event => {
    const intercept = (mode === 'prevent' || mode === 'intercept') &&
      event.cancelable && !event.isComposing && event.inputType === 'insertText';
    if (intercept) {
      event.preventDefault();
      if (mode === 'intercept') {
        const text = document.createTextNode(event.data);
        surface.replaceChildren(text);
        const range = document.createRange();
        range.selectNodeContents(text);
        range.collapse(false);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    // 浏览器写入 DOM 前先送出输入。即使渲染进程随后超时，Node 也能核对收到的内容。
    window.reportControlInput(JSON.stringify({ data: event.data, isTrusted: event.isTrusted,
      inputType: event.inputType, cancelable: event.cancelable, isComposing: event.isComposing,
      intercepted: intercept }));
  });
  function nativeParagraphText() {
    const rows = Array.from(surface.childNodes);
    // Chrome 用文本节点表示首行，之后每行一个 div。只有 <br> 的 div 表示一个空行。
    if (rows[0]?.nodeType !== Node.TEXT_NODE || !rows.slice(1).every(row =>
      row.nodeName === 'DIV' && (Array.from(row.childNodes).every(child => child.nodeType === Node.TEXT_NODE) ||
      (row.childNodes.length === 1 && row.firstChild.nodeName === 'BR')))) return null;
    return rows.map(row => row.textContent).join('\n');
  }
  window.control = {
    focused: () => document.activeElement === surface,
    committed: () => transactions !== 0,
    read: () => ({
      transactions,
      output: cm ? cm.state.doc.toString() : mode === 'contenteditable' ? nativeParagraphText() : surface.textContent,
      rendered: mode === 'contenteditable' ? surface.innerText : null,
      // 只保存开头几个节点，便于定位换行差异。
      nodes: Array.from(surface.childNodes).slice(0, 6).map(node => ({
        name: node.nodeName, child: node.firstChild?.nodeName, text: node.textContent.slice(0, 32),
      })),
    }),
  };
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function difference(expected, actual) {
  let at = 0;
  while (at < expected.length && expected[at] === actual[at]) at++;
  return {
    utf16Offset: at,
    expectedText: expected.slice(Math.max(0, at - 12), at + 24),
    actualText: actual.slice(Math.max(0, at - 12), at + 24),
  };
}

const root = process.cwd();
const fsUrl = path => '/@fs' + path;
const port = 4199, debugPort = 9348;
const origin = `http://127.0.0.1:${port}`, debugOrigin = `http://127.0.0.1:${debugPort}`;
const fixture = resolve('.tmp/large-input-control');
const output = resolve(process.env.JOT_LARGE_CONTROL_REPORT ?? 'dist/large-input-control');
const targetBytes = Number(process.env.JOT_LARGE_CONTROL_BYTES ?? 1048576);
assert(Number.isSafeInteger(targetBytes) && targetBytes >= 16384, 'control target must be at least 16 KiB');
mkdirSync(fixture, { recursive: true }); mkdirSync(output, { recursive: true });
writeFileSync(resolve(fixture, 'vite.config.mjs'), `export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(resolve(fixture, 'vite-cache'))},optimizeDeps:{noDiscovery:true},server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[${JSON.stringify(root)}]}}};\n`);
const { source } = largeInputFixture(targetBytes);
const hash = digest(source);
const report = { expectedHash: hash, bytes: Buffer.byteLength(source, 'utf8'), utf16: source.length, modes: [] };
const modes = (process.env.JOT_LARGE_CONTROL_MODES ?? 'contenteditable,codemirror,intercept').split(',');
assert(modes.every(mode => ['contenteditable', 'codemirror', 'intercept', 'prevent'].includes(mode)), 'known control modes');
let server;
try {
  server = spawn(resolve('node_modules/.bin/vite'), ['--config', resolve(fixture, 'vite.config.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let viteLog = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => {
    viteLog += String(chunk); writeFileSync(resolve(output, 'vite.log'), viteLog);
  });
  const fixtureUrl = origin + fsUrl(resolve('scripts/browser/support/editor-browser-fixture.html'));
  await waitForHttp(fixtureUrl, 15000);
  for (const mode of modes) {
    const result = { mode, samples: [], inputEvents: 0, lengths: [], inputSent: false, inputFinished: false };
    report.modes.push(result);
    const profile = mkdtempSync(resolve(tmpdir(), 'jot-control-'));
    let chrome, client, sampler, sampling = false;
    const start = performance.now();
    const sample = () => {
      if (sampling) return; sampling = true;
      execFile('/bin/ps', ['-axo', 'pid,ppid,pcpu,rss,args'], { maxBuffer: 3_000_000 }, (error, stdout) => {
        sampling = false;
        if (error) { result.samples.push({ atMs: Math.round(performance.now() - start), error: String(error) }); return; }
        const processes = stdout.split('\n').filter(line => line.includes(profile) && line.includes('--type=renderer')).map(line => {
          const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)/u.exec(line);
          return match ? { pid: Number(match[1]), ppid: Number(match[2]), cpuPercent: Number(match[3]), rssBytes: Number(match[4]) * 1024 } : undefined;
        }).filter(Boolean);
        result.samples.push({ atMs: Math.round(performance.now() - start), processes });
      });
    };
    try {
      chrome = spawn(process.env.CHROME_BIN ?? findChrome(), ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, fixtureUrl], { stdio: 'ignore' });
      await waitForHttp(debugOrigin + '/json/version', 15000);
      const pages = await fetch(debugOrigin + '/json/list').then(response => response.json());
      client = await connectCdp(pages.find(page => page.type === 'page' && page.url.startsWith(origin + '/')).webSocketDebuggerUrl);
      await client.command('Runtime.enable');
      await client.command('Runtime.addBinding', { name: 'reportControlInput' });
      client.socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.method !== 'Runtime.bindingCalled' || message.params.name !== 'reportControlInput') return;
        const { data, ...metadata } = JSON.parse(message.params.payload);
        result.inputEvents++;
        result.lengths.push({ ...metadata, length: data?.length });
        result.receivedHash = typeof data === 'string' ? digest(data) : null;
      });
      await client.command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
      await waitForEvaluation(client, `document.readyState==='complete' && document.title==='Jot native component integration fixture'`, 15000);
      const viewModule = fsUrl(realpathSync(resolve('packages/editor/node_modules/@codemirror/view/dist/index.js')));
      await client.evaluate(`(${mountControl})(${JSON.stringify(mode)},${JSON.stringify(viewModule)})`);
      await client.command('Input.dispatchMouseEvent', { type:'mousePressed',button:'left',clickCount:1,x:20,y:21 });
      await client.command('Input.dispatchMouseEvent', { type:'mouseReleased',button:'left',clickCount:1,x:20,y:21 });
      assert(await client.evaluate('control.focused()'), `${mode}: native surface focused by real pointer`);
      sample(); sampler = setInterval(sample, 2000);
      result.inputSent = true; result.inputStartedMs = Math.round(performance.now() - start);
      await client.command('Input.insertText', { text: source });
      result.inputFinished = true; result.inputFinishedMs = Math.round(performance.now() - start);
      sample();
      // 浏览器已接收输入时，CodeMirror 的 DOM 观察器可能要到下一帧才会提交事务。
      if (mode === 'codemirror') await waitForEvaluation(client, 'control.committed()', 10000);
      const { transactions, output: committed, rendered, nodes } = await client.evaluate('control.read()');
      // innerText 会把原生编辑区中的空段落读作多个换行。保留这个实测值并单独核对 DOM 行。
      if (rendered !== null) {
        result.innerText = { utf16: rendered.length, hash: digest(rendered), matchesSource: rendered === source };
        if (rendered !== source) result.innerText.difference = difference(source, rendered);
        if (committed === null) {
          result.nodes = nodes;
          throw new Error('cannot read the native editor paragraphs');
        }
      }
      result.transactions = transactions;
      result.outputLength = committed.length;
      result.outputHash = digest(committed);
      const expected = mode === 'prevent' ? '' : source;
      result.matchesExpected = committed === expected;
      if (!result.matchesExpected) {
        result.difference = difference(expected, committed);
        result.nodes = nodes;
      }
      assert.equal(result.inputEvents, 1, `${mode}: expected one beforeinput`);
      assert(result.lengths[0].isTrusted && result.lengths[0].inputType === 'insertText', `${mode}: trusted insertText`);
      assert.equal(result.receivedHash, hash, `${mode}: beforeinput payload differs`);
      assert.equal(result.lengths[0].intercepted, mode === 'prevent' || mode === 'intercept', `${mode}: handler ran`);
      assert(result.matchesExpected, `${mode}: committed text differs from expected`);
      result.status = 'verified';
    } catch (error) {
      const event = result.lengths[0];
      if ((mode === 'contenteditable' || mode === 'codemirror') &&
          error.message === 'browser command timed out: Input.insertText' &&
          result.inputEvents === 1 && event.isTrusted && event.inputType === 'insertText' &&
          !event.intercepted && result.receivedHash === hash) {
        // 已核对输入事件。达到 CDP 的时限时尚无法读取该对照组的最终文本。
        result.status = 'input-time-budget-exceeded';
        result.observedInputMs = Math.round(performance.now() - start) - result.inputStartedMs;
      } else {
        result.status = 'failed';
        result.error = String(error.stack ?? error);
        process.exitCode = 1;
      }
    }
    finally {
      clearInterval(sampler);
      while (sampling) await new Promise(resolve => setTimeout(resolve, 10));
      result.elapsedMs = Math.round(performance.now() - start);
      client?.socket.close(); await stopProcess(chrome); rmSync(profile, { recursive: true, force: true, maxRetries:20, retryDelay:100 });
      writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({mode, status:result.status, inputFinished:result.inputFinished,inputStartedMs:result.inputStartedMs,inputFinishedMs:result.inputFinishedMs,error:result.error,samples:result.samples.length}));
    }
  }
} finally { await stopProcess(server); writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
