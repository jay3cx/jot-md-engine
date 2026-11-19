use crate::common::assert_same_syntax;
use editor_engine::{
    EditorDocument,
    syntax::{CompiledSyntaxProfile, NodeKind, SyntaxSnapshot, parse},
    text::TextBuffer,
};
use editor_protocol::{
    AnalysisRequest, DocumentId, DocumentTransaction, Revision, TextEdit, TextRange, TransactionId,
    TransactionOrigin,
};

fn parsed(source: &str) -> SyntaxSnapshot {
    parse(
        &TextBuffer::from_source(source),
        &CompiledSyntaxProfile::compile(Default::default()),
    )
    .unwrap()
}

fn utf16(source: &str) -> u32 {
    source.encode_utf16().count() as u32
}

#[test]
fn explicit_hard_breaks_keep_multiple_lines_in_one_item() {
    let source = "- first  \n  中文😀  \n  third\n- next";
    let tree = parsed(source);
    assert_eq!(tree.block_count(), 2);
    let item = tree.block(0).unwrap();
    assert!(matches!(item.kind, NodeKind::ListItem { .. }));
    assert_eq!(
        item.source_range,
        TextRange::new(0, utf16(source.split("\n- next").next().unwrap()))
    );
    let paragraph = tree.node(item.children[0]).unwrap();
    assert!(matches!(paragraph.kind, NodeKind::Paragraph));
    let kinds: Vec<_> = paragraph
        .children
        .iter()
        .map(|id| tree.node(*id).unwrap().kind.wire_name())
        .collect();
    assert_eq!(kinds, ["text", "hard-break", "text", "hard-break", "text"]);
    let breaks: Vec<_> = paragraph
        .children
        .iter()
        .map(|id| tree.node(*id).unwrap())
        .filter(|node| matches!(node.kind, NodeKind::HardBreak))
        .map(|node| node.source_range)
        .collect();
    assert_eq!(
        breaks,
        [
            TextRange::new(7, 10),
            TextRange::new(
                utf16("- first  \n  中文😀"),
                utf16("- first  \n  中文😀  \n")
            )
        ]
    );
    let text = tree.node(paragraph.children[2]).unwrap();
    assert_eq!(
        text.source_range,
        TextRange::new(utf16("- first  \n  "), utf16("- first  \n  中文😀"))
    );
}

#[test]
fn continuation_requires_a_break_and_stops_before_every_new_marker() {
    for source in [
        "- one\n  ordinary",
        "- one  \nordinary",
        "- one  \n  - nested",
        "- one  \n  2) nested",
        "- one  \n- sibling",
    ] {
        let tree = parsed(source);
        assert_eq!(tree.block_count(), 2, "{source:?}");
        assert_eq!(
            tree.block(0).unwrap().source_range.to,
            utf16(source.lines().next().unwrap())
        );
    }
    let tree = parsed("- first  \n  second\n  ordinary\n- sibling");
    assert_eq!(tree.block_count(), 3);
    assert_eq!(
        tree.block(0).unwrap().source_range.to,
        utf16("- first  \n  second")
    );
}

#[test]
fn empty_continuation_and_tab_indentation_preserve_source_positions() {
    for source in [
        "- first  \n  ",
        "\t12) first  \n\t    continued",
        "  + first  \n    ",
    ] {
        let tree = parsed(source);
        assert_eq!(tree.block_count(), 1, "{source:?}");
        assert_eq!(tree.block(0).unwrap().source_range.to, utf16(source));
    }
    let empty_marker = parsed("-   \n  body");
    assert_eq!(
        empty_marker.block_count(),
        2,
        "marker padding is not a body hard break"
    );
}

#[test]
fn continuation_text_never_opens_a_block_container() {
    for content in ["``` js begin", "$$", "\\["] {
        let source = format!("- first  \n  {content}\nplain\n# heading");
        let tree = parsed(&source);
        assert_eq!(tree.block_count(), 3);
        let item = tree.block(0).unwrap();
        assert!(matches!(item.kind, NodeKind::ListItem { .. }));
        assert_eq!(
            item.source_range.to,
            utf16(&format!("- first  \n  {content}"))
        );
        assert!(matches!(tree.block(1).unwrap().kind, NodeKind::Paragraph));
        assert!(matches!(
            tree.block(2).unwrap().kind,
            NodeKind::Heading { .. }
        ));
    }
}

#[test]
fn continuation_edits_match_fresh_parse_and_keep_the_suffix() {
    let source = "before\n- first\n- sibling\nafter";
    let mut document = EditorDocument::open(
        DocumentId("list-hard-break".into()),
        source,
        Default::default(),
    )
    .unwrap();
    let tail = document
        .syntax_state()
        .complete_snapshot()
        .unwrap()
        .block(3)
        .unwrap()
        .id;
    let mut revision = Revision(0);
    for (step, (needle, insert)) in [
        ("first", "first  \n  second"),
        ("second", "中文😀"),
        ("中文😀", "中文😀  \n  "),
        ("中文😀  \n  ", "中文😀"),
        ("first  ", "first"),
    ]
    .into_iter()
    .enumerate()
    {
        let current = document.text().snapshot();
        let start = current.find(needle).unwrap();
        let from = utf16(&current[..start]);
        let to = from + utf16(needle);
        let patch = document
            .apply_transaction(&DocumentTransaction {
                id: TransactionId(format!("list-break-{step}")),
                base_revision: revision,
                origin: TransactionOrigin::Keyboard,
                edits: vec![TextEdit {
                    range: TextRange::new(from, to),
                    insert: insert.into(),
                }],
                newline_policy: Default::default(),
                selection_before: None,
                selection_after: None,
                history: Default::default(),
                metadata: None,
                analysis: Some(AnalysisRequest::default()),
            })
            .unwrap();
        revision = patch.revision;
        let expected = parsed(&document.text().snapshot());
        let actual = document.syntax_state().complete_snapshot().unwrap();
        assert_same_syntax(actual, &expected);
        assert_eq!(
            actual.block(actual.block_count() - 1).unwrap().id,
            tail,
            "step {step}"
        );
    }
}
