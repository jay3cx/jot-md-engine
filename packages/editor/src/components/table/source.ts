import type { TextEdit, TextRange } from "@jot-md/editor-protocol";
import { range } from "../../adapter/text-model.js";

export interface TableCellRange {
  readonly from: number;
  readonly to: number;
  readonly rowFrom: number;
  readonly rowTo: number;
  readonly column: number;
}

export interface TableRowCell {
  readonly from: number;
  readonly to: number;
  readonly column: number;
}

export type TableSourceRowRole = "header" | "delimiter" | "body";

/** 已由 Rust 确认是 table 后，前端用于 command 变换和安全边界降级的源码拓扑。 */
export interface TableSourceRow {
  readonly role: TableSourceRowRole;
  readonly from: number;
  readonly to: number;
  readonly cells: readonly TableRowCell[];
}

/**
 * 管道表格的最小源码模型。它只服务 command 和详情未加载时的边界定位；是否为 table
 * 仍以 Rust RenderNode 为准，不能把这个模型当作新的 Markdown 语义解析器。
 */
export interface TableSourceModel {
  readonly from: number;
  readonly to: number;
  readonly columnCount: number;
  readonly header: TableSourceRow;
  readonly delimiter: TableSourceRow;
  readonly body: readonly TableSourceRow[];
  readonly rows: readonly TableSourceRow[];
}

export interface TableCellTarget {
  readonly table: TableSourceModel;
  readonly row: TableSourceRow;
  readonly cell: TableRowCell;
}

export type TableNavigationDirection = "next" | "previous" | "up" | "down";

export type TableSurfaceNavigationDirection =
  | "left"
  | "right"
  | TableNavigationDirection;

export type TableBoundaryNavigationTarget =
  | { readonly kind: "cell"; readonly target: TableCellTarget }
  | { readonly kind: "source"; readonly offset: number }
  | { readonly kind: "insert-line"; readonly offset: number; readonly insert: string };

/**
 * 已确认 table root 与外部普通源码的删除边界。
 *
 * 这不是 cell 内文本删除：调用方必须先确认 selection 不在任何 Rust-confirmed
 * editable cell 内。它为 Preview 中作为一个可视 block 的 table 提供与普通
 * atomic block 一致的外部删除语义：
 *
 * - caret 紧邻 table 前方 + Delete → 删除整个 table；
 * - caret 紧邻 table 后方 + Backspace → 删除整个 table。
 *
 * 删除范围会包含 table 自己的一个终止 LF，但绝不吞掉随后真实 BlankLine。这样
 * 删除不会把前后物理行错误粘成同一 Markdown 行，也不会额外移除用户明确写下的
 * 空白行。是否真的是 table 仍只能由 Rust RenderNode 决定；这里仅消费已传入的
 * confirmed root range。
 */
export function tableRootDeletionRange(
  source: string,
  tableRange: TextRange,
  offset: number,
  direction: "backward" | "forward",
): { readonly from: number; readonly to: number } | undefined {
  const from = clampOffset(source, Number(tableRange.from));
  const rawTo = clampOffset(source, Math.max(from, Number(tableRange.to)));
  if (rawTo <= from) return undefined;
  const to = ownBlockTerminatorEnd(source, from, rawTo);
  const position = clampOffset(source, offset);
  if (direction === "backward") {
    // Only the position after the root's physical terminator is an external
    // “after table” boundary. `rawTo` can coincide with the final cell end in
    // tables without a trailing pipe, so treating it as root deletion would
    // make ordinary cell-edge Backspace delete the entire table.
    return position === to ? { from, to } : undefined;
  }
  return position === from ? { from, to } : undefined;
}

/**
 * 一个 selection 在已确认的 table 源码投影中的位置。
 *
 * `cell` 只表示可以编辑的内容范围；`syntax` 覆盖 pipe、空格、行首/行尾和
 * delimiter。后者不能成为视觉 caret 的稳定目标，但必须先被导航层识别，才能
 * 阻止 CodeMirror 把隐藏的 Markdown 语法当作普通文本继续移动。
 */
export type TableSurfacePosition =
  | { readonly kind: "cell"; readonly target: TableCellTarget }
  | {
    readonly kind: "syntax";
    readonly table: TableSourceModel;
    readonly row: TableSourceRow;
    /** 光标左侧和右侧最近的源码 cell；delimiter 内容本身两侧都指向同一列。 */
    readonly leftColumn: number | undefined;
    readonly rightColumn: number | undefined;
  };

/** 表面导航的统一结果；`handled` 表示属于 table 但该方向没有移动目标。 */
export type TableSurfaceNavigationTarget =
  | TableBoundaryNavigationTarget
  | { readonly kind: "handled" };

