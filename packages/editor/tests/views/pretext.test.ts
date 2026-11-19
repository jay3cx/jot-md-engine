import { type RenderNode, type Revision, type Utf16Offset } from "../../../editor-protocol/src/index.js";
import { range } from "../../src/adapter/index.js";
import { DEFAULT_PRETEXT_STYLE_METRICS, PreTextProjectionFilter } from "../../src/layout/pretext/filter.js";
import { PreTextTextLayout } from "../../src/layout/pretext/text-layout.js";
import { renderNode } from "./fixtures/render-node.js";

function pretext_filter_aligns_semantic_component_estimators(): void {
  const heading = renderNode("heading", { type: "deferred" }, [{
    name: "level",
    value: { type: "number", value: 1 },
  }]);
  const image = renderNode("image", { type: "source" }, [{
    name: "destination",
    value: { type: "string", value: "/diagram.svg" },
  }]);
  const paragraphWithImage = renderNode("paragraph", {
    type: "structured",
    children: [image],
  });
  const table = {
    ...renderNode("table", { type: "deferred" }, [{
      name: "alignments",
      value: { type: "strings" as const, value: ["left", "center", "right"] },
    }]),
    childCount: 5,
  };
  const listItem = renderNode("list-item", { type: "deferred" }, [{
    name: "indentColumns",
    value: { type: "number", value: 4 },
  }]);
  const contentRange = { from: 1 as Utf16Offset, to: 3 as Utf16Offset };
  const contentRangeAttribute = {
    name: "contentRange",
    value: { type: "range" as const, value: contentRange },
  };
  const nodes = [
    heading,
    paragraphWithImage,
    table,
    listItem,
    renderNode("fenced-code", { type: "deferred" }, [contentRangeAttribute]),
    renderNode("math-block", { type: "deferred" }, [contentRangeAttribute]),
  ];
  const result = new PreTextProjectionFilter().filter({
    revision: 2 as Revision,
    viewRevision: 3,
    items: nodes,
    layout: {
      availableWidth: 720,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "demo-v1",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: (requestedRange) => requestedRange === contentRange
        ? { preview: "content", utf16Length: 7, lineCount: 2 }
        : {
            preview: "representative component source",
            utf16Length: 31,
            lineCount: 4,
          },
      resolveImageMetadata: () => ({ aspectRatio: 16 / 9 }),
    },
  });
  equal(result.items.length, nodes.length);
  equal(result.items[0]?.evidence.strategy, "heading-1");
  equal(result.items[1]?.evidence.strategy, "paragraph-with-image");
  equal(result.items[1]?.contentText, "Image");
  equal(result.items[2]?.evidence.strategy, "table-grid-fixed");
  equal(result.items[2]?.evidence.rows, 5);
  equal(result.items[2]?.evidence.columns, 3);
  equal(result.items[3]?.evidence.strategy, "list-item-wrap");
  equal(result.items[4]?.evidence.strategy, "code-physical-lines");
  equal(result.items[4]?.evidence.rows, 2);
  equal(result.items[4]?.contentText, "content");
  equal(result.items[5]?.evidence.strategy, "math-lines");
  equal(result.items[5]?.evidence.rows, 2);
  equal(result.items.every((item) => item.estimatedHeight > 0), true);
  equal(
    result.items.every((item) =>
      item.estimatedHeight === item.boxHeight + item.blockGap &&
      item.blockGap === DEFAULT_PRETEXT_STYLE_METRICS.blockGap
    ),
    true,
  );
}

function pretext_code_wrap_estimates_long_lines_without_reading_full_source(): void {
  const node = renderNode("fenced-code", { type: "deferred" });
  const layout = {
    availableWidth: 160, lineHeight: 20, averageCharacterWidth: 8, tabSize: 4,
    widthBucketSize: 8, typographyVersion: "code-wrap-test", wrap: true,
  };
  const context = {
    metrics: DEFAULT_PRETEXT_STYLE_METRICS,
    sourceStats: () => ({ preview: "long line ".repeat(100), utf16Length: 50_000, lineCount: 1 }),
    sourceText: () => { throw new Error("code estimation must use a bounded sample"); },
  };
  const filter = new PreTextProjectionFilter();
  const base = { revision: 1 as Revision, viewRevision: 1, items: [node], layout };
  const scroll = filter.filter({ ...base, context: { ...context, codeBlockWrap: false } }).items[0]!;
  const wrap = filter.filter({ ...base, context: { ...context, codeBlockWrap: true } }).items[0]!;
  equal(scroll.evidence.visualLines, 1);
  equal(scroll.evidence.strategy, "code-physical-lines");
  equal(wrap.evidence.strategy, "code-wrapped-lines");
  assert(wrap.evidence.visualLines > 1 && wrap.estimatedHeight > scroll.estimatedHeight);
  assert(wrap.layoutKey !== scroll.layoutKey, "switching wrap mode invalidates the layout key");
}

