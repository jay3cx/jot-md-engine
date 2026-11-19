import {
  PROTOCOL_VERSION,
  type AnalysisId,
  type AnalysisState,
  type DocumentId,
  type RequestEnvelope,
  type ResponseEnvelope,
  type Revision,
  type SyntaxProfile,
} from "../../../editor-protocol/src/index.js";
import { EditorDocumentSession, EditorTransactionCoordinator, range } from "../../src/adapter/index.js";

const DOCUMENT = "render-document" as DocumentId;
const PROFILE: SyntaxProfile = {
  id: "jot",
  version: 1,
  enabledExtensions: [],
};

async function transaction_coordinator_builds_each_edit_on_confirmed_revision(): Promise<void> {
  const endpoint = new LoopbackEndpoint("one two");
  const session = new EditorDocumentSession({
    endpoint,
    documentId: DOCUMENT,
    generation: 1,
    source: "one two",
    syntaxProfile: PROFILE,
  });
  await session.open({ visibleRanges: [range(0, 7)] });
  const coordinator = new EditorTransactionCoordinator(session);
  const seen: number[] = [];
  const first = coordinator.enqueue(({ revision, source }) => {
    seen.push(Number(revision));
    equal(source, "one two");
    return {
      origin: "keyboard",
      edits: [{ range: range(0, 3), insert: "ONE" }],
      viewport: { visibleRanges: [range(0, 7)] },
    };
  });
  const second = coordinator.enqueue(({ revision, source }) => {
    seen.push(Number(revision));
    equal(source, "ONE two");
    return {
      origin: "api",
      edits: [{ range: range(4, 7), insert: "TWO" }],
      viewport: { visibleRanges: [range(0, 7)] },
    };
  });
  await Promise.all([first, second]);
  equal(seen.join(","), "0,1");
  equal(session.adapter.text.text, "ONE TWO");
  equal(Number(session.adapter.revision), 2);

  let staleRejected = false;
  try {
    await coordinator.commitExact(0 as Revision, {
      origin: "api",
      edits: [{ range: range(0, 0), insert: "x" }],
      viewport: { visibleRanges: [range(0, 1)] },
    });
  } catch {
    staleRejected = true;
  }
  equal(staleRejected, true);
  coordinator.dispose();
  session.dispose();
}

async function failed_transaction_does_not_poison_the_serial_queue(): Promise<void> {
  const endpoint = new LoopbackEndpoint("alpha");
  const session = new EditorDocumentSession({
    endpoint,
    documentId: DOCUMENT,
    generation: 1,
    source: "alpha",
    syntaxProfile: PROFILE,
  });
  await session.open({ visibleRanges: [range(0, 5)] });
  const coordinator = new EditorTransactionCoordinator(session);
  endpoint.failNextApply = true;
  const failed = coordinator.enqueue(() => ({
    origin: "api",
    edits: [{ range: range(0, 5), insert: "bad" }],
    viewport: { visibleRanges: [range(0, 3)] },
  }));
  const recovered = coordinator.enqueue(({ revision, source }) => {
    equal(Number(revision), 0);
    equal(source, "alpha");
    return {
      origin: "api",
      edits: [{ range: range(0, 5), insert: "ALPHA" }],
      viewport: { visibleRanges: [range(0, 5)] },
    };
  });
  let rejected = false;
  try {
    await failed;
  } catch {
    rejected = true;
  }
  equal(rejected, true);
  await recovered;
  equal(session.adapter.text.text, "ALPHA");
  equal(Number(session.adapter.revision), 1);
  coordinator.dispose();
  session.dispose();
}

class LoopbackEndpoint {
  readonly #listeners = new Set<(event: MessageEvent<unknown>) => void>();
  #source: string;
  #revision = 0;
  failNextApply = false;

  constructor(source: string) {
    this.#source = source;
  }

  postMessage(message: unknown): void {
    const request = message as RequestEnvelope;
    let body: ResponseEnvelope["body"];
    if (request.body.type === "open-document") {
      body = {
        type: "document-opened",
        revision: 0 as Revision,
        sourceUtf16Len: this.#source.length,
        sourceLineCount: 1,
        analysis: complete(0 as Revision),
      };
    } else if (request.body.type === "apply-transaction") {
      if (this.failNextApply) {
        this.failNextApply = false;
        body = {
          type: "failure",
          error: {
            code: "INVALID_TRANSACTION",
            message: "intentional test failure",
            recoverable: true,
          },
        };
        this.#emit(request, body);
        return;
      }
      const edit = request.body.transaction.edits[0]!;
      this.#source = `${this.#source.slice(0, Number(edit.range.from))}${edit.insert}` +
        this.#source.slice(Number(edit.range.to));
      const base = this.#revision as Revision;
      this.#revision += 1;
      body = {
        type: "transaction-committed",
        patch: {
          transactionId: request.body.transaction.id,
          baseRevision: base,
          revision: this.#revision as Revision,
          changedTextRange: {
            before: edit.range,
            after: range(Number(edit.range.from), Number(edit.range.from) + edit.insert.length),
          },
          diagnostics: { removedIds: [], upserted: [] },
        },
        analysis: complete(this.#revision as Revision),
      };
    } else {
      throw new Error(`unexpected request ${request.body.type}`);
    }
    this.#emit(request, body);
  }

  #emit(request: RequestEnvelope, body: ResponseEnvelope["body"]): void {
    const response: ResponseEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      generation: request.generation,
      documentId: DOCUMENT,
      body,
    };
    queueMicrotask(() => {
      for (const listener of this.#listeners) {
        listener({ data: response } as MessageEvent<unknown>);
      }
    });
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
}

function complete(revision: Revision): AnalysisState {
  return {
    state: "complete",
    analysisId: `render:r${String(revision)}` as AnalysisId,
    targetRevision: revision,
    sequence: 0,
    confirmedRange: range(0, 100),
    totalBlocks: 1,
  };
}

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

const tests: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
  ["transaction coordinator serializes confirmed revisions", transaction_coordinator_builds_each_edit_on_confirmed_revision],
  ["failed transactions do not poison the serial queue", failed_transaction_does_not_poison_the_serial_queue],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
