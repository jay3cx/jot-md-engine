//! 前端/Worker/Wasm 边界之间交换的稳定数据。
//!
//! 本 crate 只包含数据。解析、渲染、DOM、文件系统和应用服务逻辑不属于这里。

mod analysis;
mod common;
mod diagnostic;
mod error;
mod projection;
mod request;
mod response;
mod transaction;

pub use analysis::*;
pub use common::*;
pub use diagnostic::*;
pub use error::*;
pub use projection::*;
pub use request::*;
pub use response::*;
pub use transaction::*;
