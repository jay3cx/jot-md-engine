export type PreTextWhiteSpace = "normal" | "pre-wrap";

export interface PreTextTextStyle {
  readonly font: string;
  readonly whiteSpace?: PreTextWhiteSpace;
  readonly letterSpacing?: number;
}

export interface PreTextLayoutResult {
  readonly lineCount: number;
  readonly height: number;
}

export interface PreTextTextMeasurer {
  measure(text: string, font: string): number;
}

export interface PreTextTextLayoutOptions {
  readonly document?: Document;
  readonly fallbackCharacterWidth?: number;
  readonly cacheSize?: number;
  readonly measurer?: PreTextTextMeasurer;
}

export interface PreTextPreparedSegment {
  readonly text: string;
  readonly width: number;
  readonly hardBreak: boolean;
}

export interface PreparedPreText {
  readonly text: string;
  readonly styleKey: string;
  readonly segments: readonly PreTextPreparedSegment[];
}

/**
 * 面向 Markdown inline 文本的两阶段布局器。
 *
 * `prepare` 只在文本或字体变化时分段、测量并缓存；`layout` 只遍历已缓存的
 * 片段。它不读取 DOM，也不持有虚拟列表或滚动状态。
 */
export class PreTextTextLayout {
  readonly #measurer: PreTextTextMeasurer;
  readonly #cacheSize: number;
  readonly #prepared = new Map<string, PreparedPreText>();
  readonly #segmentWidths = new Map<string, number>();

  constructor(options: PreTextTextLayoutOptions = {}) {
    this.#cacheSize = positiveInteger(options.cacheSize, 256);
    this.#measurer = options.measurer ?? createCanvasMeasurer(
      options.document,
      positive(options.fallbackCharacterWidth, 8),
    );
  }

  prepare(text: string, style: PreTextTextStyle): PreparedPreText {
    const normalized = normalizeText(text, style.whiteSpace ?? "pre-wrap");
    const styleKey = textStyleKey(style);
    const key = `${styleKey}\u0000${normalized}`;
    const cached = this.#prepared.get(key);
    if (cached !== undefined) {
      this.#prepared.delete(key);
      this.#prepared.set(key, cached);
      return cached;
    }

    const segments = segmentGraphemes(normalized).map((segment) => ({
      text: segment,
      width: segment === "\n" ? 0 : this.#measure(segment, style),
      hardBreak: segment === "\n",
    }));
    const prepared = { text: normalized, styleKey, segments };
    this.#prepared.set(key, prepared);
    this.#trim(this.#prepared);
    return prepared;
  }

  layout(
    prepared: PreparedPreText,
    maxWidth: number,
    lineHeight: number,
  ): PreTextLayoutResult {
    const width = Math.max(1, maxWidth);
    let lineCount = 1;
    let lineWidth = 0;
    for (const segment of prepared.segments) {
      if (segment.hardBreak) {
        lineCount += 1;
        lineWidth = 0;
        continue;
      }
      if (lineWidth > 0 && lineWidth + segment.width > width) {
        lineCount += 1;
        lineWidth = segment.width;
      } else {
        lineWidth += segment.width;
      }
    }
    return {
      lineCount: Math.max(1, lineCount),
      height: Math.max(1, lineCount) * positive(lineHeight, 1),
    };
  }

  layoutText(
    text: string,
    style: PreTextTextStyle,
    maxWidth: number,
    lineHeight: number,
  ): PreTextLayoutResult {
    return this.layout(this.prepare(text, style), maxWidth, lineHeight);
  }

  clear(): void {
    this.#prepared.clear();
    this.#segmentWidths.clear();
  }

  #measure(text: string, style: PreTextTextStyle): number {
    const letterSpacing = finiteNonNegative(style.letterSpacing);
    const key = `${style.font}\u0000${letterSpacing}\u0000${text}`;
    const cached = this.#segmentWidths.get(key);
    if (cached !== undefined) return cached;
    const width = Math.max(0, this.#measurer.measure(text, style.font)) + letterSpacing;
    this.#segmentWidths.set(key, width);
    this.#trim(this.#segmentWidths);
    return width;
  }

  #trim<T>(cache: Map<string, T>): void {
    while (cache.size > this.#cacheSize) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      cache.delete(oldest);
    }
  }
}

export function createCanvasMeasurer(
  document: Document | undefined,
  fallbackCharacterWidth: number,
): PreTextTextMeasurer {
  const context = document?.createElement("canvas").getContext("2d") ?? undefined;
  return {
    measure(text, font) {
      if (context === undefined) return graphemeCount(text) * fallbackCharacterWidth;
      try {
        context.font = font;
        return context.measureText(text).width;
      } catch {
        return graphemeCount(text) * fallbackCharacterWidth;
      }
    },
  };
}

function segmentGraphemes(value: string): readonly string[] {
  const Segmenter = (globalThis.Intl as typeof Intl & {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => {
      segment(text: string): Iterable<{ readonly segment: string }>;
    };
  }).Segmenter;
  if (Segmenter !== undefined) {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}

function normalizeText(value: string, whiteSpace: PreTextWhiteSpace): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return whiteSpace === "normal" ? normalized.replace(/\s+/gu, " ") : normalized;
}

function textStyleKey(style: PreTextTextStyle): string {
  return [
    style.font,
    style.whiteSpace ?? "pre-wrap",
    finiteNonNegative(style.letterSpacing),
  ].join(":");
}

function graphemeCount(value: string): number {
  return Math.max(1, segmentGraphemes(value).length);
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}
