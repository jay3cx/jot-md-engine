import assert from 'node:assert/strict';

// These checks deliberately hold real platform composition open. A correct
// final projection alone cannot detect a broken candidate-time input surface.
export async function runImeShellScenarios({c,load,settle,confirmed,screenshot,results}) {
  const mod = await c.evaluate('/Mac|iPhone|iPad/.test(navigator.platform)') ? 4 : 2;
  async function inspect() {
    return c.evaluate(`(() => ({
      confirmed:editor.confirmedValue,source:editor.value,revision:Number(editor.revision),
      lines:[...view.contentDOM.querySelectorAll('.cm-line')].map(line => {
        const box=line.getBoundingClientRect(),style=getComputedStyle(line);
        return {text:line.textContent,className:line.className,top:box.top,height:box.height,
          marker:line.getAttribute('data-jot-live-list-marker'),number:line.getAttribute('data-jot-line-number'),
          font:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,
          markerPaint:getComputedStyle(line,'::before').content};
      })
    }))()`);
  }
  async function undo() {
    await c.command('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:mod,windowsVirtualKeyCode:90});
    await c.command('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:mod,windowsVirtualKeyCode:90});
    await confirmed();
  }
  for (const [name,body,needle] of [
    ['bullet','- 阅读文档','阅读'],
    ['ordered','12. 阅读文档','阅读'],
    ['nested','    - 阅读文档','阅读'],
    ['quoted-list','> - 阅读文档','阅读'],
    ['fence-start','``` rust begin\nfn main() {\nprintln!("Hello, Jot!");\n}\n``` end','println!'],
    ['fence-middle','``` rust begin\nfn main() {\nprintln!("Hello, Jot!");\n}\n``` end','Hello'],
  ]) {
    console.log('[ime-shell] '+name);
    const source='intro\n\n'+body+'\n\nTAIL_ANCHOR';
    const from=source.indexOf(needle);
    await load(source);
    await c.evaluate(`editor.input.setSelection(${from});editor.focus()`);
    await settle();
    const before=await inspect(), phases=[];
    const target=before.lines.findIndex(line=>line.text.includes(needle));
    if(name.startsWith('fence')) assert.deepEqual(before.lines.filter(line=>line.number!==null).map(line=>line.number),['1','2','3'],name+': baseline numbered body');
    const record={case:'ime-shell-'+name,before,phases};results.push(record);
    for(const candidate of ['s','shi','shishi']) {
      await c.command('Input.imeSetComposition',{text:candidate,selectionStart:candidate.length,selectionEnd:candidate.length});
      await settle();
      const state=await inspect();phases.push(state);
      await screenshot('ime-shell-'+name+'-'+candidate);
      assert.equal(state.confirmed,source,name+': candidate stays unconfirmed');
      assert.equal(state.revision,before.revision,name+': candidate must not create revisions');
      assert(state.source.includes(candidate),name+': native candidate is visible in the CM document');
      assert.equal(state.lines.length,before.lines.length,name+': native line count');
      for(let i=0;i<state.lines.length;i++) {
        assert.equal(state.lines[i].font,before.lines[i].font,name+': stable font on row '+i);
        assert.equal(state.lines[i].fontSize,before.lines[i].fontSize,name+': stable font size on row '+i);
        assert.equal(state.lines[i].lineHeight,before.lines[i].lineHeight,name+': stable line height on row '+i);
        assert(Math.abs(state.lines[i].top-before.lines[i].top)<1,name+': stable row geometry '+i);
      }
      if(name.startsWith('fence')) {
        assert.deepEqual(state.lines.map(line=>line.number),before.lines.map(line=>line.number),name+': every code row keeps its number');
        assert.deepEqual(state.lines.map(line=>line.className),before.lines.map(line=>line.className),name+': code remains one styled editing surface');
        assert(!state.lines.some(line=>line.text.includes('```')),name+': fence syntax stays hidden');
      } else {
        assert.equal(state.lines[target].marker,before.lines[target].marker,name+': visual marker survives');
        assert(!/^\s*(?:[-+*]|\d+[.)])\s/u.test(state.lines[target].text),name+': raw Markdown marker must stay hidden during composition');
      }
    }
    await c.command('Input.insertText',{text:'是'});await confirmed();
    const committed=await inspect();record.committed=committed;
    assert.equal(committed.confirmed,source.slice(0,from)+'是'+source.slice(from),name+': exact composition commit');
    assert.equal(committed.revision,before.revision+1,name+': one semantic transaction');
    await undo();record.restored=await inspect();
    assert.equal(record.restored.confirmed,source,name+': undo restores source');
  }
  const source='- 阅读文档';
  await load(source);await c.evaluate('editor.input.setSelection(2);editor.focus()');await settle();
  const before=await inspect();
  await c.command('Input.imeSetComposition',{text:'shi',selectionStart:3,selectionEnd:3});await settle();
  await c.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle();
  const cancelled=await inspect();
  assert.equal(cancelled.source,source,'cancelled candidate restores the native source');
  assert.equal(cancelled.confirmed,source,'cancelled candidate leaves confirmed text unchanged');
  assert.equal(cancelled.revision,before.revision,'cancellation creates no semantic revision');
  assert(!cancelled.lines.some(line=>/^\s*-\s/u.test(line.text)),'cancelled candidate keeps the raw prefix hidden');
  results.push({case:'ime-shell-cancellation',before,cancelled});
}
