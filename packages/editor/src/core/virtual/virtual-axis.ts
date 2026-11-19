export interface VirtualWindow {
  readonly from: number;
  readonly toExclusive: number;
  readonly beforePixels: number;
  readonly afterPixels: number;
  readonly totalPixels: number;
}

export interface VirtualSplice {
  readonly from: number;
  readonly removeCount: number;
  readonly insertCount: number;
}

/**
 * 由 Fenwick tree 支持的可变尺寸虚拟轴。测量更新和 offset 到 index 的查询都为
 * O(log n)；未测量条目使用统一估算值。
 */
export class VirtualAxis {
  readonly estimatedSize: number;
  #sizes = new Float64Array(0);
  #measured = new Uint8Array(0);
  #tree = new Float64Array(1);
  #measuredIndices = new Set<number>();
  #nonDefaultIndices = new Set<number>();

  constructor(estimatedSize: number) {
    if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
      throw new RangeError("estimatedSize must be positive");
    }
    this.estimatedSize = estimatedSize;
  }

  get count(): number {
    return this.#sizes.length;
  }

  get totalSize(): number {
    return this.#prefix(this.count);
  }

  resize(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("virtual item count must be a non-negative safe integer");
    }
    if (count === this.count) return;
    const sizes = new Float64Array(count);
    const copied = Math.min(count, this.count);
    sizes.set(this.#sizes.subarray(0, copied));
    sizes.fill(this.estimatedSize, copied);
    const measured = new Uint8Array(count);
    measured.set(this.#measured.subarray(0, copied));
    this.#sizes = sizes;
    this.#measured = measured;
    this.#reindexSparseState();
    this.#rebuildTree();
  }

  /** 对齐结构补丁的删除与插入。只重估换掉的槽位，未改后缀的测量随索引一起平移。 */
  splice(from: number, removeCount: number, insertCount: number): void {
    if (
      !Number.isSafeInteger(from) || from < 0 || from > this.count ||
      !Number.isSafeInteger(removeCount) || removeCount < 0 ||
      !Number.isSafeInteger(insertCount) || insertCount < 0
    ) {
      throw new RangeError("virtual splice values must be non-negative safe integers");
    }
    const removed = Math.min(removeCount, this.count - from);
    if (removed === insertCount) {
      for (let index = from; index < from + removed; index += 1) this.resetSize(index);
      return;
    }
    const nextCount = this.count - removed + insertCount;
    const sizes = new Float64Array(nextCount);
    const measured = new Uint8Array(nextCount);
    sizes.set(this.#sizes.subarray(0, from), 0);
    measured.set(this.#measured.subarray(0, from), 0);
    sizes.fill(this.estimatedSize, from, from + insertCount);
    const oldSuffix = from + removed;
    const newSuffix = from + insertCount;
    sizes.set(this.#sizes.subarray(oldSuffix), newSuffix);
    measured.set(this.#measured.subarray(oldSuffix), newSuffix);
    this.#sizes = sizes;
    this.#measured = measured;
    this.#reindexSparseState();
    this.#rebuildTree();
  }

  sizeAt(index: number): number {
    this.#assertIndex(index);
    return this.#sizes[index]!;
  }

  setSize(index: number, pixels: number): boolean {
    this.#assertIndex(index);
    if (!Number.isFinite(pixels) || pixels <= 0) return false;
    const previous = this.#sizes[index]!;
    this.#measured[index] = 1;
    this.#measuredIndices.add(index);
    if (Math.abs(previous - pixels) < 0.5) return false;
    this.#sizes[index] = pixels;
    this.#trackNonDefault(index, pixels);
    this.#add(index, pixels - previous);
    return true;
  }

  isMeasured(index: number): boolean {
    this.#assertIndex(index);
    return this.#measured[index] === 1;
  }

  setEstimate(index: number, pixels: number): boolean {
    this.#assertIndex(index);
    if (this.#measured[index] === 1 || !Number.isFinite(pixels) || pixels <= 0) {
      return false;
    }
    const previous = this.#sizes[index]!;
    if (Math.abs(previous - pixels) < 0.5) return false;
    this.#sizes[index] = pixels;
    this.#trackNonDefault(index, pixels);
    this.#add(index, pixels - previous);
    return true;
  }

  resetSize(index: number, estimatedPixels = this.estimatedSize): boolean {
    this.#assertIndex(index);
    if (!Number.isFinite(estimatedPixels) || estimatedPixels <= 0) return false;
    const previous = this.#sizes[index]!;
    this.#measured[index] = 0;
    this.#measuredIndices.delete(index);
    if (Math.abs(previous - estimatedPixels) < 0.5) return false;
    this.#sizes[index] = estimatedPixels;
    this.#trackNonDefault(index, estimatedPixels);
    this.#add(index, estimatedPixels - previous);
    return true;
  }

  invalidate(from = 0, toExclusive = this.count): void {
    const fromIndex = Math.max(0, Math.min(this.count, from));
    const toIndex = Math.max(fromIndex, Math.min(this.count, toExclusive));
    const candidates = new Set([...this.#measuredIndices, ...this.#nonDefaultIndices]);
    for (const index of candidates) {
      if (index < fromIndex || index >= toIndex) continue;
      const previous = this.#sizes[index]!;
      this.#sizes[index] = this.estimatedSize;
      this.#measured[index] = 0;
      this.#measuredIndices.delete(index);
      this.#nonDefaultIndices.delete(index);
      this.#add(index, this.estimatedSize - previous);
    }
  }

  offsetAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.count) {
      throw new RangeError("virtual offset index is outside the axis");
    }
    return this.#prefix(index);
  }

  indexAt(pixelOffset: number): number {
    if (this.count === 0) return 0;
    const target = Math.max(0, Math.min(pixelOffset, this.totalSize));
    let index = 0;
    let accumulated = 0;
    let bit = highestPowerOfTwoAtMost(this.count);
    while (bit !== 0) {
      const next = index + bit;
      if (next <= this.count && accumulated + this.#tree[next]! <= target) {
        index = next;
        accumulated += this.#tree[next]!;
      }
      bit >>= 1;
    }
    return Math.min(index, this.count - 1);
  }

  window(
    viewportStart: number,
    viewportSize: number,
    overscanPixels: number,
  ): VirtualWindow {
    if (this.count === 0) {
      return {
        from: 0,
        toExclusive: 0,
        beforePixels: 0,
        afterPixels: 0,
        totalPixels: 0,
      };
    }
    const start = Math.max(0, viewportStart - Math.max(0, overscanPixels));
    const end = Math.min(
      this.totalSize,
      viewportStart + Math.max(0, viewportSize) + Math.max(0, overscanPixels),
    );
    const from = this.indexAt(start);
    const toExclusive = Math.min(this.count, this.indexAt(end) + 1);
    const beforePixels = this.offsetAt(from);
    const renderedEnd = this.offsetAt(toExclusive);
    return {
      from,
      toExclusive,
      beforePixels,
      afterPixels: Math.max(0, this.totalSize - renderedEnd),
      totalPixels: this.totalSize,
    };
  }

  #prefix(count: number): number {
    let sum = 0;
    for (let index = count; index > 0; index -= index & -index) {
      sum += this.#tree[index]!;
    }
    return sum;
  }

  #add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
      this.#tree[cursor] = this.#tree[cursor]! + delta;
    }
  }

  #rebuildTree(): void {
    this.#tree = new Float64Array(this.count + 1);
    // Linear Fenwick construction. Repeated point updates cost O(n log n)
    // even though each tree slot needs to propagate to only one parent.
    for (let index = 1; index <= this.count; index += 1) {
      this.#tree[index] = this.#tree[index]! + this.#sizes[index - 1]!;
      const parent = index + (index & -index);
      if (parent <= this.count) this.#tree[parent] = this.#tree[parent]! + this.#tree[index]!;
    }
  }

  #reindexSparseState(): void {
    this.#measuredIndices.clear();
    this.#nonDefaultIndices.clear();
    for (let index = 0; index < this.count; index += 1) {
      if (this.#measured[index] === 1) this.#measuredIndices.add(index);
      if (Math.abs(this.#sizes[index]! - this.estimatedSize) >= 0.5) {
        this.#nonDefaultIndices.add(index);
      }
    }
  }

  #trackNonDefault(index: number, pixels: number): void {
    if (Math.abs(pixels - this.estimatedSize) < 0.5) this.#nonDefaultIndices.delete(index);
    else this.#nonDefaultIndices.add(index);
  }

  #assertIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError("virtual item index is outside the axis");
    }
  }
}

function highestPowerOfTwoAtMost(value: number): number {
  if (value <= 0) return 0;
  return 2 ** Math.floor(Math.log2(value));
}
