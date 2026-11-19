import {
  FRONTEND_REQUEST_ID_MAX,
  PROTOCOL_VERSION,
  WORKER_REQUEST_ID_MIN,
  type AnalysisId,
  type AnalysisState,
  type AnalysisUpdate,
  type DocumentId,
  type RequestEnvelope,
  type ResponseBody,
  type ResponseEnvelope,
  type Revision,
  type Utf16Offset,
} from "../../../editor-protocol/src/index.js";
import {
  AnalysisPumpScheduler,
  bootstrapEditorWorker,
  EditorWorkerRuntime,
  type EditorWorkerEndpoint,
  type EditorWasmModule,
} from "../../src/worker/index.js";

const DOCUMENT = "document-a" as DocumentId;
const ANALYSIS_0 = "document-a:r0:a1" as AnalysisId;
const ANALYSIS_1 = "document-a:r1:a2" as AnalysisId;
const REVISION_0 = 0 as Revision;
const REVISION_1 = 1 as Revision;

async function default_scheduler_yields_and_disposes(): Promise<void> {
  let sent = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const scheduler = new AnalysisPumpScheduler({
    budget: { maxSourceLines: 4, maxBlocks: 2, maxUtf16Units: 128 },
    transport: {
      nextRequestId: workerIds(),
      send: async (request) => {
        sent += 1;
        return analysisResponse(request, sent === 3
          ? complete(REVISION_0, ANALYSIS_0, sent)
          : pending(REVISION_0, ANALYSIS_0, sent), sent);
      },
    },
    onResponse: () => { if (sent === 3) finish(); },
  });
  try {
    scheduler.observe(openedResponse(pending(REVISION_0, ANALYSIS_0, 0)));
    await flushAsync();
    equal(sent, 0, "analysis must yield a task boundary, not run as a microtask loop");
    await finished;
    equal(sent, 3, "default scheduler completes bounded slices");
    scheduler.observe(openedResponse(pending(REVISION_1, ANALYSIS_1, 0)));
    scheduler.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    equal(sent, 3, "disposing cancels the queued default task");
  } finally {
    scheduler.dispose();
  }
}

async function pump_runs_exactly_one_serial_slice_per_task(): Promise<void> {
  const tasks: Array<() => void> = [];
  const sent: RequestEnvelope[] = [];
  const published: ResponseEnvelope[] = [];
  const scheduler = new AnalysisPumpScheduler({
    budget: { maxSourceLines: 4, maxBlocks: 2, maxUtf16Units: 128 },
    scheduleTask: (task) => tasks.push(task),
    transport: {
      nextRequestId: workerIds(),
      send: async (request) => {
        sent.push(request);
        return sent.length === 1
          ? analysisResponse(request, pending(REVISION_0, ANALYSIS_0, 1), 1)
          : analysisResponse(request, complete(REVISION_0, ANALYSIS_0, 2), 2);
      },
    },
    onResponse: (response) => published.push(response),
  });

  scheduler.observe(openedResponse(pending(REVISION_0, ANALYSIS_0, 0)));
  scheduler.observe(openedResponse(pending(REVISION_0, ANALYSIS_0, 0)));
  equal(tasks.length, 1, "duplicate pending states must share one scheduled task");

  tasks.shift()?.();
  await flushAsync();
  equal(sent.length, 1, "one task must issue one queue request");
  assert(sent[0]!.requestId >= WORKER_REQUEST_ID_MIN, "Worker IDs use the reserved namespace");
  equal(tasks.length, 1, "a still-pending response schedules one later task");

  tasks.shift()?.();
  await flushAsync();
  equal(sent.length, 2, "the second task performs the second and final poll");
  equal(tasks.length, 0, "completion must stop pumping");
  equal(published.length, 2, "only accepted pump responses are published");
  assert(!scheduler.hasPending(DOCUMENT), "completion removes pending state");
}

