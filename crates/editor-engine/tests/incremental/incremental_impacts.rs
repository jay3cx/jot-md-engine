use crate::common::assert_same_syntax;
use editor_engine::{
    syntax::{
        CompiledSyntaxProfile, IncrementalResult, NodeId, NodeKind, SyntaxAnalysisSession,
        SyntaxCheckpoint, SyntaxSnapshot, WorkBudget, parse, reparse_change, try_reparse_fast,
        try_reparse_table_row_window_in_place,
    },
    text::TextBuffer,
};
use editor_protocol::{ChangedTextRange, ProjectionAxis, TextRange};

fn profile() -> CompiledSyntaxProfile {
    CompiledSyntaxProfile::compile(Default::default())
}

fn replace(before_source: &str, search: &str, replacement: &str) -> IncrementalResult {
    assert_eq!(
        before_source.matches(search).count(),
        1,
        "search must be unique"
    );
    let from_byte = before_source.find(search).unwrap();
    let to_byte = from_byte + search.len();
    replace_bytes(before_source, from_byte, to_byte, replacement)
}

fn replace_bytes(
    before_source: &str,
    from_byte: usize,
    to_byte: usize,
    replacement: &str,
) -> IncrementalResult {
    let from = u32::try_from(before_source[..from_byte].encode_utf16().count()).unwrap();
    let old_to = u32::try_from(before_source[..to_byte].encode_utf16().count()).unwrap();
    let new_to = from + u32::try_from(replacement.encode_utf16().count()).unwrap();
    let after_source = format!(
        "{}{}{}",
        &before_source[..from_byte],
        replacement,
        &before_source[to_byte..]
    );
    let before = TextBuffer::from_source(before_source);
    let after = TextBuffer::from_source(&after_source);
    let previous = parse(&before, &profile()).unwrap();
    let result = reparse_change(
        &previous,
        &before,
        &after,
        ChangedTextRange {
            before: TextRange::new(from, old_to),
            after: TextRange::new(from, new_to),
        },
        &before_source[from_byte..to_byte],
        replacement,
        &profile(),
    )
    .unwrap();
    let expected = parse(&after, &profile()).unwrap();
    assert_same_syntax(&result.snapshot, &expected);
    result
}

#[test]
fn heading_and_quote_body_edits_keep_their_outer_blocks() {
    let heading_source = "before\n# title **bold**\nafter";
    let heading_before = parse(&TextBuffer::from_source(heading_source), &profile()).unwrap();
    let heading = replace(heading_source, "title", "new title");
    assert_eq!(heading.reparsed_range, TextRange::new(7, 27));
    assert_eq!(
        heading.snapshot.block(1).unwrap().id,
        heading_before.block(1).unwrap().id
    );
    assert_eq!(
        heading.snapshot.block(2).unwrap().id,
        heading_before.block(2).unwrap().id
    );

    let quote_source = "before\n> quoted **text**\nafter";
    let quote_before = parse(&TextBuffer::from_source(quote_source), &profile()).unwrap();
    let quote = replace(quote_source, "quoted", "revised");
    assert_eq!(
        quote.snapshot.block(1).unwrap().id,
        quote_before.block(1).unwrap().id
    );
    assert_eq!(
        quote.snapshot.block(2).unwrap().id,
        quote_before.block(2).unwrap().id
    );
    assert!(quote.reparsed_range.from > quote.snapshot.block(1).unwrap().source_range.from);
}

#[test]
fn inline_identity_reconciliation_is_generic_across_block_owners() {
    for source in [
        "plain **bold value** and *italic value*",
        "# title **bold value** and *italic value*",
        "- item **bold value** and *italic value*",
        "| head |\n| --- |\n| cell **bold value** and *italic value* |",
        "> quote **bold value** and *italic value*",
    ] {
        let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
        let old_strong = first_node_id(&previous, |kind| matches!(kind, NodeKind::Strong));
        let old_emphasis = first_node_id(&previous, |kind| matches!(kind, NodeKind::Emphasis));
        let old_strong_text = previous.node(old_strong).unwrap().children[0];
        let result = replace(source, "bold value", "bold revised value");
        let new_strong = first_node_id(&result.snapshot, |kind| matches!(kind, NodeKind::Strong));
        let new_emphasis =
            first_node_id(&result.snapshot, |kind| matches!(kind, NodeKind::Emphasis));
        assert_eq!(
            new_strong, old_strong,
            "Strong identity changed for {source}"
        );
        assert_eq!(
            result.snapshot.node(new_strong).unwrap().children[0],
            old_strong_text,
            "edited Text identity changed for {source}"
        );
        assert_eq!(
            new_emphasis, old_emphasis,
            "unaffected Emphasis identity changed for {source}"
        );
        assert!(
            !result.projection_changes.is_empty(),
            "nested projection delta missing for {source}"
        );
        assert!(
            result
                .projection_changes
                .iter()
                .all(|change| { change.remove_count <= 1 && change.insert_count <= 1 }),
            "one inline edit invalidated more than one sibling slot for {source}"
        );
    }
}

#[test]
fn inserting_a_matching_kind_does_not_move_ids_off_existing_inline_source() {
    for source in [
        "**same** **same** **same**",
        "# **same** **same** **same**",
        "- **same** **same** **same**",
        "> **same** **same** **same**",
        "| head |\n| --- |\n| **same** **same** **same** |",
    ] {
        let syntax = parse(&TextBuffer::from_source(source), &profile()).unwrap();
        let ids = |snapshot: &SyntaxSnapshot| {
            snapshot
                .nodes()
                .iter()
                .filter(|node| node.kind == NodeKind::Strong)
                .map(|node| (node.source_range.from, node.id, node.content_version))
                .collect::<Vec<_>>()
        };
        let before = ids(&syntax);
        let at = source.find("**same**").unwrap();
        let added = "**新** ";
        let result = replace_bytes(source, at, at, added);
        let after = ids(&result.snapshot);
        assert_eq!(
            after[1..]
                .iter()
                .map(|entry| (entry.0 - 6, entry.1, entry.2))
                .collect::<Vec<_>>(),
            before,
            "{source}"
        );
        assert!(before.iter().all(|entry| entry.1 != after[0].1));
    }
}

#[test]
fn removing_a_blank_line_between_quotes_keeps_the_surviving_root_and_its_children() {
    let source = "> one **one**\n\n>> two **two**\n\nafter";
    let syntax = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let before = syntax.block(0).unwrap();
    let at = source.find("\n\n").unwrap();
    let result = replace_bytes(source, at, at + 1, "");
    let after = result.snapshot.block(0).unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(after.children[0], before.children[0]);
    assert!(after.content_version > before.content_version);
    assert_eq!(
        result.snapshot.block(2).unwrap().id,
        syntax.block(4).unwrap().id
    );
}

