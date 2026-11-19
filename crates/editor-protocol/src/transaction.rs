use serde::{Deserialize, Serialize};

use crate::{AnalysisRequest, ConcreteEolKind, Revision, TextRange, TransactionId};

/// 描述事务产生的用户行为或系统行为，供历史记录和分析调度使用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransactionOrigin {
    Keyboard,
    Ime,
    Paste,
    Drop,
    Undo,
    Redo,
    Api,
    Remote,
    Format,
    Refactor,
    System,
    Import,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryIntent {
    Record {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<String>,
    },
    Isolate,
    Ignore,
}

impl Default for HistoryIntent {
    fn default() -> Self {
        Self::Record { group: None }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionMetadata {
    /// 稳定的语义输入类别，类似编辑器的 user-event 标签。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum NewlinePolicy {
    DocumentDominant { fallback: ConcreteEolKind },
    Configured { eol: ConcreteEolKind },
    NearestLine { fallback: ConcreteEolKind },
}

impl Default for NewlinePolicy {
    fn default() -> Self {
        Self::DocumentDominant {
            fallback: ConcreteEolKind::Lf,
        }
    }
}

/// 一次基于文档旧版本的替换操作；插入文本必须使用 LF 换行。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub range: TextRange,
    /// 内部事务文本，可以包含 LF，但绝不能包含 CR 或 CRLF。
    pub insert: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSelection {
    pub anchor: u32,
    pub head: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTransaction {
    pub id: TransactionId,
    pub base_revision: Revision,
    pub origin: TransactionOrigin,
    /// base revision 中按升序排列且互不重叠的范围。
    pub edits: Vec<TextEdit>,
    pub newline_policy: NewlinePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_before: Option<EditorSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_after: Option<EditorSelection>,
    pub history: HistoryIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<TransactionMetadata>,
    /// 所有范围都属于该事务产生的文档。hint 只改变调度，不能缩小权威失效范围。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<AnalysisRequest>,
}
