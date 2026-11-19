//! 在已经确定的 block 内容范围内进行 inline 解析。
//!
//! emphasis 和 strong 有意由同一个 delimiter resolver 处理。它们不能作为独立
//! 自动注册的正则规则，因为 `*`、`**` 和 `***` 会竞争同一段 delimiter。

mod atom;
mod emphasis;

use std::ops::Range;

use editor_protocol::TextRange;

use crate::position::utf16_len;

use super::{NodeId, ParseError, SyntaxNode, tree::NodeIdAllocator};

pub(crate) struct ParsedInline {
    pub(crate) roots: Vec<NodeId>,
    pub(crate) nodes: Vec<SyntaxNode>,
}

#[derive(Clone, Copy)]
pub(crate) struct InlineLine<'a> {
    pub(crate) text: &'a str,
    pub(crate) start_utf16: u32,
    pub(crate) end_utf16: u32,
}

struct MappingSegment {
    virtual_bytes: Range<usize>,
    virtual_utf16_start: u32,
    document_range: TextRange,
}

struct Utf16Checkpoint {
    byte: usize,
    utf16: u32,
}

pub(super) struct InlineInput {
    text: String,
    table_cell: bool,
    mappings: Vec<MappingSegment>,
    // Non-ASCII input gets one checkpoint per roughly 256 bytes. Each query
    // scans only the short tail after its checkpoint, including recursive
    // queries that arrive in an arbitrary order. ASCII needs no index.
    utf16_checkpoints: Vec<Utf16Checkpoint>,
}

