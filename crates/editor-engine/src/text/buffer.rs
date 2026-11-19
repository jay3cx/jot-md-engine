use std::ops::Range;
use std::sync::Arc;

use crop::Rope;
use editor_protocol::{ChangedTextRange, DocumentTransaction, TextRange};

use crate::{document::EngineError, position::utf16_len};

use super::{EolKind, eol::resolve_new_eol};

/// 保存 LF 归一化后的正文，并单独记录每条源代码行的原始换行符。
///
/// Rope 是本模块的私有实现细节。协议、语法树和上层文档只使用 UTF-16
/// 半开区间，不能依赖 Rope 的 byte offset 或 chunk 布局。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextBuffer {
    text: Rope,
    /// 每个源码行对应一个条目；最后一个条目始终是 `None`。
    line_endings: Arc<Vec<EolKind>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextChange {
    pub range: ChangedTextRange,
}

struct ValidatedEdit {
    bytes: Range<usize>,
    insert: String,
}

impl TextBuffer {
    /// 从外部源文本构造缓冲区，同时把 CRLF/CR 归一化为 LF。
    pub fn from_source(source: &str) -> Self {
        let mut text = String::with_capacity(source.len());
        let mut line_endings = Vec::new();
        let mut chars = source.chars().peekable();

        // 遍历源文本时把不同平台的换行形式转换为统一的 LF。
        while let Some(ch) = chars.next() {
            match ch {
                '\r' if chars.peek() == Some(&'\n') => {
                    chars.next();
                    text.push('\n');
                    line_endings.push(EolKind::Crlf);
                }
                '\r' => {
                    text.push('\n');
                    line_endings.push(EolKind::Cr);
                }
                '\n' => {
                    text.push('\n');
                    line_endings.push(EolKind::Lf);
                }
                _ => text.push(ch),
            }
        }
        line_endings.push(EolKind::None);

        Self {
            text: Rope::from(text),
            line_endings: Arc::new(line_endings),
        }
    }

    /// 只为外部 snapshot/export 消费者物化连续字符串。编辑和 projection 热路径
    /// 必须优先使用 `slice`、物理行和 Rope metric，不能反复调用此方法。
    pub fn snapshot(&self) -> String {
        self.text.to_string()
    }

    pub fn utf16_len(&self) -> u32 {
        u32::try_from(self.text.utf16_len())
            .expect("a text buffer cannot exceed the supported u32 document size")
    }

    pub fn line_count(&self) -> u32 {
        u32::try_from(self.line_endings.len()).expect("line count must fit the wire protocol")
    }

    pub fn line_endings(&self) -> &[EolKind] {
        &self.line_endings
    }

    pub fn ends_with_lf(&self) -> bool {
        self.text.byte_len() > 0 && self.text.byte(self.text.byte_len() - 1) == b'\n'
    }

