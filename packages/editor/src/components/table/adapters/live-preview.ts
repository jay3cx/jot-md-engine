import type {
  ComponentLivePreviewContext,
  ComponentLivePreviewPlan,
} from "../../contracts.js";
import type { TableComponentModel } from "../model.js";

/**
 * Rust 已确认的 table 根节点直接映射为共享 RenderRuntime 的表格 DOM。
 * 表格结构、列宽、行虚拟化和 cell DOM 全部由 Preview 的 TableGrid 负责；
 * Live Preview 只声明替换范围和交互入口。
 */
export function planTableLivePreview(
  model: TableComponentModel,
  context: ComponentLivePreviewContext,
): ComponentLivePreviewPlan {
  if (model.kind !== "table" || model.node.mode === "source") {
    return sourceFallbackPlan();
  }
  const from = Number(model.sourceRange.from);
  const rawTo = Number(model.sourceRange.to);
  // 表格后的换行属于 CodeMirror 的物理行轴，不属于 table RenderNode。
  const to = rawTo;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) {
    return sourceFallbackPlan();
  }
  const estimatedHeight = context.estimateBlockHeight?.(model.node);
  return {
    handlesSelection: true,
    visitChildren: false,
    decorations: [{
      type: "replace",
      from,
      to,
      nodeId: model.id,
      widget: {
        kind: "table",
        node: model.node,
        block: true,
        selection: "mapped",
        // TableGrid owns the row/cell update boundary. Keep the outer
        // CodeMirror widget/HeightMap identity across ordinary cell edits;
        // RenderRuntime forwards the confirmed RenderNode to the mounted grid.
        // Otherwise a changed PreText estimate would transiently reset the
        // whole table block before browser measurement can preserve its rows.
        inPlaceUpdate: true,
        ...(estimatedHeight === undefined
          ? {}
          : { estimatedHeight }),
      },
    }],
    fallbackBlocks: 0,
  };
}

function sourceFallbackPlan(): ComponentLivePreviewPlan {
  return {
    lineClasses: ["jot-live-preview-line"],
    fallbackBlocks: 1,
    visitChildren: false,
  };
}
