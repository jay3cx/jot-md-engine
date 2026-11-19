import type {
  ProjectionAxis,
  ProjectionSlice,
  RenderNode,
} from "@jot-md/editor-protocol";
import { DomVirtualList } from "../../core/virtual/dom-virtual-list.js";
import { tolerateStaleProjection } from "../../components/common/render-utils.js";
import type { RenderComponent, RenderRuntime } from "./dom-runtime.js";

const MAX_EAGER_INLINE_CHILDREN = 512;

/** 延迟加载普通 inline/semantic 子树，并在同一 DOM 外壳内协调子节点。 */
export class InlineChildren implements RenderComponent {
  #node: RenderNode;
  readonly #host: HTMLElement;
  readonly #runtime: RenderRuntime;
  #disposed = false;
  #loadEpoch = 0;

  constructor(node: RenderNode, host: HTMLElement, runtime: RenderRuntime) {
    this.#node = node;
    this.#host = host;
    this.#runtime = runtime;
    void this.#load().catch((error) => runtime.options.onError?.(error));
  }

  update(node: RenderNode): void {
    if (
      node.contentVersion === this.#node.contentVersion &&
      node.childCount === this.#node.childCount
    ) {
      return;
    }
    this.#node = node;
    void this.#load().catch((error) => this.#runtime.options.onError?.(error));
  }

  dispose(): void {
    this.#disposed = true;
    this.#loadEpoch += 1;
  }

  async #load(): Promise<void> {
    const epoch = ++this.#loadEpoch;
    const node = this.#node;
    const store = this.#runtime.options.session.adapter.projection;
    if (node.childCount > MAX_EAGER_INLINE_CHILDREN) {
      // A single pathological paragraph/table cell must never turn one visible
      // widget into an unbounded sequence of 256-child Worker round trips.
      // RenderRuntime has already checked the source range against the current revision.
      this.#replaceWithSource(node);
      return;
    }
    const missing = store.missingRanges(
      node.id,
      "syntax-children",
      0,
      node.childCount,
    );
    for (const range of missing) {
      for (let from = range.from; from < range.toExclusive; from += 256) {
        if (this.#disposed) return;
        const effect = await tolerateStaleProjection(() =>
          this.#runtime.options.session.project([{
            parentId: node.id,
            axis: "syntax-children",
            window: {
              type: "index",
              from,
              toExclusive: Math.min(range.toExclusive, from + 256),
            },
            maxDepth: 2,
          }]));
        if (effect === undefined) return;
      }
    }
    if (this.#disposed || epoch !== this.#loadEpoch) return;
    if (this.#host.childNodes.length > 0 && this.#host.children.length === 0) {
      this.#host.replaceChildren();
    }
    const children = store.nodes(
      node.id,
      "syntax-children",
      0,
      node.childCount,
    );
    this.#runtime.reconcileChildren(this.#host, children);
    delete this.#host.dataset["jotDeferred"];
    delete this.#host.dataset["jotInlineFallback"];
  }

  #replaceWithSource(node: RenderNode): void {
    for (const child of Array.from(this.#host.children)) {
      this.#runtime.disposeSubtree(child as HTMLElement);
    }
    const source = this.#runtime.options.session.adapter.text.text;
    const from = Math.max(0, Math.min(source.length, Number(node.sourceRange.from)));
    const to = Math.max(from, Math.min(source.length, Number(node.sourceRange.to)));
    this.#host.textContent = source.slice(from, to);
    this.#host.dataset["jotInlineFallback"] = "source";
    delete this.#host.dataset["jotDeferred"];
  }
}

/** 嵌套语义容器的纵向虚拟子轴。 */
export class ProjectedChildren implements RenderComponent {
  readonly #list: DomVirtualList<RenderNode>;
  #disposed = false;