/**
 * 管道表格的源码范围工具。它是输入、搜索和未来 cell overlay 的唯一前端兜底
 * 解析路径；Rust RenderNode 可用时，语义层仍优先使用 Rust 提供的范围。
 */
export function tableCellAt(source: string, offset: number): TableCellRange | undefined {
  const safeOffset = Math.max(0, Math.min(source.length, offset));
  const { from: rowFrom, to: rowTo } = sourceLineAt(source, safeOffset);
  const line = source.slice(rowFrom, rowTo);
  const cells = tableRowCells(line, rowFrom);
  if (cells.length === 0 || !isTableContext(source, rowFrom, rowTo, cells)) return undefined;
  const cell = cellOnRow(cells, safeOffset, rowTo);
  return cell === undefined ? undefined : { ...cell, rowFrom, rowTo };
}

function cellOnRow(cells: readonly TableRowCell[], offset: number, rowTo: number): TableRowCell | undefined {
  return cells.find((candidate, index) => {
    const next = cells[index + 1];
    const end = next?.from ?? rowTo;
    // 下一个 cell 的起点属于下一个 cell；否则光标正好落到 `| B` 的 B 上时
    // 会被错误归到前一列，Tab 或 cell 点击都会停在原单元格。
    const insideLastCell = offset < end ||
      (offset === end && candidate.to === rowTo);
    return offset >= candidate.from &&
      (next === undefined ? insideLastCell : offset < end);
  });
}

export function replaceTableCell(
  source: string,
  offset: number,
  value: string,
  bounds: TextRange,
): TextEdit | undefined {
  if (offset < bounds.from || offset > bounds.to) return undefined;
  const row = sourceLineAt(source, offset);
  const header = sourceLineAt(source, bounds.from);
  if (row.from === header.to + 1) return undefined;
  const cells = tableRowCells(source.slice(row.from, row.to), row.from);
  const cell = cellOnRow(cells, offset, row.to);
  if (cell === undefined) return undefined;
  const insert = serializeTableCell(value, source[cell.to] === "|");
  if (!keepsTablePipes(source, cell, insert)) return undefined;
  return {
    range: range(cell.from, cell.to),
    insert,
  };
}

/** 查找当前光标所在的 Rust/GFM 管道表格。 */
export function tableAt(source: string, offset: number): TableSourceModel | undefined {
  const cell = tableCellAt(source, offset);
  if (cell === undefined) return undefined;
  const table = tableFromLine(source, cell.rowFrom);
  return table?.rows.some((row) => row.from === cell.rowFrom) === true ? table : undefined;
}

/** Build command topology from the confirmed root bounds or the result of a single row edit. */
export function tableInRange(
  source: string,
  bounds: { readonly from: number; readonly to: number },
): TableSourceModel | undefined {
  const lines: SourceLine[] = [];
  for (let from = bounds.from; from < bounds.to;) {
    const newline = source.indexOf("\n", from);
    const to = newline < 0 ? bounds.to : Math.min(newline, bounds.to);
    lines.push(toSourceLine(source, { from, to }));
    from = to + 1;
  }
  return lines[1]?.delimiter ? tableFromRows(lines, 1) : undefined;
}

export function tableTargetInRange(source: string, offset: number, bounds: TextRange): TableCellTarget | undefined {
  if (offset < bounds.from || offset > bounds.to) return undefined;
  const table = tableInRange(source, bounds);
  const row = table?.rows.find((row) => row.from <= offset && offset <= row.to);
  if (table === undefined || row === undefined) return undefined;
  const cell = cellOnRow(row.cells, offset, row.to);
  return cell === undefined ? undefined : { table, row, cell };
}

export function tableCellTargetAt(source: string, offset: number): TableCellTarget | undefined {
  const cell = tableCellAt(source, offset);
  if (cell === undefined) return undefined;
  const table = tableFromLine(source, cell.rowFrom);
  const row = table?.rows.find((candidate) => candidate.from === cell.rowFrom);
  if (table === undefined || row === undefined) return undefined;
  const matched = row.cells.find((candidate) => candidate.column === cell.column);
  return matched === undefined ? undefined : { table, row, cell: matched };
}

/**
 * 将任意 CodeMirror selection 映射到 table 表面。
 *
 * 这是 Live Preview 导航的总入口：普通源码位置返回 `undefined`；table 内的
 * cell、语法间隙和 delimiter 都必须返回结果。这样 controller 才能区分“交给
 * CodeMirror”与“消费 table 按键”，而不会用 `active cell === undefined` 误判。
 */