    pub(crate) fn raw_lines(&self) -> impl Iterator<Item = String> + '_ {
        self.text.raw_lines().map(|line| line.to_string())
    }

    /// 返回 `range` 内物理行片段总数以及请求的相对窗口。查找使用 Rope 行 metric，
    /// 不会为被跳过的行分配节点。
    pub fn line_ranges(
        &self,
        range: TextRange,
        from: u32,
        to_exclusive: u32,
    ) -> Result<(u32, Vec<TextRange>), EngineError> {
        let bytes = self.byte_range(range)?;
        if range.from == range.to {
            return Ok((0, Vec::new()));
        }
        let first_line = self.text.line_of_byte(bytes.start);
        let last_line = self.line_of_byte_before(bytes.end);
        let total_usize = last_line - first_line + 1;
        let total = u32::try_from(total_usize).map_err(|_| EngineError::DocumentTooLarge)?;
        let from = from.min(total);
        let to = to_exclusive.min(total).max(from);
        let mut ranges = Vec::with_capacity((to - from) as usize);
        for relative in from as usize..to as usize {
            let line_from = if relative == 0 {
                range.from
            } else {
                self.utf16_of_line(first_line + relative)?
            };
            let line_to = if relative + 1 == total_usize {
                range.to
            } else {
                self.utf16_of_line(first_line + relative + 1)?
            };
            ranges.push(TextRange::new(line_from, line_to));
        }
        Ok((total, ranges))
    }

    pub fn line_index_in_range(
        &self,
        range: TextRange,
        offset: u32,
    ) -> Result<(u32, u32), EngineError> {
        let bytes = self.byte_range(range)?;
        if range.from == range.to {
            return Ok((0, 0));
        }
        let first = self.text.line_of_byte(bytes.start);
        let last = self.line_of_byte_before(bytes.end);
        let total = last - first + 1;
        let absolute = if offset <= range.from {
            first
        } else if offset >= range.to {
            last
        } else {
            self.text.line_of_byte(self.byte_of_utf16(offset)?)
        };
        Ok((
            u32::try_from(total).map_err(|_| EngineError::DocumentTooLarge)?,
            u32::try_from(absolute.saturating_sub(first).min(total - 1))
                .map_err(|_| EngineError::DocumentTooLarge)?,
        ))
    }

    /// 按协议中的 UTF-16 半开区间读取文本。
    pub fn slice(&self, range: TextRange) -> Result<String, EngineError> {
        let bytes = self.byte_range(range)?;
        Ok(self.text.byte_slice(bytes).to_string())
    }

    /// Compare canonical source ranges without allocating contiguous strings.
    pub(crate) fn range_eq(&self, range: TextRange, other: &Self, other_range: TextRange) -> bool {
        let (Ok(left), Ok(right)) = (self.byte_range(range), other.byte_range(other_range)) else {
            return false;
        };
        self.text.byte_slice(left) == other.text.byte_slice(right)
    }

    /// 返回 `range` 触及的完整物理行，不包含最后一行的尾部 LF，并附带绝对 UTF-16
    /// 范围。解析器只需读取这些行，编辑长文档时也无需复制全文。
    pub(crate) fn physical_lines_covering(
        &self,
        range: TextRange,
    ) -> Result<(TextRange, String), EngineError> {
        let bytes = self.byte_range(range)?;
        let first_line = self.text.line_of_byte(bytes.start);
        let line_from = self.text.byte_of_line(first_line.min(self.text.line_len()));
        let line_to = if bytes.end == self.text.byte_len() {
            bytes.end
        } else {
            let last_line = self.text.line_of_byte(bytes.end);
            let raw_end = self
                .text
                .byte_of_line((last_line + 1).min(self.text.line_len()));
            if raw_end > 0 && self.text.byte(raw_end - 1) == b'\n' {
                raw_end - 1
            } else {
                raw_end
            }
        };
        let from_utf16 = u32::try_from(self.text.utf16_code_unit_of_byte(line_from))
            .map_err(|_| EngineError::DocumentTooLarge)?;
        let to_utf16 = u32::try_from(self.text.utf16_code_unit_of_byte(line_to))
            .map_err(|_| EngineError::DocumentTooLarge)?;
        Ok((
            TextRange::new(from_utf16, to_utf16),
            self.text.byte_slice(line_from..line_to).to_string(),
        ))
    }

    /// 校验并按逆序应用事务，保证多个范围不会因前序替换而失效。
    pub fn apply(&mut self, transaction: &DocumentTransaction) -> Result<TextChange, EngineError> {
        let edits = self.validate(transaction)?;
        let first = transaction
            .edits
            .first()
            .ok_or(EngineError::EmptyTransaction)?;
        let last = transaction
            .edits
            .last()
            .ok_or(EngineError::EmptyTransaction)?;

        // 统计所有替换对文档长度的净影响，用于计算变更后的 UTF-16 范围。
        let mut delta_utf16 = 0_i64;
        for edit in &transaction.edits {
            delta_utf16 += i64::from(utf16_len(&edit.insert).map_err(EngineError::from)?)
                - i64::from(edit.range.to - edit.range.from);
        }

        // 从后往前改，前面的替换就不会改变后面编辑的字节位置。
        for edit in edits.into_iter().rev() {
            let insertion_line = self.text.line_of_byte(edit.bytes.start);
            let removed_eols = self
                .text
                .byte_slice(edit.bytes.clone())
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count();
            let inserted_eols = edit.insert.bytes().filter(|byte| *byte == b'\n').count();
            // 新增换行符的具体形式由事务策略决定，正文仍保持 LF。
            let new_eol = if inserted_eols == 0 {
                EolKind::None
            } else {
                resolve_new_eol(
                    &self.line_endings,
                    insertion_line,
                    &transaction.newline_policy,
                )
            };

            // 同时替换正文和换行元数据，保证两者的行数始终一致。
            self.text.replace(edit.bytes, &edit.insert);
            // Ordinary typing changes neither EOL metadata nor its shared
            // snapshot. Avoid cloning the full line vector on that hot path.
            if removed_eols != 0 || inserted_eols != 0 {
                Arc::make_mut(&mut self.line_endings).splice(
                    insertion_line..insertion_line + removed_eols,
                    std::iter::repeat_n(new_eol, inserted_eols),
                );
            }
        }

        debug_assert_eq!(
            self.line_endings.len(),
            self.text.bytes().filter(|byte| *byte == b'\n').count() + 1
        );
        debug_assert_eq!(self.line_endings.last(), Some(&EolKind::None));

        let after_to = i64::from(last.range.to)
            .checked_add(delta_utf16)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(EngineError::DocumentTooLarge)?;

        Ok(TextChange {
            range: ChangedTextRange {
                before: TextRange::new(first.range.from, last.range.to),
                after: TextRange::new(first.range.from, after_to),
            },
        })
    }

    fn validate(
        &self,
        transaction: &DocumentTransaction,
    ) -> Result<Vec<ValidatedEdit>, EngineError> {
        if transaction.edits.is_empty() {
            return Err(EngineError::EmptyTransaction);
        }

        let mut previous_to = 0;
        let mut validated = Vec::with_capacity(transaction.edits.len());
        // 校验阶段只读取旧文本，不修改缓冲区。
        for (index, edit) in transaction.edits.iter().enumerate() {
            // 编辑必须按起点升序排列，且相邻范围不能重叠。
            if !edit.range.is_ordered() || (index > 0 && edit.range.from < previous_to) {
                return Err(EngineError::UnorderedOrOverlappingEdits);
            }
            if edit.insert.contains('\r') {
                return Err(EngineError::NonNormalizedInsert);
            }
            let from = self.byte_of_utf16(edit.range.from)?;
            let to = self.byte_of_utf16(edit.range.to)?;
            validated.push(ValidatedEdit {
                bytes: from..to,
                insert: edit.insert.clone(),
            });
            previous_to = edit.range.to;
        }
        Ok(validated)
    }

    fn byte_range(&self, range: TextRange) -> Result<Range<usize>, EngineError> {
        if !range.is_ordered() {
            return Err(EngineError::InvalidRange);
        }
        Ok(self.byte_of_utf16(range.from)?..self.byte_of_utf16(range.to)?)
    }

    /// 返回非空 UTF-8 范围最后一个字符所在的物理行。
    ///
    /// `bytes.end - 1` 只是“最后一个字节”，并不一定是合法的 UTF-8
    /// 字符边界。中文、emoji 等多字节字符结束后，直接把它交给 Rope
    /// 的 `line_of_byte` 会触发 `crop` 的边界断言。先向左回退到该字符
    /// 的起点，既保持范围的半开语义，也让 Rope 永远只接收合法边界。
    fn line_of_byte_before(&self, byte_end: usize) -> usize {
        let mut byte = byte_end.saturating_sub(1);
        while byte > 0 && !self.text.is_char_boundary(byte) {
            byte -= 1;
        }
        self.text.line_of_byte(byte)
    }

    /// `crop` exposes a fast UTF-16 conversion that panics on a split
    /// surrogate。wire protocol 必须拒绝这种输入，因此先通过单调逆向 metric 定位
    /// 字节边界，再要求它恰好位于 code point 边界后才能使用。
    fn byte_of_utf16(&self, offset: u32) -> Result<usize, EngineError> {
        let target = usize::try_from(offset).map_err(|_| EngineError::DocumentTooLarge)?;
        if target > self.text.utf16_len() {
            return Err(EngineError::InvalidRange);
        }
        let mut low = 0_usize;
        let mut high = self.text.byte_len();
        while high.saturating_sub(low) > 1 {
            let raw_middle = low + (high - low) / 2;
            let mut middle = raw_middle;
            while middle < high && !self.text.is_char_boundary(middle) {
                middle += 1;
            }
            if middle == high {
                middle = raw_middle;
                while middle > low && !self.text.is_char_boundary(middle) {
                    middle -= 1;
                }
                if middle == low {
                    break;
                }
            }
            let actual = self.text.utf16_code_unit_of_byte(middle);
            if actual == target {
                return Ok(middle);
            }
            if actual < target {
                low = middle;
            } else {
                high = middle;
            }
        }
        [low, high]
            .into_iter()
            .find(|byte| self.text.utf16_code_unit_of_byte(*byte) == target)
            .ok_or(EngineError::InvalidRange)
    }

    fn utf16_of_line(&self, line: usize) -> Result<u32, EngineError> {
        let byte = self.text.byte_of_line(line);
        u32::try_from(self.text.utf16_code_unit_of_byte(byte))
            .map_err(|_| EngineError::DocumentTooLarge)
    }
}

