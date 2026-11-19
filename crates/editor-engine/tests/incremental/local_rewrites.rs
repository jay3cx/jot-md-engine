use crate::common::assert_same_syntax;
use std::collections::HashSet;

use editor_engine::{
    EditorDocument,
    syntax::{
        CompiledSyntaxProfile, parse, reparse_change, try_reparse_fast, try_reparse_inline_in_place,
    },
    text::TextBuffer,
};
use editor_protocol::{
    AnalysisRequest, ChangedTextRange, DocumentId, DocumentTransaction, ExtensionVersion, Revision,
    SyntaxProfile, TextEdit, TextRange, TransactionId, TransactionOrigin,
};

fn profile() -> CompiledSyntaxProfile {
    CompiledSyntaxProfile::compile(Default::default())
}

fn edited(
    source: &str,
    needle: &str,
    replacement: &str,
) -> (TextBuffer, TextBuffer, ChangedTextRange) {
    assert_eq!(source.matches(needle).count(), 1);
    let byte = source.find(needle).unwrap();
    let from = source[..byte].encode_utf16().count() as u32;
    let before_to = from + needle.encode_utf16().count() as u32;
    let after_to = from + replacement.encode_utf16().count() as u32;
    let after = format!(
        "{}{}{}",
        &source[..byte],
        replacement,
        &source[byte + needle.len()..]
    );
    (
        TextBuffer::from_source(source),
        TextBuffer::from_source(&after),
        ChangedTextRange {
            before: TextRange::new(from, before_to),
            after: TextRange::new(from, after_to),
        },
    )
}

#[test]
fn task_strike_escape_and_link_edits_match_full_parse() {
    for (source, needle, replacement) in [
        ("before\n- [ ] 任务\nafter", "[ ]", "[x]"),
        ("before\n- [x] 任务\nafter", "[x]", "[z]"),
        ("before\n~~删除 *斜体*~~\nafter", "~~删除", "~删除"),
        ("before\n~~删除 *斜体*~~\nafter", "删除", r"\~删除"),
        (
            "before\n[链接](https://example.com/a_(b))\nafter",
            "(b)",
            "(中文😀)",
        ),
        ("before\n<https://example.com>\nafter", ">", ""),
    ] {
        let (before, after, change) = edited(source, needle, replacement);
        let mut snapshot = parse(&before, &profile()).unwrap();
        let before_id = snapshot.block(0).unwrap().id;
        let after_id = snapshot.block(2).unwrap().id;
        if try_reparse_inline_in_place(
            &mut snapshot,
            &before,
            &after,
            change,
            needle,
            replacement,
            &profile(),
        )
        .unwrap()
        .is_none()
        {
            snapshot = reparse_change(
                &snapshot,
                &before,
                &after,
                change,
                needle,
                replacement,
                &profile(),
            )
            .unwrap()
            .snapshot;
        }
        assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
        assert_eq!(snapshot.block(0).unwrap().id, before_id, "{source}");
        assert_eq!(snapshot.block(2).unwrap().id, after_id, "{source}");
    }
}

#[test]
fn opt_in_fence_compatibility_edits_match_full_reparse() {
    let compatibility = CompiledSyntaxProfile::compile(SyntaxProfile {
        enabled_extensions: vec![ExtensionVersion {
            id: "commonmark-fence-language".into(),
            version: "1.0.0".into(),
        }],
        ..Default::default()
    });
    let cases = [
        (
            "before\n```mermaid\ngantt\n```\n# after",
            "```mermaid",
            "``` mermaid",
        ),
        (
            "before\n``` mermaid\ngantt\n```\n# after",
            "``` mermaid",
            "```mermaid",
        ),
        (
            "before\n```mermaid\ngantt\n```\n# after",
            "gantt",
            "gantt\n```\nmore",
        ),
        ("before\n```mermaid\ngantt\n# after", "gantt", "gantt\n```"),
        (
            "before\n```mermaid\ngantt\n```\n# after",
            "```mermaid",
            "```mermaid begin",
        ),
        (
            "before\n```mermaid\ngantt\n```\n# after",
            "gantt",
            "gantt 中文😀",
        ),
    ];
    for profile in [profile(), compatibility] {
        for (source, needle, replacement) in cases {
            let (before, after, change) = edited(source, needle, replacement);
            let original = parse(&before, &profile).unwrap();
            let result = reparse_change(
                &original,
                &before,
                &after,
                change,
                needle,
                replacement,
                &profile,
            )
            .unwrap();
            assert_same_syntax(&result.snapshot, &parse(&after, &profile).unwrap());
        }
    }
}

