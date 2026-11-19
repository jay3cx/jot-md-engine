import { resolveSourceRootAt } from "./presentation.js";
import type { RenderNode } from "@jot-md/editor-protocol";
import { createClosedContainerModel, type ClosedContainerModel } from "../../components/closed-container/model.js";

/**
 * 非表格 block widget 的垂直进入规则。
 *
 * CodeMirror 无法把 native ArrowUp/Down 放进 atomic replacement widget 的内部
 * 源码位置。这里不根据 Markdown 语义树猜测“相邻节点”，只在当前物理源码行与
 * 已确认 block replacement 紧邻时，把 selection 映射到该 block 的 source
 * 边界并触发源码回显。这样空行仍是真实物理行，多行 active source 内部仍交给
 * CodeMirror 原生垂直移动。
 */
export interface LivePreviewBlockReplacement {
  readonly from: number;
  readonly to: number;
}

export interface LivePreviewVerticalNavigationTarget {
  readonly range: LivePreviewBlockReplacement;
  readonly anchor: number;
}

export type LivePreviewVerticalDirection = "up" | "down";

/** The first physical content row can reveal its confirmed opening line. */
export function resolveLivePreviewOpeningNavigation(
  source: string,
  nodes: readonly RenderNode[],
  currentHead: number,
  movedHead: number | undefined,
  direction: LivePreviewVerticalDirection,
): LivePreviewVerticalNavigationTarget | undefined {
  const current = clamp(currentHead, 0, source.length);
  const moved = movedHead === undefined ? undefined : clamp(movedHead, 0, source.length);
  const currentLine = sourceLineAt(source, current);
  for (const model of closedContainers(nodes)) {
    const opening = { from: Number(model.openingRange.from), to: Number(model.openingRange.to) };
    const content = { from: Number(model.contentRange.from), to: Number(model.contentRange.to) };
    const root = { from: Number(model.sourceRange.from), to: Number(model.sourceRange.to) };
    if (direction === "up") {
      if (current < content.from || current > content.to ||
          currentLine.from !== sourceLineAt(source, content.from).from) continue;
      // Native movement within a wrapped physical row should keep its visual
      // column; reveal the header only when leaving the first physical row.
      if (moved !== undefined && moved !== current && sourceLineAt(source, moved).from === currentLine.from) continue;
      return { range: root, anchor: opening.to };
    }
    // An intervening blank row remains a real navigation stop. Enter the
    // content only from the physical row immediately before the opener.
    if (current < opening.from && currentLine.to + 1 === opening.from &&
        moved !== undefined && opening.from <= moved && moved <= opening.to) {
      return { range: root, anchor: content.from };
    }
  }
  return undefined;
}

/** Return the confirmed editable opener containing a caret, including its EOL. */
export function resolveLivePreviewOpeningRange(
  nodes: readonly RenderNode[],
  position: number,
): LivePreviewBlockReplacement | undefined {
  for (const model of closedContainers(nodes)) {
    const from = Number(model.openingRange.from), to = Number(model.openingRange.to);
    if (from <= position && position <= to) return { from, to };
  }
  return undefined;
}

function closedContainers(nodes: readonly RenderNode[]): ClosedContainerModel[] {
  const result: ClosedContainerModel[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const model = createClosedContainerModel(node);
    if (model !== undefined) result.push(model);
    if (node.content.type === "structured") pending.push(...node.content.children);
  }
  return result.sort((a, b) =>
    Number(a.sourceRange.to) - Number(a.sourceRange.from) -
    (Number(b.sourceRange.to) - Number(b.sourceRange.from)));
}

export interface LivePreviewCaretSurface {
  readonly sourceRange: LivePreviewBlockReplacement;
  readonly navigationRanges: readonly LivePreviewBlockReplacement[];
}

export interface LivePreviewCaretIntent {
  /** Omit for pointer placement; it chooses the nearest visible content. */
  readonly direction?: "backward" | "forward";
  /** Home/End keep the caret on its physical line rather than crossing a seam. */
  readonly lineBoundary?: boolean;
  /** Vertical motion already chose a visual row; its hidden prefix stays on that row. */
  readonly vertical?: boolean;
}

/**
 * One caret policy for every hidden presentation. Component-declared content
 * ranges own structural gaps (including invisible physical rows); decoration
 * ranges own inline syntax such as quote/list prefixes. No Markdown kinds or
 * token recognition belong here. Selection offsets, searches and programmatic
 * source commands remain untouched; the host calls this only for user motion.
 */
