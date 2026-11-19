use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock};
use crate::syntax::{
    NodeKind, ParseError, SyntaxNode,
    inline::{self, InlineLine},
    tree::NodeIdAllocator,
};

pub(super) fn parse(
    context: &BlockContext<'_>,
    consumed_lines: usize,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let lines = &context.lines[context.line_index..context.line_index + consumed_lines];
    let first = lines.first().ok_or(ParseError::InvalidParserState)?;
    let last = lines.last().ok_or(ParseError::InvalidParserState)?;
    let range = TextRange::new(first.start_utf16, last.end_utf16);
    let root_id = ids.allocate();
    let inline_lines: Vec<_> = lines
        .iter()
        .map(|line| InlineLine {
            text: line.text(),
            start_utf16: line.start_utf16,
            end_utf16: line.end_utf16,
        })
        .collect();
    let parsed_inline = inline::parse_lines(&inline_lines, ids)?;
    let root = SyntaxNode {
        id: root_id,
        kind: NodeKind::Paragraph,
        source_range: range,
        children: parsed_inline.roots,
        content_version: 0,
    };

    Ok(ParsedBlock {
        root,
        descendants: parsed_inline.nodes,
        consumed_lines,
    })
}
