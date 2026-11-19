use editor_protocol::{DocumentId, Revision, SourceLineEnding};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextSnapshot {
    pub document_id: DocumentId,
    pub revision: Revision,
    /// 内部已规范化为 LF 的 Unicode 文本。编码和原子文件 I/O 属于桌面适配器，
    /// 不属于引擎。
    pub text: String,
    pub line_endings: Vec<SourceLineEnding>,
}
