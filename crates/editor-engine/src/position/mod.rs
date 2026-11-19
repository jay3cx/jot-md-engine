//! 文档边界处的位置转换。

/// 文档边界位置转换失败的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PositionError {
    OutOfBounds,
    InsideSurrogatePair,
    Overflow,
}

/// 计算协议所使用的 UTF-16 code unit 长度。
pub fn utf16_len(text: &str) -> Result<u32, PositionError> {
    u32::try_from(text.encode_utf16().count()).map_err(|_| PositionError::Overflow)
}

/// 将 UTF-16 偏移转换为 Rust 字符串的字节偏移，禁止落在代理项中间。
pub fn utf16_to_byte(text: &str, target: u32) -> Result<usize, PositionError> {
    let mut utf16_offset = 0_u32;

    for (byte_offset, ch) in text.char_indices() {
        if utf16_offset == target {
            return Ok(byte_offset);
        }

        let next = utf16_offset
            .checked_add(ch.len_utf16() as u32)
            .ok_or(PositionError::Overflow)?;
        if target < next {
            return Err(PositionError::InsideSurrogatePair);
        }
        utf16_offset = next;
    }

    if utf16_offset == target {
        Ok(text.len())
    } else {
        Err(PositionError::OutOfBounds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_utf16_offsets_without_splitting_emoji() {
        let text = "a😀b";
        assert_eq!(utf16_len(text), Ok(4));
        assert_eq!(utf16_to_byte(text, 0), Ok(0));
        assert_eq!(utf16_to_byte(text, 1), Ok(1));
        assert_eq!(
            utf16_to_byte(text, 2),
            Err(PositionError::InsideSurrogatePair)
        );
        assert_eq!(utf16_to_byte(text, 3), Ok(5));
        assert_eq!(utf16_to_byte(text, 4), Ok(6));
    }
}
