import { validateEditorLayoutStyle, type EditorLayoutStyle } from "../layout/pretext/options.js";

/** 宿主可设置的颜色。设置为 null 时删除该项行内值，恢复 CSS 层叠。 */
export interface EditorThemeColors {
  readonly background?: string | null;
  readonly text?: string | null;
  readonly codeBackground?: string | null;
  readonly muted?: string | null;
  readonly link?: string | null;
  readonly quote?: string | null;
  readonly quoteBackground?: string | null;
  readonly quoteBorder?: string | null;
  readonly searchMatch?: string | null;
  readonly searchCurrent?: string | null;
  readonly selection?: string | null;
}

/** 编辑器各模式共用的外观和几何设置。 */
export interface EditorTheme {
  readonly colors?: EditorThemeColors;
  readonly layout?: EditorLayoutStyle;
}

const colorVariables: Record<keyof EditorThemeColors, string> = {
  background: "--jot-background",
  text: "--jot-text-color",
  codeBackground: "--jot-code-background",
  muted: "--jot-muted-color",
  link: "--jot-link-color",
  quote: "--jot-quote-color",
  quoteBackground: "--jot-quote-background",
  quoteBorder: "--jot-quote-border",
  searchMatch: "--jot-search-match",
  searchCurrent: "--jot-search-match-selected",
  selection: "--jot-selection-background",
};

/** 先完整校验本次更新，避免应用到一半才发现颜色或布局值无效。 */
export function validateEditorTheme(root: HTMLElement, theme: EditorTheme): void {
  if (theme.layout !== undefined) validateEditorLayoutStyle(theme.layout);
  for (const [name, value] of Object.entries(theme.colors ?? {})) {
    if (!Object.hasOwn(colorVariables, name)) throw new RangeError(`Unknown theme color: ${name}`);
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a CSS color`);
    const css = root.ownerDocument.defaultView?.CSS;
    if (css !== undefined && !css.supports("color", value)) throw new RangeError(`Invalid CSS color: ${name}`);
  }
}

export function applyEditorThemeColors(root: HTMLElement, colors: EditorThemeColors | undefined): void {
  if (colors === undefined) return;
  for (const [name, value] of Object.entries(colors)) {
    if (value === undefined) continue;
    const property = colorVariables[name as keyof EditorThemeColors];
    if (value === null) root.style.removeProperty(property);
    else root.style.setProperty(property, value);
  }
}
