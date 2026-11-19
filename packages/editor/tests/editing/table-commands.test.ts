import {
  clearTableCell,
  editTableColumn,
  deleteTableRow,
  insertTableRow,
  replaceTableCell,
  serializeTableCell,
  tableAt,
  tableCellAt,
  tableBoundaryNavigationTarget,
  tableLivePreviewCommand,
  tableNavigationTarget,
  tableRootDeletionRange,
  resolveTableSurfaceNavigation,
  tableSurfacePositionAt,
} from "../../src/components/table/index.js";
import { createDefaultEditorCommandRegistry } from "../../src/components/commands.js";
import { TABLE_COMMAND, TABLE_INTERACTION_COMMAND } from "../../src/components/table/commands.js";
import { TABLE_TOOLBAR_ACTIONS } from "../../src/components/table/toolbar.js";
import { range } from "../../src/adapter/text-model.js";
import { tableTargetInRange } from "../../src/components/table/source.js";

function table_cell_helpers_respect_escaped_pipes_and_delimiter_context(): void {
  const source = "| Name | Formula |\n| --- | --- |\n| A \\| B | `x|y` |";
  const cell = tableCellAt(source, source.indexOf("A"));
  if (cell === undefined) throw new Error("expected a table cell");
  equal(source.slice(cell.from, cell.to), "A \\| B");
  equal(cell.column, 0);
  const edit = replaceTableCell(source, source.indexOf("A"), "loss | value", range(0, source.length));
  if (edit === undefined) throw new Error("expected a table edit");
  equal(edit.insert, "loss \\| value");
  const encoded = serializeTableCell("a\\b\nc|d", false);
  equal(encoded, "a\\b c\\|d");
  equal(encoded.includes("\n"), false);
  equal(serializeTableCell(String.raw`keep \| and add |`, false), String.raw`keep \| and add \|`);
  equal(tableCellAt("a | b", 2), undefined);
}

function table_cell_helpers_match_rust_pipe_rules_for_inline_syntax(): void {
  const source = "| Link | Math | Code |\n| --- | --- | --- |\n| [A \\| B](url) | $x \\| y$ | `x|y` |";
  const link = tableCellAt(source, source.indexOf("A"));
  const math = tableCellAt(source, source.indexOf("x \\| y"));
  const code = tableCellAt(source, source.indexOf("x|y"));
  if (link === undefined || math === undefined || code === undefined) {
    throw new Error("expected escaped inline pipes to remain in their cells");
  }
  equal(link.column, 0);
  equal(math.column, 1);
  equal(code.column, 2);

  // Rust's block splitter treats an unescaped pipe as a table separator even
  // when inline syntax surrounds it; the source helper deliberately mirrors
  // that rule instead of inventing a second Markdown grammar.
  const raw = "| Link | 2 | 3 | Math |\n| --- | --- | --- | --- |\n| [A|B](url) | $x|y$ |";
  equal(tableCellAt(raw, raw.indexOf("B](url)"))?.column, 1);
  const overwide = "| L | R |\n| --- | --- |\n| x | y | draft |\n| n | m |";
  equal(tableCellAt(overwide, overwide.indexOf("draft")), undefined);
  equal(tableCellAt(overwide, overwide.indexOf("n | m")), undefined);
  equal(tableAt(overwide, overwide.indexOf("L"))?.columnCount, 2);
  equal(tableAt(overwide, overwide.indexOf("L"))?.body.length, 0);
  const padded = "| L | R |\n| --- | --- |\n  |x|y| \t";
  equal(tableCellAt(padded, padded.indexOf('y'))?.column, 1);
  equal(tableAt(padded, padded.indexOf("L"))?.body[0]?.cells.length, 2);
}

