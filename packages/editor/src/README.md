# 浏览器端源码

从 `component/markdown-editor.ts` 可以看到一次编辑的完整路径。CodeMirror 接收按键和输入法事件，`adapter/` 把文本改动送入 Worker，Rust 确认文档版本。宿主据此更新可见节点，保留用户的选区和滚动位置。

```text
src/
├── index.ts                 包入口
├── component/               MarkdownEditor 的生命周期、主题、命令面板和快捷键配置界面
├── adapter/                 会话、串行事务、UTF-16 文本索引和稀疏投影缓存
├── worker/                  Wasm 初始化、请求传递和后台解析调度
├── core/
│   ├── commands/            命令与快捷键注册表
│   ├── projection/          投影的输入输出类型、布局参数和缓存键
│   └── virtual/             逻辑尺寸轴、已挂载节点和滚动锚点
├── components/              内置命令，以及按 Rust 节点类型选择渲染或交互策略的注册表
│   ├── common/              节点到 DOM 的映射、URL 检查、图片尺寸和光标位置换算
│   ├── closed-container/    代码围栏和公式块的边界及编辑规则
│   ├── math/                KaTeX 同步和按需加载入口
│   └── table/               单元格定位、行列命令、列宽和高度估算
│       └── adapters/        把表格模型接入预览、二维虚拟滚动和选区
├── hosts/
│   ├── source/              CodeMirror 输入、查找替换和文本同步
│   ├── live-preview/        原位编辑时的装饰、可视窗口、鼠标、键盘和表格输入法
│   ├── preview/             只读预览、PreText 调试视图和基础样式
│   │   └── projection/      按节点大小确定需要加载几层子节点
│   ├── folding/             标题折叠状态与视图映射
│   └── shared/              按 CodeMirror 不可变文档复用源码快照
├── layout/                  滚动条及引用、列表的显示几何
│   └── pretext/             根据可用宽度、字体、图片尺寸估计节点高度
├── render/
│   └── runtime/             在两种预览中挂载、更新和卸载语义节点
├── plugins/                 插件注册、标题折叠和 Mermaid 图表
└── observability/           按一次编辑汇总输入、协议、解析与布局事件
```

Preview 和 Live Preview 共用渲染器与表格组件。前者拥有独立的滚动容器，后者在 CodeMirror 中挂载组件。两者共享已确认的节点和源码范围，各自管理 DOM 的生命周期。输入按 UTF-16 偏移同步，不能将浏览器光标位置直接当作语法范围。

维护特定行为时可参阅[表格更新规则](components/table/README.md)、[原位编辑与选区](hosts/live-preview/README.md)、[离屏高度估算](layout/pretext/README.md)和 [Worker 调度](worker/README.md)。
