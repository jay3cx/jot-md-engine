// A stable, mixed workload for the Demo. The generator varies the order and
// amount of ordinary prose while keeping every structural example reproducible.
const TARGET_BYTES = 1_048_576;
const encoder = new TextEncoder();
const fence = "```";

export function mixedLargeSample(): string {
  let seed = 0x5a17c9e3;
  const random = (limit: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const opening = `# 大文本

这份混合文档包含不同层级的标题、列表、引用、表格、代码、公式、图片与图表，可以滚动、搜索、折叠和直接编辑。
图片使用 Demo 的本地资源；图表由可选的 Mermaid 插件渲染。每次加载得到相同内容，便于复现问题。

## 基础结构与交互

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

普通文字包含中文、English、العربية、עברית、emoji 😀 和组合字符 é；**加粗**、*斜体*、~~删除线~~、~~*嵌套斜体*~~、\`行内代码\` 与 $E = mc^2$ 可以分别编辑。
单个 ~ 与 \\~转义波浪号\\~ 保持原样；\\~~转义开头~~ 和未闭合的 ~~删除标记也是边界例子。

[带括号的链接](https://example.com/a_(b))、<https://example.com/a_~~b~~> 和 <reader@example.com>，旁边是 [未完成链接]( 与普通括号。

- 首个字可使用中文输入法
- [ ] 待办事项
- [x] 已完成的事项
  - 二级列表
    - [ ] 三级任务
      - 四级列表
1. 有序项目
2. 继续下一项
- 跨行列表第一行  
  跨行列表第二行

> 状态：上层引用。
> >>>
> >>>>适用范围：**多层引用**、\`TableGrid\` 和中文输入。
> >>>>>>七层引用用于检查深层边线和缩进。
>    > 带空格的二层引用。
>     > 前缀后四个空格使这里的大于号保留为文字。
> > - [ ] 引用中的任务
> > 引用内的空行、缩进和后续正文。
> 回到第一层。

> > 引用中的代码：
> > ${fence} ts
> > > 保留这个属于代码内容的大于号
> > const quoted = "中文";
> > ${fence}
> 引用代码后的正文。

| 名称 | 对齐 | 说明 |
| :--- | :---: | ---: |
| 普通单元格 | 中间 | 右侧 |
| 空值 |  | 可在空单元格中编辑 |
| 转义 \\| 管道 | \`a | b\` | 中文与 emoji 😀 |
| 不齐的短行 | 只有两列 |
| 比较长的内容用于检查换行与列宽 | 中 | 42 |

## 较长的表格

| 序号 | 名称 | 备注 |
| --- | --- | --- |
${Array.from({ length: 120 }, (_, index) => `| ${index + 1} | 表格记录 ${index + 1} | ${index % 7 === 0 ? "较长的中文与 emoji 😀 用于检查列宽和换行。" : "可在滚动后编辑"} |`).join("\n")}

表格结束后是普通正文。

${fence} rust begin
fn main() {
    println!("Hello, Jot! 中文输入");
}
${fence} end

${fence} ts
const longLine = "${"中文 abc ".repeat(48)}"; // 横向滚动或自动换行
const next = 2;
${fence}

${fence} ts begin
${Array.from({ length: 160 }, (_, index) => `const codeLine${index + 1} = "第 ${index + 1} 行：中文 😀";`).join("\n")}
${fence} end

${fence}
裸围栏：编辑这一行时仍属于同一个代码块。
${fence}

$$
\\frac{a^2+b^2}{c}=x
$$

无法渲染的公式也应保留可编辑源码：$\\jotUnknownCommand{x}$。

![布局示意图](./pretext-layout.svg)

图片前后保留真实空行，点击空行时可观察图片和相邻正文的位置。

> 引用中的图片：![引用示意图](./pretext-layout.svg)
> 图片后的引用文字。

${fence} mermaid
flowchart LR
  S[Markdown 源码] -->|解析| E[语法树]
  E --> D[可见范围的投影]
  D --> Q[编辑器预览]
${fence}

${fence}mermaid
gantt
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section 项目
  设计与准备 :2026-11-02, 3d
  研发与验证 :2026-11-05, 5d
${fence}

### 图表后的正文

有空格与无空格的语言标记都用于检查 Demo 的兼容配置；后面的正文不能被代码块吞入。

${fence}rust begin
无空格的显式 begin 不构成代码块。
${fence}end

这些无效标记后仍是普通正文；#后面缺少空格也不是标题。

### 超长单行

单行开始 ${"长行内容包含中文、English、emoji 😀、数字 12345 和空格；滚动或编辑时应保持源码完整。 ".repeat(400)}单行结束

`;
  // Put unmatched, otherwise valid openers only at EOF, after every matching
  // closer in the generated document. Their following text stays editable.
  const ending = `## 未闭合标记与文档结尾

${fence} rust begin
未出现对应的结束行时，这里仍是普通内容。

### 未闭合围栏后仍可识别的标题

\\[
x + y

长文档结束。
`;
  const paragraphs = [
    "这一段记录了一个普通的编辑过程：先整理内容，再检查位置、换行、撤销和重新输入。中文、English 与 emoji 😀 混排时，文本范围仍应保持准确。",
    "文档可能包含短句，也可能有连续的长句。窗口变窄、字体改变或滚动回到先前位置时，希望看到的仍是相同内容和稳定的光标。",
    "一个段落中的 **重点**、*提示*、~~旧描述~~ 与 [参考链接](https://example.com/a_(b)) 交替出现；使用搜索和替换时可以检查实际源码。",
    "记录顺序不影响语义：表格的列、列表的层级、引用的边框和代码的行号，都应该在各自的区域内完成布局与编辑。",
  ];
  const parts = [opening];
  let bytes = encoder.encode(opening).length + encoder.encode(ending).length;
  for (let section = 1; bytes < TARGET_BYTES; section += 1) {
    const id = String(section).padStart(4, "0");
    const prose = Array.from({ length: 6 + random(5) }, () => {
      const text = paragraphs[random(paragraphs.length)]!;
      return `${text} ${text}\n`;
    }).join("\n");
    const blocks = [
      `- 列表 ${id}：第一项\n  - 第二层\n    - [ ] 待办 ${id}\n    - [x] 已完成 ${id}\n1. 有序项目 ${id}\n2. 后续项目`,
      `> 引用 ${id}：第一层\n> >>>\n> >>>>深层 **内容 ${id}** 与 \`行内代码\`。\n> > - [ ] 引用任务 ${id}\n> 返回第一层。`,
      `| 名称 | 状态 | 备注 |\n| :--- | :---: | ---: |\n| 记录 ${id} | 待处理 | ${random(1000)} |\n| 含 \\| 分隔符 | \`a | b\` | 可编辑 |\n| 空单元格 |  | 结束 |`,
      `${fence} ts\nconst item${section} = "中文 😀 ${id}";\nconst length${section} = item${section}.length;\n${fence}`,
      `行内格式 ${id}：**加粗**、*斜体*、~~删除线~~、\\~转义\\~、[链接](https://example.com/a_(b))、<reader@example.com> 与 $x_${section} + y = 1$。`,
      `$$\na_${section} + b_${section} = c_${section}\n$$`,
    ];
    // Fisher-Yates with a fixed seed gives a mixed but repeatable document.
    for (let index = blocks.length - 1; index > 0; index -= 1) {
      const other = random(index + 1);
      [blocks[index], blocks[other]] = [blocks[other]!, blocks[index]!];
    }
    if (section % 12 === 0) blocks.splice(random(blocks.length + 1), 0,
      `图片 ${id}：\n\n![布局示意图 ${id}](./pretext-layout.svg)\n\n图片后留有空行和普通段落。`);
    if (section % 24 === 0) blocks.splice(random(blocks.length + 1), 0,
      `${fence} mermaid\nflowchart LR\n  A${section}[开始 ${id}] --> B${section}[结束 ${id}]\n${fence}`);
    const chunk = `## 混合记录 ${id}\n\n${prose}\n${blocks.join("\n\n")}\n\n`;
    parts.push(chunk);
    bytes += encoder.encode(chunk).length;
  }
  parts.push(ending);
  return parts.join("");
}
