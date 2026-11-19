import type { RenderNode } from "@jot-md/editor-protocol";
import type { ComponentProjectionConsumer } from "./contracts.js";
import { defaultMarkdownComponentRegistry } from "./registry.js";

/**
 * 查询组件对 structured children 的投影深度要求。此函数不访问 DOM、Session 或
 * ProjectionStore；它只把已确认的 RenderNode 路由到组件能力。
 */
export function componentProjectionDepth(
  node: RenderNode,
  consumer: ComponentProjectionConsumer,
): number | undefined {
  const definition = defaultMarkdownComponentRegistry.resolve(node);
  const model = definition?.createModel(node);
  return model === undefined
    ? undefined
    : definition?.capabilities.projection?.detailDepth(model, consumer);
}
