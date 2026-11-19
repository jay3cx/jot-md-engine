import type {
  ComponentPreTextAdapter,
  ComponentPreTextContext,
} from "../../contracts.js";
import type { TableComponentModel } from "../model.js";
import {
  estimateTablePreText,
  type TablePreTextContext,
  type TablePreTextEstimate,
} from "../pretext.js";

/** 组件契约到 Table 预布局实现的窄适配器。 */
export const tablePreTextAdapter: ComponentPreTextAdapter<TableComponentModel> = {
  estimate(model, context) {
    if (model.kind !== "table" || !isTablePreTextContext(context)) return undefined;
    return estimateTablePreText(model.node, context);
  },
};

function isTablePreTextContext(context: ComponentPreTextContext): context is TablePreTextContext {
  const candidate = context as Partial<TablePreTextContext>;
  return candidate.sourceStats !== undefined &&
    typeof candidate.sourceStats.preview === "string" &&
    typeof candidate.semanticText === "function" &&
    candidate.metrics !== undefined;
}

export type { TablePreTextEstimate };