export function tableSurfacePositionAt(
  source: string,
  offset: number,
): TableSurfacePosition | undefined {
  const cell = tableCellTargetAt(source, offset);
  if (cell !== undefined) return { kind: "cell", target: cell };

  const line = sourceLineAt(source, offset);
  const table = tableFromLine(source, line.from);
  if (table === undefined) return undefined;
  const row = tableRowsWithDelimiter(table).find((candidate) => candidate.from === line.from);
  if (row === undefined) return undefined;
  const columns = syntaxColumns(row, offset);
  return {
    kind: "syntax",
    table,
    row,
    leftColumn: columns.left,
    rightColumn: columns.right,
  };
}

/** 下一个/上一个 cell 会跨过 delimiter 行；末端不隐式新建行。 */
export function tableNavigationTarget(
  source: string,
  offset: number,
  direction: TableNavigationDirection,
): TableCellTarget | undefined {
  const current = tableCellTargetAt(source, offset);
  if (current === undefined) return undefined;
  const rows = [current.table.header, ...current.table.body];
  const rowIndex = rows.findIndex((row) => row.from === current.row.from);
  if (rowIndex < 0) return undefined;
  let nextRow = rowIndex;
  let nextColumn = current.cell.column;
  const currentCellIndex = current.row.cells.findIndex((cell) => cell.column === current.cell.column);
  if (currentCellIndex < 0) return undefined;
  switch (direction) {
    case "next":
      if (currentCellIndex + 1 < current.row.cells.length) {
        nextColumn = current.row.cells[currentCellIndex + 1]!.column;
      }
      else {
        nextRow += 1;
        nextColumn = 0;
      }
      break;
    case "previous":
      if (currentCellIndex > 0) {
        nextColumn = current.row.cells[currentCellIndex - 1]!.column;
      }
      else {
        nextRow -= 1;
        nextColumn = current.table.columnCount - 1;
      }
      break;
    case "up":
      nextRow -= 1;
      break;
    case "down":
      nextRow += 1;
      break;
  }
  const row = rows[nextRow];
  if (row === undefined) return undefined;
  // Rust 允许 body row 少于 header 的列数。缺失列在视觉上是空 cell，但没有
  // source range；方向导航落到该行时选择最后一个真实 cell，避免把 selection
  // 丢到 widget 外或把空视觉 cell 当成可写源码范围。
  const cell = row.cells[nextColumn] ?? row.cells.at(-1);
  return cell === undefined ? undefined : { table: current.table, row, cell };
}

/**
 * 由当前源码 selection 解析 Live Preview 的表格导航。
 *
 * 这里不维护 active cell。调用方传入的 offset 是 CodeMirror 当前 selection，
 * 返回值要么是另一个 cell，要么是表格边界的源码位置。表格外的普通源码行只有
 * 在相邻物理行确实是 table 边界时才会返回 cell，因此不会跨越空白行跳跃。
 */
export function resolveTableSurfaceNavigation(
  source: string,
  offset: number,
  direction: TableSurfaceNavigationDirection,
): TableSurfaceNavigationTarget | undefined {
  const current = tableSurfacePositionAt(source, offset);
  if (current === undefined) {
    if (direction === "left" || direction === "right") {
      const adjacent = adjacentHorizontalTableCell(source, offset, direction);
      return adjacent === undefined ? undefined : { kind: "cell", target: adjacent };
    }
    if (direction !== "up" && direction !== "down") return undefined;
    const adjacent = adjacentTableCell(source, offset, direction);
    return adjacent === undefined ? undefined : { kind: "cell", target: adjacent };
  }

  if (current.kind === "syntax") {
    return syntaxNavigationTarget(source, current, direction);
  }

  // 左右键在 cell 内容内部仍然是 CodeMirror 的字符级编辑行为。只有
  // 光标位于当前 cell 的 sourceRange 边界时，才允许切换相邻 cell；
  // 否则详情投影尚未加载时，源码兜底会错误地穿过管道分隔符。
  if (
    direction === "left" && offset > current.target.cell.from ||
    direction === "right" && offset < current.target.cell.to
  ) {
    return undefined;
  }

  const tableDirection: TableNavigationDirection = direction === "left"
    ? "previous"
    : direction === "right"
      ? "next"
      : direction;
  const next = tableNavigationTarget(source, offset, tableDirection);
  if (next !== undefined) return { kind: "cell", target: next };
  if (tableDirection === "up" || tableDirection === "down") {
    return tableBoundaryNavigationTarget(source, offset, tableDirection);
  }
  return horizontalTableBoundaryTarget(source, current.target, tableDirection) ?? { kind: "handled" };
}

