import type {
  EditorCommand,
  EditorCommandContext,
  EditorCommandResult,
  EditorShortcut,
} from "../../core/commands/index.js";
import {
  clearTableCell,
  editTableColumn,
  deleteTableRow,
  insertTableRow,
  tableCellTargetAt,
  tableInRange,
  tableTargetInRange,
  type TableCellTarget,
  tableNavigationTarget,
} from "./source.js";

export const TABLE_COMMAND = {
  nextCell: "table.next-cell",
  previousCell: "table.previous-cell",
  cellAbove: "table.cell-above",
  cellBelow: "table.cell-below",
  clearCell: "table.clear-cell",
  insertRowBelow: "table.insert-row-below",
  deleteRow: "table.delete-row",
  insertColumnAfter: "table.insert-column-after",
  deleteColumn: "table.delete-column",
} as const;

export type TableCommandId = typeof TABLE_COMMAND[keyof typeof TABLE_COMMAND];

/** Live Preview 的交互命令不写源码，宿主只负责把 CodeMirror selection 移到目标位置。 */
export const TABLE_INTERACTION_COMMAND = {
  focusLeft: "table.focus-cell-left",
  focusRight: "table.focus-cell-right",
  focusAbove: "table.focus-cell-above",
  focusBelow: "table.focus-cell-below",
  focusNext: "table.focus-cell-next",
  focusPrevious: "table.focus-cell-previous",
  beginEdit: "table.begin-cell-edit",
} as const;

export type TableInteractionCommandId =
  typeof TABLE_INTERACTION_COMMAND[keyof typeof TABLE_INTERACTION_COMMAND];

