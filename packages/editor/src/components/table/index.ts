export { tableComponentDefinition } from "./definition.js";
export {
  createTableComponentModel,
  isTableNode,
  type TableComponentModel,
  type TableNodeKind,
} from "./model.js";
export {
  replaceTableCell,
  serializeTableCell,
  clearTableCell,
  editTableColumn,
  deleteTableRow,
  insertTableRow,
  isTableDelimiterLine,
  tableAt,
  tableCellAt,
  tableCellTargetAt,
  tableBoundaryNavigationTarget,
  tableInRange,
  tableNavigationTarget,
  tableRootDeletionRange,
  resolveTableSurfaceNavigation,
  tableSurfacePositionAt,
  type TableCellRange,
  type TableCellTarget,
  type TableNavigationDirection,
  type TableBoundaryNavigationTarget,
  type TableSurfacePosition,
  type TableSurfaceNavigationDirection,
  type TableSurfaceNavigationTarget,
  type TableSourceModel,
  type TableSourceRow,
  type TableSourceRowRole,
  type TableRowCell,
} from "./source.js";
export {
  TABLE_COMMAND,
  TABLE_INTERACTION_COMMAND,
  tableLivePreviewCommand,
  tableCommands,
  tableShortcuts,
  type TableCommandExecutor,
  type TableCommandId,
  type TableInteractionCommandId,
  type TableLivePreviewKeyInput,
} from "./commands.js";
export {
  TableLayoutController,
  resolveTableColumnWidths,
  resolveTableLayoutOptions,
  softWrapPreferredSample,
  tableLayoutContextKey,
  tableLayoutEvidenceFromNode,
  type TableAutoWidthMode,
  type TableColumnResizeEvent,
  type TableColumnWidth,
  type TableLayoutEvidence,
  type TableLayoutMode,
  type TableLayoutOptions,
  type TableLayoutSnapshot,
} from "./layout.js";
export { TableGrid } from "./adapters/preview.js";
export {
  tableInteractionAdapter,
  tableRenderCellAt,
  tableRenderNavigation,
  tableRenderPositionAt,
  tableRenderRootAt,
  type TableRenderCellTarget,
  type TableRenderDirection,
  type TableRenderNavigation,
  type TableRenderPosition,
} from "./adapters/interaction.js";
export { tablePreTextAdapter } from "./adapters/pretext.js";
export { tableProjectionAdapter } from "./adapters/projection.js";
export {
  planTableLivePreview,
} from "./adapters/live-preview.js";
export type { TablePreviewComponent, TablePreviewHost } from "./preview-host.js";
export {
  createTableToolbar,
  TABLE_TOOLBAR_ACTIONS,
  type TableToolbarOptions,
} from "./toolbar.js";
export {
  softWrapCellWidth,
  tableLayoutEvidenceKey,
  unbreakableInlineCellWidth,
} from "./preview-utils.js";
export {
  estimateTablePreText,
  type TablePreTextContext,
  type TablePreTextEstimate,
  type TablePreTextMetrics,
  type TablePreTextSourceStats,
} from "./pretext.js";
