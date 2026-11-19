import type { RenderNode } from "@jot-md/editor-protocol";
import {
  numberAttribute,
  stringsAttribute,
} from "../common/dom-renderer.js";
import type { ComponentPreTextContext, ComponentPreTextResult } from "../contracts.js";
import {
  resolveTableColumnWidths,
  softWrapPreferredSample,
  tableLayoutEvidenceFromNode,
  type TableLayoutOptions,
} from "./layout.js";
import { tableRowCells } from "./source.js";

export interface TablePreTextSourceStats {
  readonly preview: string;
}

export interface TablePreTextMetrics {
  readonly paragraphLineHeight: number;
  readonly tableHeaderHeight: number;
  readonly tableRowHeight: number;
  /** command 工具条由宿主启用时才会参与总高度。 */
  readonly tableToolbarHeight?: number;
  readonly tableFrame: number;
}

export interface TablePreTextContext extends ComponentPreTextContext {
  readonly sourceStats: TablePreTextSourceStats;
  readonly sampleRows?: number;
  readonly tableLayout?: Pick<
    TableLayoutOptions,
    "mode" | "fillRatio" | "minColumnWidth" | "maxColumnWidth" | "estimatedColumnWidth"
  >;
  /** 使用已有语义投影获取 cell 文本；不得在这里重新解析 Markdown。 */
  readonly semanticText: (node: RenderNode, maximum?: number) => string;
  readonly metrics: TablePreTextMetrics;
  /** Preview/Live Preview 是否会挂载统一 table command 工具条。 */
  readonly hasToolbar?: boolean;
}

export interface TablePreTextEstimate extends ComponentPreTextResult {
  readonly strategy: "table-grid-fixed" | "table-grid-sampled";
  /** 表格适配器始终提供这些证据，供通用 PreText filter 写回投影。 */
  readonly rows: number;
  readonly columns: number;
  readonly sampledRows: number;
  readonly visualLines: number;
}

interface TableCellSample {
  readonly text: string;
  readonly displayColumns?: number;
  readonly maxUnbreakableColumns?: number;
}

type TableRowSample = readonly TableCellSample[];

/**
 * Table 的 PreText 适配器。它和 Preview 共用 TableLayoutOptions 与 Rust 的整表
 * evidence，但只输出稳定的高度估计，不持有 DOM 或 VirtualAxis。
 */
export function estimateTablePreText(
  node: RenderNode,
  context: TablePreTextContext,
): TablePreTextEstimate {
  if (node.kind !== "table") throw new Error("table PreText adapter received a non-table node");
  const rows = Math.max(1, node.childCount);
  const columns = Math.max(1, stringsAttribute(node, "alignments").length);
  const samples = tableRowSamples(node, context.sourceStats, context);
  const visualLines = estimateTableRowLines(
    samples,
    columns,
    context.availableWidth,
    context.averageCharacterWidth,
    context.tabSize,
    context.tableLayout,
    tableLayoutEvidenceFromNode(node),
  );
  const rowHeight = Math.max(
    context.metrics.tableRowHeight,
    visualLines * context.metrics.paragraphLineHeight + context.metrics.tableFrame,
  );
  return {
    height: (context.hasToolbar === true ? context.metrics.tableToolbarHeight ?? 0 : 0) +
      context.metrics.tableHeaderHeight + Math.max(0, rows - 1) * rowHeight +
      context.metrics.tableFrame,
    strategy: samples.length === 0 ? "table-grid-fixed" : "table-grid-sampled",
    rows,
    columns,
    sampledRows: samples.length,
    visualLines,
  };
}

