//! 人工检查入口。默认忽略，使用 `--ignored --nocapture` 打印完整过程。

use crate::common::assert_same_syntax;
use std::{env, fs, time::Instant};

use editor_engine::{
    EditorDocument,
    syntax::{CompiledSyntaxProfile, NodeId, SyntaxSnapshot, parse},
    text::TextBuffer,
};
use editor_protocol::{
    AnalysisPriority, AnalysisRequest, AnalysisState, AnalysisWorkBudget, ConcreteEolKind,
    DocumentId, DocumentTransaction, NewlinePolicy, Revision, TextEdit, TextRange, TransactionId,
    TransactionOrigin,
};

const DEFAULT_SOURCE: &str = include_str!("fixtures/manual_syntax.md");
const DEFAULT_SEARCH: &str = "nested child";
const DEFAULT_REPLACEMENT: &str = "nested child revised";

#[test]
#[ignore = "manual syntax/change inspection; run with --ignored --nocapture"]
fn print_full_syntax_and_change_trace() {
    let source = load_source();
    let search = env::var("JOT_MD_SEARCH").unwrap_or_else(|_| DEFAULT_SEARCH.to_owned());
    let replacement =
        env::var("JOT_MD_REPLACEMENT").unwrap_or_else(|_| DEFAULT_REPLACEMENT.to_owned());
    let profile = CompiledSyntaxProfile::compile(Default::default());
    let before_text = TextBuffer::from_source(&source);
    let full_started = Instant::now();
    let before_tree = parse(&before_text, &profile).expect("fixture must parse");
    let full_elapsed = full_started.elapsed();

    println!("\n================ INPUT ================");
    println!("{source}");
    println!("================ FULL TREE: BEFORE ================");
    println!(
        "utf16={} lines={} blocks={} nodes={} elapsed={:.3}ms",
        before_text.utf16_len(),
        before_text.line_count(),
        before_tree.block_count(),
        before_tree.nodes().len(),
        full_elapsed.as_secs_f64() * 1_000.0
    );
    print_tree(&before_tree, &before_text);

    let edit_range = find_utf16_range(&source, &search);
    let changed_source = source.replacen(&search, &replacement, 1);
    let changed_text = TextBuffer::from_source(&changed_source);
    let expected_started = Instant::now();
    let expected = parse(&changed_text, &profile).expect("changed fixture must fully parse");
    let expected_elapsed = expected_started.elapsed();

    println!("\n================ REQUESTED CHANGE ================");
    println!(
        "replace utf16 {}..{}: {:?} -> {:?}",
        edit_range.from, edit_range.to, search, replacement
    );

    let mut synchronous = EditorDocument::open(
        DocumentId("manual-sync".to_owned()),
        &source,
        Default::default(),
    )
    .expect("document must open");
    let sync_started = Instant::now();
    let sync_patch = synchronous
        .apply_transaction(&transaction(edit_range, &replacement, None))
        .expect("synchronous transaction must commit");
    let sync_elapsed = sync_started.elapsed();
    let synchronous_tree = synchronous
        .syntax_state()
        .complete_snapshot()
        .expect("synchronous transaction must have a complete tree");
    assert_same_syntax(synchronous_tree, &expected);

    println!("\n================ SYNCHRONOUS CHANGE ================");
    println!(
        "quick_return=false elapsed={:.3}ms",
        sync_elapsed.as_secs_f64() * 1_000.0
    );
    println!("patch={sync_patch:#?}");
    println!("final tree:");
    print_tree(synchronous_tree, synchronous.text());

    let replacement_to = edit_range.from
        + u32::try_from(replacement.encode_utf16().count()).expect("fixture is small");
    let analysis = AnalysisRequest {
        priority: AnalysisPriority {
            priority_ranges: vec![TextRange::new(edit_range.from, replacement_to)],
            visible_ranges: vec![TextRange::new(edit_range.from, replacement_to)],
            active_range: Some(TextRange::new(edit_range.from, replacement_to)),
            ..AnalysisPriority::default()
        },
        initial_budget: AnalysisWorkBudget {
            max_source_lines: 3,
            max_blocks: 1,
            max_utf16_units: 256,
        },
        ..AnalysisRequest::default()
    };
    let mut deferred = EditorDocument::open(
        DocumentId("manual-deferred".to_owned()),
        &source,
        Default::default(),
    )
    .expect("document must open");
    let deferred_started = Instant::now();
    let deferred_patch = deferred
        .apply_transaction(&transaction(edit_range, &replacement, Some(analysis)))
        .expect("deferred transaction must commit");
    let deferred_elapsed = deferred_started.elapsed();
    let initial_state = deferred
        .analysis_state(Revision(1))
        .expect("committed revision must exist");

    println!("\n================ DEFERRED QUICK RETURN ================");
    println!(
        "quick_return=true elapsed={:.3}ms",
        deferred_elapsed.as_secs_f64() * 1_000.0
    );
    println!("patch={deferred_patch:#?}");
    println!("analysis={initial_state:#?}");

    let analysis_id = deferred.syntax_state().analysis_id().clone();
    let background_started = Instant::now();
    let mut polls = 0_u32;
    if matches!(initial_state, AnalysisState::Complete { .. }) {
        println!("background=not-needed (the proven local update completed synchronously)");
    } else {
        loop {
            let (state, update) = deferred
                .process_analysis_queue(
                    Revision(1),
                    &analysis_id,
                    AnalysisWorkBudget {
                        max_source_lines: 4,
                        max_blocks: 2,
                        max_utf16_units: 256,
                    },
                )
                .expect("background analysis must advance");
            polls += 1;
            println!("\n---------------- BACKGROUND POLL {polls} ----------------");
            println!("state={state:#?}");
            println!("update={update:#?}");
            if matches!(state, AnalysisState::Complete { .. }) {
                break;
            }
            assert!(polls < 1_000, "background analysis did not converge");
        }
    }
    let background_elapsed = background_started.elapsed();
    let deferred_tree = deferred
        .syntax_state()
        .complete_snapshot()
        .expect("background analysis must finish with a complete tree");
    assert_same_syntax(deferred_tree, &expected);

    println!("\n================ DEFERRED FINAL TREE ================");
    println!(
        "polls={} background={:.3}ms independent_full_parse={:.3}ms",
        polls,
        background_elapsed.as_secs_f64() * 1_000.0,
        expected_elapsed.as_secs_f64() * 1_000.0
    );
    print_tree(deferred_tree, deferred.text());
    println!("\nVERIFIED: synchronous and deferred trees both equal a fresh full parse.");
}

