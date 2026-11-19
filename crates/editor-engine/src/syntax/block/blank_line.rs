use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock};
use crate::syntax::{NodeKind, ParseError, SyntaxNode, tree::NodeIdAllocator};

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let line = context.current_line();
    if !line.is_blank() {
        return Err(ParseError::InvalidParserState);
    }
    Ok(ParsedBlock {
        root: SyntaxNode {
            id: ids.allocate(),
            kind: NodeKind::BlankLine,
            source_range: TextRange::new(line.start_utf16, line.end_utf16),
            children: Vec::new(),
            content_version: 0,
        },
        descendants: Vec::new(),
        consumed_lines: 1,
    })
}
