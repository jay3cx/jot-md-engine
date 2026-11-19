import type { RenderNode } from "@jot-md/editor-protocol";
import type {
  MarkdownComponentDefinition,
  MarkdownComponentModel,
} from "./contracts.js";
import { closedContainerComponentDefinition } from "./closed-container/definition.js";
import { tableComponentDefinition } from "./table/definition.js";

/**
 * Registry 是所有宿主共享的组件路由表。它只按 RenderNode kind 选择定义，
 * 不参与 Markdown 解析，也不保存任何 DOM 生命周期状态。
 */
export class MarkdownComponentRegistry {
  readonly #definitions: readonly MarkdownComponentDefinition<MarkdownComponentModel>[];
  readonly #byKind = new Map<string, MarkdownComponentDefinition<MarkdownComponentModel>>();

  constructor(definitions: readonly MarkdownComponentDefinition<MarkdownComponentModel>[]) {
    this.#definitions = [...definitions];
    for (const definition of this.#definitions) {
      if (!definition.id.trim()) throw new Error("component id must not be empty");
      if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
        throw new Error(`component ${definition.id} has an invalid schemaVersion`);
      }
      for (const kind of definition.nodeKinds) {
        if (!kind.trim()) throw new Error(`component ${definition.id} declares an empty node kind`);
        if (this.#byKind.has(kind)) throw new Error(`duplicate component node kind: ${kind}`);
        this.#byKind.set(kind, definition);
      }
    }
  }

  get definitions(): readonly MarkdownComponentDefinition<MarkdownComponentModel>[] {
    return this.#definitions;
  }

  resolve(node: RenderNode): MarkdownComponentDefinition<MarkdownComponentModel> | undefined {
    return this.#byKind.get(node.kind);
  }

  modelFor(node: RenderNode): MarkdownComponentModel | undefined {
    return this.resolve(node)?.createModel(node);
  }
}

/** 内置 Markdown 组件表；扩展能力以后只能通过受控 Registry API 增量加入。 */
export const defaultMarkdownComponentRegistry = new MarkdownComponentRegistry([
  closedContainerComponentDefinition,
  tableComponentDefinition,
]);