async function superseded_in_flight_response_is_not_published(): Promise<void> {
  const tasks: Array<() => void> = [];
  const sent: RequestEnvelope[] = [];
  const published: ResponseEnvelope[] = [];
  let resolveFirst: ((response: ResponseEnvelope) => void) | undefined;
  const scheduler = new AnalysisPumpScheduler({
    budget: { maxSourceLines: 4, maxBlocks: 2, maxUtf16Units: 128 },
    scheduleTask: (task) => tasks.push(task),
    transport: {
      nextRequestId: workerIds(),
      send: (request) => {
        sent.push(request);
        if (sent.length === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(
          analysisResponse(request, complete(REVISION_1, ANALYSIS_1, 1), 1),
        );
      },
    },
    onResponse: (response) => published.push(response),
  });

  scheduler.observe(openedResponse(pending(REVISION_0, ANALYSIS_0, 0)));
  tasks.shift()?.();
  await flushAsync();
  scheduler.observe(committedResponse(pending(REVISION_1, ANALYSIS_1, 0)));
  equal(tasks.length, 0, "a new revision waits for the one global in-flight call");
  assert(resolveFirst !== undefined, "the first request should be in flight");
  resolveFirst(analysisResponse(sent[0]!, pending(REVISION_0, ANALYSIS_0, 1), 1));
  await flushAsync();
  equal(published.length, 0, "a superseded response is never published");
  equal(tasks.length, 1, "the replacement revision is scheduled next");

  tasks.shift()?.();
  await flushAsync();
  equal(sent[1]!.body.type, "process-analysis-queue");
  if (sent[1]!.body.type === "process-analysis-queue") {
    equal(sent[1]!.body.revision, REVISION_1);
    equal(sent[1]!.body.analysisId, ANALYSIS_1);
  }
  equal(published.length, 1, "the current revision response is published");
}

async function bootstrap_initializes_once_and_routes_messages(): Promise<void> {
  const endpoint = new FakeEndpoint();
  let initialized = 0;
  let constructed = 0;
  let handled = 0;
  class FakeHost {
    constructor() {
      constructed += 1;
    }

    handle(value: unknown): unknown {
      handled += 1;
      const request = value as RequestEnvelope;
      return envelope(request, {
        type: "handshake-ack",
        engineVersion: "test",
        capabilities: [],
      });
    }
  }
  const module: EditorWasmModule = {
    default: () => {
      initialized += 1;
    },
    WasmEditorHost: FakeHost,
  };
  const fatal: unknown[] = [];
  let finishLoading: ((module: EditorWasmModule) => void) | undefined;
  const loading = new Promise<EditorWasmModule>((resolve) => {
    finishLoading = resolve;
  });
  const bootstrapping = bootstrapEditorWorker({
    endpoint,
    loadWasm: () => loading,
    onFatalError: (error) => fatal.push(error),
  });
  endpoint.emit(handshakeRequest(7));
  equal(handled, 0, "messages wait until the Wasm host is ready");
  assert(finishLoading !== undefined);
  finishLoading(module);
  const attached = await bootstrapping;
  equal(initialized, 1);
  equal(constructed, 1);
  equal(handled, 1);
  equal(endpoint.posted.length, 1);
  equal((endpoint.posted[0] as ResponseEnvelope).body.type, "handshake-ack");

  endpoint.emit(handshakeRequest(FRONTEND_REQUEST_ID_MAX + 1));
  equal(handled, 1, "reserved Worker IDs never reach Wasm from the frontend");
  equal(fatal.length, 1);
  equal((endpoint.posted[1] as { type: string }).type, "editor-worker-fatal");
  endpoint.emit(handshakeRequest(8));
  equal(handled, 1, "a failed runtime must not process queued work");
  attached.dispose();
  assert(!endpoint.hasListener, "dispose detaches the Worker listener");
}

async function fatal_initialization_and_wasm_calls_reach_the_client(): Promise<void> {
  const startup = new FakeEndpoint();
  const result = await Promise.allSettled([bootstrapEditorWorker({
    endpoint: startup, loadWasm: async () => { throw new Error("cannot load Wasm"); },
  })]);
  equal(result[0]!.status, "rejected");
  equal(startup.hasListener, false);
  equal((startup.posted[0] as { message: string }).message, "cannot load Wasm");
  const worker = new FakeEndpoint();
  const runtime = new EditorWorkerRuntime({ endpoint: worker, host: { handle() { throw new Error("host trap"); } },
    backgroundBudget: { maxSourceLines: 4, maxBlocks: 2, maxUtf16Units: 128 } });
  runtime.dispatch(handshakeRequest(1));
  runtime.dispatch(handshakeRequest(2));
  equal(worker.posted.length, 1);
  const fatal = worker.posted[0] as { type: string; message: string };
  equal(fatal.type, "editor-worker-fatal");
  assert(fatal.message.includes("host trap"));
}

async function reentrant_host_actions_are_deferred(): Promise<void> {
  const endpoint = new FakeEndpoint();
  const handled: number[] = [];
  const fatal: unknown[] = [];
  let runtime: EditorWorkerRuntime | undefined;
  let reentered = false;
  const host = {
    handle(value: unknown): unknown {
      const request = value as RequestEnvelope;
      handled.push(request.requestId);
      if (!reentered) {
        reentered = true;
        runtime?.dispatch(handshakeRequest(8));
      }
      return envelope(request, {
        type: "handshake-ack",
        engineVersion: "test",
        capabilities: [],
      });
    },
  };
  runtime = new EditorWorkerRuntime({
    host,
    endpoint,
    backgroundBudget: { maxSourceLines: 4, maxBlocks: 2, maxUtf16Units: 128 },
    onFatalError: (error) => fatal.push(error),
  });

  runtime.dispatch(handshakeRequest(7));

  equal(handled.join(","), "7,8", "reentrant input must run after the outer Wasm call");
  equal(fatal.length, 0, "deferred input must not become a fatal Worker error");
  equal(endpoint.posted.length, 2, "both serialized requests must publish responses");
  runtime.dispose();
}

class FakeEndpoint implements EditorWorkerEndpoint {
  readonly posted: unknown[] = [];
  readonly #listeners = new Set<(event: MessageEvent<unknown>) => void>();

  get hasListener(): boolean {
    return this.#listeners.size > 0;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listeners.delete(listener);
  }

  emit(data: unknown): void {
    for (const listener of this.#listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

function pending(
  revision: Revision,
  analysisId: AnalysisId,
  sequence: number,
): AnalysisState {
  return {
    state: "pending",
    analysisId,
    targetRevision: revision,
    sequence,
    confirmedRanges: [{ from: offset(0), to: offset(sequence) }],
    dirtyRanges: [{ from: offset(sequence), to: offset(100) }],
  };
}

function complete(
  revision: Revision,
  analysisId: AnalysisId,
  sequence: number,
): AnalysisState {
  return {
    state: "complete",
    analysisId,
    targetRevision: revision,
    sequence,
    confirmedRange: { from: offset(0), to: offset(100) },
    totalBlocks: 10,
  };
}

function openedResponse(analysis: AnalysisState): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 1,
    generation: 1,
    documentId: DOCUMENT,
    body: {
      type: "document-opened",
      revision: analysis.targetRevision,
      sourceUtf16Len: 100,
      sourceLineCount: 10,
      analysis,
    },
  };
}

function committedResponse(analysis: AnalysisState): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 2,
    generation: 1,
    documentId: DOCUMENT,
    body: {
      type: "transaction-committed",
      patch: {
        transactionId: "tx" as never,
        baseRevision: REVISION_0,
        revision: REVISION_1,
        changedTextRange: {
          before: { from: offset(0), to: offset(0) },
          after: { from: offset(0), to: offset(1) },
        },
        diagnostics: { removedIds: [], upserted: [] },
      },
      analysis,
    },
  };
}

