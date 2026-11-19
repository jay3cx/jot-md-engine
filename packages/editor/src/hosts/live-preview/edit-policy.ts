import type { RenderNode } from "@jot-md/editor-protocol";
import {
  componentInteractionSurfaces,
  type ComponentInteractionDeletion,
  type ComponentInteractionDeletionResult,
  type ComponentInteractionRanges,
  type ComponentInteractionSurface,
} from "../../components/index.js";
import {
  resolveLivePreviewCaret,
  type LivePreviewCaretIntent,
  type LivePreviewCaretSurface,
} from "./vertical-navigation.js";

export interface ProjectionEditChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface ProjectionEditRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Live Preview 的事务边界。
 *
 * 组件 adapter 从 Rust 已确认的 RenderNode 生成 editable / protected / command
 * range。这个类不解析 Markdown，也不拥有 selection；它只把当前 revision 的
 * 组件交互面映射到 CodeMirror transaction 的安全判定。
 */
export class LivePreviewEditPolicy {
  #source = "";
  #sourceLength = 0;
  #surfaces: InteractionSurface[] = [];
  #editable: ProjectionEditRange[] = [];
  #protected: ProjectionEditRange[] = [];
  #command: ProjectionEditRange[] = [];
  #navigation: LivePreviewCaretSurface[] = [];
  #hiddenSyntax: ProjectionEditRange[] = [];

  update(source: string, nodes: readonly RenderNode[]): void {
    this.#source = source;
    this.#sourceLength = source.length;
    this.#surfaces = componentInteractionSurfaces(nodes, { source })
      .map((surface) => normalizeSurface(surface, source.length));
    this.#refreshRanges();
  }

  clear(): void {
    this.#source = "";
    this.#sourceLength = 0;
    this.#surfaces = [];
    this.#editable = [];
    this.#protected = [];
    this.#command = [];
    this.#navigation = [];
    this.#hiddenSyntax = [];
  }

