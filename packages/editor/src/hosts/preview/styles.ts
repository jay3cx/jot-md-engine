import { DEFAULT_QUOTE_MIN_CONTENT_WIDTH } from "../../layout/quote-geometry.js";

export const EDITOR_SURFACE_CSS = `
.jot-editor-content,.jot-live-preview-content{--jot-heading-1-font-size:1.714286em;--jot-heading-2-font-size:1.428571em;--jot-heading-3-font-size:1.285714em;--jot-heading-4-font-size:1.142857em;--jot-heading-5-font-size:1em;--jot-heading-6-font-size:1em}
.jot-editor-surface{position:relative;box-sizing:border-box;min-width:0;min-height:0;overflow:auto;contain:layout style;overflow-anchor:none}
.jot-editor-content{position:relative;display:flex;flex-direction:column;min-height:100%;box-sizing:border-box;
  overflow-wrap:anywhere;word-break:break-word;
  --jot-block-gap-half:0px;--jot-live-preview-block-gap:0px;--jot-boundary-width:0px;
  --jot-paragraph-line-height:1.4em;--jot-paragraph-padding-x:0px;
  --jot-quote-padding-y:0px;--jot-quote-padding-x:0px;--jot-quote-min-content:${DEFAULT_QUOTE_MIN_CONTENT_WIDTH}px;--jot-list-indent:2em;
  --jot-code-line-height:1.4em;--jot-code-padding-half:0px;--jot-table-header-height:0px;
  --jot-table-row-height:0px;--jot-table-toolbar-height:0px;--jot-table-frame:0px;
  --jot-table-frame-half:0px;
  --jot-math-line-height:1.4em;--jot-math-padding-half:0px;--jot-thematic-height:1.4em;
  --jot-blank-line-height:1.4em}
.jot-live-preview-content{--jot-live-preview-block-gap:0px;--jot-boundary-width:0px}
.jot-virtual-spacer{display:block;flex:none;margin:0;padding:0;border:0;list-style:none}
.jot-virtual-placeholder{box-sizing:border-box;opacity:.45}
.jot-editor-content>[data-jot-virtual-index]{box-sizing:border-box;flex:none;width:100%;min-width:0;max-width:100%;
  margin-block:var(--jot-block-gap-half)!important}
.jot-editor-content>[data-jot-kind="block-quote"][data-jot-virtual-index]{margin-inline:0!important}
.jot-editor-content [data-jot-kind="paragraph"],
.jot-live-preview-widget[data-jot-kind="paragraph"],
.jot-live-preview-widget [data-jot-kind="paragraph"]{
  box-sizing:border-box;
  margin-block:0;
  padding:0;
  border:0;
  text-indent:0;
  font:inherit;
  letter-spacing:inherit;
  word-spacing:inherit;
  text-transform:inherit;
  line-height:var(--jot-paragraph-line-height)}
.jot-editor-content>[data-jot-kind="paragraph"],
.jot-live-preview-widget[data-jot-kind="paragraph"]{padding-inline:var(--jot-paragraph-padding-x)}
.jot-editor-content h1[data-jot-kind="heading"],.jot-live-preview-widget:is(h1)[data-jot-kind="heading"]{margin-block:0;font-size:var(--jot-heading-1-font-size);line-height:var(--jot-heading-1-line-height,1.2)}
.jot-editor-content h2[data-jot-kind="heading"],.jot-live-preview-widget:is(h2)[data-jot-kind="heading"]{margin-block:0;font-size:var(--jot-heading-2-font-size);line-height:var(--jot-heading-2-line-height,1.25)}
.jot-editor-content h3[data-jot-kind="heading"],.jot-live-preview-widget:is(h3)[data-jot-kind="heading"]{margin-block:0;font-size:var(--jot-heading-3-font-size);line-height:var(--jot-heading-3-line-height,1.3)}
.jot-editor-content h4[data-jot-kind="heading"],.jot-live-preview-widget:is(h4)[data-jot-kind="heading"]{margin-block:0;font-size:var(--jot-heading-4-font-size);line-height:var(--jot-heading-4-line-height,1.35)}
.jot-editor-content h5[data-jot-kind="heading"],.jot-live-preview-widget:is(h5)[data-jot-kind="heading"]{margin-block:0;font-size:var(--jot-heading-5-font-size);line-height:var(--jot-heading-5-line-height,1.4)}
.jot-editor-content h6[data-jot-kind="heading"],.jot-live-preview-widget:is(h6)[data-jot-kind="heading"]{margin-block:0;font-size:var(--jot-heading-6-font-size);line-height:var(--jot-heading-6-line-height,1.45)}
.jot-editor-content blockquote,
.jot-live-preview-widget [data-jot-kind="block-quote"]{
  margin:0;
  box-sizing:border-box;
  border-inline:0;
  border-block-start:0;
  text-indent:0;
  font:inherit;
  letter-spacing:inherit;
  word-spacing:inherit;
  text-transform:inherit;
  overflow-wrap:anywhere;
  word-break:break-word;
  padding-block:var(--jot-quote-padding-y);
  padding-inline-start:min(var(--jot-quote-padding-x),max(0px,calc(100% - var(--jot-quote-padding-x) - var(--jot-quote-min-content,64px))));
  padding-inline-end:var(--jot-quote-padding-x)}
/* Nesting adds only a left rule and indentation. The outer quote owns the
   vertical and right padding; keep a usable text column at extreme depths. */
.jot-editor-content blockquote blockquote,
.jot-live-preview-widget[data-jot-kind="block-quote"] [data-jot-kind="block-quote"],
.jot-live-preview-widget [data-jot-kind="block-quote"] [data-jot-kind="block-quote"]{
  padding-block:0;
  padding-inline-start:min(var(--jot-quote-padding-x),max(0px,calc(100% - var(--jot-quote-min-content,64px))));
  padding-inline-end:0;
  background:transparent}
/* A sparse quote must have a viewport while its children load. Once a real
   child is present, its own line height controls the container's height. */
.jot-editor-content blockquote:not(:has([data-jot-kind]:not([data-jot-kind="block-quote"]))),
.jot-live-preview-widget [data-jot-kind="block-quote"]:not(:has([data-jot-kind]:not([data-jot-kind="block-quote"]))){
  min-block-size:var(--jot-paragraph-line-height)}
.jot-editor-content blockquote:empty::before,
.jot-live-preview-widget [data-jot-kind="block-quote"]:empty::before{
  content:"";display:block;block-size:var(--jot-paragraph-line-height)}
.jot-editor-content blockquote .jot-blank-line,
.jot-live-preview-widget [data-jot-kind="block-quote"] .jot-blank-line{
  min-height:var(--jot-paragraph-line-height);line-height:var(--jot-paragraph-line-height)}
.jot-editor-content blockquote:dir(rtl),
.jot-live-preview-widget [data-jot-kind="block-quote"]:dir(rtl){
  box-shadow:inset -3px 0 0 var(--jot-quote-border,color-mix(in srgb,currentColor 25%,transparent))}
.jot-editor-content>[data-jot-mode=preview][data-jot-virtual-index]{box-sizing:border-box;
  border-block-end:var(--jot-boundary-width) solid color-mix(in srgb,currentColor 18%,transparent)}
.jot-live-preview-widget--block,.jot-live-preview-source-block-shell{box-sizing:border-box;display:block;min-width:0;max-width:100%;
  --jot-live-block-padding-start:0px;--jot-live-block-padding-end:0px;--jot-live-block-padding-inline:0px;
  margin-block:0!important;
  padding-block-start:var(--jot-live-block-padding-start);
  padding-block-end:calc(var(--jot-live-block-padding-end) + var(--jot-live-preview-block-gap));
  padding-inline:var(--jot-live-block-padding-inline);
  border-block-end:var(--jot-boundary-width) solid color-mix(in srgb,currentColor 18%,transparent)}
.jot-live-preview-widget--block:not([data-jot-kind="table"]){inline-size:100%;align-self:stretch}
.jot-live-preview-widget[data-jot-kind="block-quote"]{
  --jot-live-block-padding-start:var(--jot-quote-padding-y);
  --jot-live-block-padding-end:var(--jot-quote-padding-y);
  --jot-live-block-padding-inline:var(--jot-quote-padding-x)}
/* Quote geometry belongs to its native physical lines in both states. */
.jot-live-preview-source-block-shell--block-quote{
  --jot-live-block-padding-start:0px;--jot-live-block-padding-end:0px;--jot-live-block-padding-inline:0px}
.jot-live-preview-widget[data-jot-kind="block-quote"]{margin:0}
.jot-live-preview-source-block-shell--fenced-code{
  --jot-live-block-padding-start:var(--jot-code-padding-half);
  --jot-live-block-padding-end:var(--jot-code-padding-half)}
.jot-live-preview-source-block-shell--math-block{
  --jot-live-block-padding-start:var(--jot-math-padding-half);
  --jot-live-block-padding-end:var(--jot-math-padding-half)}
.jot-source-block,.jot-dirty-source{white-space:pre-wrap;overflow-wrap:anywhere}
.jot-source-inline{white-space:pre-wrap}
.jot-inline-text{white-space:pre-wrap;tab-size:4}
.jot-image{display:inline-block;max-width:100%;max-height:var(--jot-image-max-height,480px);height:auto;object-fit:contain;vertical-align:middle}
.jot-image:not([width]){width:100%}
.jot-blank-line{display:block;min-height:var(--jot-blank-line-height);white-space:pre}
.jot-list-item{display:flex;align-items:flex-start;box-sizing:border-box;line-height:var(--jot-paragraph-line-height)}
.jot-list-item::before{content:attr(data-marker-text);display:block;flex:none;
  min-width:2ch;margin-inline-end:1ch;text-align:end;white-space:pre}
.jot-list-item>p{margin-block:0;min-width:0}
.jot-code,.jot-source-lines{overflow:auto;white-space:pre;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  line-height:var(--jot-code-line-height);padding-block:var(--jot-code-padding-half)}
.jot-math-block{overflow:auto;white-space:pre;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  line-height:var(--jot-math-line-height);padding-block:var(--jot-math-padding-half)}
.jot-source-line{min-height:var(--jot-code-line-height);white-space:pre}
.jot-code,.jot-source-lines,.jot-md-fenced-code{background:var(--jot-code-background,color-mix(in srgb,currentColor 5%,transparent))}
.jot-code-line{position:relative;box-sizing:border-box;padding-inline-start:calc(var(--jot-code-number-width,4ch) + 1ch)!important}
.jot-code-line::before{content:attr(data-jot-line-number);position:absolute;inset-inline-start:0;width:var(--jot-code-number-width,4ch);text-align:end;color:var(--jot-muted-color,GrayText);pointer-events:none;user-select:none}
.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-code-line{padding-inline-start:calc(var(--jot-live-quote-inset) + var(--jot-code-number-width,4ch) + 1ch)!important}
.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-code-line::before{inset-inline-start:var(--jot-live-quote-inset)}
.jot-editor-surface[data-jot-code-wrap="wrap"] .jot-code{white-space:pre-wrap;overflow-x:hidden}
.jot-editor-surface[data-jot-code-wrap="wrap"] .jot-code .jot-source-line{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.jot-editor-surface[data-jot-code-wrap="wrap"] .jot-pretext-block--code .jot-pretext-block__preview{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.jot-inline-code{background:var(--jot-code-background,color-mix(in srgb,currentColor 5%,transparent));border-radius:3px}
.jot-task-checkbox{width:1em;height:1em;vertical-align:middle;accent-color:currentColor;margin:0 .2em 0 0}
.jot-plugin-block{box-sizing:border-box;min-width:0;max-width:100%;overflow:auto;text-align:center}
.jot-plugin-block__status{font-size:.85em;opacity:.72;text-align:start}
.jot-plugin-block__source{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;text-align:start}
.jot-mermaid svg{display:block;max-width:100%;height:auto;margin-inline:auto}
.jot-list-item:has(.jot-task-checkbox)::before{content:""}
.cm-line.jot-live-preview-task-item::before{content:""}
.jot-live-preview-strikethrough,.jot-live-preview-source-strikethrough{text-decoration:line-through}
.jot-link{color:var(--jot-link-color,LinkText);text-underline-offset:.12em}
.jot-live-preview-strong,.jot-live-preview-source-strong{font-weight:700}
.jot-live-preview-emphasis,.jot-live-preview-source-emphasis{font-style:italic}
.jot-live-preview-link,.jot-live-preview-source-link{color:var(--jot-link-color,LinkText);text-decoration:underline;text-underline-offset:.12em}
.jot-md-block-quote{color:var(--jot-quote-color,inherit);background:var(--jot-quote-background,color-mix(in srgb,currentColor 3%,transparent));box-shadow:inset 3px 0 0 var(--jot-quote-border,color-mix(in srgb,currentColor 25%,transparent))}
.jot-source-line--wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.jot-source-line--truncated{opacity:.88}
.jot-pretext-block{position:relative;box-sizing:border-box;display:block;overflow:hidden;padding:0;
  border:var(--jot-boundary-width) dashed color-mix(in srgb,currentColor 28%,transparent);
  border-inline-start:4px solid #6f8f78;border-radius:0;background:color-mix(in srgb,currentColor 4%,transparent);
  contain:layout paint}
.jot-pretext-block__header{position:absolute;z-index:2;inset-block-start:.25rem;inset-inline-end:.3rem;
  display:flex;align-items:center;gap:.55rem;max-width:calc(100% - .6rem);padding:.18rem .35rem;border-radius:0;
  background:color-mix(in srgb,var(--jot-background,Canvas) 88%,transparent);font:600 .65rem/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;
  text-transform:uppercase;letter-spacing:.05em;pointer-events:none}
.jot-pretext-block__header code{font:inherit;white-space:nowrap;opacity:.7}
.jot-pretext-block__preview{box-sizing:border-box;width:100%;height:100%;min-width:0;overflow:hidden;color:inherit;
  font-family:inherit;font-size:inherit;font-weight:400;line-height:var(--jot-paragraph-line-height);
  white-space:pre-wrap;overflow-wrap:anywhere}
.jot-pretext-block__evidence{position:absolute;z-index:2;inset-inline-end:.3rem;inset-block-end:.25rem;
  max-width:calc(100% - .6rem);overflow:hidden;padding:.14rem .3rem;border-radius:0;text-overflow:ellipsis;
  white-space:nowrap;background:color-mix(in srgb,var(--jot-background,Canvas) 88%,transparent);opacity:.72;
  font:500 .61rem/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;pointer-events:none}
.jot-pretext-block--compact .jot-pretext-block__header{inset-block-start:50%;width:auto;transform:translateY(-50%)}
.jot-pretext-block--compact .jot-pretext-block__evidence{display:none}
.jot-pretext-block--block-quote .jot-pretext-block__preview{
  padding-block:var(--jot-quote-padding-y);
  padding-inline-start:min(calc(var(--jot-pretext-quote-depth,1) * var(--jot-quote-padding-x)),max(0px,calc(100% - var(--jot-quote-padding-x) - var(--jot-quote-min-content,64px))));
  padding-inline-end:var(--jot-quote-padding-x)}
.jot-pretext-block--list .jot-pretext-block__preview{padding-inline-start:var(--jot-list-indent)}
.jot-pretext-block--code .jot-pretext-block__preview{padding:var(--jot-code-padding-half) 1rem;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:var(--jot-code-line-height);white-space:pre}
.jot-pretext-block--math .jot-pretext-block__preview{padding:var(--jot-math-padding-half) 1rem;
  font-family:serif;line-height:var(--jot-math-line-height);white-space:pre-wrap}
.jot-pretext-block--table .jot-pretext-block__preview{line-height:var(--jot-table-row-height);white-space:pre}
.jot-pretext-strategy--heading-1 .jot-pretext-block__preview{font-size:var(--jot-heading-1-font-size);line-height:var(--jot-heading-1-line-height)}
.jot-pretext-strategy--heading-2 .jot-pretext-block__preview{font-size:var(--jot-heading-2-font-size);line-height:var(--jot-heading-2-line-height)}
.jot-pretext-strategy--heading-3 .jot-pretext-block__preview{font-size:var(--jot-heading-3-font-size);line-height:var(--jot-heading-3-line-height)}
.jot-pretext-strategy--heading-4 .jot-pretext-block__preview{font-size:var(--jot-heading-4-font-size);line-height:var(--jot-heading-4-line-height)}
.jot-pretext-strategy--heading-5 .jot-pretext-block__preview{font-size:var(--jot-heading-5-font-size);line-height:var(--jot-heading-5-line-height)}
.jot-pretext-strategy--heading-6 .jot-pretext-block__preview{font-size:var(--jot-heading-6-font-size);line-height:var(--jot-heading-6-line-height)}
.jot-pretext-block--heading{border-inline-start-color:#b46f25}.jot-pretext-block--table{border-inline-start-color:#356f9c}
.jot-pretext-block--list{border-inline-start-color:#7a5aa6}.jot-pretext-block--code{border-inline-start-color:#38774c}
.jot-pretext-block--math{border-inline-start-color:#9b4f70}.jot-pretext-block--image{border-inline-start-color:#a05d34}
.jot-pretext-block--list[data-jot-list-level="1"]{border-inline-start-color:#b46f25}
.jot-pretext-block--list[data-jot-list-level="2"]{border-inline-start-color:#397050}
.jot-pretext-block--list[data-jot-list-level="3"]{border-inline-start-color:#356f9c}
.jot-pretext-block--list[data-jot-list-level="4"]{border-inline-start-color:#7a5aa6}
.jot-table{display:block;width:max-content;min-width:0;max-width:100%;margin-inline:auto;overflow-x:auto;
  contain:layout style;border:var(--jot-table-frame-half) solid color-mix(in srgb,currentColor 24%,transparent);background:var(--jot-background,Canvas)}
.jot-table[data-jot-table-layout-mode=content]{display:block;width:max-content;vertical-align:top;text-align:start}
.jot-editor-content>[data-jot-virtual-index]:has(>.jot-table[data-jot-table-layout-mode=content]){text-align:center}
.jot-table[data-jot-table-layout-mode=adaptive]{display:block;width:100%;text-align:start}
.jot-table-grid-header,.jot-table-grid-body{width:max-content;min-width:100%}
.jot-table[data-jot-table-layout-mode=content] .jot-table-grid-header,
.jot-table[data-jot-table-layout-mode=content] .jot-table-grid-body,
.jot-table[data-jot-table-layout-mode=content] .jot-table-row{min-width:0}
.jot-table-row[data-jot-table-layout-mode=content]{min-width:0}
.jot-table-grid-header{background:var(--jot-background,Canvas);box-shadow:0 1px 0 color-mix(in srgb,currentColor 22%,transparent)}
.jot-table-grid-body{position:relative}
.jot-table-grid-body>[data-jot-virtual-index]{box-sizing:border-box;margin-block:0!important}
/* Let the grid determine intrinsic width; narrow tables wrap their commands. */
.jot-table-toolbar{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:4px;width:0;min-width:100%;min-height:var(--jot-table-toolbar-height);padding:3px 6px;border-block-end:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,var(--jot-background,Canvas) 94%,currentColor 6%);white-space:nowrap}
.jot-table-toolbar__button{box-sizing:border-box;padding:2px 5px;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:0;background:transparent;color:inherit;font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer}
.jot-table-toolbar__button:disabled{opacity:.4;cursor:default}
.jot-table-toolbar__button:hover,.jot-table-toolbar__button:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent)}
.jot-table-toolbar__button:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.jot-table-row{display:flex;align-items:stretch;width:max-content;min-width:100%;min-height:var(--jot-table-row-height);contain:layout style;direction:ltr}
.jot-table-cell{box-sizing:border-box;flex:none;padding:3px 6px;border-inline-end:1px solid color-mix(in srgb,currentColor 14%,transparent);
  border-block-end:1px solid color-mix(in srgb,currentColor 14%,transparent);min-width:0;
  line-height:var(--jot-paragraph-line-height);white-space:pre-wrap;overflow-wrap:anywhere}
.jot-table-cell[data-jot-source-from]{cursor:pointer}
.jot-table-cell[data-jot-source-from]:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.jot-table-grid-header,.jot-table-row--header{min-height:var(--jot-table-header-height)}
.jot-table-grid-header .jot-table-cell,.jot-table-row--header .jot-table-cell{font-weight:650;background:var(--jot-background,Canvas);position:relative}
.jot-table-cell--empty{min-height:1.7rem;background:color-mix(in srgb,currentColor 2%,transparent)}
.jot-table-column-resize{position:absolute;z-index:2;inset-block:0;inset-inline-end:-3px;width:7px;cursor:col-resize;touch-action:none}
.jot-table-column-resize:focus-visible{outline:2px solid currentColor;outline-offset:-1px;background:color-mix(in srgb,currentColor 18%,transparent)}
.jot-table-cell[data-align=left]{text-align:left}.jot-table-cell[data-align=center]{text-align:center}
.jot-table-cell[data-align=right]{text-align:right}
.jot-unhandled-node{border:1px dashed currentColor;padding:.5rem}
hr[data-jot-kind="thematic-break"],.jot-live-preview-widget:is(hr)[data-jot-kind="thematic-break"]{box-sizing:border-box;height:var(--jot-thematic-height);margin-block:0;border:0;background:linear-gradient(currentColor,currentColor) center/100% 1px no-repeat;opacity:.35}
.jot-math{font-family:serif}
.jot-math-inline{white-space:normal;vertical-align:baseline}
.jot-math-block{white-space:normal;font-family:inherit}
.jot-katex-inline{display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden;white-space:normal;vertical-align:middle}
.jot-katex-display{display:block;max-width:100%;overflow-x:auto;overflow-y:hidden;white-space:normal}
.jot-katex-display .katex-display{margin:0;text-align:start}
.jot-katex[data-jot-math-error="true"]{color:#a33b2b;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}
`;

export function installEditorSurfaceStyles(
  document: Document,
  css = EDITOR_SURFACE_CSS,
): HTMLStyleElement {
  const existing = document.querySelector<HTMLStyleElement>("style[data-jot-editor-styles]");
  if (existing !== null) return existing;
  const style = document.createElement("style");
  style.dataset["jotEditorStyles"] = "true";
  style.textContent = css;
  (document.head ?? document.documentElement).append(style);
  return style;
}