function analysisResponse(
  request: RequestEnvelope,
  analysis: AnalysisState,
  sequence: number,
): ResponseEnvelope {
  const update: AnalysisUpdate = {
    analysisId: analysis.analysisId,
    targetRevision: analysis.targetRevision,
    sequence,
    confirmedRanges:
      analysis.state === "pending"
        ? analysis.confirmedRanges
        : analysis.state === "complete"
          ? [analysis.confirmedRange]
          : [],
    dirtyRanges:
      analysis.state === "pending" || analysis.state === "failed"
        ? analysis.dirtyRanges
        : [],
    diagnostics: { removedIds: [], upserted: [] },
    metrics: {
      processedSourceLines: 1,
      processedBlocks: 1,
      processedUtf16Units: 8,
      elapsedMicros: 10,
      yielded: analysis.state === "pending",
    },
  };
  return envelope(request, {
    type: "analysis-state-changed",
    analysis,
    update,
  });
}

function envelope(
  request: RequestEnvelope,
  body: ResponseBody,
): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    generation: request.generation,
    ...(request.documentId === undefined
      ? {}
      : { documentId: request.documentId }),
    body,
  };
}

function handshakeRequest(requestId: number): RequestEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    generation: 0,
    body: { type: "handshake", clientName: "test", clientVersion: "0" },
  };
}

function workerIds(): () => number {
  let next = WORKER_REQUEST_ID_MIN;
  return () => next++;
}

function offset(value: number): Utf16Offset {
  return value as Utf16Offset;
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  }
}

const tests: ReadonlyArray<readonly [string, () => Promise<void>]> = [
  ["fatal initialization and Wasm calls reach the client", fatal_initialization_and_wasm_calls_reach_the_client],
  ["default scheduler yields and disposes", default_scheduler_yields_and_disposes],
  ["pump runs exactly one serial slice per task", pump_runs_exactly_one_serial_slice_per_task],
  ["superseded in-flight response is not published", superseded_in_flight_response_is_not_published],
  ["bootstrap initializes once and routes messages", bootstrap_initializes_once_and_routes_messages],
  ["reentrant host actions are deferred", reentrant_host_actions_are_deferred],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
