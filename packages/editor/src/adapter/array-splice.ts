/** Move the suffix once, without spreading document-sized arrays as arguments. */
function moveSuffix<T>(items: T[], from: number, removeCount: number, insertCount: number): number {
  const start = Math.max(0, Math.min(items.length, Math.trunc(from)));
  const end = start + Math.max(0, Math.min(items.length - start, Math.trunc(removeCount)));
  const previousLength = items.length;
  const nextLength = previousLength - (end - start) + insertCount;
  if (nextLength > previousLength) items.length = nextLength;
  if (end < previousLength) items.copyWithin(start + insertCount, end, previousLength);
  if (nextLength < previousLength) items.length = nextLength;
  return start;
}

export function spliceItems<T>(items: T[], from: number, removeCount: number, inserted: readonly T[]): void {
  const start = moveSuffix(items, from, removeCount, inserted.length);
  for (let index = 0; index < inserted.length; index += 1) items[start + index] = inserted[index]!;
}

/** Insert unloaded projection slots without allocating an argument per slot. */
export function spliceSlots<T>(items: Array<T | undefined>, from: number, removeCount: number, insertCount: number): void {
  const start = moveSuffix(items, from, removeCount, insertCount);
  items.fill(undefined, start, start + insertCount);
}
