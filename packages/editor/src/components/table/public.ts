/** 表格交互的稳定公共入口；布局和 DOM 适配器仍属于内部实现。 */
export {
  TABLE_COMMAND,
  tableCommands,
  tableShortcuts,
  type TableCommandExecutor,
  type TableCommandId,
} from "./commands.js";
export {
  createTableToolbar,
  TABLE_TOOLBAR_ACTIONS,
  type TableToolbarOptions,
} from "./toolbar.js";
