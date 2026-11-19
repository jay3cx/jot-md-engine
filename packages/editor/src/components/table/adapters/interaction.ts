import type { RenderNode } from "@jot-md/editor-protocol";
import { findClusterBreak } from "@codemirror/state";
import { singleTextEdit } from "../../../adapter/text-diff.js";
import type {
  ComponentInteractionAdapter,
} from "../../contracts.js";
import {
  encodeTableCell,
  isTableCellEscape,
  keepsTablePipes,
  tableCellAt,
  tablePipeOffsets,
  tableRootDeletionRange,
} from "../source.js";
import type { TableComponentModel } from "../model.js";

/**
 * Rust table projection 在浏览器端的最小交互索引。
 *
 * 这个模块只消费 RenderNode 的 sourceRange 和 structured children，不重新
 * 解析 Markdown。表格的 pipe、对齐分隔行以及 cell 之间的空隙如果没有对应
 * RenderNode，就统一视为 protected surface，交给宿主的源码边界解析处理。
 * 这里不复制一套 Markdown 语法解析器，也不把缺少语义索引的状态误认为
 * 一个完整可导航的表格。
 */
export interface TableRenderCellTarget {
  readonly table: RenderNode;
  readonly row: RenderNode;
  readonly cell: RenderNode;
  readonly rowIndex: number;
  readonly columnIndex: number;
}

export type TableRenderPosition =
  | { readonly kind: "cell"; readonly target: TableRenderCellTarget }
  | {
      readonly kind: "protected";
      readonly table: RenderNode;
      readonly row?: RenderNode;
    };

export type TableRenderNavigation =
  | { readonly kind: "cell"; readonly target: TableRenderCellTarget }
  | { readonly kind: "handled" };

export type TableRenderDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "next"
  | "previous";

export interface TableMappedInputSelection {
  readonly from: number;
  readonly to: number;
}

export interface TableMappedInputCell {
  readonly from: number;
  readonly to: number;
}

export interface TableMappedInput {
  readonly inputType: string;
  /** Host 已从 InputEvent / DataTransfer 提取的纯文本，不传递 DOM event 给组件。 */
  readonly data?: string;
}

/**
 * 将 mapped table-root 内的浏览器 beforeinput 转回唯一 CodeMirror transaction。
 *
 * 这是 table 组件的输入序列化规则，不属于 LivePreviewController：Controller
 * 只负责把来自 widget 的 event 和当前 CodeMirror selection 交给这里。
 * 转义必须看到编辑后的完整 cell：反斜杠可能来自光标的任意一侧。
 */
export function tableMappedInputChange(
  source: string,
  selection: TableMappedInputSelection,
  cell: TableMappedInputCell,
  input: TableMappedInput,
): { readonly from: number; readonly to: number; readonly insert: string; readonly cursor: number } | undefined {
  let from = clamp(selection.from, cell.from, cell.to);
  let to = clamp(selection.to, from, cell.to);
  let inserted = "";
  switch (input.inputType) {
    case "insertText":
    case "insertFromPaste":
      if (!input.data) return undefined;
      inserted = input.data.replace(/\r\n?|\n/gu, " ");
      break;
    case "deleteContentBackward":
      if (from === to) {
        if (from === cell.from) return undefined;
        from = Math.max(cell.from, findClusterBreak(source, from, false, true));
      }
      break;
    case "deleteContentForward":
      if (from === to) {
        if (to === cell.to) return undefined;
        to = Math.min(cell.to, findClusterBreak(source, to, true, true));
      }
      break;
    case "deleteByCut":
    case "deleteByDrag":
      break;
    default:
      return undefined;
  }
  if (inserted === "" && from === to) return undefined;
  const previous = source.slice(cell.from, cell.to);
  if (inserted === "") {
    // Deleting either side of a rendered escape removes the token, without
    // reaching a pipe outside the editable cell.
    if (isTableCellEscape(previous, from - cell.from - 1)) from -= 1;
    if (isTableCellEscape(previous, to - cell.from - 1)) to += 1;
  }
  const cursor = from - cell.from + inserted.length;
  if (!/[\\|`]/u.test(previous) && !/[\\|`]/u.test(inserted)) {
    return { from, to, insert: inserted, cursor: cell.from + cursor };
  }
  const next = source.slice(cell.from, from) + inserted + source.slice(to, cell.to);
  const encoded = encodeTableCell(next, cursor, source[cell.to] === "|");
  if (!keepsTablePipes(source, cell, encoded.text)) return undefined;
  const [edit] = singleTextEdit(previous, encoded.text, encoded.cursor);
  return edit === undefined ? undefined : {
    from: cell.from + Number(edit.range.from),
    to: cell.from + Number(edit.range.to),
    insert: edit.insert,
    cursor: cell.from + encoded.cursor,
  };
}


export function tableMappedInputUserEvent(inputType: string): string {
  if (inputType === "insertFromPaste") return "input.table.paste";
  if (inputType.startsWith("delete")) return "input.table.delete";
  return "input.table.type";
}

