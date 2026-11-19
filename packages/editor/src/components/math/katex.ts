import katex, { type KatexOptions } from "katex";
import type { DomRenderContext } from "../common/dom-renderer.js";

/**
 * 编辑器渲染的所有公式共享的 KaTeX 选项。
 * `displayMode` 由 Markdown 节点决定，不能在这里覆盖。
 */
export type KaTeXRendererOptions = Omit<KatexOptions, "displayMode">;

/**
 * 创建 Preview 使用的内置同步公式渲染器。
 *
 * 每个节点都会得到一个新的 DOM 宿主。函数不会通过 innerHTML 写入用户控制的
 * 源码，KaTeX 只拥有传给它的宿主。无效或不支持的输入会回退为可见源码，避免
 * 错误公式破坏编辑器 Surface 的其他部分。
 */
export function createKaTeXRenderer(
  options: KaTeXRendererOptions = {},
): NonNullable<DomRenderContext["renderMath"]> {
  const settings: KaTeXRendererOptions = {
    output: "htmlAndMathml",
    throwOnError: true,
    strict: "warn",
    trust: false,
    ...options,
  };

  return (latex, display, document) => {
    const host = document.createElement(display ? "div" : "span");
    host.className = display
      ? "jot-katex jot-katex-display"
      : "jot-katex jot-katex-inline";
    try {
      katex.render(latex, host, {
        ...settings,
        displayMode: display,
      });
    } catch (error) {
      host.dataset["jotMathError"] = "true";
      host.title = error instanceof Error ? error.message : "Invalid KaTeX formula";
      host.textContent = latex;
    }
    return host;
  };
}
