import type { RenderNode, TextRange } from "../../../editor-protocol/src/index.js";
import type { MarkdownEditor } from "../../src/component/markdown-editor.js";
import { EditorPluginRegistry, type MarkdownEditorPlugin } from "../../src/plugins/registry.js";
import { EditorCommandRegistry } from "../../src/core/commands/index.js";

const editor = {} as MarkdownEditor;
const range = (from: number, to: number): TextRange => ({ from: from as TextRange["from"], to: to as TextRange["to"] });
const node = (language: string, length: number): RenderNode => ({
  id: "code", kind: "fenced-code", sourceRange: range(0, length + 8), contentVersion: 0,
  mode: "preview", childCount: 0, content: { type: "deferred" }, attributes: [
    { name: "language", value: { type: "string", value: language } },
    { name: "contentRange", value: { type: "range", value: range(4, length + 4) } },
  ],
});
const equal = (actual: unknown, expected: unknown): void => {
  if (!Object.is(actual, expected)) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
};
const throws = (action: () => void): void => {
  let failed = false; try { action(); } catch { failed = true; }
  if (!failed) throw new Error("expected an exception");
};

let starts = 0, stops = 0;
const plugin: MarkdownEditorPlugin = {
  id: "diagram", enabled: false,
  activate() { starts++; return () => { stops++; }; },
  codeBlocks: [{ languages: ["Example"], maxSourceLength: 8, render: () => null as unknown as Node }],
};
const first = new EditorPluginRegistry([plugin]);
const second = new EditorPluginRegistry([plugin]);
first.activate(editor);second.activate(editor);
equal(first.codeBlock(node("example", 3)), undefined);
equal(first.setEnabled(editor, "diagram", true), true);
equal(first.codeBlock(node("EXAMPLE", 8))?.pluginId, "diagram");
equal(first.codeBlock(node("example", 9)), undefined);
equal(first.codeBlock({ ...node("example", 3), sourceRange: range(0, 4) }), undefined);
equal(second.codeBlock(node("example", 3)), undefined);
equal(first.setEnabled(editor, "diagram", true), false);
equal(first.setEnabled(editor, "diagram", false), true);
equal(starts, 1);equal(stops, 1);
first.setEnabled(editor, "diagram", true);first.dispose();second.dispose();
equal(starts, 2);equal(stops, 2);
throws(() => new EditorPluginRegistry([plugin, plugin]));
throws(() => new EditorPluginRegistry([plugin, { ...plugin, id: "other" }]));
throws(() => first.isEnabled("missing"));

let released = false;
const broken = new EditorPluginRegistry([
  { id: "first", activate: () => () => { released = true; } },
  { id: "broken", activate: () => { throw new Error("failed setup"); } },
]);
throws(() => broken.activate(editor));
equal(released, true);
const commands = new EditorCommandRegistry();
commands.register({ id: "plugin.fold", title: "Fold", run: () => ({ userEvent: "plugin.fold" }) });
commands.bind({ id: "plugin.fold.key", command: "plugin.fold", key: "Mod-Alt-f" });
equal(commands.shortcutForEvent({ key: "f", ctrlKey: true, altKey: true })?.command, "plugin.fold");
equal(commands.unregister("plugin.fold"), true);
equal(commands.command("plugin.fold"), undefined);
equal(commands.shortcutForEvent({ key: "f", ctrlKey: true, altKey: true }), undefined);
equal(commands.defaultShortcuts.length, 0);
equal(commands.unregister("plugin.fold"), false);
console.log("ok - plugin registry isolates editors, enforces limits, and cleans up");