/**
 * Table 的通用编辑边界。Preview pointer/key adapter 与 CodeMirror transaction
 * policy 都消费同一份 Rust RenderNode 范围：cell 内容可编辑，其余 table 源码
 * 属于 protected / command surface。未加载的 row/cell 不伪造范围，而是保守地
 * 保护该部分 table。
 */
export const tableInteractionAdapter: ComponentInteractionAdapter<TableComponentModel> = {
  ranges(model) {
    if (model.kind !== "table") return undefined;
    const table = normalizedRange(model.node.sourceRange);
    const cells = tableCells(model.node)
      .map((cell) => normalizedRange(cell.sourceRange))
      .filter((range) => range.from >= table.from && range.to <= table.to);
    const editableRanges = mergeRanges(cells);
    return {
      editableRanges: editableRanges.map(textRange),
      protectedRanges: complement(table, editableRanges).map(textRange),
      commandRanges: [textRange(table)],
      ownsDescendants: true,
    };
  },
  allowsEdit(edit) {
    // GFM pipe table 的物理结构只能由 command 改动。普通 cell 输入不能凭借
    // 粘贴或键盘把一行拆成两行，也不能引入新的未转义列分隔符。
    return !/\r|\n/u.test(edit.insert) && tablePipeOffsets(edit.insert).length === 0;
  },
  resolveDeletion(model, deletion, ranges, context) {
    // Prefer the cell contract when a source offset is shared by a root edge
    // and a cell edge (notably tables without an outer pipe). A character
    // editing boundary must never be reinterpreted as “delete the whole
    // table”; root deletion is available only from an actual external syntax
    // boundary.
    const cell = tableCellAt(context.source, deletion.position);
    const withinRoot = cell !== undefined &&
      Number(model.sourceRange.from) <= cell.from &&
      cell.to <= Number(model.sourceRange.to);
    if (withinRoot && cell !== undefined) {
      const atEditableBoundary = deletion.direction === "backward"
        ? deletion.position === cell.from
        : deletion.position === cell.to;
      if (atEditableBoundary) {
        return {
          kind: "consume",
          anchor: deletion.direction === "backward" ? cell.from : cell.to,
        };
      }
      // At EOF an unpiped last cell can end at exactly the table root's end.
      // A caret inside that cell still owns ordinary character deletion. Do
      // not reinterpret the same offset as an external whole-root deletion.
      if (cell.from <= deletion.position && deletion.position <= cell.to) {
        return undefined;
      }
    }

    const root = tableRootDeletionRange(
      context.source,
      ranges.commandRanges[0] ?? model.sourceRange,
      deletion.position,
      deletion.direction,
    );
    if (root !== undefined) {
      return {
        kind: "delete-range",
        from: root.from,
        to: root.to,
      };
    }
    return undefined;
  },
};

/** Rust 已确认的 table 根范围；源码拓扑只能在这个范围内作为安全降级。 */
export function tableRenderRootAt(
  nodes: readonly RenderNode[],
  offset: number,
): RenderNode | undefined {
  return tableAt(nodes, offset);
}

export function tableRenderPositionAt(
  nodes: readonly RenderNode[],
  offset: number,
): TableRenderPosition | undefined {
  const table = tableRenderRootAt(nodes, offset);
  if (table === undefined) return undefined;
  const rows = tableRows(table);
  if (rows === undefined) return undefined;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    if (!contains(row, offset)) continue;
    const cells = rowCells(row);
    for (let columnIndex = 0; columnIndex < cells.length; columnIndex += 1) {
      const cell = cells[columnIndex]!;
      if (contains(cell, offset)) {
        return {
          kind: "cell",
          target: { table, row, cell, rowIndex, columnIndex },
        };
      }
    }
    return { kind: "protected", table, row };
  }
  return { kind: "protected", table };
}

export function tableRenderCellAt(
  nodes: readonly RenderNode[],
  offset: number,
): TableRenderCellTarget | undefined {
  const position = tableRenderPositionAt(nodes, offset);
  return position?.kind === "cell" ? position.target : undefined;
}

/**
 * 在已投影的 table 结构内导航。返回 undefined 表示当前投影不能安全决定
 * 导航目标：包括 protected surface、表格外边界、缺失的结构化子节点以及
 * 尚未完成的 Rust projection。宿主随后可以使用统一的源码边界解析。
 * `handled` 只保留给未来明确由 RenderNode 声明“按键已消费、不可写入”的
 * 语义节点；当前 table 不在这里伪造这种状态。
 */
