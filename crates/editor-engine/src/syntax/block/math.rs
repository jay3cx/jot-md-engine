use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock};
use crate::syntax::{MathDelimiter, NodeKind, ParseError, SyntaxNode, tree::NodeIdAllocator};

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    opening(context.current_line().text())
        .is_some_and(|delimiter| context.math_closer_index(&delimiter).is_some())
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let first = context.current_line();
    let delimiter = opening(first.text()).ok_or(ParseError::InvalidParserState)?;
    let closing_index = context
        .math_closer_index(&delimiter)
        .ok_or(ParseError::InvalidParserState)?;

    let content_start = context
        .line(context.line_index + 1)
        .map_or(first.end_utf16, |line| line.start_utf16);
    let last_index = closing_index;
    let last = context
        .line(last_index)
        .ok_or(ParseError::InvalidParserState)?;
    let content_end = match closing_index {
        index if index > context.line_index + 1 => {
            context
                .line(index - 1)
                .ok_or(ParseError::InvalidParserState)?
                .end_utf16
        }
        _ => content_start,
    };
    let end = last.end_utf16;

    Ok(ParsedBlock {
        root: SyntaxNode {
            id: ids.allocate(),
            kind: NodeKind::MathBlock {
                delimiter,
                opening_range: TextRange::new(first.start_utf16, first.end_utf16),
                content_range: TextRange::new(content_start, content_end),
                closing_range: Some(TextRange::new(last.start_utf16, last.end_utf16)),
                closed: true,
            },
            source_range: TextRange::new(first.start_utf16, end),
            children: Vec::new(),
            content_version: 0,
        },
        descendants: Vec::new(),
        consumed_lines: last_index - context.line_index + 1,
    })
}

pub(crate) fn opening(line: &str) -> Option<MathDelimiter> {
    match standalone(line)? {
        "$$" => Some(MathDelimiter::Dollar),
        "\\[" => Some(MathDelimiter::Bracket),
        _ => None,
    }
}

pub(crate) fn is_closing(line: &str, delimiter: &MathDelimiter) -> bool {
    matches!(
        (standalone(line), delimiter),
        (Some("$$"), MathDelimiter::Dollar) | (Some("\\]"), MathDelimiter::Bracket)
    )
}

fn standalone(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    Some(line[spaces..].trim_end_matches([' ', '\t']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_markers_must_occupy_the_line() {
        assert_eq!(opening(" $$  "), Some(MathDelimiter::Dollar));
        assert_eq!(opening("\\["), Some(MathDelimiter::Bracket));
        assert!(opening("$$ x").is_none());
        assert!(!is_closing("\\] text", &MathDelimiter::Bracket));
    }
}
