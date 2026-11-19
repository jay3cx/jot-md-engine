import type {
  AnalysisState,
  AnalysisUpdate,
  DocumentPatch,
  RenderPatch,
  Revision,
  TextEdit,
  TransactionId,
  TransactionOrigin,
} from "@jot-md/editor-protocol";
import type { AdapterEffect, EditorProtocolEvent } from "../adapter/index.js";
import type { CodeMirrorInputTransaction } from "../hosts/source/codemirror-source.js";
import type { EditorSurfaceCommitEvent } from "../hosts/preview/surface.js";

export type EditorOperationKind = "open" | "transaction" | "projection" | "analysis" | "command";
export type EditorOperationStatus = "pending" | "complete" | "failed";
export type EditorOperationStageKind =
  | "input"
  | "request"
  | "response"
  | "document"
  | "analysis"
  | "render"
  | "error";

export interface EditorOperationStage {
  readonly kind: EditorOperationStageKind;
  readonly atMs: number;
  readonly elapsedMs: number;
  readonly summary: string;
  readonly requestId?: number;
  readonly detail?: unknown;
}

export interface EditorOperationMetrics {
  readonly editCount?: number;
  readonly insertedUtf16?: number;
  readonly removedUtf16?: number;
  readonly protocolRoundTripMs?: number;
  readonly changedBlocks?: number;
  readonly totalBlocks?: number;
  readonly renderOperations?: number;
  readonly renderedNodes?: number;
  readonly engineElapsedMicros?: number;
  readonly surfaceFilterMs?: number;
  readonly surfaceCommitMs?: number;
  readonly filteredItems?: number;
  readonly mountedItems?: number;
  readonly truncatedItems?: number;
  /** PreText 估算与首次 DOM 实测之间的偏差诊断。 */
  readonly measuredItems?: number;
  readonly estimatedHeightErrorPx?: number;
  readonly estimatedHeightAbsErrorPx?: number;
  readonly estimatedHeightMaxErrorPx?: number;
}

/**
 * 一个逻辑组件操作。订阅者收到的是具有相同 `id` 的不可变替换快照；更新同一行
 * 优于为每个阶段追加新行。
 */
export interface EditorOperationTrace {
  readonly id: string;
  readonly kind: EditorOperationKind;
  readonly status: EditorOperationStatus;
  readonly startedAtMs: number;
  readonly completedAtMs?: number;
  readonly durationMs?: number;
  readonly correlationId?: string;
  readonly requestIds: readonly number[];
  readonly transactionId?: TransactionId;
  readonly origin?: TransactionOrigin;
  readonly baseRevision?: Revision;
  readonly revision?: Revision;
  readonly inputVersion?: number;
  readonly edits?: readonly TextEdit[];
  readonly documentPatch?: DocumentPatch;
  readonly analysis?: AnalysisState;
  readonly analysisUpdates: readonly AnalysisUpdate[];
  readonly renderPatches: readonly RenderPatch[];
  readonly metrics: EditorOperationMetrics;
  readonly stages: readonly EditorOperationStage[];
  readonly error?: string;
}

export interface EditorEventObserverOptions {
  readonly maxOperations?: number;
  readonly onOperation?: (operation: EditorOperationTrace) => void;
  readonly onError?: (error: unknown) => void;
  /** 可注入的单调时钟，用于确定性测试和非浏览器宿主。 */
  readonly clock?: () => number;
}

interface MutableOperation {
  id: string;
  kind: EditorOperationKind;
  status: EditorOperationStatus;
  startedAtMs: number;
  completedAtMs?: number;
  correlationId?: string;
  requestIds: number[];
  transactionId?: TransactionId;
  origin?: TransactionOrigin;
  baseRevision?: Revision;
  revision?: Revision;
  inputVersion?: number;
  edits?: readonly TextEdit[];
  documentPatch?: DocumentPatch;
  analysis?: AnalysisState;
  analysisUpdates: AnalysisUpdate[];
  renderPatches: RenderPatch[];
  metrics: EditorOperationMetrics;
  stages: EditorOperationStage[];
  error?: string;
}

