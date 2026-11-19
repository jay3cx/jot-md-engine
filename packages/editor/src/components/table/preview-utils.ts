import type { TableLayoutEvidence } from "./layout.js";
import { softWrapPreferredSample } from "./layout.js";
import { cssPixels } from "../common/render-utils.js";

/** 表格 Preview 专属的 DOM 测量与列窗口工具。 */
export function softWrapCellWidth(
  cell: HTMLElement,
  context: CanvasRenderingContext2D | null,
  minimum: number,
): number {
  const style = cell.ownerDocument.defaultView?.getComputedStyle(cell);
  const text = softWrapPreferredSample(cell.textContent ?? "");
  const padding = (style === undefined ? 0 :
    cssPixels(style.paddingInlineStart) + cssPixels(style.paddingInlineEnd) +
    cssPixels(style.borderInlineStartWidth) + cssPixels(style.borderInlineEndWidth));
  if (text.length === 0) return minimum;
  let measured = text.length * 7.5;
  if (context !== null) {
    const font = style?.font;
    if (font !== undefined && font !== "") context.font = font;
    measured = context.measureText(text).width;
  }
  return Math.max(minimum, Math.ceil(measured + padding));
}

/** 只测量行内 KaTeX，避免装饰或拖拽句柄参与列宽推导。 */
export function unbreakableInlineCellWidth(cell: HTMLElement, minimum: number): number {
  const style = cell.ownerDocument.defaultView?.getComputedStyle(cell);
  const padding = style === undefined ? 0 :
    cssPixels(style.paddingInlineStart) + cssPixels(style.paddingInlineEnd) +
    cssPixels(style.borderInlineStartWidth) + cssPixels(style.borderInlineEndWidth);
  let width = 0;
  for (const renderer of cell.querySelectorAll<HTMLElement>(".jot-katex-inline")) {
    width = Math.max(width, renderer.scrollWidth, renderer.getBoundingClientRect().width);
  }
  return width <= 0 ? minimum : Math.max(minimum, Math.ceil(width + padding));
}

export function tableLayoutEvidenceKey(evidence: TableLayoutEvidence | undefined): string {
  if (evidence === undefined) return "";
  return [
    evidence.rowCount ?? "",
    ...(evidence.totalDisplayColumns ?? []),
    "|",
    ...(evidence.maxDisplayColumns ?? []),
    "|",
    ...(evidence.maxUnbreakableColumns ?? []),
    "|",
    ...(evidence.nonEmptyCells ?? []),
    "|",
    ...(evidence.demandWeights ?? []),
  ].join(",");
}
