import type { MarkdownComponentDefinition } from "../contracts.js";
import { planTableLivePreview } from "./adapters/live-preview.js";
import { tableInteractionAdapter } from "./adapters/interaction.js";
import { tablePreTextAdapter } from "./adapters/pretext.js";
import { tablePreviewAdapter } from "./adapters/preview.js";
import { tableProjectionAdapter } from "./adapters/projection.js";
import { createTableComponentModel, type TableComponentModel } from "./model.js";

/**
 * 表格的唯一能力声明。Preview、PreText、输入命令和 Live Preview 都必须从
 * 这个组件身份与模型出发，不能在宿主内重新识别 Markdown table。
 */
export const tableComponentDefinition: MarkdownComponentDefinition<TableComponentModel> = {
  id: "markdown-table",
  schemaVersion: 1,
  nodeKinds: ["table", "table-row", "table-cell"],
  createModel: createTableComponentModel,
  capabilities: {
    preview: tablePreviewAdapter,
    pretext: tablePreTextAdapter,
    livePreview: { plan: planTableLivePreview },
    projection: tableProjectionAdapter,
    interaction: tableInteractionAdapter,
    inspect: true,
  },
};
