import type { EditorView } from "@codemirror/view";
import type { DocumentId, RenderNode, Revision } from "@jot-md/editor-protocol";
import type { EditorDocumentSession } from "../../../src/adapter/index.js";
import { SyntaxBlockIndex } from "../../../src/adapter/block-index.js";
import { ProjectionStore } from "../../../src/adapter/projection-store.js";
import { range, Utf16TextModel } from "../../../src/adapter/text-model.js";
import {
  detailSliceKey,
  screenSourceWindow,
  visibleDetailSlices,
} from "../../../src/hosts/live-preview/projection-window.js";
import { markLivePreviewUserScroll, preserveLivePreviewViewport } from "../../../src/hosts/live-preview/viewport.js";

function assert(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

function screen_window_uses_real_geometry_instead_of_overscan(): void {
  const view = {
    scrollDOM: { getBoundingClientRect: () => ({ top: 100 }), clientTop: 1, clientHeight: 100 },
    scaleY: 2,
    documentTop: 40,
    viewport: { from: 0, to: 199 },
    viewportLineBlocks: Array.from({ length: 20 }, (_, index) => ({
      from: index * 10, to: index * 10 + 9, top: index * 10, bottom: index * 10 + 10,
    })),
  } as unknown as EditorView;
  const actual = screenSourceWindow(view);
  assert(actual.from === 30 && actual.to === 139, "screen bounds must use the painted height and scale");
  const emptyView = { ...view, viewportLineBlocks: [] } as unknown as EditorView;
  const fallback = screenSourceWindow(emptyView);
  assert(fallback.from === 0 && fallback.to === 199, "missing geometry must fall back to the CM viewport");
}

function detail_batches_prioritize_screen_and_stop_without_hydration(): void {
  const roots: RenderNode[] = Array.from({ length: 110 }, (_, index) => ({
    id: `root-${index}`,
    kind: index === 90 ? "table" : "heading",
    sourceRange: range(index * 10, index * 10 + 9),
    contentVersion: 1,
    mode: "preview",
    childCount: 1,
    attributes: [],
    content: { type: "deferred" },
  }));
  const blocks = new SyntaxBlockIndex();
  blocks.seedProjection(0, roots, roots.length);
  const projection = new ProjectionStore();
  const install = (from: number, inserted: readonly RenderNode[]) => projection.apply({
    documentId: "detail-window" as DocumentId,
    documentRevision: 0 as Revision,
    viewRevision: 0,
    operations: [{ type: "replace-children", parentId: "0", axis: "syntax-children", from,
      removeCount: 0, inserted, totalChildren: roots.length }],
  });
  const session = { adapter: { blocks, projection } } as unknown as EditorDocumentSession;
  const visible = { from: 0, to: 1_099 }, screen = { from: 850, to: 869 };

  install(0, roots.slice(0, 10));
  const beforeRoots = visibleDetailSlices(session, visible, 4, undefined, screen);
  assert(beforeRoots.every(slice => slice.window.type === "index" && slice.window.from < 10),
    "unloaded root metadata cannot yet provide detail slices");
  install(10, roots.slice(10));
  const first = visibleDetailSlices(session, visible, 4, undefined, screen);
  assert(first[0]?.window.type === "index" && first[0].window.from === 85 &&
    first[1]?.window.type === "index" && first[1].window.from === 86,
  "newly loaded roots on the physical screen must precede overscan");

  const attempted = new Set<string>();
  let batches = 0, total = 0, sawTable = false;
  while (true) {
    const slices = visibleDetailSlices(session, visible, 4, undefined, screen, attempted);
    if (slices.length === 0) break;
    assert(slices.length <= 4, "detail request must respect its per-batch budget");
    for (const slice of slices) {
      const key = detailSliceKey(slice);
      assert(!attempted.has(key), "an unsupported deferred node must not be retried in the same scope");
      attempted.add(key);
      sawTable ||= slice.parentId === "root-90" && slice.window.type === "around-range";
      total += 1;
    }
    batches += 1;
    assert(batches <= 28, "unhydrated projections must terminate rather than busy-loop");
  }
  assert(total === 110 && sawTable, "continuations must visit every root and table row window once");
}

function quote_rows_use_bounded_sparse_windows_and_invalidate_on_revision(): void {
  const source = Array.from({ length: 20_000 }, (_, index) => `> 行 ${index}\n`).join("");
  const text = new Utf16TextModel(source);
  const root: RenderNode = {
    id: "quote", kind: "block-quote", sourceRange: range(0, source.length - 1),
    contentVersion: 0, mode: "preview", childCount: 20_000, attributes: [], content: { type: "deferred" },
  };
  const blocks = new SyntaxBlockIndex();
  blocks.seedProjection(0, [root], 1);
  const projection = new ProjectionStore();
  projection.apply({ documentId: "quote-window" as DocumentId, documentRevision: 0 as Revision, viewRevision: 0,
    operations: [{ type: "replace-children", parentId: "0", axis: "syntax-children", from: 0,
      removeCount: 0, totalChildren: 1, inserted: [root] }] });
  const session = { adapter: { blocks, projection, text, revision: 0 } } as unknown as EditorDocumentSession;
  const visible = { from: Number(text.lineRange(10_000).from), to: Number(text.lineRange(10_002).to) };
  const slices = visibleDetailSlices(session, visible, 8);
  const quote = slices.find(slice => slice.axis === "quote-lines");
  assert(quote?.window.type === "index" && quote.window.from === 10_000 && quote.window.toExclusive === 10_003,
    "only the visible quote lines are requested");
  const node: RenderNode = { id: "quote:line", kind: "quote-line", sourceRange: text.lineRange(10_001),
    contentVersion: 0, mode: "preview", childCount: 0, attributes: [], content: { type: "source" } };
  projection.apply({ documentId: "quote-window" as DocumentId, documentRevision: 0 as Revision, viewRevision: 0,
    operations: [{ type: "replace-children", parentId: root.id, axis: "quote-lines", from: 10_001,
      removeCount: 1, totalChildren: 20_000, inserted: [node] }] });
  assert(projection.totalChildren(root.id, "quote-lines") === 20_000 && projection.nodeAt(root.id, "quote-lines", 10_001)?.id === node.id,
    "quote projection retains total size and the requested sparse slot");
  assert(projection.snapshot().find(item => item.axis === "quote-lines")?.loaded.length === 1,
    "unseen quote rows are not materialized");
  projection.advanceRevision(1 as Revision, [{ range: range(0, 0), insert: "x" }]);
  assert(projection.totalChildren(root.id, "quote-lines") === 0,
    "an edit invalidates quote semantics even when the edit is outside the cached row");
}

function quote_row_cache_evicts_old_windows_without_losing_recent_rows(): void {
  const projection = new ProjectionStore();
  const node: RenderNode = { id: "cached-line", kind: "quote-line", sourceRange: range(0, 1),
    contentVersion: 0, mode: "preview", childCount: 0, attributes: [], content: { type: "source" } };
  const install = (parentId: string, from: number, count: number): void => {
    projection.apply({ documentId: "quote-lru" as DocumentId, documentRevision: 0 as Revision, viewRevision: 0,
      operations: [{ type: "replace-children", parentId, axis: "quote-lines", from, removeCount: count,
        totalChildren: 20_000, inserted: Array.from({ length: count }, () => node) }] });
  };
  install("first", 0, 4096);
  assert(projection.nodeAt("first", "quote-lines", 0) === node, "a visible row can be refreshed");
  install("second", 0, 1);
  assert(projection.nodeAt("first", "quote-lines", 0) === node && projection.nodeAt("first", "quote-lines", 1) === undefined,
    "the least recently used row is evicted across quote blocks");
  assert(projection.snapshot().filter(item => item.axis === "quote-lines").reduce((sum, item) => sum + item.loaded.length, 0) === 4096,
    "scrolling across quote blocks cannot grow the row cache without bound");
  projection.advanceRevision(1 as Revision);
  assert(projection.snapshot().every(item => item.axis !== "quote-lines"), "a revision clears the eviction index and its rows");
}

function delayed_anchor_restores_only_in_the_current_viewport(): void {
  let top = 100;
  let offset = 100;
  let viewport = { from: 0, to: 30 };
  const frames: Array<FrameRequestCallback> = [];
  const view = {
    scrollDOM: { scrollTop: 100, scrollLeft: 0, scrollHeight: 1_000, clientHeight: 100 },
    dom: { ownerDocument: { defaultView: { requestAnimationFrame: (frame: FrameRequestCallback) => frames.push(frame) } } },
    documentPadding: { top: 0 },
    get viewport() { return viewport; },
    lineBlockAtHeight: () => ({ from: 10, top }),
    lineBlockAt: () => ({ top: offset }),
  } as unknown as EditorView;

  preserveLivePreviewViewport(view, () => { offset = 120; });
  assert(view.scrollDOM.scrollTop === 120, "synchronous correction preserves the source anchor");
  offset = 130;
  frames.shift()!(0);
  assert(view.scrollDOM.scrollTop === 130, "the later correction still runs when the anchor remains visible");

  top = 130;
  preserveLivePreviewViewport(view, () => { offset = 140; });
  assert(view.scrollDOM.scrollTop === 140, "the second synchronous correction still runs");
  viewport = { from: 100, to: 200 };
  offset = 900;
  frames.shift()!(0);
  assert(view.scrollDOM.scrollTop === 140, "a delayed correction must not use an out-of-viewport source anchor");

  viewport = { from: 0, to: 30 };
  top = 140;
  preserveLivePreviewViewport(view, () => { offset = 150; });
  markLivePreviewUserScroll(view);
  offset = 160;
  frames.shift()!(0);
  assert(view.scrollDOM.scrollTop === 150, "an explicit later scroll invalidates the delayed correction");
}

function pending_selection_scroll_wins_during_anchor_capture(): void {
  let firstRead = true;
  const scrollDOM = { scrollTop: 0, scrollLeft: 0, scrollHeight: 2_000, clientHeight: 200 };
  const frames: Array<FrameRequestCallback> = [];
  const view = {
    scrollDOM,
    dom: { ownerDocument: { defaultView: { requestAnimationFrame: (frame: FrameRequestCallback) => frames.push(frame) } } },
    documentPadding: { top: 10 },
    viewport: { from: 0, to: 100 },
    lineBlockAtHeight: (height: number) => {
      // CodeMirror can flush a pending scrollIntoView while answering this read.
      if (firstRead) { firstRead = false; scrollDOM.scrollTop = 300; }
      const top = Math.floor(height / 100) * 100;
      return { from: top / 10, top };
    },
    lineBlockAt: (offset: number) => ({ top: offset * 10 }),
  } as unknown as EditorView;
  preserveLivePreviewViewport(view, () => {});
  assert(scrollDOM.scrollTop === 300, "a pending CodeMirror seek must not be restored to the old scrollTop");
  frames.shift()!(0);
  assert(scrollDOM.scrollTop === 300, "the delayed anchor must remain at the measured destination");
}

export function livePreviewProjectionWindowRegression(): void {
  screen_window_uses_real_geometry_instead_of_overscan();
  detail_batches_prioritize_screen_and_stop_without_hydration();
  quote_rows_use_bounded_sparse_windows_and_invalidate_on_revision();
  quote_row_cache_evicts_old_windows_without_losing_recent_rows();
  delayed_anchor_restores_only_in_the_current_viewport();
  pending_selection_scroll_wins_during_anchor_capture();
}
