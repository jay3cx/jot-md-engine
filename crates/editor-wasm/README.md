# editor-wasm

`EditorHost` 按文档 ID 管理引擎实例。每个请求先检查协议版本，需要操作已打开文档的请求还会核对文档代次。宿主随后调用 `EditorDocument`，并在响应中带回请求 ID。

在 `wasm32` 目标上，wasm-bindgen 导出 `WasmEditorHost`。Worker 将请求对象交给同步方法 `handle`，收到当前批次的响应后再安排下一次分析。

```ts
const host = new WasmEditorHost();
const response = host.handle(requestEnvelope);
```

`tests/host_flow.rs` 在本机运行真实的 Rust 宿主，覆盖事务和投影、UTF-16 行范围、分析调度等请求链路。源码仓库的 `docs/architecture/protocol.md` 说明序列化字段和修订号约束。

从项目根目录运行测试或生成演示应用使用的 JavaScript 和 Wasm 绑定。

```sh
cargo test -p editor-wasm
pnpm run wasm:demo
```
