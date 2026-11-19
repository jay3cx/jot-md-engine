import type { LivePreviewSelectionRange } from "./types.js";

/**
 * A source range is half-open for text, but a caret also occupies the gap at
 * the end of a physical line. A root beginning at the position always wins;
 * otherwise an EOL/EOF caret belongs to the root whose visible text ends
 * there. A consumed LF never gives that root ownership of the next empty row.
 * Both source commands and presentation activation must use this same rule.
 */
export function resolveSourceRootAt<T extends {
  readonly sourceRange: { readonly from: number; readonly to: number };
}>(source: string, nodes: readonly T[], offset: number): T | undefined {
  const position = Math.max(0, Math.min(source.length, offset));
  const starting = nodes.find((node) => Number(node.sourceRange.from) === position);
  if (starting !== undefined) return starting;
  const containing = nodes.find((node) => Number(node.sourceRange.from) < position &&
    position < Number(node.sourceRange.to));
  if (containing !== undefined) return containing;
  if ((source[position] === "\n" || position === source.length) && source[position - 1] !== "\n") {
    return nodes.find((node) => Number(node.sourceRange.to) === position);
  }
  return undefined;
}

/**
 * Live Preview 的显示状态只由真实编辑语义驱动：
 *
 * - 单一折叠 caret 命中范围时，该最小编辑范围显示 source-edit；
 * - 非折叠 / 多重 selection 保留 Preview，由 CodeMirror 持有真实 source
 *   selection，并由宿主做有限的 selected visual projection；
 * - IME composition 只允许当前单一 caret 命中的 root 显示 source-edit；table
 *   使用宿主的临时 IME 输入面，不拆掉 mapped root；
 * - pointer / Delete 首次命中 widget 时可追加一次 pending reveal；
 * - hover 不参与本状态机，不能在真实 CodeMirror selection 仍活跃时把源码藏回
 *   Preview。
 */
export interface LivePreviewPresentationInput {
  readonly selections: readonly LivePreviewSelectionRange[];
  readonly visibleRange: LivePreviewSelectionRange;
  readonly composing: boolean;
  readonly pendingReveal?: LivePreviewSelectionRange;
}

export function sourcePresentationRanges(
  input: LivePreviewPresentationInput,
): readonly LivePreviewSelectionRange[] {
  // 只有单一折叠 caret 才要求整个最小 block 退回源码。全选、普通范围选择和
  // 多选仍由 CodeMirror 的 source selection 负责；若把它们全交给 Planner，
  // 每个相交 block 都会被拆掉 widget，造成整篇 Markdown 回退源码和严重卡顿。
  //
  // 普通编辑阶段还有一个更重要的不变量：全局最多一个普通 source-active root。
  // `pendingReveal` 是一次性的显式激活请求，应覆盖先前 caret 的展示请求，而不与
  // 它合并成跨 block 范围。真正的唯一 root 决策由 Planner 在已确认 RenderNode
  // 集合中以半开区间完成；这里仅保证不会把多个 presentation range 交给它。
  if (input.composing) {
    const caret = input.selections.length === 1 &&
      input.selections[0]?.from === input.selections[0]?.to
      ? input.selections[0]
      : undefined;
    return caret === undefined ? [] : [normalize(caret)];
  }
  if (input.pendingReveal !== undefined) return [normalize(input.pendingReveal)];
  const collapsedCaret = input.selections.length === 1 &&
    input.selections[0]?.from === input.selections[0]?.to
    ? input.selections[0]
    : undefined;
  return collapsedCaret === undefined ? [] : [normalize(collapsedCaret)];
}

function normalize(range: LivePreviewSelectionRange): LivePreviewSelectionRange {
  return {
    from: Math.max(0, Math.min(range.from, range.to)),
    to: Math.max(0, Math.max(range.from, range.to)),
  };
}