#[cfg(test)]
mod tests {
    use editor_protocol::{
        ConcreteEolKind, DocumentTransaction, NewlinePolicy, Revision, TextEdit, TextRange,
        TransactionId, TransactionOrigin,
    };

    use super::*;

    fn transaction(edits: Vec<TextEdit>) -> DocumentTransaction {
        DocumentTransaction {
            id: TransactionId("tx-1".to_owned()),
            base_revision: Revision(0),
            origin: TransactionOrigin::Keyboard,
            edits,
            newline_policy: NewlinePolicy::DocumentDominant {
                fallback: ConcreteEolKind::Lf,
            },
            selection_before: None,
            selection_after: None,
            history: Default::default(),
            metadata: None,
            analysis: None,
        }
    }

    #[test]
    fn normalizes_source_but_preserves_eol_metadata() {
        let buffer = TextBuffer::from_source("a\r\nb\nc\rd");
        assert_eq!(buffer.snapshot(), "a\nb\nc\nd");
        assert_eq!(
            buffer.line_endings(),
            &[EolKind::Crlf, EolKind::Lf, EolKind::Cr, EolKind::None]
        );
    }

    #[test]
    fn applies_utf16_edits_and_keeps_the_final_none_eol() {
        let mut buffer = TextBuffer::from_source("a😀b\r\nc");
        let change = buffer
            .apply(&transaction(vec![TextEdit {
                range: TextRange::new(1, 3),
                insert: "x\ny".to_owned(),
            }]))
            .unwrap();

        assert_eq!(buffer.snapshot(), "ax\nyb\nc");
        assert_eq!(
            buffer.line_endings(),
            &[EolKind::Crlf, EolKind::Crlf, EolKind::None]
        );
        assert_eq!(change.range.before, TextRange::new(1, 3));
        assert_eq!(change.range.after, TextRange::new(1, 4));
        let (total, ranges) = buffer.line_ranges(TextRange::new(1, 7), 1, 3).unwrap();
        assert_eq!(total, 3);
        assert_eq!(ranges, vec![TextRange::new(3, 6), TextRange::new(6, 7)]);
    }

