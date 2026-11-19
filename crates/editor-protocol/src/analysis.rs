use serde::{Deserialize, Serialize};

use crate::{DiagnosticPatch, Revision, SyntaxPatchSummary, TextRange};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AnalysisId(pub String);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisUrgency {
    #[default]
    Interactive,
    Normal,
    Background,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisConsistency {
    #[default]
    AllowPartial,
    RequireComplete,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisPurpose {
    #[default]
    Interactive,
    Preview,
    Export,
    SaveValidation,
    Extension,
    Test,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPriority {
    /// 目标 revision 中的 UTF-16 范围。它们只影响调度；失效范围和 parser 重启
    /// 仍以引擎为准。
    pub priority_ranges: Vec<TextRange>,
    /// 目标 revision 中的 viewport 加 overscan 范围。
    pub visible_ranges: Vec<TextRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_range: Option<TextRange>,
    pub urgency: AnalysisUrgency,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisWorkBudget {
    pub max_source_lines: u32,
    pub max_blocks: u32,
    /// 为能够在单个超大 block 内让出执行权的 parser 保留。
    pub max_utf16_units: u32,
}

impl Default for AnalysisWorkBudget {
    fn default() -> Self {
        Self {
            max_source_lines: 512,
            max_blocks: 128,
            max_utf16_units: 65_536,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRequest {
    pub priority: AnalysisPriority,
    pub consistency: AnalysisConsistency,
    pub purpose: AnalysisPurpose,
    pub initial_budget: AnalysisWorkBudget,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisCancelReason {
    Requested,
    Superseded,
    DocumentClosed,
    GenerationChanged,
    ResourceLimit,
    EngineShutdown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AnalysisFailureCode {
    InvalidPriority,
    ParseFailed,
    ResourceLimit,
    Cancelled,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFailure {
    pub code: AnalysisFailureCode,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AnalysisState {
    Pending {
        analysis_id: AnalysisId,
        target_revision: Revision,
        sequence: u32,
        confirmed_ranges: Vec<TextRange>,
        dirty_ranges: Vec<TextRange>,
    },
    Complete {
        analysis_id: AnalysisId,
        target_revision: Revision,
        sequence: u32,
        confirmed_range: TextRange,
        total_blocks: u32,
    },
    Cancelled {
        analysis_id: AnalysisId,
        target_revision: Revision,
        sequence: u32,
        reason: AnalysisCancelReason,
    },
    Failed {
        analysis_id: AnalysisId,
        target_revision: Revision,
        sequence: u32,
        failure: AnalysisFailure,
        dirty_ranges: Vec<TextRange>,
    },
}

impl AnalysisState {
    pub fn complete(
        analysis_id: AnalysisId,
        target_revision: Revision,
        confirmed_range: TextRange,
        total_blocks: u32,
    ) -> Self {
        Self::Complete {
            analysis_id,
            target_revision,
            sequence: 0,
            confirmed_range,
            total_blocks,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMetrics {
    pub processed_source_lines: u32,
    pub processed_blocks: u32,
    pub processed_utf16_units: u32,
    pub elapsed_micros: u32,
    pub yielded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisUpdate {
    pub analysis_id: AnalysisId,
    pub target_revision: Revision,
    /// 在一个 analysisId 内单调递增。前端忽略重复值，发现缺口时请求 status 恢复。
    pub sequence: u32,
    pub confirmed_ranges: Vec<TextRange>,
    pub dirty_ranges: Vec<TextRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub syntax: Option<SyntaxPatchSummary>,
    #[serde(default)]
    pub diagnostics: DiagnosticPatch,
    pub metrics: AnalysisMetrics,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_request_is_bounded_and_allows_partial_results() {
        let request = AnalysisRequest::default();
        assert_eq!(request.consistency, AnalysisConsistency::AllowPartial);
        assert!(request.initial_budget.max_source_lines > 0);
        assert!(request.initial_budget.max_blocks > 0);
    }
}