function table_helpers_support_rows_without_outer_pipes(): void {
  const source = "Name | Value\n--- | ---\nalpha | beta";
  const value = tableCellAt(source, source.indexOf("beta"));
  if (value === undefined) throw new Error("expected a cell without outer pipes");
  equal(value.column, 1);
  equal(source.slice(value.from, value.to), "beta");
  equal(tableAt(source, source.indexOf("alpha"))?.columnCount, 2);
}

function table_cell_helpers_preserve_empty_cells_and_ragged_rows(): void {
  const source = "| A | B | C |\n| --- | --- | --- |\n|  | value |  |\n| only |";
  const empty = tableCellAt(source, source.indexOf("|  | value") + 3);
  if (empty === undefined) throw new Error("expected the leading empty cell");
  equal(empty.column, 0);
  equal(source.slice(empty.from, empty.to), "");
  const trailing = tableCellAt(source, source.indexOf("|  |\n| only") + 3);
  if (trailing === undefined) throw new Error("expected the trailing empty cell");
  equal(trailing.column, 2);
  equal(source.slice(trailing.from, trailing.to), "");

  const short = tableCellAt(source, source.indexOf("only"));
  if (short === undefined) throw new Error("expected a ragged row cell");
  equal(short.column, 0);
  equal(tableAt(source, source.indexOf("only"))?.columnCount, 3);
  const down = tableNavigationTarget(source, source.indexOf("B"), "down");
  if (down === undefined) throw new Error("expected ragged-row navigation to remain in the table");
  equal(source.slice(down.cell.from, down.cell.to), "value");
}

function table_cell_paste_newlines_become_spaces_without_changing_row_topology(): void {
  const source = "| A | B |\n| --- | --- |\n| value | other |";
  const edit = replaceTableCell(source, source.indexOf("value"), "first\nsecond", range(0, source.length));
  if (edit === undefined) throw new Error("expected a table cell edit");
  equal(edit.insert, "first second");
  const next = apply(source, [edit]);
  equal(next.split("\n").length, 3);
  equal(tableCellAt(next, next.indexOf("first"))?.column, 0);
  equal(tableCellAt(next, next.indexOf("other"))?.column, 1);
}

function table_navigation_crosses_rows_without_touching_the_delimiter(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
  const first = source.indexOf("1");
  const next = tableNavigationTarget(source, first, "next");
  if (next === undefined) throw new Error("expected next table cell");
  equal(source.slice(next.cell.from, next.cell.to), "2");
  const across = tableNavigationTarget(source, next.cell.from, "next");
  if (across === undefined) throw new Error("expected cross-row table cell");
  equal(source.slice(across.cell.from, across.cell.to), "3");
  const previous = tableNavigationTarget(source, across.cell.from, "previous");
  if (previous === undefined) throw new Error("expected previous table cell");
  equal(source.slice(previous.cell.from, previous.cell.to), "2");
}

function table_boundary_navigation_does_not_change_normal_document_end_behavior(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |\nparagraph";
  const header = source.indexOf("A");
  const last = source.indexOf("2");
  const above = tableBoundaryNavigationTarget(source, header, "up");
  equal(above, undefined);
  const below = tableBoundaryNavigationTarget(source, last, "down");
  if (below?.kind !== "source") throw new Error("expected table-to-following-source navigation");
  equal(source.slice(below.offset), "paragraph");

  const end = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const append = tableBoundaryNavigationTarget(end, end.indexOf("2"), "down");
  if (append?.kind !== "insert-line") throw new Error("expected explicit table exit line");
  equal(append.offset, end.length);
  equal(append.insert, "\n");
  const existingEmptyLine = `${end}\n`;
  const noInsert = tableBoundaryNavigationTarget(
    existingEmptyLine,
    existingEmptyLine.indexOf("2"),
    "down",
  );
  if (noInsert?.kind !== "source") throw new Error("expected existing empty line to be reused");
  equal(noInsert.offset, existingEmptyLine.length);
}

