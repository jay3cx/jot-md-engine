# 项目编码约定

## 让读者找到入口

同一文件一般按模块说明、导入、相关类型和常量、入口、内部帮助函数的顺序组织。本地测试在文件末尾。类和 `impl` 按使用顺序组织公开方法，把处理同一状态的私有方法放在一起。静态初始化或注册有先后要求时，按实际依赖排序，并在入口旁说明原因。

Rust 导入按标准库、外部 crate、当前 crate 或相邻模块分组。TypeScript 先写外部包，再写工作区和本地模块。跨文件的类型导入使用 `import type` 或内联 `type`。分组用于看清依赖方向。同一个功能的入口和只服务它的辅助函数可以相邻。

## 注释写行为约束

用中文说明函数何时调用、范围使用什么单位、失败后哪些状态有效，或为什么必须按某个顺序执行。公开入口优先说明调用者需要知道的边界。内部变量用准确名称，简单 getter 和直白转换通常由代码表达。测试命名描述可观察的结果。代码下注释与测试分别说明原因和验证结果。

## 项目的检查

- Rust 使用工作区的 `rustfmt.toml`。运行 `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings` 和 `cargo test --workspace`。
- TypeScript 使用 ESM 和工作区的严格类型配置。本地模块的导入路径带编译产物后缀 `.js`。先运行 `pnpm run build:protocol`，再运行 `pnpm run typecheck` 与 `pnpm run test:ts`。后者也检查组件模块的依赖方向。当前 TypeScript 没有独立的格式化器或 ESLint 配置，改动处保持相邻代码的缩进和排版。
- 跨 Rust/Worker/UI 的改动按 [协议](../architecture/protocol.md) 核对范围、版本和消息两端。渲染几何改动按 [布局](../architecture/virtual-layout.md) 同时核对 DOM 和估算路径。
