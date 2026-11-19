export {
  componentInteractionSurfaces,
} from "./interaction.js";
export {
  hasComponentCapability,
  type ComponentInteractionAdapter,
  type ComponentInteractionContext,
  type ComponentInteractionDeletion,
  type ComponentInteractionDeletionResult,
  type ComponentInteractionEdit,
  type ComponentInteractionRanges,
  type ComponentInteractionSurface,
  type ComponentLivePreviewAdapter,
  type ComponentLivePreviewContext,
  type ComponentLivePreviewDecoration,
  type ComponentLivePreviewPlan,
  type ComponentLivePreviewWidget,
  type ComponentLivePreviewWrapper,
  type ComponentProjectionAdapter,
  type ComponentProjectionConsumer,
  type ComponentPreTextAdapter,
  type ComponentPreTextContext,
  type ComponentPreTextResult,
  type ComponentPreviewAdapter,
  type ComponentPreviewHost,
  type ComponentPreviewInstance,
  type MarkdownComponentCapability,
  type MarkdownComponentDefinition,
  type MarkdownComponentModel,
} from "./contracts.js";
export { defaultMarkdownComponentRegistry, MarkdownComponentRegistry } from "./registry.js";
export { componentProjectionDepth } from "./projection.js";
export { createDefaultEditorCommandRegistry } from "./commands.js";
export {
  createKaTeXRenderer,
  type KaTeXRendererOptions,
} from "./math/katex.js";
export * from "./table/index.js";
