# editor-engine

`EditorDocument` 保存 Markdown 源码、修订号和语法树。宿主向它提交文本事务，也可以按可见区域索取渲染节点。引擎可以在本机独立运行。

## 从哪里读

| 目录 | 内容 |
| --- | --- |
| `src/document/` | 打开文档、提交事务、查询快照和投影。分析状态记录了当前修订中已经解析的范围。 |
| `src/text/`、`src/position/` | 用 Rope 保存文本，维护原始换行符，校验 UTF-16 坐标。 |
| `src/transaction/` | 分析任务队列，包括优先级调整、取消和分批处理。 |
| `src/syntax/block/`、`src/syntax/inline/` | 块级规则按优先级匹配。行内规则处理强调、链接、转义、代码和数学公式等。 |
| `src/syntax/` | 语法树、内置语法配置、完整解析、局部重解析和分批分析。一次编辑可能改变相邻块的归属，增量解析会在块边界重新检查。 |
| `src/projection/` | 根据文档修订和请求窗口，返回语法子节点、源码行、引用行或标题对应的章节范围。 |
| `src/snapshot/` | 一次文档修订的文本及逐行换行符。 |
| `src/bin/md-inspect.rs` | 命令行查看指定 Markdown 文件的语法树和分析进度。 |

正文范围使用 UTF-16 半开区间。编辑时，文档先核对事务的基准修订。调用方可以要求同步完成解析，也可以提供初始预算，随后继续处理剩余内容。源码仓库的 `docs/guides/markdown.md` 列出了语法示例，`docs/architecture/protocol.md` 说明请求和响应的格式。

## 测试

`cargo test -p editor-engine` 运行模块内的单元测试，以及 `tests/` 中从 crate 接口调用引擎的集成测试。

| 集成测试 | 验证内容 |
| --- | --- |
| `syntax_examples.rs`、`common_syntax.rs` | 块级规则的优先级、行内嵌套、定界符、容器边界和源码范围。 |
| `list_examples.rs`、`list_continuations.rs`、`list_continuation_updates.rs` | 标记、缩进、显式续行，以及编辑后每一行属于哪一项。 |
| `incremental_impacts.rs`、`local_rewrites.rs` | 将增量结果与完整解析逐节点比较，并检查节点 ID、版本和重解析范围。 |
| `document_flow.rs` | 事务、修订、快照和结构变动后的分析结果。 |
| `projection_virtualization.rs` | 按节点或坐标获取局部窗口，核对源码范围、属性和子节点数量。 |
| `manual_inspection.rs`、`fixtures/manual_syntax.md` | 手工查看一次编辑前后的树和补丁。样例供观察，完整的边界用例在上面的自动化测试中。 |
| `common/` | 集成测试共用的断言，比较树的内容、子节点顺序和源码范围。 |

在项目根目录运行以下命令可查看手工样例或检查自己的文档。

```sh
cargo test -p editor-engine --test manual_inspection -- --ignored --nocapture
cargo run -p editor-engine --bin md-inspect -- path/to/example.md
```
