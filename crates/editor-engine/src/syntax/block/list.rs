//! 列表项从标记所在的行开始。行尾至少两个空格表示硬换行。只有下一行缩进到
//! 正文列且没有新标记时，才属于同一项。缩进更深的新列表项保留自己的块和缩进列数。

use editor_protocol::TextRange;

use super::{BlockContext, ParsedBlock, SourceLine};
use crate::{
    position::utf16_len,
    syntax::{
        BulletMarker, ListMarker, NodeKind, OrderedDelimiter, ParseError, SyntaxNode, inline,
        tree::NodeIdAllocator,
    },
};

#[derive(Clone, Debug)]
struct MarkerInfo {
    indent_columns: u32,
    content_indent: u32,
    content_start_byte: usize,
    marker: ListMarker,
}

#[derive(Clone, Copy)]
struct Indent {
    bytes: usize,
    columns: u32,
}

pub(super) fn matches(context: &BlockContext<'_>) -> bool {
    analyze_marker(context.current_line().text()).is_some()
}

pub(super) fn parse(
    context: &BlockContext<'_>,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedBlock, ParseError> {
    let line = context.current_line();
    let marker = analyze_marker(line.text()).ok_or(ParseError::InvalidParserState)?;
    let item_id = ids.allocate();
    let mut children = Vec::new();
    let mut descendants = Vec::new();
    let content_start = line
        .start_utf16
        .checked_add(
            utf16_len(&line.text()[..marker.content_start_byte])
                .map_err(|_| ParseError::DocumentTooLarge)?,
        )
        .ok_or(ParseError::DocumentTooLarge)?;
    let first_content = line
        .view_from(marker.content_start_byte, content_start)
        .ok_or(ParseError::InvalidParserState)?;
    let mut contents = vec![first_content];
    let mut last = line;
    let mut consumed_lines = 1;
    while contents
        .last()
        .is_some_and(|content| has_explicit_break(content.text()))
    {
        let Some(next) = context.line(context.line_index + consumed_lines) else {
            break;
        };
        let Some(content) = continuation_view(&next, marker.content_indent)? else {
            break;
        };
        contents.push(content);
        last = next;
        consumed_lines += 1;
    }

    if contents.len() > 1 || !contents[0].is_blank() {
        let paragraph_id = ids.allocate();
        let mut inline_roots = Vec::new();
        let mut inline_nodes = Vec::new();
        for (index, content) in contents.iter().enumerate() {
            let has_next = index + 1 < contents.len();
            let text = if has_next {
                &content.text()[..content.text().len().saturating_sub(2)]
            } else {
                content.text()
            };
            let task = if index == 0 { task_marker(text) } else { None };
            if let Some(checked) = task {
                let id = ids.allocate();
                inline_roots.push(id);
                inline_nodes.push(SyntaxNode {
                    id,
                    kind: NodeKind::TaskMarker { checked },
                    source_range: TextRange::new(content.start_utf16, content.start_utf16 + 3),
                    children: Vec::new(),
                    content_version: 0,
                });
            }
            let skip = if task.is_some() { 3 } else { 0 };
            let parsed = inline::parse(&text[skip..], content.start_utf16 + skip as u32, ids)?;
            inline_roots.extend(parsed.roots);
            inline_nodes.extend(parsed.nodes);
            if has_next {
                let id = ids.allocate();
                inline_roots.push(id);
                inline_nodes.push(SyntaxNode {
                    id,
                    kind: NodeKind::HardBreak,
                    source_range: TextRange::new(
                        content.end_utf16 - 2,
                        content
                            .end_utf16
                            .checked_add(1)
                            .ok_or(ParseError::DocumentTooLarge)?,
                    ),
                    children: Vec::new(),
                    content_version: 0,
                });
            }
        }
        children.push(paragraph_id);
        descendants.push(SyntaxNode {
            id: paragraph_id,
            kind: NodeKind::Paragraph,
            source_range: TextRange::new(content_start, last.end_utf16),
            children: inline_roots,
            content_version: 0,
        });
        descendants.extend(inline_nodes);
    }

    Ok(ParsedBlock {
        root: SyntaxNode {
            id: item_id,
            kind: NodeKind::ListItem {
                marker: marker.marker,
                indent_columns: marker.indent_columns,
            },
            source_range: TextRange::new(context.current_line().start_utf16, last.end_utf16),
            children,
            content_version: 0,
        },
        descendants,
        consumed_lines,
    })
}

fn task_marker(text: &str) -> Option<bool> {
    let bytes = text.as_bytes();
    if bytes.len() < 3
        || bytes[0] != b'['
        || bytes[2] != b']'
        || (bytes.len() > 3 && !matches!(bytes[3], b' ' | b'\t'))
    {
        return None;
    }
    match bytes[1] {
        b' ' | b'\t' => Some(false),
        b'x' | b'X' => Some(true),
        _ => None,
    }
}

pub(crate) fn has_explicit_break(text: &str) -> bool {
    text.ends_with("  ")
}

