# 源码目录与测试

排查输入法、选区和撤销从源码宿主入手。排查解析结果先用 Rust 重现，再看投影。[编辑流程与模块边界](../architecture/editing-pipeline.md)

## 源码目录

```text
.
├── crates/                            Rust 工作区
│   ├── editor-engine/
│   │   ├── src/
│   │   │   ├── bin/                   md-inspect，读取文件并打印语法树与解析耗时
│   │   │   ├── document/              打开文档、推进版本，协调事务、解析和投影
│   │   │   ├── position/              UTF-16 与 Rust 字节偏移互转，检查字符边界
│   │   │   ├── projection/            把语法树的一段窗口转换成前端渲染补丁
│   │   │   ├── snapshot/              给指定版本的文本及每一行的换行符拍快照
│   │   │   ├── syntax/                解析入口、语法树、增量失效与局部重算
│   │   │   │   ├── block/             段落、标题、列表、表格、引用、围栏和块公式
│   │   │   │   └── inline/            行内格式、链接、图片、代码和公式
│   │   │   ├── text/                  Rope 文本缓冲区与换行符记录
│   │   │   └── transaction/           跟踪分析任务队列及其关联版本、状态
│   │   └── tests/                     从引擎公开接口发起的集成测试
│   │       ├── common/                比较语法树内容、顺序与源码范围，检查重复或不可达节点
│   │       ├── syntax/                完整解析、方言优先级、列表和源码范围
│   │       ├── incremental/           增量解析与整篇重算、节点复用、局部改写
│   │       ├── integration/           文档事务、快照与窗口投影
│   │       └── diagnostics/           按需输出语法树、编辑轨迹和增量场景
│   │           └── fixtures/          供人工排查的 Markdown 样例
│   ├── editor-protocol/
│   │   ├── src/                       请求、响应、范围、分析状态、补丁与错误
│   │   └── tests/                     检查序列化后的字段名、枚举标签和可选字段
│   └── editor-wasm/
│       ├── src/                       导出 Wasm 接口，分派协议请求并管理文档实例
│       └── tests/                     从宿主入口验证握手、事务、投影和错误处理
├── packages/
│   ├── editor-protocol/
│   │   └── src/                       同一套通信协议的 TypeScript 类型与常量
│   └── editor/
│       ├── src/
│       │   ├── adapter/               主线程文档会话、确认文本、事务与投影缓存
│       │   ├── component/             MarkdownEditor 入口、主题、命令面板和改键界面
│       │   ├── components/            各种 Markdown 内容的显示、编辑和命令
│       │   │   ├── closed-container/  闭合代码块与公式块的边界和编辑行为
│       │   │   ├── common/            组件共用的 DOM、源码位置、图片和引用处理
│       │   │   ├── math/              公式显示与 KaTeX 适配
│       │   │   └── table/             单元格编辑、行列命令与列宽
│       │   │       └── adapters/      表格如何接入投影、预布局、预览和即时编辑
│       │   ├── core/
│       │   │   ├── commands/          注册命令、执行命令和匹配快捷键
│       │   │   ├── projection/        筛选和转换可见窗口内的数据
│       │   │   └── virtual/           虚拟滚动轴、折叠轴与 DOM 列表复用
│       │   ├── hosts/
│       │   │   ├── folding/           各视图共享的章节折叠状态
│       │   │   ├── live-preview/      CodeMirror 即时预览、选区、部件和可视窗口
│       │   │   ├── preview/           只读预览与预布局视图
│       │   │   │   └── projection/    按节点类型和子项数量确定预览与预布局请求的投影深度
│       │   │   ├── shared/            多个宿主共用的源码快照
│       │   │   └── source/            CodeMirror 输入、查找和事务同步
│       │   ├── layout/                列表和引用的几何尺寸、滚动条
│       │   │   └── pretext/           根据语义、字体和容器宽度估算排版
│       │   ├── observability/         记录和汇总编辑器操作及各阶段耗时
│       │   ├── plugins/               插件生命周期、Mermaid 与标题折叠
│       │   ├── render/
│       │   │   └── runtime/           根据投影创建、更新和回收 DOM 组件
│       │   └── worker/                初始化 Wasm，转发请求并推进后台解析
│       └── tests/
│           ├── transport/             Worker、会话、事务响应与适配层数据
│           ├── editing/               源码宿主、键盘命令与列表续行
│           ├── views/                 组件、Preview、折叠轴、表格与布局
│           │   ├── live-preview/      即时预览窗口、指针、引用、组件生命周期
│           │   └── fixtures/          多个视图测试共用的投影节点样本
│           ├── plugins/               插件启用、失败与回收
│           ├── telemetry/             操作记录、计时与事务汇总
│           └── browser-support/       浏览器用例所需的 CodeMirror 夹具与跟踪工具
├── apps/
│   └── demo/
│       ├── public/                    示例文档使用的静态图片
│       └── src/                       示例页面、文档样本、Worker 和样式
├── benchmarks/                        生产构建上的浏览器基准和测量说明
│   └── src/                           实际组件宿主、Worker 和页内计时
├── scripts/
│   ├── build/                         编译 Wasm，生成资源及清理包输出
│   ├── release/                       打包并在独立项目试装
│   ├── checks/                        TypeScript 测试发现、组件依赖规则
│   └── browser/                       浏览器套件入口
│       ├── demo/                      Demo 多模式、Mermaid、长混合文档与示例
│       ├── interaction/               输入、命令、插件和章节折叠
│       │   └── scenarios/             键盘、IME、表格删除、空行、内边距与主题场景
│       ├── layout/                    滚动条、行高、表格几何与结构编辑
│       │   └── quote/                 引用行、嵌套层级、选区与导航
│       ├── diagnostics/               长文、长单行、大输入、容量与随机操作
│       └── support/                   Chromium 连接、测试页面与输入载荷
├── .github/
│   └── ISSUE_TEMPLATE/                缺陷报告和功能建议的 GitHub 模板
└── docs/
    ├── guides/                        编辑器配置、Markdown 语法与定制主题
    ├── architecture/                  事务、投影布局、协议与回归记录
    ├── contributing/                  源码树、测试入口和编码约定
    └── assets/                        Jot 标志和技术栈图标
```

