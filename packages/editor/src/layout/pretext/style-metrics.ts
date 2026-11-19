import {
  mergePreTextStyleMetrics,
  type PreTextStyleMetrics,
} from "./filter.js";
import { DEFAULT_QUOTE_MIN_CONTENT_WIDTH } from "../quote-geometry.js";
import { DEFAULT_LIST_MIN_CONTENT_WIDTH } from "../list-geometry.js";

/**
 * 把 PreText 的几何指标写成 Preview / Live Preview 共用的 CSS 变量。
 *
 * 这是高度契约的唯一 DOM 出口：只要某项指标参与 PreText estimate，真实
 * Preview CSS 和 Live Preview 的 source shell 就必须消费同名变量。新增会改变
 * 几何的样式时，必须同时扩展 `PreTextStyleMetrics`、本函数和共享 CSS。
 */
export function applyPreTextStyleMetrics(
  target: HTMLElement,
  overrides: Partial<PreTextStyleMetrics> | undefined,
): PreTextStyleMetrics {
  const fontSize = Number.parseFloat(target.ownerDocument?.defaultView?.getComputedStyle(target).fontSize ?? "");
  const metrics = mergePreTextStyleMetrics(overrides, fontSize);
  const style = target.style;
  style.setProperty("--jot-image-fallback-height", `${metrics.imageFallbackHeight}px`);
  style.setProperty("--jot-image-max-height", `${metrics.imageMaxHeight}px`);
  style.setProperty("--jot-block-gap-half", `${metrics.blockGap / 2}px`);
  style.setProperty("--jot-live-preview-block-gap", `${metrics.blockGap}px`);
  style.setProperty("--jot-boundary-width", `${metrics.boundaryWidth}px`);
  style.setProperty("--jot-paragraph-line-height", `${metrics.paragraphLineHeight}px`);
  style.setProperty("--jot-paragraph-padding-x", `${metrics.paragraphPaddingX}px`);
  style.setProperty("--jot-quote-padding-y", `${metrics.quotePaddingY}px`);
  style.setProperty("--jot-quote-padding-x", `${metrics.quotePaddingX}px`);
  style.setProperty("--jot-quote-min-content", `${Math.max(0, metrics.quoteMinContentWidth ?? DEFAULT_QUOTE_MIN_CONTENT_WIDTH)}px`);
  style.setProperty("--jot-list-indent", `${metrics.listIndent}px`);
  style.setProperty("--jot-list-min-content", `${Math.max(0, metrics.listMinContentWidth ?? DEFAULT_LIST_MIN_CONTENT_WIDTH)}px`);
  style.setProperty("--jot-code-line-height", `${metrics.codeLineHeight}px`);
  style.setProperty("--jot-code-padding-half", `${metrics.codePaddingY / 2}px`);
  style.setProperty("--jot-table-header-height", `${metrics.tableHeaderHeight}px`);
  style.setProperty("--jot-table-row-height", `${metrics.tableRowHeight}px`);
  style.setProperty("--jot-table-toolbar-height", `${metrics.tableToolbarHeight}px`);
  style.setProperty("--jot-table-frame", `${metrics.tableFrame}px`);
  style.setProperty("--jot-table-frame-half", `${metrics.tableFrame / 2}px`);
  style.setProperty("--jot-math-line-height", `${metrics.mathLineHeight}px`);
  style.setProperty("--jot-math-padding-half", `${metrics.mathPaddingY / 2}px`);
  style.setProperty("--jot-thematic-height", `${metrics.thematicHeight}px`);
  style.setProperty("--jot-blank-line-height", `${metrics.blankLineHeight}px`);
  metrics.headingLineHeights.forEach((height, index) => {
    style.setProperty(`--jot-heading-${index + 1}-line-height`, `${height}px`);
  });
  return metrics;
}
