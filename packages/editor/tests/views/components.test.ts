import type {
  RenderAttribute,
  RenderContent,
  RenderNode,
  RenderValue,
  TextRange,
} from "../../../editor-protocol/src/index.js";
import {
  componentInteractionSurfaces,
  componentProjectionDepth,
  defaultMarkdownComponentRegistry,
  estimateTablePreText,
  hasComponentCapability,
} from "../../src/components/index.js";

function table_component_is_registered_once_for_all_table_node_kinds(): void {
  const table = node("table", 0, 42, { type: "deferred" }, [
    strings("alignments", ["left", "right"]),
    number("layoutRowCount", 2),
    numbers("layoutDemandWeights", [1, 8]),
  ], 2);
  const definition = defaultMarkdownComponentRegistry.resolve(table);
  equal(definition?.id, "markdown-table");
  if (definition === undefined) throw new Error("table component must be registered");
  const model = definition.createModel(table);
  equal(model?.kind, "table");
  equal(model?.contentVersion, 1);
  equal(hasComponentCapability(definition, "preview"), true);
  equal(hasComponentCapability(definition, "pretext"), true);
  equal(hasComponentCapability(definition, "live-preview"), true);
  equal(hasComponentCapability(definition, "projection"), true);
  equal(hasComponentCapability(definition, "interaction"), true);

  const row = node("table-row", 0, 20, { type: "deferred" }, [], 2);
  equal(defaultMarkdownComponentRegistry.modelFor(row)?.kind, "table-row");
  const cell = node("table-cell", 0, 8, { type: "source" });
  equal(defaultMarkdownComponentRegistry.modelFor(cell)?.kind, "table-cell");
  equal(componentProjectionDepth(table, "preview"), 0);
  equal(componentProjectionDepth(table, "pretext"), 4);
  equal(componentProjectionDepth(table, "live-preview"), 0);
}

function table_pretext_uses_the_same_rust_evidence_and_bounded_samples(): void {
  const source = [
    "| ID | 说明 |",
    "| --- | --- |",
    "| 1 | 一段需要更多宽度的较长说明文本 |",
  ].join("\n");
  const header = tableRow(source, 0, source.indexOf("\n"));
  const bodyStart = source.lastIndexOf("\n") + 1;
  const body = tableRow(source, bodyStart, source.length);
  const table = node("table", 0, source.length, structured(header, body), [
    strings("alignments", ["left", "left"]),
    number("layoutRowCount", 2),
    numbers("layoutDemandWeights", [1, 24]),
    numbers("layoutMaxDisplayColumns", [2, 18]),
  ], 2);
  const estimate = estimateTablePreText(table, {
    sourceStats: { preview: source },
    sampleRows: 8,
    availableWidth: 280,
    averageCharacterWidth: 8,
    tabSize: 4,
    tableLayout: { mode: "content", fillRatio: 0.8, minColumnWidth: 56 },
    semanticText: (item) => source.slice(Number(item.sourceRange.from), Number(item.sourceRange.to)),
    metrics: {
      paragraphLineHeight: 27,
      tableHeaderHeight: 42,
      tableRowHeight: 38,
      tableFrame: 2,
    },
  });
  equal(estimate.strategy, "table-grid-sampled");
  equal(estimate.columns, 2);
  equal(estimate.rows, 2);
  equal(estimate.sampledRows, 2);
  equal(estimate.height >= 82, true);
  equal(estimate.visualLines >= 1, true);
}

function table_interaction_ranges_come_from_the_registered_adapter(): void {
  const source = "| head | value |\n| --- | --- |\n| A | one |";
  const headerEnd = source.indexOf("\n");
  const bodyStart = source.indexOf("\n", headerEnd + 1) + 1;
  const table = node("table", 0, source.length, structured(
    tableRow(source, 0, headerEnd),
    tableRow(source, bodyStart, source.length),
  ), [strings("alignments", ["none", "none"])], 2);
  const surfaces = componentInteractionSurfaces([table], { source });
  equal(surfaces.length, 1);
  const surface = surfaces[0];
  if (surface === undefined) throw new Error("expected table interaction surface");
  equal(surface.componentId, "markdown-table");
  equal(surface.editableRanges.length, 4);
  equal(surface.protectedRanges.length > 0, true);
  equal(surface.commandRanges.length, 1);
  equal(
    surface.allowsEdit?.(
      { from: source.indexOf("A"), to: source.indexOf("A"), insert: "|" },
      {
        editableRanges: surface.editableRanges,
        protectedRanges: surface.protectedRanges,
        commandRanges: surface.commandRanges,
      },
    ),
    false,
  );
}

