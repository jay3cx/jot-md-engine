/** Locate up to a Rust-confirmed number of physical quote prefixes. */
export function quotePrefix(
  source: string,
  from: number,
  maximumDepth: number,
): { readonly from: number; readonly to: number; readonly depth: number } | undefined {
  const newline = source.indexOf("\n", from);
  const end = newline < 0 ? source.length : newline;
  let cursor = from, depth = 0;
  while (cursor < end && depth < maximumDepth) {
    let marker = cursor, spaces = 0;
    while (marker < end && source[marker] === " " && spaces < 3) { marker += 1; spaces += 1; }
    if (source[marker] !== ">") break;
    cursor = marker + 1;
    if (source[cursor] === " " || source[cursor] === "\t") cursor += 1;
    depth += 1;
  }
  return depth > 0 ? { from, to: cursor, depth } : undefined;
}
