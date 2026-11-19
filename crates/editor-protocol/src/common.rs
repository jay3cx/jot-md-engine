use serde::{Deserialize, Serialize};

/// 当前请求/响应协议的版本号。
pub const PROTOCOL_VERSION: u16 = 1;
pub const FRONTEND_REQUEST_ID_MAX: u32 = 0x7fff_ffff;
pub const WORKER_REQUEST_ID_MIN: u32 = 0x8000_0000;
pub const WORKER_REQUEST_ID_MAX: u32 = u32::MAX;

/// 文档在宿主和引擎之间使用的稳定标识。
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(pub String);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TransactionId(pub String);

/// 文档内容的单调递增版本号，用于拒绝基于旧内容的事务。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revision(pub u32);

impl Revision {
    /// 尝试生成下一个版本；溢出时返回 `None`。
    pub fn checked_next(self) -> Option<Self> {
        self.0.checked_add(1).map(Self)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    /// 文档全局 UTF-16 code unit 偏移，包含起点。
    pub from: u32,
    /// 文档全局 UTF-16 code unit 偏移，不包含终点。
    pub to: u32,
}

impl TextRange {
    pub fn new(from: u32, to: u32) -> Self {
        Self { from, to }
    }

    pub fn is_ordered(self) -> bool {
        self.from <= self.to
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConcreteEolKind {
    Lf,
    Crlf,
    Cr,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceLineEnding {
    Lf,
    Crlf,
    Cr,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionVersion {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxProfile {
    pub id: String,
    pub version: u32,
    #[serde(default)]
    pub enabled_extensions: Vec<ExtensionVersion>,
}

impl Default for SyntaxProfile {
    fn default() -> Self {
        Self {
            id: "safe-markdown".to_owned(),
            version: 1,
            enabled_extensions: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_range_is_half_open_and_ordered() {
        assert!(TextRange::new(3, 3).is_ordered());
        assert!(TextRange::new(3, 4).is_ordered());
        assert!(!TextRange::new(4, 3).is_ordered());
    }

    #[test]
    fn revision_increment_is_checked() {
        assert_eq!(Revision(41).checked_next(), Some(Revision(42)));
        assert_eq!(Revision(u32::MAX).checked_next(), None);
    }
}