    #[test]
    fn ordinary_typing_shares_eol_metadata_and_newlines_detach_it() {
        let mut buffer = TextBuffer::from_source("a\r\nb\r\nc");
        let before = buffer.clone();
        buffer
            .apply(&transaction(vec![TextEdit {
                range: TextRange::new(1, 1),
                insert: "😀".into(),
            }]))
            .unwrap();
        assert!(Arc::ptr_eq(&before.line_endings, &buffer.line_endings));
        assert_eq!(before.snapshot(), "a\nb\nc");
        buffer
            .apply(&transaction(vec![TextEdit {
                range: TextRange::new(3, 3),
                insert: "\n".into(),
            }]))
            .unwrap();
        assert!(!Arc::ptr_eq(&before.line_endings, &buffer.line_endings));
        assert_eq!(
            buffer.line_endings(),
            &[EolKind::Crlf, EolKind::Crlf, EolKind::Crlf, EolKind::None]
        );
        assert_eq!(
            before.line_endings(),
            &[EolKind::Crlf, EolKind::Crlf, EolKind::None]
        );
    }

    #[test]
    fn line_start_index_survives_multiple_reverse_applied_edits() {
        let mut buffer = TextBuffer::from_source("zero\none\ntwo\nthree");
        buffer
            .apply(&transaction(vec![
                TextEdit {
                    range: TextRange::new(0, 4),
                    insert: "0\nextra".to_owned(),
                },
                TextEdit {
                    range: TextRange::new(9, 12),
                    insert: "2".to_owned(),
                },
            ]))
            .unwrap();
        assert_eq!(buffer.snapshot(), "0\nextra\none\n2\nthree");
        let (total, ranges) = buffer
            .line_ranges(TextRange::new(0, buffer.utf16_len()), 1, 4)
            .unwrap();
        assert_eq!(total, 5);
        assert_eq!(ranges.len(), 3);
        assert_eq!(buffer.slice(ranges[0]).unwrap(), "extra\n");
        assert_eq!(buffer.slice(ranges[2]).unwrap(), "2\n");
    }

