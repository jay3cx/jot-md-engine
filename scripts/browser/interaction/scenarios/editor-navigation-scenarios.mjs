import assert from 'node:assert/strict';

// Mount/setup are shared with the native component harness. Each scenario gets
// one initial caret placement; every subsequent edit/navigation is a real key.
export async function runNavigationScenarios({c,load,settle,confirmed,key,screenshot,results}) {
 const mac=await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`);
 const mod=mac?4:2;
 async function press(name,modifiers=0) {
  const code=name.length===1?'Key'+name.toUpperCase():name;
  await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,modifiers});
  await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,modifiers});
  await settle();
 }
 async function type(text) {await c.command('Input.insertText',{text});await confirmed();}
 async function startAt(expression) {await c.evaluate(`editor.input.setSelection(${expression});editor.focus()`);await settle();}
 async function clickBodyText(text) {
  const point=await c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(n=>n.textContent.includes(${JSON.stringify(text)}));if(!line)throw Error('code body line not visible');const r=line.getBoundingClientRect();if(r.width<4||r.height<4)throw Error('code body has no visible box');return{x:r.left+Math.min(50,r.width/2),y:r.top+r.height/2}})()`);
  await c.command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await settle();
 }
 async function snapshot() {return c.evaluate(`(()=>{const head=view.state.selection.main.head,r=view.coordsAtPos(head),p=view.scrollDOM.getBoundingClientRect();return {source:editor.value,head,caret:r&&{top:r.top,bottom:r.bottom},viewport:{top:p.top,bottom:p.bottom},lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(n=>({text:n.textContent,height:n.getBoundingClientRect().height}))}})()`);}
 async function tableCells() {return c.evaluate(`Array.from(document.querySelectorAll('.jot-table-grid-body .jot-table-cell'),n=>{const style=getComputedStyle(n),box=n.getBoundingClientRect(),walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT),tops=new Set();while(walker.nextNode()){if(!walker.currentNode.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);for(const rect of range.getClientRects())if(rect.width>0)tops.add(Math.round(rect.top*100)/100);}return {text:n.textContent,column:Number(n.dataset.jotColumnIndex),from:Number(n.dataset.jotSourceFrom),to:Number(n.dataset.jotSourceTo),active:n.classList.contains('jot-live-preview-table-cell--active'),width:box.width,height:box.height,lineHeight:parseFloat(style.lineHeight),verticalChrome:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth),textLineTops:[...tops]}})`);}
 async function trace(stage) {
  if (!process.env.JOT_NAVIGATION_TRACE) return;
  const state=await snapshot();
  const details=await c.evaluate(`(()=>{const line=view.state.doc.lineAt(view.state.selection.main.head);return {line:{number:line.number,from:line.from,to:line.to,text:line.text},roots:editor.session.adapter.blocks.blocks.map(b=>({kind:b.kind,from:b.sourceRange.from,to:b.sourceRange.to,dirty:b.dirty}))}})()`);
  console.log('[navigation] '+stage+' '+JSON.stringify({...state,...details}));
 }

 await load('- first\n> quote');await startAt('2');
 await press('Backspace');await confirmed();
 assert.equal((await snapshot()).source,'first\n> quote','Backspace at a hidden list prefix converts it to ordinary text');
 await press('ArrowDown');await press('Home');await press('Backspace');await confirmed();await type('plain-');
 const prefix=await snapshot();
 assert.equal(prefix.source,'first\nplain-quote','Home/Backspace at a hidden quote prefix never traps the caret');
 results.push({case:'keyboard-hidden-prefix-backspace',...prefix});

 await load('lead\n\n- first\n\n> quote\n\nend');
 await startAt("editor.value.indexOf('first')+5");
 await press('Enter');await confirmed();await type('second');
 assert((await snapshot()).source.includes('- first\n- second'),'Enter continues a list item');
 await press('Tab');await confirmed();
 assert(/\n[\t ]+- second/u.test((await snapshot()).source),'Tab indents the active list item');
 await press('Tab',8);await confirmed();
 assert((await snapshot()).source.includes('\n- second'),'Shift-Tab removes list indentation');
 await press('Enter');await confirmed();await press('Enter');await confirmed();await type('between');
 await trace('list-exit');
 assert((await snapshot()).source.includes('\nbetween\n'),'Enter on the empty list item exits the list');
 await press('Enter',mod);await confirmed();
 await trace('exit-paragraph');
 await press('ArrowDown');await trace('down-to-quote');
 await press('End');await trace('end-of-quote');
 await press('Enter');await confirmed();await type('continued');
 await trace('continued-quote');
 assert((await snapshot()).source.includes('> quote\n> continued'),'quote continuation remains keyboard editable');
 await press('Enter');await confirmed();await trace('empty-quote');
 await press('Tab',8);await confirmed();await trace('exit-empty-quote');await type('after-quote');
 await trace('after-quote');
 const prose=await snapshot();
 assert(prose.source.includes('\nafter-quote\n')&&!prose.source.includes('> after-quote'),'Shift-Tab exits an empty quote to an ordinary paragraph');
 results.push({case:'keyboard-list-quote-chain',...prose});await screenshot('keyboard-list-quote');

 await load('> > nested');await startAt('editor.value.length');
 await press('Enter');await confirmed();await press('Tab',8);await confirmed();await type('outer');
 const nested=await snapshot();
 assert.equal(nested.source,'> > nested\n> outer','Shift-Tab exits one level from an empty nested quote');
 results.push({case:'keyboard-nested-prefix-exit',...nested});

 // A real arrow gesture reveals just the opening row; the same behavior is
 // shared by closed code, a bare fence, and a formula block. Initial source
 // and caret are fixture setup; all navigation, edits and IME events below
 // go through the browser's actual input event stream.
 for(const [kind,opening,body,closing] of [
  ['code','``` rust begin','fn main() {}','``` end'],
  ['bare','```','alpha','```'],
  ['empty-code','```','','```'],
  ['math','$$','x + y','$$'],
  ['math-bracket','\\[','x + y','\\]'],
 ]) {
  const source=`before\n\n${opening}\n${body}\n${closing}\n\nafter`;
  const openFrom=source.indexOf(opening),openEnd=openFrom+opening.length,bodyFrom=openEnd+1;
  await load(source);
  if(kind==='code'||kind==='bare') {
   await clickBodyText(body);
   const clicked=await snapshot();assert(clicked.head>=bodyFrom&&clicked.head<=bodyFrom+body.length,kind+': real mouse click enters its first content row');
  } else await startAt(String(bodyFrom+Math.min(2,body.length)));
  await press('ArrowUp');
  let state=await snapshot();
  assert.equal(state.head,openEnd,kind+': first Up reaches the opening source row');
  assert.equal(state.source,source,kind+': navigation leaves source unchanged');
  assert(state.lines.some(line=>line.text===opening&&line.height>0),kind+': opening row is actually visible');
  await press('ArrowUp');state=await snapshot();
  assert.equal(state.head,openFrom-1,kind+': second Up visits the real preceding blank row');
  await press('ArrowDown');state=await snapshot();
  assert(state.head>=bodyFrom&&state.head<=bodyFrom+body.length,kind+': Down enters the first content row directly');
  assert(!state.lines.some(line=>line.text===opening&&line.height>0),kind+': opening hides after leaving');

  if(body.length>0){
   await startAt(String(bodyFrom+Math.min(2,body.length)));await press('ArrowUp',8);
   const range=await c.evaluate('({anchor:view.state.selection.main.anchor,head:view.state.selection.main.head})');
   assert.equal(range.anchor,bodyFrom+Math.min(2,body.length),kind+': Shift-Up preserves source anchor');
   assert.equal(range.head,openEnd,kind+': Shift-Up extends to the opening row');
   state=await snapshot();assert(state.lines.some(line=>line.text===opening&&line.height>0),kind+': selected opening remains visible');
   await press('ArrowDown',8);
   const down=await c.evaluate('({anchor:view.state.selection.main.anchor,head:view.state.selection.main.head})');
   assert.equal(down.anchor,range.anchor,kind+': Shift-Down keeps the original anchor');
   assert(down.head>=bodyFrom&&down.head<=bodyFrom+body.length,kind+': Shift-Down returns to content');
  }
  results.push({case:'opening-navigation-'+kind,...await snapshot()});
 }

 const codeSource='before\n\n``` rust begin\nfn main() {}\n``` end\n\nafter';
 const openFrom=codeSource.indexOf('``` rust begin'),bodyFrom=codeSource.indexOf('fn main()');
 await load(codeSource);await clickBodyText('fn main()');await press('ArrowUp');await press('Home');
 for(let i=0;i<4;i++)await press('ArrowRight');
 assert.equal((await snapshot()).head,openFrom+4,'real arrow keys reach the language token');
 const confirmedBefore=await c.evaluate('editor.confirmedValue');
 await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
 assert.equal(await c.evaluate('editor.confirmedValue'),confirmedBefore,'opening IME candidate is not semantically committed');
 assert(await c.evaluate(`Array.from(view.contentDOM.querySelectorAll('.cm-line')).some(n=>n.textContent.includes('shi')&&n.textContent.includes('\`\`\`')&&n.getBoundingClientRect().height>0)`),'IME candidate and opening syntax share one visible native row');
 await c.command('Input.insertText',{text:'是'});await confirmed();
 assert.equal((await snapshot()).source,codeSource.replace('``` rust','``` 是rust'),'IME commit edits the exact opening language position');
 await press('ArrowUp');assert.equal((await snapshot()).head,openFrom-1,'Up after editing the opener reaches the preceding row');
 await press('z',mod);await confirmed();
 assert.equal((await snapshot()).source,codeSource,'one undo restores the opening after IME');
 results.push({case:'opening-language-ime',...await snapshot()});

 await load(codeSource);await startAt(String(bodyFrom+2));await press('ArrowUp');await press('Home');await press('Delete');await confirmed();
 assert.equal((await snapshot()).source,codeSource.slice(0,openFrom)+codeSource.slice(openFrom+1),'Delete at the exposed opening edits one marker character rather than the whole block');
 await press('z',mod);await confirmed();
 assert.equal((await snapshot()).source,codeSource,'undo restores a changed opening marker and the entire block');
 results.push({case:'opening-marker-delete',...await snapshot()});

 for(const [kind,block,anchor] of [
  ['code','``` js begin\nconst value = 1;\n``` end',"editor.value.indexOf('const value')+6"],
  ['math','$$\nx + y\n$$',"editor.value.indexOf('x + y')+1"],
  ['image','![layout](/pretext-layout.svg)',"editor.value.indexOf('![layout]')+3"],
 ]) {
  await load('intro\n\n'+block+'\n\nending');await startAt(anchor);
  await press('Enter',mod|8);await confirmed();await type('before-'+kind);
  await press('Enter',mod);await confirmed();
  await press('ArrowDown');
  const inside=await snapshot();
  const from=inside.source.indexOf(block);
  assert(inside.head>=from&&inside.head<from+block.length,kind+': Down re-enters the block after creating a preceding paragraph');
  await press('Enter',mod);await confirmed();await type('after-'+kind);
  const state=await snapshot();
  assert(state.source.includes(block),kind+': block syntax and content remain intact');
  assert(state.source.indexOf('before-'+kind)<state.source.indexOf(block)&&state.source.indexOf('after-'+kind)>state.source.indexOf(block)+block.length,kind+': before/after commands produce editable neighboring paragraphs');
  assert(state.caret&&state.caret.top>=state.viewport.top-1&&state.caret.bottom<=state.viewport.bottom+1,kind+': visible native caret after exit');
  results.push({case:'keyboard-exit-'+kind,...state});await screenshot('keyboard-exit-'+kind);
 }

 const table='before\n\n| A | B |\n| --- | --- |\n| one | two |\n\nend';
 await load(table);await startAt("editor.value.indexOf('one')");
 await press('Tab');
 assert.equal((await snapshot()).head,table.indexOf('two'),'Tab visits the next painted cell');
 await press('Enter');await confirmed();await trace('table-enter');
 const enteredCells=await tableCells(),enteredHead=(await snapshot()).head;
 assert.equal(enteredCells.length,4,'Enter paints one new body row');
 assert.equal(enteredCells.at(-1).column,1,'new row retains the same column');
 assert(enteredCells.at(-1).active&&enteredCells.at(-1).from<=enteredHead&&enteredHead<=enteredCells.at(-1).to,'new second cell owns the actual selection before typing');
 await type('DOWN');await trace('table-enter-typed');
 const typedCells=await tableCells();
 assert.deepEqual(typedCells.slice(-2).map(n=>n.text),['','DOWN'],'Enter types into the painted second cell');
 const down=typedCells.at(-1);
 assert(down.width>0&&down.height>0&&down.textLineTops.length>0,'new content has real painted text boxes');
 assert(down.height<=down.lineHeight*down.textLineTops.length+down.verticalChrome+2,'row growth is explained by actual wrapped text, not an extra empty row');
 await press('Tab',8);await type('FIRST');
 await press('Tab');await press('Tab');await confirmed();await type('TAB');
 const tabbedCells=await tableCells(),tabbedHead=(await snapshot()).head;
 assert.deepEqual(tabbedCells.slice(-2).map(n=>n.text),['TAB',''],'Tab from the last cell creates a row and paints its first cell');
 assert(tabbedCells.at(-2).active&&tabbedCells.at(-2).from<=tabbedHead&&tabbedHead<=tabbedCells.at(-2).to,'first cell of the appended row owns the actual selection');
 await press('Enter',mod);await confirmed();await type('outside-table');
 const tableState=await snapshot();
 assert(tableState.source.includes('\noutside-table\n'),'Mod-Enter leaves the whole table');
 assert(await c.evaluate(`document.querySelector('.jot-table-grid-body').textContent.includes('DOWN')&&document.querySelector('.jot-table-grid-body').textContent.includes('TAB')`),'new rows are actually painted');
 results.push({case:'keyboard-table-chain',...tableState,enteredCells,typedCells,tabbedCells});await screenshot('keyboard-table-chain');

 await load(table);await startAt("editor.value.indexOf('one')");
 await c.evaluate(`editor.commands.configureShortcuts({'table.next-cell':'Mod-j'})`);
 try {
  await press('Tab');
  assert.equal((await snapshot()).head,table.indexOf('one'),'the previous Tab binding no longer navigates');
  await press('j',mod);
  assert.equal((await snapshot()).head,table.indexOf('two'),'the configured key navigates the same mapped table surface');
  results.push({case:'keyboard-table-rebinding',...await snapshot()});
 } finally {await c.evaluate('editor.commands.resetShortcuts()');}

 for(const mode of ['source','split']) {
  await c.evaluate(`editor.setMode(${JSON.stringify(mode)})`);await settle();
  const code='``` js begin\nconst retained = 1;\n``` end';
  await load(code);await startAt("editor.value.indexOf('const retained')+5");
  await press('Enter',mod);await confirmed();await type('outside-'+mode);
  assert.equal((await snapshot()).source,code+'\noutside-'+mode,mode+': block exit uses confirmed roots without a Live Preview projection');
  results.push({case:'keyboard-exit-'+mode,...await snapshot()});
 }
 await c.evaluate("editor.setMode('live-preview')");await settle();
}