function tableRowSamples(
  node: RenderNode,
  sourceStats: TablePreTextSourceStats,
  context: TablePreTextContext,
): readonly TableRowSample[] {
  const limit = Math.max(1, context.sampleRows ?? 24);
  if (node.content.type === "structured") {
    const rows = node.content.children
      .filter((child) => child.kind === "table-row")
      .map((row) => row.content.type === "structured"
        ? row.content.children.map((cell): TableCellSample => {
          const display = numberAttribute(cell, "displayColumns");
          const unbreakable = numberAttribute(cell, "maxUnbreakableColumns");
          return {
            text: context.semanticText(cell, 2_048).trim(),
            ...(display === undefined ? {} : { displayColumns: display }),
            ...(unbreakable === undefined
              ? {}
              : { maxUnbreakableColumns: unbreakable }),
          };
        })
        : [{ text: context.semanticText(row) }]);
    return selectTableSamples(rows, limit);
  }
  const rows = sourceStats.preview
    .split("\n")
    .filter((line) => line.includes("|") && !/^\s*\|?\s*:?-{3,}/u.test(line));
  return selectTableSamples(
    rows.map((line) => tableRowCells(line, 0).map(cell => ({ text: line.slice(cell.from, cell.to) }))),
    limit,
  );
}

function selectTableSamples(
  rows: readonly TableRowSample[],
  limit: number,
): readonly TableRowSample[] {
  if (rows.length <= limit) return rows;
  const selected = new Set<number>();
  const edge = Math.max(1, Math.floor(limit / 3));
  for (let index = 0; index < edge; index += 1) {
    selected.add(index);
    selected.add(rows.length - index - 1);
  }
  const middleCount = Math.max(0, limit - selected.size);
  for (let index = 0; index < middleCount; index += 1) {
    selected.add(Math.floor((index + 1) * (rows.length - 1) / (middleCount + 1)));
  }
  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, limit)
    .map((index) => rows[index]!);
}

function estimateTableRowLines(
  samples: readonly TableRowSample[],
  columnCount: number,
  width: number,
  averageCharacterWidth: number,
  tabSize = 4,
  tableLayout: TablePreTextContext["tableLayout"],
  evidence: ReturnType<typeof tableLayoutEvidenceFromNode>,
): number {
  if (samples.length === 0) return 1;
  const average = positive(averageCharacterWidth, 8);
  const preferred = Array.from({ length: columnCount }, () => 0);
  for (const row of samples) {
    for (let index = 0; index < columnCount; index += 1) {
      const cell = row[index] ?? { text: "" };
      const sample = softWrapPreferredSample(cell.text);
      const sampledColumns = Math.max(1, displayColumns(sample, tabSize));
      const hintedColumns = Math.max(0, cell.displayColumns ?? 0);
      const unbreakableColumns = Math.max(0, cell.maxUnbreakableColumns ?? 0);
      preferred[index] = Math.max(
        preferred[index] ?? 0,
        Math.max(sampledColumns, hintedColumns, Math.min(unbreakableColumns, 28)) * average + 16,
      );
    }
  }
  const widths = resolveTableColumnWidths(
    preferred,
    width,
    tableLayout ?? { mode: "content" },
    [],
    evidence,
  );
  let maximum = 1;
  for (const row of samples) {
    let rowLines = 1;
    for (let index = 0; index < columnCount; index += 1) {
      const cell = row[index] ?? { text: "" };
      const columnsPerLine = Math.max(
        1,
        Math.floor(Math.max(1, (widths[index] ?? average) - 16) / average),
      );
      const hintedColumns = Math.max(0, cell.displayColumns ?? 0);
      rowLines = Math.max(
        rowLines,
        logicalVisualLines(cell.text, columnsPerLine, tabSize),
        Math.ceil(Math.max(1, hintedColumns) / columnsPerLine),
      );
    }
    maximum = Math.max(maximum, rowLines);
  }
  // Preview cells are not truncated. The estimator may be corrected by the
  // visible DOM measurement; source newline topology remains the parser's
  // responsibility, while soft wrapping only changes the visual row height.
  return maximum;
}

function logicalVisualLines(value: string, columnsPerLine: number, tabSize: number): number {
  return value.split("\n").reduce(
    (total, line) => total + Math.max(
      1,
      Math.ceil(Math.max(1, displayColumns(line, tabSize)) / columnsPerLine),
    ),
    0,
  );
}

function displayColumns(value: string, tabSize = 4): number {
  let columns = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (character === "\t") {
      columns += tabSize - (columns % tabSize || 0);
    } else {
      columns += point >= 0x1100 ? 2 : 1;
    }
  }
  return columns;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
