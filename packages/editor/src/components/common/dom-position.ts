/** DOM supplies visual positions; Rust-confirmed source ranges bound them. */
export interface DomSourceRange {
  readonly from: number;
  readonly to: number;
}

interface SourceAnchor extends DomSourceRange {
  readonly element: Element;
}

/** Missing attributes are not the valid source position zero. */
export function readDomSourceRange(element: Element): DomSourceRange | undefined {
  return readDomRange(element, "data-jot-source");
}

function readDomRange(element: Element, prefix: string): DomSourceRange | undefined {
  const rawFrom = element.getAttribute(`${prefix}-from`)?.trim();
  const rawTo = element.getAttribute(`${prefix}-to`)?.trim();
  if (rawFrom === undefined || rawTo === undefined ||
      !/^\d+$/u.test(rawFrom) || !/^\d+$/u.test(rawTo)) return undefined;
  const from = Number(rawFrom);
  const to = Number(rawTo);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from
    ? { from, to }
    : undefined;
}

/** Paint a caret in same-text anchors; hidden syntax and opaque renderers map to edges. */
export function domRangeForSourceOffset(root: HTMLElement, offset: number): Range | undefined {
  const sourceOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const candidates: Array<{ readonly node: Text; readonly from: number; readonly to: number }> = [];
  let nearest: { readonly distance: number; readonly node: Text; readonly offset: number } |
    { readonly distance: number; readonly element: HTMLElement; readonly before: boolean } | undefined;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode()) !== null) {
    if (current.nodeType !== Node.TEXT_NODE) continue;
    const anchor = closestSourceAnchor(current.parentElement, root);
    if (anchor === undefined || !hasSameTextShape(anchor)) continue;
    const local = textOffsetInAnchor(anchor.element, current, 0);
    const from = anchor.from + local;
    const to = Math.min(anchor.to, from + (current.textContent?.length ?? 0));
    if (from <= sourceOffset && sourceOffset <= to) {
      candidates.push({ node: current as Text, from, to });
    } else {
      // Markdown delimiters have source positions but no painted characters.
      // Keep the caret beside the nearest real text boundary instead of
      // collapsing to the unrelated end of the entire cell.
      const boundary = clamp(sourceOffset, from, to);
      const distance = Math.abs(sourceOffset - boundary);
      if (nearest === undefined || distance < nearest.distance) {
        nearest = { distance, node: current as Text,
          offset: clamp(boundary - from, 0, current.textContent?.length ?? 0) };
      }
    }
  }
  const candidate = candidates.sort((left, right) =>
    sourceAnchorScore(left, sourceOffset) - sourceAnchorScore(right, sourceOffset))[0];
  if (candidate !== undefined) {
    const range = root.ownerDocument.createRange();
    range.setStart(candidate.node, clamp(sourceOffset - candidate.from, 0, candidate.node.data.length));
    range.collapse(true);
    return range;
  }
  // Formulae, images and escape sequences do not have a character-for-
  // character visual map. Preserve their source range and choose an edge.
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-jot-kind="inline-math"], [data-jot-kind="image"], [data-jot-kind="escaped-text"]',
  )) {
    const anchor = readDomSourceRange(element);
    if (anchor === undefined) continue;
    const before = Math.abs(sourceOffset - anchor.from) <= Math.abs(sourceOffset - anchor.to);
    const boundary = before ? anchor.from : anchor.to;
    const distance = Math.abs(sourceOffset - boundary);
    if (nearest === undefined || distance < nearest.distance) nearest = { distance, element, before };
  }
  if (nearest !== undefined) {
    const range = root.ownerDocument.createRange();
    if ("node" in nearest) {
      range.setStart(nearest.node, nearest.offset);
      range.collapse(true);
    } else {
      range.selectNode(nearest.element);
      range.collapse(nearest.before);
    }
    return range;
  }
  const anchor = closestSourceAnchor(root, root);
  if (anchor === undefined) return undefined;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.collapse(sourceOffset <= anchor.from);
  return range;
}

/**
 * Exact text leaves map their UTF-16 offsets. Math glyphs, images and other
 * non-isomorphic DOM map only to semantic edges, never by rendered text length.
 * Every result is also bounded by the caller's confirmed semantic range.
 */
