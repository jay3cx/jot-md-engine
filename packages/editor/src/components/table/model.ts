import type { RenderNode, TextRange } from "@jot-md/editor-protocol";
import { stringsAttribute } from "../common/dom-renderer.js";
import {
  tableLayoutEvidenceFromNode,
  type TableLayoutEvidence,
} from "./layout.js";
import type { MarkdownComponentModel } from "../contracts.js";

export type TableNodeKind = "table" | "table-row" | "table-cell";

export interface TableComponentModel extends MarkdownComponentModel {
  readonly kind: TableNodeKind;
  readonly sourceRange: TextRange;
  readonly columnCount: number;
  readonly alignments: readonly string[];
  /** 只有 table 根节点携带完整 Rust 布局摘要。 */
  readonly layoutEvidence: TableLayoutEvidence | undefined;
}

export function createTableComponentModel(node: RenderNode): TableComponentModel | undefined {
  if (!isTableNode(node)) return undefined;
  const alignments = node.kind === "table" ? stringsAttribute(node, "alignments") : [];
  return {
    id: node.id,
    kind: node.kind,
    sourceRange: node.sourceRange,
    contentVersion: node.contentVersion,
    node,
    columnCount: node.kind === "table" ? alignments.length : node.childCount,
    alignments,
    layoutEvidence: node.kind === "table" ? tableLayoutEvidenceFromNode(node) : undefined,
  };
}

export function isTableNode(node: RenderNode): node is RenderNode & { readonly kind: TableNodeKind } {
  return node.kind === "table" || node.kind === "table-row" || node.kind === "table-cell";
}
