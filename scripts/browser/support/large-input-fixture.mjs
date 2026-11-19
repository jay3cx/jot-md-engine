// 两组浏览器测试使用同一份文档，输入量及内容可以逐字节比较。
export function largeInputFixture(bytesTarget, { inlineTask = false, fenceCompat = false } = {}) {
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#678"/></svg>').toString('base64');
  const prose = '中文与 emoji 😀 的一段文字，用于检测源码、视口和真实组件之间的同步。 ';
  let source = '';
  let sourceBytes = 0;
  let sections = 0;
  while (sourceBytes < bytesTarget) {
    const id = String(sections++).padStart(5, '0');
    const extra = inlineTask ? `- [ ] TASK_${id}\n\n~~STRIKE_${id}~~ \\~literal\\~ <https://example.invalid/a_~~b~~>\n` : '';
    const opening = fenceCompat ? '```rust' : '``` rust begin';
    const closing = fenceCompat ? '```' : '``` end';
    const chunk = `# SECTION_${id}\n\n${prose.repeat(3)} **BOLD_${id}** and [link](https://example.invalid/).\n\n![IMG_${id}](${image})\n\n| Column | ID |\n| --- | --- |\n| TABLE_${id} | value |\n\n- LIST_${id}\n- second item\n${extra}\n> QUOTE_${id}\n\n${opening}\nlet CODE_${id} = 1;\n${closing}\n\n$$\nx + y\n$$\n\n`;
    source += chunk;
    sourceBytes += Buffer.byteLength(chunk, 'utf8');
  }
  source += 'FINAL_SENTINEL';
  return { source, sections };
}