function syntaxNavigationTarget(
  source: string,
  position: Extract<TableSurfacePosition, { readonly kind: "syntax" }>,
  direction: TableSurfaceNavigationDirection,
): TableSurfaceNavigationTarget {
  const row = position.row;
  const column = direction === "left" || direction === "previous"
    ? position.leftColumn ?? position.rightColumn
    : position.rightColumn ?? position.leftColumn;

  if (row.role === "delimiter") {
    const delimiterColumn = column ?? 0;
    if (
      direction === "up" || direction === "left" || direction === "right" ||
      direction === "previous" || direction === "next"
    ) {
      const header = cellTargetAt(position.table, position.table.header, delimiterColumn);
      return header === undefined ? { kind: "handled" } : { kind: "cell", target: header };
    }
    const firstBody = position.table.body[0];
    const body = firstBody === undefined
      ? undefined
      : cellTargetAt(position.table, firstBody, delimiterColumn);
    return body === undefined ? { kind: "handled" } : { kind: "cell", target: body };
  }

  if (
    direction === "left" || direction === "right" ||
    direction === "previous" || direction === "next"
  ) {
    const horizontal = direction === "left" || direction === "previous" ? "left" : "right";
    if (
      ((horizontal === "left" && position.leftColumn === undefined) ||
        (horizontal === "right" && position.rightColumn === undefined))
    ) {
      const edgeColumn = horizontal === "left"
        ? position.rightColumn ?? row.cells[0]?.column
        : position.leftColumn ?? row.cells.at(-1)?.column;
      const edge = edgeColumn === undefined
        ? undefined
        : cellTargetAt(position.table, row, edgeColumn);
      const boundary = edge === undefined
        ? undefined
        : horizontalTableBoundaryTarget(source, edge, horizontal);
      if (boundary !== undefined) return boundary;
    }
    const targetColumn = column ?? (horizontal === "left"
      ? row.cells.at(-1)?.column
      : row.cells[0]?.column);
    const target = targetColumn === undefined
      ? undefined
      : cellTargetAt(position.table, row, targetColumn);
    return target === undefined ? { kind: "handled" } : { kind: "cell", target };
  }

  const baseColumn = column ?? 0;
  const base = cellTargetAt(position.table, row, baseColumn);
  if (base === undefined) return { kind: "handled" };
  if (direction !== "up" && direction !== "down") return { kind: "handled" };
  const next = tableNavigationTarget(source, base.cell.from, direction);
  if (next !== undefined) return { kind: "cell", target: next };
  return tableBoundaryNavigationTarget(source, base.cell.from, direction) ?? { kind: "handled" };
}

function cellTargetAt(
  table: TableSourceModel,
  row: TableSourceRow,
  column: number,
): TableCellTarget | undefined {
  const cell = row.cells[column] ?? row.cells.at(-1);
  return cell === undefined ? undefined : { table, row, cell };
}

function syntaxColumns(
  row: TableSourceRow,
  offset: number,
): { readonly left: number | undefined; readonly right: number | undefined } {
  for (const cell of row.cells) {
    // Delimiter content is syntax, not an editable cell. For a position inside
    // `---` both horizontal directions recover to the same semantic column.
    if (row.role === "delimiter" && offset >= cell.from && offset <= cell.to) {
      return { left: cell.column, right: cell.column };
    }
    if (offset < cell.from) return { left: undefined, right: cell.column };
    if (offset <= cell.to) return { left: cell.column, right: cell.column };
  }
  return { left: row.cells.at(-1)?.column, right: undefined };
}

function tableRowsWithDelimiter(table: TableSourceModel): readonly TableSourceRow[] {
  return [table.header, table.delimiter, ...table.body];
}

/**
 * 处理 table 与相邻普通源码行的水平边界。只跨越一条实际相邻物理行，不扫描
 * 跳过空白行；因此普通 CodeMirror 文本仍拥有自己的水平移动语义。
 */
function adjacentHorizontalTableCell(
  source: string,
  offset: number,
  direction: "left" | "right",
): TableCellTarget | undefined {
  const line = sourceLineAt(source, offset);

  if (direction === "right") {
    if (offset !== line.to || line.to >= source.length || source[line.to] !== "\n") return undefined;
    const nextLine = sourceLineAt(source, line.to + 1);
    const table = tableFromLine(source, nextLine.from);
    if (table === undefined || table.header.from !== nextLine.from) return undefined;
    return cellTargetAt(table, table.header, 0);
  }

  if (offset !== line.from || line.from === 0) return undefined;
  const previousLine = sourceLineAt(source, line.from - 1);
  const table = tableFromLine(source, previousLine.from);
  if (table === undefined) return undefined;
  const last = table.body.at(-1) ?? table.header;
  if (last.from !== previousLine.from) return undefined;
  return cellTargetAt(table, last, table.columnCount - 1);
}

