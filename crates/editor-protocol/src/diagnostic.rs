use serde::{Deserialize, Serialize};

use crate::TextRange;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub id: String,
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub source_range: TextRange,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPatch {
    pub removed_ids: Vec<String>,
    pub upserted: Vec<Diagnostic>,
}
