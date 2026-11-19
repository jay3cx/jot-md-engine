import type { DomRenderContext } from "../common/dom-renderer.js";
import type { KaTeXRendererOptions } from "./katex.js";

type MathRenderer = NonNullable<DomRenderContext["renderMath"]>;
type RendererModule = { readonly createKaTeXRenderer: (options?: KaTeXRendererOptions) => MathRenderer };

/**
 * Load KaTeX on the first visible formula. Until it is ready, retain the
 * literal source in the same DOM host. A failed load also leaves it readable.
 */
export function createLazyKaTeXRenderer(
  options: KaTeXRendererOptions = {},
  load: () => Promise<RendererModule> = () => import("./katex.js"),
): MathRenderer {
  let renderer: MathRenderer | undefined;
  let loading: Promise<MathRenderer> | undefined;
  const notifyTargets = new Set<HTMLElement>();
  let notificationScheduled = false;

  const notifyLayout = (host: HTMLElement): void => {
    if (!host.isConnected) return;
    notifyTargets.add(host.closest<HTMLElement>(".jot-markdown-editor") ?? host);
    if (notificationScheduled) return;
    notificationScheduled = true;
    const notify = () => {
      notificationScheduled = false;
      for (const target of notifyTargets) {
        const EventType = target.ownerDocument.defaultView?.Event;
        if (target.isConnected && EventType !== undefined) {
          target.dispatchEvent(new EventType("jot-math-rendered", { bubbles: true }));
        }
      }
      notifyTargets.clear();
    };
    const view = host.ownerDocument.defaultView;
    if (view === null) queueMicrotask(notify);
    else view.requestAnimationFrame(notify);
  };

  const rendererWhenReady = (): Promise<MathRenderer> => {
    if (loading === undefined) {
      loading = Promise.resolve().then(load).then((module) => {
        renderer = module.createKaTeXRenderer(options);
        return renderer;
      }).catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
    }
    return loading;
  };

  return (latex, display, document) => {
    if (renderer !== undefined) return renderer(latex, display, document);
    const host = document.createElement(display ? "div" : "span");
    host.className = display ? "jot-katex jot-katex-display" : "jot-katex jot-katex-inline";
    host.textContent = latex;
    void rendererWhenReady().then((render) => {
      const rendered = render(latex, display, document);
      if (rendered.nodeType === 1) {
        const element = rendered as HTMLElement;
        host.replaceChildren(...element.childNodes);
        if (element.dataset["jotMathError"] !== undefined) host.dataset["jotMathError"] = "true";
        if (element.title !== "") host.title = element.title;
      } else {
        host.replaceChildren(rendered);
      }
      notifyLayout(host);
    }).catch((error: unknown) => {
      host.dataset["jotMathError"] = "true";
      host.title = error instanceof Error ? error.message : "KaTeX could not be loaded";
    });
    return host;
  };
}
