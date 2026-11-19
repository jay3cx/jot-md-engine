use serde::{Deserialize, Serialize};

use crate::{
    AnalysisCancelReason, AnalysisId, AnalysisPriority, AnalysisRequest, AnalysisWorkBudget,
    DocumentId, DocumentTransaction, ProjectionRequest, Revision, SyntaxProfile,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub protocol_version: u16,
    pub request_id: u32,
    /// 每当前端替换或重新打开文档实例时变化。
    pub generation: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<DocumentId>,
    pub body: RequestBody,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RequestBody {
    Handshake {
        client_name: String,
        client_version: String,
    },
    OpenDocument {
        /// 已解码的 Unicode 源码，原始 CR/LF/CRLF 序列仍然存在。
        source: String,
        syntax_profile: SyntaxProfile,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        analysis: Option<AnalysisRequest>,
    },
    ApplyTransaction {
        transaction: DocumentTransaction,
        /// 可选的提交后 projection，针对新 revision 计算。它把常见的
        /// transaction -> 可见渲染往返合并到一次 Wasm 请求，同时不把语法分析与
        /// DOM 细节耦合。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        projection: Option<ProjectionRequest>,
    },
    Project {
        projection: ProjectionRequest,
    },
    GetSnapshot {
        revision: Revision,
    },
    ScheduleAnalysis {
        revision: Revision,
        request: AnalysisRequest,
    },
    ReprioritizeAnalysis {
        revision: Revision,
        analysis_id: AnalysisId,
        priority: AnalysisPriority,
    },
    ProcessAnalysisQueue {
        revision: Revision,
        analysis_id: AnalysisId,
        budget: AnalysisWorkBudget,
    },
    CancelAnalysis {
        revision: Revision,
        analysis_id: AnalysisId,
        reason: AnalysisCancelReason,
    },
    GetAnalysisStatus {
        revision: Revision,
    },
    CloseDocument,
}
