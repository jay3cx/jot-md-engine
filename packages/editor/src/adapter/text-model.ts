import type {
  TextEdit,
  TextRange,
  Utf16Offset,
} from "@jot-md/editor-protocol";

export interface SourceLineSlice {
  readonly line: number;
  readonly range: TextRange;
  readonly text: string;
}

export interface SourceLinePreview extends SourceLineSlice {
  readonly fullUtf16Length: number;
  readonly contentVersion: number;
}

export interface TextLineChange {
  readonly fromLine: number;
  readonly removeCount: number;
  readonly insertCount: number;
}

/**
 * 权威 LF 规范化源码的前端镜像。
 * JavaScript 字符串偏移是 UTF-16 code unit，与 wire protocol 一致。
 */
export class Utf16TextModel {
  #text: string;
  #lineStarts: number[];

  constructor(source = "") {
    assertLfNormalized(source);
    this.#text = source;
    this.#lineStarts = collectLineStarts(source);
  }

  get text(): string {
    return this.#text;
  }

  get utf16Length(): number {
    return this.#text.length;
  }

  get lineCount(): number {
    return this.#lineStarts.length;
  }

  lineAt(offset: Utf16Offset): number {
    this.#assertOffset(offset);
    return Math.max(0, upperBound(this.#lineStarts, Number(offset)) - 1);
  }

  lineRange(line: number): TextRange {
    if (!Number.isInteger(line) || line < 0 || line >= this.lineCount) {
      throw new RangeError("line index is outside the document");
    }
    const from = this.#lineStarts[line]!;
    const next = this.#lineStarts[line + 1];
    const to = next === undefined ? this.#text.length : next - 1;
    return range(from, to);
  }

  lines(fromLine: number, toLineExclusive: number): readonly SourceLineSlice[] {
    const from = Math.max(0, Math.min(this.lineCount, fromLine));
    const to = Math.max(from, Math.min(this.lineCount, toLineExclusive));
    const result: SourceLineSlice[] = [];
    for (let line = from; line < to; line += 1) {
      const lineRange = this.lineRange(line);
      result.push({
        line,
        range: lineRange,
        text: this.#text.slice(Number(lineRange.from), Number(lineRange.to)),
      });
    }
    return result;
  }

  /**
   * 为只读虚拟渲染返回有界文本。超长物理行绝不会再分配一份同等大小的
   * JavaScript 字符串。
   */
  linePreviews(
    fromLine: number,
    toLineExclusive: number,
    maxUtf16: number,
  ): readonly SourceLinePreview[] {
    if (!Number.isSafeInteger(maxUtf16) || maxUtf16 <= 0) {
      throw new RangeError("maxUtf16 must be a positive safe integer");
    }
    const from = Math.max(0, Math.min(this.lineCount, fromLine));
    const to = Math.max(from, Math.min(this.lineCount, toLineExclusive));
    const result: SourceLinePreview[] = [];
    for (let line = from; line < to; line += 1) {
      const lineRange = this.lineRange(line);
      const start = Number(lineRange.from);
      const end = Number(lineRange.to);
      const fullUtf16Length = end - start;
      const previewEnd = safeSliceEnd(this.#text, start, Math.min(end, start + maxUtf16));
      const text = this.#text.slice(start, previewEnd);
      result.push({
        line,
        range: lineRange,
        text,
        fullUtf16Length,
        contentVersion: sampledContentVersion(this.#text, start, end, text),
      });
    }
    return result;
  }

  apply(edits: readonly TextEdit[]): readonly TextLineChange[] {
    validateEdits(this.#text, edits);
    if (edits.length > 1) {
      // All edit offsets refer to the same original revision. Stream that
      // revision once instead of shifting a line-index suffix and flattening
      // the intermediate string for every changed table row.
      const starts: number[] = [];
      const pieces: string[] = [];
      const changes: TextLineChange[] = [];
      let line = 0, cursor = 0, delta = 0;
      for (const edit of edits) {
        const from = Number(edit.range.from), to = Number(edit.range.to);
        pieces.push(this.#text.slice(cursor, from), edit.insert);
        while (line < this.#lineStarts.length && this.#lineStarts[line]! <= from) {
          starts.push(this.#lineStarts[line++]! + delta);
        }
        const fromLine = line - 1;
        while (line < this.#lineStarts.length && this.#lineStarts[line]! <= to) line += 1;
        const originalLineCount = line - fromLine;
        let insertedLineCount = 1;
        for (let index = edit.insert.indexOf("\n"); index >= 0; index = edit.insert.indexOf("\n", index + 1)) {
          starts.push(from + delta + index + 1);
          insertedLineCount += 1;
        }
        changes.push({fromLine, removeCount: originalLineCount, insertCount: insertedLineCount});
        delta += edit.insert.length - (to - from);
        cursor = to;
      }
      pieces.push(this.#text.slice(cursor));
      while (line < this.#lineStarts.length) starts.push(this.#lineStarts[line++]! + delta);
      this.#text = pieces.join("");
      this.#lineStarts = starts;
      return changes.reverse();
    }
    const lineChanges: TextLineChange[] = [];
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index]!;
      const from = Number(edit.range.from);
      const to = Number(edit.range.to);
      const fromLine = this.lineAt(edit.range.from);
      const toLine = this.lineAt(edit.range.to);
      lineChanges.push({
        fromLine,
        removeCount: toLine - fromLine + 1,
        insertCount: countLf(edit.insert) + 1,
      });
      const delta = edit.insert.length - (to - from);
      const removeFrom = upperBound(this.#lineStarts, from);
      const removeTo = upperBound(this.#lineStarts, to);
      const inserted: number[] = [];
      for (let cursor = 0; cursor < edit.insert.length; cursor += 1) {
        if (edit.insert.charCodeAt(cursor) === 10) {
          inserted.push(from + cursor + 1);
        }
      }
      if (removeFrom === removeTo && inserted.length === 0) {
        if (delta !== 0) {
          for (let line = removeTo; line < this.#lineStarts.length; line += 1) {
            this.#lineStarts[line] = this.#lineStarts[line]! + delta;
          }
        }
      } else {
        this.#lineStarts = this.#lineStarts.slice(0, removeFrom).concat(
          inserted,
          this.#lineStarts.slice(removeTo).map((start) => start + delta),
        );
      }
      this.#text = `${this.#text.slice(0, from)}${edit.insert}${this.#text.slice(to)}`;
    }
    return lineChanges;
  }

  #assertOffset(offset: Utf16Offset): void {
    const value = Number(offset);
    if (!isValidBoundary(this.#text, value)) {
      throw new RangeError("offset is outside the document or splits a surrogate pair");
    }
  }
}

function countLf(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function safeSliceEnd(source: string, start: number, requestedEnd: number): number {
  if (requestedEnd <= start || requestedEnd >= source.length) return requestedEnd;
  const previous = source.charCodeAt(requestedEnd - 1);
  const next = source.charCodeAt(requestedEnd);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? requestedEnd + 1
    : requestedEnd;
}

function sampledContentVersion(
  source: string,
  from: number,
  to: number,
  prefix: string,
): number {
  let hash = 0x811c9dc5;
  const update = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  update(prefix);
  if (prefix.length < to - from) update(source.slice(Math.max(from, to - 128), to));
  hash ^= to - from;
  return hash >>> 0;
}

export function normalizeInsertedText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function validateEdits(source: string, edits: readonly TextEdit[]): void {
  let previousTo = 0;
  for (const [index, edit] of edits.entries()) {
    assertLfNormalized(edit.insert);
    const from = Number(edit.range.from);
    const to = Number(edit.range.to);
    if (
      from > to ||
      !isValidBoundary(source, from) ||
      !isValidBoundary(source, to) ||
      (index > 0 && from < previousTo)
    ) {
      throw new RangeError("edits must be ordered, non-overlapping UTF-16 ranges");
    }
    previousTo = to;
  }
}

export function range(from: number, to: number): TextRange {
  return { from: from as Utf16Offset, to: to as Utf16Offset };
}

function collectLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function upperBound(values: readonly number[], target: number): number {
  let from = 0;
  let to = values.length;
  while (from < to) {
    const middle = from + Math.floor((to - from) / 2);
    if (values[middle]! <= target) from = middle + 1;
    else to = middle;
  }
  return from;
}

function isValidBoundary(source: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return false;
  if (offset === 0 || offset === source.length) return true;
  const previous = source.charCodeAt(offset - 1);
  const next = source.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function assertLfNormalized(source: string): void {
  if (source.includes("\r")) throw new TypeError("frontend source must be LF-normalized");
}