function horizontalTableBoundaryTarget(
  source: string,
  current: TableCellTarget,
  direction: "left" | "right" | "previous" | "next",
): TableBoundaryNavigationTarget | undefined {
  const horizontal = direction === "left" || direction === "previous" ? "left" : "right";
  const rows = [current.table.header, ...current.table.body];
  const rowIndex = rows.findIndex((row) => row.from === current.row.from);
  if (rowIndex < 0) return undefined;
  if (horizontal === "left" && rowIndex === 0 && current.cell.column === 0) {
    return current.table.from === 0
      ? undefined
      : { kind: "source", offset: current.table.from - 1 };
  }
  const lastRow = rows.at(-1);
  const lastColumn = current.row.cells.at(-1)?.column;
  if (
    horizontal === "right" && lastRow !== undefined && current.row.from === lastRow.from &&
    current.cell.column === lastColumn
  ) {
    return current.table.to < source.length && source[current.table.to] === "\n"
      ? { kind: "source", offset: current.table.to + 1 }
      : undefined;
  }
  return undefined;
}

/**
 * 处理表格上下边界。普通文档末尾的 ArrowDown 不经过这里，只有已经聚焦在
 * table 最后一行时才允许创建一个文档空行，因此不会把普通文本光标行为改掉。
 */
export function tableBoundaryNavigationTarget(
  source: string,
  offset: number,
  direction: "up" | "down",
): TableBoundaryNavigationTarget | undefined {
  const current = tableCellTargetAt(source, offset);
  if (current === undefined) return undefined;
  const rows = [current.table.header, ...current.table.body];
  const rowIndex = rows.findIndex((row) => row.from === current.row.from);
  if (rowIndex < 0) return undefined;

  if (direction === "up" && rowIndex === 0) {
    // 回到紧邻 table 的上一条物理源码行。`table.from - 1` 是分隔两行的
    // 换行符位置；当上一行为空时它仍是边界位置，CodeMirror 会把它解析成
    // 上一行末尾，容易在下一次 ArrowUp 时直接越过空行。因此返回上一行的
    // line end，让空行拥有稳定的物理位置。
    if (current.table.from === 0) return undefined;
    const previous = sourceLineBefore(source, current.table.from);
    return previous === undefined ? undefined : { kind: "source", offset: previous.to };
  }
  if (direction === "down" && rowIndex === rows.length - 1) {
    if (current.table.to < source.length && source[current.table.to] === "\n") {
      return { kind: "source", offset: current.table.to + 1 };
    }
    return { kind: "insert-line", offset: source.length, insert: "\n" };
  }
  return undefined;
}

function sourceLineBefore(
  source: string,
  lineFrom: number,
): { readonly from: number; readonly to: number } | undefined {
  if (lineFrom <= 0) return undefined;
  const previousTo = lineFrom - 1;
  const previousFrom = source.lastIndexOf("\n", Math.max(0, previousTo - 1)) + 1;
  return { from: previousFrom, to: previousTo };
}

/** 从普通源码行进入紧邻的 table 边界；中间有空行时由 CodeMirror 先处理空行。 */
function adjacentTableCell(
  source: string,
  offset: number,
  direction: "up" | "down",
): TableCellTarget | undefined {
  const currentLine = sourceLineAt(source, offset);
  const adjacentLine = adjacentSourceLine(source, currentLine, direction);
  if (adjacentLine === undefined) return undefined;
  const table = tableFromLine(source, adjacentLine.from);
  if (table === undefined) return undefined;
  const row = direction === "down"
    ? table.header
    : table.body.at(-1) ?? table.header;
  if (row.from !== adjacentLine.from) return undefined;
  const cell = row.cells[0];
  return cell === undefined ? undefined : { table, row, cell };
}

function adjacentSourceLine(
  source: string,
  line: { readonly from: number; readonly to: number },
  direction: "up" | "down",
): { readonly from: number; readonly to: number } | undefined {
  if (direction === "down") {
    if (line.to >= source.length || source[line.to] !== "\n") return undefined;
    const from = line.to + 1;
    const newline = source.indexOf("\n", from);
    return { from, to: newline < 0 ? source.length : newline };
  }
  if (line.from === 0) return undefined;
  const to = line.from - 1;
  const from = source.lastIndexOf("\n", Math.max(0, to - 1)) + 1;
  return { from, to };
}

/** 清空当前 cell；Markdown 分隔符与行结构保持不变。 */
export function clearTableCell(target: TableCellTarget): TextEdit {
  return { range: range(target.cell.from, target.cell.to), insert: "" };
}

/** 在当前数据行之后插入一行；光标位于 header 时插入为第一条 body row。 */
export function insertTableRow(source: string, target: TableCellTarget): TextEdit {
  const template = target.table.body[0] ?? target.table.header;
  const line = serializeTableRow(
    source,
    template,
    Array.from({ length: target.table.columnCount }, () => ""),
  );
  const after = target.row.role === "header" ? target.table.delimiter.to : target.row.to;
  return { range: range(after, after), insert: `\n${line}` };
}

