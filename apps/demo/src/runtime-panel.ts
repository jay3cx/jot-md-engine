import type { MarkdownEditor } from "../../../packages/editor/src/component/index.js";
import type { EditorOperationTrace } from "../../../packages/editor/src/observability/index.js";

const operationNames = {
  open: "打开文档",
  transaction: "提交编辑",
  analysis: "后台解析",
  command: "命令",
};

export function bindRuntimePanel(editor: MarkdownEditor, root: HTMLElement) {
  const logs = document.querySelector<HTMLOListElement>("#runtime-log")!;
  const confirmation = document.querySelector("#metric-confirm")!;
  const analysis = document.querySelector("#metric-parse")!;
  const plan = document.querySelector("#metric-plan")!;
  const rows = document.querySelector("#metric-rows")!;
  const rowLabel = rows.parentElement!.querySelector("button")!;
  const heap = document.querySelector("#metric-heap")!;
  const recent = new Map<string, string>();
  let confirmMs: number | undefined;
  let latestConfirmation = -1;
  let parseTiming = "—";
  let pendingParse: { revision: number; confirmedAt: number } | undefined;
  let timer: number | undefined;
  let dirty = true;

  const cards = document.querySelector<HTMLElement>("#metric-cards")!;
  let activeHint: HTMLButtonElement | undefined;
  let pinned = false;
  function showHint(button?: HTMLButtonElement): void {
    activeHint?.setAttribute("aria-expanded", "false");
    activeHint = button;
    button?.setAttribute("aria-expanded", "true");
    pinned = false;
  }
  const hints = new AbortController();
  for (const trigger of cards.querySelectorAll<HTMLButtonElement>("dt button")) {
    const term = trigger.parentElement!;
    term.addEventListener("pointerenter", event => {
      if (event.pointerType !== "touch" && !pinned) showHint(trigger);
    }, { signal: hints.signal });
    term.addEventListener("pointerleave", () => {
      if (!pinned && activeHint === trigger && !trigger.matches(":focus-visible")) showHint();
    }, { signal: hints.signal });
    trigger.addEventListener("focus", () => showHint(trigger), { signal: hints.signal });
    trigger.addEventListener("blur", () => showHint(), { signal: hints.signal });
    trigger.addEventListener("click", () => {
      if (activeHint === trigger && pinned) { showHint(); return; }
      showHint(trigger);
      pinned = true;
    }, { signal: hints.signal });
  }
  document.addEventListener("pointerdown", event => {
    if (activeHint && !activeHint.parentElement!.contains(event.target as Node)) showHint();
  }, { signal: hints.signal });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !activeHint) return;
    event.preventDefault();
    event.stopPropagation();
    showHint();
  }, { capture: true, signal: hints.signal });

  const unsubscribe = editor.events.subscribe(accept);
  const unsubscribeAnalysis = editor.subscribe(effect => {
    if (effect.documentPatch !== undefined) {
      pendingParse = { revision: Number(effect.documentPatch.revision), confirmedAt: performance.now() };
    }
    const analysis = effect.analysis;
    if (analysis === undefined || analysis.targetRevision !== editor.session.adapter.revision) return;
    // 打开文档只有初始版本。第一笔编辑确认之前，两项编辑耗时都留空。
    if (!pendingParse || pendingParse.revision !== Number(analysis.targetRevision)) return;
    if (analysis.state === "pending") {
      parseTiming = "后台解析中";
      return;
    }
    if (analysis.state === "failed") {
      parseTiming = `失败 · ${analysis.failure.code}`;
    } else if (analysis.state === "cancelled") {
      parseTiming = "已取消";
    } else {
      parseTiming = effect.documentPatch === undefined
        ? milliseconds(performance.now() - pendingParse.confirmedAt)
        : "同次返回";
    }
    pendingParse = undefined;
  });
  function accept(operation: EditorOperationTrace): void {
    if (operation.kind === "projection" && !operation.error) return;
    const committed = operation.kind === "transaction" ? lastDocumentStage(operation) : undefined;
    if (committed !== undefined && committed.atMs > latestConfirmation) {
      latestConfirmation = committed.atMs;
      confirmMs = committed.elapsedMs;
    }
    const job = operation.kind === "analysis" ? operation.analysis : undefined;
    if (operation.status === "pending" && job === undefined) return;
    const revision = operation.revision ?? operation.analysis?.targetRevision;
    const version = revision === undefined ? "" : ` · 第 ${revision} 版`;
    const state = operation.error ?? (job?.state === "failed" ? job.failure.code
      : job?.state === "cancelled" ? "已取消" : job?.state === "pending" ? "解析中" : "完成");
    const name = operation.kind === "projection" ? "视口投影" : operationNames[operation.kind];
    const key = job === undefined ? operation.id : `analysis:${job.analysisId}`;
    recent.delete(key);
    recent.set(key, `${name}${version} · ${state}`);
    if (recent.size > 12) recent.delete(recent.keys().next().value!);
    dirty = true;
  }

  function render(): void {
    confirmation.textContent = milliseconds(confirmMs);
    analysis.textContent = parseTiming;
    const snapshot = editor.livePreview.snapshot;
    plan.textContent = snapshot.enabled && snapshot.projectedNodes > 0 ? milliseconds(snapshot.planDurationMs) : "—";
    const view = editor.input.view;
    const previewOnly = editor.mode === "preview" || editor.mode === "pretext";
    rowLabel.textContent = previewOnly ? "预览已挂载根块" : "已挂载行 / 全文行";
    rows.textContent = previewOnly
      ? String(root.querySelectorAll(".jot-editor-content > [data-jot-virtual-index]").length)
      : `${view.contentDOM.querySelectorAll(".cm-line").length} / ${view.state.doc.lines.toLocaleString()}`;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
    heap.textContent = memory === undefined ? "浏览器未提供" : `${(memory / 1048576).toFixed(1)} MiB`;
    if (dirty) {
      const items = Array.from(recent.values()).reverse().map(summary => {
        const item = document.createElement("li");
        item.textContent = summary;
        return item;
      });
      logs.replaceChildren(...items);
      dirty = false;
    }
  }

  function setVisible(visible: boolean): void {
    window.clearInterval(timer);
    timer = undefined;
    if (!visible) showHint();
    if (visible) {
      render();
      timer = window.setInterval(render, 350);
    }
  }

  return {
    setVisible,
    dispose() {
      setVisible(false);
      hints.abort();
      unsubscribe();
      unsubscribeAnalysis();
    },
  };
}

function lastDocumentStage(operation: EditorOperationTrace) {
  for (let index = operation.stages.length - 1; index >= 0; index--) {
    const stage = operation.stages[index];
    if (stage?.kind === "document") return stage;
  }
}

function milliseconds(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)} ms`;
}
