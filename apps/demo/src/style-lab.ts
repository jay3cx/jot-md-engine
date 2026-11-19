const targets = [
  { label: "标题", selector: ".jot-md-heading", example: "color: #108a76;" },
  { label: "正文", selector: ".jot-md-paragraph", example: "color: #567ec1;" },
  { label: "引用", selector: ".jot-md-block-quote", example: "background-color: #def6f1;\ncolor: #102331;" },
  { label: "代码内容行", selector: ".jot-code-line, .jot-source-line", example: "color: #388ac1;" },
  { label: "表格单元格", selector: ".jot-table-cell", example: "border-color: #75bfb1;" },
  { label: "表格按钮", selector: ".jot-table-toolbar__button", example: "color: #108a76;" },
];
const visualProperties = new Set(["color", "background-color", "border-color", "outline-color", "text-decoration-color", "caret-color"]);

export function bindStyleLab(): void {
  const select = document.querySelector<HTMLSelectElement>("#css-target")!;
  const selector = document.querySelector<HTMLElement>("#css-selector")!;
  const editor = document.querySelector<HTMLTextAreaElement>("#css-declarations")!;
  const status = document.querySelector<HTMLElement>("#css-status")!;
  const style = document.createElement("style");
  document.head.append(style);
  const sheet = style.sheet!;
  const rules = targets.map(({ selector, label }, index) => {
    select.add(new Option(label, String(index)));
    const scoped = selector.split(",").map(part => `#editor-root ${part.trim()}`).join(", ");
    sheet.insertRule(`${scoped} {}`, index);
    return sheet.cssRules[index] as CSSStyleRule;
  });
  const drafts = targets.map(() => "");
  const errors = targets.map(() => "");

  function render(): void {
    const index = select.selectedIndex;
    editor.value = drafts[index] ?? "";
    editor.placeholder = targets[index]!.example;
    selector.textContent = rules[index]!.selectorText;
    showStatus();
  }

  function showStatus(): void {
    const error = errors[select.selectedIndex] ?? "";
    status.textContent = error || (editor.value.trim() ? "预览已更新。" : "使用默认样式。");
    status.toggleAttribute("data-error", error !== "");
    editor.setAttribute("aria-invalid", String(error !== ""));
  }

  function apply(): void {
    const index = select.selectedIndex;
    drafts[index] = editor.value;
    const values = new Map<string, string>();
    for (const declaration of editor.value.split(";").map(part => part.trim()).filter(Boolean)) {
      const colon = declaration.indexOf(":");
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (colon < 0 || !visualProperties.has(property) || !CSS.supports(property, value)) {
        errors[index] = "请输入颜色类 CSS 声明，例如 color: #108a76;。当前预览保留上次有效的样式。";
        showStatus();
        return;
      }
      values.set(property, value);
    }
    const rule = rules[index]!;
    rule.style.cssText = "";
    for (const [property, value] of values) rule.style.setProperty(property, value, "important");
    errors[index] = "";
    showStatus();
  }

  select.addEventListener("change", render);
  editor.addEventListener("input", apply);
  document.querySelector("#css-example")!.addEventListener("click", () => {
    editor.value = targets[select.selectedIndex]!.example;
    apply();
  });
  document.querySelector("#css-reset")!.addEventListener("click", () => {
    editor.value = "";
    apply();
  });
  render();
}