/** 删除当前 body row；表头和 delimiter 是语法骨架，不能被这个命令删除。 */
export function deleteTableRow(source: string, target: TableCellTarget): TextEdit | undefined {
  if (target.row.role !== "body") return undefined;
  // 优先删除当前行后的换行，避免把前一行与下一行粘连；仅在末行时才回收前导换行。
  const hasFollowingNewline = target.row.to < source.length && source[target.row.to] === "\n";
  const from = hasFollowingNewline ? target.row.from : Math.max(target.table.from, target.row.from - 1);
  const to = hasFollowingNewline ? target.row.to + 1 : target.row.to;
  return { range: range(from, to), insert: "" };
}

/** Rewrite each physical row once and resolve the caret from just the changed active row. */
export function editTableColumn(
  source: string,
  target: TableCellTarget,
  operation: "insert-after" | "delete",
): { readonly edits: readonly TextEdit[]; readonly anchor: number | undefined } | undefined {
  if (operation === "delete" && target.table.columnCount <= 1) return undefined;
  const adding = operation === "insert-after";
  const index = target.cell.column + (adding ? 1 : 0);
  let delta = 0;
  let anchor: number | undefined;
  const edits = tableRowsWithDelimiter(target.table).map((row) => {
    const values = tableRowValues(source, row, target.table.columnCount);
    if (adding) values.splice(index, 0, row.role === "delimiter" ? "---" : "");
    else values.splice(index, 1);
    const insert = serializeTableRow(source, row, values);
    if (row === target.row) {
      const cells = tableRowCells(insert, row.from + delta);
      anchor = cells[Math.min(index, cells.length - 1)]?.from;
    }
    delta += insert.length - (row.to - row.from);
    return { range: range(row.from, row.to), insert };
  });
  return { edits, anchor };
}

/**
 * 保留 cell 原有的 Markdown inline 源码，只补齐未转义的 pipe。
 * 编辑器传入的是源码值而不是“去标记后的纯文本”；如果无条件把 `\|` 再
 * 转义成 `\\|`，反而会让原本安全的 pipe 在二次编辑后重新成为列分隔符。
 */
export function serializeTableCell(value: string, followedByPipe: boolean): string {
  // GFM 管道表格的 cell 必须留在同一条物理源码行；粘贴进来的换行只
  // 作为词间空格保留，不能写入第二条源码行或自定义不可见标记。
  const source = value.replace(/\r\n?|\n/gu, " ");
  return encodeTableCell(source, source.length, followedByPipe).text;
}

export function encodeTableCell(value: string, cursor: number, followedByPipe: boolean): {
  readonly text: string; readonly cursor: number;
} {
  let from = 0;
  let text = "";
  let anchor = cursor;
  for (const pipe of tablePipeOffsets(value)) {
    text += value.slice(from, pipe) + "\\";
    from = pipe;
    if (pipe < cursor) anchor += 1;
  }
  text += value.slice(from);
  if (followedByPipe && isEscaped(text, text.length)) {
    text += "\\";
    if (cursor === value.length) anchor += 1;
  }
  return { text, cursor: anchor };
}