#[test]
#[ignore = "manual per-syntax incremental inspection; run with --ignored --nocapture"]
fn print_incremental_scenario_matrix() {
    let scenarios = [
        (
            "heading-inline",
            "before\n# old **bold**\nafter",
            "old **",
            "new **",
        ),
        (
            "paragraph-inline",
            "before\nplain *word*\nafter",
            "word",
            "term",
        ),
        (
            "list-body",
            "- alpha\n- beta\n- gamma\nafter",
            "beta",
            "revised",
        ),
        (
            "list-change-marker",
            "- alpha\n- beta\n- gamma\nafter",
            "- beta",
            "+ beta",
        ),
        (
            "list-change-marker-after-blank",
            "- alpha\n\n+ beta\nafter",
            "+ beta",
            "- beta",
        ),
        (
            "list-indent",
            "- parent\n  - child\n- tail\nafter",
            "  - child",
            "- child",
        ),
        (
            "list-line-split",
            "- alpha\n- beta\n- gamma",
            "- beta",
            "- beta\n  continuation",
        ),
        (
            "list-increase-indent",
            "- alpha\n- beta\n- gamma",
            "- beta",
            "  - beta",
        ),
        (
            "table-row",
            "| a | b |\n| --- | --- |\n| c | d |\nafter",
            "| c | d |",
            "| c | d | e |",
        ),
        (
            "table-boundary",
            "| a | b |\n| --- | --- |\nafter",
            "| --- | --- |",
            "not a delimiter",
        ),
        (
            "table-insert-row",
            "| a | b |\n| --- | --- |\n| c | d |\n| e | f |",
            "| c | d |",
            "| c | d |\n| inserted | row |",
        ),
        (
            "code-content",
            "``` rust begin\nlet x = 1;\n``` end\nafter",
            "x = 1",
            "x = 100",
        ),
        (
            "code-opening",
            "``` rust begin\ncode\n``` end\nafter",
            "rust",
            "typescript",
        ),
        (
            "code-boundary",
            "``` rust begin\ncode\n``` end\nafter",
            "``` end",
            "``` end trailing",
        ),
        ("math-content", "$$\nx + y\n$$\nafter", "x + y", "x + y + z"),
    ];
    let profile = CompiledSyntaxProfile::compile(Default::default());
    for (name, source, search, replacement) in scenarios {
        let range = find_utf16_range(source, search);
        let changed_source = source.replacen(search, replacement, 1);
        let expected_text = TextBuffer::from_source(&changed_source);
        let expected = parse(&expected_text, &profile).expect("scenario full parse must succeed");
        let mut document = EditorDocument::open(
            DocumentId(format!("manual-{name}")),
            source,
            Default::default(),
        )
        .expect("scenario must open");
        let started = Instant::now();
        let patch = document
            .apply_transaction(&transaction(range, replacement, None))
            .expect("scenario transaction must commit");
        let elapsed = started.elapsed();
        let actual = document
            .syntax_state()
            .complete_snapshot()
            .expect("synchronous scenario must be complete");
        assert_same_syntax(actual, &expected);

        println!("\n================ SCENARIO: {name} ================");
        println!("change={search:?} -> {replacement:?}");
        println!(
            "elapsed={:.3}ms patch={patch:#?}",
            elapsed.as_secs_f64() * 1_000.0
        );
        print_tree(actual, document.text());
        println!("VERIFIED: incremental == full parse");
    }
}