/** 按身份聚合组件输入、wire 消息和已接受的 effect。 */
export class EditorEventObserver {
  readonly #maxOperations: number;
  readonly #onOperation: ((operation: EditorOperationTrace) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #clock: () => number;
  readonly #listeners = new Set<(operation: EditorOperationTrace) => void>();
  readonly #operations = new Map<string, MutableOperation>();
  readonly #orderedIds: string[] = [];
  readonly #requestToOperation = new Map<number, string>();
  readonly #requestStartedAt = new Map<number, number>();
  readonly #transactionToOperation = new Map<TransactionId, string>();
  readonly #revisionToOperation = new Map<number, string>();
  readonly #effectIdentityToOperation = new WeakMap<object, string>();
  #sequence = 0;
  #disposed = false;

  constructor(options: EditorEventObserverOptions = {}) {
    this.#maxOperations = Math.max(1, options.maxOperations ?? 200);
    this.#onOperation = options.onOperation;
    this.#onError = options.onError;
    this.#clock = options.clock ?? monotonicNow;
  }

  get snapshot(): readonly EditorOperationTrace[] {
    return this.#orderedIds.flatMap((id) => {
      const operation = this.#operations.get(id);
      return operation === undefined ? [] : [freezeOperation(operation)];
    });
  }

  subscribe(listener: (operation: EditorOperationTrace) => void): () => void {
    this.#assertLive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clear(): void {
    this.#assertLive();
    this.#operations.clear();
    this.#orderedIds.length = 0;
    this.#requestToOperation.clear();
    this.#requestStartedAt.clear();
    this.#transactionToOperation.clear();
    this.#revisionToOperation.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#listeners.clear();
    this.#disposed = true;
  }

  acceptInput(event: CodeMirrorInputTransaction): void {
    if (this.#disposed) return;
    const correlationId = `codemirror-${event.version}`;
    const now = this.#clock();
    const operation = this.#operation(correlationId, "transaction", now);
    operation.correlationId = correlationId;
    operation.inputVersion = event.version;
    operation.origin = event.origin;
    operation.edits = event.edits;
    operation.metrics = {
      ...operation.metrics,
      ...editMetrics(event.edits),
    };
    this.#stage(operation, "input", now, `${event.origin} · ${event.edits.length} edit(s)`, {
      detail: event,
    });
    this.#emit(operation);
  }

  acceptProtocol(event: EditorProtocolEvent): void {
    if (this.#disposed) return;
    const now = this.#clock();
    if (event.direction === "request") {
      const request = event.message;
      const body = request.body;
      let operation: MutableOperation;
      if (body.type === "apply-transaction") {
        const correlationId = body.transaction.metadata?.correlationId;
        operation = this.#operation(
          correlationId ?? String(body.transaction.id),
          "transaction",
          now,
        );
        if (correlationId !== undefined) operation.correlationId = correlationId;
        operation.transactionId = body.transaction.id;
        operation.origin = body.transaction.origin;
        operation.baseRevision = body.transaction.baseRevision;
        operation.edits ??= body.transaction.edits;
        operation.metrics = {
          ...editMetrics(body.transaction.edits),
          ...operation.metrics,
        };
        this.#transactionToOperation.set(body.transaction.id, operation.id);
      } else {
        operation = this.#operation(
          `request:${request.requestId}`,
          requestKind(body.type),
          now,
        );
      }
      if (!operation.requestIds.includes(request.requestId)) {
        operation.requestIds.push(request.requestId);
      }
      this.#requestToOperation.set(request.requestId, operation.id);
      this.#requestStartedAt.set(request.requestId, now);
      this.#stage(operation, "request", now, body.type, {
        requestId: request.requestId,
        detail: request,
      });
      this.#emit(operation);
      return;
    }

    const response = event.message;
    const operation = this.#operationForResponse(response.requestId, response.body.type, now);
    const requestStartedAt = this.#requestStartedAt.get(response.requestId);
    if (requestStartedAt !== undefined) {
      operation.metrics = {
        ...operation.metrics,
        protocolRoundTripMs: now - requestStartedAt,
      };
      this.#requestStartedAt.delete(response.requestId);
    }
    this.#stage(operation, "response", now, `${response.body.type} · ${event.channel}`, {
      requestId: response.requestId,
      detail: response,
    });
    if (response.body.type === "transaction-committed") {
      this.#acceptDocumentPatch(operation, response.body.patch);
      operation.analysis = response.body.analysis;
      this.#effectIdentityToOperation.set(response.body.patch, operation.id);
      this.#effectIdentityToOperation.set(response.body.analysis, operation.id);
      if (response.body.renderPatch !== undefined) {
        this.#effectIdentityToOperation.set(response.body.renderPatch, operation.id);
        this.#acceptRenderPatch(operation, response.body.renderPatch, false);
      }
    } else if (response.body.type === "projection-ready") {
      this.#effectIdentityToOperation.set(response.body.patch, operation.id);
      this.#acceptRenderPatch(operation, response.body.patch, false);
    } else if (response.body.type === "analysis-state-changed") {
      operation.analysis = response.body.analysis;
      this.#effectIdentityToOperation.set(response.body.analysis, operation.id);
      if (response.body.update !== undefined) {
        this.#effectIdentityToOperation.set(response.body.update, operation.id);
        this.#acceptAnalysisUpdate(operation, response.body.update, false);
      }
    } else if (response.body.type === "document-opened") {
      operation.revision = response.body.revision;
      operation.analysis = response.body.analysis;
      this.#revisionToOperation.set(Number(response.body.revision), operation.id);
      this.#effectIdentityToOperation.set(response.body.analysis, operation.id);
    } else if (response.body.type === "failure") {
      operation.status = "failed";
      operation.error = response.body.error.message;
      operation.completedAtMs = now;
      this.#stage(operation, "error", now, response.body.error.message, {
        requestId: response.requestId,
        detail: response.body.error,
      });
    }
    this.#emit(operation);
  }

  acceptEffect(effect: AdapterEffect): void {
    if (this.#disposed) return;
    const now = this.#clock();
    const identity = effect.documentPatch ?? effect.renderPatch ??
      effect.analysisUpdate ?? effect.analysis;
    const identityOperationId = identity === undefined
      ? undefined
      : this.#effectIdentityToOperation.get(identity);
    let operation = identityOperationId === undefined
      ? undefined
      : this.#operations.get(identityOperationId);
    operation ??= effect.documentPatch === undefined
      ? undefined
      : this.#findByTransaction(effect.documentPatch.transactionId);
    const targetRevision = effect.documentPatch?.revision ??
      effect.analysisUpdate?.targetRevision ?? effect.analysis?.targetRevision ??
      effect.renderPatch?.documentRevision;
    operation ??= targetRevision === undefined
      ? undefined
      : this.#findByRevision(targetRevision);
    operation ??= this.#operation(
      `effect:${targetRevision === undefined ? ++this.#sequence : String(targetRevision)}`,
      effect.analysisUpdate === undefined && effect.analysis === undefined
        ? "projection"
        : "analysis",
      now,
    );

    if (effect.documentPatch !== undefined) {
      this.#acceptDocumentPatch(operation, effect.documentPatch);
      this.#stage(operation, "document", now,
        `r${effect.documentPatch.baseRevision} → r${effect.documentPatch.revision}`, {
          detail: effect.documentPatch,
        });
      operation.status = "complete";
      operation.completedAtMs = now;
    }
    if (effect.analysisUpdate !== undefined) {
      this.#acceptAnalysisUpdate(operation, effect.analysisUpdate, true);
    } else if (effect.analysis !== undefined) {
      operation.analysis = effect.analysis;
      this.#stage(operation, "analysis", now,
        `${effect.analysis.state} · sequence ${effect.analysis.sequence}`, {
          detail: effect.analysis,
        });
    }
    if (effect.renderPatch !== undefined) {
      this.#acceptRenderPatch(operation, effect.renderPatch, true);
    }
    if (effect.documentPatch === undefined && operation.kind !== "transaction") {
      operation.status = "complete";
      operation.completedAtMs ??= now;
    }
    this.#emit(operation);
  }

  acceptSurfaceCommit(event: EditorSurfaceCommitEvent): void {
    if (this.#disposed) return;
    // 纯滚动提交不应制造业务事件；首次 DOM 测量携带的误差指标例外，必须
    // 回填到同一 revision 的 trace，否则 Benchmark 看不到估算偏差。
    if (event.reason === "viewport" && event.measuredItems === 0) return;
    const now = this.#clock();
    let operation = event.reason === "mode"
      ? undefined
      : this.#findByRevision(event.revision);
    operation ??= this.#operation(
      `surface:${event.reason}:${event.viewRevision}:${++this.#sequence}`,
      event.reason === "projection" ? "projection" : "command",
      now,
    );
    operation.revision ??= event.revision;
    operation.metrics = {
      ...operation.metrics,
      surfaceFilterMs: event.filterDurationMs,
      surfaceCommitMs: event.commitDurationMs,
      filteredItems: event.filteredItems,
      mountedItems: event.mountedItems,
      truncatedItems: event.truncatedItems,
      measuredItems: event.measuredItems,
      estimatedHeightErrorPx: event.estimatedHeightErrorPx,
      estimatedHeightAbsErrorPx: event.estimatedHeightAbsErrorPx,
      estimatedHeightMaxErrorPx: event.estimatedHeightMaxErrorPx,
    };
    this.#stage(
      operation,
      "render",
      now,
      `${event.mode} commit · ${event.mountedItems} mounted`,
      { detail: event },
    );
    operation.status = "complete";
    operation.completedAtMs = now;
    this.#emit(operation);
  }

  #acceptDocumentPatch(operation: MutableOperation, patch: DocumentPatch): void {
    operation.transactionId = patch.transactionId;
    operation.baseRevision = patch.baseRevision;
    operation.revision = patch.revision;
    operation.documentPatch = patch;
    operation.metrics = {
      ...operation.metrics,
      ...(patch.syntax?.changedBlocks === undefined
        ? {}
        : { changedBlocks: patch.syntax.changedBlocks }),
      ...(patch.syntax?.totalBlocks === undefined
        ? {}
        : { totalBlocks: patch.syntax.totalBlocks }),
    };
    this.#transactionToOperation.set(patch.transactionId, operation.id);
    this.#revisionToOperation.set(Number(patch.revision), operation.id);
  }

  #acceptAnalysisUpdate(
    operation: MutableOperation,
    update: AnalysisUpdate,
    addStage: boolean,
  ): void {
    if (!operation.analysisUpdates.some((candidate) => candidate.sequence === update.sequence)) {
      operation.analysisUpdates.push(update);
    }
    operation.metrics = {
      ...operation.metrics,
      ...(update.syntax?.changedBlocks === undefined
        ? {}
        : { changedBlocks: update.syntax.changedBlocks }),
      ...(update.syntax?.totalBlocks === undefined
        ? {}
        : { totalBlocks: update.syntax.totalBlocks }),
      engineElapsedMicros: update.metrics.elapsedMicros,
    };
    this.#revisionToOperation.set(Number(update.targetRevision), operation.id);
    if (addStage) {
      const now = this.#clock();
      this.#stage(operation, "analysis", now,
        `sequence ${update.sequence} · ${update.metrics.elapsedMicros}µs`, {
          detail: update,
        });
    }
  }

  #acceptRenderPatch(
    operation: MutableOperation,
    patch: RenderPatch,
    addStage: boolean,
  ): void {
    if (!operation.renderPatches.some((candidate) =>
      candidate.documentRevision === patch.documentRevision &&
      candidate.viewRevision === patch.viewRevision &&
      candidate.operations === patch.operations
    )) {
      operation.renderPatches.push(patch);
    }
    operation.metrics = {
      ...operation.metrics,
      renderOperations: patch.operations.length,
      renderedNodes: patch.operations.reduce(
        (count, item) => count + item.inserted.length,
        0,
      ),
    };
    this.#revisionToOperation.set(Number(patch.documentRevision), operation.id);
    if (addStage) {
      const now = this.#clock();
      this.#stage(operation, "render", now,
        `${patch.operations.length} operation(s) · view ${patch.viewRevision}`, {
          detail: patch,
        });
    }
  }

  #operationForResponse(requestId: number, responseType: string, now: number): MutableOperation {
    const operationId = this.#requestToOperation.get(requestId);
    if (operationId !== undefined) {
      const operation = this.#operations.get(operationId);
      if (operation !== undefined) return operation;
    }
    return this.#operation(
      `response:${requestId}`,
      responseType === "analysis-state-changed" ? "analysis" : "command",
      now,
    );
  }

  #findByTransaction(transactionId: TransactionId): MutableOperation | undefined {
    const id = this.#transactionToOperation.get(transactionId);
    return id === undefined ? undefined : this.#operations.get(id);
  }

  #findByRevision(revision: Revision): MutableOperation | undefined {
    const id = this.#revisionToOperation.get(Number(revision));
    return id === undefined ? undefined : this.#operations.get(id);
  }

  #operation(id: string, kind: EditorOperationKind, now: number): MutableOperation {
    const existing = this.#operations.get(id);
    if (existing !== undefined) return existing;
    const operation: MutableOperation = {
      id,
      kind,
      status: "pending",
      startedAtMs: now,
      requestIds: [],
      analysisUpdates: [],
      renderPatches: [],
      metrics: {},
      stages: [],
    };
    this.#operations.set(id, operation);
    this.#orderedIds.unshift(id);
    this.#prune();
    return operation;
  }

  #stage(
    operation: MutableOperation,
    kind: EditorOperationStageKind,
    now: number,
    summary: string,
    options: { readonly requestId?: number; readonly detail?: unknown } = {},
  ): void {
    operation.stages.push({
      kind,
      atMs: now,
      elapsedMs: now - operation.startedAtMs,
      summary,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    });
  }

  #emit(operation: MutableOperation): void {
    const snapshot = freezeOperation(operation);
    try {
      this.#onOperation?.(snapshot);
    } catch (error) {
      this.#onError?.(error);
    }
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#onError?.(error);
      }
    }
  }

  #prune(): void {
    while (this.#orderedIds.length > this.#maxOperations) {
      const id = this.#orderedIds.pop();
      if (id === undefined) return;
      const operation = this.#operations.get(id);
      this.#operations.delete(id);
      if (operation?.transactionId !== undefined) {
        this.#transactionToOperation.delete(operation.transactionId);
      }
      if (operation?.revision !== undefined) {
        this.#revisionToOperation.delete(Number(operation.revision));
      }
      for (const requestId of operation?.requestIds ?? []) {
        this.#requestToOperation.delete(requestId);
        this.#requestStartedAt.delete(requestId);
      }
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("editor event observer disposed");
  }
}

function freezeOperation(operation: MutableOperation): EditorOperationTrace {
  return {
    ...operation,
    ...(operation.completedAtMs === undefined
      ? {}
      : { durationMs: operation.completedAtMs - operation.startedAtMs }),
    requestIds: [...operation.requestIds],
    ...(operation.edits === undefined ? {} : { edits: [...operation.edits] }),
    analysisUpdates: [...operation.analysisUpdates],
    renderPatches: [...operation.renderPatches],
    metrics: { ...operation.metrics },
    stages: operation.stages.map((stage) => ({ ...stage })),
  };
}

function editMetrics(edits: readonly TextEdit[]): EditorOperationMetrics {
  return {
    editCount: edits.length,
    insertedUtf16: edits.reduce((count, edit) => count + edit.insert.length, 0),
    removedUtf16: edits.reduce(
      (count, edit) => count + Number(edit.range.to) - Number(edit.range.from),
      0,
    ),
  };
}

function requestKind(type: string): EditorOperationKind {
  if (type === "open-document") return "open";
  if (type === "project") return "projection";
  if (type.includes("analysis")) return "analysis";
  return "command";
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