function tableCodeSpans(line: string): ReadonlyMap<number, number> {
  const tickEnds = new Map<number, number>();
  const codeSpans = new Map<number, number>();
  const runs = [...line.matchAll(/`+/gu)];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const count = run[0].length;
    const close = tickEnds.get(count);
    if (close !== undefined) codeSpans.set(run.index, close);
    tickEnds.set(count, run.index + count);
  }
  return codeSpans;
}

export function isTableCellEscape(cell: string, offset: number): boolean {
  if (cell[offset] !== "\\" || (cell[offset + 1] !== "|" && cell[offset + 1] !== "\\") ||
      isEscaped(cell, offset)) return false;
  if (!cell.includes("`")) return true;
  const spans = tableCodeSpans(cell);
  for (let index = cell.indexOf("`"); index >= 0 && index < offset;) {
    const end = isEscaped(cell, index) ? undefined : spans.get(index);
    if (end !== undefined && offset < end) return false;
    index = cell.indexOf("`", end ?? index + 1);
  }
  return true;
}

/** Structural separators in the same source spelling that Rust parses. */
export function tablePipeOffsets(line: string): readonly number[] {
  const separators: number[] = [];
  const codeSpans = line.includes("`") ? tableCodeSpans(line) : undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    const close = character === "`" && !isEscaped(line, index) ? codeSpans?.get(index) : undefined;
    if (close !== undefined) {
      index = close - 1;
      continue;
    }
    if (character === "|" && !isEscaped(line, index)) separators.push(index);
  }
  return separators;
}

export function keepsTablePipes(
  source: string,
  cell: { readonly from: number; readonly to: number },
  next: string,
): boolean {
  // Only code spans can reach past an already escaped cell and consume a
  // separator from another cell. Compare separators in physical row context.
  if (!next.includes("`") && !source.slice(cell.from, cell.to).includes("`")) return true;
  const row = sourceLineAt(source, cell.from);
  const before = tablePipeOffsets(source.slice(row.from, row.to));
  const after = tablePipeOffsets(source.slice(row.from, cell.from) + next + source.slice(cell.to, row.to));
  const delta = next.length - (cell.to - cell.from);
  return before.length === after.length && before.every((pipe, index) =>
    (row.from + pipe < cell.to ? pipe : pipe + delta) === after[index]);
}

/** 返回一行管道表格的 cell 范围；escaped pipe 和 code span 不被当作分隔符。 */
export function tableRowCells(line: string, absoluteFrom: number): readonly TableRowCell[] {
  const separators = tablePipeOffsets(line);
  if (separators.length === 0) return [];
  const first = separators[0]!;
  const last = separators[separators.length - 1]!;
  const startsWithPipe = /^[ \t]*$/u.test(line.slice(0, first));
  if (startsWithPipe && separators.length === 1) return [];
  const endsWithPipe = last === line.length - 1 ||
    (separators.length > 1 && /^[ \t]*$/u.test(line.slice(last + 1)));
  const result: TableRowCell[] = [];
  let from = startsWithPipe ? first + 1 : 0;
  for (let separatorIndex = startsWithPipe ? 1 : 0; separatorIndex < separators.length; separatorIndex += 1) {
    const separator = separators[separatorIndex]!;
    let to = separator;
    while (from < to && /[ \t]/u.test(line[from]!)) from += 1;
    while (to > from && /[ \t]/u.test(line[to - 1]!)) to -= 1;
    result.push({ from: absoluteFrom + from, to: absoluteFrom + to, column: result.length });
    from = separator + 1;
  }
  if (!endsWithPipe) {
    let to = line.length;
    while (from < to && /[ \t]/u.test(line[from]!)) from += 1;
    while (to > from && /[ \t]/u.test(line[to - 1]!)) to -= 1;
    result.push({ from: absoluteFrom + from, to: absoluteFrom + to, column: result.length });
  }
  return result;
}

/** 供命令拓扑识别 delimiter；不会单独决定一段文本是否为 table。 */
export function isTableDelimiterLine(line: string): boolean {
  return isDelimiter(line, tableRowCells(line, 0));
}

function isDelimiter(line: string, cells: readonly TableRowCell[], lineFrom = 0): boolean {
  return cells.length > 0 && cells.every((cell) =>
    /^:?-{3,}:?$/u.test(line.slice(cell.from - lineFrom, cell.to - lineFrom)));
}

function isTableContext(source: string, rowFrom: number, rowTo: number, row: readonly TableRowCell[]): boolean {
  if (isTableDelimiterLine(source.slice(rowFrom, rowTo))) return false;
  let previousStart = rowFrom;
  let widest = row.length;
  while (previousStart > 0) {
    const previousEnd = previousStart - 1;
    previousStart = previousEnd === 0 ? 0 : source.lastIndexOf("\n", previousEnd - 1) + 1;
    const previous = source.slice(previousStart, previousEnd);
    const cells = tableRowCells(previous, 0);
    if (cells.length === 0) break;
    if (isDelimiter(previous, cells)) {
      if (widest > cells.length || previousStart === 0) return false;
      const header = sourceLineAt(source, previousStart - 1);
      return tableRowCells(source.slice(header.from, header.to), 0).length === cells.length;
    }
    widest = Math.max(widest, cells.length);
  }
  if (rowTo === source.length) return false;
  const next = sourceLineAt(source, rowTo + 1);
  const text = source.slice(next.from, next.to);
  const cells = tableRowCells(text, 0);
  return cells.length === row.length && isDelimiter(text, cells);
}

function tableFromLine(source: string, rowFrom: number): TableSourceModel | undefined {
  const anchor = sourceLineAt(source, rowFrom);
  const anchorLine = toSourceLine(source, anchor);
  if (anchorLine.cells.length === 0 && !anchorLine.delimiter) return undefined;
  const lines = collectTableLines(source, anchor);
  const anchorIndex = lines.findIndex((line) => line.from === anchor.from);
  const delimiterIndex = nearestDelimiter(lines, anchorIndex);
  if (delimiterIndex <= 0) return undefined;
  const table = tableFromRows(lines, delimiterIndex);
  return table !== undefined && table.from <= anchor.from && anchor.from <= table.to ? table : undefined;
}

function tableFromRows(lines: readonly SourceLine[], delimiterIndex: number): TableSourceModel | undefined {
  const header = rowWithRole(lines[delimiterIndex - 1]!, "header");
  const delimiter = rowWithRole(lines[delimiterIndex]!, "delimiter");
  const columnCount = header.cells.length;
  if (columnCount !== delimiter.cells.length) return undefined;
  const body: TableSourceRow[] = [];
  for (let index = delimiterIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.cells.length > columnCount) break;
    body.push(rowWithRole(line, "body"));
  }
  const rows = [header, ...body];
  return {
    from: header.from,
    to: body.at(-1)?.to ?? delimiter.to,
    columnCount,
    header,
    delimiter,
    body,
    rows,
  };
}

