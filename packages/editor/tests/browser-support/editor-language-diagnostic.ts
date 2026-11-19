import { Language, ensureSyntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import type { EditorState, StateField } from "@codemirror/state";

// 容量测试通过 CodeMirror 的解析上下文统计复用的语法片段。
export function languageFragmentStats(state: EditorState): unknown {
  const field = (Language as unknown as { state: StateField<{
    context: { fragments: readonly { from: number; to: number; tree: { length: number } }[] };
  }> }).state;
  const context = state.field(field, false)?.context;
  if (context === undefined) return undefined;
  const fragments = context.fragments;
  return {
    fragments: fragments.length,
    uniqueTrees: new Set(fragments.map(fragment => fragment.tree)).size,
    ranges: fragments.map(fragment => ({ from: fragment.from, to: fragment.to, treeLength: fragment.tree.length })).slice(0, 50),
  };
}

export function compareMarkdownTree(state: EditorState, positions: readonly number[]): unknown {
  const incremental = ensureSyntaxTree(state, state.doc.length, 10_000);
  if (incremental === null) return { complete: false };
  const full = markdown({ addKeymap: false }).language.parser.parse(state.doc.toString());
  const describe = (tree: typeof full, position: number) => {
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(position, -1);
    const path = [];
    while (node !== null) {
      path.push({ name: node.name, from: node.from, to: node.to });
      node = node.parent;
    }
    return path;
  };
  return {
    complete: true,
    positions: positions.map(position => ({ position, incremental: describe(incremental, position), full: describe(full, position) })),
  };
}
