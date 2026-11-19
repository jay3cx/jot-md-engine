import { VirtualAxis, type VirtualWindow } from "../../core/virtual/virtual-axis.js";
import type { RenderNode, TextRange } from "@jot-md/editor-protocol";

export type TableLayoutMode = "adaptive" | "content" | "fixed";
export type TableColumnWidth = number | "auto";
/** 自动列宽的收敛策略；stable 避免虚拟行挂载后反复改变表格几何。 */
export type TableAutoWidthMode = "stable" | "live";

export interface TableColumnResizeEvent {
  readonly tableId: string;
  readonly column: number;
  readonly width: number;
  readonly source: "user" | "measurement";
}

export interface TableLayoutIdentity {
  /** 当前 revision lineage 内用于 DOM/缓存的运行时节点 ID。 */
  readonly runtimeId: string;
  readonly sourceRange: TextRange;
  readonly columnCount: number;
}

export interface TableLayoutOptions {
  /** content 以内容宽度为准；adaptive 填充容器；fixed 停止自动测量。 */
  readonly mode?: TableLayoutMode;
  /** stable 在一次测量批次内保持列宽；live 允许后续批次双向调整列宽。 */
  readonly autoWidth?: TableAutoWidthMode;
  /**
   * content 模式的容器填充比例。0 表示保持 intrinsic 宽度；大于 0 时，
   * 目标宽度至少为容器宽度乘以该比例，剩余空间优先分给有换行收益的列；
   * 没有需求权重时按当前候选宽度兜底分配，保证表格从溢出恢复后仍能重新收敛。
   */
  readonly fillRatio?: number;
  /** 所有自动列的 border-box 下限；它不是 CSS min-width。 */
  readonly minColumnWidth?: number;
  readonly maxColumnWidth?: number;
  readonly estimatedColumnWidth?: number;
  /** 数字会固定列宽；auto 让列宽继续由选定的布局策略决定。 */
  readonly columnWidths?: readonly TableColumnWidth[];
  /** 按运行时表格 ID 恢复外部持久化的用户列宽。 */
  readonly resolveTableKey?: (identity: TableLayoutIdentity) => string | undefined;
  /** 按稳定表格 key 恢复外部持久化的用户列宽。 */
  readonly resolveColumnWidths?: (
    tableId: string,
    columnCount: number,
  ) => readonly TableColumnWidth[] | undefined;
  readonly resizableColumns?: boolean;
  readonly onColumnResize?: (event: TableColumnResizeEvent) => void;
  /** 用户或自动布局改变后通知宿主保存完整快照。 */
  readonly onLayoutChange?: (snapshot: TableLayoutSnapshot) => void;
}

export interface TableLayoutSnapshot {
  readonly tableId: string;
  readonly mode: TableLayoutMode;
  readonly autoWidth: TableAutoWidthMode;
  readonly fillRatio: number;
  readonly columnCount: number;
  readonly widths: readonly number[];
  readonly pinnedColumns: readonly number[];
  readonly totalWidth: number;
}

/**
 * 生成自动列宽的失效上下文。
 *
 * 没有 fillRatio 的 content/fixed 列宽不依赖容器宽度；容器变窄只应出现横向
 * 滚动，不能重新打开内容测量。adaptive 和 content+fillRatio 才需要随可用宽度
 * 重新分配列宽。
 */
export function tableLayoutContextKey(
  mode: TableLayoutMode,
  direction: string,
  availableWidth: number,
  fillRatio = 0,
): string {
  const normalizedDirection = direction === "rtl" ? "rtl" : "ltr";
  const normalizedFillRatio = normalizeFillRatio(fillRatio);
  const widthSensitive = mode === "adaptive" ||
    (mode === "content" && normalizedFillRatio > 0);
  if (!widthSensitive) return `${mode}:${normalizedDirection}`;
  const normalizedWidth = Number.isFinite(availableWidth)
    ? Math.max(0, Math.round(availableWidth))
    : 0;
  return mode === "adaptive" && normalizedFillRatio === 0
    ? `${mode}:${normalizedDirection}:${normalizedWidth}`
    : `${mode}:${normalizedDirection}:${normalizedWidth}:${normalizedFillRatio}`;
}

