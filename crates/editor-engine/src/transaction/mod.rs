//! 文档的分析任务队列。队列保留任务的修订号，以便丢弃已过期或已取消的工作。

mod queue;

pub(crate) use queue::{AnalysisId, AnalysisQueue};
