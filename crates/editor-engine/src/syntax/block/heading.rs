use std::ops::Range;

use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock};
use crate::{
    position::utf16_len,
    syntax::{NodeKind, ParseError, SyntaxNode, inline, tree::NodeIdAllocator},
};

struct HeadingMatch {
    level: u8,
    content_bytes: Range<usize>,
}

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    analyze(context.current_line().text()).is_some()
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let line = context.current_line();
    let heading = analyze(line.text()).ok_or(ParseError::InvalidParserState)?;
    let content_start = line
        .start_utf16
        .checked_add(
            utf16_len(&line.text()[..heading.content_bytes.start])
                .map_err(|_| ParseError::DocumentTooLarge)?,
        )
        .ok_or(ParseError::DocumentTooLarge)?;
    let content = &line.text()[heading.content_bytes];
    let root_id = ids.allocate();
    let parsed_inline = inline::parse(content, content_start, ids)?;
    let root = SyntaxNode {
        id: root_id,
        kind: NodeKind::Heading {
            level: heading.level,
        },
        source_range: TextRange::new(line.start_utf16, line.end_utf16),
        children: parsed_inline.roots,
        content_version: 0,
    };

    Ok(ParsedBlock {
        root,
        descendants: parsed_inline.nodes,
        consumed_lines: 1,
    })
}

fn marker_prefix(line: &str) -> Option<(usize, u8)> {
    let bytes = line.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() && bytes[cursor] == b' ' && cursor < 4 {
        cursor += 1;
    }
    if cursor > 3 || bytes.get(cursor) != Some(&b'#') {
        return None;
    }

    let marker_start = cursor;
    while bytes.get(cursor) == Some(&b'#') {
        cursor += 1;
    }
    let marker_len = cursor - marker_start;
    if !(1..=6).contains(&marker_len) {
        return None;
    }
    if let Some(next) = bytes.get(cursor)
        && !matches!(next, b' ' | b'\t')
    {
        return None;
    }

    Some((cursor, marker_len as u8))
}

/// Editing after the first existing separator cannot change the ATX marker.
/// A bare `#` has no such safe insertion point.
pub(crate) fn safe_content_offset(line: &str) -> Option<u32> {
    let (cursor, _) = marker_prefix(line)?;
    matches!(line.as_bytes().get(cursor), Some(b' ' | b'\t'))
        .then_some(u32::try_from(cursor + 1).ok()?)
}

fn analyze(line: &str) -> Option<HeadingMatch> {
    let bytes = line.as_bytes();
    let (mut cursor, level) = marker_prefix(line)?;

    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    let content_start = cursor;
    let mut content_end = trim_ascii_space_end(bytes, bytes.len()).max(content_start);

    let mut closing_start = content_end;
    while closing_start > content_start && bytes[closing_start - 1] == b'#' {
        closing_start -= 1;
    }
    if closing_start < content_end
        && closing_start > 0
        && matches!(bytes[closing_start - 1], b' ' | b'\t')
    {
        content_end = trim_ascii_space_end(bytes, closing_start - 1).max(content_start);
    }

    Some(HeadingMatch {
        level,
        content_bytes: content_start..content_end,
    })
}

fn trim_ascii_space_end(bytes: &[u8], mut end: usize) -> usize {
    while end > 0 && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_edit_boundary_keeps_the_marker_separator() {
        assert_eq!(safe_content_offset("# title"), Some(2));
        assert_eq!(safe_content_offset("  ###  中文"), Some(6));
        assert_eq!(safe_content_offset("#"), None);
        assert_eq!(safe_content_offset("#not-a-heading"), None);
    }

    fn heading(source: &str) -> Option<(u8, &str)> {
        analyze(source).map(|matched| (matched.level, &source[matched.content_bytes]))
    }

    #[test]
    fn recognizes_atx_headings_and_optional_closing_markers() {
        assert_eq!(heading("# title"), Some((1, "title")));
        assert_eq!(heading("   ### title ###   "), Some((3, "title")));
        assert_eq!(heading("######"), Some((6, "")));
        assert_eq!(heading("# ###"), Some((1, "")));
        assert_eq!(heading("# title#"), Some((1, "title#")));
    }

    #[test]
    fn rejects_missing_separator_excess_markers_and_four_space_indent() {
        assert_eq!(heading("#title"), None);
        assert_eq!(heading("####### title"), None);
        assert_eq!(heading("    # title"), None);
    }
}
