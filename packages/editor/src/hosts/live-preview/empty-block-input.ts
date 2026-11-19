import type { RenderNode } from "@jot-md/editor-protocol";
import { Annotation } from "@codemirror/state";
import type { IndexedBlock, SyntaxBlockIndex } from "../../adapter/block-index.js";
import { createClosedContainerModel } from "../../components/closed-container/model.js";

export type OptimisticEmptyMarkerKind = "code-bare" | "code-end" | "math-dollar" | "math-bracket";

export const optimisticMarkerRisk = {
  "code-bare": 1,
  "code-end": 2,
  "math-dollar": 4,
  "math-bracket": 8,
} as const satisfies Record<OptimisticEmptyMarkerKind, number>;

/**
 * A bounded subset of the Rust grammar, only for preserving an immediate
 * first input while its confirmed blank row is still awaiting analysis.
 * Unknown or unusually long markers decline the optimistic path.
 */
export function resolveOptimisticEmptyMarkerKind(
  opening: string,
  closing: string,
  allowUnspacedLanguage = false,
): OptimisticEmptyMarkerKind | undefined {
  if (opening.length > 512 || closing.length > 512) return undefined;
  const start = standalone(opening), end = standalone(closing);
  if (start === undefined || end === undefined) return undefined;
  if (start === "$$" && end === "$$") return "math-dollar";
  if (start === "\\[" && end === "\\]") return "math-bracket";
  const kind = fenceOpeningKind(start, allowUnspacedLanguage);
  if (kind === undefined) return undefined;
  if (kind === "code-bare" && end === "```") return kind;
  if (kind === "code-end" && fenceEnd(end)) return kind;
  return undefined;
}

/**
 * Return unresolved marker types in a complete confirmed prefix. The caller
 * must independently prove that the current document has not changed before
 * this blank-line position. `undefined` means the proof or bounded scan was
 * unavailable, not that the prefix was safe.
 */
export function confirmedPrefixMarkerRisks(
  source: string,
  blocks: SyntaxBlockIndex,
  position: number,
  totalRoots: number,
  allowUnspacedLanguage = false,
): number | undefined {
  const roots = blocks.blocks;
  if (!Number.isSafeInteger(position) || position < 0 || position > source.length ||
      !Number.isSafeInteger(totalRoots) || totalRoots !== roots.length || roots.length > 65_536 ||
      (position > 0 && source[position - 1] !== "\n")) return undefined;
  // Some engines represent the wholly empty document with no root metadata.
  // This exact state has no prefix and needs no fabricated blank-line node.
  if (source.length === 0 && position === 0 && roots.length === 0) return 0;
  let blank = false, previousFrom = -1, previousTo = -1;
  for (const root of roots) {
    const from = Number(root.sourceRange.from), to = Number(root.sourceRange.to);
    if (root.dirty || root.kind === "unloaded" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
        from < 0 || to < from || to > source.length || from < previousFrom || from < previousTo) return undefined;
    previousFrom = from;
    previousTo = to;
    if (root.kind === "blank-line" && from === position && to === position) blank = true;
  }
  if (!blank) return undefined;
  const previousEnd = position - 1;
  const previousStart = previousEnd <= 0 ? 0 : source.lastIndexOf("\n", previousEnd - 1) + 1;
  if (position > 0 && source.slice(previousStart, previousEnd).endsWith("  ")) return undefined;

  // Cache each marker's previous occurrence. Re-scan a token only when its
  // cached position was consumed, avoiding O(markers * document length) when
  // the prefix contains many closed blocks but no markers of the other kinds.
  const tokens = ["```", "$$", "\\["] as const;
  const positions = tokens.map(token => position === 0 ? -1 : source.lastIndexOf(token, position - 1));
  let risks = 0, inspected = 0;
  while (true) {
    const marker = Math.max(...positions);
    if (marker < 0) return risks;
    if (++inspected > 4_096) return undefined;
    const lineFrom = marker === 0 ? 0 : source.lastIndexOf("\n", marker - 1) + 1;
    const newline = source.indexOf("\n", marker);
    const lineTo = newline < 0 ? source.length : newline;
    const owner = blockContainingLine(roots, lineFrom, lineTo);
    let restart = lineFrom - 1;
    if (owner !== undefined && (owner.kind === "fenced-code" || owner.kind === "math-block")) {
      // These Rust root kinds are emitted only after a closer is confirmed.
      restart = Number(owner.sourceRange.from) - 1;
    } else {
      const risk = openingRisk(source.slice(lineFrom, lineTo), allowUnspacedLanguage);
      // A standalone opener without a fully covering root is not proof that
      // it is ordinary source; the metadata could have a missing interval.
      if (risk !== 0 && owner === undefined) return undefined;
      risks |= risk;
    }
    for (let i = 0; i < positions.length; i++) {
      if (positions[i]! > restart) positions[i] = restart < 0 ? -1 : source.lastIndexOf(tokens[i]!, restart);
    }
  }
}