export function tableRenderNavigation(
  nodes: readonly RenderNode[],
  offset: number,
  direction: TableRenderDirection,
): TableRenderNavigation | undefined {
  const position = tableRenderPositionAt(nodes, offset);
  if (position === undefined) return undefined;
  if (position.kind !== "cell") return undefined;

  const { target } = position;
  const rows = tableRows(target.table);
  if (rows === undefined) return undefined;
  const currentRow = rows[target.rowIndex];
  if (currentRow === undefined) return undefined;
  const cells = rowCells(currentRow);
  let rowIndex = target.rowIndex;
  let columnIndex = target.columnIndex;

  if ((direction === "left" && offset > Number(target.cell.sourceRange.from)) ||
      (direction === "right" && offset < Number(target.cell.sourceRange.to))) {
    // 只有在当前 editable range 的边缘，组件才接管水平键；cell 内部仍由
    // CodeMirror 处理字符级移动和选区扩展。
    return undefined;
  }

  switch (direction) {
    case "left":
    case "previous":
      if (columnIndex > 0) columnIndex -= 1;
      else if (rowIndex > 0) {
        rowIndex -= 1;
        columnIndex = Math.max(0, rowCells(rows[rowIndex]!).length - 1);
      } else {
        return undefined;
      }
      break;
    case "right":
    case "next":
      if (columnIndex + 1 < cells.length) columnIndex += 1;
      else if (rowIndex + 1 < rows.length) {
        rowIndex += 1;
        columnIndex = 0;
      } else {
        return undefined;
      }
      break;
    case "up":
      if (rowIndex === 0) return undefined;
      rowIndex -= 1;
      columnIndex = nearestColumn(rows[rowIndex]!, columnIndex);
      break;
    case "down":
      if (rowIndex + 1 >= rows.length) return undefined;
      rowIndex += 1;
      columnIndex = nearestColumn(rows[rowIndex]!, columnIndex);
      break;
  }

  const row = rows[rowIndex];
  const cell = row === undefined ? undefined : rowCells(row)[columnIndex];
  return row === undefined || cell === undefined
    ? undefined
    : {
        kind: "cell",
        target: {
          table: target.table,
          row,
          cell,
          rowIndex,
          columnIndex,
        },
      };
}

function tableAt(nodes: readonly RenderNode[], offset: number): RenderNode | undefined {
  return nodes
    .filter((node) => node.kind === "table" && contains(node, offset))
    .sort((left, right) =>
      Number(right.sourceRange.from) - Number(left.sourceRange.from))[0];
}

function tableRows(table: RenderNode): readonly RenderNode[] | undefined {
  return table.content.type === "structured"
    ? table.content.children.filter((node) => node.kind === "table-row")
    : undefined;
}

function rowCells(row: RenderNode): readonly RenderNode[] {
  return row.content.type === "structured"
    ? row.content.children.filter((node) => node.kind === "table-cell")
    : [];
}

function nearestColumn(row: RenderNode, column: number): number {
  const cells = rowCells(row);
  return cells.length === 0 ? 0 : Math.min(column, cells.length - 1);
}

function contains(node: RenderNode, offset: number): boolean {
  return Number(node.sourceRange.from) <= offset &&
    offset <= Number(node.sourceRange.to);
}

function tableCells(table: RenderNode): readonly RenderNode[] {
  if (table.content.type !== "structured") return [];
  return table.content.children
    .filter((row) => row.kind === "table-row")
    .flatMap((row) => row.content.type === "structured"
      ? row.content.children.filter((cell) => cell.kind === "table-cell")
      : []);
}

function normalizedRange(range: { readonly from: number; readonly to: number }): {
  readonly from: number;
  readonly to: number;
} {
  const from = Math.max(0, Number(range.from));
  const to = Math.max(from, Number(range.to));
  return { from, to };
}

function mergeRanges(
  ranges: readonly { readonly from: number; readonly to: number }[],
): readonly { readonly from: number; readonly to: number }[] {
  const result: Array<{ readonly from: number; readonly to: number }> = [];
  for (const range of [...ranges].sort((left, right) =>
    left.from - right.from || left.to - right.to)) {
    const previous = result.at(-1);
    if (previous !== undefined && range.from <= previous.to) {
      result[result.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, range.to),
      };
    } else {
      result.push(range);
    }
  }
  return result;
}

function complement(
  outer: { readonly from: number; readonly to: number },
  editable: readonly { readonly from: number; readonly to: number }[],
): readonly { readonly from: number; readonly to: number }[] {
  const protectedRanges: Array<{ readonly from: number; readonly to: number }> = [];
  let cursor = outer.from;
  for (const range of editable) {
    if (cursor < range.from) protectedRanges.push({ from: cursor, to: range.from });
    cursor = Math.max(cursor, range.to);
  }
  if (cursor < outer.to) protectedRanges.push({ from: cursor, to: outer.to });
  return protectedRanges;
}

function textRange(range: { readonly from: number; readonly to: number }): import("@jot-md/editor-protocol").TextRange {
  return {
    from: range.from as import("@jot-md/editor-protocol").TextRange["from"],
    to: range.to as import("@jot-md/editor-protocol").TextRange["to"],
  };
}

function clamp(value: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, value));
}
