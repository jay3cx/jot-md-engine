# 离屏高度估算

块还没挂载时，Preview 和 Live Preview 需要一个初始高度来建立滚动范围。`filter.ts` 根据 Rust 节点、可用宽度和字体参数估算高度。`text-layout.ts` 缓存字素测量与换行结果，长文本和大表格分别采用有界采样。节点可见后，由宿主用真实 DOM 尺寸修正估算及滚动锚点。

表格的采样规则在 `components/table/pretext.ts`。`resolveImageMetadata` 可以提供图片尺寸或宽高比，首次加载前没有这些数据时，使用配置的占位高度。

`style-metrics.ts` 把行高、内边距、边框等布局参数写入共享 CSS 变量。改变行高或间距时同步更新估算参数，替换外部字体后通知编辑器重新测量。根列表项的尾部间距已计入 `blockGap`，重复添加会让长列表的滚动范围偏大。