  constructor(node: RenderNode, host: HTMLElement, runtime: RenderRuntime) {
    const axis: ProjectionAxis = "syntax-children";
    const store = runtime.options.session.adapter.projection;
    this.#list = new DomVirtualList({
      host,
      scrollElement: runtime.options.scrollElement ?? runtime.options.root,
      estimatedItemHeight: runtime.options.estimatedRowHeight ?? 32,
      axis: runtime.axis(
        `${axis}:${node.id}`,
        runtime.options.estimatedRowHeight ?? 32,
      ),
      overscanPixels: runtime.options.overscanPixels,
      getItem: (index) => store.nodeAt(node.id, axis, index),
      itemKey: (item) => runtime.key(item),
      loadRange: async (from, toExclusive) => {
        const missing = store.missingRanges(node.id, axis, from, toExclusive);
        if (missing.length === 0) return;
        await tolerateStaleProjection(() =>
          runtime.options.session.project(
            missing.map((range): ProjectionSlice => ({
              parentId: node.id,
              axis,
              window: { type: "index", ...range },
              maxDepth: 1,
            })),
          ));
      },
      renderItem: (item) => runtime.mount(item),
      updateItem: (element, item) => runtime.update(element, item),
      disposeElement: (element) => runtime.disposeSubtree(element),
      onError: runtime.options.onError,
      spacerTag: host.tagName === "UL" || host.tagName === "OL" ? "li" : "div",
    });
    this.#list.setCount(node.childCount);
  }

  update(node: RenderNode): void {
    this.#list.setCount(node.childCount);
    this.#list.schedule();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#list.dispose();
  }
}

/** fenced code 和大型公式的物理源码行虚拟子轴。 */
export class ProjectedLines implements RenderComponent {
  readonly #list: DomVirtualList<RenderNode>;
  readonly #runtime: RenderRuntime;
  readonly #host: HTMLElement;
  #node: RenderNode;
  #disposed = false;
  #loadEpoch = 0;

  constructor(node: RenderNode, host: HTMLElement, runtime: RenderRuntime) {
    this.#runtime = runtime;
    this.#host = host;
    this.#node = node;
    host.classList.add("jot-source-lines");
    const store = runtime.options.session.adapter.projection;
    this.#list = new DomVirtualList({
      host,
      scrollElement: runtime.options.scrollElement ?? runtime.options.root,
      estimatedItemHeight: runtime.options.estimatedLineHeight ?? 24,
      axis: runtime.axis(
        `source-lines:${node.id}`,
        runtime.options.estimatedLineHeight ?? 24,
      ),
      overscanPixels: runtime.options.overscanPixels,
      getItem: (index) => store.nodeAt(node.id, "source-lines", index),
      itemKey: (_item, index) => `${node.id}:source-line:${index}`,
      loadRange: async (from, toExclusive) => {
        const missing = store.missingRanges(node.id, "source-lines", from, toExclusive);
        if (missing.length === 0) return;
        await tolerateStaleProjection(() =>
          runtime.options.session.project([{
            parentId: node.id,
            axis: "source-lines",
            window: { type: "index", from, toExclusive },
            maxDepth: 0,
          }]));
      },
      renderItem: (item, index) => {
        const element = runtime.mount(item);
        if (node.kind === "fenced-code") {
          element.classList.add("jot-code-line");
          element.dataset["jotLineNumber"] = String(index + 1);
        }
        return element;
      },
      updateItem: (element, item, index) => {
        runtime.updateProjectedSourceLine(element, item);
        if (node.kind === "fenced-code") element.dataset["jotLineNumber"] = String(index + 1);
      },
      disposeElement: (element) => runtime.disposeSubtree(element),
      onError: runtime.options.onError,
    });
    void this.#reloadCount();
  }

  update(node: RenderNode): void {
    if (
      node.contentVersion === this.#node.contentVersion &&
      node.childCount === this.#node.childCount
    ) {
      return;
    }
    this.#node = node;
    void this.#reloadCount();
  }

  #reloadCount(): Promise<void> {
    const epoch = ++this.#loadEpoch;
    const node = this.#node;
    return tolerateStaleProjection(() =>
      this.#runtime.options.session.projectSourceLines(node.id, 0, 64))
      .then((effect) => {
        if (this.#disposed || epoch !== this.#loadEpoch || effect === undefined) return;
        const operation = effect.renderPatch?.operations.find(
          (candidate) => candidate.parentId === node.id && candidate.axis === "source-lines",
        );
        const total = operation?.totalChildren ??
          this.#runtime.options.session.adapter.projection.totalChildren(
            node.id,
            "source-lines",
          );
        if (node.kind === "fenced-code") {
          this.#host.style.setProperty("--jot-code-number-width", `${Math.max(4, String(Math.max(1, total)).length)}ch`);
        }
        if (node.kind === "math-block" && total <= 128) {
          this.#list.dispose();
          this.#host.replaceChildren(this.#runtime.renderMathBlock(node));
          return;
        }
        this.#list.setCount(total);
      })
      .catch(this.#runtime.options.onError);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loadEpoch += 1;
    this.#list.dispose();
  }
}
