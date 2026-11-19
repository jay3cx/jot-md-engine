use serde::{Deserialize, Serialize};

use crate::Revision;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ProtocolMismatch,
    MissingDocumentId,
    DocumentNotOpen,
    GenerationMismatch,
    RevisionMismatch,
    RevisionOverflow,
    InvalidTransaction,
    InvalidRange,
    InvalidAnalysisHint,
    AnalysisNotFound,
    AnalysisStale,
    AnalysisFailed,
    ResourceLimit,
    UnsupportedRequest,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<Revision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_revision: Option<Revision>,
    pub recoverable: bool,
}