开发工具链由 `rust-toolchain.toml` 固定，Rust edition 和最低编译器版本见 `Cargo.toml`，依赖版本见 `Cargo.lock`。前端工作区和命令见 `package.json`、`pnpm-workspace.yaml`。`apps/*/src/generated` 和 `benchmarks/src/generated` 下的 Wasm 绑定由构建命令生成。根目录的 `target`、`dist` 和 `.tmp` 分别存放 Rust 构建产物、网页与报告、临时输出。

## 运行测试

以下命令都在仓库根目录运行。环境安装步骤见[项目首页](../../README.md)。

| 入口 | 检查内容 |
| --- | --- |
| `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings` | Rust 格式和静态检查 |
| `cargo test --workspace` | 模块内的单元测试，以及引擎、协议和 Wasm 宿主的集成测试 |
| `pnpm run build:protocol`，随后 `pnpm run typecheck` | 生成协议包的类型声明，检查两个组件包的 TypeScript 类型 |
| `pnpm run test:ts` | 检查模块依赖边界，在 Node 中验证会话、事务、组件、投影、插件等行为 |
| `pnpm run test:browser` | 真实 Chromium 中的 Demo、键盘、选区、视口、表格、引用、插件与主题交互 |
| `pnpm run package:verify` | 打包并在独立项目安装，检查对外入口、样式、类型、Worker 及 Wasm |
| `pnpm run benchmark` | 测真实浏览器里的可见帧、Rust 文本确认、后台解析和滚动。[基准说明](../../benchmarks/README.md) |

Rust 单元测试位于对应实现的 `#[cfg(test)]` 中，适合检查局部解析和位置边界。`crates/editor-engine/tests/` 从公开接口打开文档、连续应用修改，再检查完整解析与增量解析是否一致，以及未受影响节点、投影窗口是否正确。跨层行为由这一级测试保护。`diagnostics/fixtures/` 里的样例便于查看整棵树，具体语法与容错边界还要看分项断言。协议集成测试关注序列化形状，Wasm 宿主测试关注同一消息在真实分派入口会发生什么。

遇到语法问题，可以把最小示例存为 `example.md`，直接运行 `cargo run -p editor-engine --bin md-inspect -- example.md`。输出包含节点类型、范围、树形关系和解析耗时。

## 定向测试和诊断

