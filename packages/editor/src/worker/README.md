# Worker 调度

`bootstrap.ts` 在加载 Wasm 时先缓冲到达的消息。初始化完成后，它创建一个 `WasmEditorHost`，把缓冲的请求交给 `runtime.ts`，再开始接收后续请求。完整的 Worker 入口与应用接入示例见[组件 README](../../README.md)。

`analysis-pump.ts` 每次调度只提交一次 `process-analysis-queue`。返回状态仍为 `pending` 时才安排下一次任务。文档被关闭、会话被替换或分析目标改变后，旧任务的结果不会送回前端。

前端请求编号占用低半区，Worker 后台请求编号占用高半区。发生致命异常时，端点发送 `editor-worker-fatal`，会话会结束所有等待中的请求。
