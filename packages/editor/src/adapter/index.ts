export {
  createAnalysisRequest,
  DEFAULT_EDITOR_BUDGETS,
  mapChangedRanges,
  type AnalysisPolicyInput,
  type EditorAnalysisBudgets,
  type EditorViewport,
} from "./analysis-policy.js";
export { SyntaxBlockIndex, type IndexedBlock } from "./block-index.js";
export {
  EditorDocumentAdapter,
  type AdapterEffect,
  type EditorDocumentAdapterOptions,
  type EditorEditIntent,
} from "./document-adapter.js";
export {
  ProjectionStore,
  type ProjectionWindowSnapshot,
} from "./projection-store.js";
export {
  EditorTransactionCoordinator,
  StaleEditorCommandError,
  type TransactionBuilder,
  type TransactionContext,
} from "./transaction-coordinator.js";
export {
  EditorDocumentSession,
  type EditorClientEndpoint,
  type EditorDocumentSessionOptions,
  type EditorProtocolEvent,
} from "./session.js";
export {
  normalizeInsertedText,
  range,
  Utf16TextModel,
  validateEdits,
  type SourceLinePreview,
  type SourceLineSlice,
  type TextLineChange,
} from "./text-model.js";
export { singleTextEdit } from "./text-diff.js";
