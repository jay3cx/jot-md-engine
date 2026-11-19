import type { ComponentProjectionAdapter } from "../../contracts.js";
import type { TableComponentModel } from "../model.js";

/**
 * Table 的结构详情预算。Preview 由 TableGrid 自己按可见行/列请求；Live Preview
 * 在 Host 中以受限 around-range 请求当前可见行/cell，不能由通用 detail depth 全表展开；
 * 只有小表格的 PreText 值得一次性拿到 inline cell 语义文本。
 */
export const tableProjectionAdapter: ComponentProjectionAdapter<TableComponentModel> = {
  detailDepth(model, consumer) {
    if (model.kind !== "table") return 0;
    return consumer === "pretext" && model.node.childCount <= 64 ? 4 : 0;
  },
};