function table_boundaries_skip_separator_lines_and_trailing_pipe_end(): void {
  const source = [
    "before",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "## after",
  ].join("\n");
  const header = tableBoundaryNavigationTarget(source, source.indexOf("A"), "up");
  if (header?.kind !== "source") throw new Error("expected immediate previous source line");
  equal(header.offset, source.indexOf("| A") - 1);
  const body = tableBoundaryNavigationTarget(source, source.indexOf("2"), "down");
  if (body?.kind !== "source") throw new Error("expected immediate following source line");
  equal(body.offset, source.indexOf("| 1") + "| 1 | 2 |".length + 1);
  equal(source.slice(body.offset), "\n## after");

  const rowEnd = source.indexOf("\n\n## after");
  equal(tableCellAt(source, rowEnd), undefined);
}

function table_surface_navigation_uses_selection_and_preserves_blank_lines(): void {
  const source = [
    "before",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "after",
  ].join("\n");
  const header = source.indexOf("A");
  const last = source.indexOf("2");
  const left = resolveTableSurfaceNavigation(source, source.indexOf("2"), "left");
  if (left?.kind !== "cell") throw new Error("ArrowLeft must resolve a previous cell");
  equal(source.slice(left.target.cell.from, left.target.cell.to), "1");
  const right = resolveTableSurfaceNavigation(source, source.indexOf("1") + 1, "right");
  if (right?.kind !== "cell") throw new Error("ArrowRight must resolve the next cell");
  equal(source.slice(right.target.cell.from, right.target.cell.to), "2");

  const above = resolveTableSurfaceNavigation(source, header, "up");
  if (above?.kind !== "source") throw new Error("header ArrowUp must reach the separator line");
  equal(above.offset, source.indexOf("| A") - 1);
  const below = resolveTableSurfaceNavigation(source, last, "down");
  if (below?.kind !== "source") throw new Error("last row ArrowDown must reach the separator line");
  equal(below.offset, source.indexOf("| 1") + "| 1 | 2 |".length + 1);

  const blankAfter = below.offset;
  const backToTable = resolveTableSurfaceNavigation(source, blankAfter, "up");
  if (backToTable?.kind !== "cell") throw new Error("separator ArrowUp must enter the last table row");
  equal(source.slice(backToTable.target.cell.from, backToTable.target.cell.to), "1");
}

function table_surface_navigation_enters_only_the_adjacent_table_line(): void {
  const source = "before\n| A | B |\n| --- | --- |\n| 1 | 2 |\nafter";
  const entered = resolveTableSurfaceNavigation(source, source.indexOf("before"), "down");
  if (entered?.kind !== "cell") throw new Error("ArrowDown must enter an adjacent table");
  equal(source.slice(entered.target.cell.from, entered.target.cell.to), "A");

  const separated = "before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  const blank = separated.indexOf("\n\n") + 1;
  const fromBlank = resolveTableSurfaceNavigation(separated, blank, "down");
  if (fromBlank?.kind !== "cell") throw new Error("ArrowDown from the blank line must enter the table");
  equal(separated.slice(fromBlank.target.cell.from, fromBlank.target.cell.to), "A");
}

function table_surface_navigation_stops_at_horizontal_edges(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  equal(resolveTableSurfaceNavigation(source, source.indexOf("A"), "left")?.kind, "handled");
  equal(resolveTableSurfaceNavigation(source, source.indexOf("2") + 1, "right")?.kind, "handled");
}

function table_surface_navigation_never_exposes_delimiter_or_pipe_source(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const delimiter = source.indexOf("---");
  const position = tableSurfacePositionAt(source, delimiter);
  if (position?.kind !== "syntax") throw new Error("delimiter must be a table syntax position");

  const left = resolveTableSurfaceNavigation(source, delimiter, "left");
  if (left?.kind !== "cell") throw new Error("delimiter ArrowLeft must recover to a cell");
  equal(source.slice(left.target.cell.from, left.target.cell.to), "A");

  const right = resolveTableSurfaceNavigation(source, delimiter, "right");
  if (right?.kind !== "cell") throw new Error("delimiter ArrowRight must recover to a cell");
  equal(source.slice(right.target.cell.from, right.target.cell.to), "A");

  const trailingPipe = source.indexOf("| --- | --- |") + "| --- | --- |".length - 1;
  const trailing = resolveTableSurfaceNavigation(source, trailingPipe, "right");
  if (trailing?.kind !== "cell") throw new Error("trailing pipe must recover to a cell");
  equal(source.slice(trailing.target.cell.from, trailing.target.cell.to), "B");
}