#[test]
fn fence_compatibility_local_edit_matrix_matches_full_reparse() {
    let compatibility = CompiledSyntaxProfile::compile(SyntaxProfile {
        enabled_extensions: vec![ExtensionVersion {
            id: "commonmark-fence-language".into(),
            version: "1.0.0".into(),
        }],
        ..Default::default()
    });
    let source = "intro\n```mermaid\ngantt\n```\n## after\n``` js begin\nlet x=1\n``` end\ntail";
    for profile in [profile(), compatibility] {
        let before = TextBuffer::from_source(source);
        let original = parse(&before, &profile).unwrap();
        let mut offsets: Vec<usize> = source.char_indices().map(|(offset, _)| offset).collect();
        offsets.push(source.len());
        for &byte in &offsets {
            for replacement in [" ", "x", "`", "\n", "😀"] {
                let from = source[..byte].encode_utf16().count() as u32;
                let after = TextBuffer::from_source(&format!(
                    "{}{}{}",
                    &source[..byte],
                    replacement,
                    &source[byte..]
                ));
                let change = ChangedTextRange {
                    before: TextRange::new(from, from),
                    after: TextRange::new(from, from + replacement.encode_utf16().count() as u32),
                };
                let mut snapshot = original.clone();
                if try_reparse_inline_in_place(
                    &mut snapshot,
                    &before,
                    &after,
                    change,
                    "",
                    replacement,
                    &profile,
                )
                .unwrap()
                .is_none()
                {
                    snapshot = reparse_change(
                        &snapshot,
                        &before,
                        &after,
                        change,
                        "",
                        replacement,
                        &profile,
                    )
                    .unwrap()
                    .snapshot;
                }
                assert_same_syntax(&snapshot, &parse(&after, &profile).unwrap());
            }
            if byte < source.len() {
                let size = source[byte..].chars().next().unwrap().len_utf8();
                let removed = &source[byte..byte + size];
                let from = source[..byte].encode_utf16().count() as u32;
                let after = TextBuffer::from_source(&format!(
                    "{}{}",
                    &source[..byte],
                    &source[byte + size..]
                ));
                let change = ChangedTextRange {
                    before: TextRange::new(from, from + removed.encode_utf16().count() as u32),
                    after: TextRange::new(from, from),
                };
                let mut snapshot = original.clone();
                if try_reparse_inline_in_place(
                    &mut snapshot,
                    &before,
                    &after,
                    change,
                    removed,
                    "",
                    &profile,
                )
                .unwrap()
                .is_none()
                {
                    snapshot =
                        reparse_change(&snapshot, &before, &after, change, removed, "", &profile)
                            .unwrap()
                            .snapshot;
                }
                assert_same_syntax(&snapshot, &parse(&after, &profile).unwrap());
            }
        }
    }
}

#[test]
fn fixed_range_rewrites_match_full_parse_across_owners_and_inline_kinds() {
    for source in [
        "before\nplain TARGET and *untouched*\nafter",
        "before\n# title TARGET and *untouched*\nafter",
        "before\n- item TARGET and *untouched*\nafter",
        "before\n  7) item TARGET and *untouched*\nafter",
        "before\n> > quote TARGET and *untouched*\n> other line\nafter",
        "before\n| TARGET | header |\n| --- | --- |\n| body | stable |\nafter",
        "before\n| header | header |\n| --- | --- |\n| TARGET | stable |\nafter",
        "before\nplain **TARGET** and *untouched*\nafter",
        "before\nplain [TARGET](https://example.test) and *untouched*\nafter",
        "before\nplain ![TARGET](/image.svg) and *untouched*\nafter",
        "before\nplain `TARGET` and *untouched*\nafter",
        "before\nplain $TARGET$ and *untouched*\nafter",
    ] {
        for replacement in ["SAMPLE", "中文中文中文", "😀😀😀"] {
            let (before, after, change) = edited(source, "TARGET", replacement);
            let mut snapshot = parse(&before, &profile()).unwrap();
            let original = snapshot.clone();
            let root_children = original.root().children.clone();
            let result = try_reparse_inline_in_place(
                &mut snapshot,
                &before,
                &after,
                change,
                "TARGET",
                replacement,
                &profile(),
            )
            .unwrap();
            assert!(result.is_some(), "expected local rewrite for {source}");
            assert_eq!(snapshot.root().children, root_children);
            assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
            for node in original.nodes() {
                if node.source_range.to < change.before.from
                    || node.source_range.from > change.before.to
                {
                    assert_eq!(
                        snapshot.node(node.id),
                        Some(node),
                        "unrelated node changed for {source}"
                    );
                }
            }
        }
    }
}

