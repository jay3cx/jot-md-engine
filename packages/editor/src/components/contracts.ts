import type { RenderNode, TextRange } from "@jot-md/editor-protocol";

/**
 * 语义组件的最小共同身份。组件模型只描述 Rust 已确认的语义与源码范围，
 * 不能持有 DOM、CodeMirror View 或 Surface 实例。
 */
export interface MarkdownComponentModel {
  readonly id: string;
  readonly kind: string;
  readonly sourceRange: TextRange;
  readonly contentVersion: number;
  readonly node: RenderNode;
}

/** 组件适配器可声明的宿主能力；缺失能力必须显式降级，不能临时打补丁。 */
export type MarkdownComponentCapability =
  | "preview"
  | "pretext"
  | "live-preview"
  | "projection"
  | "interaction"
  | "inspect"
  | "search";

/** Live Preview 适配器所需的宿主无关输入；偏移始终是 UTF-16。 */
export interface ComponentLivePreviewContext {
  readonly source: string;
  readonly selections: readonly { readonly from: number; readonly to: number }[];
  readonly visibleRange?: { readonly from: number; readonly to: number };
  readonly maxDecorations: number;
  /** 由统一 PreText 入口提供的当前 RenderNode 初始高度。 */
  readonly estimateBlockHeight?: (node: RenderNode) => number | undefined;
}

/** 组件提出的纯 widget 描述；具体 DOM 仍由 Live Preview Host 统一挂载。 */
export interface ComponentLivePreviewWidget {
  readonly kind: string;
  readonly node: RenderNode;
  readonly text?: string;
  readonly block: boolean;
  /**
   * 允许 CodeMirror selection 落在 RenderNode.sourceRange 内。
   * 默认 widget 是 atomic 的；可编辑投影必须显式声明 mapped，避免把
   * Preview DOM 误当成第二个 selection 模型。
   */
  readonly selection?: "atomic" | "mapped";
  readonly estimatedHeight?: number;
  /**
   * 此根组件拥有自己的细粒度 DOM 更新边界。为 `true` 时，宿主保持
   * CodeMirror widget 的几何身份，并在已挂载实例上把新的 RenderNode 交给共享
   * RenderRuntime；`estimatedHeight` 仅用于首次挂载/离屏 HeightMap，不得因每次
   * 内容更新重置已实测的 block 高度。
   *
   * 典型用途是 table-root：一个 cell 的文本更新只应触发 TableGrid 的局部 row /
   * cell 协调，而不是让 CodeMirror 重建整张 table 的 replacement widget。
   */
  readonly inPlaceUpdate?: boolean;
  /**
   * 仅用于离屏根块的 PreText 几何占位。它保留 CodeMirror 的全局高度图，
   * 进入 viewport 后会被当前 revision 的真实 RenderNode widget 替换；不能
   * 调用 RenderRuntime 把合成节点误当作完整 Preview 语义。
   */
  readonly geometry?: boolean;
  /**
   * Active source may keep a read-only rendering of the same semantic node
   * after its Markdown text. This is a presentation companion, not an atomic
   * replacement and never owns selection or input.
   */
  readonly sourceCompanion?: boolean;
  /**
   * 非空 CodeMirror selection 不应强制整篇文档退回源码。宿主可将与选择相交的
   * Preview widget 标成 selected，以提供视觉反馈而不创建第二份 selection。
   */
  readonly selected?: boolean;
  /** 组件私有的只读投影数据，不可包含 DOM 或 EditorView。 */
  readonly payload?: unknown;
}

/** 组件可以直接声明的 Live Preview decoration，避免通用 Planner 认识组件细节。 */
export type ComponentLivePreviewDecoration =
  | {
      readonly type: "line";
      readonly from: number;
      readonly className: string;
      readonly nodeId: string;
      readonly attributes?: Readonly<Record<string, string>>;
      /** Nested block presentations may contribute to the same physical line. */
      readonly structuralOwners?: readonly string[];
    }
  | {
      readonly type: "mark";
      readonly from: number;
      readonly to: number;
      readonly className: string;
      readonly nodeId: string;
    }
  | {
      readonly type: "replace";
      readonly from: number;
      readonly to: number;
      readonly nodeId: string;
      readonly widget?: ComponentLivePreviewWidget;
      /** Hidden block syntax survives adjacent body input until confirmation. */
      readonly structural?: boolean;
    };

