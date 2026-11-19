import type { DocumentId, RenderNode, Revision } from "@jot-md/editor-protocol";
import type { EditorView } from "@codemirror/view";
import type { EditorDocumentSession } from "../../../src/adapter/index.js";
import { SyntaxBlockIndex } from "../../../src/adapter/block-index.js";
import { ProjectionStore } from "../../../src/adapter/projection-store.js";
import { Utf16TextModel, range } from "../../../src/adapter/text-model.js";
import { LivePreviewPreTextEstimator } from "../../../src/hosts/live-preview/pretext-estimator.js";
import { visibleLivePreviewNodes } from "../../../src/hosts/live-preview/projection-window.js";
import { spliceItems, spliceSlots } from "../../../src/adapter/array-splice.js";

class CountedBlockIndex extends SyntaxBlockIndex {
  reads = 0;
  override get blocks() {
    this.reads += 1;
    return super.blocks;
  }
}

const view = {
  contentDOM: { dataset: {} },
  dom: { ownerDocument: { defaultView: { getComputedStyle: () => ({
    font: "14px sans-serif", lineHeight: "24px", letterSpacing: "0px",
  }) } } },
} as unknown as EditorView;

function session(blocks: SyntaxBlockIndex, text: Utf16TextModel, projection = new ProjectionStore()) {
  return { adapter: { blocks, text, projection, revision: 0, viewRevision: 0, analysis: { state: "complete" } } } as unknown as EditorDocumentSession;
}

function root(id: string, from: number, to: number, kind = "paragraph"): RenderNode {
  return {
    id, kind, sourceRange: range(from, to), contentVersion: 1,
    mode: "preview", childCount: 0, attributes: [], content: { type: "source" },
  };
}

