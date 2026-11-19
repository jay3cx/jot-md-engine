import {
  PROTOCOL_VERSION,
  WORKER_REQUEST_ID_MAX,
  WORKER_REQUEST_ID_MIN,
  type AnalysisId,
  type AnalysisState,
  type AnalysisUpdate,
  type AnalysisWorkBudget,
  type DocumentId,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Revision,
} from "@jot-md/editor-protocol";

export interface AnalysisPumpTransport {
  readonly send: (request: RequestEnvelope) => Promise<ResponseEnvelope>;
  readonly nextRequestId: () => number;
}

export interface AnalysisPumpHooks {
  /** 接收完成身份校验后被接受的 pump/status 响应。 */
  readonly onResponse?: (response: ResponseEnvelope) => void;
  readonly onSequenceGap?: (input: {
    readonly documentId: DocumentId;
    readonly expected: number;
    readonly actual: number;
  }) => void;
  readonly onError?: (error: unknown) => void;
}

export interface AnalysisPumpOptions extends AnalysisPumpHooks {
  readonly transport: AnalysisPumpTransport;
  readonly budget: AnalysisWorkBudget;
  /** 每个已调度回调最多执行一次 Wasm 队列轮询。 */
  readonly scheduleTask?: (task: () => void) => void;
}

/** 从 protocol 为 Worker 保留的 u32 地址空间半区分配 ID。 */
export function createWorkerRequestIdAllocator(): () => number {
  let next: number = WORKER_REQUEST_ID_MIN;
  return () => {
    const current = next;
    next = next === WORKER_REQUEST_ID_MAX ? WORKER_REQUEST_ID_MIN : next + 1;
    return current;
  };
}

interface PendingAnalysis {
  readonly documentId: DocumentId;
  readonly generation: number;
  readonly revision: Revision;
  readonly analysisId: AnalysisId;
  sequence: number;
  inFlight: boolean;
}

/**
 * Worker 使用的串行 round-robin Analysis 队列驱动器。
 *
 * 调度器绝不会在循环中耗尽 Wasm。一个待处理响应只调度一个 task；该 task
 * 只发送一次 `process-analysis-queue` 请求。下一次轮询前，更新的
 * generation/revision/analysisId 会替换旧条目。
 */
export class AnalysisPumpScheduler {
  readonly #transport: AnalysisPumpTransport;
  readonly #budget: AnalysisWorkBudget;
  readonly #scheduleTask: (task: () => void) => void;
  readonly #taskChannel: MessageChannel | undefined;
  readonly #hooks: AnalysisPumpHooks;
  readonly #documents = new Map<string, PendingAnalysis>();
  readonly #ready: string[] = [];
  readonly #readySet = new Set<string>();
  #taskScheduled = false;
  #running = false;
  #disposed = false;

  constructor(options: AnalysisPumpOptions) {
    this.#transport = options.transport;
    this.#budget = options.budget;
    if (options.scheduleTask !== undefined) {
      this.#scheduleTask = options.scheduleTask;
    } else if (typeof MessageChannel !== "undefined") {
      // A real task boundary lets transactions interrupt analysis, without the
      // nested setTimeout minimum delay accumulating across hundreds of slices.
      const channel = new MessageChannel();
      this.#taskChannel = channel;
      const tasks: Array<() => void> = [];
      channel.port1.onmessage = () => tasks.shift()?.();
      this.#scheduleTask = (task) => {
        tasks.push(task);
        channel.port2.postMessage(null);
      };
    } else {
      this.#scheduleTask = (task) => setTimeout(task, 0);
    }
    this.#hooks = options;
    assertPositiveBudget(this.#budget);
  }

  /**
   * 观察 Worker 路由的 document-opened、transaction-committed 或
   * analysis-state-changed 响应。
   */
  observe(response: ResponseEnvelope): void {
    if (this.#disposed || response.protocolVersion !== PROTOCOL_VERSION) return;
    const documentId = response.documentId;
    if (documentId === undefined) return;
    const body = response.body;
    if (
      body.type !== "document-opened" &&
      body.type !== "transaction-committed" &&
      body.type !== "analysis-state-changed"
    ) {
      return;
    }
    this.#observeState(documentId, response.generation, body.analysis);
  }

  /** 停止本地 pump；Rust 侧的关闭/取消仍通过普通命令完成。 */
  forget(documentId: DocumentId, generation?: number): void {
    const key = documentKey(documentId);
    const current = this.#documents.get(key);
    if (current && (generation === undefined || current.generation === generation)) {
      this.#documents.delete(key);
      this.#dropReady(key);
    }
  }

  hasPending(documentId: DocumentId): boolean {
    return this.#documents.has(documentKey(documentId));
  }

  dispose(): void {
    this.#disposed = true;
    this.#taskChannel?.port1.close();
    this.#taskChannel?.port2.close();
    this.#documents.clear();
    this.#ready.length = 0;
    this.#readySet.clear();
  }

  #observeState(
    documentId: DocumentId,
    generation: number,
    state: AnalysisState,
  ): void {
    const key = documentKey(documentId);
    const current = this.#documents.get(key);
    if (current) {
      if (generation < current.generation) return;
      if (
        generation === current.generation &&
        Number(state.targetRevision) < Number(current.revision)
      ) {
        return;
      }
    }

    if (state.state !== "pending") {
      if (
        current &&
        generation === current.generation &&
        state.targetRevision === current.revision &&
        state.analysisId !== current.analysisId
      ) {
        return;
      }
      if (current) {
        this.#documents.delete(key);
        this.#dropReady(key);
      }
      return;
    }

    if (
      current &&
      generation === current.generation &&
      state.targetRevision === current.revision &&
      state.analysisId === current.analysisId
    ) {
      current.sequence = Math.max(current.sequence, state.sequence);
      this.#enqueue(key, current);
      return;
    }

    const pending: PendingAnalysis = {
      documentId,
      generation,
      revision: state.targetRevision,
      analysisId: state.analysisId,
      sequence: state.sequence,
      inFlight: false,
    };
    this.#documents.set(key, pending);
    this.#enqueue(key, pending);
  }

