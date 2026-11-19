# Table 组件

Table 是 Markdown 管道表格的唯一组件包。它从同一个 TableComponentModel
装配布局、PreText、Preview DOM、Live Preview 交互和统一 command，不在不同
宿主中复制表格 renderer。

## 目录职责

- model.ts：把 Rust RenderNode 转为稳定组件模型；
- layout.ts：列宽、容器宽度、用户固定列和 Rust 布局证据；
- pretext.ts：有界行采样与表格高度估算；
- source.ts：command 的源码编辑变换，以及 RenderNode 尚未加载时的保守边界降级；
- commands.ts：增删行列、清空 cell、Tab 导航等无 DOM command；
- toolbar.ts：把按钮转发到同一个 TableCommandExecutor；
- adapters/interaction.ts：消费已加载的 Rust table/row/cell sourceRange，定位
  cell 和 protected surface；
- adapters/projection.ts：声明 table 详情投影预算；
- adapters/preview.ts：TableGrid、二维行窗口、列窗口和列宽拖拽；
- adapters/live-preview.ts：只生成一个 table-root widget 描述；
- adapters/dom.ts：Preview 与 Live Preview 共用的 row/cell DOM 契约。

## 关键不变式

1. Table 的语义来自 Rust RenderNode；source.ts 不能升级普通 pipe 文本为 table。
2. Preview 和 Live Preview 都通过 RenderRuntime 挂载 TableGrid。
3. Live Preview 不创建 row widget、divider widget、逐 cell input 或第二份文本状态；宿主级共享瞬态 IME
   surface 只能承接未提交 composition。
   表格根 widget 使用 `selection: "mapped"`，因此 CodeMirror 的 selection 可以
   落在 Rust 返回的 cell sourceRange 内，TableGrid 只把它投影成 active 样式。
4. cell 的 active 状态是 CodeMirror selection 的投影，不是组件内部状态。
5. 文本改动必须走 CodeMirror transaction、EditorDocumentSession 和 Rust。
6. 未加载、过期、重叠或无法安全定位的范围必须回退源码。

## 局部更新边界

列操作在同一个已确认表格内重写各行。事务保留逐行范围和换行，实现整列一次撤销；
事务内只请求一次表格根的投影，所需行列再由视口按新列数加载。光标目标从重写后的
活动行直接计算，避免生成新全文再扫描表格找回选区。

TableGrid 的更新边界不能由 table root 的 `contentVersion` 单独决定：Rust 会在一个
cell 文本改动时递增 table、row、cell 的版本，这是**内容确认**，不是“整张表
重新布局”的信号。

| 更新类型 | 判定 | 必须保留 | 允许改变 |
| --- | --- | --- | --- |
| cell 内容 | row/cell 内容版本改变 | table root DOM、TableGrid、列宽、row VirtualAxis、未受影响行的测量与 DOM、横向 scroll anchor | 已挂载的目标 row/cell 子树与实际行高；live 宽度策略的后续测量 |
| 源码位置平移 | 未改内容但前方文本导致 sourceRange 同长度移动 | 上述全部，以及现有 cell DOM | 仅重基 subtree 的 `data-jot-source-from/to` 锚点 |
| 增删正文行 | 正文行数变化 | 现有列宽与未受影响的 keyed DOM | 垂直虚拟轴、可视行和实际高度 |
| 列几何 | 表头列数、对齐、显式列宽或容器上下文变化 | 能按稳定 key 复用的 DOM 和用户 pin 宽度 | 列窗口、auto-width、受影响行的换行与高度 |

具体规则：

- `tableLayoutEvidenceKey()` 的数值变化（例如某个 cell 的字符数、列需求权重）不能让
  `autoWidth: "stable"` 重新打开列宽收敛；否则一个字符会清空 intrinsic cache、重测所有可见
  row，并引发整表换行/高度跳动。
- 列数由 Rust 确认的表头和分隔行决定。超列正文行留在源码中，不由挂载中的行改变表格宽度。
- `autoWidth: "live"` 可以在目标 row DOM 已局部更新后重新测量，但必须从当前列宽开始；
  测量结果没有实质宽度变化时不得重新调度 row 窗口。
- 表格 root widget 声明 `inPlaceUpdate`。对已挂载 table，PreText 的新估高只用于离屏/
  首次挂载，不能因 cell 编辑重置 CodeMirror 已实测的 block HeightMap；最终高度继续由
  `ResizeObserver → requestMeasure()` 校正。
- sparse projection 暂时缺少某个 cell 时代表“未知”而非删除。已挂载 row 必须保留同列的
  已确认 cell shell，等待 row/cell slice 返回，不能闪成 empty cell。
- 列宽首轮测量、横向窗口移动可以不改变 row 的内容版本。表头仍必须协调当前列索引、
  cell 宽度和前后 spacer，不能让旧估宽的 spacer 撑大表格或遮住末列。
- content 模式的外壳宽度由列轴决定。工具条按这个宽度换行，不能用按钮的固有总宽度
  反向撑大只剩一两列的外壳；工具条换行后的实际高度由宿主测量，并让后续块正常下移。

这个边界同时适用于 Preview 与 Live Preview，因为两者共用同一个 `TableGrid`。

## 命令入口

`commands.ts` 定义行列操作和单元格导航。工具条与快捷键都调用同一组命令，更新通过 CodeMirror 事务进入会话。宿主可以在 `surface.table` 配置列宽策略，或者调用编辑器的表格布局方法读取和修改列宽。