#[test]
fn a_removed_blank_line_does_not_replace_independent_blocks() {
    for (before, after) in [
        ("- first", "- second"),
        ("``` rust\none\n```", "``` rust\ntwo\n```"),
        ("$$\none\n$$", "$$\ntwo\n$$"),
    ] {
        let source = format!("{before}\n\n{after}");
        let old = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
        let result = replace_bytes(&source, before.len(), before.len() + 1, "");
        assert_eq!(result.snapshot.block_count(), 2);
        for (index, original) in [0, 2].into_iter().enumerate() {
            let first = old.block(original).unwrap();
            let updated = result.snapshot.block(index).unwrap();
            assert_eq!(updated.id, first.id, "{source}");
            assert_eq!(updated.content_version, first.content_version, "{source}");
        }
    }
}

#[test]
fn rebased_inline_ranges_do_not_invalidate_content_versions() {
    for (source, shifted_kind) in [
        ("# prefix `unchanged`", "inline-code"),
        ("> prefix $unchanged$", "inline-math"),
        ("| Head |\n| --- |\n| prefix \\| |", "escaped-text"),
    ] {
        let before = parse(&TextBuffer::from_source(source), &profile()).unwrap();
        let node_id = first_node_id(&before, |kind| kind.wire_name() == shifted_kind);
        let previous = before.node(node_id).unwrap();
        let result = replace(source, "prefix", "longer prefix");
        let updated = result.snapshot.node(node_id).unwrap();
        assert!(updated.source_range.from > previous.source_range.from);
        assert_eq!(updated.content_version, previous.content_version);
    }
    // The suffix-splice path also rebases the payload, even without reparsing.
    replace(
        "before\n\n| A |\n| --- |\n| \\| |",
        "before",
        "a longer prefix",
    );
}

