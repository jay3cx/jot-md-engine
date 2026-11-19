/** Match the bounded visual indentation used by both rendering hosts. */
export const MAX_LIST_DISPLAY_INDENT_COLUMNS = 48;
export const DEFAULT_LIST_MIN_CONTENT_WIDTH = 64;

export function listDisplayIndentColumns(columns: number): number {
  return Math.min(MAX_LIST_DISPLAY_INDENT_COLUMNS, Math.max(0, columns));
}

/** CSS percentages remain relative to the current host width. */
export function listDisplayIndentCss(columns: number, markerColumns: number): string {
  return `min(${listDisplayIndentColumns(columns)}ch, max(0px, calc(100% - ` +
    `max(var(--jot-list-indent), calc(${Math.max(0, markerColumns)}ch + .5em)) - ` +
    `var(--jot-list-min-content, ${DEFAULT_LIST_MIN_CONTENT_WIDTH}px))))`;
}
