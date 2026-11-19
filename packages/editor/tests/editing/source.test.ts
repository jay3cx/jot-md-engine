import {
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { createDefaultEditorCommandRegistry } from "../../src/components/commands.js";
import { history, undoDepth } from "@codemirror/commands";
import { engineSynchronization, requestedOrigin, sourceReadOnlyFilter } from "../../src/hosts/source/synchronization.js";
import { sourceSnapshot } from "../../src/hosts/shared/source-snapshot.js";
import { SearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { executeSourceAction, sourceSearch, updateSourceSearch } from "../../src/hosts/source/search.js";

function source_snapshots_share_only_the_latest_text_per_view(): void {
  const initial = EditorState.create({ doc: "first\n第二行😀" });
  const updated = initial.update({ changes: { from: 0, insert: "new " } }).state;
  let initialCalls = 0;
  let updatedCalls = 0;
  const initialToString = initial.doc.toString.bind(initial.doc);
  const updatedToString = updated.doc.toString.bind(updated.doc);
  Object.defineProperty(initial.doc, "toString", {
    value: () => { initialCalls += 1; return initialToString(); }, configurable: true,
  });
  Object.defineProperty(updated.doc, "toString", {
    value: () => { updatedCalls += 1; return updatedToString(); }, configurable: true,
  });
  try {
    const view = { state: initial };
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 1);

    view.state = initial.update({ selection: EditorSelection.cursor(3) }).state;
    equal(view.state.doc, initial.doc);
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 1); // Selection changes share the same immutable Text.

    view.state = updated;
    equal(sourceSnapshot(view), "new first\n第二行😀");
    equal(sourceSnapshot(view), "new first\n第二行😀");
    equal(updatedCalls, 1);
    view.state = initial;
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 2); // Returning through history recomputes an evicted version.

    const otherView = { state: initial };
    equal(sourceSnapshot(otherView), "first\n第二行😀");
    equal(initialCalls, 3); // Even shared Text objects do not share view lifetimes.
    otherView.state = updated;
    equal(sourceSnapshot(otherView), "new first\n第二行😀");
    equal(updatedCalls, 2);
    equal(sourceSnapshot(view), "first\n第二行😀");
    equal(initialCalls, 3); // Moving the other view cannot invalidate this view.
  } finally {
    Reflect.deleteProperty(initial.doc, "toString");
    Reflect.deleteProperty(updated.doc, "toString");
  }
}

function source_search_matches_full_document_and_respects_query_options(): void {
  const source = `Alpha alphabet ALPHA\n${"unrelated line\n".repeat(20_000)}alpha tail42\n尾部匹配`;
  const state = EditorState.create({ doc: source, extensions: sourceSearch() });
  const query = new SearchQuery({ search: "alpha", wholeWord: true });
  const matches = [...{ [Symbol.iterator]: () => query.getCursor(state) }];
  equal(matches.length, 3);
  equal(matches[2]?.from, source.lastIndexOf("alpha"));
  const exact = new SearchQuery({ search: "Alpha", caseSensitive: true, wholeWord: true });
  equal([...{ [Symbol.iterator]: () => exact.getCursor(state) }].length, 1);
  const regex = new SearchQuery({ search: "tail(\\d+)", regexp: true });
  equal(regex.getCursor(state).next().value?.from, source.indexOf("tail42"));
  const unicode = new SearchQuery({ search: "尾部匹配" });
  equal(unicode.getCursor(state).next().value?.to, source.length);
  equal(new SearchQuery({ search: "[", regexp: true }).valid, false);
}

function source_replace_all_is_one_undoable_transaction_and_honors_read_only(): void {
  const source = "# word12\n\n> word34\n\n``` js begin\nword56\n``` end";
  let state = EditorState.create({ doc: source, extensions: [history(), sourceReadOnlyFilter, sourceSearch()] });
  const events: string[] = [];
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec | Transaction) {
      const transaction = spec instanceof Transaction ? spec : state.update(spec);
      if (transaction.docChanged) events.push(transaction.annotation(Transaction.userEvent) ?? "");
      state = transaction.state;
    },
  } as unknown as EditorView;
  updateSourceSearch(view, { search: "word(\\d+)", replace: "value-$1", regexp: true });
  equal(executeSourceAction(view, "search.replace-all"), true);
  equal(state.doc.toString(), source.replace(/word(\d+)/gu, "value-$1"));
  equal(events.join(","), "input.replace.all");
  equal(undoDepth(state), 1);
  equal(executeSourceAction(view, "history.undo"), true);
  equal(state.doc.toString(), source);
  equal(executeSourceAction(view, "history.redo"), true);
  equal(state.doc.toString(), source.replace(/word(\d+)/gu, "value-$1"));

  updateSourceSearch(view, { search: "[", regexp: true });
  const invalidSource = state.doc.toString();
  for (const action of ["search.next", "search.previous", "search.replace-next", "search.replace-all"]) {
    equal(executeSourceAction(view, action), false);
  }
  equal(state.doc.toString(), invalidSource);

  state = EditorState.create({ doc: source, extensions: [EditorState.readOnly.of(true), sourceReadOnlyFilter, sourceSearch()] });
  updateSourceSearch(view, { search: "word", replace: "changed" });
  equal(executeSourceAction(view, "search.replace-all"), false);
  equal(executeSourceAction(view, "search.replace-next"), false);
  equal(state.doc.toString(), source);
}

