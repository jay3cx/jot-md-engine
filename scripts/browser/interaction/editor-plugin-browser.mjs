// Browser E2E for the exported component and real Mermaid, without Demo handlers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connectCdp, findChrome, stopProcess, waitForEvaluation, waitForHttp } from '../support/browser-test-utils.mjs';

const port=Number(process.env.JOT_PLUGIN_PORT??4268),debugPort=Number(process.env.JOT_PLUGIN_DEBUG_PORT??9468);
const output=resolve(process.env.JOT_PLUGIN_REPORT??'dist/plugin-browser-report');
const profile=mkdtempSync(resolve(tmpdir(),'jot-plugin-browser-'));
mkdirSync(output,{recursive:true});
const evidence=[],browserErrors=[];
let server,chrome,c;
const fence='```';
const documentSource=`intro\n\n${fence} mermaid\ngantt\n  dateFormat YYYY-MM-DD\n  axisFormat %m-%d\n  section 项目\n  设计与准备 :2026-11-02, 3d\n  研发与验证 :2026-11-05, 5d\n${fence}\n\n## 后续正文\n\n${fence} ts\nconst x = 1;\n${fence}\n\nend`;
try {
 server=spawn(resolve('node_modules/.bin/vite'),['--config','apps/demo/vite.config.mjs','--port',String(port),'--strictPort'],{stdio:'ignore'});
 await waitForHttp(`http://127.0.0.1:${port}/`,15000);
 chrome=spawn(process.env.CHROME_BIN??findChrome(),['--headless=new','--no-first-run','--disable-background-networking',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/@fs${process.cwd()}/scripts/browser/support/editor-browser-fixture.html`],{stdio:'ignore'});
 await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,15000);
 const pages=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
 c=await connectCdp(pages.find(p=>p.type==='page'&&p.url.includes(`:${port}`)).webSocketDebuggerUrl);
 c.socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.method==='Runtime.exceptionThrown')browserErrors.push(message.params.exceptionDetails.text)});
 await c.command('Runtime.enable');
 await c.command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
 await waitForEvaluation(c,`document.readyState==='complete' && document.title==='Jot native component integration fixture'`,15000);
 await c.evaluate(`(async()=>{
  const {MarkdownEditor,createMermaidPlugin}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
  const {loadMermaid}=await import('/src/mermaid-loader.ts');
  const root=document.createElement('div');root.id='integration';root.style.cssText='height:700px;width:900px;margin:10px';document.body.replaceChildren(root);
  window.worker=new Worker('/src/worker.ts',{type:'module'});window.errors=[];window.loads=0;window.mermaidRenderCalls=[];window.activations=0;window.cleanups=0;
  const delayed={id:'delayed',enabled:false,activate(editor){activations++;editor.commands.register({id:'plugin.probe',title:'Plugin probe',run:()=>({userEvent:'plugin.probe'})});editor.commands.bind({id:'plugin.probe.key',command:'plugin.probe',key:'Mod-Alt-p'});return()=>{cleanups++;editor.commands.unregister('plugin.probe')}},codeBlocks:[{languages:['probe'],render({document}){return new Promise(resolve=>{window.finishDelayed=()=>{const n=document.createElement('span');n.className='delayed-output';n.textContent='late output';resolve(n)}})}}]};
  const dual={id:'dual',codeBlocks:['first','second'].map(language=>({languages:[language],render({document}){const n=document.createElement('span');n.className='dual-'+language;n.textContent=language;return n}}))};
  window.editor=new MarkdownEditor({root,mode:'live-preview',plugins:[createMermaidPlugin({enabled:false,load:async()=>{loads++;const m=(await loadMermaid()).default;return{default:{initialize:c=>m.initialize(c),render:(id,source,container)=>{mermaidRenderCalls.push(source);return m.render(id,source,container)}}}}}),delayed,dual],session:{endpoint:worker,documentId:'plugin-test',generation:1,source:'ready',syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>errors.push(String(e))});
  await editor.open();window.view=editor.input.view;
  window.createCompat=async(source)=>{root.style.display='none';const second=document.createElement('div');second.id='compat';second.style.cssText='height:700px;width:900px;margin:10px';document.body.append(second);window.compatWorker=new Worker('/src/worker.ts',{type:'module'});window.compatEditor=new MarkdownEditor({root:second,mode:'live-preview',plugins:[createMermaidPlugin({load:loadMermaid})],session:{endpoint:compatWorker,documentId:'compat-test',generation:1,source,syntaxProfile:{id:'default',version:1,enabledExtensions:[{id:'commonmark-fence-language',version:'1.0.0'}]}},onError:e=>errors.push(String(e))});await compatEditor.open();compatEditor.input.setSelection(0);await compatEditor.livePreview.settled()};
 })()`);
 await c.evaluate(`editor.setPluginEnabled('mermaid',true)`);
 await settle();
 assert.equal(await c.evaluate('loads'),0,'enabled plugin without a diagram does not load Mermaid');
 await c.evaluate(`editor.setPluginEnabled('mermaid',false)`);
 await load(documentSource);
 assert.equal(await c.evaluate('editor.isPluginEnabled("mermaid")'),false);
 assert.equal(await c.evaluate('loads'),0,'disabled plugin must not load Mermaid');
 assert(await c.evaluate(`document.querySelectorAll('.jot-code-line').length>0 && !document.querySelector('.jot-mermaid')`),'disabled plugin uses ordinary code rendering');
 assert(await c.evaluate(`view.contentDOM.textContent.includes('后续正文')`),'the following heading stays outside both code blocks');
 await c.evaluate(`editor.setPluginEnabled('mermaid',true)`);
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] .jot-mermaid svg')`,60000);
 assert.equal(await c.evaluate('loads'),1,'Mermaid is loaded on demand');
 assert.equal(await c.evaluate('editor.value'),documentSource);
 assert(await c.evaluate(`!!document.querySelector('.jot-live-preview-source-fenced-code.jot-code-line')`),'ordinary code stays native');
 const lightRenders=await c.evaluate('mermaidRenderCalls.length');
 await c.evaluate('editor.invalidateLayout()');await settle();
 assert.equal(await c.evaluate('mermaidRenderCalls.length'),lightRenders,'unchanged layout invalidation reuses the rendered SVG');
 await screenshot('gantt-live');
 evidence.push({case:'enabled-gantt',loads:await c.evaluate('loads')});

 await c.evaluate(`editor.setTheme({colors:{background:'#111315',text:'#eeeeee'}})`);
 await waitForEvaluation(c,`!!document.querySelector('.jot-mermaid[data-jot-mermaid-theme="dark"] svg')`,60000);
 const darkRenders=await c.evaluate('mermaidRenderCalls.length');
 assert(darkRenders>lightRenders,'a new theme needs its own render');
 assert.equal(await c.evaluate('editor.value'),documentSource,'theme changes preserve source');
 await screenshot('gantt-dark');
 await c.evaluate(`editor.setTheme({colors:{background:'#ffffff',text:'#222222'}})`);
 await waitForEvaluation(c,`!!document.querySelector('.jot-mermaid[data-jot-mermaid-theme="default"] svg')`,60000);
 assert.equal(await c.evaluate('mermaidRenderCalls.length'),darkRenders,'returning to a cached theme does not render again');
 evidence.push({case:'diagram-light-and-dark'});

 await c.evaluate('editor.openSearch()');
 await c.command('Input.insertText',{text:'研发与验证'});
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await waitForEvaluation(c,`view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to)==='研发与验证' && !document.querySelector('.jot-plugin-block')`,15000);
 assert.equal(await c.evaluate('editor.value'),documentSource,'search inside a diagram does not change source');
 assert.equal(await c.evaluate(`editor.setSearchQuery({search:'研发与验证',replace:'实现与测试'});editor.replaceAll()`),true);
 await confirmed();assert.equal(await c.evaluate('editor.value'),documentSource.replace('研发与验证','实现与测试'));
 await c.evaluate('editor.input.closeSearch();editor.focus()');
 const modifier=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`)?4:2;
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:modifier});
 await confirmed();assert.equal(await c.evaluate('editor.value'),documentSource,'one undo restores diagram replacement');
 await c.evaluate('editor.input.setSelection(0);editor.focus();editor.livePreview.settled()');
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 evidence.push({case:'search-replace-and-undo-in-diagram'});

 const point=await c.evaluate(`(()=>{const r=document.querySelector('.jot-mermaid svg').getBoundingClientRect(),p=view.scrollDOM.getBoundingClientRect();return{x:Math.max(p.left+10,Math.min(p.right-10,(r.left+r.right)/2)),y:Math.max(p.top+10,Math.min(p.bottom-10,(r.top+r.bottom)/2))}})()`);
 for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
 await waitForEvaluation(c,`!document.querySelector('.jot-plugin-block') && view.hasFocus`,15000);
 const head=await c.evaluate('view.state.selection.main.head');
 assert(head>=documentSource.indexOf('gantt')&&head<=documentSource.indexOf('gantt')+5,'clicking a diagram enters its actual code content');
 await c.command('Input.insertText',{text:'%% edited\n%% '});await confirmed();
 await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
 assert(await c.evaluate(`view.composing && !document.querySelector('.jot-plugin-block')`),'composition stays in the native code editor');
 await c.command('Input.insertText',{text:'是'});await c.command('Input.insertText',{text:'\n'});await confirmed();
 const edited=documentSource.replace('gantt','%% edited\n%% 是\ngantt');
 assert.equal(await c.evaluate('editor.value'),edited,'editing uses the single Markdown source');
 await c.evaluate('editor.input.setSelection(0);editor.focus();editor.livePreview.settled()');
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 evidence.push({case:'click-edit-ime-redraw'});

 await c.evaluate(`editor.setMode('preview')`);await c.evaluate('editor.surface.settled()');
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 await c.evaluate(`editor.setPluginEnabled('mermaid',false)`);
 await waitForEvaluation(c,`!document.querySelector('.jot-plugin-block') && !!document.querySelector('.jot-code')`,15000);
 assert.equal(await c.evaluate('editor.value'),edited,'disabling a plugin preserves source');
 await c.evaluate(`editor.setPluginEnabled('mermaid',true)`);
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 evidence.push({case:'preview-enable-disable'});

 const hostile=`intro\n\n${fence} mermaid\nflowchart TD\nA["<img src=x onerror=alert(1)>"]\n${fence}\n\nafter`;
 await c.evaluate(`window.diagramAlerts=0;window.alert=()=>{diagramAlerts++}`);
 await c.evaluate(`editor.setMode('live-preview')`);await load(hostile);
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 await settle();
 const markup=await c.evaluate(`(()=>{const root=document.querySelector('.jot-mermaid'),nodes=[...root.querySelectorAll('*')];return{scripts:root.querySelectorAll('script').length,handlers:nodes.flatMap(n=>[...n.attributes].filter(a=>/^on/i.test(a.name)).map(a=>a.name)),unsafeLinks:nodes.map(n=>n.getAttribute('href')??n.getAttribute('xlink:href')).filter(h=>/^\\s*javascript:/i.test(h??'')),alerts:diagramAlerts,images:[...root.querySelectorAll('img')].map(n=>n.outerHTML)}})()`);
 evidence.push({case:'strict-diagram-markup',markup});
 assert.deepEqual({scripts:markup.scripts,handlers:markup.handlers,unsafeLinks:markup.unsafeLinks,alerts:markup.alerts},{scripts:0,handlers:[],unsafeLinks:[],alerts:0},'untrusted diagram markup cannot execute scripts or handlers');

 const many='intro\n\n'+Array.from({length:120},(_,i)=>`${fence} mermaid\nflowchart LR\nItem_${i}-->End_${i}\n${fence}\n\n`).join('')+'end';
 await load(many);
 await waitForEvaluation(c,`[...document.querySelectorAll('.jot-plugin-block[data-jot-plugin-state="ready"] svg')].some(n=>n.textContent.includes('Item_0'))`,60000);
 const firstRenderCount=await c.evaluate(`mermaidRenderCalls.filter(source=>source.includes('Item_0-->End_0')).length`);
 const firstX=await c.evaluate(`(()=>{const s=[...document.querySelectorAll('.jot-mermaid svg')].find(n=>n.textContent.includes('Item_0'));return s.getBoundingClientRect().left})()`);
 const topCount=await c.evaluate(`document.querySelectorAll('.jot-plugin-block').length`);
 assert(topCount<30,'many diagrams keep a bounded mounted viewport');
 const scrollPoint=await c.evaluate(`(()=>{const r=view.scrollDOM.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 for(let i=0;i<3;i++)await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:0,deltaY:2200});
 await settle();
 await waitForEvaluation(c,`view.scrollDOM.scrollTop>500 && [...document.querySelectorAll('.jot-plugin-block[data-jot-plugin-state="ready"]')].some(n=>{const a=n.getBoundingClientRect(),b=view.scrollDOM.getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom&&!!n.querySelector('svg')})`,60000);
 const visible=await c.evaluate(`(()=>{const p=view.scrollDOM.getBoundingClientRect();return [...document.querySelectorAll('.jot-plugin-block[data-jot-plugin-state="ready"]')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom}).map(n=>({text:n.textContent,source:editor.value.slice(Number(n.dataset.jotSourceFrom),Number(n.dataset.jotSourceTo))}))})()`);
 assert(visible.length>0,'diagrams appear in the scrolled viewport');
 for(const item of visible){const id=item.text.match(/Item_\d+/u)?.[0];assert(id&&item.source.includes(id),'a scrolled diagram corresponds to its own source range')}
 assert.equal(await c.evaluate('editor.value'),many);
 assert(!await c.evaluate(`[...document.querySelectorAll('.jot-mermaid svg')].some(n=>n.textContent.includes('Item_0'))`),'the first diagram was actually unmounted outside the viewport');
 await c.command('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:0,deltaY:-20000});
 await waitForEvaluation(c,`[...document.querySelectorAll('.jot-plugin-block[data-jot-plugin-state="ready"] svg')].some(n=>n.textContent.includes('Item_0') && n.getBoundingClientRect().bottom>view.scrollDOM.getBoundingClientRect().top)`,60000);
 assert.equal(await c.evaluate(`mermaidRenderCalls.filter(source=>source.includes('Item_0-->End_0')).length`),firstRenderCount,'a diagram returning from outside the viewport is not rendered again');
 const returnedX=await c.evaluate(`(()=>{const s=[...document.querySelectorAll('.jot-mermaid svg')].find(n=>n.textContent.includes('Item_0'));return s.getBoundingClientRect().left})()`);
 assert(Math.abs(returnedX-firstX)<1,'the cached diagram retains its horizontal alignment after scrolling');
 evidence.push({case:'many-diagrams-scroll',initialMounted:topCount,visible:visible.length,firstRenderCount,firstX,returnedX});

 const cacheChecks=await c.evaluate(`(async()=>{
  const {createMermaidPlugin}=await import('/@fs${process.cwd()}/packages/editor/src/plugins/mermaid.ts');
  let calls=0;const stages=[];const renderer=createMermaidPlugin({cacheMaxEntries:1,load:async()=>({initialize(){},async render(id,source,stage){calls++;stages.push(stage);if(!stage?.isConnected)throw Error('missing staging host');return{svg:'<svg xmlns="http://www.w3.org/2000/svg" id="'+id+'"><text>'+source+'</text></svg>'}}})}).codeBlocks[0];
  const scope={},otherScope={},host=document.createElement('div');
  const run=(nodeId,source,cacheScope=scope)=>renderer.render({nodeId,source,cacheScope,document,element:host,signal:new AbortController().signal});
  const first=await run('one','A');const hit=run('one','A');const synchronous=hit instanceof Node;
  const second=await run('two','A');const distinctIds=first.querySelector('svg').id!==second.querySelector('svg').id;
  await run('one','A');await run('one','A',otherScope);
  let disabledCalls=0;const disabled=createMermaidPlugin({cacheMaxBytes:0,load:async()=>({initialize(){},async render(id){disabledCalls++;return{svg:'<svg xmlns="http://www.w3.org/2000/svg" id="'+id+'"></svg>'}}})}).codeBlocks[0];
  const params={nodeId:'one',source:'A',cacheScope:scope,document,element:host,signal:new AbortController().signal};await disabled.render(params);await disabled.render(params);
  let started,release,abortCalls=0,abortStage,failedStage;const startedPromise=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const delayed=createMermaidPlugin({load:async()=>({initialize(){},async render(id,_source,stage){abortCalls++;abortStage=stage;started();await gate;return{svg:'<svg xmlns="http://www.w3.org/2000/svg" id="'+id+'"></svg>'}}})}).codeBlocks[0];
  const oldSignal=new AbortController(),old=delayed.render({...params,signal:oldSignal.signal}).catch(e=>e.name);await startedPromise;oldSignal.abort();const next=delayed.render(params);release();
  const oldResult=await old,nextSvg=!!(await next).querySelector('svg');
  const failing=createMermaidPlugin({load:async()=>({initialize(){},async render(_id,_source,stage){failedStage=stage;throw Error('draw failed')}})}).codeBlocks[0];
  const failure=await failing.render(params).catch(e=>e.message);
  return{synchronous,distinctIds,calls,disabledCalls,abortCalls,oldResult,nextSvg,failure,stagesClean:stages.every(s=>!s.isConnected)&&!abortStage.isConnected&&!failedStage.isConnected};
 })()`);
 assert.deepEqual(cacheChecks,{synchronous:true,distinctIds:true,calls:4,disabledCalls:2,abortCalls:1,oldResult:'AbortError',nextSvg:true,failure:'draw failed',stagesClean:true},'cache isolation, eviction, disabling, cancellation and staging cleanup behave correctly');
 evidence.push({case:'mermaid-cache-boundaries',...cacheChecks});

 const invalid=`intro\n\n${fence} mermaid\nthis is invalid mermaid !!!\n${fence}\n\nafter`;
 await load(invalid);
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="error"]')`,60000);
 assert(await c.evaluate(`document.querySelector('.jot-plugin-block__source').textContent.includes('invalid mermaid')`),'invalid diagrams display their source');
 assert.deepEqual(await c.evaluate('errors'),[],'an invalid diagram is an editable content error, not a fatal editor error');
 evidence.push({case:'invalid-fallback'});

 const slow=`intro\n\n${fence} probe\nslow text\n${fence}\n\nafter`;
 await c.evaluate(`editor.setPluginEnabled('mermaid',false)`);await load(slow);
 await c.evaluate(`editor.setPluginEnabled('delayed',true)`);
 await waitForEvaluation(c,`typeof finishDelayed==='function'`,15000);
 assert(await c.evaluate(`!!editor.commands.command('plugin.probe')`),'activating a plugin can register a command');
 await c.evaluate(`(async()=>{await editor.setPluginEnabled('delayed',false);finishDelayed()})()`);
 await settle();await settle();
 assert.equal(await c.evaluate(`!!document.querySelector('.delayed-output')`),false,'late async output cannot resurrect a disabled plugin');
 assert.deepEqual(await c.evaluate('[activations,cleanups]'),[1,1]);
 assert.equal(await c.evaluate(`editor.commands.command('plugin.probe')===undefined`),true,'cleanup unregisters the plugin command');
 assert.equal(await c.evaluate('editor.value'),slow);
 evidence.push({case:'cancel-and-cleanup'});

 await c.evaluate(`delete window.finishDelayed;editor.setPluginEnabled('delayed',true)`);
 await waitForEvaluation(c,`typeof finishDelayed==='function'`,15000);
 await c.evaluate(`(()=>{const original=worker.postMessage,own=Object.hasOwn(worker,'postMessage'),pending=[];worker.postMessage=function(...args){pending.push(args)};window.releasePluginGate=()=>{if(own)worker.postMessage=original;else delete worker.postMessage;for(const args of pending)original.apply(worker,args);return pending.length};const at=editor.value.indexOf('slow text');editor.input.replaceRange(at,at+4,'new')})()`);
 assert.notEqual(await c.evaluate('editor.value'),await c.evaluate('editor.confirmedValue'),'Worker confirmation is actually delayed');
 await c.evaluate('finishDelayed()');await settle();
 assert.equal(await c.evaluate(`!!document.querySelector('.delayed-output')`),false,'stale async rendering is discarded after an unconfirmed source edit');
 assert((await c.evaluate('releasePluginGate()'))>0);await confirmed();
 await c.evaluate(`editor.setPluginEnabled('delayed',false)`);
 assert.equal(await c.evaluate('editor.value'),slow.replace('slow text','new text'));
 evidence.push({case:'delayed-worker-stale-render'});

 const dualSource=`intro\n\n${fence} first\ncontent\n${fence}\n\nafter`;
 await load(dualSource);
 await waitForEvaluation(c,`!!document.querySelector('.dual-first')`,15000);
 await c.evaluate(`editor.setMode('preview')`);
 await waitForEvaluation(c,`!!document.querySelector('.dual-first')`,15000);
 const dualId=await c.evaluate(`document.querySelector('.dual-first').closest('[data-jot-node-id]').dataset.jotNodeId`);
 const dualAt=dualSource.indexOf('first');
 await c.evaluate(`editor.input.replaceRange(${dualAt},${dualAt+5},'second')`);await confirmed();
 await waitForEvaluation(c,`!!document.querySelector('.dual-second')`,15000);
 assert.equal(await c.evaluate(`document.querySelector('.dual-second').closest('[data-jot-node-id]').dataset.jotNodeId`),dualId,'changing a language keeps node identity while selecting the new renderer');
 evidence.push({case:'same-node-different-renderer'});

 await c.evaluate(`editor.setMode('live-preview')`);
 await c.evaluate(`editor.setPluginEnabled('mermaid',true)`);
 const strictSource=`intro\n\n${fence}mermaid\ngantt\n${fence}\n\nafter`;
 await load(strictSource);
 assert.equal(await c.evaluate(`!!document.querySelector('.jot-plugin-block')`),false,'enabling the plugin does not change the default parser profile');
 assert(await c.evaluate(`view.contentDOM.textContent.includes(${JSON.stringify(fence+'mermaid')})`),'the strict profile keeps the unspaced opener as ordinary source');
 evidence.push({case:'default-grammar-unchanged'});

 const solo=`${fence} mermaid\nflowchart LR\nA-->B\n${fence}`;
 await load(solo);
 assert.equal(await c.evaluate(`!!document.querySelector('.jot-plugin-block')`),false,'focused diagram source remains editable');
 for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:1000,y:780});
 await waitForEvaluation(c,`!!document.querySelector('.jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 assert.equal(await c.evaluate('editor.value'),solo,'blurring a single diagram preserves source');
 const soloPoint=await c.evaluate(`(()=>{const r=document.querySelector('.jot-mermaid svg').getBoundingClientRect();return{x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()`);
 for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...soloPoint});
 await waitForEvaluation(c,`view.hasFocus && !document.querySelector('.jot-plugin-block')`,15000);
 evidence.push({case:'single-diagram-blur-and-edit'});

 const compatSource=`intro\n\n${fence}mermaid\ngantt\n  dateFormat YYYY-MM-DD\n  section 项目\n  设计 :2026-11-02, 3d\n${fence}\n\n## 后续正文\n\n${fence}ts\nconst after = 1;\n${fence}\n\nend`;
 await c.evaluate(`createCompat(${JSON.stringify(compatSource)})`);
 await waitForEvaluation(c,`!!document.querySelector('#compat .jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 assert.equal(await c.evaluate('compatEditor.value'),compatSource,'compatibility rendering preserves the exact source');
 assert(await c.evaluate(`document.querySelector('#compat .cm-content').textContent.includes('后续正文')`),'a following heading is not absorbed by the diagram fence');
 assert(await c.evaluate(`document.querySelector('#compat .jot-code-line')?.textContent.includes('const after')`),'a later code block remains independent');
 const at=await c.evaluate(`compatEditor.value.indexOf('mermaid')`);
 await c.evaluate(`compatEditor.input.replaceRange(${at},${at},' ')`);
 await waitForEvaluation(c,`compatEditor.value===compatEditor.confirmedValue && compatEditor.session.adapter.analysis?.state==='complete'`,20000);
 await c.evaluate(`compatEditor.input.setSelection(0);compatEditor.livePreview.settled()`);
 await waitForEvaluation(c,`!!document.querySelector('#compat .jot-plugin-block[data-jot-plugin-state="ready"] svg')`,60000);
 assert.equal(await c.evaluate('compatEditor.value'),compatSource.replace('```mermaid','``` mermaid'));
 evidence.push({case:'opt-in-unspaced-fence-and-edit'});

 await c.evaluate(`compatEditor.setValue('')`);
 await waitForEvaluation(c,`compatEditor.value===compatEditor.confirmedValue && compatEditor.session.adapter.analysis?.state==='complete'`,20000);
 await c.evaluate('compatEditor.livePreview.settled()');
 const emptyPoint=await c.evaluate(`(()=>{const r=document.querySelector('#compat .cm-line').getBoundingClientRect();return{x:r.left+4,y:(r.top+r.bottom)/2}})()`);
 for(const type of ['mousePressed','mouseReleased'])await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...emptyPoint});
 await c.evaluate(`(()=>{const original=compatWorker.postMessage,own=Object.hasOwn(compatWorker,'postMessage'),pending=[];compatWorker.postMessage=function(...args){pending.push(args)};window.releaseCompatGate=()=>{if(own)compatWorker.postMessage=original;else delete compatWorker.postMessage;for(const args of pending)original.apply(compatWorker,args);return pending.length}})()`);
 await c.command('Input.insertText',{text:fence+'mermaid'});
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await c.command('Input.insertText',{text:fence});
 for(const type of ['keyDown','keyUp'])await c.command('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36});
 await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});
 await c.command('Input.insertText',{text:'是'});
 assert((await c.evaluate('releaseCompatGate()'))>0,'the compatibility test delayed real Worker messages');
 await waitForEvaluation(c,`compatEditor.value===compatEditor.confirmedValue && compatEditor.session.adapter.analysis?.state==='complete'`,20000);
 await c.evaluate('compatEditor.livePreview.settled()');
 assert.equal(await c.evaluate('compatEditor.value'),fence+'mermaid\n是\n'+fence,'rapid IME input keeps the compatible closing fence intact');
 assert.equal(await c.evaluate(`compatEditor.session.adapter.blocks.blocks.filter(node=>node.kind==='fenced-code').length`),1);
 evidence.push({case:'opt-in-rapid-ime-delayed-worker'});

 // The lazy math renderer is a component capability, not a Demo-only facade.
 // Hold its real module load while the document changes, then release it.
 await c.evaluate(`(async()=>{
  document.querySelector('#compat').style.display='none';
  const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/component/index.ts');
  const {createLazyKaTeXRenderer}=await import('/@fs${process.cwd()}/packages/editor/src/components/math/lazy-katex.ts');
  await import('/@fs${process.cwd()}/packages/editor/node_modules/katex/dist/katex.min.css');
  const root=document.createElement('div');root.id='lazy-math';root.style.cssText='height:700px;width:900px;margin:10px';document.body.append(root);
  window.mathLoads=0;window.mathLayoutEvents=0;root.addEventListener('jot-math-rendered',()=>mathLayoutEvents++);
  const gate=new Promise(resolve=>{window.releaseMath=resolve});
  const renderMath=createLazyKaTeXRenderer({},()=>{mathLoads++;return gate.then(()=>import('/@fs${process.cwd()}/packages/editor/src/components/math/katex.ts'))});
  window.mathWorker=new Worker('/src/worker.ts',{type:'module'});
  window.mathEditor=new MarkdownEditor({root,mode:'live-preview',surface:{renderMath},session:{endpoint:mathWorker,documentId:'lazy-math-test',generation:1,source:${JSON.stringify('# 普通文档\n\n这里没有公式。')},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},onError:e=>errors.push(String(e))});
  await mathEditor.open();await mathEditor.livePreview.settled();
 })()`);
 assert.equal(await c.evaluate('mathLoads'),0,'documents without formulas do not load KaTeX');
 await c.evaluate(`mathEditor.setValue(${JSON.stringify('# 初版\n\n公式 $OLD$ 与 $z^2$。\n\n$$\nf(z)=z^2\n$$')})`);
 await waitForEvaluation(c,`mathLoads===1 && document.querySelectorAll('#lazy-math .jot-katex').length>=2`,20000);
 assert(await c.evaluate(`document.querySelector('#lazy-math').textContent.includes('OLD')`),'formula source stays visible while its renderer loads');
 await c.evaluate(`mathEditor.setValue(${JSON.stringify('# 新版\n\n公式 $NEW$ 与 $y^2$。\n\n$$\nf(y)=y^2\n$$')})`);
 await waitForEvaluation(c,`mathEditor.value===mathEditor.confirmedValue && document.querySelector('#lazy-math')?.textContent.includes('NEW')`,20000);
 // Confirm the latest formula placeholders are mounted before releasing the
 // loader. Otherwise the renderer may load between revisions and new nodes
 // render synchronously, leaving no connected placeholder that needs an event.
 await c.evaluate('mathEditor.livePreview.settled()');
 await waitForEvaluation(c,`document.querySelectorAll('#lazy-math .jot-katex').length>=2 && [...document.querySelectorAll('#lazy-math .jot-katex')].some(node=>node.textContent.includes('NEW'))`,20000);
 await c.evaluate('releaseMath()');
 await waitForEvaluation(c,`document.querySelectorAll('#lazy-math .katex-html').length>=2 && mathLayoutEvents>0`,30000);
 assert.equal(await c.evaluate('mathLoads'),1,'concurrent formulas share one module load');
 assert(!await c.evaluate(`document.querySelector('#lazy-math').textContent.includes('OLD')`),'late results do not restore an old formula');
 assert((await c.evaluate('mathEditor.value')).includes('$NEW$'),'loading formulas preserves the latest Markdown source');
 evidence.push({case:'lazy-math-delayed-and-stale',loads:await c.evaluate('mathLoads'),layoutEvents:await c.evaluate('mathLayoutEvents')});

 await c.evaluate(`(async()=>{
  const {createLazyKaTeXRenderer}=await import('/@fs${process.cwd()}/packages/editor/src/components/math/lazy-katex.ts');
  window.mathAttempts=0;const render=createLazyKaTeXRenderer({},()=>{mathAttempts++;return mathAttempts===1?Promise.reject(new Error('load failed')):import('/@fs${process.cwd()}/packages/editor/src/components/math/katex.ts')});
  const host=document.createElement('div');host.id='math-retry';document.body.append(host);host.append(render('a^2',false,document));window.retryMath=()=>host.append(render('b^2',false,document));
 })()`);
 await waitForEvaluation(c,`document.querySelector('#math-retry [data-jot-math-error="true"]')?.textContent==='a^2'`,10000);
 await c.evaluate('retryMath()');
 await waitForEvaluation(c,`!!document.querySelector('#math-retry .katex-html')`,20000);
 assert.equal(await c.evaluate('mathAttempts'),2,'a failed lazy load can be retried');
 evidence.push({case:'lazy-math-load-failure-and-retry'});

 assert.deepEqual(browserErrors,[],'no uncaught browser exceptions');
 writeFileSync(resolve(output,'report.json'),JSON.stringify({passed:true,evidence,browserErrors},null,2));
 console.log(`Plugin browser checks passed: ${output}`);
} catch(error) {
 try { await screenshot('failure'); } catch {}
 let state;try{state=await c?.evaluate(`({source:window.editor?.value,errors:window.errors,scrollTop:window.view?.scrollDOM.scrollTop,renderCalls:window.mermaidRenderCalls?.length,html:document.querySelector('#integration')?.outerHTML.slice(0,15000)})`)}catch{}
 writeFileSync(resolve(output,'report.json'),JSON.stringify({passed:false,error:String(error.stack??error),state,evidence,browserErrors},null,2));
 throw error;
} finally {
 try { await c?.evaluate(`window.mathEditor?.dispose();window.mathWorker?.terminate();window.compatEditor?.dispose();window.compatWorker?.terminate();window.editor?.dispose();window.worker?.terminate()`); } catch {}
 c?.socket.close();await stopProcess(chrome);await stopProcess(server);rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}

async function settle(){await c.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))`)}
async function confirmed(){await waitForEvaluation(c,`editor.session.adapter.analysis?.state==='complete'&&editor.value===editor.confirmedValue`,20000);await c.evaluate('editor.livePreview.settled()');await settle()}
async function load(source){await c.evaluate(`editor.setValue(${JSON.stringify(source)});editor.input.setSelection(0);editor.focus()`);await confirmed()}
async function screenshot(name){const result=await c.command('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,name+'.png'),Buffer.from(result.data,'base64'))}
