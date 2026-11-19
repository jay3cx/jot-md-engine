/// <reference lib="webworker" />

import { bootstrapEditorWorker } from "../../../packages/editor/src/worker/index.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

await bootstrapEditorWorker({
  endpoint: scope,
  loadWasm: () => import("./generated/editor_wasm.js"),
});
