import assert from 'node:assert/strict';
import { waitForEvaluation } from '../../support/browser-test-utils.mjs';

// A second consumer uses only the exported constructor and theme API.
export async function runThemeScenarios({c,results}) {
 const longText='宽度验证文本一二三四五六七八九十'.repeat(8);
 const source='intro\n\n# Theme heading\n\n``` js begin\nfirst();\nsecond();\n``` end\n\n[link](https://example.com)\n\n'+longText;
 await c.evaluate(`(async()=>{
   document.querySelector('#integration').style.display='none';
   const style=document.createElement('style');style.id='theme-test-css';style.textContent='.theme-fixture { --jot-link-color: rgb(11, 12, 13); --theme-text: #345678; }';document.head.append(style);
   const root=document.createElement('div');root.id='theme-fixture';root.className='theme-fixture';root.style.cssText='height:500px;width:680px';document.body.append(root);
   const {MarkdownEditor}=await import('/@fs${process.cwd()}/packages/editor/src/index.ts');
   window.themeWorker=new Worker('/src/worker.ts',{type:'module'});window.themeErrors=[];
   window.themeEditor=new MarkdownEditor({root,mode:'live-preview',session:{endpoint:themeWorker,documentId:'theme-test',generation:1,source:${JSON.stringify(source)},syntaxProfile:{id:'default',version:1,enabledExtensions:[]}},
    theme:{colors:{background:'#f4f6f8',text:'#123456',codeBackground:'#e1e5e9',link:'#1b38a3',selection:'#ccddff'},layout:{fontSize:17,letterSpacing:.1,metrics:{paragraphLineHeight:26,blankLineHeight:22,codeLineHeight:24,paragraphPaddingX:12}}},onError:e=>themeErrors.push(String(e))});
   await themeEditor.open();await themeEditor.livePreview.settled();
 })()`);
 try {
  await waitForEvaluation(c,`themeEditor.confirmedValue===${JSON.stringify(source)} && document.querySelectorAll('#theme-fixture .jot-code-line').length===2`,15000);
  // Live Preview paints the background on the shared horizontal scroll box;
  // its individual source rows are deliberately transparent.
  const read=async()=>c.evaluate(`(()=>{const root=document.querySelector('#theme-fixture'),content=root.querySelector('.cm-content'),code=root.querySelector('.jot-code,.jot-live-preview-code-scroll'),lines=[...root.querySelectorAll(themeEditor.mode==='preview'?'.jot-source-line':'.jot-code-line')],paragraph=[...root.querySelectorAll(themeEditor.mode==='preview'?'.jot-editor-content > [data-jot-kind=paragraph]':'.jot-live-preview-native-block--paragraph')].find(n=>n.textContent.includes('宽度验证'));return{value:themeEditor.value,confirmed:themeEditor.confirmedValue,mode:themeEditor.mode,rootColor:getComputedStyle(root).color,rootBackground:getComputedStyle(root).backgroundColor,link:getComputedStyle(root).getPropertyValue('--jot-link-color').trim(),font:parseFloat(getComputedStyle(content).fontSize),lineHeight:parseFloat(getComputedStyle(content).getPropertyValue('--jot-paragraph-line-height')),selectionBackground:getComputedStyle(content,'::selection').backgroundColor,codeBackground:code?getComputedStyle(code).backgroundColor:null,codeHeights:lines.map(n=>n.getBoundingClientRect().height),codeTop:lines.length?lines[0].getBoundingClientRect().top-root.getBoundingClientRect().top:null,paragraph:paragraph?{height:paragraph.getBoundingClientRect().height,paddingLeft:parseFloat(getComputedStyle(paragraph).paddingLeft),paddingRight:parseFloat(getComputedStyle(paragraph).paddingRight)}:null,geometry:[...root.querySelectorAll(themeEditor.mode==='preview'?'.jot-editor-content > [data-jot-virtual-index]':'.cm-line')].filter(n=>n.getBoundingClientRect().height).map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {text:n.textContent?.slice(0,30),top:r.top-root.getBoundingClientRect().top,height:r.height,lineHeight:s.lineHeight,fontSize:s.fontSize,classes:n.className,kind:n.dataset.jotKind}}),scroll:themeEditor.mode==='preview'?root.querySelector('.jot-editor-surface').scrollTop:themeEditor.input.view.scrollDOM.scrollTop,headingHtml:root.querySelector(themeEditor.mode==='preview'?'.jot-md-heading':'.jot-live-preview-source-heading')?.outerHTML,errors:themeErrors}})()`);
  const initial=await read();
  assert.equal(initial.rootColor,'rgb(18, 52, 86)','initial theme colors apply to the component root');
  assert.equal(initial.rootBackground,'rgb(244, 246, 248)','initial background applies before open');
  assert.equal(initial.codeBackground,'rgb(225, 229, 233)','rendered code uses the theme color');
  assert.equal(initial.font,17,'initial typography reaches the editable host');
  assert.equal(initial.lineHeight,26,'initial geometry reaches the live-preview host');
  assert.equal(initial.selectionBackground,'rgb(204, 221, 255)','source selection uses the same theme token as widget selection');
  assert.deepEqual(initial.codeHeights,[24,24],'initial code metrics match the actual rendered rows');
  assert.equal(initial.paragraph?.paddingLeft,12,'initial paragraph inset reaches the native line');
  assert.equal(initial.paragraph?.paddingRight,12);
  assert.equal(initial.value,source);assert.equal(initial.confirmed,source);
  const clickBlank=async(expectedHeight,label)=>{
   const before=await c.evaluate(`(()=>{const view=themeEditor.input.view,lines=[...view.contentDOM.querySelectorAll('.cm-line')],line=lines.find(n=>n.classList.contains('jot-live-preview-blank-line')),next=line?.nextElementSibling;if(!line||!next)throw Error('missing blank line and following block');const r=line.getBoundingClientRect(),n=next.getBoundingClientRect();return{height:r.height,top:r.top,nextTop:n.top,x:r.left+8,y:(r.top+r.bottom)/2,scroll:view.scrollDOM.scrollTop,value:themeEditor.value}})()`);
   assert(Math.abs(before.height-expectedHeight)<1,label+': inactive blank line uses the configured height');
   for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:before.x,y:before.y});
   await c.evaluate('themeEditor.livePreview.settled()');
   const after=await c.evaluate(`(()=>{const view=themeEditor.input.view,line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.classList.contains('jot-live-preview-blank-line')),r=line.getBoundingClientRect(),n=line.nextElementSibling.getBoundingClientRect();return{height:r.height,top:r.top,nextTop:n.top,active:line.classList.contains('jot-live-preview-active-line'),scroll:view.scrollDOM.scrollTop,value:themeEditor.value,head:view.state.selection.main.head}})()`);
   assert(after.active,label+': the actual pointer activates the blank line');
   assert.equal(after.head,source.indexOf('\n\n')+1,label+': the caret enters the original blank source line');
   assert.equal(after.value,before.value,label+': clicking must not change Markdown');
   assert(Math.abs(after.height-before.height)<1,label+': activating a blank line must not change its height');
   assert(Math.abs(after.nextTop-before.nextTop)<1,label+': the following block must not jump');
   assert(Math.abs(after.scroll-before.scroll)<1,label+': the viewport must remain in place');
  };
  await clickBlank(22,'initial theme');

  await c.evaluate(`themeEditor.setTheme({colors:{text:'var(--theme-text)',codeBackground:'#d1d8df',link:null,searchMatch:'#ffcc00'},layout:{fontSize:20,metrics:{paragraphLineHeight:32,blankLineHeight:24,codeLineHeight:28,paragraphPaddingX:20}}})`);
  await c.evaluate(`themeEditor.livePreview.settled()`);
  const changed=await read();
  assert.equal(changed.rootColor,'rgb(52, 86, 120)','runtime palette updates the existing component');
  assert.equal(changed.codeBackground,'rgb(209, 216, 223)','runtime color reaches mounted code');
  assert.equal(changed.link,'rgb(11, 12, 13)','null restores the host CSS cascade');
  assert.equal(changed.font,20);assert.equal(changed.lineHeight,32);
  assert.deepEqual(changed.codeHeights,[28,28],'updated metrics remeasure live code rows');
  assert.equal(changed.paragraph?.paddingLeft,20);assert.equal(changed.paragraph?.paddingRight,20);
  assert.equal(changed.value,source);assert.equal(changed.confirmed,source);
  await clickBlank(24,'updated theme');

  const invalid=await c.evaluate(`(async()=>{try{await themeEditor.setTheme({colors:{text:'#ff0000'},layout:{fontSize:0}});return false}catch(e){return e instanceof RangeError}})()`);
  assert.equal(invalid,true,'invalid geometry is rejected');
  assert.equal((await read()).rootColor,changed.rootColor,'invalid theme does not partially change colors');
  const invalidColor=await c.evaluate(`(async()=>{try{await themeEditor.setTheme({colors:{text:'#ff0000',background:'not-a-css-color'}});return false}catch(e){return e instanceof RangeError}})()`);
  assert.equal(invalidColor,true,'invalid CSS colors are rejected');
  assert.equal((await read()).rootColor,changed.rootColor,'invalid colors do not partially apply the palette');
  await c.evaluate(`themeEditor.setMode('preview')`);
  await c.evaluate(`themeEditor.surface.settled()`);
  await waitForEvaluation(c,`document.querySelectorAll('#theme-fixture .jot-source-line').length===2`,15000);
  const preview=await read();
  assert.deepEqual(preview.codeHeights,[28,28],'Preview and live-preview consume the same code metrics');
  if(Math.abs(preview.codeTop-changed.codeTop)>=2) console.error('theme code geometry',JSON.stringify({changed,preview}));
  assert(Math.abs(preview.codeTop-changed.codeTop)<2,'the themed code block stays aligned across Preview and live-preview');
  assert.equal(preview.paragraph?.paddingLeft,20);assert.equal(preview.paragraph?.paddingRight,20);
  assert(Math.abs(preview.paragraph.height-changed.paragraph.height)<2,'the themed wrapped paragraph has the same height across both modes');
  assert.equal(preview.value,source);assert.equal(preview.confirmed,source);
  await c.evaluate(`themeEditor.setMode('live-preview')`);
  await c.evaluate(`themeEditor.livePreview.settled()`);
  const returned=await read();
  assert.deepEqual(returned.codeHeights,[28,28],'mode switches preserve the configured geometry');
  assert.deepEqual(returned.errors,[]);
  const point=await c.evaluate(`(()=>{const line=document.querySelector('#theme-fixture .jot-live-preview-source-heading');const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);while(walker.nextNode()){if(!walker.currentNode.nodeValue.includes('Theme heading'))continue;const r=document.createRange();r.selectNodeContents(walker.currentNode);const b=r.getBoundingClientRect();return{x:b.left+2,y:(b.top+b.bottom)/2};}throw Error('missing themed heading text');})()`);
  for(const type of ['mousePressed','mouseReleased']) await c.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
  await c.evaluate('themeEditor.livePreview.settled()');
  const caret=await c.evaluate(`(()=>{const view=themeEditor.input.view,head=view.state.selection.main.head,r=view.coordsAtPos(head);return{head,top:r?.top,bottom:r?.bottom,value:themeEditor.value}})()`);
  const headingStart=source.indexOf('Theme heading');
  assert(caret.head>=headingStart&&caret.head<=headingStart+'Theme heading'.length,'themed heading pointer resolves to its real source text');
  assert(caret.bottom>caret.top,'the caret remains visible beside hidden heading syntax');
  assert.equal(caret.value,source,'themed heading activation does not alter source');
  await c.command('Input.insertText',{text:'Z'});
  const edited=source.slice(0,caret.head)+'Z'+source.slice(caret.head);
  await waitForEvaluation(c,`themeEditor.value===${JSON.stringify(edited)} && themeEditor.confirmedValue===${JSON.stringify(edited)}`,15000);
  results.push({case:'public-theme-initial-and-runtime',initial,changed,preview,returned,caret});
 } finally {
  await c.evaluate(`(()=>{themeEditor.dispose();themeWorker.terminate();document.querySelector('#theme-fixture').remove();document.querySelector('#theme-test-css').remove();document.querySelector('#integration').style.display='';})()`);
 }
}