export interface TableLivePreviewKeyInput {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/** 统一维护 Live Preview 的方向键映射；Source keymap 不注册这些裸方向键。 */
export function tableLivePreviewCommand(
  input: TableLivePreviewKeyInput,
): TableInteractionCommandId | undefined {
  if (input.altKey === true || input.ctrlKey === true || input.metaKey === true) return undefined;
  if (input.shiftKey === true && input.key !== "Enter" && input.key !== "Tab") return undefined;
  switch (input.key) {
    case "ArrowLeft": return TABLE_INTERACTION_COMMAND.focusLeft;
    case "ArrowRight": return TABLE_INTERACTION_COMMAND.focusRight;
    case "ArrowUp": return TABLE_INTERACTION_COMMAND.focusAbove;
    case "ArrowDown": return TABLE_INTERACTION_COMMAND.focusBelow;
    case "Tab":
      return input.shiftKey === true
        ? TABLE_INTERACTION_COMMAND.focusPrevious
        : TABLE_INTERACTION_COMMAND.focusNext;
    case "Enter":
      return input.shiftKey === true ? undefined : TABLE_INTERACTION_COMMAND.beginEdit;
    default: return undefined;
  }
}

/** 宿主只提供命令执行端口；命令实现仍由本文件集中维护。 */
export type TableCommandExecutor = (
  command: TableCommandId,
  anchor: number,
) => boolean;

/**
 * 表格命令的唯一语义实现。它们都是 source -> TextEdit 的纯函数，因此 Source、
 * Table Live Preview、菜单和未来 Extension SDK 都会走同一条 Rust 事务链路。
 */
export const tableCommands: readonly EditorCommand[] = [
  navigationCommand(TABLE_COMMAND.nextCell, "下一个表格单元格", "next"),
  navigationCommand(TABLE_COMMAND.previousCell, "上一个表格单元格", "previous"),
  navigationCommand(TABLE_COMMAND.cellAbove, "上方表格单元格", "up"),
  navigationCommand(TABLE_COMMAND.cellBelow, "下方表格单元格", "down"),
  editCommand(TABLE_COMMAND.clearCell, "清空表格单元格", (_, target) => clearTableCell(target)),
  editCommand(TABLE_COMMAND.insertRowBelow, "在下方插入表格行", insertTableRow),
  editCommand(TABLE_COMMAND.deleteRow, "删除表格行", deleteTableRow),
  columnCommand(TABLE_COMMAND.insertColumnAfter, "在右侧插入表格列", "insert-after"),
  columnCommand(TABLE_COMMAND.deleteColumn, "删除表格列", "delete"),
];

/**
 * 所有默认快捷键集中在组件命令声明旁。`Mod` 由 CodeMirror 归一化为当前平台的
 * Command/Control；命令不适用时返回 false，Markdown 的默认按键继续生效。
 */
export const tableShortcuts: readonly EditorShortcut[] = [
  { id: "table.next-row", key: "Enter", command: TABLE_COMMAND.cellBelow },
  { id: "table.previous-row", key: "Shift-Enter", command: TABLE_COMMAND.cellAbove },
  { id: "table.next-cell", key: "Tab", command: TABLE_COMMAND.nextCell },
  { id: "table.previous-cell", key: "Shift-Tab", command: TABLE_COMMAND.previousCell },
  { id: "table.cell-above", key: "Alt-ArrowUp", command: TABLE_COMMAND.cellAbove },
  { id: "table.cell-below", key: "Alt-ArrowDown", command: TABLE_COMMAND.cellBelow },
  { id: "table.insert-row-below", key: "Mod-Alt-ArrowDown", command: TABLE_COMMAND.insertRowBelow },
  { id: "table.delete-row", key: "Mod-Alt-Backspace", command: TABLE_COMMAND.deleteRow },
  {
    id: "table.insert-column-after",
    key: "Mod-Alt-ArrowRight",
    command: TABLE_COMMAND.insertColumnAfter,
  },
  {
    id: "table.delete-column",
    key: "Mod-Alt-Shift-Backspace",
    command: TABLE_COMMAND.deleteColumn,
  },
  { id: "table.clear-cell", key: "Alt-Shift-Backspace", command: TABLE_COMMAND.clearCell },
];

function navigationCommand(
  id: TableCommandId,
  title: string,
  direction: "next" | "previous" | "up" | "down",
): EditorCommand {
  return {
    id,
    title,
    run(context) {
      if (context.selectionCount !== undefined && context.selectionCount !== 1) return undefined;
      const target = tableNavigationTarget(
        context.source,
        Number(context.selection.head),
        direction,
      );
      // A boundary is still a handled table command. Returning undefined here
      // would let CodeMirror's generic indentWithTab handler mutate the row.
      if (target === undefined) {
        return tableCellTargetAt(context.source, Number(context.selection.head)) === undefined
          ? undefined
          : { userEvent: `input.${id}` };
      }
      return {
        selection: selection(target.cell.from),
        userEvent: `input.${id}`,
      };
    },
  };
}

function commandTarget(context: EditorCommandContext): TableCellTarget | undefined {
  const block = context.block;
  return block?.kind === "table"
    ? tableTargetInRange(context.source, Number(context.selection.head), block.sourceRange)
    : undefined;
}

function editCommand(
  id: TableCommandId,
  title: string,
  edit: (source: string, target: TableCellTarget) => import("@jot-md/editor-protocol").TextEdit | undefined,
): EditorCommand {
  return {
    id,
    title,
    run(context): EditorCommandResult | undefined {
      if (context.selectionCount !== undefined && context.selectionCount !== 1) return undefined;
      const current = commandTarget(context);
      if (current === undefined) return undefined;
      const change = edit(context.source, current);
      if (change === undefined) return undefined;
      const { table, cell } = current;
      const rowIndex = table.rows.indexOf(current.row) + (id === TABLE_COMMAND.insertRowBelow ? 1 : 0);
      const text = context.source.slice(table.from, change.range.from) + change.insert +
        context.source.slice(change.range.to, table.to);
      const next = tableInRange(text, { from: 0, to: text.length });
      const row = next?.rows[Math.min(rowIndex, next.rows.length - 1)];
      const anchor = row?.cells[Math.min(cell.column, row.cells.length - 1)]?.from;
      return {
        edits: [change],
        ...(anchor === undefined ? {} : { selection: selection(table.from + anchor) }),
        origin: "keyboard",
        userEvent: `input.${id}`,
      };
    },
  };
}

function columnCommand(
  id: TableCommandId, title: string, operation: "insert-after" | "delete",
): EditorCommand {
  return {
    id,
    title,
    run(context) {
      if (context.selectionCount !== undefined && context.selectionCount !== 1) return undefined;
      const target = commandTarget(context);
      if (target === undefined) return undefined;
      const result = editTableColumn(context.source, target, operation);
      if (result === undefined) return undefined;
      return {
        edits: result.edits,
        ...(result.anchor === undefined ? {} : { selection: selection(result.anchor) }),
        origin: "keyboard",
        userEvent: `input.${id}`,
      };
    },
  };
}

function selection(offset: number) {
  return {
    anchor: offset as import("@jot-md/editor-protocol").Utf16Offset,
    head: offset as import("@jot-md/editor-protocol").Utf16Offset,
  };
}
