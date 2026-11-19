import type { RenderNode, TextRange } from "@jot-md/editor-protocol";

/**
 * Preview 与 Live Preview 共同使用的表格行 DOM 契约。
 *
 * 两个宿主的差异只在行如何进入 DOM：Preview 交给二维虚拟列表，Live Preview
 * 交给 CodeMirror widget。行、cell 的语义属性和几何 class 必须从这里统一生成，
 * 否则两个宿主即使使用同一份 Rust projection，也会出现两套视觉实现。
 */
export interface TableRowDomOptions {
  readonly id: string;
  readonly kind: string;
  readonly sourceRange: TextRange;
  readonly contentVersion: number;
  readonly header: boolean;
  readonly ariaRowIndex: number;
  readonly className?: string;
}

export interface TableCellDomOptions {
  readonly index: number;
  readonly header: boolean;
  readonly width?: number;
  readonly alignment?: string | undefined;
  readonly empty?: boolean;
  readonly className?: string;
}

export function createTableRowElement(
  document: Document,
  options: TableRowDomOptions,
): HTMLElement {
  const element = document.createElement("div");
  configureTableRowElement(element, options);
  return element;
}

export function configureTableRowElement(
  element: HTMLElement,
  options: TableRowDomOptions,
): void {
  setClass(element, "jot-table-row", true);
  if (options.className !== undefined) setClass(element, options.className, true);
  setClass(element, "jot-table-row--header", options.header);
  setAttribute(element, "role", "row");
  setAttribute(element, "aria-rowindex", String(options.ariaRowIndex));
  setDataset(element, "jotNodeId", options.id);
  setDataset(element, "jotKind", options.kind);
  setDataset(element, "jotSourceFrom", String(options.sourceRange.from));
  setDataset(element, "jotSourceTo", String(options.sourceRange.to));
  setDataset(element, "jotContentVersion", String(options.contentVersion));
}

export function createTableCellElement(
  document: Document,
  options: TableCellDomOptions,
): HTMLElement {
  const element = document.createElement("div");
  configureTableCellElement(element, options);
  return element;
}

export function configureTableCellElement(
  element: HTMLElement,
  options: TableCellDomOptions,
): void {
  setClass(element, "jot-table-cell", true);
  if (options.className !== undefined) setClass(element, options.className, true);
  setClass(element, "jot-table-cell--empty", options.empty === true);
  setAttribute(element, "role", options.header ? "columnheader" : "cell");
  // 这是明确的可交互目标，不等同于通用 source anchor。Live Preview 的
  // widget 事件只跳过这种声明过的目标，避免所有语义节点都被误判为按钮。
  setDataset(element, "jotInteraction", "table-cell");
  setDataset(element, "jotColumnIndex", String(options.index));
  setAttribute(element, "aria-colindex", String(options.index + 1));
  if (options.width !== undefined && Number.isFinite(options.width)) {
    const width = `${Math.max(1, options.width)}px`;
    if (element.style.width !== width) element.style.width = width;
  }
  if (options.alignment !== undefined) {
    if (options.alignment === "none") {
      if (element.dataset["align"] !== undefined) delete element.dataset["align"];
    } else {
      setDataset(element, "align", options.alignment);
    }
  }
  if (options.empty === true) setAttribute(element, "aria-hidden", "true");
  else if (element.hasAttribute("aria-hidden")) element.removeAttribute("aria-hidden");
}

export function tableRowDomOptions(
  row: RenderNode,
  header: boolean,
  index: number,
  className?: string,
): TableRowDomOptions {
  return {
    id: row.id,
    kind: row.kind,
    sourceRange: row.sourceRange,
    contentVersion: row.contentVersion,
    header,
    ariaRowIndex: header ? 1 : index + 2,
    ...(className === undefined ? {} : { className }),
  };
}

function setClass(element: HTMLElement, className: string, present: boolean): void {
  if (element.classList.contains(className) === present) return;
  element.classList.toggle(className, present);
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setDataset(
  element: HTMLElement,
  name: keyof DOMStringMap,
  value: string,
): void {
  if (element.dataset[name] !== value) element.dataset[name] = value;
}
