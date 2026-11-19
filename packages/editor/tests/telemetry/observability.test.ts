import {
  PROTOCOL_VERSION,
  type DocumentId,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Revision,
  type TransactionId,
  type Utf16Offset,
} from "../../../editor-protocol/src/index.js";
import { EditorEventObserver } from "../../src/observability/index.js";

function equal<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  }
}

function transaction_events_collapse_into_one_operation(): void {
  let now = 10;
  const updates: string[] = [];
  const observer = new EditorEventObserver({
    clock: () => now,
    onOperation: (operation) => updates.push(operation.id),
  });
  const documentId = "observe" as DocumentId;
  const transactionId = "observe:tx1" as TransactionId;
  const baseRevision = 0 as Revision;
  const revision = 1 as Revision;
  const edit = {
    range: { from: 0 as Utf16Offset, to: 0 as Utf16Offset },
    insert: "x",
  };

  observer.acceptInput({
    version: 1,
    origin: "keyboard",
    userEvent: "input.type",
    edits: [edit],
    selectionBefore: { anchor: 0 as Utf16Offset, head: 0 as Utf16Offset },
    selectionAfter: { anchor: 1 as Utf16Offset, head: 1 as Utf16Offset },
  });
  now = 12;
  const request: RequestEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 1,
    generation: 1,
    documentId,
    body: {
      type: "apply-transaction",
      transaction: {
        id: transactionId,
        baseRevision,
        origin: "keyboard",
        edits: [edit],
        newlinePolicy: { type: "document-dominant", fallback: "lf" },
        history: { type: "record" },
        metadata: { correlationId: "codemirror-1" },
      },
    },
  };
  observer.acceptProtocol({ direction: "request", message: request });
  now = 16;
  const patch = {
    transactionId,
    baseRevision,
    revision,
    changedTextRange: { before: edit.range, after: { from: edit.range.from, to: 1 as Utf16Offset } },
    syntax: {
      reparsedRange: { from: 0 as Utf16Offset, to: 1 as Utf16Offset },
      totalBlocks: 1,
      changedBlocks: 1,
      blockChanges: [],
    },
    diagnostics: { removedIds: [], upserted: [] },
  };
  const response: ResponseEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: 1,
    generation: 1,
    documentId,
    body: {
      type: "transaction-committed",
      patch,
      analysis: {
        state: "complete",
        analysisId: "analysis-1" as import("../../../editor-protocol/src/index.js").AnalysisId,
        targetRevision: revision,
        sequence: 1,
        confirmedRange: { from: 0 as Utf16Offset, to: 1 as Utf16Offset },
        totalBlocks: 1,
      },
    },
  };
  observer.acceptProtocol({ direction: "response", channel: "foreground", message: response });
  now = 18;
  observer.acceptEffect({
    documentPatch: patch,
    appliedEdits: [edit],
    projectionChanged: false,
  });
  now = 22;
  observer.acceptSurfaceCommit({
    revision,
    viewRevision: 1,
    mode: "pretext",
    reason: "document",
    window: {
      from: 0,
      toExclusive: 1,
      beforePixels: 0,
      afterPixels: 0,
      totalPixels: 20,
    },
    filteredItems: 1,
    truncatedItems: 0,
    filterDurationMs: 0.25,
    createdItems: 1,
    updatedItems: 0,
    removedItems: 0,
    mountedItems: 1,
    commitDurationMs: 0.5,
    measuredItems: 1,
    estimatedHeightErrorPx: 3,
    estimatedHeightAbsErrorPx: 3,
    estimatedHeightMaxErrorPx: 3,
  });

  const snapshot = observer.snapshot;
  equal(snapshot.length, 1);
  const operation = snapshot[0]!;
  equal(operation.id, "codemirror-1");
  equal(operation.status, "complete");
  equal(operation.transactionId, transactionId);
  equal(operation.revision, revision);
  equal(operation.metrics.measuredItems, 1);
  equal(operation.metrics.estimatedHeightErrorPx, 3);
  equal(operation.metrics.protocolRoundTripMs, 4);
  equal(operation.metrics.changedBlocks, 1);
  equal(operation.durationMs, 12);
  equal(operation.metrics.mountedItems, 1);
  equal(operation.stages.map((stage) => stage.kind).join(","),
    "input,request,response,document,render");
  equal(updates.every((id) => id === "codemirror-1"), true);
}

function projection_requests_remain_separate_operations(): void {
  let now = 0;
  const observer = new EditorEventObserver({ clock: () => ++now });
  observer.acceptProtocol({
    direction: "request",
    message: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 7,
      generation: 1,
      documentId: "observe" as DocumentId,
      body: {
        type: "project",
        projection: {
          revision: 0 as Revision,
          viewRevision: 2,
          mode: "source",
          slices: [],
        },
      },
    },
  });
  const renderPatch = {
    documentId: "observe" as DocumentId,
    documentRevision: 0 as Revision,
    viewRevision: 2,
    operations: [],
  };
  observer.acceptProtocol({
    direction: "response",
    channel: "foreground",
    message: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 7,
      generation: 1,
      documentId: "observe" as DocumentId,
      body: { type: "projection-ready", patch: renderPatch },
    },
  });
  observer.acceptEffect({
    renderPatch,
    projectionChanged: true,
  });
  equal(observer.snapshot.length, 1);
  equal(observer.snapshot[0]!.kind, "projection");
  equal(observer.snapshot[0]!.id, "request:7");
  equal(observer.snapshot[0]!.status, "complete");
  equal(observer.snapshot[0]!.stages.map((stage) => stage.kind).join(","),
    "request,response,render");
}

const tests: readonly [string, () => void][] = [
  ["transaction events collapse into one operation", transaction_events_collapse_into_one_operation],
  ["projection requests remain separate operations", projection_requests_remain_separate_operations],
];

for (const [name, test] of tests) {
  test();
  console.log(`ok - ${name}`);
}