function table_surface_navigation_crosses_only_real_horizontal_boundaries(): void {
  const source = "before\n| A | B |\n| --- | --- |\n| 1 | 2 |\nafter";
  const beforeEnd = source.indexOf("\n");
  const intoTable = resolveTableSurfaceNavigation(source, beforeEnd, "right");
  if (intoTable?.kind !== "cell") throw new Error("right at a table boundary must enter the header");
  equal(source.slice(intoTable.target.cell.from, intoTable.target.cell.to), "A");
  equal(resolveTableSurfaceNavigation(source, beforeEnd, "next"), undefined);

  const afterStart = source.indexOf("after");
  const backToTable = resolveTableSurfaceNavigation(source, afterStart, "left");
  if (backToTable?.kind !== "cell") throw new Error("left at a table boundary must enter the last row");
  equal(source.slice(backToTable.target.cell.from, backToTable.target.cell.to), "2");

  const separated = "before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter";
  const blankStart = separated.indexOf("\n\n") + 1;
  const fromBlank = resolveTableSurfaceNavigation(separated, blankStart, "right");
  if (fromBlank?.kind !== "cell") throw new Error("right from the adjacent blank line must enter the table");
  equal(separated.slice(fromBlank.target.cell.from, fromBlank.target.cell.to), "A");
  const blankAfter = separated.indexOf("\n\nafter") + 1;
  const backFromBlank = resolveTableSurfaceNavigation(separated, blankAfter, "left");
  if (backFromBlank?.kind !== "cell") throw new Error("left from the adjacent blank line must enter the table");
  equal(separated.slice(backFromBlank.target.cell.from, backFromBlank.target.cell.to), "2");
  const afterBlank = separated.lastIndexOf("after");
  equal(resolveTableSurfaceNavigation(separated, afterBlank, "left"), undefined);
}

function table_root_deletion_uses_only_the_external_block_boundaries(): void {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const source = `before\n${table}\n\nafter`;
  const from = source.indexOf(table);
  const rawTo = from + table.length;
  const tableRange = {
    from: from as import("../../../editor-protocol/src/index.js").TextRange["from"],
    to: rawTo as import("../../../editor-protocol/src/index.js").TextRange["to"],
  };
  const forward = tableRootDeletionRange(source, tableRange, from, "forward");
  if (forward === undefined) throw new Error("Delete at table root start should remove the whole table");
  equal(source.slice(forward.from, forward.to), `${table}\n`);
  // The second LF belongs to a true BlankLine and must survive.
  equal(apply(source, [{ range: forward, insert: "" }]), "before\n\nafter");

  const backward = tableRootDeletionRange(source, tableRange, rawTo + 1, "backward");
  if (backward === undefined) throw new Error("Backspace after table block terminator should remove the whole table");
  equal(backward.from, forward.from);
  equal(backward.to, forward.to);

  // A caret inside a cell or at the pre-terminator boundary must not turn a
  // normal character deletion into a whole-table operation. Only the position
  // after table's own physical terminator is the external “after table”
  // boundary.
  equal(tableRootDeletionRange(source, tableRange, source.indexOf("1"), "backward"), undefined);
  equal(tableRootDeletionRange(source, tableRange, rawTo, "backward"), undefined);
  equal(tableRootDeletionRange(source, tableRange, rawTo + 1, "forward"), undefined);

  const terminal = `before\n${table}`;
  const terminalFrom = terminal.indexOf(table);
  const terminalRange = {
    from: terminalFrom as import("../../../editor-protocol/src/index.js").TextRange["from"],
    to: terminal.length as import("../../../editor-protocol/src/index.js").TextRange["to"],
  };
  const terminalBackspace = tableRootDeletionRange(
    terminal,
    terminalRange,
    terminal.length,
    "backward",
  );
  if (terminalBackspace === undefined) {
    throw new Error("Backspace at document end after a table should remove the table");
  }
  equal(apply(terminal, [{ range: terminalBackspace, insert: "" }]), "before\n");
}

