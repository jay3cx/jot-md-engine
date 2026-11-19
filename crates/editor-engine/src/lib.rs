//! 文档的文本、修订号和语法树由 `EditorDocument` 管理。宿主通过事务修改文本，
//! 通过投影读取当前修订中需要显示的节点。

pub mod document;
pub mod position;
pub mod projection;
pub mod snapshot;
pub mod syntax;
pub mod text;
mod transaction;

pub use document::{EditorDocument, EngineError, SyntaxState};
