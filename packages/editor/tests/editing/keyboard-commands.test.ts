import { EditorSelection, EditorState } from "@codemirror/state";
import type { Utf16Offset } from "../../../editor-protocol/src/index.js";
import { createDefaultEditorCommandRegistry } from "../../src/components/commands.js";
import { tableCellAt } from "../../src/components/table/source.js";
import type { EditorCommandResult } from "../../src/core/commands/index.js";

function execute(id: string, source: string, anchor = 0, head = anchor): {
  state: EditorState; result: EditorCommandResult;
} {
  const result = createDefaultEditorCommandRegistry().execute(id, {
    source, selection: { anchor: anchor as Utf16Offset, head: head as Utf16Offset }, selectionCount: 1,
  });
  if (result === undefined) throw new Error(`${id} was unavailable`);
  let state = EditorState.create({ doc: source, selection: EditorSelection.range(anchor, head) });
  state = state.update({
    changes: (result.edits ?? []).map((edit) => ({ from: edit.range.from, to: edit.range.to, insert: edit.insert })),
    ...(result.selection === undefined ? {} : { selection: EditorSelection.range(result.selection.anchor, result.selection.head) }),
  }).state;
  return { state, result };
}

function text(state: EditorState): string { return state.doc.toString(); }
function selected(state: EditorState): string {
  return state.sliceDoc(state.selection.main.from, state.selection.main.to);
}
function type(state: EditorState, value: string): EditorState {
  return state.update(state.replaceSelection(value)).state;
}
function equal<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function inserted_blocks_accept_the_first_keystroke_at_their_content(): void {
  const opening = "``` js begin\n";
  const code = execute("insert.code-block", "").state;
  equal(code.selection.main.head, opening.length);
  equal(text(type(code, "const 值 = '😀';")), `${opening}const 值 = '😀';\n\`\`\` end`);

  const source = "before\n\n选中😀\n\nafter";
  const from = source.indexOf("选中");
  const wrapped = execute("insert.code-block", source, from + "选中😀".length, from).state;
  equal(selected(wrapped), "选中😀");
  equal(text(type(wrapped, "replacement")), `before\n\n${opening}replacement\n\`\`\` end\n\nafter`);

  const math = execute("insert.math-block", "").state;
  equal(selected(math), "x");
  equal(text(type(math, "a^2")), "$$\na^2\n$$");

  const table = execute("insert.table", "").state;
  const cell = tableCellAt(text(table), table.selection.main.head);
  if (cell === undefined) throw new Error("table insertion must select a real editable cell");
  equal(table.selection.main.empty, true);
  const populated = type(table, "正文");
  equal(text(populated), "| A | B |\n| --- | --- |\n|  正文|  |");
  equal(tableCellAt(text(populated), populated.selection.main.head)?.column, 0);

  const image = execute("insert.image", "a]b\n😀", 0, "a]b\n😀".length).state;
  equal(selected(image), "https://");
  equal(text(type(image, "https://example.test/image.png")), "![a\\]b 😀](https://example.test/image.png)");
}

function block_insertion_reuses_existing_separators(): void {
  const middle = execute("insert.thematic-break", "leftRIGHT", 4).state;
  equal(text(middle), "left\n\n---\n\nRIGHT");
  equal(text(type(middle, "new ")), "left\n\n---\n\nnew RIGHT");
  const between = execute("insert.math-block", "left\n\nright", 6).state;
  equal(text(between), "left\n\n$$\nx\n$$\n\nright");
  const atEnd = execute("insert.thematic-break", "left\n\n", 6).state;
  equal(text(atEnd), "left\n\n---\n\n");
  equal(atEnd.selection.main.head, text(atEnd).length);
}

