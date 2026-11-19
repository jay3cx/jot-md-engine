import { Annotation, ChangeSet, EditorState, Transaction } from "@codemirror/state";
import type { TextEdit, TransactionOrigin } from "@jot-md/editor-protocol";
import { singleTextEdit } from "../../adapter/text-diff.js";

export const synchronizedFromEngine = Annotation.define<boolean>();
export const requestedOrigin = Annotation.define<TransactionOrigin>();

/** Read-only is a user-input policy; confirmed engine/API updates remain legal. */
export const sourceReadOnlyFilter = EditorState.transactionFilter.of((transaction) => {
  const origin = transaction.annotation(requestedOrigin);
  return transaction.startState.readOnly && transaction.docChanged &&
      transaction.annotation(synchronizedFromEngine) !== true && origin !== "api" && origin !== "system"
    ? []
    : transaction;
});

/** Preserve untouched ranges, all selections, and user history during engine sync. */
export function engineSynchronization(
  state: EditorState,
  source: string,
  appliedEdits?: readonly TextEdit[],
): Transaction | undefined {
  const previous = state.doc.toString();
  if (source === previous) return undefined;
  const changesFor = (edits: readonly TextEdit[]) => ChangeSet.of(edits.map((edit) => ({
    from: Number(edit.range.from), to: Number(edit.range.to), insert: edit.insert,
  })), state.doc.length);
  let changes: ChangeSet | undefined;
  if (appliedEdits !== undefined) {
    // An external transaction may arrive after optimistic local input. Only
    // apply its original coordinates if they still produce the confirmed text.
    try {
      const candidate = changesFor(appliedEdits);
      if (candidate.apply(state.doc).toString() === source) changes = candidate;
    } catch { /* Reconcile the actual visible text below. */ }
  }
  changes ??= changesFor(singleTextEdit(previous, source));
  return state.update({
    changes,
    selection: state.selection.map(changes),
    annotations: [
      synchronizedFromEngine.of(true),
      Transaction.userEvent.of("input.engine-sync"),
      Transaction.addToHistory.of(false),
    ],
  });
}
