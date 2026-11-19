use std::{
    env, fs,
    io::{self, Read},
    time::{Duration, Instant},
};

use editor_engine::{
    syntax::{CompiledSyntaxProfile, NodeId, SyntaxAnalysisSession, SyntaxSnapshot, WorkBudget},
    text::TextBuffer,
};
use editor_protocol::TextRange;

struct Options {
    input: String,
    priority: Option<TextRange>,
    budget: WorkBudget,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_options()?;
    let source = read_source(&options.input)?;
    let text = TextBuffer::from_source(&source);
    let priority = options
        .priority
        .unwrap_or_else(|| TextRange::new(0, text.utf16_len()));

    let initialized_at = Instant::now();
    let mut session = SyntaxAnalysisSession::from_text(
        &text,
        CompiledSyntaxProfile::compile(Default::default()),
    )?;
    let initialization_time = initialized_at.elapsed();

    let priority_at = Instant::now();
    let priority_progress = session.parse_priority(priority)?;
    let priority_time = priority_at.elapsed();
    println!(
        "input_utf16={} source_lines={}",
        text.utf16_len(),
        text.line_count()
    );
    println!(
        "priority_requested={}..{} confirmed={}..{} blocks={} complete={}",
        priority.from,
        priority.to,
        priority_progress.confirmed_range.from,
        priority_progress.confirmed_range.to,
        priority_progress.parsed_blocks,
        priority_progress.complete
    );
    println!("initialization={}", duration(initialization_time));
    println!("priority_parse={}", duration(priority_time));

    let background_at = Instant::now();
    let mut polls = 0_u64;
    while !session.is_complete() {
        session.poll(options.budget)?;
        polls += 1;
    }
    let background_time = background_at.elapsed();
    let snapshot = session
        .completed_snapshot()
        .ok_or("analysis session did not complete")?;
    println!("background_polls={polls}");
    println!("background_parse={}", duration(background_time));
    println!(
        "total={}",
        duration(initialization_time + priority_time + background_time)
    );
    println!(
        "blocks={} nodes={}",
        snapshot.block_count(),
        snapshot.nodes().len()
    );
    println!("tree:");
    print_node(&snapshot, snapshot.root().id, &text, 0);
    Ok(())
}

fn parse_options() -> Result<Options, Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let mut input = None;
    let mut priority = None;
    let mut max_source_lines = 512;
    let mut max_blocks = 128;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--range" => {
                priority = Some(parse_range(&args.next().ok_or("--range needs FROM:TO")?)?)
            }
            "--budget-lines" => {
                max_source_lines = args
                    .next()
                    .ok_or("--budget-lines needs a number")?
                    .parse()?;
            }
            "--budget-blocks" => {
                max_blocks = args
                    .next()
                    .ok_or("--budget-blocks needs a number")?
                    .parse()?;
            }
            "--help" | "-h" => {
                println!(
                    "usage: md-inspect [--range FROM:TO] [--budget-lines N] \
                     [--budget-blocks N] [FILE|-]"
                );
                std::process::exit(0);
            }
            value if input.is_none() => input = Some(value.to_owned()),
            value => return Err(format!("unexpected argument: {value}").into()),
        }
    }
    Ok(Options {
        input: input.unwrap_or_else(|| "-".to_owned()),
        priority,
        budget: WorkBudget::new(max_source_lines, max_blocks),
    })
}

fn parse_range(value: &str) -> Result<TextRange, Box<dyn std::error::Error>> {
    let (from, to) = value.split_once(':').ok_or("range must be FROM:TO")?;
    Ok(TextRange::new(from.parse()?, to.parse()?))
}

fn read_source(input: &str) -> io::Result<String> {
    if input == "-" {
        let mut source = String::new();
        io::stdin().read_to_string(&mut source)?;
        Ok(source)
    } else {
        fs::read_to_string(input)
    }
}

fn print_node(snapshot: &SyntaxSnapshot, id: NodeId, text: &TextBuffer, depth: usize) {
    let node = snapshot.node(id).expect("tree child must exist");
    let preview = text
        .slice(node.source_range)
        .map(|source| preview(&source))
        .unwrap_or_else(|_| "<invalid-range>".to_owned());
    println!(
        "{}{:?} id={} range={}..{} text={:?}",
        "  ".repeat(depth),
        node.kind,
        node.id.0,
        node.source_range.from,
        node.source_range.to,
        preview
    );
    for child in &node.children {
        print_node(snapshot, *child, text, depth + 1);
    }
}

fn preview(source: &str) -> String {
    const LIMIT: usize = 80;
    let mut chars = source.chars();
    let mut result: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result.replace('\n', "\\n")
}

fn duration(value: Duration) -> String {
    format!("{:.3}ms", value.as_secs_f64() * 1_000.0)
}
