import type { TextRange } from "@jot-md/editor-protocol";
import type { ComponentInteractionAdapter } from "../contracts.js";
import type { ClosedContainerModel } from "./model.js";

/**
 * A closed code/math block exposes its opening line and semantic content to
 * ordinary CodeMirror edits. The joining line breaks and closing delimiter are
 * structural. A hidden opening can be revealed by moving up from the first
 * content line; editing it is an ordinary source edit and can change the
 * block's confirmed type on the next parse.
 */
export const closedContainerInteractionAdapter:
ComponentInteractionAdapter<ClosedContainerModel> = {
  ranges(model) {
    return {
      editableRanges: [copyRange(model.openingRange), copyRange(model.contentRange)],
      protectedRanges: [
        textRange(Number(model.sourceRange.from), Number(model.openingRange.from)),
        textRange(Number(model.openingRange.to), Number(model.contentRange.from)),
        textRange(Number(model.contentRange.to), Number(model.sourceRange.to)),
      ].filter((range) => Number(range.to) > Number(range.from)),
      commandRanges: [copyRange(model.sourceRange)],
      navigationRanges: [copyRange(model.openingRange), copyRange(model.contentRange)],
      ownsDescendants: true,
    };
  },
  resolveDeletion(model, deletion, _ranges, context) {
    const contentFrom = Number(model.contentRange.from);
    const contentTo = Number(model.contentRange.to);
    if (
      (deletion.direction === "backward" && deletion.position === contentFrom) ||
      (deletion.direction === "forward" && deletion.position === contentTo)
    ) {
      return {
        kind: "consume",
        anchor: deletion.direction === "backward" ? contentFrom : contentTo,
      };
    }

    const from = Number(model.sourceRange.from);
    const rawTo = Number(model.sourceRange.to);
    const to = ownBlockTerminatorEnd(context.source, from, rawTo);
    if (
      (deletion.direction === "forward" && deletion.position === from) ||
      (deletion.direction === "backward" && deletion.position === to)
    ) {
      return { kind: "delete-range", from, to };
    }
    return undefined;
  },
};

function ownBlockTerminatorEnd(source: string, from: number, rawTo: number): number {
  if (rawTo <= from || rawTo >= source.length) return rawTo;
  return source[rawTo - 1] === "\n" || source[rawTo] !== "\n"
    ? rawTo
    : rawTo + 1;
}

function copyRange(range: TextRange): TextRange {
  return { from: range.from, to: range.to };
}

function textRange(from: number, to: number): TextRange {
  return { from: from as TextRange["from"], to: to as TextRange["to"] };
}