fn load_source() -> String {
    match env::var("JOT_MD_FILE") {
        Ok(path) => fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read JOT_MD_FILE {path:?}: {error}")),
        Err(_) => DEFAULT_SOURCE.to_owned(),
    }
}

fn transaction(
    range: TextRange,
    replacement: &str,
    analysis: Option<AnalysisRequest>,
) -> DocumentTransaction {
    DocumentTransaction {
        id: TransactionId("manual-change".to_owned()),
        base_revision: Revision(0),
        origin: TransactionOrigin::Keyboard,
        edits: vec![TextEdit {
            range,
            insert: replacement.to_owned(),
        }],
        newline_policy: NewlinePolicy::Configured {
            eol: ConcreteEolKind::Lf,
        },
        selection_before: None,
        selection_after: None,
        history: Default::default(),
        metadata: None,
        analysis,
    }
}

fn find_utf16_range(source: &str, search: &str) -> TextRange {
    let from_byte = source.find(search).expect("manual SEARCH must exist once");
    assert_eq!(
        source.matches(search).count(),
        1,
        "manual SEARCH must be unique"
    );
    let to_byte = from_byte + search.len();
    let from = u32::try_from(source[..from_byte].encode_utf16().count()).expect("fixture is small");
    let to = u32::try_from(source[..to_byte].encode_utf16().count()).expect("fixture is small");
    TextRange::new(from, to)
}

fn print_tree(snapshot: &SyntaxSnapshot, text: &TextBuffer) {
    print_node(snapshot, snapshot.root().id, text, 0);
}

fn print_node(snapshot: &SyntaxSnapshot, id: NodeId, text: &TextBuffer, depth: usize) {
    let node = snapshot.node(id).expect("tree child must exist");
    let source = text
        .slice(node.source_range)
        .expect("node range must be valid");
    println!(
        "{}{:?} id={} range={}..{} source={:?}",
        "  ".repeat(depth),
        node.kind,
        node.id.0,
        node.source_range.from,
        node.source_range.to,
        preview(&source)
    );
    for child in &node.children {
        print_node(snapshot, *child, text, depth + 1);
    }
}

fn preview(source: &str) -> String {
    const LIMIT: usize = 72;
    let mut chars = source.chars();
    let mut result: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result.replace('\n', "\\n")
}
