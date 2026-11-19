import {
  FRONTEND_REQUEST_ID_MAX,
  WORKER_REQUEST_ID_MIN,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ProjectionSlice,
} from "@jot-md/editor-protocol";

import {
  EditorDocumentAdapter,
  type AdapterEffect,
  type EditorDocumentAdapterOptions,
  type EditorEditIntent,
} from "./document-adapter.js";
import type { EditorViewport } from "./analysis-policy.js";

export interface EditorClientEndpoint {
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

export type EditorProtocolEvent =
  | {
      readonly direction: "request";
      readonly message: RequestEnvelope;
    }
  | {
      readonly direction: "response";
      readonly channel: "foreground" | "background";
      readonly message: ResponseEnvelope;
    };

export interface EditorDocumentSessionOptions extends EditorDocumentAdapterOptions {
  /** Dedicated to this session. The caller terminates its Worker after disposal. */
  readonly endpoint: EditorClientEndpoint;
  readonly onBackgroundEffect?: (effect: AdapterEffect) => void;
  /** 供诊断和开发工具使用的只读协议旁路。 */
  readonly onProtocolEvent?: (event: EditorProtocolEvent) => void;
  readonly onError?: (error: unknown) => void;
}

// Request IDs restart in each session. A disposed endpoint may still deliver its last response.
const claimedEndpoints = new WeakSet<EditorClientEndpoint>();

/** 将一个文档适配器连接到 Editor Worker 的前端一侧。 */
export class EditorDocumentSession {
  readonly adapter: EditorDocumentAdapter;
  readonly #endpoint: EditorClientEndpoint;
  readonly #onBackgroundEffect: ((effect: AdapterEffect) => void) | undefined;
  readonly #onProtocolEvent: ((event: EditorProtocolEvent) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #listeners = new Set<(effect: AdapterEffect) => void>();
  // Ownership is deliberately out-of-band: effects retain their public shape
  // and stay structured-cloneable for host applications.
  readonly #requestOwners = new WeakMap<AdapterEffect, symbol>();
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (response: ResponseEnvelope) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  readonly #listener: (event: MessageEvent<unknown>) => void;
  #stopped: Error | undefined;
  readonly #workerError = (event: Event) => {
    const message = "message" in event && typeof event.message === "string" ? event.message : event.type;
    this.#fail(new Error(`Editor Worker: ${message}`));
  };

