# 投影、虚拟布局与滚动

## 哪一层负责高度

- Preview 通过虚拟列表保留未挂载内容的高度。根块、表格行、引用或长代码的子内容有各自的投影窗口。窗口由滚动和容器几何决定。
- Live Preview 的段落、标题、引用和代码主要由 CodeMirror 的原生物理行贡献高度。表格、块公式等替换部件需要有界的额外几何估算。再给已存在的物理行垫一份高度会把滚动范围算大。
- PreText 是项目内的排版估算模块。它用字体、宽度、语义内容和共享指标估算未挂载内容，实际 DOM 测量后再校正。表格走共享列宽策略并限制采样。图片尺寸未知时先占位，宿主可提前返回内在尺寸。

[Preview 宿主](../../packages/editor/src/hosts/preview/surface.ts) · [即时预览估算](../../packages/editor/src/hosts/live-preview/pretext-estimator.ts) · [PreText 配置](../../packages/editor/src/layout/pretext/options.ts)

## 哪些更新会挪动内容

字体、容器宽度、列宽和图片加载都会使估算失效。修改时先判断滚动来自用户、布局变化还是编辑器程序跳转。用户拖动滚动条时，频繁把视口拉回旧锚点会和拖动冲突。折叠、跳转和浏览器测量也可能依次移动可见区域，自动化点击需要先确认目标在最终坐标上。

投影窗口也有两种边界。协议的 `around-range` 围绕范围起点取有限数量的块。整屏缺块时用已确认的根块索引算出首末位置，再请求缺失索引区间。前半屏出现渲染并不能证明后半屏拥有投影。[根窗口计算](../../packages/editor/src/hosts/live-preview/projection-window.ts) · [滚动条实现](../../packages/editor/src/layout/direct-scrollbar.ts)

变更几何时从 `EditorLayoutStyle` 写入共享指标，再验证实际 DOM。涉及样式覆盖先读[主题与布局](../guides/theming.md)，涉及空白、抖动或长文显示先读[回归排查](regressions.md)。
