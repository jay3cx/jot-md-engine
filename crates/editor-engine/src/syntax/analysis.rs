use std::sync::Arc;

use editor_protocol::{ChangedTextRange, TextRange};

use super::{
    CompiledSyntaxProfile, NodeId, NodeKind, ParseError, SyntaxNode, SyntaxSnapshot,
    block::{BlockIndex, SourceLine, parse_next, source_lines_from_buffer},
    tree::NodeIdAllocator,
};
use crate::text::TextBuffer;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxCheckpoint {
    pub utf16_offset: u32,
    pub reused_blocks: u32,
    prefix: SyntaxSnapshot,
    suffix: Option<SuffixReuse>,
    identities: Option<ReparsedIdentities>,
    ids: NodeIdAllocator,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SuffixReuse {
    snapshot: Arc<SyntaxSnapshot>,
    first_block: usize,
    delta: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReparsedIdentities {
    snapshot: Arc<SyntaxSnapshot>,
    text: TextBuffer,
    change: ChangedTextRange,
}

impl SyntaxCheckpoint {
    /// 选择包含改动或紧邻改动之前的顶层 block。该 block 会重新解析，只有更早的
    /// 完整 block 可以复用。
    pub fn before(snapshot: &SyntaxSnapshot, offset: u32) -> Self {
        let mut block_index = 0_usize;
        let mut checkpoint_offset = 0_u32;
        for index in 0..snapshot.block_count() {
            let Some(block) = snapshot.block(index) else {
                break;
            };
            if block.source_range.from > offset {
                break;
            }
            block_index = index;
            checkpoint_offset = block.source_range.from;
        }
        Self {
            utf16_offset: checkpoint_offset,
            reused_blocks: u32::try_from(block_index).unwrap_or(u32::MAX),
            prefix: snapshot.prefix(block_index, checkpoint_offset),
            suffix: None,
            identities: None,
            ids: NodeIdAllocator::after(snapshot),
        }
    }

    /// 创建带有候选未变化后缀的事务 checkpoint。重新解析至少一个新 block 后，
    /// parser 到达某个平移后的 block 起点时，可以接上第一个候选后缀。
    pub fn for_change(snapshot: &SyntaxSnapshot, changed_before: TextRange, delta: i64) -> Self {
        let mut checkpoint = Self::before(snapshot, changed_before.from);
        let first_block =
            (checkpoint.reused_blocks as usize + 1..snapshot.block_count()).find(|index| {
                snapshot
                    .block(*index)
                    .is_some_and(|block| block.source_range.from >= changed_before.to)
            });
        checkpoint.suffix = first_block.map(|first_block| SuffixReuse {
            snapshot: Arc::new(snapshot.clone()),
            first_block,
            delta,
        });
        checkpoint
    }

    /// Carry identity into each published work slice, including partial ones.
    /// Only match roots at source starts that have an unambiguous old position.
    pub(crate) fn with_stable_identities(
        mut self,
        snapshot: &SyntaxSnapshot,
        text: &TextBuffer,
        change: ChangedTextRange,
    ) -> Self {
        self.identities = Some(ReparsedIdentities {
            snapshot: self.suffix.as_ref().map_or_else(
                || Arc::new(snapshot.clone()),
                |suffix| Arc::clone(&suffix.snapshot),
            ),
            text: text.clone(),
            change,
        });
        self
    }

    /// 结构性行变化可能与前一个 block 合并，最典型的是 paragraph 加上新变为合法
    /// 的表格分隔行。保留后缀候选的同时，重新解析一个顶层 look-behind block。
    pub fn for_structural_change(
        snapshot: &SyntaxSnapshot,
        changed_before: TextRange,
        delta: i64,
    ) -> Self {
        let mut checkpoint = Self::for_change(snapshot, changed_before, delta);
        if checkpoint.reused_blocks > 0 {
            let reused_blocks = checkpoint.reused_blocks as usize - 1;
            let offset = snapshot
                .block(reused_blocks)
                .map_or(0, |block| block.source_range.from);
            checkpoint.utf16_offset = offset;
            checkpoint.reused_blocks = u32::try_from(reused_blocks).unwrap_or(u32::MAX);
            checkpoint.prefix = snapshot.prefix(reused_blocks, offset);
        }
        checkpoint
    }

    /// 可恢复的前缀快照恰好结束在 parser 已确认的行边界，因此编辑从其后开始时
    /// 可以复用整个前缀。
    pub fn after_prefix(snapshot: &SyntaxSnapshot) -> Self {
        let offset = snapshot.root().source_range.to;
        Self {
            utf16_offset: offset,
            reused_blocks: u32::try_from(snapshot.block_count()).unwrap_or(u32::MAX),
            prefix: snapshot.clone(),
            suffix: None,
            identities: None,
            ids: NodeIdAllocator::after(snapshot),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkBudget {
    pub max_source_lines: usize,
    pub max_blocks: usize,
    pub max_utf16_units: usize,
}

impl WorkBudget {
    pub const fn new(max_source_lines: usize, max_blocks: usize) -> Self {
        Self {
            max_source_lines,
            max_blocks,
            max_utf16_units: usize::MAX,
        }
    }

    pub const fn bounded(
        max_source_lines: usize,
        max_blocks: usize,
        max_utf16_units: usize,
    ) -> Self {
        Self {
            max_source_lines,
            max_blocks,
            max_utf16_units,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnalysisProgress {
    /// 已知使用正确文档起始状态完成解析的前缀。
    pub confirmed_range: TextRange,
    pub parsed_blocks: u32,
    pub consumed_source_lines: u32,
    pub consumed_blocks: u32,
    pub consumed_utf16_units: u32,
    pub reused_prefix_blocks: u32,
    pub parsed_new_blocks: u32,
    pub reused_suffix_blocks: u32,
    pub reparsed_range: TextRange,
    pub complete: bool,
}

pub struct SyntaxAnalysisSession {
    text_utf16_len: u32,
    lines: Vec<SourceLine>,
    block_index: BlockIndex,
    profile: CompiledSyntaxProfile,
    ids: NodeIdAllocator,
    cursor: usize,
    roots: Vec<NodeId>,
    nodes: Vec<SyntaxNode>,
    initial_root_count: usize,
    parsed_new_blocks: usize,
    reused_suffix_blocks: usize,
    suffix: Option<SuffixReuse>,
    identities: Option<(ReparsedIdentities, TextBuffer)>,
    reparse_start_utf16: u32,
    reparse_end_utf16: u32,
}

impl SyntaxAnalysisSession {
    /// 一次复制并规范化完整源码，然后保留可恢复的 parser state。priority range
    /// 永远不会变成独立的 parse root。
    pub fn from_source(source: &str, profile: CompiledSyntaxProfile) -> Result<Self, ParseError> {
        Self::from_text(&TextBuffer::from_source(source), profile)
    }

    pub fn from_text(
        text: &TextBuffer,
        profile: CompiledSyntaxProfile,
    ) -> Result<Self, ParseError> {
        let text_utf16_len = text.utf16_len();
        let lines = source_lines_from_buffer(text)?;
        let block_index = BlockIndex::new(&lines);
        Ok(Self {
            text_utf16_len,
            lines,
            block_index,
            profile,
            ids: NodeIdAllocator::new(),
            cursor: 0,
            roots: Vec::new(),
            nodes: Vec::new(),
            initial_root_count: 0,
            parsed_new_blocks: 0,
            reused_suffix_blocks: 0,
            suffix: None,
            identities: None,
            reparse_start_utf16: 0,
            reparse_end_utf16: 0,
        })
    }

    pub fn from_checkpoint(
        text: &TextBuffer,
        profile: CompiledSyntaxProfile,
        checkpoint: SyntaxCheckpoint,
    ) -> Result<Self, ParseError> {
        if checkpoint.utf16_offset > text.utf16_len()
            || checkpoint.prefix.root().source_range.to != checkpoint.utf16_offset
        {
            return Err(ParseError::InvalidParserState);
        }
        let lines = source_lines_from_buffer(text)?;
        let block_index = BlockIndex::new(&lines);
        let cursor = if checkpoint.utf16_offset == text.utf16_len()
            && lines
                .last()
                .is_none_or(|line| line.start_utf16 != checkpoint.utf16_offset)
        {
            lines.len()
        } else {
            lines
                .iter()
                .position(|line| line.start_utf16 == checkpoint.utf16_offset)
                .ok_or(ParseError::InvalidParserState)?
        };
        let roots = checkpoint.prefix.root().children.clone();
        let initial_root_count = roots.len();
        let nodes = checkpoint
            .prefix
            .nodes()
            .iter()
            .filter(|node| node.id != checkpoint.prefix.root().id)
            .cloned()
            .collect();
        // 新 ID 必须高于完整旧快照，即使在最后一个 block 插入后没有可复用的后缀
        // 候选也一样。只在 checkpoint 前缀之后分配，可能在身份协调时与旧 dirty
        // block 冲突。
        let ids = checkpoint.ids;
        Ok(Self {
            text_utf16_len: text.utf16_len(),
            lines,
            block_index,
            profile,
            ids,
            cursor,
            roots,
            nodes,
            initial_root_count,
            parsed_new_blocks: 0,
            reused_suffix_blocks: 0,
            suffix: checkpoint.suffix,
            identities: checkpoint
                .identities
                .map(|previous| (previous, text.clone())),
            reparse_start_utf16: checkpoint.utf16_offset,
            reparse_end_utf16: checkpoint.utf16_offset,
        })
    }

    /// 从当前文档起始 checkpoint 解析到覆盖 `range.to` 为止。跨越请求边界的容器
    /// 会作为完整 block 完成，因此 confirmed_range 可能大于请求范围。
    pub fn parse_priority(&mut self, range: TextRange) -> Result<AnalysisProgress, ParseError> {
        if !range.is_ordered() || range.to > self.text_utf16_len {
            return Err(ParseError::InvalidParserState);
        }
        while !self.is_complete() && self.confirmed_to() < range.to {
            // 在目标位置之后或相等的第一个已确认 block 边界处停止；这里如果批量
            // 过宽，会意外把 priority parse 变回接近完整的同步解析。
            self.poll(WorkBudget::new(1, 1))?;
        }
        Ok(self.progress(0, 0, 0))
    }

    /// 在不超过调用方确定性工作片的前提下向 priority range 推进。parser 仍是
    /// 正确的文档起始前缀 parser；range 只改变初始工作片可以停止的位置。
    pub fn poll_priority(
        &mut self,
        range: TextRange,
        budget: WorkBudget,
    ) -> Result<AnalysisProgress, ParseError> {
        if !range.is_ordered() || range.to > self.text_utf16_len {
            return Err(ParseError::InvalidParserState);
        }
        self.poll_until(budget, Some(range.to))
    }

    /// 推进有界数量的顶层 block/物理行。单个容器是原子的，可能超过行预算；要让
    /// 超大单容器可恢复，必须在该 block 规则内部实现。
    pub fn poll(&mut self, budget: WorkBudget) -> Result<AnalysisProgress, ParseError> {
        self.poll_until(budget, None)
    }

    fn poll_until(
        &mut self,
        budget: WorkBudget,
        priority_to: Option<u32>,
    ) -> Result<AnalysisProgress, ParseError> {
        if budget.max_source_lines == 0 || budget.max_blocks == 0 || budget.max_utf16_units == 0 {
            return Err(ParseError::InvalidParserState);
        }
        let start_cursor = self.cursor;
        let start_blocks = self.roots.len();
        let start_utf16 = self.confirmed_to();
        let mut parsed_end_utf16 = start_utf16;
        let mut parsed_blocks = 0_usize;
        while self.cursor < self.lines.len()
            && parsed_blocks < budget.max_blocks
            && self.cursor - start_cursor < budget.max_source_lines
        {
            if self.cursor > start_cursor
                && usize::try_from(self.confirmed_to().saturating_sub(start_utf16))
                    .unwrap_or(usize::MAX)
                    >= budget.max_utf16_units
            {
                break;
            }
            if priority_to.is_some_and(|target| self.confirmed_to() >= target) {
                break;
            }
            let old_cursor = self.cursor;
            let (parsed, next_cursor) = parse_next(
                &self.lines,
                &self.block_index,
                &self.profile,
                &mut self.ids,
                self.cursor,
            )?;
            self.cursor = next_cursor;
            parsed_end_utf16 = self.confirmed_to();
            self.reparse_end_utf16 = parsed_end_utf16;
            if let Some(mut parsed) = parsed {
                if let Some((previous, text)) = &self.identities {
                    previous.reconcile(&mut parsed, text)?;
                }
                self.roots.push(parsed.root.id);
                self.nodes.push(parsed.root);
                self.nodes.extend(parsed.descendants);
                parsed_blocks += 1;
                self.parsed_new_blocks += 1;
            }
            if self.cursor <= old_cursor {
                return Err(ParseError::InvalidParserState);
            }
            if self.try_attach_suffix()? {
                break;
            }
        }
        Ok(self.progress(
            self.cursor - start_cursor,
            self.roots.len() - start_blocks,
            parsed_end_utf16.saturating_sub(start_utf16),
        ))
    }

    fn try_attach_suffix(&mut self) -> Result<bool, ParseError> {
        if self.parsed_new_blocks == 0 {
            return Ok(false);
        }
        let Some(reuse) = &self.suffix else {
            return Ok(false);
        };
        let confirmed_to = self.confirmed_to();
        let Ok(old_offset) = u32::try_from(i64::from(confirmed_to) - reuse.delta) else {
            return Ok(false);
        };
        // 根块按源码位置排列。插入区尚未解析完时，逐块扫描旧后缀会在每个新块后
        // 重复遍历同一段旧文档。
        let roots = &reuse.snapshot.root().children[reuse.first_block..];
        let slot = roots.partition_point(|id| {
            reuse
                .snapshot
                .node(*id)
                .expect("indexed syntax root")
                .source_range
                .from
                < old_offset
        });
        let matching_block = reuse.first_block + slot;
        let Some(block) = reuse.snapshot.block(matching_block) else {
            return Ok(false);
        };
        if block.source_range.from != old_offset {
            return Ok(false);
        }
        // 末尾 LF 产生的零宽空行必须在新文档中仍有对应的物理行。
        if block.kind == NodeKind::BlankLine
            && block.source_range.from == block.source_range.to
            && !self
                .lines
                .get(self.cursor)
                .is_some_and(|line| line.start_utf16 == confirmed_to && line.is_blank())
        {
            return Ok(false);
        }
        let (root_ids, nodes) = reuse
            .snapshot
            .shifted_suffix(matching_block, reuse.delta)
            .ok_or(ParseError::DocumentTooLarge)?;
        self.reused_suffix_blocks = root_ids.len();
        self.roots.extend(root_ids);
        self.nodes.extend(nodes);
        self.cursor = self.lines.len();
        self.suffix = None;
        Ok(true)
    }

    pub fn is_complete(&self) -> bool {
        self.cursor == self.lines.len()
    }

    /// The document owns a prefix from this same session. Publish only the
    /// append-only frontier; earlier nodes and their lookup index remain intact.
    pub(crate) fn extend_snapshot(&self, prefix: &mut SyntaxSnapshot) {
        let blocks = prefix.block_count();
        let nodes = prefix.nodes().len() - 1;
        prefix.append_confirmed(
            &self.roots[blocks..],
            &self.nodes[nodes..],
            self.confirmed_to(),
        );
    }

    pub fn prefix_snapshot(&self) -> SyntaxSnapshot {
        self.build_snapshot(self.confirmed_to())
    }

    pub fn completed_snapshot(&self) -> Option<SyntaxSnapshot> {
        self.is_complete()
            .then(|| self.build_snapshot(self.text_utf16_len))
    }

    pub fn reused_prefix_blocks(&self) -> u32 {
        u32::try_from(self.initial_root_count).unwrap_or(u32::MAX)
    }

    pub fn parsed_new_blocks(&self) -> u32 {
        u32::try_from(self.parsed_new_blocks).unwrap_or(u32::MAX)
    }

    pub fn reused_suffix_blocks(&self) -> u32 {
        u32::try_from(self.reused_suffix_blocks).unwrap_or(u32::MAX)
    }

    pub fn reparsed_range(&self) -> TextRange {
        TextRange::new(self.reparse_start_utf16, self.reparse_end_utf16)
    }

    fn progress(
        &self,
        consumed_source_lines: usize,
        consumed_blocks: usize,
        consumed_utf16_units: u32,
    ) -> AnalysisProgress {
        AnalysisProgress {
            confirmed_range: TextRange::new(0, self.confirmed_to()),
            parsed_blocks: u32::try_from(self.roots.len()).unwrap_or(u32::MAX),
            consumed_source_lines: u32::try_from(consumed_source_lines).unwrap_or(u32::MAX),
            consumed_blocks: u32::try_from(consumed_blocks).unwrap_or(u32::MAX),
            consumed_utf16_units,
            reused_prefix_blocks: self.reused_prefix_blocks(),
            parsed_new_blocks: self.parsed_new_blocks(),
            reused_suffix_blocks: self.reused_suffix_blocks(),
            reparsed_range: self.reparsed_range(),
            complete: self.is_complete(),
        }
    }

    fn confirmed_to(&self) -> u32 {
        self.lines
            .get(self.cursor)
            .map_or(self.text_utf16_len, |line| line.start_utf16)
    }

    fn build_snapshot(&self, root_end: u32) -> SyntaxSnapshot {
        SyntaxSnapshot::new(
            SyntaxNode {
                id: NodeId(0),
                kind: NodeKind::Document,
                source_range: TextRange::new(0, root_end),
                children: self.roots.clone(),
                content_version: 0,
            },
            self.nodes.clone(),
        )
        .with_id_allocator(self.ids.clone())
    }
}

impl ReparsedIdentities {
    fn reconcile(
        &self,
        parsed: &mut super::block::ParsedBlock,
        text: &TextBuffer,
    ) -> Result<(), ParseError> {
        let from = parsed.root.source_range.from;
        let original = if from < self.change.after.from {
            from
        } else if from >= self.change.after.to {
            // The suffix starts at `before.to` in the old source.
            from - self.change.after.to + self.change.before.to
        } else if from == self.change.after.from && self.change.before.from < self.change.before.to
        {
            // A replacement at the block's start can keep the same kind and
            // identity. Pure insertions still belong to the new prefix.
            self.change.before.from
        } else {
            return Ok(());
        };
        let roots = &self.snapshot.root().children;
        let Ok(index) = roots.binary_search_by_key(&original, |id| {
            self.snapshot
                .node(*id)
                .expect("indexed syntax root")
                .source_range
                .from
        }) else {
            return Ok(());
        };
        let old = self
            .snapshot
            .node(roots[index])
            .ok_or(ParseError::InvalidParserState)?;
        if std::mem::discriminant(&old.kind) != std::mem::discriminant(&parsed.root.kind) {
            return Ok(());
        }
        super::incremental::reconcile_reparsed_children(
            &self.snapshot,
            &self.text,
            text,
            self.change,
            &old.children,
            &mut parsed.root.children,
            &mut parsed.descendants,
        )?;
        super::incremental::preserve_node_version(&self.text, text, old, &mut parsed.root);
        parsed.root.id = old.id;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> CompiledSyntaxProfile {
        CompiledSyntaxProfile::compile(Default::default())
    }

    fn assert_same_syntax(
        actual: &SyntaxSnapshot,
        actual_id: NodeId,
        expected: &SyntaxSnapshot,
        expected_id: NodeId,
    ) {
        let actual_node = actual.node(actual_id).unwrap();
        let expected_node = expected.node(expected_id).unwrap();
        assert_eq!(actual_node.kind, expected_node.kind);
        assert_eq!(actual_node.source_range, expected_node.source_range);
        assert_eq!(actual_node.children.len(), expected_node.children.len());
        for (actual_child, expected_child) in
            actual_node.children.iter().zip(&expected_node.children)
        {
            assert_same_syntax(actual, *actual_child, expected, *expected_child);
        }
    }

    #[test]
    fn priority_parse_is_a_confirmed_prefix_not_an_isolated_fragment() {
        let source = "``` rust begin\ninside\nstill inside\n``` end\nafter";
        let mut session = SyntaxAnalysisSession::from_source(source, profile()).unwrap();
        let progress = session.parse_priority(TextRange::new(18, 20)).unwrap();
        assert!(progress.confirmed_range.to >= 20);
        let prefix = session.prefix_snapshot();
        assert!(matches!(
            prefix.block(0).unwrap().kind,
            NodeKind::FencedCode { .. }
        ));
    }

    #[test]
    fn polling_to_completion_matches_full_parse() {
        let source = "# h\none\ntwo\n- a\n- b\n$$\nx\n$$";
        let text = TextBuffer::from_source(source);
        let expected = super::super::parse(&text, &profile()).unwrap();
        let mut session = SyntaxAnalysisSession::from_text(&text, profile()).unwrap();
        while !session.is_complete() {
            session.poll(WorkBudget::new(2, 1)).unwrap();
        }
        assert_eq!(session.completed_snapshot().unwrap(), expected);
    }

    #[test]
    fn checkpoint_reparses_the_whole_container_not_an_interior_line() {
        let source = "before\n``` rust begin\ninside\n``` end\nafter";
        let text = TextBuffer::from_source(source);
        let snapshot = super::super::parse(&text, &profile()).unwrap();
        let inside = u32::try_from(source.find("inside").unwrap()).unwrap();
        let checkpoint = SyntaxCheckpoint::before(&snapshot, inside);
        assert_eq!(checkpoint.utf16_offset, 7);
        assert_eq!(checkpoint.reused_blocks, 1);
    }

    #[test]
    fn budgeted_table_seam_edits_keep_identity_in_every_published_snapshot() {
        let before = "| A | B |\n| --- | --- |\n| x | y |\n";
        let rest = "\n``` rust\nfn main() {}\n```";
        for (draft, insert, expected_rows) in [("", "|", 2), ("", "\n", 2), ("|内容", "|", 3)] {
            let old_text = TextBuffer::from_source(&format!("{before}{draft}{rest}"));
            let text = TextBuffer::from_source(&format!("{before}{draft}{insert}{rest}"));
            let old = super::super::parse(&old_text, &profile()).unwrap();
            let expected = super::super::parse(&text, &profile()).unwrap();
            let offset = (before.encode_utf16().count() + draft.encode_utf16().count()) as u32;
            let change = ChangedTextRange {
                before: TextRange::new(offset, offset),
                after: TextRange::new(offset, offset + 1),
            };
            let checkpoint = SyntaxCheckpoint::for_structural_change(&old, change.before, 1)
                .with_stable_identities(&old, &old_text, change);
            let mut session =
                SyntaxAnalysisSession::from_checkpoint(&text, profile(), checkpoint).unwrap();
            let table = old.block(0).unwrap();
            while !session.is_complete() {
                session.poll(WorkBudget::new(1, 1)).unwrap();
                let prefix = session.prefix_snapshot();
                let published = prefix.block(0).unwrap();
                assert_eq!(published.id, table.id);
                assert_eq!(published.children.len(), expected_rows);
                assert_eq!(published.children[..table.children.len()], table.children);
                assert_eq!(
                    published.content_version,
                    u32::from(expected_rows > table.children.len())
                );
            }
            let actual = session.completed_snapshot().unwrap();
            assert_same_syntax(&actual, actual.root().id, &expected, expected.root().id);
            for (i, node) in actual.nodes().iter().enumerate() {
                assert_eq!(actual.node(node.id), Some(&actual.nodes()[i]));
            }
        }
    }

    #[test]
    fn checkpoint_resume_matches_a_full_parse_and_preserves_prefix_ids() {
        let source = (0..40)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let old_text = TextBuffer::from_source(&source);
        let old = super::super::parse(&old_text, &profile()).unwrap();
        let edit_offset = u32::try_from(source.find("line 30").unwrap() + 5).unwrap();
        let checkpoint = SyntaxCheckpoint::before(&old, edit_offset);
        assert_eq!(checkpoint.reused_blocks, 30);

        let changed_source = source.replacen("line 30", "line thirty", 1);
        let changed_text = TextBuffer::from_source(&changed_source);
        let expected = super::super::parse(&changed_text, &profile()).unwrap();
        let mut session =
            SyntaxAnalysisSession::from_checkpoint(&changed_text, profile(), checkpoint).unwrap();
        while !session.is_complete() {
            session.poll(WorkBudget::new(2, 1)).unwrap();
        }
        let actual = session.completed_snapshot().unwrap();
        assert_same_syntax(&actual, actual.root().id, &expected, expected.root().id);
        for index in 0..30 {
            assert_eq!(
                actual.block(index).unwrap().id,
                old.block(index).unwrap().id
            );
        }
    }
}
