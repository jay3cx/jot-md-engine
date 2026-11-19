use serde::{Deserialize, Serialize};

use crate::{
    AnalysisState, AnalysisUpdate, DocumentId, DocumentPatch, ProtocolError, RenderPatch, Revision,
    SourceLineEnding,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub protocol_version: u16,
    pub request_id: u32,
    pub generation: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<DocumentId>,
    pub body: ResponseBody,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ResponseBody {
    HandshakeAck {
        engine_version: String,
        capabilities: Vec<String>,
    },
    DocumentOpened {
        revision: Revision,
        source_utf16_len: u32,
        source_line_count: u32,
        analysis: AnalysisState,
    },
    TransactionCommitted {
        patch: DocumentPatch,
        analysis: AnalysisState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        render_patch: Option<RenderPatch>,
    },
    ProjectionReady {
        patch: RenderPatch,
    },
    SnapshotReady {
        revision: Revision,
        text: String,
        line_endings: Vec<SourceLineEnding>,
    },
    AnalysisStateChanged {
        analysis: AnalysisState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        update: Option<AnalysisUpdate>,
    },
    DocumentClosed,
    Failure {
        error: ProtocolError,
    },
}
