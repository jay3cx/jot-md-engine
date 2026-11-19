import type { RenderNode } from "@jot-md/editor-protocol";
import { componentProjectionDepth } from "../../../components/projection.js";

/** Preview 的通用 Markdown 详情预算，特化组件可通过 Registry 覆盖。 */
export function previewDetailDepth(node: RenderNode): number {
  return componentProjectionDepth(node, "preview") ?? defaultDetailDepth(node);
}

/** PreText 可对小型语义容器取得更多内容，用于更准确的初始高度估算。 */
export function preTextDetailDepth(node: RenderNode): number {
  return componentProjectionDepth(node, "pretext") ?? defaultDetailDepth(node);
}

function defaultDetailDepth(node: RenderNode): number {
  if (node.childCount === 0) return 0;
  if (node.childCount <= 64 && [
    "paragraph",
    "heading",
    "list-item",
  ].includes(node.kind)) return 4;
  // BlockQuote 可能是大型虚拟容器。只有小引用允许内联展开；大型引用必须
  // 保持自己的稀疏子轴。
  return node.kind === "block-quote" && node.childCount <= 16 ? 4 : 0;
}