/** Rust 为每张表提供的逻辑布局证据；这里不携带 CSS 像素。 */
export interface TableLayoutEvidence {
  readonly rowCount?: number;
  readonly totalDisplayColumns?: readonly number[];
  readonly maxDisplayColumns?: readonly number[];
  readonly maxUnbreakableColumns?: readonly number[];
  readonly nonEmptyCells?: readonly number[];
  /** Rust 根据完整表格摘要计算的无量纲列需求权重。 */
  readonly demandWeights?: readonly number[];
}

/** 从 table RenderNode 读取 Rust 的表级布局摘要。旧 projection 没有摘要时返回 undefined。 */
export function tableLayoutEvidenceFromNode(node: RenderNode): TableLayoutEvidence | undefined {
  if (node.kind !== "table") return undefined;
  const attribute = (name: string) => node.attributes.find((item) => item.name === name)?.value;
  const numberValue = attribute("layoutRowCount");
  const numbers = (name: string): readonly number[] | undefined => {
    const value = attribute(name);
    return value?.type === "numbers" ? value.value : undefined;
  };
  const totalDisplayColumns = numbers("layoutTotalDisplayColumns");
  const maxDisplayColumns = numbers("layoutMaxDisplayColumns");
  const maxUnbreakableColumns = numbers("layoutMaxUnbreakableColumns");
  const nonEmptyCells = numbers("layoutNonEmptyCells");
  const demandWeights = numbers("layoutDemandWeights");
  if (
    numberValue?.type !== "number" &&
    totalDisplayColumns === undefined &&
    maxDisplayColumns === undefined &&
    maxUnbreakableColumns === undefined &&
    nonEmptyCells === undefined &&
    demandWeights === undefined
  ) {
    return undefined;
  }
  return {
    ...(numberValue?.type === "number" ? { rowCount: numberValue.value } : {}),
    ...(totalDisplayColumns === undefined ? {} : { totalDisplayColumns }),
    ...(maxDisplayColumns === undefined ? {} : { maxDisplayColumns }),
    ...(maxUnbreakableColumns === undefined ? {} : { maxUnbreakableColumns }),
    ...(nonEmptyCells === undefined ? {} : { nonEmptyCells }),
    ...(demandWeights === undefined ? {} : { demandWeights }),
  };
}

/** 在不把可换行正文扩成 max-content 的前提下，估算一列的候选宽度。 */
export function resolveTableColumnWidths(
  preferredWidths: readonly (number | undefined)[],
  availableWidth: number,
  options: Pick<
    TableLayoutOptions,
    "mode" | "fillRatio" | "minColumnWidth" | "maxColumnWidth" | "estimatedColumnWidth"
  > = {},
  minimumWidths: readonly (number | undefined)[] = [],
  evidence?: TableLayoutEvidence,
): readonly number[] {
  const minimum = normalizePositive(options.minColumnWidth, DEFAULT_MIN_COLUMN_WIDTH);
  const maximum = Math.max(
    minimum,
    normalizePositive(options.maxColumnWidth, DEFAULT_MAX_COLUMN_WIDTH),
  );
  const estimated = normalizePositive(options.estimatedColumnWidth, DEFAULT_ESTIMATED_COLUMN_WIDTH);
  const widths = preferredWidths.map((preferred, index) => clampTableWidth(
    Math.max(
      preferred ?? estimated,
      evidencePreferredColumnWidth(index, evidence, estimated) ?? 0,
    ),
    minimum,
    maximum,
  ));
  const mode = options.mode ?? "content";
  const fillRatio = normalizeFillRatio(options.fillRatio);
  const shouldUseTargetWidth = mode === "adaptive" || (mode === "content" && fillRatio > 0);
  if (shouldUseTargetWidth) {
    const lowerBounds = widths.map((_, index) => clampTableWidth(
      minimumWidths[index] ?? minimum,
      minimum,
      maximum,
    ));
    const targetWidth = mode === "adaptive"
      ? availableWidth
      : Math.max(widths.reduce((sum, width) => sum + width, 0), availableWidth * fillRatio);
    reconcileAvailableWidth(
      widths,
      lowerBounds,
      targetWidth,
      maximum,
      new Set(),
      evidence,
      mode === "adaptive" || (mode === "content" && fillRatio > 0),
    );
  }
  return widths;
}

