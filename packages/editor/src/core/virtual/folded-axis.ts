import { VirtualAxis } from "./virtual-axis.js";

export interface HiddenBlockRange {
  readonly from: number;
  readonly toExclusive: number;
}

/** A view over the original axis. Hidden blocks retain their measured sizes. */
export class FoldedVirtualAxis extends VirtualAxis {
  readonly #base: VirtualAxis;
  #hidden: Array<HiddenBlockRange & { visibleFrom: number; hiddenBefore: number; pixelsBefore: number }> = [];
  #requested: readonly HiddenBlockRange[] = [];
  #hiddenCount = 0;
  #hiddenPixels = 0;

  constructor(base: VirtualAxis, estimate: number) {
    super(estimate);
    this.#base = base;
  }

  get count(): number { return this.#base.count - this.#hiddenCount; }
  get totalSize(): number { return Math.max(0, this.#base.totalSize - this.#hiddenPixels); }
  get physicalCount(): number { return this.#base.count; }

  setHidden(ranges: readonly HiddenBlockRange[]): void {
    this.#requested = ranges.map(range => ({ ...range }));
    const sorted = ranges.map(({ from, toExclusive }) => ({
      from: Math.max(0, Math.min(this.#base.count, from)),
      toExclusive: Math.max(0, Math.min(this.#base.count, toExclusive)),
    })).filter(range => range.toExclusive > range.from)
      .sort((a, b) => a.from - b.from || b.toExclusive - a.toExclusive);
    const merged: Array<{ from: number; toExclusive: number }> = [];
    for (const range of sorted) {
      const previous = merged.at(-1);
      if (previous !== undefined && range.from <= previous.toExclusive) {
        previous.toExclusive = Math.max(previous.toExclusive, range.toExclusive);
      } else merged.push({ ...range });
    }
    let hidden = 0, pixels = 0;
    this.#hidden = merged.map(range => {
      const item = { ...range, visibleFrom: range.from - hidden, hiddenBefore: hidden, pixelsBefore: pixels };
      hidden += range.toExclusive - range.from;
      pixels += this.#base.offsetAt(range.toExclusive) - this.#base.offsetAt(range.from);
      return item;
    });
    this.#hiddenCount = hidden;
    this.#hiddenPixels = pixels;
  }

  physicalAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.count) throw new RangeError("visible index outside axis");
    let low = 0, high = this.#hidden.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#hidden[middle]!.visibleFrom <= index) low = middle + 1;
      else high = middle;
    }
    const last = this.#hidden[low - 1];
    return index + (last === undefined ? 0 : last.hiddenBefore + last.toExclusive - last.from);
  }

  visibleAt(index: number): number {
    const position = Math.max(0, Math.min(this.#base.count, index));
    let low = 0, high = this.#hidden.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.#hidden[middle]!.from <= position) low = middle + 1; else high = middle; }
    const range = this.#hidden[low - 1];
    if (range !== undefined && position < range.toExclusive) return Math.max(0, range.visibleFrom - 1);
    const hidden = range === undefined ? 0 : range.hiddenBefore + range.toExclusive - range.from;
    return Math.max(0, Math.min(this.count, position - hidden));
  }

  physicalRanges(from: number, toExclusive: number): HiddenBlockRange[] {
    const ranges: HiddenBlockRange[] = [];
    let start = this.physicalAt(Math.max(0, Math.min(this.count, from)));
    const end = this.physicalAt(Math.max(from, Math.min(this.count, toExclusive)));
    let low = 0, high = this.#hidden.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.#hidden[middle]!.toExclusive <= start) low = middle + 1; else high = middle; }
    for (let index = low; index < this.#hidden.length; index++) {
      const hidden = this.#hidden[index]!;
      if (hidden.from >= end) break;
      if (start < hidden.from) ranges.push({ from: start, toExclusive: hidden.from });
      start = Math.max(start, hidden.toExclusive);
    }
    if (start < end) ranges.push({ from: start, toExclusive: end });
    return ranges;
  }

  resize(count: number): void { this.#base.resize(count); this.#recalculate(); }
  splice(from: number, removeCount: number, insertCount: number): void {
    const physical = this.physicalAt(from);
    this.#base.splice(physical, removeCount, insertCount);
    const delta = insertCount - removeCount;
    const moved = this.#hidden.map(range => ({
      from: range.from >= physical + removeCount ? range.from + delta : range.from,
      toExclusive: range.toExclusive >= physical + removeCount ? range.toExclusive + delta : range.toExclusive,
    }));
    this.setHidden(moved);
  }
  sizeAt(index: number): number { return this.#base.sizeAt(this.physicalAt(index)); }
  setSize(index: number, pixels: number): boolean { return this.#base.setSize(this.physicalAt(index), pixels); }
  isMeasured(index: number): boolean { return this.#base.isMeasured(this.physicalAt(index)); }
  setEstimate(index: number, pixels: number): boolean { return this.#base.setEstimate(this.physicalAt(index), pixels); }
  resetSize(index: number, estimate?: number): boolean { return this.#base.resetSize(this.physicalAt(index), estimate); }
  invalidate(): void { this.#base.invalidate(); this.#recalculate(); }
  offsetAt(index: number): number {
    const physical = this.physicalAt(index);
    let low = 0, high = this.#hidden.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.#hidden[middle]!.toExclusive <= physical) low = middle + 1; else high = middle; }
    const range = this.#hidden[low - 1];
    const pixels = range === undefined ? 0 : range.pixelsBefore + this.#base.offsetAt(range.toExclusive) - this.#base.offsetAt(range.from);
    return this.#base.offsetAt(physical) - pixels;
  }
  indexAt(pixelOffset: number): number {
    if (this.count === 0) return 0;
    const target = Math.max(0, Math.min(pixelOffset, this.totalSize));
    let low = 0, high = this.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsetAt(middle + 1) <= target) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, this.count - 1);
  }
  #recalculate(): void { this.setHidden(this.#requested); }
}
