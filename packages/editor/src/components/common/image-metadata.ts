import type { ImageMetadata } from "./dom-renderer.js";

// Intrinsic dimensions survive virtual unmounts, but never cross documents.
const documents = new WeakMap<Document, Map<string, ImageMetadata>>();
function key(document: Document, source: string): string {
  try { return new URL(source, document.baseURI).href; } catch { return source; }
}
export function cachedImageMetadata(document: Document, source: string): ImageMetadata | undefined {
  return documents.get(document)?.get(key(document, source));
}
export function rememberImageMetadata(image: HTMLImageElement, source: string): ImageMetadata | undefined {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return undefined;
  let cache = documents.get(image.ownerDocument);
  if (cache === undefined) documents.set(image.ownerDocument, cache = new Map());
  const metadata = { width: image.naturalWidth, height: image.naturalHeight };
  const url = key(image.ownerDocument, source);
  cache.delete(url);
  cache.set(url, metadata);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  return metadata;
}
