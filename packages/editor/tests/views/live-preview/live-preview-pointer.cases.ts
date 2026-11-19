import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  domRangeForSourceOffset,
  readDomSourceRange,
  sourceOffsetAtPoint,
} from "../../../src/components/common/dom-position.js";
import {
  beginLivePreviewPointerSelection,
  cancelLivePreviewPointerSelection,
  captureRepeatedPreviewPointerSelection,
  previewPointerRange,
} from "../../../src/hosts/live-preview/pointer-selection.js";

export function livePreviewPointerRegression(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Node");
  const filterDescriptor = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
  Object.defineProperty(globalThis, "Node", { configurable: true, value: { TEXT_NODE: 3 } });
  Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: { SHOW_TEXT: 4 } });
  try {
    source_anchors_require_present_attributes_and_respect_the_cell_range();
    opaque_math_never_maps_glyph_offsets_to_tex();
    inline_code_uses_confirmed_content_ranges_instead_of_tick_offsets();
    caret_mapping_accounts_for_multiple_text_leaves();
    hidden_delimiters_map_to_nearest_visible_text_boundary();
    pointer_selection_keeps_shift_words_cells_and_drag_ranges();
    pointer_cleanup_and_repeated_opaque_clicks_keep_the_source_selection();
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "Node");
    else Object.defineProperty(globalThis, "Node", descriptor);
    if (filterDescriptor === undefined) Reflect.deleteProperty(globalThis, "NodeFilter");
    else Object.defineProperty(globalThis, "NodeFilter", filterDescriptor);
  }
}

function hidden_delimiters_map_to_nearest_visible_text_boundary(): void {
  const document = new TestDocument();
  const cell = document.element(0, 8);
  const first = document.element(0, 1);
  const firstText = document.text("a");
  first.append(firstText);
  const strong = document.element(1, 7);
  const leaf = document.element(3, 5);
  const text = document.text("bc");
  leaf.append(text);
  strong.append(leaf);
  const last = document.element(7, 8);
  const lastText = document.text("d");
  last.append(lastText);
  cell.append(first, strong, last);
  const opening = domRangeForSourceOffset(cell as unknown as HTMLElement, 2) as unknown as TestRange;
  equal(opening.startContainer, firstText, "hidden opening delimiter stays by the preceding text edge");
  equal(opening.startOffset, 1, "hidden opening delimiter uses that edge");
  const closing = domRangeForSourceOffset(cell as unknown as HTMLElement, 6) as unknown as TestRange;
  equal(closing.startContainer, text, "hidden closing delimiter stays by the formatted text edge");
  equal(closing.startOffset, 2, "hidden closing delimiter uses that edge");
}

function source_anchors_require_present_attributes_and_respect_the_cell_range(): void {
  const document = new TestDocument();
  const cell = document.element(58, 68);
  const span = document.element();
  const text = document.text("cell-value");
  cell.append(span);
  span.append(text);
  document.caret = { offsetNode: text, offset: 4 };
  equal(readDomSourceRange(span as unknown as Element), undefined, "unmarked span has no source range");
  equal(sourceOffsetAtPoint(cell as unknown as HTMLElement, 10, 10, { from: 58, to: 68 }), 62,
    "nested unmarked spans must not send table clicks to document zero");
  span.attributes.set("data-jot-source-from", "0");
  span.attributes.set("data-jot-source-to", "10");
  equal(sourceOffsetAtPoint(cell as unknown as HTMLElement, 10, 10, { from: 58, to: 68 }), 58,
    "even a discovered child anchor cannot escape the caller's semantic cell");
  span.attributes.set("data-jot-source-from", "");
  equal(readDomSourceRange(span as unknown as Element), undefined, "empty attributes are not zero");
  span.attributes.set("data-jot-source-from", "-1");
  equal(readDomSourceRange(span as unknown as Element), undefined, "negative positions are invalid");
  equal(readDomSourceRange(document.element(0, 0) as unknown as Element)?.from, 0, "explicit zero is valid");
}

function opaque_math_never_maps_glyph_offsets_to_tex(): void {
  const document = new TestDocument();
  const cell = document.element(58, 68);
  const math = document.element(60, 66);
  math.attributes.set("data-jot-kind", "inline-math");
  const glyph = document.text("xxxxxx");
  math.append(glyph);
  cell.append(math);
  document.caret = { offsetNode: glyph, offset: 2 };
  equal(sourceOffsetAtPoint(cell as unknown as HTMLElement, 10, 10, { from: 58, to: 68 }), 60,
    "even equal-length glyph and TeX text are opaque");
  equal(sourceOffsetAtPoint(cell as unknown as HTMLElement, 90, 10, { from: 58, to: 68 }), 66,
    "opaque right edge maps to the semantic end");
}