function engine_sync_preserves_selection_and_does_not_create_history(): void {
  const state = EditorState.create({
    doc: "abc\ndef\nghi",
    selection: EditorSelection.create([EditorSelection.range(5, 4), EditorSelection.cursor(9)], 0),
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
  });
  const transaction = engineSynchronization(state, "a!bc\ndef\nghi");
  if (transaction === undefined) throw new Error("missing sync transaction");
  equal(transaction.newDoc.toString(), "a!bc\ndef\nghi");
  equal(transaction.newSelection.ranges.length, 2);
  equal(transaction.newSelection.main.anchor, 6);
  equal(transaction.newSelection.main.head, 5);
  equal(undoDepth(transaction.state), 0);
  let changed = 0;
  transaction.changes.iterChangedRanges((from, to) => { changed += to - from; });
  equal(changed, 0); // insertion only: the rest of the document was not replaced
}

function read_only_blocks_custom_input_but_allows_explicit_api_updates(): void {
  const state = EditorState.create({ doc: "abc", extensions: [
    history(), sourceReadOnlyFilter, EditorState.readOnly.of(true),
  ] });
  equal(state.update({ changes: { from: 0, insert: "user" } }).newDoc.toString(), "abc");
  equal(state.update({ changes: { from: 0, insert: "api" },
    annotations: requestedOrigin.of("api") }).newDoc.toString(), "apiabc");
  equal(engineSynchronization(state, "confirmed")?.newDoc.toString(), "confirmed");
}

function format_commands_and_dynamic_keybindings_share_one_catalog(): void {
  const registry = createDefaultEditorCommandRegistry();
  const formatted = registry.execute("format.bold", { source: "hello",
    selection: { anchor: 0 as import("@jot-md/editor-protocol").Utf16Offset,
      head: 5 as import("@jot-md/editor-protocol").Utf16Offset } });
  if (formatted?.edits === undefined || formatted.selection === undefined) throw new Error("missing format edit");
  equal(apply("hello", formatted.edits), "**hello**");
  const unwrapped = registry.execute("format.bold", { source: "**hello**", selection: formatted.selection });
  equal(apply("**hello**", unwrapped?.edits ?? []), "hello");
  let changes = 0;
  const unsubscribe = registry.subscribe(() => { changes += 1; });
  registry.configureShortcuts({ "format.bold": "Mod-Shift-b", "format.italic": null });
  equal(registry.shortcuts.find((item) => item.id === "format.bold")?.key, "Mod-Shift-b");
  equal(registry.shortcuts.some((item) => item.id === "format.italic"), false);
  let conflict = false;
  try { registry.configureShortcuts({ "format.italic": "Shift-Mod-b" }); } catch { conflict = true; }
  equal(conflict, true);
  equal(registry.shortcuts.some((item) => item.id === "format.italic"), false);
  equal(changes, 1);
  let invalid = false;
  try { registry.configureShortcuts({ "format.bold": "Unknown-b" }); } catch { invalid = true; }
  equal(invalid, true);
  equal(registry.shortcuts.find((item) => item.id === "format.bold")?.key, "Mod-Shift-b");
  equal(changes, 1);
  registry.resetShortcuts();
  equal(registry.shortcuts.find((item) => item.id === "format.bold")?.key, "Mod-b");
  equal(changes, 2);
  unsubscribe();
}

function apply(source: string, edits: readonly { readonly range: { readonly from: number; readonly to: number }; readonly insert: string }[]): string {
  return [...edits]
    .sort((left, right) => Number(right.range.from) - Number(left.range.from))
    .reduce((value, edit) =>
      value.slice(0, Number(edit.range.from)) + edit.insert + value.slice(Number(edit.range.to)), source);
}

function equal<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

source_snapshots_share_only_the_latest_text_per_view();
source_search_matches_full_document_and_respects_query_options();
source_replace_all_is_one_undoable_transaction_and_honors_read_only();
engine_sync_preserves_selection_and_does_not_create_history();
read_only_blocks_custom_input_but_allows_explicit_api_updates();
format_commands_and_dynamic_keybindings_share_one_catalog();