function pretext_image_metadata_drives_aspect_ratio(): void {
  const image = renderNode("image", { type: "source" }, [{
    name: "destination",
    value: { type: "string", value: "/diagram.svg" },
  }]);
  const filter = new PreTextProjectionFilter();
  const input = {
    revision: 1 as Revision,
    viewRevision: 1,
    items: [image],
    layout: {
      availableWidth: 800,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "image-metadata-test",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({ preview: "![diagram](/diagram.svg)", utf16Length: 24, lineCount: 1 }),
      resolveImageMetadata: () => ({ width: 1600, height: 900 }),
    },
  };
  const result = filter.filter(input);
  equal(result.items[0]?.evidence.aspectRatio, 16 / 9);
  const extraHeight = DEFAULT_PRETEXT_STYLE_METRICS.blockGap + DEFAULT_PRETEXT_STYLE_METRICS.boundaryWidth;
  equal(result.items[0]?.estimatedHeight, 450 + extraHeight);

  const paragraph = renderNode("paragraph", { type: "structured", children: [image] });
  const small = filter.filter({
    ...input,
    items: [image, paragraph],
    context: { ...input.context, resolveImageMetadata: () => ({ width: 64, height: 64 }) },
  });
  equal(small.items[0]?.estimatedHeight, 64 + extraHeight);
  equal(small.items[1]?.estimatedHeight, 64 + extraHeight);
}

function pretext_table_wraps_inline_cell_content_without_block_assumptions(): void {
  const cellText = renderNode("text", { type: "source" });
  const cell = renderNode("table-cell", {
    type: "structured",
    children: [cellText],
  });
  const row = renderNode("table-row", {
    type: "structured",
    children: [cell],
  });
  const table = {
    ...renderNode("table", {
      type: "structured",
      children: [row],
    }, [{
      name: "alignments",
      value: { type: "strings" as const, value: ["left"] },
    }]),
    childCount: 1,
  };
  const result = new PreTextProjectionFilter().filter({
    revision: 2 as Revision,
    viewRevision: 3,
    items: [table],
    layout: {
      availableWidth: 220,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "table-inline-v1",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      tableLayout: {
        mode: "content",
        minColumnWidth: 56,
        maxColumnWidth: 240,
        estimatedColumnWidth: 96,
      },
      sourceStats: () => ({
        preview: "这是一个很长的 inline cell 文本，用于验证软换行只增加行高而不会假设存在 block 子节点。".repeat(4),
        utf16Length: 220,
        lineCount: 1,
      }),
    },
  });
  assert((result.items[0]?.evidence.visualLines ?? 0) > 1);
  equal(result.items[0]?.evidence.columns, 1);
}

function pretext_preserves_leading_whitespace_for_layout_and_preview(): void {
  const text = {
    ...renderNode("text", { type: "source" }),
    sourceRange: range(0, 7),
  };
  const paragraph = {
    ...renderNode("paragraph", { type: "structured", children: [text] }),
    sourceRange: range(0, 7),
  };
  const result = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [paragraph],
    layout: {
      availableWidth: 240,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "whitespace-test",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({ preview: "  lead", utf16Length: 6, lineCount: 1 }),
    },
  });
  equal(result.items[0]?.contentText, "  lead");
  equal(result.items[0]?.evidence.leadingWhitespaceColumns, 2);
}

function pretext_task_markers_reflect_their_checked_state(): void {
  const item = (checked: boolean): RenderNode => {
    const marker = renderNode("task-marker", { type: "source" }, [{
      name: "checked", value: { type: "boolean", value: checked },
    }]);
    const text = renderNode("text", { type: "source" });
    const paragraph = renderNode("paragraph", { type: "structured", children: [marker, text] });
    return renderNode("list-item", { type: "structured", children: [paragraph] });
  };
  const result = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [item(false), item(true)],
    layout: {
      availableWidth: 240, lineHeight: 24, averageCharacterWidth: 8, tabSize: 4,
      widthBucketSize: 32, typographyVersion: "task-test", wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({ preview: " task", utf16Length: 5, lineCount: 1 }),
    },
  });
  equal(result.items[0]?.contentText, "☐ task");
  equal(result.items[1]?.contentText, "☑ task");
}

