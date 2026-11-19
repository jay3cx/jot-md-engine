import type { RenderNode, Utf16Offset } from "../../../../editor-protocol/src/index.js";

export function renderNode(
  kind: string,
  content: RenderNode["content"],
  attributes: RenderNode["attributes"] = [],
): RenderNode {
  return {
    id: `${kind}-1`,
    kind,
    sourceRange: { from: 0 as Utf16Offset, to: 4 as Utf16Offset },
    contentVersion: 0,
    mode: "preview",
    childCount: content.type === "structured" ? content.children.length : 0,
    attributes,
    content,
  };
}
