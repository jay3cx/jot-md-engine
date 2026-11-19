import type { RenderNode, TextRange } from "@jot-md/editor-protocol";
import type {
  ComponentInteractionContext,
  ComponentInteractionRanges,
  ComponentInteractionSurface,
  MarkdownComponentModel,
} from "./contracts.js";
import { defaultMarkdownComponentRegistry } from "./registry.js";

/**
 * 从当前 revision 已加载的 RenderNode 物化组件交互面。
 *
 * 这里不认识 table、list 或其他 Markdown 语法；组件是否拥有一个范围、是否接管
 * descendants 都由 Registry 中的 adapter 决定。缺少 Projection 时不产生猜测
 * surface，调用方自然退回安全源码行为。
 */
export function componentInteractionSurfaces(
  nodes: readonly RenderNode[],
  context: ComponentInteractionContext,
): readonly ComponentInteractionSurface[] {
  const surfaces: ComponentInteractionSurface[] = [];
  const visited = new Set<string>();

  const visit = (node: RenderNode): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    const definition = defaultMarkdownComponentRegistry.resolve(node);
    const model = definition?.createModel(node);
    const adapter = definition?.capabilities.interaction;
    if (model !== undefined && adapter !== undefined) {
      const ranges = adapter.ranges(model, context);
      if (ranges !== undefined) {
        surfaces.push(surface(
          definition!.id,
          model,
          ranges,
          adapter.allowsEdit === undefined
            ? undefined
            : (edit, currentRanges) => adapter.allowsEdit!(edit, currentRanges, context),
          adapter.resolveDeletion === undefined
            ? undefined
            : (deletion, currentRanges) =>
              adapter.resolveDeletion!(model, deletion, currentRanges, context),
        ));
        if (ranges.ownsDescendants === true) return;
      }
    }

    if (node.content.type !== "structured") return;
    for (const child of node.content.children) visit(child);
  };

  for (const node of nodes) visit(node);
  return surfaces.sort((left, right) =>
    Number(left.sourceRange.from) - Number(right.sourceRange.from) ||
    Number(left.sourceRange.to) - Number(right.sourceRange.to) ||
    left.componentId.localeCompare(right.componentId));
}

function surface(
  componentId: string,
  model: MarkdownComponentModel,
  ranges: ComponentInteractionRanges,
  allowsEdit: ComponentInteractionSurface["allowsEdit"],
  resolveDeletion: ComponentInteractionSurface["resolveDeletion"],
): ComponentInteractionSurface {
  return {
    componentId,
    sourceRange: copyRange(model.sourceRange),
    editableRanges: ranges.editableRanges.map(copyRange),
    protectedRanges: ranges.protectedRanges.map(copyRange),
    commandRanges: ranges.commandRanges.map(copyRange),
    ...(ranges.navigationRanges === undefined
      ? {}
      : { navigationRanges: ranges.navigationRanges.map(copyRange) }),
    ...(allowsEdit === undefined ? {} : { allowsEdit }),
    ...(resolveDeletion === undefined ? {} : { resolveDeletion }),
  };
}

function copyRange(range: TextRange): TextRange {
  return { from: range.from, to: range.to };
}