function blockContainingLine(roots: readonly IndexedBlock[], from: number, to: number): IndexedBlock | undefined {
  let low = 0, high = roots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Number(roots[middle]!.sourceRange.from) <= from) low = middle + 1;
    else high = middle;
  }
  const root = roots[low - 1];
  return root !== undefined && Number(root.sourceRange.from) <= from &&
    to <= Number(root.sourceRange.to) ? root : undefined;
}

function openingRisk(line: string, allowUnspacedLanguage: boolean): number {
  const marker = standalone(line);
  if (marker === undefined) return 0;
  if (marker === "$$") return optimisticMarkerRisk["math-dollar"];
  if (marker === "\\[") return optimisticMarkerRisk["math-bracket"];
  const fence = fenceOpeningKind(marker, allowUnspacedLanguage);
  return fence === undefined ? 0 : optimisticMarkerRisk[fence];
}

function standalone(line: string): string | undefined {
  const indent = /^ */u.exec(line)?.[0].length ?? 0;
  if (indent > 3 || line.includes("\n")) return undefined;
  return line.slice(indent).replace(/[ \t]+$/u, "");
}

function fenceOpeningKind(marker: string, allowUnspacedLanguage: boolean): "code-bare" | "code-end" | undefined {
  if (!marker.startsWith("```")) return undefined;
  const suffix = marker.slice(3);
  if (suffix.length === 0) return "code-bare";
  if (suffix.includes("`")) return undefined;
  if (!suffix.startsWith(" ")) {
    return allowUnspacedLanguage && !/[\t\v\f\r\n ]/u.test(suffix) &&
      suffix !== "begin" && suffix !== "end" ? "code-bare" : undefined;
  }
  const tokens = suffix.split(/[\t\v\f\r ]+/u).filter(Boolean);
  if (tokens.length === 0) return "code-bare";
  if (tokens.length === 1 && tokens[0] === "begin") return "code-end";
  if (tokens.length === 1 && tokens[0] !== "end") return "code-bare";
  if (tokens.length === 2 && tokens[1] === "begin" && tokens[0] !== "begin" && tokens[0] !== "end") return "code-end";
  return undefined;
}

function fenceEnd(marker: string): boolean {
  if (!marker.startsWith("``` ") || marker.includes("`", 3)) return false;
  const tokens = marker.slice(3).split(/[\t\v\f\r ]+/u).filter(Boolean);
  return tokens.length === 1 && tokens[0] === "end" ||
    tokens.length === 2 && tokens[1] === "end" && tokens[0] !== "begin" && tokens[0] !== "end";
}

export interface EmptyClosedContainer {
  readonly nodeId: string;
  readonly kind: "fenced-code" | "math-block";
  readonly from: number;
  readonly to: number;
  readonly position: number;
  readonly closing: { readonly from: number; readonly to: number };
}

/** Internal proof that this input belongs to a confirmed zero-width body. */
export const emptyContainerFirstInput = Annotation.define<{
  readonly nodeId: string;
  readonly position: number;
  readonly kind: "fenced-code" | "math-block";
}>();

/**
 * An opening immediately followed by its closer has no physical body row.
 * Identify that case from confirmed component ranges, never from raw markers.
 */
export function resolveEmptyClosedContainer(
  nodes: readonly RenderNode[],
  position: number,
): EmptyClosedContainer | undefined {
  let best: EmptyClosedContainer | undefined;
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const model = createClosedContainerModel(node);
    if (model !== undefined &&
        Number(model.contentRange.from) === position &&
        Number(model.contentRange.to) === position &&
        Number(model.closingRange.from) === position) {
      const candidate = {
        nodeId: model.id,
        kind: model.kind,
        from: Number(model.sourceRange.from),
        to: Number(model.sourceRange.to),
        position,
        closing: { from: Number(model.closingRange.from), to: Number(model.closingRange.to) },
      };
      if (best === undefined || candidate.to - candidate.from < best.to - best.from) best = candidate;
    }
    if (node.content.type === "structured") pending.push(...node.content.children);
  }
  return best;
}

export interface EmptyClosedContainerSeparator {
  readonly from: number;
  readonly to: number;
  readonly insert: "\n";
}

/**
 * Append a separator to the same transaction that makes the first real input.
 * Offsets are in the new document after that input; the caller retains the
 * user's original selection before this separator. Planning uses only a
 * UTF-16 length, so pasting a large block does not copy its entire text.
 */
export function planEmptyClosedContainerSeparator(
  block: EmptyClosedContainer,
  insertedUtf16Length: number,
): EmptyClosedContainerSeparator | undefined {
  if (!Number.isSafeInteger(insertedUtf16Length) || insertedUtf16Length <= 0) return undefined;
  const end = block.position + insertedUtf16Length;
  if (!Number.isSafeInteger(end)) return undefined;
  return {
    from: end,
    to: end,
    insert: "\n",
  };
}
