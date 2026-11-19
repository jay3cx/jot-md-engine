use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock};
use crate::syntax::{NodeKind, ParseError, SyntaxNode, tree::NodeIdAllocator};

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    is_thematic_break(context.current_line().text())
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let line = context.current_line();
    if !is_thematic_break(line.text()) {
        return Err(ParseError::InvalidParserState);
    }
    Ok(ParsedBlock {
        root: SyntaxNode {
            id: ids.allocate(),
            kind: NodeKind::ThematicBreak,
            source_range: TextRange::new(line.start_utf16, line.end_utf16),
            children: Vec::new(),
            content_version: 0,
        },
        descendants: Vec::new(),
        consumed_lines: 1,
    })
}

fn is_thematic_break(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut indent = 0_usize;
    while indent < bytes.len() && indent < 4 && bytes[indent] == b' ' {
        indent += 1;
    }
    if indent > 3 {
        return false;
    }
    let remainder = &text[indent..];
    let marker = remainder.bytes().find(|byte| !matches!(byte, b' ' | b'\t'));
    let Some(marker @ (b'*' | b'-' | b'_')) = marker else {
        return false;
    };
    let mut count = 0;
    for byte in remainder.bytes() {
        if byte == marker {
            count += 1;
        } else if !matches!(byte, b' ' | b'\t') {
            return false;
        }
    }
    count >= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_spaced_markers_but_not_mixed_content() {
        assert!(is_thematic_break("* * *"));
        assert!(is_thematic_break("  ---  "));
        assert!(is_thematic_break("___"));
        assert!(!is_thematic_break("- - item"));
        assert!(!is_thematic_break("**"));
    }
}