/// A continuation is an explicitly joined text line, never a nested/new item.
/// Strip the shortest whole-character whitespace prefix reaching the owner's
/// content column; additional whitespace remains part of the inline body.
pub(crate) fn continuation_view(
    line: &SourceLine,
    content_indent: u32,
) -> Result<Option<SourceLine>, ParseError> {
    if analyze_marker(line.text()).is_some() {
        return Ok(None);
    }
    let mut bytes = 0;
    let mut column = 0;
    for ch in line.text().chars() {
        if column >= content_indent {
            break;
        }
        match ch {
            ' ' => column += 1,
            '\t' => column += 4 - column % 4,
            _ => break,
        }
        bytes += ch.len_utf8();
    }
    if column < content_indent {
        return Ok(None);
    }
    let from = line
        .start_utf16
        .checked_add(utf16_len(&line.text()[..bytes]).map_err(|_| ParseError::DocumentTooLarge)?)
        .ok_or(ParseError::DocumentTooLarge)?;
    line.view_from(bytes, from)
        .map(Some)
        .ok_or(ParseError::InvalidParserState)
}

pub(crate) fn marker_content_indent(text: &str) -> Option<u32> {
    analyze_marker(text).map(|marker| marker.content_indent)
}

fn analyze_marker(text: &str) -> Option<MarkerInfo> {
    let indent = leading_indent(text);
    let bytes = text.as_bytes();
    let marker_start = indent.bytes;
    let (marker, marker_end) = match *bytes.get(marker_start)? {
        b'-' | b'+' | b'*' => {
            let marker = match bytes[marker_start] {
                b'-' => BulletMarker::Dash,
                b'+' => BulletMarker::Plus,
                b'*' => BulletMarker::Asterisk,
                _ => unreachable!(),
            };
            (
                ListMarker::Unordered { marker },
                marker_start.checked_add(1)?,
            )
        }
        digit if digit.is_ascii_digit() => {
            let mut end = marker_start;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) && end - marker_start < 9 {
                end += 1;
            }
            if bytes.get(end).is_some_and(u8::is_ascii_digit) {
                return None;
            }
            let delimiter = match bytes.get(end)? {
                b'.' => OrderedDelimiter::Period,
                b')' => OrderedDelimiter::Parenthesis,
                _ => return None,
            };
            let number = text[marker_start..end].parse().ok()?;
            (
                ListMarker::Ordered { number, delimiter },
                end.checked_add(1)?,
            )
        }
        _ => return None,
    };

    if marker_end == bytes.len() {
        let marker_end_column =
            marker_column_width(indent.columns, marker_end.saturating_sub(marker_start));
        return Some(MarkerInfo {
            indent_columns: indent.columns,
            content_indent: marker_end_column.saturating_add(1),
            content_start_byte: marker_end,
            marker,
        });
    }
    if !matches!(bytes[marker_end], b' ' | b'\t') {
        return None;
    }

    let marker_end_column =
        marker_column_width(indent.columns, marker_end.saturating_sub(marker_start));
    let padding = whitespace_run(text, marker_end, marker_end_column);
    let (content_start_byte, padding_columns) = if padding.columns <= 4 {
        (padding.bytes, padding.columns)
    } else {
        let first_end = marker_end + text[marker_end..].chars().next()?.len_utf8();
        let first_padding = columns_between(&text[marker_end..first_end], marker_end_column);
        (first_end, first_padding)
    };

    Some(MarkerInfo {
        indent_columns: indent.columns,
        content_indent: marker_end_column.saturating_add(padding_columns),
        content_start_byte,
        marker,
    })
}

fn leading_indent(text: &str) -> Indent {
    whitespace_run(text, 0, 0)
}

fn whitespace_run(text: &str, start: usize, start_column: u32) -> Indent {
    let mut bytes = start;
    let mut column = start_column;
    for ch in text[start..].chars() {
        match ch {
            ' ' => column += 1,
            '\t' => column += 4 - column % 4,
            _ => break,
        }
        bytes += ch.len_utf8();
    }
    Indent {
        bytes,
        columns: column - start_column,
    }
}

fn columns_between(text: &str, start_column: u32) -> u32 {
    whitespace_run(text, 0, start_column).columns
}

fn marker_column_width(indent: u32, marker_bytes: usize) -> u32 {
    indent.saturating_add(u32::try_from(marker_bytes).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::super::BlockIndex;
    use super::*;
    use crate::{syntax::CompiledSyntaxProfile, text::TextBuffer};

    #[test]
    fn recognizes_arbitrarily_indented_physical_items() {
        assert_eq!(analyze_marker("- item").unwrap().indent_columns, 0);
        assert_eq!(analyze_marker("  42) item").unwrap().indent_columns, 2);
        assert_eq!(analyze_marker("         * deep").unwrap().indent_columns, 9);
        assert!(matches!(
            analyze_marker("42) item").unwrap().marker,
            ListMarker::Ordered {
                number: 42,
                delimiter: OrderedDelimiter::Parenthesis
            }
        ));
    }

    #[test]
    fn parses_exactly_one_source_line() {
        let text = TextBuffer::from_source("- one\n  - two");
        let lines = super::super::source_lines_from_buffer(&text).unwrap();
        let index = BlockIndex::new(&lines);
        let profile = CompiledSyntaxProfile::compile(Default::default());
        let context = BlockContext {
            lines: &lines,
            index: &index,
            _profile: &profile,
            line_index: 0,
        };
        let mut ids = NodeIdAllocator::new();
        let parsed = parse(&context, &mut ids).unwrap();
        assert_eq!(parsed.consumed_lines, 1);
        assert!(matches!(
            parsed.root.kind,
            NodeKind::ListItem {
                indent_columns: 0,
                ..
            }
        ));
    }

    #[test]
    fn rejects_missing_spacing_and_ten_digit_markers() {
        assert!(analyze_marker("-item").is_none());
        assert!(analyze_marker("1234567890. item").is_none());
    }
}
