import type { MarkdownEditorPlugin } from "./registry.js";

/** Optional, per-editor heading folding over Rust-confirmed root sections. */
export function createHeadingFoldPlugin(options: { readonly enabled?: boolean } = {}): MarkdownEditorPlugin {
  return {
    id: "heading-fold",
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    activate(editor) {
      const registered: string[] = [];
      try {
        editor.commands.register({ id: "heading-fold.toggle", title: "折叠或展开当前标题", category: "视图", requiresInput: false,
          run: () => ({ action: "heading-fold.toggle", userEvent: "view.heading-fold.toggle" }) });
        registered.push("heading-fold.toggle");
        editor.commands.register({ id: "heading-fold.unfold-all", title: "展开全部章节", category: "视图", requiresInput: false,
          run: () => ({ action: "heading-fold.unfold-all", userEvent: "view.heading-fold.unfold-all" }) });
        registered.push("heading-fold.unfold-all");
        const platform = editor.input.view.dom.ownerDocument.defaultView?.navigator.platform ?? "";
        editor.commands.bind({ id: "heading-fold.toggle", command: "heading-fold.toggle",
          key: /Mac|iPhone|iPad/u.test(platform) ? "Ctrl-Shift-o" : "Mod-Alt-f" });
        editor.headingFolds.setEnabled(true);
      } catch (error) {
        for (const id of registered) editor.commands.unregister(id);
        throw error;
      }
      return () => {
        editor.commands.unregister("heading-fold.toggle");
        editor.commands.unregister("heading-fold.unfold-all");
        editor.headingFolds.setEnabled(false);
      };
    },
  };
}
