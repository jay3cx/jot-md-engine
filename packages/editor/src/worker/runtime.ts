import {
  FRONTEND_REQUEST_ID_MAX,
  PROTOCOL_VERSION,
  type AnalysisWorkBudget,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "@jot-md/editor-protocol";

import {
  AnalysisPumpScheduler,
  createWorkerRequestIdAllocator,
  type AnalysisPumpHooks,
} from "./analysis-pump.js";

/** wasm-bindgen 生成类对外暴露的最小接口。 */
export interface WasmEditorHost {
  handle(request: unknown): unknown;
}

export interface EditorWorkerEndpoint {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface EditorWorkerRuntimeOptions extends AnalysisPumpHooks {
  readonly host: WasmEditorHost;
  readonly endpoint: Pick<EditorWorkerEndpoint, "postMessage">;
  readonly backgroundBudget: AnalysisWorkBudget;
  readonly scheduleTask?: (task: () => void) => void;
  /** 无效入站消息和 Wasm 边界失败不是协议响应。 */
  readonly onFatalError?: (error: unknown) => void;
}

type DeferredHostAction =
  | {
      readonly type: "dispatch";
      readonly value: unknown;
    }
  | {
      readonly type: "invoke";
      readonly request: RequestEnvelope;
      readonly resolve: (response: ResponseEnvelope) => void;
      readonly reject: (error: unknown) => void;
    };

/**
 * 持有 Worker 中唯一的 Wasm Host 实例，并串行化后台工作。
 * 前端请求是同步 Wasm 调用；之后每个已调度 task 最多执行一次后台队列轮询。
 */
export class EditorWorkerRuntime {
  readonly #host: WasmEditorHost;
  readonly #endpoint: Pick<EditorWorkerEndpoint, "postMessage">;
  readonly #pump: AnalysisPumpScheduler;
  readonly #onFatalError: ((error: unknown) => void) | undefined;
  #invoking = false;
  #draining = false;
  #disposed = false;
  readonly #deferred: DeferredHostAction[] = [];

  constructor(options: EditorWorkerRuntimeOptions) {
    this.#host = options.host;
    this.#endpoint = options.endpoint;
    this.#onFatalError = options.onFatalError;
    this.#pump = new AnalysisPumpScheduler({
      budget: options.backgroundBudget,
      transport: {
        nextRequestId: createWorkerRequestIdAllocator(),
        send: (request) => this.#invokeWhenIdle(request),
      },
      onResponse: (response) => {
        this.#endpoint.postMessage(response);
        options.onResponse?.(response);
      },
      ...(options.scheduleTask === undefined
        ? {}
        : { scheduleTask: options.scheduleTask }),
      ...(options.onSequenceGap === undefined
        ? {}
        : { onSequenceGap: options.onSequenceGap }),
      onError: (error) => {
        this.#fail(error);
        options.onError?.(error);
      },
    });
  }

  /** 接收前端消息。Host 运行中收到的同步回调先入队，当前 Wasm 调用返回后再处理。 */
  dispatch(value: unknown): void {
    if (this.#disposed) return;
    // DedicatedWorker 通常按事件串行派发，但宿主回调、测试 endpoint 或
    // 第三方 Worker 适配器可能在 handle() 内同步触发下一条消息。不能让这条
    // 消息重新进入 wasm-bindgen 的同一个 &mut WasmEditorHost。
    if (this.#invoking || this.#draining) {
      this.#deferred.push({ type: "dispatch", value });
      return;
    }
    this.#dispatchNow(value);
  }

  #dispatchNow(value: unknown): void {
    try {
      const request = assertFrontendRequest(value);
      const response = this.#invoke(request);
      this.#endpoint.postMessage(response);
      if (
        request.body.type === "close-document" &&
        response.body.type === "document-closed" &&
        request.documentId !== undefined
      ) {
        this.#pump.forget(request.documentId, request.generation);
      } else {
        this.#pump.observe(response);
      }
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#drainDeferred();
    }
  }

  #fail(error: unknown): void {
    if (this.#disposed) return;
    this.dispose();
    reportWorkerFailure(this.#endpoint, error);
    this.#onFatalError?.(error);
  }

  hasPending(documentId: RequestEnvelope["documentId"]): boolean {
    return documentId !== undefined && this.#pump.hasPending(documentId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#pump.dispose();
    for (const action of this.#deferred) {
      if (action.type === "invoke") {
        action.reject(new Error("editor Worker runtime disposed"));
      }
    }
    this.#deferred.length = 0;
  }

  #invokeWhenIdle(request: RequestEnvelope): Promise<ResponseEnvelope> {
    if (this.#disposed) {
      return Promise.reject(new Error("editor Worker runtime disposed"));
    }
    if (!this.#invoking && !this.#draining) {
      try {
        return Promise.resolve(this.#invoke(request));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      this.#deferred.push({ type: "invoke", request, resolve, reject });
    });
  }

  #drainDeferred(): void {
    if (this.#disposed || this.#invoking || this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#disposed && this.#deferred.length > 0) {
        const action = this.#deferred.shift();
        if (action === undefined) continue;
        if (action.type === "dispatch") {
          this.#dispatchNow(action.value);
          continue;
        }
        try {
          action.resolve(this.#invoke(action.request));
        } catch (error) {
          action.reject(error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #invoke(request: RequestEnvelope): ResponseEnvelope {
    if (this.#invoking) {
      throw new Error(`reentrant Wasm request: ${request.body.type}`);
    }
    this.#invoking = true;
    try {
      let value: unknown;
      try {
        value = this.#host.handle(request);
      } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        throw new Error(`Wasm ${request.body.type} failed: ${detail}`);
      }
      const response = assertResponse(value);
      if (
        response.requestId !== request.requestId ||
        response.generation !== request.generation ||
        response.documentId !== request.documentId
      ) {
        throw new Error("Wasm response identity mismatch");
      }
      return response;
    } finally {
      this.#invoking = false;
    }
  }
}

export interface AttachedEditorWorker {
  readonly runtime: EditorWorkerRuntime;
  dispose(): void;
}

export function attachEditorWorker(
  endpoint: EditorWorkerEndpoint,
  options: Omit<EditorWorkerRuntimeOptions, "endpoint">,
): AttachedEditorWorker {
  const runtime = new EditorWorkerRuntime({ ...options, endpoint });
  const listener = (event: MessageEvent<unknown>) => {
    runtime.dispatch(event.data);
  };
  endpoint.addEventListener("message", listener);
  return {
    runtime,
    dispose() {
      endpoint.removeEventListener("message", listener);
      runtime.dispose();
    },
  };
}

/** A fatal transport notification carries no transaction outcome. */
export function reportWorkerFailure(endpoint: Pick<EditorWorkerEndpoint, "postMessage">, error: unknown): void {
  endpoint.postMessage({ type: "editor-worker-fatal", message: error instanceof Error ? error.message : String(error) });
}

function assertFrontendRequest(value: unknown): RequestEnvelope {
  if (!isRecord(value)) throw new TypeError("Worker message must be an object");
  const requestId = value.requestId;
  const generation = value.generation;
  if (
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isU32(requestId) ||
    requestId > FRONTEND_REQUEST_ID_MAX ||
    !isU32(generation) ||
    !isRecord(value.body) ||
    typeof value.body.type !== "string"
  ) {
    throw new TypeError("invalid frontend request envelope");
  }
  return value as unknown as RequestEnvelope;
}

function assertResponse(value: unknown): ResponseEnvelope {
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isU32(value.requestId) ||
    !isU32(value.generation) ||
    !isRecord(value.body) ||
    typeof value.body.type !== "string"
  ) {
    throw new TypeError("invalid Wasm response envelope");
  }
  return value as unknown as ResponseEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isU32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}