impl InlineInput {
    fn from_lines(lines: &[InlineLine<'_>]) -> Result<Self, ParseError> {
        let mut text = String::new();
        let mut mappings = Vec::new();
        let mut virtual_utf16 = 0_u32;
        let mut ascii = true;

        for (index, line) in lines.iter().enumerate() {
            let measured = utf16_len(line.text).map_err(|_| ParseError::DocumentTooLarge)?;
            ascii &= measured as usize == line.text.len();
            if line.start_utf16.checked_add(measured) != Some(line.end_utf16) {
                return Err(ParseError::InvalidParserState);
            }
            if index > 0 {
                let newline_start = text.len();
                text.push('\n');
                let previous = lines[index - 1];
                mappings.push(MappingSegment {
                    virtual_bytes: newline_start..newline_start + 1,
                    virtual_utf16_start: virtual_utf16,
                    document_range: TextRange::new(
                        previous.end_utf16,
                        previous
                            .end_utf16
                            .checked_add(1)
                            .ok_or(ParseError::DocumentTooLarge)?,
                    ),
                });
                virtual_utf16 = virtual_utf16
                    .checked_add(1)
                    .ok_or(ParseError::DocumentTooLarge)?;
            }
            if !line.text.is_empty() {
                let start = text.len();
                text.push_str(line.text);
                mappings.push(MappingSegment {
                    virtual_bytes: start..text.len(),
                    virtual_utf16_start: virtual_utf16,
                    document_range: TextRange::new(line.start_utf16, line.end_utf16),
                });
            }
            virtual_utf16 = virtual_utf16
                .checked_add(measured)
                .ok_or(ParseError::DocumentTooLarge)?;
        }

        let mut utf16_checkpoints = Vec::new();
        if !ascii {
            let mut utf16 = 0_u32;
            let mut next_checkpoint = 0;
            for (byte, ch) in text.char_indices() {
                if byte >= next_checkpoint {
                    utf16_checkpoints.push(Utf16Checkpoint { byte, utf16 });
                    next_checkpoint = byte.saturating_add(256);
                }
                utf16 = utf16
                    .checked_add(ch.len_utf16() as u32)
                    .ok_or(ParseError::DocumentTooLarge)?;
            }
        }

        Ok(Self {
            text,
            table_cell: false,
            mappings,
            utf16_checkpoints,
        })
    }

    fn text(&self) -> &str {
        &self.text
    }

    fn text_range(&self, bytes: Range<usize>) -> Result<TextRange, ParseError> {
        if bytes.start > bytes.end || bytes.end > self.text.len() {
            return Err(ParseError::InvalidParserState);
        }
        let from = self.map_start(bytes.start)?;
        let to = self.map_end(bytes.end)?;
        Ok(TextRange::new(from, to))
    }

    fn map_start(&self, byte: usize) -> Result<u32, ParseError> {
        if self.text.is_empty() && byte == 0 {
            return Ok(0);
        }
        let index = self
            .mappings
            .partition_point(|mapping| mapping.virtual_bytes.end <= byte);
        if let Some(mapping) = self.mappings.get(index)
            && byte >= mapping.virtual_bytes.start
        {
            return self.map_within(mapping, byte);
        }
        self.mappings
            .last()
            .filter(|mapping| byte == mapping.virtual_bytes.end)
            .map(|mapping| mapping.document_range.to)
            .ok_or(ParseError::InvalidParserState)
    }

    fn map_end(&self, byte: usize) -> Result<u32, ParseError> {
        if self.text.is_empty() && byte == 0 {
            return Ok(0);
        }
        let index = self
            .mappings
            .partition_point(|mapping| mapping.virtual_bytes.start < byte);
        if let Some(mapping) = index
            .checked_sub(1)
            .and_then(|index| self.mappings.get(index))
            && byte <= mapping.virtual_bytes.end
        {
            return self.map_within(mapping, byte);
        }
        self.mappings
            .first()
            .filter(|mapping| byte == mapping.virtual_bytes.start)
            .map(|mapping| mapping.document_range.from)
            .ok_or(ParseError::InvalidParserState)
    }

    fn map_within(&self, mapping: &MappingSegment, byte: usize) -> Result<u32, ParseError> {
        if !self.text.is_char_boundary(byte) {
            return Err(ParseError::InvalidParserState);
        }
        let virtual_utf16 = if self.utf16_checkpoints.is_empty() {
            u32::try_from(byte).map_err(|_| ParseError::DocumentTooLarge)?
        } else {
            let index = self
                .utf16_checkpoints
                .partition_point(|checkpoint| checkpoint.byte <= byte);
            let checkpoint = &self.utf16_checkpoints[index - 1];
            checkpoint
                .utf16
                .checked_add(
                    utf16_len(&self.text[checkpoint.byte..byte])
                        .map_err(|_| ParseError::DocumentTooLarge)?,
                )
                .ok_or(ParseError::DocumentTooLarge)?
        };
        mapping
            .document_range
            .from
            .checked_add(virtual_utf16 - mapping.virtual_utf16_start)
            .ok_or(ParseError::DocumentTooLarge)
    }
}

pub(crate) fn parse(
    source: &str,
    base_utf16: u32,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    parse_single_line(source, base_utf16, false, ids)
}

pub(crate) fn parse_table_cell(
    source: &str,
    base_utf16: u32,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    parse_single_line(source, base_utf16, true, ids)
}

fn parse_single_line(
    source: &str,
    base_utf16: u32,
    table_cell: bool,
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    // 加入 code span、escape、autolink 和 bracket 构造后，应先识别它们受保护的
    // 结构范围，再运行 emphasis resolver。不要在这里添加独立的“先 strong、
    // 后 emphasis”两轮处理；二者属于同一个 delimiter 算法。
    let end_utf16 = base_utf16
        .checked_add(utf16_len(source).map_err(|_| ParseError::DocumentTooLarge)?)
        .ok_or(ParseError::DocumentTooLarge)?;
    let mut input = InlineInput::from_lines(&[InlineLine {
        text: source,
        start_utf16: base_utf16,
        end_utf16,
    }])?;
    input.table_cell = table_cell;
    emphasis::parse(&input, ids)
}

pub(crate) fn parse_lines(
    lines: &[InlineLine<'_>],
    ids: &mut NodeIdAllocator,
) -> Result<ParsedInline, ParseError> {
    let input = InlineInput::from_lines(lines)?;
    emphasis::parse(&input, ids)
}

#[cfg(test)]
mod tests {
    use std::{hint::black_box, time::Instant};

    use super::*;

    #[test]
    fn ascii_mapping_uses_no_index_and_keeps_both_sides_of_a_line_seam() {
        let input = InlineInput::from_lines(&[
            InlineLine {
                text: "a",
                start_utf16: 10,
                end_utf16: 11,
            },
            InlineLine {
                text: "b",
                start_utf16: 20,
                end_utf16: 21,
            },
        ])
        .unwrap();
        assert!(input.utf16_checkpoints.is_empty());
        assert_eq!(input.text_range(0..1).unwrap(), TextRange::new(10, 11));
        assert_eq!(input.text_range(1..2).unwrap(), TextRange::new(11, 12));
        assert_eq!(input.text_range(2..3).unwrap(), TextRange::new(20, 21));
        assert_eq!(input.map_start(2).unwrap(), 20);
        assert_eq!(input.map_end(2).unwrap(), 12);
    }

    #[test]
    fn mapping_preserves_unicode_and_discontinuous_line_seams() {
        let first = "中文😀 *a* ".repeat(80);
        let last = "[**标签😀**](https://example.test) `代码`".repeat(80);
        let lines = [
            InlineLine {
                text: &first,
                start_utf16: 7,
                end_utf16: 7 + utf16_len(&first).unwrap(),
            },
            InlineLine {
                text: "",
                start_utf16: 2_000,
                end_utf16: 2_000,
            },
            InlineLine {
                text: &last,
                start_utf16: 2_004,
                end_utf16: 2_004 + utf16_len(&last).unwrap(),
            },
        ];
        let input = InlineInput::from_lines(&lines).unwrap();
        assert!(input.utf16_checkpoints.len() <= input.text.len() / 256 + 1);
        let offsets: Vec<_> = input
            .text
            .char_indices()
            .map(|(byte, _)| byte)
            .chain(std::iter::once(input.text.len()))
            .collect();
        // Lookup order is intentionally reversed: recursive inline children
        // can query earlier boundaries after their parent's ending boundary.
        for byte in offsets.into_iter().rev() {
            let expected_start = input
                .mappings
                .iter()
                .find(|mapping| {
                    byte >= mapping.virtual_bytes.start && byte < mapping.virtual_bytes.end
                })
                .map(|mapping| {
                    mapping.document_range.from
                        + utf16_len(&input.text[mapping.virtual_bytes.start..byte]).unwrap()
                })
                .unwrap_or_else(|| input.mappings.last().unwrap().document_range.to);
            let expected_end = input
                .mappings
                .iter()
                .rev()
                .find(|mapping| {
                    byte > mapping.virtual_bytes.start && byte <= mapping.virtual_bytes.end
                })
                .map(|mapping| {
                    mapping.document_range.from
                        + utf16_len(&input.text[mapping.virtual_bytes.start..byte]).unwrap()
                })
                .unwrap_or_else(|| input.mappings.first().unwrap().document_range.from);
            assert_eq!(
                input.map_start(byte).unwrap(),
                expected_start,
                "start byte {byte}"
            );
            assert_eq!(
                input.map_end(byte).unwrap(),
                expected_end,
                "end byte {byte}"
            );
        }
    }

    #[test]
    fn many_unicode_inline_nodes_keep_exact_ranges_and_ids() {
        let unit = "中文😀 `代码` [**标签😀**](https://example.test) $x$ ";
        let source = unit.repeat(1_024);
        let parsed = parse(&source, 103, &mut NodeIdAllocator::new()).unwrap();
        let unit_utf16 = utf16_len(unit).unwrap();
        let code_start = utf16_len(unit.split('`').next().unwrap()).unwrap();
        let code_len = utf16_len("`代码`").unwrap();
        let codes: Vec<_> = parsed
            .nodes
            .iter()
            .filter(|node| matches!(node.kind, super::super::NodeKind::InlineCode { .. }))
            .collect();
        assert_eq!(codes.len(), 1_024);
        for (index, node) in codes.iter().enumerate() {
            let from = 103 + index as u32 * unit_utf16 + code_start;
            assert_eq!(node.source_range, TextRange::new(from, from + code_len));
            let super::super::NodeKind::InlineCode { content_range } = node.kind else {
                unreachable!()
            };
            assert_eq!(content_range, TextRange::new(from + 1, from + code_len - 1));
        }
        let second = parse(&source, 103, &mut NodeIdAllocator::new()).unwrap();
        assert_eq!(parsed.roots, second.roots);
        assert_eq!(parsed.nodes, second.nodes);
    }

    /// Run with `cargo test -p editor-engine --release benchmark_long_inline -- --ignored --nocapture`.
    #[test]
    #[ignore = "manual release timing; no wall-clock threshold in correctness tests"]
    fn benchmark_long_inline() {
        for count in [1_000, 4_000, 8_000] {
            let source = "中文😀 `代码` [**标签😀**](https://example.test) $x$ ".repeat(count);
            let mut elapsed = Vec::new();
            let mut node_count = 0;
            for _ in 0..3 {
                let start = Instant::now();
                let parsed = parse(black_box(&source), 103, &mut NodeIdAllocator::new()).unwrap();
                elapsed.push(start.elapsed());
                node_count = parsed.nodes.len();
                black_box(parsed);
            }
            elapsed.sort();
            println!(
                "inline units={count} bytes={} nodes={node_count} median_ms={:.3}",
                source.len(),
                elapsed[1].as_secs_f64() * 1_000.0
            );
        }
    }
}
