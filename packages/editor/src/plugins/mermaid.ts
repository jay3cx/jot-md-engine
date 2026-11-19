import type { MarkdownEditorPlugin } from "./registry.js";

/** The caller supplies Mermaid so the core editor never downloads it. */
export interface MermaidLibrary {
  initialize(config: {
    readonly startOnLoad: false;
    readonly securityLevel: "strict";
    readonly suppressErrorRendering: true;
    readonly maxTextSize: number;
    readonly maxEdges: number;
    readonly theme: MermaidTheme;
    readonly themeVariables?: MermaidThemeVariables;
  }): void;
  render(id: string, source: string, container?: Element): Promise<{ readonly svg: string }>;
}

export interface MermaidPluginOptions {
  /** For example, `() => import("mermaid")`. Called only for a visible diagram. */
  readonly load: () => Promise<{ readonly default: MermaidLibrary } | MermaidLibrary>;
  readonly enabled?: boolean;
  readonly maxSourceLength?: number;
  /** Defaults to the current editor text color; may be supplied explicitly. */
  readonly theme?: MermaidTheme | ((element: HTMLElement) => MermaidTheme);
  /** Per-render Mermaid variables. Use the "base" theme for a custom palette. */
  readonly themeVariables?: MermaidThemeVariables | ((element: HTMLElement) => MermaidThemeVariables);
  /** Maximum cached diagrams per rendering host; 0 disables caching. */
  readonly cacheMaxEntries?: number;
  /** Approximate maximum cached source and SVG bytes per host; 0 disables caching. */
  readonly cacheMaxBytes?: number;
}

export type MermaidTheme = "default" | "dark" | "forest" | "neutral" | "base";
type MermaidThemeVariables = Readonly<Record<string, string | number | boolean>>;

let nextDiagramId = 0;

/** Optional, lazy renderer for Rust-confirmed fenced code with language mermaid. */
export function createMermaidPlugin(options: MermaidPluginOptions): MarkdownEditorPlugin {
  const maxSourceLength = options.maxSourceLength ?? 50_000;
  const cacheMaxEntries = cacheLimit(options.cacheMaxEntries, 64, "cacheMaxEntries");
  const cacheMaxBytes = cacheLimit(options.cacheMaxBytes, 4 * 1024 * 1024, "cacheMaxBytes");
  const caches = new WeakMap<object, { entries: Map<string, { svg: string; bytes: number }>; bytes: number }>();
  let loading: Promise<MermaidLibrary> | undefined;
  let renderTail: Promise<void> = Promise.resolve();
  const library = (): Promise<MermaidLibrary> => {
    if (loading === undefined) {
      loading = options.load().then((module) => "default" in module ? module.default : module)
        .catch((error: unknown) => { loading = undefined; throw error; });
    }
    return loading;
  };
  return {
    id: "mermaid",
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    codeBlocks: [{
      languages: ["mermaid"],
      maxSourceLength,
      rerenderOnLayout: true,
      render({ source, document, element: host, signal, nodeId, cacheScope }) {
        const theme = typeof options.theme === "function" ? options.theme(host) :
          options.theme ?? inferTheme(host);
        const themeVariables = typeof options.themeVariables === "function" ? options.themeVariables(host) :
          options.themeVariables;
        // Each runtime and node owns its own SVG IDs. Sharing markup across
        // different nodes or editors would create duplicate DOM references.
        const key = JSON.stringify([nodeId, theme, themeVariables, source]);
        const readCache = (): string | undefined => {
          const entries = caches.get(cacheScope)?.entries;
          const cached = entries?.get(key);
          if (cached === undefined || entries === undefined) return undefined;
          entries.delete(key);
          entries.set(key, cached);
          return cached.svg;
        };
        const saveCache = (svg: string): void => {
          const bytes = (key.length + svg.length) * 2;
          if (cacheMaxEntries === 0 || cacheMaxBytes === 0 || bytes > cacheMaxBytes) return;
          let cache = caches.get(cacheScope);
          if (cache === undefined) {
            cache = { entries: new Map(), bytes: 0 };
            caches.set(cacheScope, cache);
          }
          const previous = cache.entries.get(key);
          if (previous !== undefined) cache.bytes -= previous.bytes;
          cache.entries.delete(key);
          cache.entries.set(key, { svg, bytes });
          cache.bytes += bytes;
          while (cache.entries.size > cacheMaxEntries || cache.bytes > cacheMaxBytes) {
            const oldest = cache.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            cache.bytes -= cache.entries.get(oldest)!.bytes;
            cache.entries.delete(oldest);
          }
        };
        const makeElement = (svg: string): HTMLElement => {
          const element = document.createElement("div");
          element.className = "jot-mermaid";
          element.dataset["jotMermaidTheme"] = theme;
          element.innerHTML = svg;
          if (element.querySelector("svg") === null) throw new Error("Mermaid did not return an SVG diagram");
          return element;
        };
        const cached = readCache();
        if (cached !== undefined) return makeElement(cached);
        // Mermaid renders serially. Check cancellation before entering its
        // queue so fast scrolling cannot leave a backlog of stale diagrams.
        const task = renderTail.then(async () => {
          if (signal.aborted) throw new DOMException("Diagram render cancelled", "AbortError");
          // A previous unmounted request may have finished while this request
          // waited in the queue; use its result instead of rendering twice.
          const queued = readCache();
          if (queued !== undefined) return makeElement(queued);
          const mermaid = await library();
          if (signal.aborted) throw new DOMException("Diagram render cancelled", "AbortError");
          // Configuration belongs to the caller-supplied library instance.
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            maxTextSize: maxSourceLength,
            maxEdges: 500,
            theme,
            ...(themeVariables === undefined ? {} : { themeVariables: { ...themeVariables } }),
          });
          // Without a container Mermaid appends its temporary SVG directly to
          // <body>. While a diagram is drawing, that extra in-flow element can
          // create a page scrollbar and shift every centered editor. Keep the
          // measurable staging DOM out of the page flow; do not change the
          // page's own overflow or scrollbar behavior.
          const staging = document.createElement("div");
          staging.setAttribute("data-jot-mermaid-stage", "");
          staging.setAttribute("aria-hidden", "true");
          const width = Math.max(1, host.getBoundingClientRect().width || document.documentElement.clientWidth);
          staging.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:0;overflow:hidden;visibility:hidden;pointer-events:none;z-index:-1`;
          (document.body ?? document.documentElement).append(staging);
          let result: { readonly svg: string };
          try {
            result = await mermaid.render(`jot-mermaid-${++nextDiagramId}`, source, staging);
          } finally {
            staging.remove();
          }
          const element = makeElement(result.svg);
          saveCache(result.svg);
          if (signal.aborted) throw new DOMException("Diagram render cancelled", "AbortError");
          return element;
        });
        renderTail = task.then(() => undefined, () => undefined);
        return task;
      },
    }],
  };
}

function cacheLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return limit;
}

function inferTheme(element: HTMLElement): MermaidTheme {
  const color = element.ownerDocument.defaultView?.getComputedStyle(element).color ?? "";
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/u.exec(color);
  if (match === null) return "default";
  const lightness = (Number(match[1]) * .2126 + Number(match[2]) * .7152 + Number(match[3]) * .0722) / 255;
  return lightness > .5 ? "dark" : "default";
}