Rust 的集成测试可以按目录运行。使用 `cargo test -p editor-engine --test syntax` 检查方言，使用 `--test incremental` 检查增量解析，使用 `--test integration` 检查事务和投影。用 `cargo test -p editor-engine --test diagnostics -- --ignored --nocapture` 打印调试轨迹。容量测量可用 release 模式运行增量套件里的忽略用例。

`pnpm run test:ts` 编译一次，从源码目录发现所有 `*.test.ts`。即时预览的 `*.cases.ts` 由同目录的测试入口调用。浏览器夹具不作为 Node 用例运行。

`pnpm run test:browser` 运行常规套件。仅跑一组时传 `demo`、`interaction`、`layout` 或 `quote`。可以设置 `CHROME_BIN` 指向 Chrome 或 Chromium。浏览器键盘及 IME 自动化只覆盖页面已收到的事件序列。系统占用和候选窗需在对应系统实测。

浏览器套件运行时，先让它跑完再构建同一工作区的协议或 Wasm。开发服务器监听这些产物，重新写入可能在用例中途刷新页面。

### 浏览器分组如何选

| 分组 | 入口包含的脚本与场景 |
| --- | --- |
| `demo` | `browser-smoke` 走生产 Demo 的模式和页面控件，`editor-mermaid-viewport-browser` 分别在开发与生产预览中验证图表可见窗口，`demo-large-mixed-browser` 检查 1 MiB 混合文档的编辑、滚动和折叠。 |
| `interaction` | `editor-interaction-browser` 运行 `scenarios/` 的键位、搜索与导航、IME、结构编辑、列表、表格删除、内边距、空行和主题。插件生命周期与标题折叠各有独立入口。 |
| `layout` | `editor-structural-stability-browser` 对照提交前后的几何，`editor-scrollbar-browser` 检查滚动条与真实视口，`editor-metric-guard-browser` 对照主题后的行高，`editor-boundary-audit-browser` 验证表格、代码等复杂块的边界。 |
| `quote` | `editor-blockquote-browser` 核对嵌套渲染和源码选择，`editor-quote-contract-browser` 核对编辑和定位契约，`editor-quote-navigation-browser` 走逐行导航，`editor-quote-adaptive-browser` 检查随宽度变化的几何。 |

维护脚本时把端口、Chrome 连接和空白示例页留在 `browser/support/`。复用数据载荷时保留生成器与消费端的尺寸断言。表格删除有独立诊断入口，需要大表样本时，准备 Demo 的协议与 Wasm 后可运行 `JOT_TABLE_DELETE_ROWS=2000 node scripts/browser/interaction/scenarios/editor-table-delete-scenarios.mjs`。

### 单独运行诊断

从仓库根目录运行。除大输入对照外，浏览器诊断先运行 `pnpm run build:protocol` 和 `pnpm run wasm:demo`，再用 `node scripts/browser/diagnostics/<文件名>` 运行所需脚本。报告默认写入 `dist/`。

| 文件 | 检查内容 |
| --- | --- |
| `editor-large-document-browser.mjs` | 默认打开 1 MiB、10 MiB 文档，测首屏确认、文尾可见性及 DOM 上限。用 `JOT_LARGE_MIB` 指定大小。 |
| `editor-large-input-contract-browser.mjs` | 大段输入、撤销/重做、多光标、只读和保护范围。 |
| `editor-large-input-scroll-browser.mjs` | 大段输入、滚动和提交后的文本确认。 |
| `editor-large-input-control.mjs` | 同一载荷送到原生可编辑区域、纯 CodeMirror 和一个拦截后写入文本节点的对照。用 `JOT_LARGE_CONTROL_BYTES` 指定字节数。30 秒代表 CDP 命令超时，未读到最终对照文本。Jot 组件的可见、确认和解析耗时由浏览器基准单独测量。 |
| `editor-capacity-audit-browser.mjs` | 用 `JOT_CAPACITY_CASE`、`JOT_CAPACITY_COUNT` 指定场景和规模。打开 `JOT_CAPACITY_LANGUAGE_DIAG=1` 可观察复用片段。 |
| `editor-search-pointer-fuzz.mjs` | 以可重放的随机种子检查搜索、滚动和指针选区。 |
| `editor-single-line-browser.mjs` | 长物理行的输入、定位和可见性。 |

发布前运行 `package:verify`，它调用 `package:pack` 生成 tarball，再通过 `verify-packaged-worker.mjs` 检查安装到外部项目的真实 Worker。
