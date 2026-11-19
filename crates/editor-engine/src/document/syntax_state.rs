use editor_protocol::{
    AnalysisCancelReason, AnalysisFailure, AnalysisId, AnalysisState, Revision, TextRange,
};

use crate::syntax::SyntaxSnapshot;

/// 从一个精确文本 revision 派生的语法。partial/failed/cancelled 状态绝不会把
/// 前缀快照伪装成完整文档树。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyntaxState {
    Complete {
        revision: Revision,
        analysis_id: AnalysisId,
        sequence: u32,
        snapshot: SyntaxSnapshot,
    },
    Partial {
        revision: Revision,
        analysis_id: AnalysisId,
        sequence: u32,
        prefix: SyntaxSnapshot,
        confirmed_ranges: Vec<TextRange>,
        dirty_ranges: Vec<TextRange>,
    },
    Cancelled {
        revision: Revision,
        analysis_id: AnalysisId,
        sequence: u32,
        prefix: Option<SyntaxSnapshot>,
        dirty_ranges: Vec<TextRange>,
        reason: AnalysisCancelReason,
    },
    Failed {
        revision: Revision,
        analysis_id: AnalysisId,
        sequence: u32,
        prefix: Option<SyntaxSnapshot>,
        dirty_ranges: Vec<TextRange>,
        failure: AnalysisFailure,
    },
}

impl SyntaxState {
    pub fn revision(&self) -> Revision {
        match self {
            Self::Complete { revision, .. }
            | Self::Partial { revision, .. }
            | Self::Cancelled { revision, .. }
            | Self::Failed { revision, .. } => *revision,
        }
    }

    pub fn analysis_id(&self) -> &AnalysisId {
        match self {
            Self::Complete { analysis_id, .. }
            | Self::Partial { analysis_id, .. }
            | Self::Cancelled { analysis_id, .. }
            | Self::Failed { analysis_id, .. } => analysis_id,
        }
    }

    pub fn sequence(&self) -> u32 {
        match self {
            Self::Complete { sequence, .. }
            | Self::Partial { sequence, .. }
            | Self::Cancelled { sequence, .. }
            | Self::Failed { sequence, .. } => *sequence,
        }
    }

    pub fn complete_snapshot(&self) -> Option<&SyntaxSnapshot> {
        match self {
            Self::Complete { snapshot, .. } => Some(snapshot),
            _ => None,
        }
    }

    pub(crate) fn complete_snapshot_mut(&mut self) -> Option<&mut SyntaxSnapshot> {
        match self {
            Self::Complete { snapshot, .. } => Some(snapshot),
            _ => None,
        }
    }

    pub fn protocol_state(&self, document_utf16_len: u32) -> AnalysisState {
        match self {
            Self::Complete {
                revision,
                analysis_id,
                sequence,
                snapshot,
            } => AnalysisState::Complete {
                analysis_id: analysis_id.clone(),
                target_revision: *revision,
                sequence: *sequence,
                confirmed_range: TextRange::new(0, document_utf16_len),
                total_blocks: u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX),
            },
            Self::Partial {
                revision,
                analysis_id,
                sequence,
                confirmed_ranges,
                dirty_ranges,
                ..
            } => AnalysisState::Pending {
                analysis_id: analysis_id.clone(),
                target_revision: *revision,
                sequence: *sequence,
                confirmed_ranges: confirmed_ranges.clone(),
                dirty_ranges: dirty_ranges.clone(),
            },
            Self::Cancelled {
                revision,
                analysis_id,
                sequence,
                reason,
                ..
            } => AnalysisState::Cancelled {
                analysis_id: analysis_id.clone(),
                target_revision: *revision,
                sequence: *sequence,
                reason: *reason,
            },
            Self::Failed {
                revision,
                analysis_id,
                sequence,
                dirty_ranges,
                failure,
                ..
            } => AnalysisState::Failed {
                analysis_id: analysis_id.clone(),
                target_revision: *revision,
                sequence: *sequence,
                failure: failure.clone(),
                dirty_ranges: dirty_ranges.clone(),
            },
        }
    }
}