#[test]
fn large_list_body_edit_only_rebuilds_one_physical_item() {
    let source = (0..200)
        .map(|index| format!("- item {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let previous = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    let result = replace(&source, "item 120", "item one hundred twenty");
    assert_eq!(result.snapshot.block_count(), 200);
    assert_eq!(
        result.snapshot.block(120).unwrap().id,
        previous.block(120).unwrap().id
    );
    assert_eq!(
        result.snapshot.block(121).unwrap().id,
        previous.block(121).unwrap().id
    );
    assert_eq!(result.changed_blocks, 1);
    assert!(result.reparsed_range.to - result.reparsed_range.from < 40);
}

#[test]
fn huge_list_line_split_and_indent_edits_reuse_the_physical_suffix() {
    let source = (0..10_000)
        .map(|index| format!("- item {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let previous = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    assert_eq!(previous.block_count(), 10_000);
    let old_item = previous.block(5_000).unwrap().id;
    let old_after_item = previous.block(5_001).unwrap().id;

    let split_line = replace(&source, "- item 5000", "- item 5000\n  continuation");
    assert_eq!(split_line.snapshot.block_count(), 10_001);
    assert_eq!(split_line.snapshot.block(5_000).unwrap().id, old_item);
    assert_eq!(split_line.snapshot.block(5_002).unwrap().id, old_after_item);
    assert!(split_line.reparsed_range.to - split_line.reparsed_range.from < 40);

    let indented = replace(&source, "- item 5000", " - item 5000");
    assert_eq!(indented.snapshot.block_count(), 10_000);
    assert_eq!(indented.changed_blocks, 1);
    assert_eq!(indented.snapshot.block(5_000).unwrap().id, old_item);
    assert_eq!(indented.snapshot.block(5_001).unwrap().id, old_after_item);
    assert!(matches!(
        indented.snapshot.block(5_000).unwrap().kind,
        NodeKind::ListItem {
            indent_columns: 1,
            ..
        }
    ));
    assert!(indented.reparsed_range.to - indented.reparsed_range.from < 20);

    let deeper = replace(&source, "- item 5000", "  - item 5000");
    assert_eq!(deeper.snapshot.block_count(), 10_000);
    assert_eq!(deeper.snapshot.block(5_000).unwrap().id, old_item);
    assert_eq!(deeper.snapshot.block(5_001).unwrap().id, old_after_item);
    assert!(matches!(
        deeper.snapshot.block(5_000).unwrap().kind,
        NodeKind::ListItem {
            indent_columns: 2,
            ..
        }
    ));
    assert!(deeper.reparsed_range.to - deeper.reparsed_range.from < 30);
}

#[test]
fn huge_multilevel_list_reparses_one_physical_item_across_marker_families() {
    let source = (0..3_000)
        .map(|index| format!("- parent {index}\n  1. ordered {index}\n     * deep {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let previous = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    assert_eq!(previous.block_count(), 9_000);
    let ordered_index = 1_500 * 3 + 1;
    let old_ordered_item = previous.block(ordered_index).unwrap().id;
    let old_next_outer_item = previous.block(ordered_index + 2).unwrap().id;

    // marker 类型是单个物理项的属性，因此其余行可以复用，无需重建递归列表容器。
    let result = replace(&source, "1. ordered 1500", "1) ordered 1500");
    assert_eq!(result.snapshot.block_count(), 9_000);
    assert_eq!(
        result.snapshot.block(ordered_index).unwrap().id,
        old_ordered_item
    );
    assert_eq!(
        result.snapshot.block(ordered_index + 2).unwrap().id,
        old_next_outer_item
    );
    assert!(result.reparsed_range.to - result.reparsed_range.from < 100);
    assert!(matches!(
        result.snapshot.block(ordered_index).unwrap().kind,
        NodeKind::ListItem {
            marker: editor_engine::syntax::ListMarker::Ordered {
                delimiter: editor_engine::syntax::OrderedDelimiter::Parenthesis,
                ..
            },
            indent_columns: 2,
        }
    ));
}

#[test]
fn ordered_marker_edit_reparses_one_item_and_preserves_following_items() {
    let source = "1. alpha\n2. beta\n3. gamma\n\nafter";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let result = replace(source, "2. beta", "20. beta");
    assert_eq!(result.snapshot.block_count(), 5);
    for index in 0..5 {
        assert_eq!(
            result.snapshot.block(index).unwrap().id,
            previous.block(index).unwrap().id
        );
    }
    assert!(result.reparsed_range.from > result.snapshot.block(0).unwrap().source_range.from);
}

#[test]
fn list_marker_and_indent_changes_are_item_local_and_reuse_the_suffix() {
    let split_source = "before\n- alpha\n- beta\n- gamma\n\nafter";
    let split_before = parse(&TextBuffer::from_source(split_source), &profile()).unwrap();
    let split = replace(split_source, "- beta", "+ beta");
    assert_eq!(split.snapshot.block_count(), 6);
    assert_eq!(
        split.snapshot.block(2).unwrap().id,
        split_before.block(2).unwrap().id
    );
    assert_eq!(
        split.snapshot.block(5).unwrap().id,
        split_before.block(5).unwrap().id
    );

    let indent_source = "before\n- parent\n  - child\n- tail\n\nafter";
    let indent_before = parse(&TextBuffer::from_source(indent_source), &profile()).unwrap();
    let indent = replace(indent_source, "  - child", "- child");
    assert_eq!(
        indent.snapshot.block(2).unwrap().id,
        indent_before.block(2).unwrap().id
    );
    assert!(matches!(
        indent.snapshot.block(2).unwrap().kind,
        NodeKind::ListItem {
            indent_columns: 0,
            ..
        }
    ));
    assert_eq!(
        indent.snapshot.block(3).unwrap().id,
        indent_before.block(3).unwrap().id
    );
}

#[test]
fn indenting_an_item_only_changes_its_absolute_depth_attribute() {
    let source = "- 一级项目\n  1. 二级有序项目\n2.\n     - 三级项目\n- 尾项";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let marker = source.find("\n2.").unwrap() + 1;
    let result = replace_bytes(source, marker, marker, "  ");

    assert_eq!(result.snapshot.block_count(), 5);
    assert_eq!(
        result.snapshot.block(2).unwrap().id,
        previous.block(2).unwrap().id
    );
    assert!(matches!(
        result.snapshot.block(2).unwrap().kind,
        NodeKind::ListItem {
            indent_columns: 2,
            ..
        }
    ));
    assert_eq!(
        result.snapshot.block(3).unwrap().id,
        previous.block(3).unwrap().id
    );
}

#[test]
fn list_marker_change_never_absorbs_items_across_blank_lines() {
    let source = "before\n- alpha\n\n+ beta\n\nafter";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    assert_eq!(previous.block_count(), 6);
    let result = replace(source, "+ beta", "- beta");
    assert_eq!(result.snapshot.block_count(), 6);
    assert_eq!(result.changed_blocks, 1);
    assert_eq!(
        result.snapshot.block(3).unwrap().id,
        previous.block(3).unwrap().id
    );
    assert!(matches!(
        result.snapshot.block(3).unwrap().kind,
        NodeKind::ListItem {
            marker: editor_engine::syntax::ListMarker::Unordered {
                marker: editor_engine::syntax::BulletMarker::Dash
            },
            ..
        }
    ));
    assert_eq!(
        result.snapshot.block(5).unwrap().id,
        previous.block(5).unwrap().id
    );
}

#[test]
fn table_cell_and_body_row_changes_do_not_reparse_later_blocks() {
    let source = "before\n| name | value | note |\n| --- | --- | --- |\n| alpha | beta |\nafter";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let cell = replace(source, "beta", "revised beta");
    assert_eq!(
        cell.snapshot.block(1).unwrap().id,
        previous.block(1).unwrap().id
    );
    assert_eq!(
        cell.snapshot.block(2).unwrap().id,
        previous.block(2).unwrap().id
    );

    let row = replace(source, "beta", "beta | extra");
    assert_eq!(
        row.snapshot.block(1).unwrap().id,
        previous.block(1).unwrap().id
    );
    assert_eq!(
        row.snapshot.block(2).unwrap().id,
        previous.block(2).unwrap().id
    );
    assert!(row.reparsed_range.from > row.snapshot.block(1).unwrap().source_range.from);
}

#[test]
fn in_place_table_row_edit_matches_full_parse_and_rebuilds_id_index() {
    let before_source =
        "before\n| name | value |\n| --- | --- |\n| alpha | beta |\n| tail | stable |\nafter";
    let from_byte = before_source.find("beta").unwrap();
    let to_byte = from_byte + "beta".len();
    let replacement = "revised beta";
    let after_source = format!(
        "{}{}{}",
        &before_source[..from_byte],
        replacement,
        &before_source[to_byte..]
    );
    let from = u32::try_from(before_source[..from_byte].encode_utf16().count()).unwrap();
    let old_to = u32::try_from(before_source[..to_byte].encode_utf16().count()).unwrap();
    let new_to = from + u32::try_from(replacement.encode_utf16().count()).unwrap();
    let before_text = TextBuffer::from_source(before_source);
    let after_text = TextBuffer::from_source(&after_source);
    let mut actual = parse(&before_text, &profile()).unwrap();
    let old_table = actual.block(1).unwrap().id;
    let old_suffix = actual.block(2).unwrap().id;
    let result = try_reparse_table_row_window_in_place(
        &mut actual,
        &before_text,
        &after_text,
        ChangedTextRange {
            before: TextRange::new(from, old_to),
            after: TextRange::new(from, new_to),
        },
        &profile(),
    )
    .unwrap()
    .expect("a body cell edit should use the in-place table path");
    let expected = parse(&after_text, &profile()).unwrap();

    assert_same_syntax(&actual, &expected);
    assert_eq!(actual.block(1).unwrap().id, old_table);
    assert_eq!(actual.block(2).unwrap().id, old_suffix);
    assert_eq!(result.removed_blocks, 1);
    assert_eq!(result.changed_blocks, 1);
    assert_eq!(actual.node(old_table).unwrap().children.len(), 3);
    assert!(actual.node(old_suffix).is_some());
}

#[test]
fn clearing_a_padded_cell_keeps_its_slot_and_uses_the_new_empty_range() {
    let source = "| A | B | C |\n| --- | --- | --- |\n| left | beta \t| right |";
    let before = TextBuffer::from_source(source);
    let from = u32::try_from(source.find("beta").unwrap()).unwrap();
    for replacement in ["", "  "] {
        let after = TextBuffer::from_source(&source.replace("beta", replacement));
        let mut tree = parse(&before, &profile()).unwrap();
        let row = tree.block(0).unwrap().children[1];
        let cells = tree.node(row).unwrap().children.clone();
        let change = ChangedTextRange {
            before: TextRange::new(from, from + 4),
            after: TextRange::new(from, from + replacement.len() as u32),
        };
        try_reparse_table_row_window_in_place(&mut tree, &before, &after, change, &profile())
            .unwrap()
            .unwrap();
        assert_same_syntax(&tree, &parse(&after, &profile()).unwrap());
        assert_eq!(tree.node(row).unwrap().children, cells);
        let empty = tree.node(cells[1]).unwrap();
        assert!(empty.source_range.from > change.after.to);
        assert_eq!(empty.source_range.from, empty.source_range.to);
        assert!(empty.content_version > 0);
    }
}

#[test]
fn huge_table_inserts_and_merges_rows_without_reparsing_the_container() {
    let mut lines = vec![
        "| key | value | c3 | c4 | c5 | c6 |".to_owned(),
        "| --- | --- | --- | --- | --- | --- |".to_owned(),
    ];
    lines.extend((0..10_000).map(|index| format!("| r{index} | v{index} |")));
    let source = lines.join("\n");
    let previous = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    let old_table = previous.block(0).unwrap();
    let old_suffix_row = old_table.children[5_002];

    let inserted = replace(
        &source,
        "| r5000 | v5000 |",
        "| r5000 | v5000 |\n| inserted | value |",
    );
    let inserted_table = inserted.snapshot.block(0).unwrap();
    assert_eq!(inserted_table.id, old_table.id);
    assert_eq!(inserted_table.children.len(), old_table.children.len() + 1);
    assert_eq!(inserted_table.children[5_003], old_suffix_row);
    assert!(inserted.reparsed_range.to - inserted.reparsed_range.from < 50);

    let merged = replace(
        &source,
        "| r5000 | v5000 |\n| r5001 | v5001 |",
        "| r5000 | v5000 | | r5001 | v5001 |",
    );
    let merged_table = merged.snapshot.block(0).unwrap();
    assert_eq!(merged_table.id, old_table.id);
    assert_eq!(merged_table.children.len() + 1, old_table.children.len());
    assert_eq!(merged_table.children[5_002], old_table.children[5_003]);
    assert!(merged.reparsed_range.to - merged.reparsed_range.from < 60);
}

#[test]
fn oversized_table_rows_stay_source_until_they_fit_the_header() {
    let source = "| A | B |\n| --- | --- |\n| x | y |\n\n| later | two |";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    for draft in ["||||", "| first | second | must stay visible |"] {
        let changed = replace(source, "\n\n| later", &format!("\n{draft}\n| later"));
        let table = changed.snapshot.block(0).unwrap();
        assert_eq!(table.id, previous.block(0).unwrap().id);
        assert_eq!(table.children.len(), 2);
        let next = changed.snapshot.block(1).unwrap();
        assert_eq!(next.kind, NodeKind::Paragraph);
        assert_eq!(
            next.source_range.to - next.source_range.from,
            draft.len() as u32
        );
    }
}

#[test]
fn huge_table_supports_variable_width_rows_and_literal_pipes_incrementally() {
    let columns = (0..24).map(|index| format!("h{index}")).collect::<Vec<_>>();
    let mut lines = vec![
        format!("| {} |", columns.join(" | ")),
        format!("| {} |", vec!["---"; columns.len()].join(" | ")),
    ];
    lines.extend((0..2_000).map(|row| {
        let width = 3 + row % 10;
        let cells = (0..width)
            .map(|column| format!("r{row}c{column}"))
            .collect::<Vec<_>>();
        format!("| {} |", cells.join(" | "))
    }));
    lines[752] = "| target750 | escaped \\| pipe | `code|pipe` | tail |".to_owned();
    let source = lines.join("\n");
    let previous = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    let old_table = previous.block(0).unwrap();
    assert_eq!(old_table.children.len(), 2_001);
    assert_eq!(
        previous
            .node(old_table.children[751])
            .unwrap()
            .children
            .len(),
        4
    );
    let old_suffix_row = old_table.children[752];

    let result = replace(
        &source,
        "| target750 | escaped \\| pipe | `code|pipe` | tail |",
        "| target750 | escaped \\| pipe | `code|pipe` | added | tail |",
    );
    let table = result.snapshot.block(0).unwrap();
    assert_eq!(table.id, old_table.id);
    assert_eq!(table.children[752], old_suffix_row);
    assert_eq!(
        result
            .snapshot
            .node(table.children[751])
            .unwrap()
            .children
            .len(),
        5
    );
    assert!(result.reparsed_range.to - result.reparsed_range.from < 80);
}

#[test]
fn table_creation_looks_back_one_physical_line_and_keeps_unrelated_prefix() {
    let source = "intro\na | b\n--- x ---\nafter";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let result = replace(source, "--- x ---", "--- | ---");
    assert_eq!(
        result.snapshot.block(0).unwrap().id,
        previous.block(0).unwrap().id
    );
    assert!(matches!(
        result.snapshot.block(1).unwrap().kind,
        NodeKind::Table { .. }
    ));
    assert_eq!(result.reparsed_range.from, 6);
}

#[test]
fn fenced_code_and_math_content_edits_only_update_the_opaque_block() {
    let code_source = "before\n``` rust begin\nlet value = 1;\n``` end\nafter";
    let code_before = parse(&TextBuffer::from_source(code_source), &profile()).unwrap();
    let code = replace(code_source, "value = 1", "value = 100");
    assert_eq!(
        code.snapshot.block(1).unwrap().id,
        code_before.block(1).unwrap().id
    );
    assert_eq!(
        code.snapshot.block(2).unwrap().id,
        code_before.block(2).unwrap().id
    );
    assert_eq!(code.reparsed_range.to - code.reparsed_range.from, 11);
    assert_eq!(code.projection_changes.len(), 1);
    assert_eq!(code.projection_changes[0].axis, ProjectionAxis::SourceLines);
    assert_eq!(code.projection_changes[0].remove_count, 1);
    assert_eq!(code.projection_changes[0].insert_count, 1);

    let math_source = "before\n$$\nx + y\n$$\nafter";
    let math_before = parse(&TextBuffer::from_source(math_source), &profile()).unwrap();
    let math = replace(math_source, "x + y", "x + y + z");
    assert_eq!(
        math.snapshot.block(1).unwrap().id,
        math_before.block(1).unwrap().id
    );
    assert_eq!(
        math.snapshot.block(2).unwrap().id,
        math_before.block(2).unwrap().id
    );
}

#[test]
fn opaque_content_reports_exact_source_line_splices() {
    let source = "``` rust begin\nfirst\nsecond\nthird\n``` end";
    let merged = replace(source, "first\nsecond", "first second");
    let merge = &merged.projection_changes[0];
    assert_eq!(merge.axis, ProjectionAxis::SourceLines);
    assert_eq!(merge.from, 0);
    assert_eq!(merge.remove_count, 2);
    assert_eq!(merge.insert_count, 1);
    assert_eq!(merge.total_children, 2);

    let split = replace(source, "second", "sec\nond");
    let split_change = &split.projection_changes[0];
    assert_eq!(split_change.axis, ProjectionAxis::SourceLines);
    assert_eq!(split_change.from, 1);
    assert_eq!(split_change.remove_count, 1);
    assert_eq!(split_change.insert_count, 2);
    assert_eq!(split_change.total_children, 4);
}

#[test]
fn code_enter_and_backspace_at_content_end_update_blank_source_lines() {
    let source = "before\n``` rust begin\ncode\n``` end\nafter";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let inserted = replace(source, "code", "code\n");
    assert_eq!(
        inserted.snapshot.block(1).unwrap().id,
        previous.block(1).unwrap().id
    );
    assert_eq!(
        inserted.snapshot.block(1).unwrap().content_version,
        previous.block(1).unwrap().content_version.saturating_add(1)
    );
    assert_eq!(
        inserted.snapshot.block(2).unwrap().id,
        previous.block(2).unwrap().id
    );
    let line_change = &inserted.projection_changes[0];
    assert_eq!(line_change.axis, ProjectionAxis::SourceLines);
    assert_eq!(line_change.from, 0);
    assert_eq!(line_change.remove_count, 1);
    assert_eq!(line_change.insert_count, 2);
    assert_eq!(line_change.total_children, 2);

    let with_blank = "before\n``` rust begin\ncode\n\n``` end\nafter";
    let removed = replace(with_blank, "code\n", "code");
    let line_change = &removed.projection_changes[0];
    assert_eq!(line_change.from, 0);
    assert_eq!(line_change.remove_count, 2);
    assert_eq!(line_change.insert_count, 1);
    assert_eq!(line_change.total_children, 1);
}

#[test]
fn sequential_code_body_edit_then_enter_keeps_the_same_opaque_block() {
    let source = "before\n``` rust begin\ncode stays code\n``` end\nafter";
    let before = TextBuffer::from_source(source);
    let initial = parse(&before, &profile()).unwrap();
    let body_from = u32::try_from(source.find("code stays code").unwrap()).unwrap();
    let body_to = body_from + 15;
    let after_body_source = source.replace("code stays code", "code NOW!! code");
    let after_body = TextBuffer::from_source(&after_body_source);
    let first = try_reparse_fast(
        &initial,
        &before,
        &after_body,
        ChangedTextRange {
            before: TextRange::new(body_from, body_to),
            after: TextRange::new(body_from, body_to),
        },
        "code stays code",
        "code NOW!! code",
        &profile(),
    )
    .unwrap()
    .expect("body replacement should use opaque fast path");

    let enter_at = u32::try_from(after_body_source.find("\n``` end").unwrap()).unwrap();
    let after_enter_source = format!(
        "{}\n{}",
        &after_body_source[..enter_at as usize],
        &after_body_source[enter_at as usize..]
    );
    let after_enter = TextBuffer::from_source(&after_enter_source);
    let second = try_reparse_fast(
        &first.snapshot,
        &after_body,
        &after_enter,
        ChangedTextRange {
            before: TextRange::new(enter_at, enter_at),
            after: TextRange::new(enter_at, enter_at + 1),
        },
        "",
        "\n",
        &profile(),
    )
    .unwrap()
    .expect("enter before the existing separator should remain opaque-local");
    assert_eq!(
        second.snapshot.block(1).unwrap().id,
        initial.block(1).unwrap().id
    );
    assert_eq!(second.snapshot.block(1).unwrap().content_version, 2);
    assert_eq!(second.projection_changes[0].total_children, 2);
}

#[test]
fn insertion_at_paragraph_end_updates_inline_identity_and_version() {
    let source = "拼音：";
    let before = TextBuffer::from_source(source);
    let previous = parse(&before, &profile()).unwrap();
    let after = TextBuffer::from_source("拼音：你");
    let offset = u32::try_from(source.encode_utf16().count()).unwrap();
    let result = try_reparse_fast(
        &previous,
        &before,
        &after,
        ChangedTextRange {
            before: TextRange::new(offset, offset),
            after: TextRange::new(offset, offset + 1),
        },
        "",
        "你",
        &profile(),
    )
    .unwrap()
    .expect("typing at a physical paragraph end should remain inline-local");
    let old_paragraph = previous.block(0).unwrap();
    let new_paragraph = result.snapshot.block(0).unwrap();
    assert_eq!(new_paragraph.id, old_paragraph.id);
    assert_eq!(
        new_paragraph.content_version,
        old_paragraph.content_version.saturating_add(1)
    );
    assert_eq!(new_paragraph.children, old_paragraph.children);
    let expected = parse(&after, &profile()).unwrap();
    assert_same_syntax(&result.snapshot, &expected);
}

#[test]
fn replacing_a_trailing_newline_document_does_not_reuse_a_phantom_blank_line() {
    let before_source = "old\n";
    let after_source = "new";
    let before = TextBuffer::from_source(before_source);
    let after = TextBuffer::from_source(after_source);
    let previous = parse(&before, &profile()).unwrap();
    assert_eq!(previous.block_count(), 2);
    assert_eq!(previous.block(1).unwrap().kind, NodeKind::BlankLine);

    let result = reparse_change(
        &previous,
        &before,
        &after,
        ChangedTextRange {
            before: TextRange::new(0, 4),
            after: TextRange::new(0, 3),
        },
        before_source,
        after_source,
        &profile(),
    )
    .unwrap();
    let expected = parse(&after, &profile()).unwrap();
    assert_same_syntax(&result.snapshot, &expected);
    assert_eq!(result.snapshot.block_count(), 1);
    assert_eq!(result.snapshot.block(0).unwrap().kind, NodeKind::Paragraph);
}

#[test]
fn empty_and_loose_list_edits_remain_incremental_and_equal_full_parse() {
    let source = "- alpha\n- beta\n- tail";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let emptied = replace(source, "beta", "");
    let empty_item = emptied.snapshot.block(1).unwrap();
    assert_eq!(empty_item.id, previous.block(1).unwrap().id);
    assert!(empty_item.children.is_empty());
    assert_eq!(
        emptied.snapshot.block(2).unwrap().id,
        previous.block(2).unwrap().id
    );

    let loosened = replace(source, "\n- beta", "\n\n- beta");
    assert_eq!(loosened.snapshot.block_count(), 4);
    assert_eq!(
        loosened.snapshot.block(1).unwrap().kind,
        NodeKind::BlankLine
    );
    assert!(matches!(
        loosened.snapshot.block(2).unwrap().kind,
        NodeKind::ListItem { .. }
    ));

    let nested_source = "- parent\n  1. child\n- tail";
    let nested_before = parse(&TextBuffer::from_source(nested_source), &profile()).unwrap();
    let nested = replace(nested_source, "child", "");
    let ordered = nested.snapshot.block(1).unwrap();
    assert_eq!(ordered.id, nested_before.block(1).unwrap().id);
    assert!(ordered.children.is_empty());
    assert!(matches!(
        ordered.kind,
        NodeKind::ListItem {
            indent_columns: 2,
            ..
        }
    ));
}

#[test]
fn list_user_operation_matrix_always_matches_a_full_parse() {
    let cases = [
        (
            "delete final item",
            "- alpha\n- beta\n- gamma",
            "\n- gamma",
            "",
        ),
        (
            "empty final item body",
            "- alpha\n- beta\n- gamma",
            "gamma",
            "",
        ),
        (
            "indent middle item under previous",
            "- alpha\n- beta\n- gamma",
            "- beta",
            "  - beta",
        ),
        (
            "outdent nested item",
            "- parent\n  - child\n- tail",
            "  - child",
            "- child",
        ),
        (
            "change middle marker family",
            "- alpha\n- beta\n- gamma",
            "- beta",
            "2. beta",
        ),
        (
            "remove middle marker",
            "- alpha\n- beta\n- gamma",
            "- beta",
            "beta",
        ),
        (
            "insert blank before middle item",
            "- alpha\n- beta\n- gamma",
            "\n- beta",
            "\n\n- beta",
        ),
        (
            "remove blank before nested item",
            "- parent\n\n  1. child\n- tail",
            "\n\n  1.",
            "\n  1.",
        ),
        (
            "indent ordered continuation from screenshot",
            "- first\n  1. second\n2.\n     - third\n- tail",
            "\n2.",
            "\n  2.",
        ),
        (
            "outdent ordered continuation",
            "- first\n  1. second\n  2.\n     - third\n- tail",
            "\n  2.",
            "\n2.",
        ),
        (
            "edit screenshot nested ordered body",
            "- first\n  1. second\n     - third\n- s\n  2. 23\n     3. 23\n- tail",
            "\n  2. 23",
            "\n  2. changed",
        ),
        (
            "delete screenshot deepest ordered item",
            "- first\n  1. second\n     - third\n- s\n  2. 23\n     3. 23\n- tail",
            "\n     3. 23",
            "",
        ),
        (
            "outdent screenshot deepest ordered item to sibling",
            "- first\n  1. second\n     - third\n- s\n  2. 23\n     3. 23\n- tail",
            "\n     3. 23",
            "\n  3. 23",
        ),
    ];
    for (name, source, search, replacement) in cases {
        let result = replace(source, search, replacement);
        assert!(
            result.reparsed_range.to - result.reparsed_range.from
                <= result.snapshot.root().source_range.to,
            "{name}"
        );
    }
}

#[test]
fn quote_prefix_and_line_operations_match_a_full_parse() {
    let cases = [
        ("> alpha\n>>>> beta\n> gamma", ">>>> beta", ">>> beta"),
        ("> alpha\n> beta\n> gamma", "> beta", "beta"),
        ("> alpha\nbeta\n> gamma", "beta", "> beta"),
        ("> alpha\n>>>> beta\n> gamma", "beta", "be\n>>>> ta"),
        ("> alpha\n>>>> beta\n> gamma", "beta", "beta\n>>>> "),
        (
            "> alpha\n>    > beta\n> gamma",
            ">    > beta",
            ">     > beta",
        ),
        ("> alpha\n>>>> beta\n> gamma", ">>>> beta", "\\>>>> beta"),
        (
            "> ``` ts\n> > literal\n> ```",
            "> > literal",
            "> >> literal",
        ),
        (
            "> alpha\n> - [ ] task\n> gamma",
            "> - [ ] task",
            ">> - [ ] task",
        ),
        ("> alpha\n>>\n> gamma", ">>\n", ">> \t\n"),
        ("> alpha\n>>>> \n> gamma", ">>>> \n", ">>>> 字\n"),
        ("> alpha\n>>>> 字\n> gamma", ">>>> 字\n", ">>>> \n"),
        (
            "> alpha\n> - [ ] task\n> gamma",
            "> - [ ] task",
            ">   - [ ] task",
        ),
        (
            "> ``` ts\n> let x = 1\n> ```",
            "> let x = 1",
            ">   let x = 1",
        ),
        (">>\n>>>\n\n>\n>>", ">>>\n\n>\n", ">>>\n>\n"),
        (">>\n>>>\n>\n>>", ">>>\n>\n", ">>>\n\n>\n"),
        (">>>\n\nend", ">>>\n\n", ">>>\n>>>\n\n"),
        ("> ``` ts\n>\n\n> ```\nend", ">\n\n> ```", ">\n> ```"),
    ];
    for (source, search, replacement) in cases {
        let result = replace(source, search, replacement);
        assert!(result.reparsed_range.to <= result.snapshot.root().source_range.to);
    }
}

#[test]
fn table_user_operation_matrix_always_matches_a_full_parse() {
    let source = "| a | b |\n| --- | --- |\n| c | d |\n| e | f |";
    let cases = [
        ("delete last row", "\n| e | f |", ""),
        ("delete last cell", "| e | f |", "| e |"),
        ("remove trailing pipe", "| e | f |", "| e | f"),
        ("add a body column", "| c | d |", "| c | d | extra |"),
        ("insert a blank row", "\n| e | f |", "\n\n| e | f |"),
        ("turn last row into text", "| e | f |", "plain text"),
        (
            "mismatch header and delimiter widths",
            "| --- | --- |",
            "| --- |",
        ),
        (
            "escaped and inline-code pipes remain cells",
            "| c | d |",
            "| c \\| literal | `x|y` |",
        ),
    ];
    for (name, search, replacement) in cases {
        let result = replace(source, search, replacement);
        assert!(
            result.reparsed_range.to - result.reparsed_range.from
                <= result.snapshot.root().source_range.to,
            "{name}"
        );
    }
}

#[test]
fn container_marker_edits_use_maintained_opening_and_closing_ranges() {
    let code_source = "before\n``` rust begin\ncode\n``` end\nafter";
    let code_before = parse(&TextBuffer::from_source(code_source), &profile()).unwrap();
    let language = replace(code_source, "rust", "typescript");
    assert_eq!(
        language.snapshot.block(1).unwrap().id,
        code_before.block(1).unwrap().id
    );
    assert_eq!(
        language.snapshot.block(2).unwrap().id,
        code_before.block(2).unwrap().id
    );
    let NodeKind::FencedCode {
        language: parsed_language,
        opening_range,
        content_range,
        closing_range,
        ..
    } = &language.snapshot.block(1).unwrap().kind
    else {
        panic!("expected fenced code");
    };
    assert_eq!(parsed_language.as_deref(), Some("typescript"));
    assert_eq!(*opening_range, TextRange::new(7, 27));
    assert_eq!(*content_range, TextRange::new(28, 32));
    assert_eq!(*closing_range, Some(TextRange::new(33, 40)));
    assert_eq!(language.reparsed_range, TextRange::new(11, 21));

    let closer = replace(code_source, "``` end", "```   end");
    assert_eq!(
        closer.snapshot.block(1).unwrap().id,
        code_before.block(1).unwrap().id
    );
    assert_eq!(
        closer.snapshot.block(2).unwrap().id,
        code_before.block(2).unwrap().id
    );

    let math_source = "before\n $$ \nx\n$$\nafter";
    let math_before = parse(&TextBuffer::from_source(math_source), &profile()).unwrap();
    let opener = replace(math_source, " $$ ", "  $$  ");
    assert_eq!(
        opener.snapshot.block(1).unwrap().id,
        math_before.block(1).unwrap().id
    );
    assert_eq!(
        opener.snapshot.block(2).unwrap().id,
        math_before.block(2).unwrap().id
    );
}

#[test]
fn creating_a_real_closer_recomputes_the_container_boundary() {
    let code = replace(
        "before\n``` rust begin\ncode\nnot end\nafter",
        "not end",
        "``` end",
    );
    assert!(matches!(
        code.snapshot.block(1).unwrap().kind,
        NodeKind::FencedCode { closed: true, .. }
    ));
    assert!(matches!(
        code.snapshot.block(2).unwrap().kind,
        NodeKind::Paragraph
    ));

    let math = replace("before\n$$\nx\nnot end\nafter", "not end", "$$");
    assert!(matches!(
        math.snapshot.block(1).unwrap().kind,
        NodeKind::MathBlock { closed: true, .. }
    ));
    assert!(matches!(
        math.snapshot.block(2).unwrap().kind,
        NodeKind::Paragraph
    ));
}

#[test]
fn removing_a_math_boundary_releases_the_following_source_lines() {
    let source = "before\n$$\nx\n$$\nafter";
    let removed_opening = replace_bytes(source, 7, 9, "plain");
    assert_eq!(removed_opening.snapshot.block_count(), 5);
    assert!(
        (0..removed_opening.snapshot.block_count()).all(|index| removed_opening
            .snapshot
            .block(index)
            .unwrap()
            .kind
            == NodeKind::Paragraph)
    );

    let removed_closing = replace_bytes(source, 12, 14, "plain");
    assert_eq!(removed_closing.snapshot.block_count(), 5);
    assert!(
        (0..removed_closing.snapshot.block_count()).all(|index| removed_closing
            .snapshot
            .block(index)
            .unwrap()
            .kind
            == NodeKind::Paragraph)
    );
}

#[test]
fn creating_or_removing_code_closer_reparses_from_the_original_opener() {
    let unclosed = "before\n``` rust begin\ncode\nstill text\nend candidate\nafter";
    let previous = parse(&TextBuffer::from_source(unclosed), &profile()).unwrap();
    let old_before = previous.block(0).unwrap().id;
    let old_after = previous.block(5).unwrap().id;
    let closed = replace(unclosed, "end candidate", "``` end");
    assert_eq!(closed.snapshot.block_count(), 3);
    assert_eq!(closed.snapshot.block(0).unwrap().id, old_before);
    assert!(matches!(
        closed.snapshot.block(1).unwrap().kind,
        NodeKind::FencedCode { closed: true, .. }
    ));
    assert_eq!(closed.snapshot.block(2).unwrap().id, old_after);

    let opened = replace(
        "before\n``` rust begin\ncode\n``` end\nafter",
        "``` end",
        "not an end",
    );
    assert_eq!(opened.snapshot.block_count(), 5);
    assert!(
        (1..opened.snapshot.block_count())
            .all(|index| opened.snapshot.block(index).unwrap().kind == NodeKind::Paragraph)
    );
}

#[test]
fn code_fence_pair_edits_match_full_parse_with_neighboring_blocks() {
    // `replace` checks the complete tree's kinds, ranges and children against
    // a fresh parse, rather than assuming the new closer affects only its line.
    for (source, needle, replacement) in [
        (
            "before\n```\n# code heading\n- code item\nclose!\nafter",
            "close!",
            "```",
        ),
        ("before\n``` ts\ncode\nclose!\n# after", "close!", "```"),
        (
            "before\n``` begin\ncode\nclose!\nafter",
            "close!",
            "``` end",
        ),
        (
            "before\n``` rust begin\ncode\nclose!\n| H |\n| --- |\n| value |",
            "close!",
            "``` end",
        ),
        (
            "before\n``` rust begin\ncode\nclose!\nafter",
            "close!",
            "``` rust end",
        ),
        (
            "before\n``` rust begin\ncode\n``` rust end\nafter",
            "rust end",
            "python end",
        ),
        (
            "before\n``` rust begin\ncode\n``` rust end\nafter",
            "rust end",
            "end",
        ),
        // A previously unmatched explicit opener must not prevent a later
        // bare-mode opener from acquiring the newly typed bare closer.
        (
            "before\n``` rust begin\n# heading\n``` ts\ncode\nclose!\nafter",
            "close!",
            "```",
        ),
        (
            "before\n``` rust begin\nfirst\nline\nlast\n``` end\nafter",
            "line",
            "```",
        ),
        (
            "before\n``` ts\nfirst\nline\nlast\n```\nafter",
            "line",
            "```",
        ),
        (
            "before\n``` rust begin\nfirst\nline\nlast\n``` end\nafter",
            "line",
            "``` ts end",
        ),
        (
            "before\n``` rust begin\nfirst\n```\nlast\n``` end\nafter",
            " begin",
            "",
        ),
        ("before\n``` ts\ncode\n```\nafter", " ts", " ts begin"),
        (
            "before\n``` rust begin\ncode\n``` end\nafter",
            "``` end",
            "```",
        ),
        (
            "before\n``` ts\ncode\n```\nafter",
            "```\nafter",
            "not a close\nafter",
        ),
        ("before\n``` ts\ncode\n```\nafter", "``` ts", "```ts"),
        ("before\n```ts\ncode\n```\nafter", "```ts", "``` ts"),
        (
            "before\n```rust begin\ncode\n``` end\nafter",
            "```rust begin",
            "``` rust begin",
        ),
        (
            "before\n``` beginlang\ncode\n```\nafter",
            "beginlang",
            "weekend",
        ),
        ("前😀\n``` ts\n代码🙂\nclose!\n# 后", "close!", "```"),
    ] {
        replace(source, needle, replacement);
    }
}

#[test]
fn labeled_closing_edits_preserve_the_code_owner_and_opening_language() {
    let source = "before\n``` rust begin\ncode\n``` rust end\nafter";
    let before = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let owner = before.block(1).unwrap().id;
    for replacement in ["python end", "end"] {
        let changed = replace(source, "rust end", replacement);
        assert_eq!(changed.snapshot.block(1).unwrap().id, owner);
        assert!(matches!(
            &changed.snapshot.block(1).unwrap().kind,
            NodeKind::FencedCode { language: Some(language), .. } if language == "rust"
        ));
    }
}

#[test]
fn adding_the_first_code_line_keeps_empty_fence_ranges_correct() {
    for source in [
        "before\n```\n```\nafter",
        "before\n``` ts begin\n``` end\nafter",
    ] {
        let from = source.find("\n```").unwrap() + 1;
        // Find the second marker, after the opening line's terminating LF.
        let from = from + source[from..].find('\n').unwrap() + 1;
        let changed = replace_bytes(source, from, from, "代码🙂\n");
        let NodeKind::FencedCode { content_range, .. } = &changed.snapshot.block(1).unwrap().kind
        else {
            panic!("first line insertion must retain the fenced block");
        };
        let after = format!("{}代码🙂\n{}", &source[..from], &source[from..]);
        assert_eq!(
            TextBuffer::from_source(&after)
                .slice(*content_range)
                .unwrap(),
            "代码🙂"
        );
    }
}

#[test]
fn adding_the_first_math_line_reparses_an_empty_opaque_source_sequence() {
    let source = "before\n$$\n$$\nafter";
    let from = source.find("\n$$\n$$").unwrap() + "\n$$\n".len();
    let changed = replace_bytes(source, from, from, "x + y\n");
    let NodeKind::MathBlock { content_range, .. } = &changed.snapshot.block(1).unwrap().kind else {
        panic!("first line insertion must retain the math block");
    };
    let after = format!("{}x + y\n{}", &source[..from], &source[from..]);
    assert_eq!(
        TextBuffer::from_source(&after)
            .slice(*content_range)
            .unwrap(),
        "x + y"
    );
}

#[test]
fn code_and_math_marker_rewrites_match_full_parse_across_short_documents() {
    const LINES: [&str; 7] = [
        "```",
        "``` ts",
        "``` begin",
        "``` end",
        "``` ts end",
        "$$",
        "text",
    ];
    for a in LINES {
        for b in LINES {
            for c in LINES {
                let lines = [a, b, c];
                let source = format!("before\n{}\nafter", lines.join("\n"));
                for line in 0..lines.len() {
                    let from =
                        "before\n".len() + lines[..line].iter().map(|s| s.len() + 1).sum::<usize>();
                    for replacement in LINES {
                        if replacement == lines[line] {
                            continue;
                        }
                        if std::panic::catch_unwind(|| {
                            replace_bytes(&source, from, from + lines[line].len(), replacement)
                        })
                        .is_err()
                        {
                            panic!(
                                "incremental mismatch for {source:?}, line {line}, replacement {replacement:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn header_row_is_local_but_header_delimiter_mismatch_rechecks_table_boundary() {
    let source = "before\n| a | b |\n| --- | --- |\n| c | d |\nafter";
    let previous = parse(&TextBuffer::from_source(source), &profile()).unwrap();
    let local = replace(source, "| a | b |", "| alpha | beta |");
    assert_eq!(
        local.snapshot.block(1).unwrap().id,
        previous.block(1).unwrap().id
    );
    assert_eq!(
        local.snapshot.block(2).unwrap().id,
        previous.block(2).unwrap().id
    );
    assert_eq!(
        local.reparsed_range,
        local
            .snapshot
            .node(local.snapshot.block(1).unwrap().children[0])
            .unwrap()
            .source_range
    );

    let mismatch = replace(source, "| a | b |", "| a | b | extra |");
    assert!(matches!(
        mismatch.snapshot.block(1).unwrap().kind,
        NodeKind::Paragraph
    ));
    assert!(mismatch.reparsed_range.from <= previous.block(1).unwrap().source_range.from);
}

#[test]
fn representative_mutations_always_equal_a_fresh_full_parse() {
    let source = concat!(
        "# heading **bold** and *italic*\n",
        "plain $x$ text\n",
        "- one\n",
        "  - nested\n",
        "- two\n",
        "\n",
        "| a | b |\n",
        "| --- | :---: |\n",
        "| c | d |\n",
        "``` rust begin\n",
        "let x = 1;\n",
        "``` end\n",
        "$$\n",
        "x + y\n",
        "$$\n",
        "tail"
    );
    let boundaries: Vec<usize> = source
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(source.len()))
        .collect();
    for &at in &boundaries {
        for inserted in ["x", "#", "|", "`", "$", "- ", "\n"] {
            let checked = std::panic::catch_unwind(|| replace_bytes(source, at, at, inserted));
            assert!(
                checked.is_ok(),
                "incremental mismatch for insertion {inserted:?} at byte {at}"
            );
        }
    }
    for window in boundaries.windows(2) {
        for replacement in ["", "语"] {
            let checked = std::panic::catch_unwind(|| {
                replace_bytes(source, window[0], window[1], replacement)
            });
            assert!(
                checked.is_ok(),
                "incremental mismatch for byte range {}..{} -> {replacement:?}",
                window[0],
                window[1]
            );
        }
    }
}

#[test]
fn background_analysis_stops_at_convergence_and_reuses_the_large_suffix() {
    let source = (0..1_000)
        .map(|index| format!("line {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let search = "line 500";
    let replacement = (0..50)
        .map(|index| format!("inserted {index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let from_byte = source.find(search).unwrap();
    let to_byte = from_byte + search.len();
    let from = u32::try_from(source[..from_byte].encode_utf16().count()).unwrap();
    let old_to = u32::try_from(source[..to_byte].encode_utf16().count()).unwrap();
    let new_to = from + u32::try_from(replacement.encode_utf16().count()).unwrap();
    let change = ChangedTextRange {
        before: TextRange::new(from, old_to),
        after: TextRange::new(from, new_to),
    };
    let old_text = TextBuffer::from_source(&source);
    let previous = parse(&old_text, &profile()).unwrap();
    let changed_source = format!(
        "{}{}{}",
        &source[..from_byte],
        replacement,
        &source[to_byte..]
    );
    let changed_text = TextBuffer::from_source(&changed_source);
    let delta = i64::from(new_to - from) - i64::from(old_to - from);
    let checkpoint = SyntaxCheckpoint::for_structural_change(&previous, change.before, delta);
    let mut session =
        SyntaxAnalysisSession::from_checkpoint(&changed_text, profile(), checkpoint).unwrap();
    let mut polls = 0;
    while !session.is_complete() {
        session.poll(WorkBudget::new(2, 2)).unwrap();
        polls += 1;
    }
    let actual = session.completed_snapshot().unwrap();
    let expected = parse(&changed_text, &profile()).unwrap();
    assert_same_syntax(&actual, &expected);
    assert_eq!(session.reused_prefix_blocks(), 499);
    assert_eq!(session.parsed_new_blocks(), 51);
    assert_eq!(session.reused_suffix_blocks(), 499);
    assert_eq!(polls, 26);
    assert!(session.reparsed_range().to < changed_text.utf16_len());
}

fn first_node_id(snapshot: &SyntaxSnapshot, predicate: impl Fn(&NodeKind) -> bool) -> NodeId {
    snapshot
        .nodes()
        .iter()
        .find(|node| predicate(&node.kind))
        .map(|node| node.id)
        .expect("expected syntax node")
}
