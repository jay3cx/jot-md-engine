import type { TextEdit } from "@jot-md/editor-protocol";

import { range } from "./text-model.js";

/**
 * 在两个 JavaScript UTF-16 字符串之间生成一个最小替换。
 * 范围边界会避开 surrogate pair 的内部。
 */
export function singleTextEdit(
  previous: string,
  next: string,
  selectionAfter?: number,
): readonly TextEdit[] {
  if (previous === next) return [];
  const hinted = editFromSelectionHint(previous, next, selectionAfter);
  if (hinted !== undefined) return [hinted];
  const sharedLimit = Math.min(previous.length, next.length);
  let prefix = 0;
  while (
    prefix < sharedLimit &&
    previous.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  if (splitsSurrogate(previous, prefix) || splitsSurrogate(next, prefix)) {
    prefix -= 1;
  }

  let suffix = 0;
  while (
    previous.length - suffix > prefix &&
    next.length - suffix > prefix &&
    previous.charCodeAt(previous.length - suffix - 1) ===
      next.charCodeAt(next.length - suffix - 1)
  ) {
    suffix += 1;
  }
  while (
    suffix > 0 &&
    (
      splitsSurrogate(previous, previous.length - suffix) ||
      splitsSurrogate(next, next.length - suffix)
    )
  ) {
    suffix -= 1;
  }

  return [{
    range: range(prefix, previous.length - suffix),
    insert: next.slice(prefix, next.length - suffix),
  }];
}

/**
 * 相邻重复字符会让只看值的 diff 产生歧义：在已有 LF 前插入 LF，与在其后插入
 * LF 产生相同文本。宿主选区可以解决归属；当它能精确重建新值时必须优先。
 */
function editFromSelectionHint(
  previous: string,
  next: string,
  selectionAfter: number | undefined,
): TextEdit | undefined {
  if (
    selectionAfter === undefined ||
    !Number.isSafeInteger(selectionAfter) ||
    selectionAfter < 0 ||
    selectionAfter > next.length
  ) {
    return undefined;
  }
  const delta = next.length - previous.length;
  if (delta > 0) {
    const from = selectionAfter - delta;
    if (from < 0 || from > previous.length) return undefined;
    if (splitsSurrogate(previous, from) || splitsSurrogate(next, selectionAfter)) {
      return undefined;
    }
    const insert = next.slice(from, selectionAfter);
    if (previous.slice(0, from) + insert + previous.slice(from) === next) {
      return { range: range(from, from), insert };
    }
  } else if (delta < 0) {
    const from = selectionAfter;
    const to = from - delta;
    if (
      to <= previous.length &&
      !splitsSurrogate(previous, from) &&
      !splitsSurrogate(previous, to) &&
      !splitsSurrogate(next, selectionAfter) &&
      previous.slice(0, from) + previous.slice(to) === next
    ) {
      return { range: range(from, to), insert: "" };
    }
  }
  return undefined;
}

function splitsSurrogate(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}
