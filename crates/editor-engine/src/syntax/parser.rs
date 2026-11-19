//! 完整解析入口，统一建立文档根及块序列。

use editor_protocol::TextRange;

use crate::text::TextBuffer;

use super::{
    CompiledSyntaxProfile, NodeId, NodeKind, SyntaxNode, SyntaxSnapshot, block,
    tree::NodeIdAllocator,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    DocumentTooLarge,
    InvalidParserState,
}

/// 对整个文档执行一次完整解析，并创建统一的 Document 根节点。
pub fn parse(
    text: &TextBuffer,
    profile: &CompiledSyntaxProfile,
) -> Result<SyntaxSnapshot, ParseError> {
    // 每次完整解析都从 1 开始分配节点 ID，0 专门保留给文档根节点。
    let mut ids = NodeIdAllocator::new();
    // 块解析器先识别标题、段落、列表等块，再递归解析块内的行和内联内容。
    let blocks = block::parse_blocks(text, profile, &mut ids)?;
    let root = SyntaxNode {
        id: NodeId(0),
        kind: NodeKind::Document,
        source_range: TextRange::new(0, text.utf16_len()),
        children: blocks.roots,
        content_version: 0,
    };
    Ok(SyntaxSnapshot::new(root, blocks.nodes))
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DocumentTooLarge => formatter.write_str("document is too large"),
            Self::InvalidParserState => formatter.write_str("invalid parser state or range"),
        }
    }
}

impl std::error::Error for ParseError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_parse_always_produces_a_document_root() {
        let text = TextBuffer::from_source("hello");
        let profile = CompiledSyntaxProfile::compile(Default::default());
        let syntax = parse(&text, &profile).unwrap();
        assert_eq!(syntax.root().kind, NodeKind::Document);
        assert_eq!(syntax.root().source_range, TextRange::new(0, 5));
    }
}
