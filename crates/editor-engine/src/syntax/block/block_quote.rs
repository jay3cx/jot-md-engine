use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock, parse_line_views};
use crate::{
    position::utf16_len,
    syntax::{NodeKind, ParseError, SyntaxNode, tree::NodeIdAllocator},
};

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    marker_end(context.current_line().text()).is_some()
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let first = context.current_line();
    let mut cursor = context.line_index;
    let mut views = Vec::new();
    while let Some(line) = context.line(cursor) {
        let Some(start) = marker_end(line.text()) else {
            break;
        };
        let prefix = &line.text()[..start];
        let start_utf16 = line
            .start_utf16
            .checked_add(utf16_len(prefix).map_err(|_| ParseError::DocumentTooLarge)?)
            .ok_or(ParseError::DocumentTooLarge)?;
        views.push(
            line.view_from(start, start_utf16)
                .ok_or(ParseError::InvalidParserState)?,
        );
        cursor += 1;
    }
    let parsed = parse_line_views(&views, context._profile, ids)?;
    let end = context
        .line(cursor - 1)
        .ok_or(ParseError::InvalidParserState)?
        .end_utf16;
    Ok(ParsedBlock {
        root: SyntaxNode {
            id: ids.allocate(),
            kind: NodeKind::BlockQuote,
            source_range: TextRange::new(first.start_utf16, end),
            children: parsed.roots,
            content_version: 0,
        },
        descendants: parsed.nodes,
        consumed_lines: cursor - context.line_index,
    })
}

pub(super) fn marker_end(line: &str) -> Option<usize> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 || line.as_bytes().get(spaces) != Some(&b'>') {
        return None;
    }
    let after = spaces + 1;
    Some(after + usize::from(matches!(line.as_bytes().get(after), Some(b' ' | b'\t'))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_up_to_three_spaces_and_optional_padding() {
        assert_eq!(marker_end("  > quoted"), Some(4));
        assert_eq!(marker_end(">quoted"), Some(1));
        assert_eq!(marker_end("    > no"), None);
    }
}
