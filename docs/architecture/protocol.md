# 主线程、Worker 与 Wasm 的通信

当前通信协议为 `1`。Rust 的 `editor-protocol` 定义线上字段，TypeScript 的 `@jot-md/editor-protocol` 提供对应类型。组件、Worker 和 Wasm 随同一版本构建。普通接入可以直接用 `MarkdownEditor`，自行发送消息时才需要处理下面的边界。[Rust 协议](../../crates/editor-protocol/src/lib.rs) · [TypeScript 协议](../../packages/editor-protocol/src/index.ts)

## 一次请求

```json
{
  "protocolVersion": 1,
  "requestId": 1,
  "generation": 1,
  "body": {
    "type": "handshake",
    "clientName": "example",
    "clientVersion": "0.1.0"
  }
}
```

响应包含同一个 `requestId` 和 `generation`。握手返回 `engineVersion` 与 `capabilities`。文档操作还需要 `documentId`，由宿主指定。`generation` 区分先后两次打开的文档实例，`revision` 标记同一实例内已经确认的内容版本。主线程请求使用低半区 ID，Worker 后台分析使用高半区，从 `0x80000000` 开始。

| 请求体的 `type` | 对应响应 | 作用 |
| --- | --- | --- |
| `handshake` | `handshake-ack` | 查询引擎版本与能力 |
| `open-document` | `document-opened` | 提交原始 Unicode 文本和语法配置，取得起始 revision、长度及分析状态 |
| `apply-transaction` | `transaction-committed` | 按 `baseRevision` 应用整笔修改，返回文档补丁。可在同一请求指定提交后的投影 |
| `project` | `projection-ready` | 请求指定范围或子节点窗口的渲染数据 |
| `get-snapshot` | `snapshot-ready` | 读取指定 revision 的文本及逐行换行信息 |
| `schedule-analysis`、`reprioritize-analysis`、`process-analysis-queue`、`cancel-analysis`、`get-analysis-status` | `analysis-state-changed` | 创建、调整、推进或取消分析，以及查询状态 |
| `close-document` | `document-closed` | 释放指定实例 |

失败时统一返回 `failure`。`error.code` 可用于区分协议不符、文档已关闭、版本不符、范围无效等情况。`error.recoverable` 描述出错性质，版本冲突还可带期望和实际 revision。上层应先核对文档实例与请求归属，再处理响应。[请求结构](../../crates/editor-protocol/src/request.rs) · [响应结构](../../crates/editor-protocol/src/response.rs)

## 编辑坐标

所有文本范围都是 LF 归一化文档中的 UTF-16 半开区间 `[from, to)`。例如 `A😀B` 的长度是 4，把 emoji 换成 `好` 的范围是 `[1, 3)`。端点不能切开代理对。`open-document` 接受 LF、CRLF 和 CR，Rust 单独保留各行的原始换行信息。

一笔事务中的 `edits` 按起点升序排列、互不重叠，全部以同一 `baseRevision` 为坐标。各次插入的 `insert` 只能包含 LF 换行。事务还可以记录编辑来源、选区和历史意图。Rust 要么接受整笔事务并返回新 revision，要么返回错误。前端收到确认前显示的是当前输入值。

## 异步分析与视口

编辑确认和语法解析分开。Worker 可以先返回本次修改的结果，再按预算推进后台分析。`pending` 的 `confirmedRanges` 列出已确认的范围，`complete` 表示当前 revision 的分析已完成。取消或失败也有单独状态。可见区提示能调整分析优先级，文本变更的实际影响范围由引擎计算。

前端按视口请求根块、表格行列、长代码块或引用的局部内容。投影只代表请求的窗口。尚未载入的节点仍属于文档。源码型渲染节点携带源文范围，前端从本地文本取值。应用补丁时要同时检查文档实例、内容版本和投影窗口，滚动前发出的旧请求不能覆盖用户已经到达的新位置。[投影类型](../../crates/editor-protocol/src/projection.rs)
