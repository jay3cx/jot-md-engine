# 已修复的回归与复现方法

以下记录来自项目已修复的问题。跟进同类故障时，先记录编辑模式、操作前选区、变化前后的文本和滚动位置。传输相关问题还需记录 `generation`、`revision`、`analysisId` 和 `sequence`。截图配合最短可复制的 Markdown，便于判断是源码、解析还是布局出错。

| 症状 | 已知原因与约束 | 用例 |
| --- | --- | --- |
| 在已有大文档开头插入一整份文本，文字很快出现，语法预览却迟迟不齐 | 解析器曾在每个新块后顺序扫描旧后缀。现在按有序源码坐标二分查找可复用的起点。用相同文本比较按钮插入、粘贴和撤销，再核对确认时的正文与 Rust 快照。 | [Demo 大文档回归](../../scripts/browser/demo/demo-large-mixed-browser.mjs) · [浏览器基准](../../benchmarks/README.md) |
| 列表首字输入法候选期间出现双标记，代码行首输入时行高变了 | 正文变化与隐藏标记相邻。粗粒度失效曾只清走隐藏标记或部分行样式。结构边界仍有效时，沿 ChangeSet 保留输入外壳。跨行或触及结构标记时重新校验。 | [IME 场景](../../scripts/browser/interaction/scenarios/editor-ime-shell-scenarios.mjs) |
| 退一级引用时整块抖动，或空引用输入首字时后续行跳动 | 整个根节点一起丢失结构装饰，或空/非空行仍带旧标识。用例扣住 Worker 回包，断言确认前、确认后和撤销时的几何与源码。改行和没改的行按各自范围映射。 | [结构编辑回归](../../scripts/browser/layout/editor-structural-stability-browser.mjs) |
| 删列后留下大块空白，工具条撑大表格 | 表头占位和列轴不同步，工具条也有固有最小宽度。检查真实列边、占位宽度、工具条换行和撤销。单列表格的工具条可能变高，后续行随真实高度移动。 | [表格删除场景](../../scripts/browser/interaction/scenarios/editor-table-delete-scenarios.mjs) · [越界表格](../../scripts/browser/layout/editor-boundary-audit-browser.mjs) |
| 拖滚动条会被拉回，或长文只有半屏显示格式 | 视口的用户意图被旧语义锚点盖过，或按起点取的固定窗口没有覆盖后半屏。分别录下滚动比例、选区和缺失根块范围，确认补齐目标窗口。 | [滚动条回归](../../scripts/browser/layout/editor-scrollbar-browser.mjs) · [投影窗口用例](../../packages/editor/tests/views/live-preview/live-preview-projection-window.cases.ts) |
| 空行打首字时光标横移，主题切换后行高不齐 | 空行继承了与正文不同的 CodeMirror 默认缩进，或改变的 CSS 没进入高度估算。比较 `getBoundingClientRect()` 和正文、空行、代码行的指标，再复现滚出视口后返回。 | [内边距场景](../../scripts/browser/interaction/scenarios/editor-padding-geometry-scenarios.mjs) · [行高守卫](../../scripts/browser/layout/editor-metric-guard-browser.mjs) |
| 补齐围栏结尾或列表硬换行后，邻块归属不对 | 变更可能影响旧 owner 以外的行。比较完整解析与增量解析的树、范围和未影响节点 ID，再检查后台解析边界。 | [增量解析套件](../../crates/editor-engine/tests/incremental/main.rs) · [事务用例](../../crates/editor-engine/tests/integration/document_flow.rs) |
| 深处标题已挂载，但点击折叠偶尔点到下一行 | 上方虚拟块测量后改变了标题位置。检查目标列的实际命中和同一标题连续帧的坐标。用真实单次点击验证折叠，核对展开前后的 Markdown。 | [1 MiB 混合文档](../../scripts/browser/demo/demo-large-mixed-browser.mjs) |

`pnpm run test:browser interaction` 运行输入、命令和表格互动，`pnpm run test:browser layout` 检查尺寸与滚动，`pnpm run test:browser quote` 检查引用几何和导航。保留测试报告时注明浏览器版本，输入法自动化覆盖的是页面收到的事件序列。[命令和诊断入口](../contributing/development.md)
