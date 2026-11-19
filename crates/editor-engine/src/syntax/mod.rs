//! 按语法配置解析 Markdown，生成带有稳定 ID 和 UTF-16 范围的节点。

mod analysis;
pub(crate) mod block;
mod incremental;
mod inline;
mod local_rewrite;
mod parser;
mod profile;
mod tree;

pub use analysis::{AnalysisProgress, SyntaxAnalysisSession, SyntaxCheckpoint, WorkBudget};
pub use incremental::{
    DirtyPlan, DirtyStrategy, InPlaceIncrementalResult, IncrementalResult, plan_dirty_change,
    reparse_change, try_reparse_fast, try_reparse_table_row_window_in_place,
};
pub use local_rewrite::try_reparse_inline_in_place;
pub use parser::{ParseError, parse};
pub use profile::CompiledSyntaxProfile;
pub use tree::{
    BulletMarker, ListMarker, MathDelimiter, NodeId, NodeKind, OrderedDelimiter, SyntaxNode,
    SyntaxSnapshot, TableAlignment,
};
