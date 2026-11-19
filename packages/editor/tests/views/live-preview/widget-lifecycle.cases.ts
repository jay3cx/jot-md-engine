import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RenderNode } from "../../../../editor-protocol/src/index.js";
import { LivePreviewWidget } from "../../../src/hosts/live-preview/widget.js";
import type { LivePreviewWidgetDescriptor } from "../../../src/hosts/live-preview/types.js";
import type { RenderRuntime } from "../../../src/render/runtime/dom-runtime.js";
import { renderNodeKey } from "../../../src/components/common/render-utils.js";

// A lifecycle test, not a browser geometry test. Retain the actual listeners
// installed by toDOM, then invoke them after CodeMirror-style DOM transfer.
export function widgetLifecycleRegression(): void {
  const element = new WidgetElement();
  let updates = 0;
  const runtime = {
    key: renderNodeKey,
    mount: (node: RenderNode) => {
      element.dataset["jotRenderKey"] = renderNodeKey(node);
      return element;
    },
    update: () => { updates += 1; },
    disposeSubtree: () => {},
  } as unknown as RenderRuntime;
  const view = {
    state: EditorState.create({ doc: "x".repeat(100) }),
    dom: element,
    scrollDOM: { scrollTop: 0, scrollLeft: 0, scrollHeight: 100, clientHeight: 50 },
    documentPadding: { top: 0 },
    lineBlockAtHeight: () => ({ from: 0, top: 0 }),
    lineBlockAt: () => ({ from: 0, top: 0 }),
    focus: () => {},
    requestMeasure: () => {},
    dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
      view.state = view.state.update(spec).state;
    },
  };
  const editorView = view as unknown as EditorView;
  let activated = "";
  const activate = (_view: EditorView, from: number, to: number) => {
    activated = `${from}:${to}`;
  };
  const descriptor = (from: number, version = 1): LivePreviewWidgetDescriptor => ({
    kind: "inline-math", block: false, estimatedHeight: 20,
    node: {
      id: "math", kind: "inline-math", contentVersion: version, mode: "preview",
      sourceRange: { from, to: from + 5 } as RenderNode["sourceRange"],
      childCount: 0, attributes: [], content: { type: "source" },
    },
  });
  const first = new LivePreviewWidget(10, 15, descriptor(10), runtime, activate);
  const changed = new LivePreviewWidget(10, 15, descriptor(10, 2), runtime, activate);
  if (first.eq(changed)) throw new Error("content update must reach updateDOM");
  const hydrated = new LivePreviewWidget(10, 15, {
    ...descriptor(10), node: { ...descriptor(10).node, content: { type: "structured", children: [] } },
  }, runtime, activate);
  if (first.eq(hydrated)) throw new Error("hydration must reach updateDOM");
  const dom = first.toDOM(editorView);
  if (!changed.updateDOM(dom) || updates !== 1) throw new Error("update must retain the DOM shell");

  const moved = new LivePreviewWidget(30, 35, descriptor(30, 2), runtime, activate);
  if (!moved.updateDOM(dom)) throw new Error("range shift must retain the DOM shell");
  element.click();
  if (activated !== "30:35" || view.state.selection.main.head !== 30) {
    throw new Error(`stale widget listener: ${activated}`);
  }
  const equivalent = new LivePreviewWidget(30, 35, descriptor(30, 2), runtime,
    (_view, from, to) => { activated = `new:${from}:${to}`; });
  if (!moved.eq(equivalent)) throw new Error("equal render data should preserve DOM");
  element.click();
  if (String(activated) !== "new:30:35") throw new Error("eq must transfer current callbacks");
  equivalent.destroy(dom);
  activated = "disposed";
  element.click();
  if (activated !== "disposed") throw new Error("disposed widget must ignore queued events");
}

class WidgetElement {
  readonly dataset: Record<string, string> = {};
  readonly ownerDocument = {
    defaultView: undefined,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  readonly style = { setProperty: () => {} };
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
  };
  readonly listeners: Array<(event: MouseEvent) => void> = [];
  addEventListener(_type: string, listener: (event: MouseEvent) => void): void {
    this.listeners.push(listener);
  }
  closest(): null { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20, bottom: 20 }; }
  click(): void {
    const event = { button: 0, target: null, clientX: 1, clientY: 1,
      preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent;
    this.listeners.forEach((listener) => listener(event));
  }
}