/** 组件声明的块级容器；宿主负责把它翻译成具体编辑器的 wrapper。 */
export interface ComponentLivePreviewWrapper {
  readonly type: "wrapper";
  readonly from: number;
  readonly to: number;
  readonly nodeId: string;
  readonly className: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ComponentLivePreviewPlan {
  readonly lineClasses?: readonly string[];
  /** 当前节点必须保留 Markdown 源码的根块数。 */
  readonly fallbackBlocks?: number;
  /** 由宿主继续访问 structured children。 */
  readonly visitChildren?: boolean;
  /** 组件自行处理当前选区，例如 Table 保持根投影并由 selection 映射 active cell。 */
  readonly handlesSelection?: boolean;
  /** 组件专属的 line/mark/replace 计划；通用 Planner 仅负责合并与上限保护。 */
  readonly decorations?: readonly ComponentLivePreviewDecoration[];
  /** 组件专属的块级 DOM 容器；不携带 DOM 或 EditorView 状态。 */
  readonly wrappers?: readonly ComponentLivePreviewWrapper[];
}

export interface ComponentLivePreviewAdapter<Model extends MarkdownComponentModel> {
  plan(model: Model, context: ComponentLivePreviewContext): ComponentLivePreviewPlan | undefined;
}

/**
 * 组件交互范围使用 UTF-16 半开区间。它们描述 Preview 的可见交互如何回到
 * CodeMirror 的唯一源码 selection / transaction，而不是创建第二个编辑器状态。
 */
export interface ComponentInteractionEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/**
 * 可编辑 Preview root 与相邻 source 行之间的删除意图。它是一个“外部 block
 * 删除”请求，不等同于 editableRange 内的字符删除；组件可选择把它解析成整个
 * 已确认 root 的 source range，例如 table 前 Delete / table 后 Backspace。
 */
export interface ComponentInteractionDeletion {
  readonly position: number;
  readonly direction: "backward" | "forward";
}

export type ComponentInteractionDeletionResult =
  | {
    /** 组件确认这是一个 root 级删除，宿主提交此精确 source range。 */
    readonly kind: "delete-range";
    readonly from: number;
    readonly to: number;
  }
  | {
    /** 组件拥有该 boundary，但不允许默认行为穿过其结构。 */
    readonly kind: "consume";
    /** 可选地将唯一 CodeMirror caret 归一到这个合法 editable boundary。 */
    readonly anchor?: number;
  };

export interface ComponentInteractionContext {
  /** 当前 CodeMirror 文本；组件不得据此重新识别 Markdown 结构。 */
  readonly source: string;
}

export interface ComponentInteractionRanges {
  /** 普通输入、删除、粘贴允许完整落入的源码范围。 */
  readonly editableRanges: readonly TextRange[];
  /** 普通编辑不可穿越的结构语法范围。 */
  readonly protectedRanges: readonly TextRange[];
  /** 仅由组件 command 可以修改的结构范围。 */
  readonly commandRanges: readonly TextRange[];
  /**
   * Visible caret destinations inside this component. When supplied, the host
   * skips the structural gaps between these ranges for pointer placement and
   * native keyboard motion. This is independent of edit protection: mapped
   * widgets may provide their own navigation, and ordinary hidden inline
   * syntax is derived from the current presentation decorations instead.
   */
  readonly navigationRanges?: readonly TextRange[];
  /**
   * 返回 true 时，当前组件根已经为其结构化后代声明了完整交互边界；通用收集器
   * 不再递归到 children，避免 table/row/cell 等重复拥有同一段源码。
   */
  readonly ownsDescendants?: boolean;
}

/**
 * 组件把已确认的 RenderNode 映射为交互范围。所有返回值都必须来自 Rust
 * Projection 的 sourceRange，不能扫描源码重新判断节点类型。
 */
export interface ComponentInteractionAdapter<Model extends MarkdownComponentModel> {
  ranges(
    model: Model,
    context: ComponentInteractionContext,
  ): ComponentInteractionRanges | undefined;
  /**
   * 在通用 EditableRange 校验已经通过后，对组件私有的输入序列化约束做最后判定。
   * 例如 table cell 不允许普通输入创建物理换行或未转义的 pipe。
   */
  allowsEdit?(
    edit: ComponentInteractionEdit,
    ranges: ComponentInteractionRanges,
    context: ComponentInteractionContext,
  ): boolean;
  /**
   * 解析组件 root 外部的删除边界。只接受来自 Rust-confirmed model/sourceRange
   * 的结果；返回 undefined 表示该组件不接管，宿主回到普通 CodeMirror 删除。
   */
  resolveDeletion?(
    model: Model,
    deletion: ComponentInteractionDeletion,
    ranges: ComponentInteractionRanges,
    context: ComponentInteractionContext,
  ): ComponentInteractionDeletionResult | undefined;
}

/** 由 Registry 物化后的宿主无关交互面，可安全跨 Host 使用。 */
export interface ComponentInteractionSurface {
  readonly componentId: string;
  readonly sourceRange: TextRange;
  readonly editableRanges: readonly TextRange[];
  readonly protectedRanges: readonly TextRange[];
  readonly commandRanges: readonly TextRange[];
  readonly navigationRanges?: readonly TextRange[];
  /**
   * Host 会把当前映射后的范围传回，避免 decoration/ChangeSet 映射后仍然依据
   * 旧 revision 的范围判定输入是否合法。
   */
  readonly allowsEdit?: (
    edit: ComponentInteractionEdit,
    ranges: ComponentInteractionRanges,
  ) => boolean;
  readonly resolveDeletion?: (
    deletion: ComponentInteractionDeletion,
    ranges: ComponentInteractionRanges,
  ) => ComponentInteractionDeletionResult | undefined;
}

/** 使用方请求细节投影的目的；组件可据此限制昂贵的 structured child 展开。 */
export type ComponentProjectionConsumer = "pretext" | "preview" | "live-preview";

/**
 * 组件自己的详情投影策略。返回 `undefined` 表示交给宿主的通用 Markdown 策略；
 * 返回 `0` 则明确禁止展开，避免宿主再次猜测复杂节点的成本边界。
 */
export interface ComponentProjectionAdapter<Model extends MarkdownComponentModel> {
  detailDepth(model: Model, consumer: ComponentProjectionConsumer): number | undefined;
}

/** 所有 PreText adapter 共享的宿主无关输入；特化组件可在此基础上扩展。 */
export interface ComponentPreTextContext {
  readonly availableWidth: number;
  readonly averageCharacterWidth: number;
  readonly tabSize: number;
}

export interface ComponentPreTextResult {
  readonly height: number;
  readonly strategy: string;
  readonly rows?: number;
  readonly columns?: number;
  readonly sampledRows?: number;
  readonly visualLines?: number;
}

export interface ComponentPreTextAdapter<Model extends MarkdownComponentModel> {
  estimate(model: Model, context: ComponentPreTextContext): ComponentPreTextResult | undefined;
}

/** Preview host 的最小端口。具体组件可通过自己的窄接口进行结构校验。 */
export interface ComponentPreviewHost {}

export interface ComponentPreviewInstance {
  update(node: RenderNode): void;
  dispose(): void;
}

export interface ComponentPreviewAdapter<Model extends MarkdownComponentModel> {
  /** 是否接管该模型的内部 DOM；同一组件可声明 table/table-row/table-cell 多种 node kind。 */
  manages?(model: Model): boolean;
  prepareShell?(
    model: Model,
    element: HTMLElement,
    host: ComponentPreviewHost,
  ): void;
  mount?(
    model: Model,
    element: HTMLElement,
    host: ComponentPreviewHost,
  ): ComponentPreviewInstance | undefined;
}

/**
 * 组件定义是宿主无关的注册单元。Preview/PreText/Live Preview 的具体实现可以
 * 使用不同 DOM，但必须从同一个 Model、sourceRange 和 contentVersion 出发。
 */
export interface MarkdownComponentDefinition<Model extends MarkdownComponentModel> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly nodeKinds: readonly string[];
  createModel(node: RenderNode): Model | undefined;
  readonly capabilities: Readonly<{
    readonly preview?: ComponentPreviewAdapter<Model>;
    readonly pretext?: ComponentPreTextAdapter<Model>;
    readonly livePreview?: ComponentLivePreviewAdapter<Model>;
    readonly projection?: ComponentProjectionAdapter<Model>;
    readonly interaction?: ComponentInteractionAdapter<Model>;
    readonly inspect?: true;
    readonly search?: true;
  }>;
}

export function hasComponentCapability(
  definition: MarkdownComponentDefinition<MarkdownComponentModel>,
  capability: MarkdownComponentCapability,
): boolean {
  switch (capability) {
    case "preview":
      return definition.capabilities.preview !== undefined;
    case "pretext":
      return definition.capabilities.pretext !== undefined;
    case "live-preview":
      return definition.capabilities.livePreview !== undefined;
    case "projection":
      return definition.capabilities.projection !== undefined;
    case "interaction":
      return definition.capabilities.interaction !== undefined;
    case "inspect":
      return definition.capabilities.inspect === true;
    case "search":
      return definition.capabilities.search === true;
  }
}