const DEFAULT_MIN_COLUMN_WIDTH = 56;
const DEFAULT_MAX_COLUMN_WIDTH = 560;
const DEFAULT_ESTIMATED_COLUMN_WIDTH = 160;
const DEFAULT_FILL_RATIO = 0;
/** estimatedColumnWidth 代表约 20 个逻辑显示列的舒适宽度。 */
const REFERENCE_DISPLAY_COLUMNS = 20;

/**
 * 由前端持有的表格几何策略。Rust protocol 只描述表格语义；CSS 像素、viewport
 * 宽度和用户偏好属于这里。包装的 VirtualAxis 使列虚拟化保持 O(log n)。
 */
export class TableLayoutController {
  readonly #tableId: string;
  readonly #axis: VirtualAxis;
  readonly #options: Required<Pick<
    TableLayoutOptions,
    "mode" | "autoWidth" | "fillRatio" | "minColumnWidth" | "maxColumnWidth" | "estimatedColumnWidth" | "resizableColumns"
  >> & Pick<
    TableLayoutOptions,
    "columnWidths" | "resolveTableKey" | "resolveColumnWidths" | "onColumnResize" | "onLayoutChange"
  >;
  // 手动调过的列宽由宿主指定，后续自动测量只分配未固定的列。
  readonly #pinned = new Set<number>();
  readonly #listeners = new Set<(snapshot: TableLayoutSnapshot) => void>();
  #schemaKey = "";
  #contextKey = "";
  #autoWidthsSealed = false;
  #autoWidthsCommitted = false;

