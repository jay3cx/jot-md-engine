import type { AnalysisWorkBudget } from "@jot-md/editor-protocol";

import {
  attachEditorWorker,
  reportWorkerFailure,
  type AttachedEditorWorker,
  type EditorWorkerEndpoint,
  type EditorWorkerRuntimeOptions,
  type WasmEditorHost,
} from "./runtime.js";

export interface EditorWasmModule {
  readonly default: () => unknown | Promise<unknown>;
  readonly WasmEditorHost: new () => WasmEditorHost;
}

export interface BootstrapEditorWorkerOptions
  extends Omit<
    EditorWorkerRuntimeOptions,
    "host" | "endpoint" | "backgroundBudget"
  > {
  readonly endpoint: EditorWorkerEndpoint;
  /** 加载 wasm-bindgen 模块。默认初始化函数通过模块自身的 URL 定位 Wasm。 */
  readonly loadWasm: () => Promise<EditorWasmModule>;
  readonly backgroundBudget?: AnalysisWorkBudget;
}

const DEFAULT_BACKGROUND_BUDGET: AnalysisWorkBudget = {
  maxSourceLines: 256,
  maxBlocks: 64,
  maxUtf16Units: 32_768,
};

/** 初始化 Wasm 期间暂存第一批消息。路由接管监听后按到达顺序处理暂存请求。 */
export async function bootstrapEditorWorker(
  options: BootstrapEditorWorkerOptions,
): Promise<AttachedEditorWorker> {
  const queued: unknown[] = [];
  const buffer = (event: MessageEvent<unknown>) => queued.push(event.data);
  options.endpoint.addEventListener("message", buffer);
  try {
    const module = await options.loadWasm();
    await module.default();
    const host = new module.WasmEditorHost();
    const attached = attachEditorWorker(options.endpoint, {
      host,
      backgroundBudget:
        options.backgroundBudget ?? DEFAULT_BACKGROUND_BUDGET,
      ...(options.scheduleTask === undefined
        ? {}
        : { scheduleTask: options.scheduleTask }),
      ...(options.onResponse === undefined
        ? {}
        : { onResponse: options.onResponse }),
      ...(options.onSequenceGap === undefined
        ? {}
        : { onSequenceGap: options.onSequenceGap }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onFatalError === undefined
        ? {}
        : { onFatalError: options.onFatalError }),
    });
    options.endpoint.removeEventListener("message", buffer);
    for (const message of queued) attached.runtime.dispatch(message);
    return attached;
  } catch (error) {
    options.endpoint.removeEventListener("message", buffer);
    reportWorkerFailure(options.endpoint, error);
    throw error;
  }
}
