# editor-protocol

编辑器的 Rust 通信类型。前端、Worker 和 Wasm 宿主使用同一套请求和响应，握手和消息信封的协议版本均为 1。源码位置以 UTF-16 代码单元计数，范围使用左闭右开的 `[from, to)`。

| 文件 | 内容 |
| --- | --- |
| `src/request.rs`、`src/response.rs` | 消息信封和命令，包括握手、打开文档、提交事务、投影、快照和分析。 |
| `src/common.rs`、`src/error.rs` | 协议版本、请求 ID 范围、文档标识、修订号、语法配置和错误码。 |
| `src/transaction.rs` | 文本替换、选区、换行策略和编辑意图。 |
| `src/analysis.rs` | 分析预算、优先范围、进度和取消原因。 |
| `src/projection.rs`、`src/diagnostic.rs` | 窗口请求、渲染节点、文档补丁和诊断数据结构。 |
| `tests/wire_shape.rs` | 检查序列化后的字段名、消息标签、可选字段和协议版本。 |

修改消息字段时需同时核对 TypeScript 类型。源码仓库的 `packages/editor-protocol/` 保存 TypeScript 类型，`docs/architecture/protocol.md` 说明两端使用的消息格式。

```sh
cargo test -p editor-protocol
```
