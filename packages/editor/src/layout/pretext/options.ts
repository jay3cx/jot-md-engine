import type {
  PreTextProjectionFilterOptions,
  PreTextStyleMetrics,
} from "./filter.js";

/** Preview 与 Live Preview 共用的 PreText 配置，不依赖任何具体 Surface。 */
export interface PreTextOptions extends PreTextProjectionFilterOptions {
  readonly metrics?: Partial<PreTextStyleMetrics>;
  readonly maxSourcePreviewUtf16?: number;
  readonly averageCharacterWidth?: number;
  readonly tabSize?: number;
  readonly widthBucketSize?: number;
  readonly typographyVersion?: string;
}

/** 宿主可设置的排版参数，由 DOM 样式和两种预览的估算路径共同使用。 */
export interface EditorLayoutStyle {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly letterSpacing?: number;
  /** wrap 在块内折行。scroll 保留物理行宽，由块自身横向滚动。 */
  readonly codeBlockWrap?: "wrap" | "scroll";
  readonly metrics?: Partial<PreTextStyleMetrics>;
}

export function validateEditorLayoutStyle(style: EditorLayoutStyle): void {
  if (style.fontSize !== undefined && (!Number.isFinite(style.fontSize) || style.fontSize <= 0)) {
    throw new RangeError("fontSize must be positive");
  }
  if (style.letterSpacing !== undefined && !Number.isFinite(style.letterSpacing)) {
    throw new RangeError("letterSpacing must be finite");
  }
  if (style.codeBlockWrap !== undefined && style.codeBlockWrap !== "wrap" && style.codeBlockWrap !== "scroll") {
    throw new RangeError("codeBlockWrap must be wrap or scroll");
  }
  for (const [name, value] of Object.entries(style.metrics ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((metric) => typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)) {
      throw new RangeError(`${name} must contain finite non-negative metrics`);
    }
    if (name === "headingLineHeights" && (!Array.isArray(value) || value.length !== 6)) {
      throw new RangeError("headingLineHeights must contain six metrics");
    }
  }
}

export function applyEditorTypography(target: HTMLElement, style: EditorLayoutStyle): void {
  validateEditorLayoutStyle(style);
  if (style.fontFamily !== undefined) target.style.fontFamily = style.fontFamily;
  if (style.fontSize !== undefined) target.style.fontSize = `${style.fontSize}px`;
  if (style.letterSpacing !== undefined) target.style.letterSpacing = `${style.letterSpacing}px`;
  if (style.codeBlockWrap !== undefined) target.dataset["jotCodeWrap"] = style.codeBlockWrap;
}