  constructor(tableId: string, options: TableLayoutOptions = {}) {
    this.#tableId = tableId;
    const min = normalizePositive(options.minColumnWidth, DEFAULT_MIN_COLUMN_WIDTH);
    const max = Math.max(min, normalizePositive(options.maxColumnWidth, DEFAULT_MAX_COLUMN_WIDTH));
    this.#options = {
      mode: options.mode ?? "content",
      autoWidth: options.autoWidth ?? "stable",
      fillRatio: normalizeFillRatio(options.fillRatio ?? DEFAULT_FILL_RATIO),
      minColumnWidth: min,
      maxColumnWidth: max,
      estimatedColumnWidth: normalizePositive(
        options.estimatedColumnWidth,
        DEFAULT_ESTIMATED_COLUMN_WIDTH,
      ),
      resizableColumns: options.resizableColumns ?? true,
      ...(options.columnWidths === undefined ? {} : { columnWidths: options.columnWidths }),
      ...(options.resolveTableKey === undefined
        ? {}
        : { resolveTableKey: options.resolveTableKey }),
      ...(options.resolveColumnWidths === undefined
        ? {}
        : { resolveColumnWidths: options.resolveColumnWidths }),
      ...(options.onColumnResize === undefined ? {} : { onColumnResize: options.onColumnResize }),
      ...(options.onLayoutChange === undefined ? {} : { onLayoutChange: options.onLayoutChange }),
    };
    this.#axis = new VirtualAxis(this.#options.estimatedColumnWidth);
  }

  get tableId(): string {
    return this.#tableId;
  }

  get mode(): TableLayoutMode {
    return this.#options.mode;
  }

  get autoWidth(): TableAutoWidthMode {
    return this.#options.autoWidth;
  }

  get fillRatio(): number {
    return this.#options.fillRatio;
  }

  get resizableColumns(): boolean {
    return this.#options.resizableColumns;
  }

  /** 供 DOM 层在进入 Canvas/几何扫描前做 O(1) 快速判断。 */
  get needsAutoWidthMeasurement(): boolean {
    if (this.#options.mode === "fixed") return false;
    return this.#options.autoWidth !== "stable" || !this.#autoWidthsSealed;
  }

  get count(): number {
    return this.#axis.count;
  }

  get totalSize(): number {
    return this.#axis.totalSize;
  }

  sizeAt(index: number): number {
    return this.#axis.sizeAt(index);
  }

  offsetAt(index: number): number {
    return this.#axis.offsetAt(index);
  }

  indexAt(pixelOffset: number): number {
    return this.#axis.indexAt(pixelOffset);
  }

  window(viewportStart: number, viewportSize: number, overscanPixels: number): VirtualWindow {
    return this.#axis.window(viewportStart, viewportSize, overscanPixels);
  }

  isPinned(index: number): boolean {
    return this.#pinned.has(index);
  }

  snapshot(): TableLayoutSnapshot {
    const widths = Array.from({ length: this.count }, (_, index) => this.sizeAt(index));
    return {
      tableId: this.#tableId,
      mode: this.#options.mode,
      autoWidth: this.#options.autoWidth,
      fillRatio: this.#options.fillRatio,
      columnCount: this.count,
      widths,
      pinnedColumns: [...this.#pinned].sort((left, right) => left - right),
      totalWidth: this.totalSize,
    };
  }

  subscribe(listener: (snapshot: TableLayoutSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 对齐语义列形状，同时保留稳定的用户列宽选择。 */
  configure(columnCount: number, schemaKey: string, contextKey = ""): void {
    const schemaChanged = schemaKey !== this.#schemaKey;
    const contextChanged = contextKey !== this.#contextKey;
    this.#schemaKey = schemaKey;
    this.#contextKey = contextKey;
    if (schemaChanged || contextChanged) {
      this.#autoWidthsSealed = false;
      this.#autoWidthsCommitted = false;
    }
    this.#axis.resize(columnCount);
    if (schemaChanged) this.#applyConfiguredWidths(columnCount);
    if (contextChanged && !schemaChanged) this.invalidateAutoWidths();
    this.#applyMinimumWidths(false);
  }

  /** 用户设置的宽度是显式选择，因此优先于后续自动测量。 */
  setUserWidth(index: number, width: number): boolean {
    this.#assertIndex(index);
    if (!this.#options.resizableColumns) return false;
    const normalized = this.#clamp(width);
    const changed = this.#axis.setSize(index, normalized);
    this.#pinned.add(index);
    if (!changed) return false;
    this.#emit(index, normalized, "user");
    return true;
  }

  clearUserWidth(index: number): boolean {
    this.#assertIndex(index);
    if (!this.#pinned.delete(index)) return false;
    this.#autoWidthsSealed = false;
    this.#autoWidthsCommitted = false;
    this.#axis.resetSize(index, this.#options.estimatedColumnWidth);
    this.#emit(index, this.sizeAt(index), "measurement");
    return true;
  }

  /** 字体、DPR 或容器变化后使自动列宽失效。 */
  resetAutoWidths(emit = true): boolean {
    this.#autoWidthsSealed = false;
    this.#autoWidthsCommitted = false;
    let changed = false;
    for (let index = 0; index < this.count; index += 1) {
      if (this.#pinned.has(index)) continue;
      changed = this.#axis.resetSize(index, this.#options.estimatedColumnWidth) || changed;
    }
    if (changed && emit) this.#emit(-1, 0, "measurement");
    return changed;
  }

  /** 按选定策略应用测得的内容宽度。 */
  measure(index: number, measuredWidth: number, fillWidth: number): boolean {
    this.#assertIndex(index);
    if (this.#pinned.has(index)) return false;
    if (this.#options.mode === "fixed") return false;
    if (this.#options.autoWidth === "stable" && this.#autoWidthsSealed) return false;
    const measured = this.#clamp(measuredWidth);
    const fill = this.#clamp(fillWidth);
    const target = this.#options.mode === "content" && this.#options.fillRatio === 0
      ? measured
      : Math.max(measured, fill);
    const previous = this.sizeAt(index);
    // stable 在一次批次内保持宽度；invalidate 后允许重新收敛。live 每次测量
    // 都允许双向变化，调用方负责以帧为单位合并测量和滚动锚点修正。
    if (this.#options.autoWidth === "stable" && this.#autoWidthsCommitted &&
      target < previous - 0.5) return false;
    if (Math.abs(target - previous) <= 0.5) return false;
    const changed = this.#axis.setSize(index, target);
    return changed;
  }

  /**
   * 以一次快照提交整张表的列宽。
   *
   * 普通文本允许软换行，因此 preferredWidths 表示“舒适阅读宽度”，而不是
   * 整个 cell 的 max-content 宽度。adaptive 或 content+fillRatio 模式会把目标
   * 宽度的空间优先给 Rust 识别出的换行压力列；空间不足时，从未固定列的可压缩
   * 空间中回收。若连最小宽度也无法容纳，才保留横向溢出。所有非固定列在同一次
   * 提交中更新，从而避免虚拟行逐个挂载时出现列边界漂移。
   */
  reconcile(
    preferredWidths: readonly (number | undefined)[],
    availableWidth: number,
    evidence?: TableLayoutEvidence,
  ): boolean {
    if (!this.needsAutoWidthMeasurement) return false;

    const widths = Array.from({ length: this.count }, (_, index) => {
      if (this.#pinned.has(index)) return this.sizeAt(index);
      const preferred = preferredWidths[index];
      const candidate = this.#clamp(Math.max(
        preferred ?? this.sizeAt(index),
        evidencePreferredColumnWidth(
          index,
          evidence,
          this.#options.estimatedColumnWidth,
        ) ?? 0,
      ));
      return this.#options.autoWidth === "stable" && this.#autoWidthsCommitted
        ? Math.max(candidate, this.sizeAt(index))
        : candidate;
    });

    const shouldUseTargetWidth = this.#options.mode === "adaptive" ||
      (this.#options.mode === "content" && this.#options.fillRatio > 0);
    if (shouldUseTargetWidth) {
      const targetWidth = this.#options.mode === "adaptive"
        ? availableWidth
        : Math.max(
          widths.reduce((sum, width) => sum + width, 0),
          availableWidth * this.#options.fillRatio,
        );
      reconcileAvailableWidth(
        widths,
        widths.map(() => this.#options.minColumnWidth),
        targetWidth,
        this.#options.maxColumnWidth,
        this.#pinned,
        evidence,
        this.#options.mode === "adaptive" ||
          (this.#options.mode === "content" && this.#options.fillRatio > 0),
      );
    }

    let changed = false;
    for (let index = 0; index < widths.length; index += 1) {
      if (this.#pinned.has(index)) continue;
      changed = this.#axis.setSize(index, widths[index]!) || changed;
    }
    this.#autoWidthsCommitted = true;
    if (changed) this.#emit(-1, 0, "measurement");
    return changed;
  }

  /** 内容发生增量变化；下一次批量测量允许自动列宽双向重新收敛。 */
  invalidateAutoWidths(): void {
    this.#autoWidthsSealed = false;
    this.#autoWidthsCommitted = false;
  }

  /** 在首轮可见单元格完成测量后冻结自动列宽，后续虚拟行只在列内换行。 */
  sealAutoWidths(): void {
    if (this.#options.autoWidth === "stable") this.#autoWidthsSealed = true;
  }

  ensureMinimumWidths(): boolean {
    return this.#applyMinimumWidths(true);
  }

  #applyConfiguredWidths(columnCount: number): void {
    const previousPinned = new Map(
      [...this.#pinned]
        .filter((index) => index < columnCount)
        .map((index) => [index, this.sizeAt(index)] as const),
    );
    this.#pinned.clear();
    const configured = this.#options.resolveColumnWidths?.(this.#tableId, columnCount) ??
      this.#options.columnWidths ?? [];
    for (let index = 0; index < columnCount; index += 1) {
      const width = configured[index];
      const previous = previousPinned.get(index);
      if (typeof width === "number" && Number.isFinite(width)) {
        this.#axis.setSize(index, this.#clamp(width));
        this.#pinned.add(index);
      } else if (previous !== undefined) {
        this.#axis.setSize(index, previous);
        this.#pinned.add(index);
      } else {
        this.#axis.resetSize(index, this.#options.estimatedColumnWidth);
      }
    }
  }

  #applyMinimumWidths(emit: boolean): boolean {
    let changed = false;
    for (let index = 0; index < this.count; index += 1) {
      if (this.sizeAt(index) >= this.#options.minColumnWidth) continue;
      changed = this.#axis.setSize(index, this.#options.minColumnWidth) || changed;
    }
    if (changed && emit) this.#emit(-1, 0, "measurement");
    return changed;
  }

  #clamp(width: number): number {
    return clampTableWidth(width, this.#options.minColumnWidth, this.#options.maxColumnWidth);
  }

  #assertIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError("table column index is outside the layout axis");
    }
  }

  #emit(column: number, width: number, source: TableColumnResizeEvent["source"]): void {
    if (column >= 0) {
      this.#options.onColumnResize?.({ tableId: this.#tableId, column, width, source });
    }
    const snapshot = this.snapshot();
    this.#options.onLayoutChange?.(snapshot);
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export function resolveTableLayoutOptions(options: {
  readonly table?: TableLayoutOptions;
  readonly estimatedColumnWidth?: number;
  readonly minTableColumnWidth?: number;
  readonly maxTableColumnWidth?: number;
}): TableLayoutOptions {
  return {
    ...options.table,
    ...(options.table?.estimatedColumnWidth === undefined && options.estimatedColumnWidth !== undefined
      ? { estimatedColumnWidth: options.estimatedColumnWidth }
      : {}),
    ...(options.table?.minColumnWidth === undefined && options.minTableColumnWidth !== undefined
      ? { minColumnWidth: options.minTableColumnWidth }
      : {}),
    ...(options.table?.maxColumnWidth === undefined && options.maxTableColumnWidth !== undefined
      ? { maxColumnWidth: options.maxTableColumnWidth }
      : {}),
  };
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeFillRatio(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

function clampTableWidth(width: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(width) || width <= 0) return minimum;
  return Math.min(maximum, Math.max(minimum, width));
}

/**
 * 把 Rust 的全表最大逻辑长度转换成一个稳定的像素下限。
 *
 * 这不是最终列宽，也不是 Rust 计算 CSS；它只是防止 stable 布局在容器 resize
 * 时因为“当前刚好挂载了哪一行”而出现候选宽度漂移。真实字体测量仍可提供更大的
 * 候选，最终空间分配继续由当前容器和列需求权重决定。
 */
function evidencePreferredColumnWidth(
  index: number,
  evidence: TableLayoutEvidence | undefined,
  estimatedColumnWidth: number,
): number | undefined {
  if (evidence === undefined) return undefined;
  const logicalColumns = Math.max(
    evidence.maxDisplayColumns?.[index] ?? 0,
    evidence.maxUnbreakableColumns?.[index] ?? 0,
  );
  if (logicalColumns <= 0) return undefined;
  const referenceWidth = normalizePositive(estimatedColumnWidth, DEFAULT_ESTIMATED_COLUMN_WIDTH);
  return referenceWidth * logicalColumns / REFERENCE_DISPLAY_COLUMNS;
}

/**
 * 生成软换行文本的有限测量样本。
 *
 * 超长可断文本不应按全文长度撑宽列；不可避免的长 token 也只需要参与“舒适
 * 宽度”估算，真正的渲染由 CSS `overflow-wrap:anywhere` 负责断行。
 */
export function softWrapPreferredSample(value: string, maxColumns = 28): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "";
  const tokens = collapsed
    .split(/[\s,.;:!?，。；：！？/\\()[\]{}<>|]+/u)
    .filter((token) => token.length > 0);
  const longest = tokens.reduce(
    (current, token) => displayColumns(token) > displayColumns(current) ? token : current,
    "",
  );
  const candidate = longest.length > 0 && displayColumns(longest) > maxColumns
    ? longest
    : collapsed;
  return truncateDisplayColumns(candidate, maxColumns);
}

function truncateDisplayColumns(value: string, maximum: number): string {
  let columns = 0;
  let result = "";
  for (const character of value) {
    const width = character === "\t" ? 4 : displayColumns(character);
    if (columns + width > maximum) break;
    result += character;
    columns += width;
  }
  return result || value.slice(0, 1);
}

function displayColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    columns += point >= 0x1100 ? 2 : 1;
  }
  return columns;
}

function reconcileAvailableWidth(
  widths: number[],
  lowerBounds: readonly number[],
  availableWidth: number,
  maximum: number,
  pinned: ReadonlySet<number>,
  evidence: TableLayoutEvidence | undefined,
  fallbackToWidthWeights: boolean,
): void {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total < availableWidth) {
    distributeSlack(
      widths,
      availableWidth - total,
      maximum,
      pinned,
      evidence,
      fallbackToWidthWeights,
    );
    return;
  }

  let deficit = total - availableWidth;
  while (deficit > 0.5) {
    const candidates = widths
      .map((width, index) => ({
        index,
        capacity: width - (lowerBounds[index] ?? 0),
      }))
      .filter(({ index, capacity }) => !pinned.has(index) && capacity > 0.5);
    if (candidates.length === 0) return;
    const capacity = candidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
    if (capacity <= 0) return;
    let reduced = 0;
    for (const candidate of candidates) {
      const delta = Math.min(
        candidate.capacity,
        deficit * candidate.capacity / capacity,
      );
      widths[candidate.index] = Math.max(
        lowerBounds[candidate.index] ?? 0,
        widths[candidate.index]! - delta,
      );
      reduced += delta;
    }
    if (reduced <= 0.5) return;
    deficit -= reduced;
  }
}

function distributeSlack(
  widths: number[],
  remaining: number,
  maximum: number,
  pinned: ReadonlySet<number>,
  evidence: TableLayoutEvidence | undefined,
  fallbackToWidthWeights: boolean,
): void {
  if (!Number.isFinite(remaining) || remaining <= 0) return;

  const active = () => widths
    .map((width, index) => ({ index, width }))
    .filter(({ index, width }) => !pinned.has(index) && width < maximum - 0.5);

  while (remaining > 0.5) {
    const candidates = active();
    if (candidates.length === 0) return;
    const demandWeights = candidates.map((candidate) => ({
      ...candidate,
      weight: tableColumnDemandWeight(candidate.index, evidence),
    }));
    const demandWeight = demandWeights.reduce((sum, candidate) => sum + candidate.weight, 0);
    const weight = demandWeight > 0
      ? demandWeight
      : fallbackToWidthWeights
        ? candidates.reduce((sum, candidate) => sum + candidate.width, 0)
        : 0;
    if (weight <= 0) return;
    let distributed = 0;
    for (const candidate of demandWeights) {
      const candidateWeight = demandWeight > 0
        ? candidate.weight
        : candidate.width;
      const share = remaining * candidateWeight / weight;
      const delta = Math.min(share, maximum - candidate.width);
      widths[candidate.index] = candidate.width + delta;
      distributed += delta;
    }
    if (distributed <= 0.5) return;
    remaining -= distributed;
  }
}

/**
 * 将 Rust 的逻辑布局摘要转换为剩余空间权重。
 *
 * max-average 是“少数长 cell 造成的换行压力”，average 则避免所有内容都较长时
 * 完全没有弹性。这个权重不代表 CSS 像素比例，只用于决定哪一列先获得额外空间。
 */
function tableColumnDemandWeight(
  index: number,
  evidence: TableLayoutEvidence | undefined,
): number {
  if (evidence === undefined) return 0;
  const total = evidence.totalDisplayColumns?.[index] ?? 0;
  const demand = evidence.demandWeights?.[index];
  if (demand !== undefined) {
    return Number.isFinite(demand) && demand > 0 ? demand : 0;
  }
  const maximum = Math.max(
    evidence.maxDisplayColumns?.[index] ?? 0,
    evidence.maxUnbreakableColumns?.[index] ?? 0,
  );
  const count = evidence.nonEmptyCells?.[index] ?? evidence.rowCount ?? 0;
  if (count <= 0 || (total <= 0 && maximum <= 0)) return 0;
  const average = total / count;
  const outlierPressure = Math.max(0, maximum - Math.max(average, 4));
  const densityPressure = Math.max(0, average - 4);
  return outlierPressure * 2 + densityPressure;
}