function caret_mapping_accounts_for_multiple_text_leaves(): void {
  const document = new TestDocument();
  const cell = document.element(58, 68);
  const span = document.element();
  const first = document.text("cell-");
  const second = document.text("value");
  span.append(first, second);
  cell.append(span);
  const range = domRangeForSourceOffset(cell as unknown as HTMLElement, 65) as unknown as TestRange;
  equal(range.startContainer, second, "the caret must use the second text leaf");
  equal(range.startOffset, 2, "the offset is local to its actual text leaf");
}

function inline_code_uses_confirmed_content_ranges_instead_of_tick_offsets(): void {
  const document = new TestDocument();
  const cell = document.element(58, 68);
  const code = document.element(59, 67);
  code.attributes.set("data-jot-kind", "inline-code");
  code.attributes.set("data-jot-source-content-from", "61");
  code.attributes.set("data-jot-source-content-to", "65");
  const text = document.text("code");
  code.append(text);
  cell.append(code);
  document.caret = { offsetNode: text, offset: 2 };
  equal(sourceOffsetAtPoint(cell as unknown as HTMLElement, 10, 10, { from: 58, to: 68 }), 63,
    "inline code clicks map into content after the exact Rust-confirmed tick run");
  const range = domRangeForSourceOffset(cell as unknown as HTMLElement, 64) as unknown as TestRange;
  equal(range.startContainer, text, "inline-code caret uses its content text");
  equal(range.startOffset, 3, "inline-code caret excludes opening ticks");
  code.attributes.set("data-jot-source-content-from", "0");
  code.attributes.set("data-jot-source-content-to", "4");
  equal(sourceOffsetAtPoint(cell as unknown as HTMLElement, 10, 10, { from: 58, to: 68 }), 59,
    "an escaped content range is rejected instead of mapping outside its owner");
}

function pointer_selection_keeps_shift_words_cells_and_drag_ranges(): void {
  const { view, document, element } = testView("alpha beta gamma");
  view.dispatch({ selection: { anchor: 1 } });
  beginLivePreviewPointerSelection(view, mouse({ shiftKey: true }), {
    element, range: { from: 0, to: 16 }, offset: 8,
  });
  equal(view.state.selection.main.anchor, 1, "Shift-click preserves the existing anchor");
  equal(view.state.selection.main.head, 8, "Shift-click extends to the hit point");
  beginLivePreviewPointerSelection(view, mouse({ detail: 2 }), {
    element, range: { from: 0, to: 16 }, offset: 8,
  });
  equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "beta", "double click selects a word");
  document.emit("mousemove", mouse({ clientX: 0, clientY: 8, buttons: 1 }));
  equal(view.state.selection.main.anchor, 10, "backward word dragging retains the initial word end");
  equal(view.state.selection.main.head, 0, "backward word dragging extends to the previous word start");
  document.emit("mouseup", mouse());
  beginLivePreviewPointerSelection(view, mouse({ detail: 3 }), {
    element, range: { from: 6, to: 10 }, offset: 8, lineRange: { from: 6, to: 10 },
  });
  equal(view.state.selection.main.from, 6, "cell triple click excludes its opening pipe");
  equal(view.state.selection.main.to, 10, "cell triple click excludes its closing pipe");
  cancelLivePreviewPointerSelection(view);
  const unicode = EditorState.create({ doc: "hello 😀 world\nnext" });
  equal(previewPointerRange(unicode, 10, 2).from, 9, "word selection follows UTF-16 positions after emoji");
  equal(previewPointerRange(unicode, 10, 3).to, 15, "line selection includes the physical line ending");
  const readOnly = testView("A😀BC", true);
  beginLivePreviewPointerSelection(readOnly.view, mouse(), {
    element: readOnly.element, range: { from: 0, to: 5 }, offset: 2,
  });
  equal(readOnly.view.state.selection.main.head, 3, "pointer offsets cannot split a surrogate pair");
  equal(readOnly.view.state.doc.toString(), "A😀BC", "read-only pointer gestures change only selection");
  cancelLivePreviewPointerSelection(readOnly.view);
}

