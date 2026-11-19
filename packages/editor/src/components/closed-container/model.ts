import type { RenderNode, TextRange } from "@jot-md/editor-protocol";
import { booleanAttribute, rangeAttribute } from "../common/dom-renderer.js";
import type { MarkdownComponentModel } from "../contracts.js";

export type ClosedContainerKind = "fenced-code" | "math-block";

export interface ClosedContainerModel extends MarkdownComponentModel {
  readonly kind: ClosedContainerKind;
  readonly openingRange: TextRange;
  readonly contentRange: TextRange;
  readonly closingRange: TextRange;
}

/** Only Rust-confirmed, fully closed blocks get a protected editing surface. */
export function createClosedContainerModel(
  node: RenderNode,
): ClosedContainerModel | undefined {
  if (node.kind !== "fenced-code" && node.kind !== "math-block") return undefined;
  if (booleanAttribute(node, "closed") !== true) return undefined;
  const openingRange = rangeAttribute(node, "openingRange");
  const contentRange = rangeAttribute(node, "contentRange");
  const closingRange = rangeAttribute(node, "closingRange");
  if (
    openingRange === undefined || contentRange === undefined || closingRange === undefined ||
    Number(node.sourceRange.from) > Number(openingRange.from) ||
    Number(openingRange.to) > Number(contentRange.from) ||
    Number(contentRange.to) > Number(closingRange.from) ||
    Number(closingRange.to) > Number(node.sourceRange.to)
  ) {
    return undefined;
  }
  return {
    id: node.id,
    kind: node.kind,
    sourceRange: node.sourceRange,
    contentVersion: node.contentVersion,
    node,
    openingRange,
    contentRange,
    closingRange,
  };
}