export function sourceOffsetAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  semanticRange: DomSourceRange,
  fallbackOffset = semanticRange.from,
): number {
  const fallback = clamp(fallbackOffset, semanticRange.from, semanticRange.to);
  const caret = caretAtPoint(root.ownerDocument, clientX, clientY);
  if (caret === undefined || !root.contains(caret.node)) return fallback;
  const anchor = closestSourceAnchor(
    caret.node.nodeType === Node.TEXT_NODE ? caret.node.parentElement : caret.node as Element,
    root,
  );
  if (anchor !== undefined && hasSameTextShape(anchor)) {
    const local = textOffsetInAnchor(anchor.element, caret.node, caret.offset);
    return clamp(anchor.from + local, semanticRange.from, semanticRange.to);
  }
  if (caret.node.nodeType !== Node.TEXT_NODE) {
    const boundary = sourceAnchorAtBoundary(caret.node, caret.offset, root);
    if (boundary !== undefined) return clamp(boundary, semanticRange.from, semanticRange.to);
  }
  if (anchor !== undefined) {
    const rect = anchor.element.getBoundingClientRect();
    const edge = clientX >= rect.left + rect.width / 2 ? anchor.to : anchor.from;
    return clamp(edge, semanticRange.from, semanticRange.to);
  }
  return fallback;
}

interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

function caretAtPoint(document: Document, x: number, y: number): CaretPoint | undefined {
  const withCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => {
      readonly offsetNode: Node;
      readonly offset: number;
    } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = withCaret.caretPositionFromPoint?.(x, y);
  if (position !== undefined && position !== null) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = withCaret.caretRangeFromPoint?.(x, y);
  return range === null || range === undefined
    ? undefined
    : { node: range.startContainer, offset: range.startOffset };
}

function closestSourceAnchor(element: Element | null, root: HTMLElement): SourceAnchor | undefined {
  let current: Element | null = element;
  while (current !== null) {
    const range = readDomSourceRange(current);
    if (range !== undefined) {
      // Inline code paints the Rust-confirmed contentRange, not its tick
      // delimiters. Only that explicit metadata can establish an exact map.
      const content = current.getAttribute("data-jot-kind") === "inline-code"
        ? readDomRange(current, "data-jot-source-content")
        : undefined;
      const mapped = content !== undefined && content.from >= range.from && content.to <= range.to
        ? content
        : range;
      return { ...mapped, element: current };
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return undefined;
}

function hasSameTextShape(anchor: SourceAnchor): boolean {
  const kind = anchor.element.getAttribute("data-jot-kind");
  if (kind === "inline-math" || kind === "math-block" || kind === "image" ||
      anchor.element.closest(".katex, mjx-container") !== null) return false;
  const length = anchor.element.textContent?.length ?? 0;
  return length === anchor.to - anchor.from ||
    (kind === "source-line" && length + 1 === anchor.to - anchor.from);
}

function sourceAnchorScore(candidate: DomSourceRange, offset: number): number {
  const boundary = offset === candidate.from ? 0 : offset === candidate.to ? 1 : 2;
  return Math.max(0, candidate.to - candidate.from) * 3 + boundary;
}

function textOffsetInAnchor(anchor: Element, target: Node, offset: number): number {
  if (target.nodeType !== Node.TEXT_NODE) {
    const range = anchor.ownerDocument.createRange();
    range.selectNodeContents(anchor);
    range.setEnd(target, clamp(offset, 0, target.childNodes.length));
    return range.toString().length;
  }
  const walker = anchor.ownerDocument.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current: Node | null;
  while ((current = walker.nextNode()) !== null) {
    if (current === target) return total + clamp(offset, 0, current.textContent?.length ?? 0);
    total += current.textContent?.length ?? 0;
  }
  return 0;
}

function sourceAnchorAtBoundary(node: Node, offset: number, root: HTMLElement): number | undefined {
  const previous = node.childNodes[offset - 1];
  const next = node.childNodes[offset];
  const previousText = previous === undefined ? undefined : lastTextNode(previous);
  if (previousText !== undefined) {
    const anchor = closestSourceAnchor(previousText.parentElement, root);
    if (anchor !== undefined) return anchor.to;
  }
  const nextText = next === undefined ? undefined : firstTextNode(next);
  if (nextText !== undefined) {
    const anchor = closestSourceAnchor(nextText.parentElement, root);
    if (anchor !== undefined) return anchor.from;
  }
  const anchor = closestSourceAnchor(node as Element, root);
  return anchor === undefined ? undefined : offset <= 0 ? anchor.from : anchor.to;
}

function firstTextNode(node: Node): Node | undefined {
  if (node.nodeType === Node.TEXT_NODE) return node;
  for (const child of Array.from(node.childNodes)) {
    const text = firstTextNode(child);
    if (text !== undefined) return text;
  }
  return undefined;
}

function lastTextNode(node: Node): Node | undefined {
  if (node.nodeType === Node.TEXT_NODE) return node;
  const children = Array.from(node.childNodes);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const text = lastTextNode(children[index]!);
    if (text !== undefined) return text;
  }
  return undefined;
}

function clamp(value: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, value));
}