function live_preview_table_keys_are_centralized(): void {
  equal(
    tableLivePreviewCommand({ key: "ArrowDown" }),
    TABLE_INTERACTION_COMMAND.focusBelow,
  );
  equal(
    tableLivePreviewCommand({ key: "Enter" }),
    TABLE_INTERACTION_COMMAND.beginEdit,
  );
  equal(
    tableLivePreviewCommand({ key: "Tab" }),
    TABLE_INTERACTION_COMMAND.focusNext,
  );
  equal(
    tableLivePreviewCommand({ key: "Tab", shiftKey: true }),
    TABLE_INTERACTION_COMMAND.focusPrevious,
  );
  equal(tableLivePreviewCommand({ key: "Enter", shiftKey: true }), undefined);
  equal(tableLivePreviewCommand({ key: "ArrowDown", shiftKey: true }), undefined);
}

function table_navigation_commands_consume_the_last_cell_boundary(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const registry = createDefaultEditorCommandRegistry();
  const result = registry.execute(TABLE_COMMAND.nextCell, {
    source,
    selection: selection(source.indexOf("2")),
  });
  if (result === undefined) throw new Error("last table cell must consume Tab");
  equal(result.edits, undefined);
  equal(result.selection, undefined);
  equal(result.userEvent, "input.table.next-cell");
}

function table_structure_transforms_preserve_a_valid_delimiter_row(): void {
  const source = "| ID | Name |\n| --- | :---: |\n| 1 | alpha |\n| 2 | beta |";
  const offset = source.indexOf("alpha");
  const target = tableTargetInRange(source, offset, range(0, source.length))!;
  const cleared = clearTableCell(target);
  if (cleared === undefined) throw new Error("expected clear-cell edit");
  equal(apply(source, [cleared]).includes("| 1 |  |"), true);

  const insertedColumn = editTableColumn(source, tableTargetInRange(source, source.indexOf("1"), range(0, source.length))!, "insert-after");
  if (insertedColumn === undefined) throw new Error("expected insert-column edits");
  const withColumn = apply(source, insertedColumn.edits);
  equal(withColumn.includes("| --- | --- | :---: |"), true);
  equal(withColumn.includes("| 1 |  | alpha |"), true);

  const insertedBlank = tableNavigationTarget(withColumn, withColumn.indexOf("1"), "next");
  if (insertedBlank === undefined) throw new Error("expected inserted blank table cell");
  const deletedColumn = editTableColumn(withColumn, insertedBlank, "delete");
  if (deletedColumn === undefined) throw new Error("expected delete-column edits");
  const restoredColumns = apply(withColumn, deletedColumn.edits);
  equal(restoredColumns.includes("| --- | :---: |"), true);
  equal(restoredColumns.includes("| 1 | alpha |"), true);
  const unpiped = "A | B\n--- | ---\nx | y";
  const lastColumn = editTableColumn(unpiped, tableTargetInRange(unpiped, unpiped.indexOf("x"), range(0, unpiped.length))!, "delete");
  if (lastColumn === undefined || lastColumn.anchor === undefined) throw new Error("expected one surviving column");
  const oneColumn = apply(unpiped, lastColumn.edits);
  equal(oneColumn, "| B |\n| --- |\n| y |");
  equal(oneColumn[lastColumn.anchor], "y");

  const insertedRow = insertTableRow(source, target);
  if (insertedRow === undefined) throw new Error("expected insert-row edit");
  const withRow = apply(source, [insertedRow]);
  equal(withRow.includes("| 1 | alpha |\n|  |  |\n| 2 | beta |"), true);

  const deletedRow = deleteTableRow(source, target);
  if (deletedRow === undefined) throw new Error("expected delete-row edit");
  const withoutRow = apply(source, [deletedRow]);
  equal(withoutRow.includes("alpha"), false);
  equal(withoutRow.includes("| --- | :---: |"), true);
}