function pretext_scales_bounded_semantic_preview_to_full_source(): void {
  const text = renderNode("text", { type: "source" });
  const paragraph = renderNode("paragraph", {
    type: "structured",
    children: [text],
  });
  const result = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [paragraph],
    layout: {
      availableWidth: 240,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "bounded-preview-test",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({
        preview: "x".repeat(2_048),
        utf16Length: 8_192,
        lineCount: 1,
      }),
    },
  });
  // 语义 preview 仍然有界，但虚拟轴必须使用完整源码长度外推，不能只按
  // 2,048 个预览字符建立总高度。
  assert((result.items[0]?.evidence.visualLines ?? 0) > 200);
}

function pretext_accounts_for_inline_math_without_creating_dom(): void {
  const contentRange = range(2, 5);
  const math = {
    ...renderNode("inline-math", { type: "source" }),
    sourceRange: range(2, 9),
    attributes: [{
      name: "contentRange",
      value: { type: "range" as const, value: contentRange },
    }],
  };
  const paragraph = {
    ...renderNode("paragraph", { type: "structured", children: [math] }),
    sourceRange: range(0, 9),
  };
  const result = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [paragraph],
    layout: {
      availableWidth: 240,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "math-test",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: (requestedRange) => requestedRange === contentRange
        ? { preview: "x_i", utf16Length: 3, lineCount: 1 }
        : { preview: "  $x_i$", utf16Length: 7, lineCount: 1 },
    },
  });
  equal(result.items[0]?.contentText, "x_i");
  equal(result.items[0]?.evidence.inlineMathCount, 1);
  equal(result.items[0]?.evidence.leadingWhitespaceColumns, 2);
}

function pretext_text_layout_caches_prepare_and_wraps_graphemes(): void {
  let measurements = 0;
  const layout = new PreTextTextLayout({
    measurer: {
      measure: (text) => {
        measurements += 1;
        return [...text].length * 10;
      },
    },
  });
  const style = { font: "16px sans-serif", whiteSpace: "pre-wrap" as const };
  const first = layout.layoutText("a🙂b\nc", style, 25, 20);
  const second = layout.layoutText("a🙂b\nc", style, 25, 20);
  equal(first.lineCount, 3);
  equal(first.height, 60);
  equal(second.lineCount, first.lineCount);
  equal(measurements, 4);
}

function pretext_uses_full_semantic_text_for_layout(): void {
  const paragraph = renderNode("paragraph", {
    type: "structured",
    children: [renderNode("text", { type: "source" })],
  });
  const layout = new PreTextTextLayout({
    measurer: { measure: (text) => [...text].length * 10 },
  });
  const result = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [paragraph],
    layout: {
      availableWidth: 40,
      lineHeight: 24,
      averageCharacterWidth: 8,
      tabSize: 4,
      widthBucketSize: 32,
      typographyVersion: "full-semantic-layout",
      wrap: true,
    },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({ preview: "x", utf16Length: 100, lineCount: 1 }),
      sourceText: () => "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      textLayout: layout,
      textStyle: { font: "16px sans-serif", whiteSpace: "pre-wrap" },
    },
  });
  equal(result.items[0]?.evidence.visualLines, 13);
  equal(result.items[0]?.evidence.textLayout, "prepared");
}

function pretext_nested_quote_respects_content_reserve_and_literals(): void {
  const quote = renderNode("block-quote", { type: "deferred" });
  const textLayout = new PreTextTextLayout({ measurer: { measure: (text) => [...text].length * 10 } });
  const measure = (source: string, lineCount: number, minimum: number) => new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [quote],
    layout: { availableWidth: 100, lineHeight: 22, averageCharacterWidth: 10, tabSize: 4,
      widthBucketSize: 32, typographyVersion: "quote-layout", wrap: true },
    context: {
      metrics: { ...DEFAULT_PRETEXT_STYLE_METRICS, quoteMinContentWidth: minimum },
      sourceStats: () => ({ preview: source, utf16Length: source.length, lineCount }),
      sourceText: () => source,
      textLayout,
      textStyle: { font: "16px sans-serif", whiteSpace: "pre-wrap" },
    },
  }).items[0]!;
  const source = ">>>> " + "x".repeat(30);
  const reserved = measure(source, 1, 64), unreserved = measure(source, 1, 0);
  equal(reserved.contentText, "x".repeat(30));
  equal(reserved.evidence.quoteDepth, 4);
  equal(reserved.evidence.visualLines, 5);
  equal(unreserved.evidence.visualLines, 8);
  assert(reserved.layoutKey !== unreserved.layoutKey, "changing the reserve invalidates cached estimates");
  const multiline = measure("> ``` ts\n> > literal\n> ```", 3, 64);
  assert(multiline.contentText.includes("> literal"), "literal markers in multiline code are not stripped");
}

