use editor_engine::{
    syntax::{CompiledSyntaxProfile, NodeKind, SyntaxSnapshot, parse},
    text::TextBuffer,
};
use editor_protocol::TextRange;

fn node(
    syntax: &SyntaxSnapshot,
    id: editor_engine::syntax::NodeId,
) -> &editor_engine::syntax::SyntaxNode {
    syntax.node(id).expect("syntax node must exist")
}

#[test]
fn heading_contains_strong_and_emphasis_inline_children() {
    let text = TextBuffer::from_source("# title **bold** and *italic* ###");
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let syntax = parse(&text, &profile).unwrap();
    let heading = syntax.block(0).unwrap();

    assert_eq!(heading.kind, NodeKind::Heading { level: 1 });
    assert_eq!(heading.source_range, TextRange::new(0, 33));
    let inline_kinds: Vec<_> = heading
        .children
        .iter()
        .map(|id| &node(&syntax, *id).kind)
        .collect();
    assert_eq!(
        inline_kinds,
        vec![
            &NodeKind::Text,
            &NodeKind::Strong,
            &NodeKind::Text,
            &NodeKind::Emphasis,
        ]
    );
}

#[test]
fn heading_rule_has_priority_over_paragraph_fallback() {
    let text = TextBuffer::from_source("before\n## heading\nafter");
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let syntax = parse(&text, &profile).unwrap();

    assert_eq!(syntax.block_count(), 3);
    assert_eq!(syntax.block(0).unwrap().kind, NodeKind::Paragraph);
    assert_eq!(
        syntax.block(1).unwrap().kind,
        NodeKind::Heading { level: 2 }
    );
    assert_eq!(syntax.block(2).unwrap().kind, NodeKind::Paragraph);
}

#[test]
fn heading_list_and_thematic_break_openers_have_deterministic_priority() {
    let text = TextBuffer::from_source("# - heading text\n- # list text\n* * *");
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let syntax = parse(&text, &profile).unwrap();

    assert_eq!(syntax.block_count(), 3);
    assert_eq!(
        syntax.block(0).unwrap().kind,
        NodeKind::Heading { level: 1 }
    );
    assert!(matches!(
        syntax.block(1).unwrap().kind,
        NodeKind::ListItem {
            indent_columns: 0,
            ..
        }
    ));
    assert_eq!(syntax.block(2).unwrap().kind, NodeKind::ThematicBreak);
}