#[test]
fn length_changes_and_point_typing_keep_semantics_and_suffix_versions() {
    for source in [
        "before\nplain TARGET and *stable*\nafter",
        "before\n# title TARGET and *stable*\nafter",
        "before\n- item TARGET and *stable*\nafter",
        "before\n> > quote TARGET and *stable*\n> next line\nafter",
        "before\n| head |\n| --- |\n| TARGET |\nafter",
    ] {
        for replacement in ["longer 中文😀 replacement", "x"] {
            let (before, after, change) = edited(source, "TARGET", replacement);
            let mut snapshot = parse(&before, &profile()).unwrap();
            let roots = snapshot.root().children.clone();
            let old_suffix = snapshot.block(snapshot.block_count() - 1).unwrap().clone();
            assert!(
                try_reparse_inline_in_place(
                    &mut snapshot,
                    &before,
                    &after,
                    change,
                    "TARGET",
                    replacement,
                    &profile()
                )
                .unwrap()
                .is_some()
            );
            assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
            assert_eq!(snapshot.root().children, roots);
            assert_eq!(
                snapshot.node(old_suffix.id).unwrap().content_version,
                old_suffix.content_version
            );
        }
        let byte = source.find("TARGET").unwrap() + 3;
        let from = source[..byte].encode_utf16().count() as u32;
        let next = format!("{}😀{}", &source[..byte], &source[byte..]);
        let before = TextBuffer::from_source(source);
        let after = TextBuffer::from_source(&next);
        let mut snapshot = parse(&before, &profile()).unwrap();
        assert!(
            try_reparse_inline_in_place(
                &mut snapshot,
                &before,
                &after,
                ChangedTextRange {
                    before: TextRange::new(from, from),
                    after: TextRange::new(from, from + 2)
                },
                "",
                "😀",
                &profile()
            )
            .unwrap()
            .is_some()
        );
        assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
    }
}

#[test]
fn inline_topology_rewrites_retire_slots_without_reusing_ids() {
    let mut source = "before\nxxboldxx and *stable*\nafter".to_owned();
    let mut snapshot = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    let roots = snapshot.root().children.clone();
    let mut retired = HashSet::new();
    for iteration in 0..100 {
        let (needle, replacement) = if iteration % 2 == 0 {
            ("xxboldxx", "**bold**")
        } else {
            ("**bold**", "xxboldxx")
        };
        let (before, after, change) = edited(&source, needle, replacement);
        let old_ids: HashSet<_> = snapshot.nodes().iter().map(|node| node.id).collect();
        assert!(
            try_reparse_inline_in_place(
                &mut snapshot,
                &before,
                &after,
                change,
                needle,
                replacement,
                &profile()
            )
            .unwrap()
            .is_some()
        );
        let new_ids: HashSet<_> = snapshot.nodes().iter().map(|node| node.id).collect();
        assert!(
            new_ids.is_disjoint(&retired),
            "retired node ID was resurrected"
        );
        retired.extend(old_ids.difference(&new_ids).copied());
        assert_eq!(snapshot.root().children, roots);
        assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
        for id in &retired {
            assert!(snapshot.node(*id).is_none());
        }
        source = source.replacen(needle, replacement, 1);
    }
    assert!(!retired.is_empty());
}

#[test]
fn allocator_history_survives_switching_between_local_and_detached_updates() {
    let mut source = "before\nxxboldxx and *stable*\nafter".to_owned();
    let mut snapshot = parse(&TextBuffer::from_source(&source), &profile()).unwrap();
    let mut retired = HashSet::new();
    for _ in 0..20 {
        for (needle, replacement) in [
            ("xxboldxx", "**bold**"),
            ("**bold**", "xxboldxx"),
            ("xxboldxx", "xxboldxx|"),
            ("xxboldxx|", "xxboldxx"),
        ] {
            let (before, after, change) = edited(&source, needle, replacement);
            let old_ids: HashSet<_> = snapshot.nodes().iter().map(|node| node.id).collect();
            let local = try_reparse_inline_in_place(
                &mut snapshot,
                &before,
                &after,
                change,
                needle,
                replacement,
                &profile(),
            )
            .unwrap();
            if needle.contains('|') || replacement.contains('|') {
                assert!(local.is_none());
            }
            if local.is_none() {
                snapshot = reparse_change(
                    &snapshot,
                    &before,
                    &after,
                    change,
                    needle,
                    replacement,
                    &profile(),
                )
                .unwrap()
                .snapshot;
            }
            let new_ids: HashSet<_> = snapshot.nodes().iter().map(|node| node.id).collect();
            assert!(
                new_ids.is_disjoint(&retired),
                "fallback reset the allocator high-water mark"
            );
            retired.extend(old_ids.difference(&new_ids).copied());
            assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
            source = source.replacen(needle, replacement, 1);
        }
    }
}