function pretext_bounds_measurement_for_an_extremely_long_semantic_line(): void {
  const text = "x" + "中a😀".repeat(262_144);
  const layout = new PreTextTextLayout({ measurer: { measure: () => 10 } });
  const lengths: number[] = [];
  const prepare = layout.prepare.bind(layout);
  layout.prepare = (sample, style) => {
    lengths.push(sample.length);
    const last = sample.charCodeAt(sample.length - 1);
    assert(last < 0xd800 || last > 0xdbff, "sample must not split a surrogate pair");
    return prepare(sample, style);
  };
  const item = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [renderNode("paragraph", { type: "source" })],
    layout: { availableWidth: 400, lineHeight: 24, averageCharacterWidth: 8, tabSize: 4,
      widthBucketSize: 32, typographyVersion: "long-semantic-layout", wrap: true },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({ preview: text.slice(0, 2048), utf16Length: text.length, lineCount: 1 }),
      sourceText: () => text,
      textLayout: layout,
      textStyle: { font: "16px sans-serif", whiteSpace: "pre-wrap" },
    },
  }).items[0]!;
  assert(lengths.length > 0 && lengths.every((length) => length <= 8192), "measurement uses a bounded sample");
  assert(item.evidence.visualLines > 1_000, "the estimate scales to the complete line");
}

function pretext_scales_a_measured_preview_for_an_offscreen_long_line(): void {
  const item = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [renderNode("paragraph", { type: "source" })],
    layout: { availableWidth: 400, lineHeight: 24, averageCharacterWidth: 8, tabSize: 4,
      widthBucketSize: 32, typographyVersion: "long-offscreen-layout", wrap: true },
    context: {
      metrics: DEFAULT_PRETEXT_STYLE_METRICS,
      sourceStats: () => ({ preview: "x".repeat(2_048), utf16Length: 81_920, lineCount: 1 }),
      textLayout: new PreTextTextLayout({ measurer: { measure: () => 8 } }),
      textStyle: { font: "16px sans-serif", whiteSpace: "pre-wrap" },
    },
  }).items[0]!;
  assert(item.evidence.visualLines > 1_000, "measured preview must represent the full offscreen line");
}

function pretext_paragraph_inset_does_not_shrink_headings(): void {
  const paragraph = renderNode("paragraph", { type: "source" });
  const heading = renderNode("heading", { type: "source" }, [{
    name: "level", value: { type: "number", value: 1 },
  }]);
  const textLayout = new PreTextTextLayout({ measurer: { measure: () => 10 } });
  const result = new PreTextProjectionFilter().filter({
    revision: 1 as Revision,
    viewRevision: 1,
    items: [paragraph, heading],
    layout: {
      availableWidth: 100, lineHeight: 22, averageCharacterWidth: 10, tabSize: 4,
      widthBucketSize: 1, typographyVersion: "paragraph-inset", wrap: true,
    },
    context: {
      metrics: { ...DEFAULT_PRETEXT_STYLE_METRICS, paragraphPaddingX: 30 },
      sourceStats: () => ({ preview: "abcdefgh", utf16Length: 8, lineCount: 1 }),
      textLayout,
      textStyle: { font: "16px sans-serif", whiteSpace: "pre-wrap" },
    },
  });
  equal(result.items[0]?.evidence.visualLines, 2);
  equal(result.items[1]?.evidence.visualLines, 1);
}

function assert(condition: boolean, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

const tests: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
  ["pretext aligns semantic component estimators", pretext_filter_aligns_semantic_component_estimators],
  ["pretext estimates wrapped code from a bounded sample", pretext_code_wrap_estimates_long_lines_without_reading_full_source],
  ["pretext image metadata drives aspect ratio", pretext_image_metadata_drives_aspect_ratio],
  ["pretext wraps inline table cells", pretext_table_wraps_inline_cell_content_without_block_assumptions],
  ["pretext preserves leading whitespace", pretext_preserves_leading_whitespace_for_layout_and_preview],
  ["pretext task markers preserve checked state", pretext_task_markers_reflect_their_checked_state],
  ["pretext scales bounded previews", pretext_scales_bounded_semantic_preview_to_full_source],
  ["pretext estimates inline math without DOM", pretext_accounts_for_inline_math_without_creating_dom],
  ["pretext layout caches prepared graphemes", pretext_text_layout_caches_prepare_and_wraps_graphemes],
  ["pretext layout reads full semantic text", pretext_uses_full_semantic_text_for_layout],
  ["pretext quotes honor nested width and literal markers", pretext_nested_quote_respects_content_reserve_and_literals],
  ["pretext bounds measurement of extremely long lines", pretext_bounds_measurement_for_an_extremely_long_semantic_line],
  ["pretext scales measured previews for long offscreen lines", pretext_scales_a_measured_preview_for_an_offscreen_long_line],
  ["paragraph inset does not shrink heading width", pretext_paragraph_inset_does_not_shrink_headings],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