export function resolveLivePreviewCaret(
  source: string,
  offset: number,
  surfaces: readonly LivePreviewCaretSurface[],
  hiddenSyntax: readonly LivePreviewBlockReplacement[],
  intent: LivePreviewCaretIntent = {},
): number | undefined {
  const position = clamp(offset, 0, source.length);
  const surface = resolveSourceRootAt(source, surfaces, position);
  if (surface !== undefined && surface.navigationRanges.length > 0) {
    const ranges = surface.navigationRanges;
    if (ranges.some((range) => range.from <= position && position <= range.to)) {
      return undefined;
    }
    const before = [...ranges].reverse().find((range) => range.to < position);
    const after = ranges.find((range) => range.from > position);
    if (intent.direction === undefined || intent.lineBoundary === true) {
      if (before === undefined) return after?.from;
      if (after === undefined) return before.to;
      return position - before.to < after.from - position ? before.to : after.from;
    }
    if (intent.direction === "backward") {
      if (before !== undefined) return before.to;
      return surface.sourceRange.from > 0 ? surface.sourceRange.from - 1 : ranges[0]!.from;
    }
    if (after !== undefined) return after.from;
    const end = blockTerminatorEnd(source, surface.sourceRange);
    return end < source.length || source[end - 1] === "\n" ? end : ranges.at(-1)!.to;
  }

  for (const range of hiddenSyntax) {
    // A hidden prefix begins at a physical line boundary. That start position
    // is not a visible caret destination; an inline token's start still is.
    const prefix = range.from === 0 || source[range.from - 1] === "\n";
    if (position < range.from || position >= range.to || position === range.from && !prefix) continue;
    if (intent.direction === "backward" && intent.lineBoundary !== true && !(prefix && intent.vertical === true)) {
      return prefix ? range.from > 0 ? range.from - 1 : range.to : range.from;
    }
    return range.to;
  }
  return undefined;
}

function blockTerminatorEnd(source: string, range: LivePreviewBlockReplacement): number {
  if (range.to <= range.from || range.to >= source.length) return range.to;
  return source[range.to - 1] === "\n" || source[range.to] !== "\n"
    ? range.to
    : range.to + 1;
}

export interface LivePreviewBlockExit {
  readonly from: number;
  readonly insert: string;
  readonly anchor: number;
}

/** A root owns its terminating LF, but never the neighboring empty line. */
export function resolveLivePreviewBlockExit(
  source: string,
  range: LivePreviewBlockReplacement,
  direction: "before" | "after",
): LivePreviewBlockExit {
  if (direction === "before") {
    if (range.from > 0) {
      const previous = sourceLineAt(source, range.from - 1);
      if (source.slice(previous.from, previous.to).trim().length === 0) {
        return { from: previous.from, insert: "", anchor: previous.from };
      }
    }
    return { from: range.from, insert: "\n", anchor: range.from };
  }
  const from = blockTerminatorEnd(source, range);
  if (from < source.length || source[from - 1] === "\n") {
    const next = sourceLineAt(source, from);
    if (source.slice(next.from, next.to).trim().length === 0) {
      return { from, insert: "", anchor: from };
    }
    return { from, insert: "\n", anchor: from };
  }
  return { from, insert: "\n", anchor: from + 1 };
}

export function resolveLivePreviewVerticalNavigation(
  source: string,
  offset: number,
  replacements: readonly LivePreviewBlockReplacement[],
  direction: LivePreviewVerticalDirection,
): LivePreviewVerticalNavigationTarget | undefined {
  const position = clamp(offset, 0, source.length);
  const blocks = normalizedBlocks(source.length, replacements);
  if (blocks.length === 0) return undefined;

  // CodeMirror may expose a replacement endpoint as the current source
  // position. Enter the widget on the direction-facing endpoint before
  // searching for a neighboring physical line.
  const direct = direction === "up"
    ? blocks.filter((block) => block.from < position && position <= block.to)
    : blocks.filter((block) => block.from <= position && position < block.to);
  const directTarget = direction === "up"
    ? direct.sort((left, right) => right.to - left.to)[0]
    : direct.sort((left, right) => left.from - right.from)[0];
  if (directTarget !== undefined) return target(source, directTarget, direction);

  const line = sourceLineAt(source, position);
  if (direction === "up") {
    // Only cross an exact seam. If a true BlankLine lies in between, native
    // CodeMirror movement must visit that physical line first.
    const previous = blocks
      .filter((block) => block.to <= line.from && source.slice(block.to, line.from) === "")
      .sort((left, right) => right.to - left.to)[0];
    return previous === undefined ? undefined : target(source, previous, direction);
  }

  // The newline following the current source line is the only allowed bridge.
  // Two LF characters mean there is an actual BlankLine that must remain on
  // CodeMirror's physical navigation axis.
  const next = blocks
    .filter((block) => block.from >= line.to && source.slice(line.to, block.from) === "\n")
    .sort((left, right) => left.from - right.from)[0];
  return next === undefined ? undefined : target(source, next, direction);
}

function target(
  source: string,
  range: LivePreviewBlockReplacement,
  direction: LivePreviewVerticalDirection,
): LivePreviewVerticalNavigationTarget {
  const anchor = direction === "down"
    ? range.from
    : range.to > range.from && source[range.to - 1] === "\n"
      ? range.to - 1
      : range.to;
  return { range, anchor: clamp(anchor, range.from, range.to) };
}

function normalizedBlocks(
  length: number,
  ranges: readonly LivePreviewBlockReplacement[],
): readonly LivePreviewBlockReplacement[] {
  return ranges
    .map((range) => ({
      from: clamp(range.from, 0, length),
      to: clamp(range.to, clamp(range.from, 0, length), length),
    }))
    .filter((range) => range.from < range.to)
    .sort((left, right) => left.from - right.from || left.to - right.to);
}

function sourceLineAt(source: string, offset: number): {
  readonly from: number;
  readonly to: number;
} {
  const safe = clamp(offset, 0, source.length);
  const from = safe === 0 ? 0 : source.lastIndexOf("\n", safe - 1) + 1;
  const newline = source.indexOf("\n", safe);
  return { from, to: newline < 0 ? source.length : newline };
}

function clamp(value: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, value));
}
