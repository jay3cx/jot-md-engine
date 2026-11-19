import type { TextEdit, Utf16Offset } from "@jot-md/editor-protocol";
import { range } from "../adapter/text-model.js";
import { tableRowCells } from "./table/source.js";
import type { EditorCommand, EditorCommandContext, EditorCommandResult } from "../core/commands/index.js";

/** Shared insertion recipe: keep physical separators and place selection inside content. */
function block(context: EditorCommandContext, id: string, build: (selected: string) => {
  text: string; anchor: number; head?: number;
}): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  const from = Math.min(context.selection.anchor, context.selection.head);
  const to = Math.max(context.selection.anchor, context.selection.head);
  const content = build(context.source.slice(from, to));
  const before = separator(context.source, from, content.text, 0);
  const after = separator(content.text, content.text.length, context.source, to);
  return {
    edits: [{ range: range(from, to), insert: before + content.text + after }],
    selection: {
      anchor: (from + before.length + content.anchor) as Utf16Offset,
      head: (from + before.length + (content.head ?? content.anchor)) as Utf16Offset,
    },
    userEvent: `input.insert.${id}`,
  };
}

/** Account for separators already owned by either side, including a new trailing paragraph. */
function separator(left: string, end: number, right: string, start: number): string {
  if (end === 0 || start === right.length) return "";
  let count = 0;
  for (let index = end - 1; index >= 0 && left[index] === "\n" && count < 2; index -= 1) count += 1;
  for (let index = start; index < right.length && right[index] === "\n" && count < 2; index += 1) count += 1;
  return "\n".repeat(2 - count);
}

function prefix(context: EditorCommandContext, id: string, marker: string): EditorCommandResult | undefined {
  if ((context.selectionCount ?? 1) !== 1) return undefined;
  const start = Math.min(context.selection.anchor, context.selection.head);
  const end = Math.max(context.selection.anchor, context.selection.head);
  const from = start === 0 ? 0 : context.source.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && context.source[end - 1] === "\n" ? end - 1 : end;
  const newline = context.source.indexOf("\n", last);
  const to = newline < 0 ? context.source.length : newline;
  const lines = context.source.slice(from, to).split("\n");
  let offset = from;
  const targets = lines.flatMap((line) => {
    const indent = /^[\t ]*/u.exec(line)![0].length;
    const position = offset + indent;
    offset += line.length + 1;
    // A selected separator stays a separator. A single caret on a blank line
    // can still create the requested list/quote marker for subsequent typing.
    if (start !== end && line.trim().length === 0) return [];
    const text = line.slice(indent);
    const existing = id === "format.ordered-list"
      ? /^\d+[.)] /u.exec(text)?.[0]
      : text.startsWith(marker) ? marker : undefined;
    return [{ position, existing }];
  });
  if (targets.length === 0) return undefined;
  const remove = targets.every((target) => target.existing !== undefined);
  const edits: TextEdit[] = targets.flatMap(({ position, existing }) =>
    remove
      ? [{ range: range(position, position + existing!.length), insert: "" }]
      : existing === undefined ? [{ range: range(position, position), insert: marker }] : []);
  const map = (position: number): Utf16Offset => {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.range.from) break;
      if (position <= edit.range.to) return (edit.range.from + delta + edit.insert.length) as Utf16Offset;
      delta += edit.insert.length - (edit.range.to - edit.range.from);
    }
    return (position + delta) as Utf16Offset;
  };
  return { edits,
    selection: { anchor: map(context.selection.anchor), head: map(context.selection.head) },
    userEvent: `input.${id}` };
}

export const blockCommands: readonly EditorCommand[] = [
  ...([
    ["format.bullet-list", "切换无序列表", "- "],
    ["format.ordered-list", "切换有序列表", "1. "],
    ["format.quote", "切换引用", "> "],
  ] as const).map(([id, title, marker]): EditorCommand => ({
    id, title, category: "块格式", run: (context) => prefix(context, id, marker),
  })),
  { id: "insert.code-block", title: "插入代码块", category: "插入", run: (context) =>
    block(context, "code-block", (selected) => {
      const opening = "``` js begin\n";
      return { text: `${opening}${selected}\n\`\`\` end`, anchor: opening.length, head: opening.length + selected.length };
    }) },
  { id: "insert.math-block", title: "插入公式块", category: "插入", run: (context) =>
    block(context, "math-block", (selected) => ({ text: `$$\n${selected || "x"}\n$$`, anchor: 3, head: 3 + (selected || "x").length })) },
  { id: "insert.table", title: "插入表格", category: "插入", run: (context) =>
    block(context, "table", () => {
      const header = "| A | B |\n| --- | --- |\n";
      const body = "|  |  |";
      return { text: header + body, anchor: tableRowCells(body, header.length)[0]!.from };
    }) },
  { id: "insert.image", title: "插入图片", category: "插入", run: (context) =>
    block(context, "image", (selected) => {
      const alt = selected.replace(/\r\n?|\n/gu, " ").replace(/\\/gu, "\\\\").replace(/[\[\]]/gu, "\\$&");
      const opening = `![${alt}](`;
      return { text: `${opening}https://)`, anchor: opening.length, head: opening.length + "https://".length };
    }) },
  { id: "insert.thematic-break", title: "插入分隔线", category: "插入", run: (context) =>
    block(context, "thematic-break", () => ({ text: "---\n\n", anchor: 5 })) },
];