interface SourceLine {
  readonly from: number;
  readonly to: number;
  readonly cells: readonly TableRowCell[];
  readonly delimiter: boolean;
}

function sourceLineAt(source: string, offset: number): { readonly from: number; readonly to: number } {
  const safe = Math.max(0, Math.min(source.length, offset));
  const from = safe === 0 ? 0 : source.lastIndexOf("\n", safe - 1) + 1;
  const next = source.indexOf("\n", safe);
  return { from, to: next < 0 ? source.length : next };
}

function collectTableLines(source: string, anchor: { readonly from: number; readonly to: number }): readonly SourceLine[] {
  const lines: SourceLine[] = [toSourceLine(source, anchor)];
  let cursor = anchor.from;
  while (cursor > 0) {
    const previousTo = cursor - 1;
    const previousFrom = previousTo === 0 ? 0 : source.lastIndexOf("\n", previousTo - 1) + 1;
    const previous = toSourceLine(source, { from: previousFrom, to: previousTo });
    if (previous.cells.length === 0) break;
    lines.push(previous);
    cursor = previousFrom;
  }
  lines.reverse();
  cursor = anchor.to;
  while (cursor < source.length && source[cursor] === "\n") {
    const nextFrom = cursor + 1;
    const newline = source.indexOf("\n", nextFrom);
    const nextTo = newline < 0 ? source.length : newline;
    const next = toSourceLine(source, { from: nextFrom, to: nextTo });
    if (next.cells.length === 0) break;
    lines.push(next);
    cursor = nextTo;
  }
  return lines;
}

function toSourceLine(
  source: string,
  bounds: { readonly from: number; readonly to: number },
): SourceLine {
  const line = source.slice(bounds.from, bounds.to);
  const cells = tableRowCells(line, bounds.from);
  return {
    ...bounds,
    cells,
    delimiter: isDelimiter(line, cells, bounds.from),
  };
}

function nearestDelimiter(lines: readonly SourceLine[], anchorIndex: number): number {
  const candidates = lines
    .map((_, index) => ({ index, distance: Math.abs(index - anchorIndex) }))
    .filter(({ index }) => lines[index]?.delimiter === true && index > 0)
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  return candidates[0]?.index ?? -1;
}

function rowWithRole(line: SourceLine, role: TableSourceRowRole): TableSourceRow {
  return { role, from: line.from, to: line.to, cells: line.cells };
}

function tableRowValues(
  source: string,
  row: TableSourceRow,
  columnCount: number,
): string[] {
  const values = row.cells.map((cell) => source.slice(cell.from, cell.to));
  while (values.length < columnCount) values.push("");
  return values;
}

function serializeTableRow(source: string, row: TableSourceRow, values: readonly string[]): string {
  const line = source.slice(row.from, row.to);
  const leadingWhitespace = line.match(/^[ \t]*/u)![0];
  const trailingWhitespace = line.match(/[ \t]*$/u)![0];
  const last = line.length - trailingWhitespace.length - 1;
  // A single cell needs explicit pipes to distinguish it from a paragraph
  // (or a draft that consists only of an opening pipe).
  const startsWithPipe = values.length === 1 || line[leadingWhitespace.length] === "|";
  const endsWithPipe = values.length === 1 || (line[last] === "|" && !isEscaped(line, last));
  const content = values.join(" | ");
  return `${leadingWhitespace}${startsWithPipe ? "| " : ""}${content}${endsWithPipe ? " |" : ""}${trailingWhitespace}`;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function ownBlockTerminatorEnd(source: string, from: number, rawTo: number): number {
  if (rawTo <= from || rawTo >= source.length) return rawTo;
  // A root RenderNode usually ends before its physical line terminator. The
  // first LF belongs to the visual table block; a second LF is a real
  // BlankLine and must survive a block-level delete.
  return source[rawTo - 1] === "\n" || source[rawTo] !== "\n"
    ? rawTo
    : rawTo + 1;
}

function clampOffset(source: string, offset: number): number {
  return Number.isFinite(offset)
    ? Math.max(0, Math.min(source.length, Math.trunc(offset)))
    : 0;
}
