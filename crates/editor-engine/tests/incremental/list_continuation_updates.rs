use crate::common::assert_same_syntax;
use editor_engine::{
    EditorDocument, SyntaxState,
    syntax::{CompiledSyntaxProfile, parse},
};
use editor_protocol::{
    AnalysisRequest, AnalysisWorkBudget, DocumentId, DocumentTransaction, Revision, TextEdit,
    TextRange, TransactionId, TransactionOrigin,
};

fn apply(
    document: &mut EditorDocument,
    needle: &str,
    insert: &str,
    analysis: Option<AnalysisRequest>,
) {
    let source = document.text().snapshot();
    let byte = source.find(needle).unwrap();
    let from = source[..byte].encode_utf16().count() as u32;
    document
        .apply_transaction(&DocumentTransaction {
            id: TransactionId("continuation-edit".into()),
            base_revision: Revision(0),
            origin: TransactionOrigin::Keyboard,
            edits: vec![TextEdit {
                range: TextRange::new(from, from + needle.encode_utf16().count() as u32),
                insert: insert.into(),
            }],
            newline_policy: Default::default(),
            selection_before: None,
            selection_after: None,
            history: Default::default(),
            metadata: None,
            analysis,
        })
        .unwrap();
    while let SyntaxState::Partial { analysis_id, .. } = document.syntax_state() {
        let id = analysis_id.clone();
        document
            .process_analysis_queue(
                Revision(1),
                &id,
                AnalysisWorkBudget {
                    max_source_lines: 128,
                    max_blocks: 128,
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
}

#[test]
fn changes_to_hard_breaks_and_indentation_recompute_neighbour_ownership() {
    for (source, needle, insert) in [
        ("- alpha\n  beta\nTAIL", "alpha", "alpha  "),
        ("- alpha \n  beta\nTAIL", "alpha ", "alpha  "),
        ("- alpha  \n  beta\nTAIL", "alpha  ", "alpha "),
        ("- alpha  \n  beta\nTAIL", "alpha  ", "alpha"),
        ("- alpha  \nbeta\nTAIL", "beta", "  beta"),
        ("- alpha  \n  beta\nTAIL", "  beta", "beta"),
        ("- alpha  \n  beta\nTAIL", "  beta", "  - beta"),
        ("- alpha  \n  beta\nTAIL", "beta", "中文😀"),
        ("- alpha  \n  beta  \n  gamma\nTAIL", "beta", "middle"),
        ("- alpha  \n  beta  \n  gamma\nTAIL", "gamma", "end"),
        ("- alpha  \n  beta\nTAIL", "beta", ""),
        ("- alpha  \n  beta", "beta", ""),
        ("- alpha  \n  beta\n", "alpha  ", "alpha"),
        ("> - alpha\n>   beta\nTAIL", "alpha", "alpha  "),
        ("> - alpha  \n>   beta\nTAIL", "alpha  ", "alpha"),
    ] {
        for analysis in [None, Some(AnalysisRequest::default())] {
            let mut document = EditorDocument::open(
                DocumentId("continuation-oracle".into()),
                source,
                Default::default(),
            )
            .unwrap();
            apply(&mut document, needle, insert, analysis);
        }
    }
}

#[test]
fn indentation_edit_revisits_the_last_confirmed_item_of_a_partial_prefix() {
    let source = "- alpha  \nbeta\nTAIL";
    let request = AnalysisRequest {
        initial_budget: AnalysisWorkBudget {
            max_source_lines: 1,
            max_blocks: 1,
            max_utf16_units: 128,
        },
        ..Default::default()
    };
    let mut document = EditorDocument::open_with_analysis(
        DocumentId("partial-list".into()),
        source,
        Default::default(),
        &request,
    )
    .unwrap();
    let SyntaxState::Partial { prefix, .. } = document.syntax_state() else {
        panic!("expected a partial prefix");
    };
    assert_eq!(prefix.block_count(), 1);
    apply(
        &mut document,
        "beta",
        "  beta",
        Some(AnalysisRequest::default()),
    );
    assert_eq!(
        document
            .syntax_state()
            .complete_snapshot()
            .unwrap()
            .block_count(),
        2
    );
}
