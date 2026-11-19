use crate::common::assert_same_syntax;
use editor_engine::{
    syntax::{
        BulletMarker, CompiledSyntaxProfile, ListMarker, NodeKind, OrderedDelimiter,
        SyntaxSnapshot, parse, reparse_change,
    },
    text::TextBuffer,
};
use editor_protocol::{ChangedTextRange, TextRange};

fn parse_syntax(source: &str) -> SyntaxSnapshot {
    parse(
        &TextBuffer::from_source(source),
        &CompiledSyntaxProfile::compile(Default::default()),
    )
    .unwrap()
}

fn assert_item(
    syntax: &SyntaxSnapshot,
    index: usize,
    indent_columns: u32,
    expected_marker: ListMarker,
) {
    assert_eq!(
        syntax.block(index).unwrap().kind,
        NodeKind::ListItem {
            marker: expected_marker,
            indent_columns,
        }
    );
}

#[test]
fn every_list_item_is_one_top_level_physical_line() {
    let syntax = parse_syntax("- one\n  - two\n     1. three");
    assert_eq!(syntax.block_count(), 3);
    assert_item(
        &syntax,
        0,
        0,
        ListMarker::Unordered {
            marker: BulletMarker::Dash,
        },
    );
    assert_item(
        &syntax,
        1,
        2,
        ListMarker::Unordered {
            marker: BulletMarker::Dash,
        },
    );
    assert_item(
        &syntax,
        2,
        5,
        ListMarker::Ordered {
            number: 1,
            delimiter: OrderedDelimiter::Period,
        },
    );
}

#[test]
fn ordered_numbers_delimiters_and_indentation_belong_to_each_item() {
    let syntax = parse_syntax("  42) first\n  43) second");
    assert_eq!(syntax.block_count(), 2);
    assert_item(
        &syntax,
        0,
        2,
        ListMarker::Ordered {
            number: 42,
            delimiter: OrderedDelimiter::Parenthesis,
        },
    );
    assert_item(
        &syntax,
        1,
        2,
        ListMarker::Ordered {
            number: 43,
            delimiter: OrderedDelimiter::Parenthesis,
        },
    );
}

#[test]
fn ordinary_and_blank_lines_split_list_runs_and_remain_renderable_blocks() {
    let syntax = parse_syntax("- first\n\nordinary\n  - second");
    assert_eq!(syntax.block_count(), 4);
    assert!(matches!(
        syntax.block(0).unwrap().kind,
        NodeKind::ListItem { .. }
    ));
    assert_eq!(syntax.block(1).unwrap().kind, NodeKind::BlankLine);
    assert_eq!(syntax.block(2).unwrap().kind, NodeKind::Paragraph);
    assert!(matches!(
        syntax.block(3).unwrap().kind,
        NodeKind::ListItem {
            indent_columns: 2,
            ..
        }
    ));
}

#[test]
fn leading_whitespace_and_terminal_blank_lines_are_explicit_root_nodes() {
    let syntax = parse_syntax("\n \t\ntext\n");
    assert_eq!(syntax.block_count(), 4);
    assert_eq!(syntax.block(0).unwrap().kind, NodeKind::BlankLine);
    assert_eq!(syntax.block(0).unwrap().source_range, TextRange::new(0, 0));
    assert_eq!(syntax.block(1).unwrap().kind, NodeKind::BlankLine);
    assert_eq!(syntax.block(1).unwrap().source_range, TextRange::new(1, 3));
    assert_eq!(syntax.block(2).unwrap().kind, NodeKind::Paragraph);
    assert_eq!(syntax.block(3).unwrap().kind, NodeKind::BlankLine);
    assert_eq!(syntax.block(3).unwrap().source_range, TextRange::new(9, 9));
}

#[test]
fn code_fence_owns_its_internal_blank_lines_but_not_a_following_blank() {
    let closed = parse_syntax("``` rust begin\n\ncode\n\n``` end\n");
    assert_eq!(closed.block_count(), 2);
    assert!(matches!(
        closed.block(0).unwrap().kind,
        NodeKind::FencedCode { closed: true, .. }
    ));
    assert_eq!(closed.block(1).unwrap().kind, NodeKind::BlankLine);

    let unclosed = parse_syntax("``` rust begin\n\n# heading\n- item");
    assert_eq!(unclosed.block_count(), 4);
    assert_eq!(unclosed.block(0).unwrap().kind, NodeKind::Paragraph);
    assert_eq!(unclosed.block(1).unwrap().kind, NodeKind::BlankLine);
    assert_eq!(
        unclosed.block(2).unwrap().kind,
        NodeKind::Heading { level: 1 }
    );
    assert!(matches!(
        unclosed.block(3).unwrap().kind,
        NodeKind::ListItem { .. }
    ));
}