  constructor(options: EditorDocumentSessionOptions) {
    if (claimedEndpoints.has(options.endpoint)) throw new Error("each editor session requires a dedicated Worker endpoint");
    this.adapter = new EditorDocumentAdapter(options);
    this.#endpoint = options.endpoint;
    this.#onBackgroundEffect = options.onBackgroundEffect;
    this.#onProtocolEvent = options.onProtocolEvent;
    this.#onError = options.onError;
    this.#listener = (event) => this.#receive(event.data);
    this.#endpoint.addEventListener("message", this.#listener);
    if (this.#endpoint instanceof EventTarget) {
      this.#endpoint.addEventListener("error", this.#workerError);
      this.#endpoint.addEventListener("messageerror", this.#workerError);
    }
    claimedEndpoints.add(this.#endpoint);
  }

  get terminalError(): Error | undefined {
    return this.#stopped;
  }

  /** 查询 Worker 的协议与能力，握手无需先打开文档。 */
  handshake(): Promise<AdapterEffect> {
    return this.#send(this.adapter.handshake());
  }

  /** 创建新文档代次，首屏范围作为初次分析的优先区间。 */
  open(viewport: EditorViewport): Promise<AdapterEffect> {
    return this.#send(this.adapter.open(viewport));
  }

  /** 提交当前确认版本上的编辑。确认响应由适配层应用到文本及投影。 */
  transact(intent: EditorEditIntent): Promise<AdapterEffect> {
    if (this.#stopped) return Promise.reject(this.#stopped);
    return this.#send(this.adapter.transaction(intent));
  }

  project(slices: readonly ProjectionSlice[], options?: { readonly owner?: symbol }): Promise<AdapterEffect> {
    return this.#send(this.adapter.project(slices), options?.owner);
  }

  /** 区分共享投影缓存中，本宿主发起的请求和其他宿主触发的更新。 */
  ownsProjection(effect: AdapterEffect, owner: symbol): boolean {
    return this.#requestOwners.get(effect) === owner;
  }

  projectRoot(from: number, toExclusive: number, maxDepth = 0): Promise<AdapterEffect> {
    return this.#send(this.adapter.projectRoot(from, toExclusive, maxDepth));
  }

  projectSourceLines(
    parentId: string,
    from: number,
    toExclusive: number,
  ): Promise<AdapterEffect> {
    return this.#send(this.adapter.projectSourceLines(parentId, from, toExclusive));
  }

  projectAround(
    parentId: string,
    axis: ProjectionSlice["axis"],
    range: import("@jot-md/editor-protocol").TextRange,
    before: number,
    after: number,
    maxDepth = 0,
  ): Promise<AdapterEffect> {
    return this.#send(
      this.adapter.projectAround(parentId, axis, range, before, after, maxDepth),
    );
  }

  subscribe(listener: (effect: AdapterEffect) => void): () => void {
    if (this.#stopped) throw this.#stopped;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#stop(new Error("editor document session disposed"));
  }

  #fail(error: Error): void {
    if (this.#stopped) return;
    this.#stop(error);
    this.#onError?.(error);
  }

  #stop(error: Error): void {
    if (this.#stopped) return;
    this.#stopped = error;
    if (this.#endpoint instanceof EventTarget) {
      this.#endpoint.removeEventListener("error", this.#workerError);
      this.#endpoint.removeEventListener("messageerror", this.#workerError);
    }
    this.#endpoint.removeEventListener("message", this.#listener);
    this.adapter.discardPendingTransactions();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#listeners.clear();
  }

  #send(request: RequestEnvelope, requestOwner?: symbol): Promise<AdapterEffect> {
    if (this.#stopped) return Promise.reject(this.#stopped);
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject });
      this.#emitProtocolEvent({ direction: "request", message: request });
      try {
        this.#endpoint.postMessage(request);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((response) => {
      const effect = this.adapter.accept(response);
      if (requestOwner !== undefined) this.#requestOwners.set(effect, requestOwner);
      this.#notify(effect);
      return effect;
    });
  }

  #receive(value: unknown): void {
    if (typeof value === "object" && value !== null && "type" in value && value.type === "editor-worker-fatal" &&
        "message" in value && typeof value.message === "string") {
      this.#fail(new Error(value.message));
      return;
    }
    if (!isResponse(value)) {
      this.#onError?.(new TypeError("invalid Editor Worker response"));
      return;
    }
    this.#emitProtocolEvent({
      direction: "response",
      channel: value.requestId <= FRONTEND_REQUEST_ID_MAX
        ? "foreground"
        : "background",
      message: value,
    });
    if (value.requestId <= FRONTEND_REQUEST_ID_MAX) {
      const pending = this.#pending.get(value.requestId);
      if (pending === undefined) return;
      this.#pending.delete(value.requestId);
      pending.resolve(value);
      return;
    }
    if (value.requestId >= WORKER_REQUEST_ID_MIN) {
      try {
        const effect = this.adapter.accept(value);
        this.#onBackgroundEffect?.(effect);
        this.#notify(effect);
      } catch (error) {
        this.#onError?.(error);
      }
    }
  }

  #notify(effect: AdapterEffect): void {
    for (const listener of this.#listeners) {
      try {
        listener(effect);
      } catch (error) {
        this.#onError?.(error);
      }
    }
  }

  #emitProtocolEvent(event: EditorProtocolEvent): void {
    try {
      this.#onProtocolEvent?.(event);
    } catch (error) {
      this.#onError?.(error);
    }
  }
}

function isResponse(value: unknown): value is ResponseEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "number" &&
    "body" in value &&
    typeof value.body === "object" &&
    value.body !== null
  );
}