  /** Use exactly the ranges hidden by the committed plan, never reparse text. */
  setHiddenSyntax(ranges: readonly ProjectionEditRange[]): void {
    this.#hiddenSyntax = mergeRanges(ranges.map((range) =>
      normalizedRange(range, this.#sourceLength)));
  }

  resolveCaret(position: number, intent: LivePreviewCaretIntent = {}): number | undefined {
    return resolveLivePreviewCaret(
      this.#source, position, this.#navigation, this.#hiddenSyntax, intent,
    );
  }

  get hasNavigation(): boolean {
    return this.#navigation.length > 0 || this.#hiddenSyntax.length > 0;
  }

  /** Empty visible prefix rows share one exit rule regardless of node kind. */
  isEmptyPrefixLine(position: number): boolean {
    const from = this.#source.lastIndexOf("\n", position - 1) + 1;
    const newline = this.#source.indexOf("\n", position);
    const to = newline < 0 ? this.#sourceLength : newline;
    const prefix = this.#hiddenSyntax.find((range) => range.from === from && range.to <= to);
    return prefix !== undefined && prefix.to <= position &&
      this.#source.slice(prefix.to, to).trim().length === 0 &&
      this.allows([{ from, to, insert: "" }]);
  }

  allows(changes: readonly ProjectionEditChange[]): boolean {
    if (changes.length === 0 || this.#surfaces.length === 0) return true;
    return changes.every((change) => this.#allowsChange(change));
  }

  /**
   * 组件 root 的外部删除语义不应该散落在 Host 的 keydown 分支中。Host 只提供
   * 当前 collapsed CodeMirror position；具体组件根据 Rust-confirmed
   * sourceRange / editableRanges 决定是删除 root、消费边界，还是不接管。
   */
  resolveDeletion(
    deletion: ComponentInteractionDeletion,
  ): ComponentInteractionDeletionResult | undefined {
    if (this.#surfaces.length === 0) return undefined;
    const normalized = {
      ...deletion,
      position: clamp(deletion.position, 0, this.#sourceLength),
    };
    for (const surface of [...this.#surfaces].sort((left, right) =>
      span(left.sourceRange) - span(right.sourceRange) ||
      left.sourceRange.from - right.sourceRange.from)) {
      const resolved = surface.resolveDeletion?.(normalized, rangesFor(surface));
      if (resolved === undefined) continue;
      if (resolved.kind === "consume") return resolved;
      const from = clamp(resolved.from, 0, this.#sourceLength);
      const to = clamp(resolved.to, from, this.#sourceLength);
      if (to > from) return { kind: "delete-range", from, to };
    }
    return undefined;
  }

  get editableRanges(): readonly ProjectionEditRange[] {
    return this.#editable;
  }

  get protectedRanges(): readonly ProjectionEditRange[] {
    return this.#protected;
  }

  get commandRanges(): readonly ProjectionEditRange[] {
    return this.#command;
  }

  #refreshRanges(): void {
    this.#editable = mergeRanges(this.#surfaces.flatMap((surface) => surface.editableRanges));
    this.#protected = mergeRanges(this.#surfaces.flatMap((surface) => surface.protectedRanges));
    this.#command = mergeRanges(this.#surfaces.flatMap((surface) => surface.commandRanges));
    this.#navigation = this.#surfaces
      .filter((surface) => surface.navigationRanges !== undefined)
      .map((surface) => ({ sourceRange: surface.sourceRange, navigationRanges: surface.navigationRanges! }))
      .sort((left, right) => span(left.sourceRange) - span(right.sourceRange));
  }

  #allowsChange(change: ProjectionEditChange): boolean {
    const touched = this.#surfaces.filter((surface) =>
      touches(surface.sourceRange, change.from, change.to));
    if (touched.length === 0) return true;

    // Cmd/Ctrl+A 后的 Delete / Paste 是“替换整篇 Markdown”的正常 CodeMirror
    // 事务，而不是试图从 table cell 穿过 pipe。对每个被命中的组件根单独判断：
    // 只要该 root 被此次删除范围完整覆盖，它会整体消失，因此允许它随事务一并
    // 被替换；部分覆盖仍必须落在同一个 adapter 声明的 editable range。
    //
    // 不能只取 innermost surface：一个全选事务可能同时覆盖多张 table，任一
    // 未被完整包含的 root 都仍是结构穿越，应继续拒绝。
    const partial = touched.filter((surface) => !coversSurface(surface.sourceRange, change));
    if (partial.length === 0) return true;

    // 嵌套 interaction surface 只要被外层完整删除即可随之消失。这里剩下的是
    // 未完整覆盖的最内层 root；若其父级也处于 partial 集合，优先用最小范围
    // 执行 cell 规则，避免不同 adapter 重复判定同一段输入。
    const surface = innermostSurface(partial, change);
    if (surface === undefined) return true;
    const editable = surface.editableRanges.find((range) => containsEdit(range, change));
    if (editable === undefined) return false;
    // 结构字符与 command range 即使恰好在 cell 边界相邻，也不能借由普通
    // transaction 穿越。containsEdit 已保证整个 edit 位于同一 EditableRange；
    // adapter 只负责组件私有 serializer 规则。
    return surface.allowsEdit?.(change, rangesFor(surface)) ?? true;
  }
}

interface InteractionSurface {
  readonly componentId: string;
  readonly sourceRange: ProjectionEditRange;
  readonly editableRanges: readonly ProjectionEditRange[];
  readonly protectedRanges: readonly ProjectionEditRange[];
  readonly commandRanges: readonly ProjectionEditRange[];
  readonly navigationRanges?: readonly ProjectionEditRange[];
  readonly allowsEdit?: (
    edit: ProjectionEditChange,
    ranges: ComponentInteractionRanges,
  ) => boolean;
  readonly resolveDeletion?: (
    deletion: ComponentInteractionDeletion,
    ranges: ComponentInteractionRanges,
  ) => ComponentInteractionDeletionResult | undefined;
}

function normalizeSurface(
  surface: ComponentInteractionSurface,
  sourceLength: number,
): InteractionSurface {
  return {
    componentId: surface.componentId,
    sourceRange: normalizedRange(surface.sourceRange, sourceLength),
    editableRanges: mergeRanges(surface.editableRanges.map((range) =>
      normalizedRange(range, sourceLength))),
    protectedRanges: mergeRanges(surface.protectedRanges.map((range) =>
      normalizedRange(range, sourceLength))),
    commandRanges: mergeRanges(surface.commandRanges.map((range) =>
      normalizedRange(range, sourceLength))),
    ...(surface.navigationRanges === undefined ? {} : {
      navigationRanges: mergeRanges(surface.navigationRanges.map((range) =>
        normalizedRange(range, sourceLength))),
    }),
    ...(surface.allowsEdit === undefined ? {} : { allowsEdit: surface.allowsEdit }),
    ...(surface.resolveDeletion === undefined
      ? {}
      : { resolveDeletion: surface.resolveDeletion }),
  };
}

function normalizedRange(
  range: { readonly from: number; readonly to: number },
  sourceLength = Number.MAX_SAFE_INTEGER,
): ProjectionEditRange {
  const from = clamp(Number(range.from), 0, sourceLength);
  const to = clamp(Number(range.to), from, sourceLength);
  return { from, to };
}

function mergeRanges(ranges: readonly ProjectionEditRange[]): ProjectionEditRange[] {
  const merged: ProjectionEditRange[] = [];
  for (const range of [...ranges].sort(compareRanges)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.from <= previous.to) {
      merged[merged.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, range.to),
      };
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function compareRanges(left: ProjectionEditRange, right: ProjectionEditRange): number {
  return left.from - right.from || left.to - right.to;
}

function innermostSurface(
  surfaces: readonly InteractionSurface[],
  change: ProjectionEditChange,
): InteractionSurface | undefined {
  return surfaces
    .filter((surface) => touches(surface.sourceRange, change.from, change.to))
    .sort((left, right) =>
      span(left.sourceRange) - span(right.sourceRange) ||
      left.sourceRange.from - right.sourceRange.from)[0];
}

function coversSurface(
  range: ProjectionEditRange,
  change: ProjectionEditChange,
): boolean {
  // 纯插入永远不会“删除”一个既有组件 root。即使插入点在边界处，也要继续
  // 走 cell/protected-range 判定，不能把 table 末尾的输入误放行。
  return change.from < change.to &&
    change.from <= range.from &&
    range.to <= change.to;
}

function rangesFor(surface: InteractionSurface): ComponentInteractionRanges {
  return {
    editableRanges: surface.editableRanges.map(textRange),
    protectedRanges: surface.protectedRanges.map(textRange),
    commandRanges: surface.commandRanges.map(textRange),
    ...(surface.navigationRanges === undefined ? {} : {
      navigationRanges: surface.navigationRanges.map(textRange),
    }),
  };
}

function textRange(range: ProjectionEditRange): import("@jot-md/editor-protocol").TextRange {
  return {
    from: range.from as import("@jot-md/editor-protocol").TextRange["from"],
    to: range.to as import("@jot-md/editor-protocol").TextRange["to"],
  };
}

/**
 * 纯插入的 CodeMirror 位置位于两个 UTF-16 单元之间。cell sourceRange 通常
 * 包含两侧空格，因此插入点可以合法地处于 `[from, to]`；删除/替换仍保持半开
 * 区间，不能跨到紧邻的 pipe、delimiter 或物理换行。
 */
function containsEdit(range: ProjectionEditRange, change: ProjectionEditChange): boolean {
  if (change.from === change.to) {
    return change.from >= range.from && change.from <= range.to;
  }
  return change.from >= range.from && change.to <= range.to;
}

function touches(range: ProjectionEditRange, from: number, to: number): boolean {
  return from === to
    ? from >= range.from && from <= range.to
    : from < range.to && to > range.from;
}

function span(range: ProjectionEditRange): number {
  return range.to - range.from;
}

function clamp(value: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, value));
}