  #enqueue(key: string, pending: PendingAnalysis): void {
    if (this.#disposed || this.#readySet.has(key) || pending.inFlight) return;
    this.#readySet.add(key);
    this.#ready.push(key);
    this.#ensureTask();
  }

  #dropReady(key: string): void {
    this.#readySet.delete(key);
    for (let index = this.#ready.length - 1; index >= 0; index -= 1) {
      if (this.#ready[index] === key) this.#ready.splice(index, 1);
    }
  }

  #ensureTask(): void {
    if (
      this.#disposed ||
      this.#running ||
      this.#taskScheduled ||
      this.#ready.length === 0
    ) {
      return;
    }
    this.#taskScheduled = true;
    this.#scheduleTask(() => {
      void this.#runOne();
    });
  }

  async #runOne(): Promise<void> {
    this.#taskScheduled = false;
    if (this.#disposed || this.#running) return;
    this.#running = true;
    const key = this.#ready.shift();
    if (key === undefined) {
      this.#running = false;
      this.#ensureTask();
      return;
    }
    this.#readySet.delete(key);
    const pending = this.#documents.get(key);
    if (!pending) {
      this.#running = false;
      this.#ensureTask();
      return;
    }
    if (pending.inFlight) {
      this.#running = false;
      this.#ensureTask();
      return;
    }
    pending.inFlight = true;
    const request: RequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: this.#transport.nextRequestId(),
      generation: pending.generation,
      documentId: pending.documentId,
      body: {
        type: "process-analysis-queue",
        revision: pending.revision,
        analysisId: pending.analysisId,
        budget: this.#budget,
      },
    };

    try {
      const response = await this.#transport.send(request);
      if (!isMatchingResponse(request, response)) {
        throw new Error("analysis pump response identity mismatch");
      }
      // Wasm 让出执行权等待 Promise 期间，文档可能已经提交了更新 revision。
      // 这条响应对自己的请求仍然有效，但已经不能再发布给前端。
      if (this.#documents.get(key) !== pending) return;
      const body = response.body;
      if (body.type === "analysis-state-changed") {
        const update = body.update;
        if (update && !isMatchingUpdate(pending, update)) {
          throw new Error("analysis update identity mismatch");
        }
        if (update && update.sequence <= pending.sequence) {
          this.#observeState(
            pending.documentId,
            pending.generation,
            body.analysis,
          );
        } else if (update && update.sequence > pending.sequence + 1) {
          this.#hooks.onSequenceGap?.({
            documentId: pending.documentId,
            expected: pending.sequence + 1,
            actual: update.sequence,
          });
          await this.#recoverStatus(pending);
        } else {
          this.#hooks.onResponse?.(response);
          this.#observeState(
            pending.documentId,
            pending.generation,
            body.analysis,
          );
        }
      } else if (body.type === "failure") {
        this.#hooks.onResponse?.(response);
        // 失败的精确 pump 不能触发忙等循环；后续普通响应或显式 status 请求
        // 可以再次登记这个文档。
        if (this.#documents.get(key) === pending) {
          this.#documents.delete(key);
          this.#dropReady(key);
        }
      }
    } catch (error) {
      if (this.#documents.get(key) === pending) {
        this.#documents.delete(key);
        this.#dropReady(key);
      }
      this.#hooks.onError?.(error);
    } finally {
      pending.inFlight = false;
      const latest = this.#documents.get(key);
      if (latest === pending) this.#enqueue(key, pending);
      this.#running = false;
      this.#ensureTask();
    }
  }

  async #recoverStatus(pending: PendingAnalysis): Promise<void> {
    const request: RequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: this.#transport.nextRequestId(),
      generation: pending.generation,
      documentId: pending.documentId,
      body: {
        type: "get-analysis-status",
        revision: pending.revision,
      },
    };
    const response = await this.#transport.send(request);
    if (!isMatchingResponse(request, response)) {
      throw new Error("analysis status response identity mismatch");
    }
    this.#hooks.onResponse?.(response);
    if (response.body.type === "analysis-state-changed") {
      this.#observeState(
        pending.documentId,
        pending.generation,
        response.body.analysis,
      );
    } else {
      const key = documentKey(pending.documentId);
      if (this.#documents.get(key) === pending) {
        this.#documents.delete(key);
        this.#dropReady(key);
      }
    }
  }
}

function isMatchingResponse(
  request: RequestEnvelope,
  response: ResponseEnvelope,
): boolean {
  return (
    response.protocolVersion === PROTOCOL_VERSION &&
    response.requestId === request.requestId &&
    response.generation === request.generation &&
    response.documentId === request.documentId
  );
}

function isMatchingUpdate(
  pending: PendingAnalysis,
  update: AnalysisUpdate,
): boolean {
  return (
    update.analysisId === pending.analysisId &&
    update.targetRevision === pending.revision
  );
}

function documentKey(documentId: DocumentId): string {
  return String(documentId);
}

function assertPositiveBudget(budget: AnalysisWorkBudget): void {
  if (
    budget.maxSourceLines <= 0 ||
    budget.maxBlocks <= 0 ||
    budget.maxUtf16Units <= 0
  ) {
    throw new RangeError("analysis work budget values must all be positive");
  }
}