function assert(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

function unchanged_viewport_work_does_not_enumerate_the_document(): void {
  const count = 10_000;
  const text = new Utf16TextModel("abc\n".repeat(count));
  const blocks = new CountedBlockIndex();
  const roots = Array.from({ length: count }, (_, index) =>
    root(String(index), index * 4, index * 4 + 4, index % 100 === 0 ? "math-block" : "paragraph"));
  blocks.seedProjection(0, roots, count);
  const initialVersion = blocks.version;
  blocks.seedProjection(4_000, roots.slice(4_000, 4_030), count);
  assert(blocks.version === initialVersion, "projection detail refresh must preserve semantic geometry identity");
  const estimator = new LivePreviewPreTextEstimator(session(blocks, text), {});
  estimator.resize(800);
  estimator.geometry(view, { from: 15_000, to: 15_200 });
  blocks.reads = 0;
  for (let index = 0; index < 20; index += 1) {
    estimator.geometry(view, { from: 15_000 + index * 4, to: 15_200 + index * 4 });
  }
  assert(blocks.reads === 0, "scroll/caret updates must reuse the document geometry index");

  // Background parsing can splice the same block array at the same revision.
  const previousVersion = blocks.version;
  blocks.applySyntaxPatch({
    blockChanges: [{ fromBlock: 4_999, removeCount: 1, inserted: [{
      id: "late-table", kind: "table", sourceRange: range(19_996, 20_000), contentVersion: 2,
    }] }],
    totalBlocks: count, changedBlocks: 1, reparsedRange: range(19_996, 20_000),
  });
  assert(blocks.version > previousVersion, "in-place syntax updates need a new cache identity");
  const gaps = estimator.geometry(view, { from: 20_200, to: 20_204 });
  assert(gaps.some((gap) => gap.id === "pretext-gap:late-table"), "late confirmed widget must enter geometry");
  assert(blocks.reads > 0, "syntax update must invalidate the geometry index");

  blocks.reads = 0;
  estimator.resize(400);
  estimator.geometry(view, { from: 20_200, to: 20_204 });
  estimator.invalidateLayout({ pretext: { typographyVersion: "new-font" } });
  estimator.geometry(view, { from: 20_200, to: 20_204 });
  assert(blocks.reads === 0, "width and typography changes reuse the source-ordered candidate index");
  estimator.dispose();
}

function visible_projection_reads_only_the_required_parent_windows(): void {
  const store = new ProjectionStore();
  const count = 10_000;
  const roots = Array.from({ length: count }, (_, index) => root(String(index), index * 10, index * 10 + 9));
  const table = { ...root("table", 50_000, 50_009, "table"), childCount: 1, content: { type: "deferred" as const } };
  roots[5_000] = table;
  const row = { ...root("row", 50_000, 50_009, "table-row"), childCount: 1, content: { type: "deferred" as const } };
  const cell = root("cell", 50_001, 50_008, "table-cell");
  store.apply({ documentId: "performance-test" as DocumentId, documentRevision: 0 as Revision, viewRevision: 0, operations: [
    { type: "replace-children", parentId: "0", axis: "syntax-children", from: 0, removeCount: 0, inserted: roots, totalChildren: count },
    { type: "replace-children", parentId: table.id, axis: "syntax-children", from: 0, removeCount: 0, inserted: [row], totalChildren: 1 },
    { type: "replace-children", parentId: row.id, axis: "syntax-children", from: 0, removeCount: 0, inserted: [cell], totalChildren: 1 },
  ] });
  const blocks = new SyntaxBlockIndex();
  blocks.seedProjection(0, roots, count);
  store.snapshot = () => { throw new Error("viewport work must not snapshot the full projection cache"); };
  const reads: Array<{ parentId: string; count: number }> = [];
  const entries = store.entries.bind(store);
  store.entries = (parentId, axis, from, to) => {
    const result = entries(parentId, axis, from, to);
    reads.push({ parentId, count: result.length });
    return result;
  };
  const nodes = visibleLivePreviewNodes(session(blocks, new Utf16TextModel(), store), { from: 50_000, to: 50_009 }, 50_003);
  const actual = nodes.find((node) => node.id === table.id);
  assert(actual?.content.type === "structured" && actual.content.children[0]?.content.type === "structured" &&
    actual.content.children[0].content.children[0]?.id === cell.id, "bounded reads must still hydrate the mapped cell");
  assert(reads.length === 3, "only root, selected table and selected row should be read");
  assert(reads[0]!.count <= 4, "root reads must stay within the visible metadata span");
}

function ordinary_projection_writes_do_not_search_sparse_root_capacity(): void {
  const store = new ProjectionStore();
  let unrelatedIdentityReads = 0;
  const guarded: RenderNode = {
    ...root("far-root", 999_990, 999_999),
    get id() { unrelatedIdentityReads += 1; return "far-root"; },
  };
  const patch = (from: number, inserted: readonly RenderNode[]) => ({
    documentId: "sparse-write" as DocumentId, documentRevision: 0 as Revision, viewRevision: 0,
    operations: [{ type: "replace-children" as const, parentId: "0", axis: "syntax-children" as const,
      from, removeCount: 0, inserted, totalChildren: 100_000 }],
  });
  store.apply(patch(99_999, [guarded]));
  unrelatedIdentityReads = 0;
  store.apply(patch(0, [root("near-root", 0, 9)]));
  assert(unrelatedIdentityReads === 0, "ordinary roots have no child cache to invalidate and must not search unrelated slots");
  assert(store.nodeAt("0", "syntax-children", 99_999) === guarded, "far sparse projection must remain intact");
}

function large_syntax_splices_preserve_suffixes_without_function_argument_limits(): void {
  // The untouched native operation is the oracle for overlapping suffix moves.
  for (let from = 0; from < 6; from += 1) {
    for (let remove = 0; remove < 7; remove += 1) {
      for (let count = 0; count < 6; count += 1) {
        const original = [0, 1, 2, 3];
        const inserted = Array.from({ length: count }, (_, index) => index + 10);
        const expected = [...original];
        expected.splice(from, remove, ...inserted);
        const actual = [...original];
        spliceItems(actual, from, remove, inserted);
        assert(JSON.stringify(actual) === JSON.stringify(expected), "array splice must preserve native range semantics");
        const slots: Array<number | undefined> = [...original];
        const expectedSlots: Array<number | undefined> = [...original];
        expectedSlots.splice(from, remove, ...new Array<number | undefined>(count).fill(undefined));
        spliceSlots(slots, from, remove, count);
        assert(JSON.stringify(slots) === JSON.stringify(expectedSlots), "projection slot splice must preserve native range semantics");
      }
    }
  }

  const count = 250_000;
  const blocks = new SyntaxBlockIndex();
  const prefix = root("prefix", 0, 1);
  const suffix = root("suffix", count + 1, count + 2);
  blocks.seedProjection(0, [prefix, suffix], 2);
  const inserted = Array.from({ length: count }, (_, index) => ({
    id: String(index), kind: "paragraph", sourceRange: range(index + 1, index + 2), contentVersion: 1,
  }));
  const patch = {
    blockChanges: [{ fromBlock: 1, removeCount: 0, inserted }],
    totalBlocks: count + 2, changedBlocks: count, reparsedRange: range(1, count + 1),
  };
  blocks.applySyntaxPatch(patch);
  assert(blocks.blocks.length === count + 2 && blocks.blocks.at(-1)?.id === "suffix", "large metadata insertion must preserve suffix identity");

  const store = new ProjectionStore();
  store.apply({ documentId: "large-splice" as DocumentId, documentRevision: 0 as Revision, viewRevision: 0,
    operations: [{ type: "replace-children", parentId: "0", axis: "syntax-children",
      from: 0, removeCount: 0, inserted: [prefix, suffix], totalChildren: 2 }],
  });
  store.applySyntaxPatch(patch);
  assert(store.totalBlocks === count + 2 && store.nodeAt("0", "syntax-children", count + 1) === suffix,
    "large unloaded root insertion must preserve sparse suffix slots");
}

export function livePreviewPerformanceRegression(): void {
  unchanged_viewport_work_does_not_enumerate_the_document();
  visible_projection_reads_only_the_required_parent_windows();
  ordinary_projection_writes_do_not_search_sparse_root_capacity();
  large_syntax_splices_preserve_suffixes_without_function_argument_limits();
}
