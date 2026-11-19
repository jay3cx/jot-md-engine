import type { Revision } from "@jot-md/editor-protocol";

import type { AdapterEffect, EditorEditIntent } from "./document-adapter.js";
import type { EditorDocumentSession } from "./session.js";

export interface TransactionContext {
  readonly revision: Revision;
  readonly source: string;
}

export type TransactionBuilder =
  (context: TransactionContext) => EditorEditIntent | Promise<EditorEditIntent>;

export class StaleEditorCommandError extends Error {
  constructor(expected: Revision, actual: Revision) {
    super(
      `stale editor command: expected revision ${String(expected)}, ` +
      `current revision is ${String(actual)}`,
    );
    this.name = "StaleEditorCommandError";
  }
}

/**
 * 前端串行事务闸门。只有轮到某个 builder 时才执行，因此排队命令会基于最新
 * confirmed revision 计算范围。
 */
export class EditorTransactionCoordinator {
  readonly #session: EditorDocumentSession;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(session: EditorDocumentSession) {
    this.#session = session;
  }

  enqueue(builder: TransactionBuilder): Promise<AdapterEffect> {
    if (this.#disposed) return Promise.reject(new Error("transaction coordinator disposed"));
    const result = this.#tail.then(async () => {
      if (this.#disposed) throw new Error("transaction coordinator disposed");
      if (this.#session.terminalError) throw this.#session.terminalError;
      const revision = this.#session.adapter.revision;
      const source = this.#session.adapter.text.text;
      const intent = await builder({
        revision,
        source,
      });
      if (
        this.#session.adapter.revision !== revision ||
        this.#session.adapter.text.text !== source
      ) {
        throw new StaleEditorCommandError(revision, this.#session.adapter.revision);
      }
      return this.#session.transact(intent);
    });
    // 向调用方返回本次错误，队尾仍可继续执行后续有效编辑。
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 提交基于既定 revision 的原生输入。版本变化后，旧范围已无法安全重用。 */
  commitExact(
    expectedRevision: Revision,
    intent: EditorEditIntent,
  ): Promise<AdapterEffect> {
    return this.enqueue(({ revision }) => {
      if (revision !== expectedRevision) {
        throw new StaleEditorCommandError(expectedRevision, revision);
      }
      return intent;
    });
  }

  async settled(): Promise<void> {
    await this.#tail;
  }

  dispose(): void {
    this.#disposed = true;
  }
}
