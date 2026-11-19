# 从输入到确认后的渲染

## 编辑同步

CodeMirror 持有用户当前编辑的文本、选区、输入法状态和撤销历史。适配层持有 Worker 已确认的文本及 `revision`。即时预览用 CodeMirror 的 decoration 和挂载部件显示已有语义。输入法候选留在 CodeMirror，确认后才发送编辑。没有新树的这段时间，可以借助 ChangeSet 映射仍可靠的行样式和已知容器边界。改到结构标记或无法证明范围有效时，等 Rust 确认。[源码宿主](../../packages/editor/src/hosts/source/index.ts) · [即时预览入口](../../packages/editor/src/hosts/live-preview/controller.ts)

编辑意图经过 `EditorTransactionCoordinator` 串行处理。CodeMirror 在等待回包时把后续修改合并为一个 ChangeSet。轮到这一批时，若已确认正文仍等于 ChangeSet 的起点，就用它的改动范围。起点已变化时，从最新已确认正文与本批目标正文重新计算差异。命令构建后也会核对版本，避免用旧坐标修改当前正文。[输入同步](../../packages/editor/src/hosts/source/codemirror-source.ts) · [事务协调器](../../packages/editor/src/adapter/transaction-coordinator.ts)

回包按请求号路由，正文确认还会核对事务号和基础修订。确认回包推进已确认正文，仍在等待提交的输入留在 CodeMirror。普通输入事务失败时会报错并恢复已确认正文，若 Worker 已终止，会话会上报错误。解析和投影回包受文档修订约束，旧结果无法覆盖当前修订的预览。[消息会话](../../packages/editor/src/adapter/session.ts) · [已确认正文](../../packages/editor/src/adapter/document-adapter.ts) · [延迟回包的浏览器用例](../../scripts/browser/layout/editor-structural-stability-browser.mjs)

## Rust 先确认文本，再按预算推进解析

Wasm Host 用文档 ID 和 `generation` 区分实例，再把请求交给 `EditorDocument`。编辑和投影使用半开 UTF-16 范围。Rust 在访问字节切片前检查边界，Rope 保存已规范化的换行，快照另带逐行换行记录。事务基于当前 `revision`，提交后递增版本。后台解析更新还受 `analysisId` 和 `sequence` 约束，同一修订可以收到多个解析版本。[文档入口](../../crates/editor-engine/src/document/mod.rs) · [协议](protocol.md)

同一物理行的局部编辑，在结构边界明确时可重解析一个 owner。等长替换可以不访问未变后缀；长度变化需要重基后续绝对范围，内容没改的节点可保留 ID 和内容版本。遇到列表续行、围栏闭合、表格列数等可能改变相邻块归属的编辑，局部路径会让出，改从可信的块边界解析。后台任务按行、块和 UTF-16 预算推进，确认前缀之外的脏区用源码显示。[局部改写](../../crates/editor-engine/src/syntax/local_rewrite.rs) · [增量解析](../../crates/editor-engine/src/syntax/incremental.rs) · [解析会话](../../crates/editor-engine/src/syntax/analysis.rs)

## 投影是有版本的窗口

Rust 返回当前窗口需要的节点、属性、范围和补丁。适配层按父节点和轴保存稀疏片段。收到迟到消息时核对文档实例、请求和版本。root、表格行、引用物理行和长围栏内容按实际可见范围取数据。浅层投影可以给出一个节点的概要，已有且仍有效的子窗口可以继续使用。[投影实现](../../crates/editor-engine/src/projection/mod.rs) · [即时预览如何补齐窗口](../../packages/editor/src/hosts/live-preview/projection-window.ts)

修改语法时用同一串编辑比较增量结果与重新解析。修改即时预览时同时检查输入后的第一帧、Worker 确认后的视图、撤销和实际光标位置。[测试入口](../contributing/development.md) · [回归排查](regressions.md)