#[test]
fn structural_or_boundary_changes_decline_without_mutating_the_tree() {
    for (source, needle, replacement) in [
        ("before\nordinary\nafter", "ordinary", "# title!"),
        ("before\nnot end\nafter", "not end", "``` end"),
        (
            "before\n``` rust begin\ncode\nnot end\nafter",
            "not end",
            "``` end",
        ),
        ("before\n$$\nx+y\nxx\nafter", "xx", "$$"),
        ("before\n$$\nx+y\n$$\nafter", "x+y", "a+b"),
        (
            "before\n``` rust begin\ncode\n``` end\nafter",
            "code",
            "next",
        ),
        ("before\n# title\nafter", "# title", "##title"),
        ("before\n- item\nafter", "- item", "+ item"),
        ("before\nplain\nafter", "plain", "pl\nin"),
        ("| header |\n| --- |\n| TARGET |", "TARGET", "  RGET"),
        ("| header |\n| --- |\n| TARGET |", "TARGET", "T|RGET"),
        ("| A | B |\n| --- | --- |\n| a\\x| b |", "x", ""),
    ] {
        let (before, after, change) = edited(source, needle, replacement);
        let mut snapshot = parse(&before, &profile()).unwrap();
        let original = snapshot.clone();
        assert!(
            try_reparse_inline_in_place(
                &mut snapshot,
                &before,
                &after,
                change,
                needle,
                replacement,
                &profile()
            )
            .unwrap()
            .is_none(),
            "unsafe fast path for {source}"
        );
        assert_eq!(
            snapshot, original,
            "declined plan must leave all state intact"
        );
    }
}

#[test]
fn public_transactions_keep_marker_and_pipe_fallback_semantics() {
    for analysis in [None, Some(AnalysisRequest::default())] {
        for (source, needle, replacement) in [
            ("| A | B |\n| --- | --- |\n| a\\x| b |", "x", ""),
            (
                "before\n``` rust begin\ncode\nnot end\n# heading\nafter",
                "not end",
                "``` end",
            ),
            (
                "before\n``` rust begin\ncode\n``` end\n# heading\nafter",
                "``` end",
                "not end",
            ),
            (
                "before\n``` ts\ncode\nnot end\n# heading\nafter",
                "not end",
                "```",
            ),
            (
                "before\n``` rust begin\ncode\nnot end\n# heading\nafter",
                "not end",
                "``` rust end",
            ),
            (
                "before\n``` ts\ncode\n```\n# heading\nafter",
                "``` ts",
                "```ts",
            ),
            ("before\n$$\nx+y\nxx\n# heading\nafter", "xx", "$$"),
            (
                "before\n$$\nx+y\n$$\n# heading\nafter",
                "x+y\n$$",
                "x+y\nxx",
            ),
        ] {
            let (_, after, change) = edited(source, needle, replacement);
            let mut document = EditorDocument::open(
                DocumentId("local-fallback".into()),
                source,
                Default::default(),
            )
            .unwrap();
            let patch = document
                .apply_transaction(&DocumentTransaction {
                    id: TransactionId("edit".into()),
                    base_revision: Revision(0),
                    origin: TransactionOrigin::Keyboard,
                    edits: vec![TextEdit {
                        range: change.before,
                        insert: replacement.into(),
                    }],
                    newline_policy: Default::default(),
                    selection_before: None,
                    selection_after: None,
                    history: Default::default(),
                    metadata: None,
                    analysis: analysis.clone(),
                })
                .unwrap();
            assert_eq!(
                document.snapshot(patch.revision).unwrap().text,
                after.snapshot()
            );
            assert_same_syntax(
                document.syntax_state().complete_snapshot().unwrap(),
                &parse(&after, &profile()).unwrap(),
            );
        }
    }
}