    #[test]
    fn locates_a_utf16_line_inside_an_opaque_content_range() {
        let buffer = TextBuffer::from_source("before\n😀 first\nsecond\nthird\nafter");
        let content = TextRange::new(7, 28);
        assert_eq!(buffer.line_index_in_range(content, 7).unwrap(), (3, 0));
        assert_eq!(buffer.line_index_in_range(content, 10).unwrap(), (3, 0));
        assert_eq!(buffer.line_index_in_range(content, 16).unwrap(), (3, 1));
        assert_eq!(buffer.line_index_in_range(content, 27).unwrap(), (3, 2));
        assert_eq!(buffer.line_index_in_range(content, 100).unwrap(), (3, 2));
    }

    #[test]
    fn rejects_a_range_that_splits_a_surrogate_pair_without_panicking() {
        let mut buffer = TextBuffer::from_source("a😀b");
        let error = buffer
            .apply(&transaction(vec![TextEdit {
                range: TextRange::new(2, 3),
                insert: "x".to_owned(),
            }]))
            .unwrap_err();

        assert!(matches!(error, EngineError::InvalidRange));
        assert_eq!(buffer.snapshot(), "a😀b");
    }

    #[test]
    fn maps_every_character_boundary_across_multiple_rope_chunks() {
        let source = "aé中😀\n".repeat(2_000);
        let buffer = TextBuffer::from_source(&source);
        let mut utf16 = 0_u32;
        for (byte, character) in source.char_indices() {
            assert_eq!(buffer.byte_of_utf16(utf16).unwrap(), byte);
            if character.len_utf16() == 2 {
                assert!(matches!(
                    buffer.byte_of_utf16(utf16 + 1),
                    Err(EngineError::InvalidRange)
                ));
            }
            utf16 += character.len_utf16() as u32;
        }
        assert_eq!(buffer.byte_of_utf16(utf16).unwrap(), source.len());
    }

    #[test]
    fn line_queries_return_utf16_ranges_after_multibyte_characters() {
        let source = "前\n😀后\n尾";
        let buffer = TextBuffer::from_source(source);
        let full = TextRange::new(0, buffer.utf16_len());

        let (total, ranges) = buffer.line_ranges(full, 0, 10).unwrap();
        assert_eq!(total, 3);
        assert_eq!(
            ranges,
            [
                TextRange::new(0, 2),
                TextRange::new(2, 6),
                TextRange::new(6, 7)
            ]
        );
        assert_eq!(
            buffer
                .line_index_in_range(full, buffer.utf16_len())
                .unwrap(),
            (3, 2)
        );

        let second_line_end = "前\n😀后".encode_utf16().count() as u32;
        let partial = TextRange::new(0, second_line_end);
        assert_eq!(
            buffer
                .line_index_in_range(partial, second_line_end)
                .unwrap(),
            (2, 1)
        );
        assert_eq!(buffer.slice(ranges[1]).unwrap(), "😀后\n");
    }

    #[test]
    fn cloned_buffers_are_copy_on_write_snapshots() {
        let original = TextBuffer::from_source("first\nsecond\nthird");
        let mut edited = original.clone();
        edited
            .apply(&transaction(vec![TextEdit {
                range: TextRange::new(6, 12),
                insert: "2".to_owned(),
            }]))
            .unwrap();

        assert_eq!(original.snapshot(), "first\nsecond\nthird");
        assert_eq!(edited.snapshot(), "first\n2\nthird");
    }

    #[test]
    fn returns_only_physical_lines_touched_by_a_utf16_range() {
        let buffer = TextBuffer::from_source("zero\n😀 one\ntwo\nthree");
        let (range, source) = buffer
            .physical_lines_covering(TextRange::new(8, 14))
            .unwrap();

        assert_eq!(range, TextRange::new(5, 15));
        assert_eq!(source, "😀 one\ntwo");
    }
}
