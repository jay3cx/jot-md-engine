import type { EditorView } from "@codemirror/view";

type SnapshotView = Pick<EditorView, "state">;
const snapshots = new WeakMap<SnapshotView, {
  readonly doc: SnapshotView["state"]["doc"];
  readonly source: string;
}>();

/** Share one flattening across consumers of a view's current immutable CM Text. */
export function sourceSnapshot(view: SnapshotView): string {
  const doc = view.state.doc;
  const cached = snapshots.get(view);
  if (cached?.doc === doc) return cached.source;
  const source = doc.toString();
  // Keep only the latest document; history must not accumulate string copies.
  snapshots.set(view, { doc, source });
  return source;
}
