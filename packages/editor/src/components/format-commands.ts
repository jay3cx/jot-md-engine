import type { EditorCommand, EditorCommandContext, EditorCommandResult, EditorShortcut } from "../core/commands/index.js";
import { range } from "../adapter/text-model.js";
import type { Utf16Offset } from "@jot-md/editor-protocol";

function wrap(context: EditorCommandContext, marker: string, id: string): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  const from = Math.min(context.selection.anchor, context.selection.head);
  const to = Math.max(context.selection.anchor, context.selection.head);
  const selected = context.source.slice(from, to);
  if (selected.includes("\n")) return undefined;
  const unwrap = from >= marker.length &&
    context.source.slice(from - marker.length, from) === marker &&
    context.source.slice(to, to + marker.length) === marker;
  const start = unwrap ? from - marker.length : from;
  const end = unwrap ? to + marker.length : to;
  const insert = unwrap ? selected : `${marker}${selected}${marker}`;
  const anchor = unwrap ? start : from + marker.length;
  return {
    edits: [{ range: range(start, end), insert }],
    selection: { anchor: anchor as Utf16Offset, head: (anchor + selected.length) as Utf16Offset },
    userEvent: `input.format.${id}`,
  };
}

export const formatCommands: readonly EditorCommand[] = [
  ...([
    ["bold", "加粗", "**"], ["italic", "斜体", "*"], ["code", "行内代码", "`"],
  ] as const).map(([id, title, marker]) => ({
    id: `format.${id}`, title, run: (context: EditorCommandContext) => wrap(context, marker, id),
  })),
  {
    id: "format.link", title: "插入链接",
    run(context) {
      if ((context.selectionCount ?? 1) !== 1) return undefined;
      const from = Math.min(context.selection.anchor, context.selection.head);
      const to = Math.max(context.selection.anchor, context.selection.head);
      const text = context.source.slice(from, to) || "链接文字";
      if (text.includes("\n")) return undefined;
      const insert = `[${text}](https://)`;
      const anchor = from + text.length + 3;
      return { edits: [{ range: range(from, to), insert }],
        selection: { anchor: anchor as Utf16Offset, head: (anchor + 8) as Utf16Offset },
        userEvent: "input.format.link" };
    },
  },
  ...Array.from({ length: 6 }, (_, index): EditorCommand => ({
    id: `format.heading-${index + 1}`, title: `${index + 1} 级标题`,
    run(context) {
      if ((context.selectionCount ?? 1) !== 1) return undefined;
      const position = Math.min(context.selection.anchor, context.selection.head);
      const from = position === 0 ? 0 : context.source.lastIndexOf("\n", position - 1) + 1;
      const end = context.source.indexOf("\n", from);
      const line = context.source.slice(from, end < 0 ? undefined : end);
      const marker = /^(#{1,6})\s+/u.exec(line)?.[0] ?? "";
      const insert = `${"#".repeat(index + 1)} `;
      return { edits: [{ range: range(from, from + marker.length), insert }],
        userEvent: "input.format.heading" };
    },
  })),
];

export const formatShortcuts: readonly EditorShortcut[] = [
  { id: "format.bold", command: "format.bold", key: "Mod-b" },
  { id: "format.italic", command: "format.italic", key: "Mod-i" },
  { id: "format.code", command: "format.code", key: "Mod-`" },
  { id: "format.link", command: "format.link", key: "Mod-k" },
  ...Array.from({ length: 6 }, (_, index) => ({
    id: `format.heading-${index + 1}`, command: `format.heading-${index + 1}`, key: `Mod-Alt-${index + 1}`,
  })),
];