function closed_container_interaction_exposes_content_but_protects_delimiters(): void {
  const source = "$$\nx\n$$\nafter";
  const math = node("math-block", 0, 7, { type: "deferred" }, [
    bool("closed", true),
    rangeValue("openingRange", 0, 2),
    rangeValue("contentRange", 3, 4),
    rangeValue("closingRange", 5, 7),
  ]);
  const definition = defaultMarkdownComponentRegistry.resolve(math);
  equal(definition?.id, "markdown-closed-container");
  const surface = componentInteractionSurfaces([math], { source })[0];
  if (surface === undefined) throw new Error("expected closed-container interaction surface");
  equal(Number(surface.editableRanges[0]?.from), 0);
  equal(Number(surface.editableRanges[0]?.to), 2);
  equal(Number(surface.editableRanges[1]?.from), 3);
  equal(Number(surface.editableRanges[1]?.to), 4);
  equal(surface.protectedRanges.length, 2);
  equal(Number(surface.protectedRanges[0]?.from), 2);
  equal(Number(surface.protectedRanges[0]?.to), 3);
  equal(Number(surface.navigationRanges?.[0]?.from), 0);
  equal(Number(surface.navigationRanges?.[1]?.from), 3);
  const deletion = surface.resolveDeletion?.(
    { position: 8, direction: "backward" },
    {
      editableRanges: surface.editableRanges,
      protectedRanges: surface.protectedRanges,
      commandRanges: surface.commandRanges,
    },
  );
  equal(deletion?.kind, "delete-range");
  if (deletion?.kind === "delete-range") equal(deletion.to, 8);
}

function tableRow(source: string, from: number, to: number): RenderNode {
  const cells = splitCells(source, from, to).map(({ from: cellFrom, to: cellTo }) =>
    node("table-cell", cellFrom, cellTo, { type: "source" }));
  return node("table-row", from, to, structured(...cells), [], cells.length);
}

function splitCells(source: string, from: number, to: number): readonly { readonly from: number; readonly to: number }[] {
  const line = source.slice(from, to);
  const boundaries = [...line.matchAll(/\|/gu)].map((match) => from + (match.index ?? 0));
  const cells: Array<{ readonly from: number; readonly to: number }> = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]! + 1;
    const end = boundaries[index + 1]!;
    cells.push({ from: start, to: end });
  }
  return cells;
}

function node(
  kind: string,
  from: number,
  to: number,
  content: RenderContent,
  attributes: readonly RenderAttribute[] = [],
  childCount = content.type === "structured" ? content.children.length : 0,
): RenderNode {
  return {
    id: `${kind}:${from}:${to}`,
    kind,
    sourceRange: textRange(from, to),
    contentVersion: 1,
    mode: "preview",
    childCount,
    attributes,
    content,
  };
}

function structured(...children: readonly RenderNode[]): RenderContent {
  return { type: "structured", children };
}

function number(name: string, value: number): RenderAttribute {
  return attribute(name, { type: "number", value });
}

function numbers(name: string, value: readonly number[]): RenderAttribute {
  return attribute(name, { type: "numbers", value });
}

function strings(name: string, value: readonly string[]): RenderAttribute {
  return attribute(name, { type: "strings", value });
}

function bool(name: string, value: boolean): RenderAttribute {
  return attribute(name, { type: "boolean", value });
}

function rangeValue(name: string, from: number, to: number): RenderAttribute {
  return attribute(name, { type: "range", value: textRange(from, to) });
}

function attribute(name: string, value: RenderValue): RenderAttribute {
  return { name, value };
}

function textRange(from: number, to: number): TextRange {
  return { from: from as TextRange["from"], to: to as TextRange["to"] };
}

function equal<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

table_component_is_registered_once_for_all_table_node_kinds();
table_pretext_uses_the_same_rust_evidence_and_bounded_samples();
table_interaction_ranges_come_from_the_registered_adapter();
closed_container_interaction_exposes_content_but_protects_delimiters();