#[test]
fn empty_items_have_no_body_but_keep_marker_and_indent() {
    let syntax = parse_syntax("- \n  1.\n     * \n- tail");
    assert_eq!(syntax.block_count(), 4);
    for index in 0..3 {
        assert!(syntax.block(index).unwrap().children.is_empty());
    }
    assert!(matches!(
        syntax.block(2).unwrap().kind,
        NodeKind::ListItem {
            marker: ListMarker::Unordered {
                marker: BulletMarker::Asterisk
            },
            indent_columns: 5,
        }
    ));
    assert_eq!(syntax.block(3).unwrap().children.len(), 1);
}

#[test]
fn thematic_break_keeps_priority_over_a_list_marker() {
    let syntax = parse_syntax("* * *");
    assert_eq!(syntax.block(0).unwrap().kind, NodeKind::ThematicBreak);
}

#[test]
fn screenshot_source_is_a_flat_sequence_with_absolute_indentation() {
    let syntax = parse_syntax(
        "- 一级项目\n  1. 二级有序项目\n     - 三级项目\n- s\n  2. 23\n     3. 23\n- 修改任意一项，观察 revision 和渲染同步",
    );
    assert_eq!(syntax.block_count(), 7);
    let indents = syntax
        .root()
        .children
        .iter()
        .map(|id| match &syntax.node(*id).unwrap().kind {
            NodeKind::ListItem { indent_columns, .. } => *indent_columns,
            other => panic!("expected ListItem, got {other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(indents, [0, 2, 5, 0, 2, 5, 0]);
}

#[test]
fn deeply_indented_and_large_lists_have_no_container_limit() {
    let mut deep = String::new();
    for level in 0..32 {
        deep.push_str(&"  ".repeat(level));
        deep.push_str("- level\n");
    }
    let deep_syntax = parse_syntax(&deep);
    assert_eq!(deep_syntax.block_count(), 33);
    for level in 0..32 {
        assert!(matches!(
            deep_syntax.block(level).unwrap().kind,
            NodeKind::ListItem { indent_columns, .. }
                if indent_columns == u32::try_from(level * 2).unwrap()
        ));
    }
    assert_eq!(deep_syntax.block(32).unwrap().kind, NodeKind::BlankLine);

    let large: String = (0..2_000)
        .map(|index| format!("- item {index}\n"))
        .collect();
    let large_syntax = parse_syntax(&large);
    assert_eq!(large_syntax.block_count(), 2_001);
    assert!((0..2_000).all(|index| matches!(
        large_syntax.block(index).unwrap().kind,
        NodeKind::ListItem { .. }
    )));
    assert_eq!(large_syntax.block(2_000).unwrap().kind, NodeKind::BlankLine);
}

#[test]
fn list_edit_incremental_result_matches_a_full_parse() {
    let original: String = (0..500)
        .map(|index| format!("- item {index:03}\n"))
        .collect();
    let removed = "- item 250";
    let inserted = "  250) **item 250**";
    let changed = original.replacen(removed, inserted, 1);
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let before = TextBuffer::from_source(&original);
    let previous = parse(&before, &profile).unwrap();
    let changed_buffer = TextBuffer::from_source(&changed);
    let changed_from = u32::try_from(original.find("- item 250").unwrap()).unwrap();
    let incremental = reparse_change(
        &previous,
        &before,
        &changed_buffer,
        ChangedTextRange {
            before: TextRange::new(changed_from, changed_from + removed.len() as u32),
            after: TextRange::new(changed_from, changed_from + inserted.len() as u32),
        },
        removed,
        inserted,
        &profile,
    )
    .unwrap();
    let full = parse(&changed_buffer, &profile).unwrap();
    assert_same_syntax(&incremental.snapshot, &full);
    assert_eq!(incremental.changed_blocks, 1);
    assert_eq!(
        previous.block(250).unwrap().id,
        incremental.snapshot.block(250).unwrap().id
    );
}

#[test]
fn inserting_a_blank_line_keeps_neighbor_item_ids_and_matches_full_parse() {
    let original = "- alpha\n- beta\n- gamma";
    let changed = "- alpha\n\n- beta\n- gamma";
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let before = TextBuffer::from_source(original);
    let after = TextBuffer::from_source(changed);
    let previous = parse(&before, &profile).unwrap();
    let result = reparse_change(
        &previous,
        &before,
        &after,
        ChangedTextRange {
            before: TextRange::new(8, 8),
            after: TextRange::new(8, 9),
        },
        "",
        "\n",
        &profile,
    )
    .unwrap();
    let full = parse(&after, &profile).unwrap();
    assert_same_syntax(&result.snapshot, &full);
    assert_eq!(
        result.snapshot.block(0).unwrap().id,
        previous.block(0).unwrap().id
    );
    assert_eq!(
        result.snapshot.block(2).unwrap().id,
        previous.block(1).unwrap().id
    );
    assert_eq!(
        result.snapshot.block(3).unwrap().id,
        previous.block(2).unwrap().id
    );
}