#[test]
fn public_compatibility_profile_reparses_new_and_removed_closers() {
    let settings = SyntaxProfile {
        enabled_extensions: vec![ExtensionVersion {
            id: "commonmark-fence-language".into(),
            version: "1.0.0".into(),
        }],
        ..Default::default()
    };
    for analysis in [None, Some(AnalysisRequest::default())] {
        for (source, needle, replacement) in [
            (
                "before\n```mermaid\ngantt\nnot-closed\n# after",
                "not-closed",
                "```",
            ),
            (
                "before\n```mermaid\ngantt\n```\n# after",
                "gantt\n```",
                "gantt\nnot-closed",
            ),
            (
                "before\n```mermaid\ngantt\n```\n# after",
                "```mermaid",
                "```mermaid begin",
            ),
        ] {
            let (_, after, change) = edited(source, needle, replacement);
            let mut document =
                EditorDocument::open(DocumentId("compat-public".into()), source, settings.clone())
                    .unwrap();
            let patch = document
                .apply_transaction(&DocumentTransaction {
                    id: TransactionId("edit".into()),
                    base_revision: Revision(0),
                    origin: TransactionOrigin::Keyboard,
                    edits: vec![TextEdit {
                        range: change.before,
                        insert: replacement.into(),
                    }],
                    newline_policy: Default::default(),
                    selection_before: None,
                    selection_after: None,
                    history: Default::default(),
                    metadata: None,
                    analysis: analysis.clone(),
                })
                .unwrap();
            assert_eq!(
                document.snapshot(patch.revision).unwrap().text,
                after.snapshot()
            );
            assert_same_syntax(
                document.syntax_state().complete_snapshot().unwrap(),
                &parse(&after, &CompiledSyntaxProfile::compile(settings.clone())).unwrap(),
            );
        }
    }
}

#[test]
fn deep_table_lookup_preserves_the_large_parent_and_unrelated_rows() {
    let mut source = "| head |\n| --- |\n".to_owned();
    for row in 0..20_000 {
        source.push_str(&format!("| row {row:05} |\n"));
    }
    let (before, after, change) = edited(&source, "row 19000", "row 19001");
    let mut snapshot = parse(&before, &profile()).unwrap();
    let table_id = snapshot.block(0).unwrap().id;
    let children_pointer = snapshot.node(table_id).unwrap().children.as_ptr();
    let first_row = snapshot
        .node(snapshot.node(table_id).unwrap().children[1])
        .unwrap()
        .clone();
    let result = try_reparse_inline_in_place(
        &mut snapshot,
        &before,
        &after,
        change,
        "row 19000",
        "row 19001",
        &profile(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        snapshot.node(table_id).unwrap().children.as_ptr(),
        children_pointer,
        "ancestor child vector must not be cloned"
    );
    assert_eq!(snapshot.node(first_row.id), Some(&first_row));
    assert!(
        result
            .projection_changes
            .iter()
            .any(|patch| patch.parent_id == table_id.0.to_string()
                && patch.from == 19_001
                && patch.remove_count == 1)
    );
    assert_same_syntax(&snapshot, &parse(&after, &profile()).unwrap());
}

#[test]
#[ignore = "manual release timing; excludes fixture construction and snapshot cloning"]
fn benchmark_local_tree_rewrites() {
    use std::{hint::black_box, time::Instant};
    for count in [100, 10_000, 100_000] {
        let source = (0..count)
            .map(|index| format!("paragraph {index:06} **bold** and *stable*\n"))
            .collect::<String>();
        let needle = format!("paragraph {:06}", count / 2);
        let syntax_profile = profile();
        let snapshot = parse(&TextBuffer::from_source(&source), &syntax_profile).unwrap();
        for (mode, replacement) in [
            ("fixed", format!("Paragraph {:06}", count / 2)),
            ("grow", format!("X{needle}")),
        ] {
            let (before, after, change) = edited(&source, &needle, &replacement);
            let mut local = Vec::new();
            let mut detached = Vec::new();
            for _ in 0..5 {
                let mut owned = snapshot.clone();
                let started = Instant::now();
                let result = try_reparse_inline_in_place(
                    &mut owned,
                    &before,
                    &after,
                    change,
                    &needle,
                    &replacement,
                    &syntax_profile,
                )
                .unwrap()
                .unwrap();
                local.push(started.elapsed().as_secs_f64() * 1000.0);
                black_box(result);
                let started = Instant::now();
                let result = try_reparse_fast(
                    &snapshot,
                    &before,
                    &after,
                    change,
                    &needle,
                    &replacement,
                    &syntax_profile,
                )
                .unwrap()
                .unwrap();
                detached.push(started.elapsed().as_secs_f64() * 1000.0);
                black_box(result);
            }
            local.sort_by(f64::total_cmp);
            detached.sort_by(f64::total_cmp);
            println!(
                "mode={mode} roots={count} nodes={} local_ms={:.4} detached_ms={:.4}",
                snapshot.nodes().len(),
                local[2],
                detached[2]
            );
        }
    }
}