function pointer_cleanup_and_repeated_opaque_clicks_keep_the_source_selection(): void {
  const { view, document, element } = testView("before $x$ after");
  beginLivePreviewPointerSelection(view, mouse({ timeStamp: 10 }), {
    element, range: { from: 8, to: 9 }, offset: 8, opaque: { from: 7, to: 10 },
  });
  document.emit("mouseup", mouse());
  equal(document.listenerCount, 0, "mouse release removes all document gesture listeners");
  const captured = captureRepeatedPreviewPointerSelection(view, mouse({
    detail: 2, timeStamp: 20, target: element,
  }));
  equal(captured, true, "an opaque second click survives the first-click source reveal");
  equal(view.state.selection.main.from, 7, "opaque double click starts at its semantic source boundary");
  equal(view.state.selection.main.to, 10, "opaque double click ends at its semantic source boundary");
  cancelLivePreviewPointerSelection(view, element);
  // Repeated-click handling binds the origin to contentDOM, which is the same
  // element here. Destroying it must remove all retained gesture listeners.
  equal(document.listenerCount, 0, "destroy cancels the active gesture");
  document.emit("mousemove", mouse({ clientX: 14, buttons: 1 }));
  equal(view.state.selection.main.to, 10, "disposed gestures cannot change selection");
  cancelLivePreviewPointerSelection(view);
}

function testView(source: string, readOnly = false): { view: EditorView; document: TestDocument; element: HTMLElement } {
  const document = new TestDocument();
  const element = document.element();
  const view = {
    state: EditorState.create({ doc: source, extensions: [EditorState.readOnly.of(readOnly)] }),
    dom: element,
    contentDOM: element,
    scrollDOM: { scrollTop: 0, scrollLeft: 0, scrollHeight: 100, clientHeight: 50 },
    documentPadding: { top: 0 },
    lineBlockAtHeight: () => ({ from: 0, top: 0 }),
    lineBlockAt: () => ({ from: 0, top: 0 }),
    focus: () => {},
    posAtCoords: ({ x }: { x: number }) => Math.max(0, Math.min(source.length, Math.floor(x))),
    dispatch: (spec: Parameters<EditorState["update"]>[0]) => { view.state = view.state.update(spec).state; },
  };
  return { view: view as unknown as EditorView, document, element: element as unknown as HTMLElement };
}

function mouse(options: Partial<MouseEvent> = {}): MouseEvent {
  return { button: 0, detail: 1, clientX: 8, clientY: 8, buttons: 1, timeStamp: 1,
    preventDefault() {}, stopPropagation() {}, ...options } as MouseEvent;
}

class TestDocument {
  readonly defaultView = undefined;
  caret: { offsetNode: TestNode; offset: number } | null = null;
  readonly listeners = new Map<string, Set<(event: MouseEvent) => void>>();
  element(from?: number, to?: number): TestElement {
    const element = new TestElement(this);
    if (from !== undefined) element.attributes.set("data-jot-source-from", String(from));
    if (to !== undefined) element.attributes.set("data-jot-source-to", String(to));
    return element;
  }
  text(text: string): TestText { return new TestText(text); }
  caretPositionFromPoint() { return this.caret; }
  elementFromPoint(): null { return null; }
  createRange(): TestRange { return new TestRange(); }
  createTreeWalker(root: TestNode) {
    const text: TestText[] = [];
    const collect = (node: TestNode) => {
      if (node.nodeType === 3) text.push(node as TestText);
      else node.childNodes.forEach(collect);
    };
    root.childNodes.forEach(collect);
    let index = 0;
    return { nextNode: () => text[index++] ?? null };
  }
  addEventListener(name: string, listener: (event: MouseEvent) => void): void {
    const callbacks = this.listeners.get(name) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(name, callbacks);
  }
  removeEventListener(name: string, listener: (event: MouseEvent) => void): void { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: MouseEvent): void { [...(this.listeners.get(name) ?? [])].forEach(callback => callback(event)); }
  get listenerCount(): number { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
}

type TestNode = TestElement | TestText;
class TestElement {
  readonly nodeType = 1;
  readonly childNodes: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  parentElement: TestElement | null = null;
  constructor(readonly ownerDocument: TestDocument) {}
  get textContent(): string { return this.childNodes.map(child => child.textContent).join(""); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  closest(): null { return null; }
  querySelectorAll(): TestElement[] { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20, bottom: 20 }; }
  contains(node: TestNode): boolean { return node === this || this.childNodes.some(child => child === node || child.nodeType === 1 && (child as TestElement).contains(node)); }
  append(...children: TestNode[]): void {
    children.forEach(child => { child.parentElement = this; this.childNodes.push(child); });
  }
}

class TestText {
  readonly nodeType = 3;
  readonly childNodes: TestNode[] = [];
  parentElement: TestElement | null = null;
  constructor(readonly data: string) {}
  get textContent(): string { return this.data; }
}

class TestRange {
  startContainer: TestNode | undefined;
  startOffset = 0;
  setStart(node: TestNode, offset: number): void { this.startContainer = node; this.startOffset = offset; }
  selectNodeContents(node: TestNode): void { this.startContainer = node; }
  collapse(): void {}
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}