function line_prefixes_preserve_blank_lines_indentation_and_selection_direction(): void {
  const original = "\nalpha\n\n  beta\n";
  const listed = execute("format.bullet-list", original, original.length, 0);
  equal(text(listed.state), "\n- alpha\n\n  - beta\n");
  equal(listed.state.selection.main.anchor > listed.state.selection.main.head, true);
  equal(listed.result.userEvent, "input.format.bullet-list");
  const unlisted = execute("format.bullet-list", text(listed.state),
    listed.state.selection.main.anchor, listed.state.selection.main.head).state;
  equal(text(unlisted), original);
  equal(unlisted.selection.main.anchor, original.length);
  equal(unlisted.selection.main.head, 0);

  const firstEmpty = execute("format.quote", "\ntext", 0).state;
  equal(text(firstEmpty), "> \ntext");
  equal(firstEmpty.selection.main.head, 2);
  equal(text(type(firstEmpty, "quoted")), "> quoted\ntext");

  const firstLine = execute("format.quote", "one\ntwo", 0, 4).state;
  equal(text(firstLine), "> one\ntwo");
  equal(selected(firstLine), "one\n");

  const ordered = execute("format.ordered-list", "1. first\n2. second", 0, 18).state;
  equal(text(ordered), "first\nsecond");
  const mixed = execute("format.bullet-list", "- first\nsecond", 0, 14).state;
  equal(text(mixed), "- first\n- second");
}

function registry_native_actions_and_remapped_shortcuts_have_one_identity(): void {
  const registry = createDefaultEditorCommandRegistry();
  const context = { source: "body", selection: { anchor: 0 as Utf16Offset, head: 0 as Utf16Offset } };
  for (const id of ["command.palette", "shortcut.settings", "search.open", "search.replace", "history.undo", "history.redo"]) {
    const command = registry.command(id);
    if (command === undefined || command.title.length === 0) throw new Error(`${id} missing from command directory`);
    const result = registry.execute(id, context);
    equal(result?.action, id);
    equal(result?.edits, undefined);
  }
  equal(registry.shortcutForEvent({ key: "z", ctrlKey: true })?.command, "history.undo");
  equal(registry.shortcutForEvent({ key: "f", metaKey: true }, true)?.command, "search.open");
  registry.configureShortcuts({ "history.undo": null, "search.open": null });
  equal(registry.shortcutForEvent({ key: "z", ctrlKey: true }), undefined);
  equal(registry.shortcutForEvent({ key: "f", metaKey: true }, true), undefined);
  // Disabling a shortcut must retain the command for palette/API invocation.
  equal(registry.execute("history.undo", context)?.action, "history.undo");
  registry.configureShortcuts({ "history.undo": "Mod-Alt-u", "search.open": "Mod-Shift-f" });
  equal(registry.shortcutForEvent({ key: "u", ctrlKey: true, altKey: true })?.command, "history.undo");
  equal(registry.shortcutForEvent({ key: "u", metaKey: true, altKey: true }, true)?.command, "history.undo");
  equal(registry.shortcutForEvent({ key: "F", metaKey: true, shiftKey: true }, true)?.command, "search.open");
  equal(registry.shortcutForEvent({ key: "u", metaKey: true, altKey: true }), undefined);
  equal(registry.shortcuts.find((binding) => binding.command === "search.open")?.key, "Mod-Shift-f");
  registry.resetShortcuts();
  equal(registry.shortcutForEvent({ key: "z", metaKey: true }, true)?.command, "history.undo");
  equal(registry.shortcutForEvent({ key: "f", ctrlKey: true })?.command, "search.open");
}

function default_shortcuts_follow_the_host_platform(): void {
  const mac = createDefaultEditorCommandRegistry("MacIntel");
  const linux = createDefaultEditorCommandRegistry("Linux x86_64");
  const shiftedDigit = { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true };
  equal(mac.shortcutForEvent(shiftedDigit, true)?.command, "format.heading-1");
  equal(linux.shortcutForEvent(shiftedDigit), undefined);
  equal(mac.shortcutForEvent({ key: "F3" }, true), undefined);
  equal(linux.shortcutForEvent({ key: "F3" })?.command, "search.next");
  equal(mac.shortcutForEvent({ key: "ArrowRight", metaKey: true, altKey: true }, true), undefined);
  equal(linux.shortcutForEvent({ key: "ArrowRight", ctrlKey: true, altKey: true })?.command, "table.insert-column-after");
  mac.configureShortcuts({ "format.heading-1": null });
  equal(mac.shortcutForEvent(shiftedDigit, true), undefined);
  mac.resetShortcuts();
  equal(mac.shortcutForEvent(shiftedDigit, true)?.command, "format.heading-1");
}

inserted_blocks_accept_the_first_keystroke_at_their_content();
block_insertion_reuses_existing_separators();
line_prefixes_preserve_blank_lines_indentation_and_selection_direction();
registry_native_actions_and_remapped_shortcuts_have_one_identity();
default_shortcuts_follow_the_host_platform();