function table_commands_share_a_single_registry_and_user_event_namespace(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const registry = createDefaultEditorCommandRegistry();
  const result = registry.execute(TABLE_COMMAND.nextCell, {
    source,
    selection: selection(source.indexOf("1")),
  });
  if (result === undefined || result.selection === undefined) {
    throw new Error("expected table navigation command result");
  }
  equal(source.slice(Number(result.selection.head), Number(result.selection.head) + 1), "2");
  equal(result.userEvent, "input.table.next-cell");
  equal(registry.shortcuts.some((shortcut) => shortcut.command === TABLE_COMMAND.insertRowBelow), true);
}

function table_commands_do_not_collapse_multi_selection(): void {
  const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const registry = createDefaultEditorCommandRegistry();
  equal(registry.execute(TABLE_COMMAND.nextCell, {
    source,
    selection: selection(source.indexOf("1")),
    selectionCount: 2,
  }), undefined);
  equal(registry.execute(TABLE_COMMAND.clearCell, {
    source,
    selection: selection(source.indexOf("1")),
    selectionCount: 2,
  }), undefined);
}

function table_toolbar_actions_are_backed_by_registered_commands(): void {
  const registry = createDefaultEditorCommandRegistry();
  for (const action of TABLE_TOOLBAR_ACTIONS) {
    equal(registry.command(action.command)?.id, action.command);
  }
}

function apply(source: string, edits: readonly { readonly range: { readonly from: number; readonly to: number }; readonly insert: string }[]): string {
  return [...edits]
    .sort((left, right) => Number(right.range.from) - Number(left.range.from))
    .reduce((value, edit) =>
      value.slice(0, Number(edit.range.from)) + edit.insert + value.slice(Number(edit.range.to)), source);
}

function selection(offset: number) {
  return {
    anchor: offset as import("../../../editor-protocol/src/index.js").Utf16Offset,
    head: offset as import("../../../editor-protocol/src/index.js").Utf16Offset,
  };
}

function equal<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

table_cell_helpers_respect_escaped_pipes_and_delimiter_context();
table_cell_helpers_match_rust_pipe_rules_for_inline_syntax();
table_helpers_support_rows_without_outer_pipes();
table_cell_helpers_preserve_empty_cells_and_ragged_rows();
table_cell_paste_newlines_become_spaces_without_changing_row_topology();
table_navigation_crosses_rows_without_touching_the_delimiter();
table_boundary_navigation_does_not_change_normal_document_end_behavior();
table_boundaries_skip_separator_lines_and_trailing_pipe_end();
table_surface_navigation_uses_selection_and_preserves_blank_lines();
table_surface_navigation_enters_only_the_adjacent_table_line();
table_surface_navigation_stops_at_horizontal_edges();
table_surface_navigation_never_exposes_delimiter_or_pipe_source();
table_surface_navigation_crosses_only_real_horizontal_boundaries();
table_root_deletion_uses_only_the_external_block_boundaries();
live_preview_table_keys_are_centralized();
table_navigation_commands_consume_the_last_cell_boundary();
table_structure_transforms_preserve_a_valid_delimiter_row();
table_commands_share_a_single_registry_and_user_event_namespace();
table_commands_do_not_collapse_multi_selection();
table_toolbar_actions_are_backed_by_registered_commands();
