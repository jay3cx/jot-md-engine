//! 在既有语法树上改写单个行内内容所属的子树。
//! 先完成可能失败的解析和补丁构造，再写入节点槽位，避免留下部分更新的快照。

use std::collections::HashSet;

use editor_protocol::{ChangedTextRange, TextRange};

use crate::text::TextBuffer;

use super::{
    CompiledSyntaxProfile, InPlaceIncrementalResult, NodeId, NodeKind, ParseError, SyntaxNode,
    SyntaxSnapshot,
    block::{self, parse_line_views, source_lines_with_base},
    incremental::{projection_changes_for_inline_replacement, reconcile_reparsed_children},
    inline,
    tree::{NodeIdAllocator, shift_offset},
};

/// 用新文本重算受影响的行内子树，保留无关节点的 ID。等长替换不访问后缀；
/// 长度变化时会平移后续节点的绝对范围。可能改变块边界时返回 None，由调用方从安全检查点解析。
pub fn try_reparse_inline_in_place(
    previous: &mut SyntaxSnapshot,
    previous_text: &TextBuffer,
    text: &TextBuffer,
    change: ChangedTextRange,
    removed_text: &str,
    inserted_text: &str,
    profile: &CompiledSyntaxProfile,
) -> Result<Option<InPlaceIncrementalResult>, ParseError> {
    if change.before.from != change.after.from
        || removed_text.contains(['\n', '\r'])
        || inserted_text.contains(['\n', '\r'])
        || block::list_continuation_sensitive(previous_text, change.before)
        || block::list_continuation_sensitive(text, change.after)
    {
        return Ok(None);
    }
    let Some((path, slots)) = previous.inline_owner_path(change.before) else {
        return Ok(None);
    };
    let owner = previous
        .node(*path.last().ok_or(ParseError::InvalidParserState)?)
        .ok_or(ParseError::InvalidParserState)?;
    let delta = i64::from(change.after.to - change.after.from)
        - i64::from(change.before.to - change.before.from);
    let owner_range = TextRange::new(
        owner.source_range.from,
        shift_offset(owner.source_range.to, delta).ok_or(ParseError::DocumentTooLarge)?,
    );
    let source = text
        .slice(owner_range)
        .map_err(|_| ParseError::InvalidParserState)?;
    let old_source = previous_text
        .slice(owner.source_range)
        .map_err(|_| ParseError::InvalidParserState)?;
    if source.contains(['\n', '\r']) {
        return Ok(None);
    }
    let mut ids = NodeIdAllocator::after(previous);
    let (mut children, mut nodes) = match &owner.kind {
        NodeKind::TableCell { .. } => {
            // The row parser owns trimming, pipes, escapes and inline-code pipe
            // protection. Do not freeze a cell range after a boundary edit.
            if source.is_empty()
                || source.trim_matches([' ', '\t']) != source
                || old_source.contains(['`', '\\'])
                || source.contains(['`', '\\'])
                || removed_text
                    .bytes()
                    .chain(inserted_text.bytes())
                    .any(|byte| matches!(byte, b'|' | b'`' | b'\\'))
            {
                return Ok(None);
            }
            let parsed = inline::parse(&source, owner_range.from, &mut ids)?;
            (parsed.roots, parsed.nodes)
        }
        NodeKind::Paragraph | NodeKind::Heading { .. } | NodeKind::ListItem { .. } => {
            if matches!(owner.kind, NodeKind::Paragraph)
                && (boundary_marker(&old_source, profile)
                    || boundary_marker(&source, profile)
                    || old_source.contains('|')
                    || source.contains('|'))
            {
                return Ok(None);
            }
            let lines = source_lines_with_base(&source, owner_range.from)?;
            let mut parsed = parse_line_views(&lines, profile, &mut ids)?;
            if parsed.roots.len() != 1 {
                return Ok(None);
            }
            let root_position = parsed
                .nodes
                .iter()
                .position(|node| node.id == parsed.roots[0])
                .ok_or(ParseError::InvalidParserState)?;
            let root = parsed.nodes.swap_remove(root_position);
            // A same-length rewrite can still change heading level, marker,
            // indentation, or turn an ordinary line into another block kind.
            if root.kind != owner.kind || root.source_range != owner_range {
                return Ok(None);
            }
            (root.children, parsed.nodes)
        }
        _ => return Ok(None),
    };
    reconcile_reparsed_children(
        previous,
        previous_text,
        text,
        change,
        &owner.children,
        &mut children,
        &mut nodes,
    )?;
    let projection_changes = projection_changes_for_inline_replacement(
        previous,
        &path,
        owner,
        &children,
        &nodes,
        Some(&slots),
    )?;
    let mut old_ids = Vec::new();
    let mut pending = owner.children.clone();
    while let Some(id) = pending.pop() {
        let node = previous.node(id).ok_or(ParseError::InvalidParserState)?;
        pending.extend_from_slice(&node.children);
        old_ids.push(id);
    }
    let retained: HashSet<NodeId> = nodes.iter().map(|node| node.id).collect();
    old_ids.retain(|id| !retained.contains(id));
    let result = InPlaceIncrementalResult {
        reparsed_range: owner_range,
        replaced_from: u32::try_from(*slots.first().ok_or(ParseError::InvalidParserState)?)
            .map_err(|_| ParseError::DocumentTooLarge)?,
        removed_blocks: 1,
        changed_blocks: 1,
        projection_changes,
    };
    nodes.push(SyntaxNode {
        id: owner.id,
        kind: owner.kind.clone(),
        source_range: owner_range,
        children,
        content_version: owner.content_version.saturating_add(1),
    });
    previous.commit_local_rewrite(
        &old_ids,
        nodes,
        &path[..path.len() - 1],
        ids.next_id(),
        (delta != 0).then_some((change.before.to, delta)),
    );
    Ok(Some(result))
}

fn boundary_marker(source: &str, profile: &CompiledSyntaxProfile) -> bool {
    block::fenced_code_language(source, profile).is_some()
        || block::closes_fenced_code(source)
        || block::is_math_block_boundary(source)
}
