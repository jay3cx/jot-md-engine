use crate::common::assert_same_syntax;
use editor_engine::EditorDocument;
use editor_engine::syntax::NodeKind;
use editor_engine::syntax::{CompiledSyntaxProfile, parse};
use editor_protocol::{
    AnalysisRequest, ConcreteEolKind, DocumentId, DocumentTransaction, NewlinePolicy, Revision,
    TextEdit, TextRange, TransactionId, TransactionOrigin,
};

#[test]
fn public_api_preserves_revision_and_snapshot_invariants() {
    let mut document = EditorDocument::open(
        DocumentId("integration-document".to_owned()),
        "first\r\nsecond",
        Default::default(),
    )
    .unwrap();

    let patch = document
        .apply_transaction(&DocumentTransaction {
            id: TransactionId("integration-transaction".to_owned()),
            base_revision: Revision(0),
            origin: TransactionOrigin::Keyboard,
            edits: vec![TextEdit {
                range: TextRange::new(5, 5),
                insert: "!".to_owned(),
            }],
            newline_policy: NewlinePolicy::Configured {
                eol: ConcreteEolKind::Lf,
            },
            selection_before: None,
            selection_after: None,
            history: Default::default(),
            metadata: None,
            analysis: None,
        })
        .unwrap();

    let snapshot = document.snapshot(patch.revision).unwrap();
    assert_eq!(snapshot.text, "first!\nsecond");
    assert_eq!(snapshot.line_endings.len(), 2);
    assert_eq!(snapshot.revision, Revision(1));
}

#[test]
fn analysis_transaction_creating_a_code_closer_restarts_at_the_opener() {
    let source = "before\n``` rust begin\ncode\nstill text\nend candidate\nafter";
    let mut document = EditorDocument::open(
        DocumentId("fence-transaction".to_owned()),
        source,
        Default::default(),
    )
    .unwrap();
    let previous = document.syntax_state().complete_snapshot().unwrap().clone();
    let old_suffix = previous.block(5).unwrap().id;
    let from = u32::try_from(source.find("end candidate").unwrap()).unwrap();
    let to = from + u32::try_from("end candidate".len()).unwrap();
    document
        .apply_transaction(&DocumentTransaction {
            id: TransactionId("close-fence".to_owned()),
            base_revision: Revision(0),
            origin: TransactionOrigin::Keyboard,
            edits: vec![TextEdit {
                range: TextRange::new(from, to),
                insert: "``` end".to_owned(),
            }],
            newline_policy: NewlinePolicy::Configured {
                eol: ConcreteEolKind::Lf,
            },
            selection_before: None,
            selection_after: None,
            history: Default::default(),
            metadata: None,
            analysis: Some(AnalysisRequest::default()),
        })
        .unwrap();
    let snapshot = document.syntax_state().complete_snapshot().unwrap();
    assert_eq!(snapshot.block_count(), 3);
    assert!(matches!(
        snapshot.block(1).unwrap().kind,
        NodeKind::FencedCode { closed: true, .. }
    ));
    assert_eq!(snapshot.block(2).unwrap().id, old_suffix);
}

#[test]
fn table_boundary_transactions_match_fresh_parse_after_every_edit() {
    let original = "| h |\n| --- |\n| abcdef |\n\nafter\nnext";
    // Exercise the public transaction path, including edits that consume the
    // last row's terminator, following blank line, or part of the next block.
    for analysis in [None, Some(AnalysisRequest::default())] {
        for end in [24, 25, 26, 29, original.len() as u32] {
            for replacement in ["", "| x |", "plain\n", "| x |\n| y |\n"] {
                let mut document = EditorDocument::open(
                    DocumentId("table-boundary".into()),
                    original,
                    Default::default(),
                )
                .unwrap();
                let mut revision = Revision(0);
                // Follow the structural edit with more edits in the same
                // document so a stale node index/range cannot hide behind open().
                for (step, (range, insert)) in [
                    (TextRange::new(14, end), replacement),
                    (TextRange::new(0, 0), "prefix\n"),
                    (TextRange::new(0, 6), "heading"),
                    (TextRange::new(0, 8), ""),
                ]
                .into_iter()
                .enumerate()
                {
                    let patch = document
                        .apply_transaction(&DocumentTransaction {
                            id: TransactionId(format!("boundary-{step}")),
                            base_revision: revision,
                            origin: TransactionOrigin::Keyboard,
                            edits: vec![TextEdit {
                                range,
                                insert: insert.into(),
                            }],
                            newline_policy: Default::default(),
                            selection_before: None,
                            selection_after: None,
                            history: Default::default(),
                            metadata: None,
                            analysis: analysis.clone(),
                        })
                        .unwrap_or_else(|error| {
                            panic!("end={end} replacement={replacement:?} step={step}: {error:?}")
                        });
                    revision = patch.revision;
                    let expected = parse(
                        document.text(),
                        &CompiledSyntaxProfile::compile(Default::default()),
                    )
                    .unwrap();
                    let actual = document.syntax_state().complete_snapshot().unwrap();
                    assert_same_syntax(actual, &expected);
                    assert_eq!(
                        document.snapshot(revision).unwrap().text,
                        document.text().snapshot()
                    );
                }
            }
        }
    }
}

#[test]
fn replacing_a_large_table_with_code_preserves_the_complete_heading() {
    let original = format!(
        "# 大表格\n\n| 序号 | 名称 | 说明 |\n| --- | --- | --- |\n{}\n\n表格结束。",
        (0..2000)
            .map(|i| format!("| {i} | 项目 {i} | 可编辑内容 |\n"))
            .collect::<String>()
    );
    let replacement = format!(
        "# 大代码块\n\n``` ts begin\n{}\n``` end\n\n代码结束。",
        (0..10000)
            .map(|i| format!("const value{i} = {i};\n"))
            .collect::<String>()
    );
    for analysis in [None, Some(AnalysisRequest::default())] {
        let mut document = EditorDocument::open(
            DocumentId("replace-large".into()),
            &original,
            Default::default(),
        )
        .unwrap();
        document
            .apply_transaction(&DocumentTransaction {
                id: TransactionId("replace".into()),
                base_revision: Revision(0),
                origin: TransactionOrigin::Keyboard,
                edits: vec![TextEdit {
                    range: TextRange::new(0, original.encode_utf16().count() as u32),
                    insert: replacement.clone(),
                }],
                newline_policy: Default::default(),
                selection_before: None,
                selection_after: None,
                history: Default::default(),
                metadata: None,
                analysis,
            })
            .unwrap();
        while document.syntax_state().complete_snapshot().is_none() {
            let editor_engine::SyntaxState::Partial { analysis_id, .. } = document.syntax_state()
            else {
                panic!("expected partial")
            };
            let id = analysis_id.clone();
            document
                .process_analysis_queue(
                    Revision(1),
                    &id,
                    editor_protocol::AnalysisWorkBudget {
                        max_source_lines: 256,
                        max_blocks: 64,
                        max_utf16_units: 32768,
                    },
                )
                .unwrap();
        }
        let actual = document.syntax_state().complete_snapshot().unwrap();
        let expected = parse(
            document.text(),
            &CompiledSyntaxProfile::compile(Default::default()),
        )
        .unwrap();
        assert_same_syntax(actual, &expected);
        assert_eq!(actual.block(0).unwrap().source_range, TextRange::new(0, 6));
    }
}
