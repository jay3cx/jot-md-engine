/** Shared quote-width contract for semantic Preview, native rows and PreText. */
export const DEFAULT_QUOTE_MIN_CONTENT_WIDTH = 64;

export function quoteContentWidth(
  availableWidth: number,
  indentation: number,
  minimumContentWidth: number,
  depth: number,
): number {
  const end = Math.max(0, indentation);
  const reserve = Math.max(0, minimumContentWidth);
  const start = Math.min(Math.max(0, depth) * end, Math.max(0, availableWidth - end - reserve));
  return Math.max(1, availableWidth - start - end);
}
