import { Compartment, EditorState, Prec, StateEffect, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Diagnostic observer only: it returns the original transaction unchanged. */
export function traceBrowserTransactions(view: EditorView): {
  readonly events: unknown[];
  stop(): void;
} {
  const events: unknown[] = [];
  const compartment = new Compartment();
  const observe = EditorState.transactionFilter.of(transaction => {
    if (transaction.docChanged) {
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      transaction.changes.iterChanges((from, to, _fromB, _toB, text) => {
        changes.push({ from, to, insert: text.toString().slice(0, 200) });
      });
      events.push({
        timeMs: performance.now(),
        userEvent: transaction.annotation(Transaction.userEvent),
        beforeDoc: transaction.startState.doc.toString(),
        afterDoc: transaction.newDoc.toString(),
        before: { anchor: transaction.startState.selection.main.anchor, head: transaction.startState.selection.main.head },
        after: { anchor: transaction.newSelection.main.anchor, head: transaction.newSelection.main.head },
        changes,
      });
    }
    return transaction;
  });
  // Transaction filters execute from the end of the facet array; lowest
  // precedence observes the raw transaction before the editor's filter.
  view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(Prec.lowest(observe))) });
  return { events, stop: () => view.dispatch({ effects: compartment.reconfigure([]) }) };
}
