import {
  resolveTableColumnWidths,
  tableLayoutEvidenceFromNode,
  tableLayoutContextKey,
  TableLayoutController,
  softWrapPreferredSample,
} from "../../src/components/table/layout.js";
import { tableLayoutEvidenceKey } from "../../src/components/table/preview-utils.js";
import { renderNode } from "./fixtures/render-node.js";

function table_layout_preserves_user_widths_across_context_resets(): void {
  const layout = new TableLayoutController("table-1", {
    mode: "adaptive",
    minColumnWidth: 80,
    maxColumnWidth: 400,
    estimatedColumnWidth: 120,
  });
  layout.configure(3, "left\u0000left\u0000left", "ltr:720");
  layout.measure(0, 260, 240);
  layout.setUserWidth(1, 310);
  layout.configure(3, "left\u0000left\u0000left", "ltr:480");
  equal(layout.sizeAt(1), 310);
  equal(layout.isPinned(1), true);
  // 容器变化只失效自动测量，不先把列重置为估算值；下一帧测量前保留当前几何。
  equal(layout.sizeAt(0), 260);
  layout.clearUserWidth(1);
  equal(layout.isPinned(1), false);
  equal(layout.snapshot().columnCount, 3);
}

function table_layout_exposes_restore_and_persistence_hooks(): void {
  const snapshots: number[] = [];
  const layout = new TableLayoutController("table-persist", {
    mode: "content",
    resolveColumnWidths: (tableId, columnCount) => {
      equal(tableId, "table-persist");
      equal(columnCount, 2);
      return [210, "auto"];
    },
    onLayoutChange: (snapshot) => snapshots.push(snapshot.totalWidth),
  });
  layout.configure(2, "left\u0000left", "ltr:720");
  equal(layout.sizeAt(0), 210);
  layout.setUserWidth(1, 260);
  equal(layout.snapshot().totalWidth, 470);
  assert(snapshots.includes(470), "layout persistence callback must receive the snapshot");
}

function table_layout_content_mode_is_intrinsic_and_stable_after_sealing(): void {
  const layout = new TableLayoutController("table-content", {
    mode: "content",
    autoWidth: "stable",
    minColumnWidth: 80,
    maxColumnWidth: 400,
    estimatedColumnWidth: 120,
  });
  layout.configure(2, "left\u0000left", "ltr:720");
  layout.measure(0, 180, 360);
  layout.measure(1, 240, 360);
  layout.sealAutoWidths();
  equal(layout.sizeAt(0), 180);
  equal(layout.sizeAt(1), 240);
  equal(layout.measure(0, 390, 360), false);
  equal(layout.sizeAt(0), 180);
  layout.configure(2, "left\u0000left", "ltr:480");
  equal(layout.measure(0, 260, 240), true);
}

function table_layout_live_mode_can_follow_later_virtual_rows(): void {
  const layout = new TableLayoutController("table-live", {
    mode: "content",
    autoWidth: "live",
    minColumnWidth: 80,
    maxColumnWidth: 400,
    estimatedColumnWidth: 120,
  });
  layout.configure(1, "left", "ltr:720");
  layout.measure(0, 140, 360);
  layout.sealAutoWidths();
  equal(layout.measure(0, 280, 360), true);
  equal(layout.sizeAt(0), 280);
  equal(layout.reconcile([96], 720), true);
  equal(layout.sizeAt(0), 96);
}

function table_layout_reconciles_soft_wrap_candidates_proportionally(): void {
  const layout = new TableLayoutController("table-soft-wrap", {
    mode: "adaptive",
    autoWidth: "stable",
    minColumnWidth: 56,
    maxColumnWidth: 560,
    estimatedColumnWidth: 96,
  });
  layout.configure(2, "left\u0000left", "ltr:720");
  equal(layout.reconcile([64, 192], 512), true);
  equal(Math.round(layout.sizeAt(0)), 128);
  equal(Math.round(layout.sizeAt(1)), 384);
  layout.sealAutoWidths();
  equal(layout.reconcile([320, 320], 512), false);
}

function table_layout_soft_wrap_does_not_turn_full_text_into_width(): void {
  const sample = softWrapPreferredSample("x".repeat(20_000));
  assert(sample.length <= 28);
  const widths = resolveTableColumnWidths(
    [sample.length * 8, 80],
    600,
    { mode: "content", minColumnWidth: 56, maxColumnWidth: 320 },
  );
  equal(widths[0], 224);
  equal(widths[1], 80);
}

function table_layout_reopens_on_edit_and_can_shrink_existing_columns(): void {
  const layout = new TableLayoutController("table-edit", {
    mode: "content",
    autoWidth: "stable",
    minColumnWidth: 56,
    maxColumnWidth: 320,
    estimatedColumnWidth: 96,
  });
  layout.configure(1, "left", "ltr:720");
  equal(layout.reconcile([120], 720), true);
  layout.sealAutoWidths();
  layout.invalidateAutoWidths();
  equal(layout.reconcile([220], 720), true);
  equal(layout.sizeAt(0), 220);
  layout.invalidateAutoWidths();
  equal(layout.reconcile([64], 720), true);
  equal(layout.sizeAt(0), 64);
}

function table_layout_adaptive_reclaims_space_before_overflowing(): void {
  const layout = new TableLayoutController("table-compress", {
    mode: "adaptive",
    autoWidth: "live",
    minColumnWidth: 80,
    maxColumnWidth: 560,
  });
  layout.configure(3, "left\u0000left\u0000left", "ltr:600");
  equal(layout.reconcile([320, 220, 180], 600), true);
  equal(Math.round(layout.sizeAt(0)), 260);
  equal(Math.round(layout.sizeAt(1)), 185);
  equal(Math.round(layout.sizeAt(2)), 155);
  equal(Math.round(layout.totalSize), 600);
}

function table_layout_content_mode_keeps_overflow_as_scrollable_width(): void {
  const layout = new TableLayoutController("table-overflow", {
    mode: "content",
    autoWidth: "live",
    minColumnWidth: 80,
    maxColumnWidth: 560,
  });
  layout.configure(2, "left\u0000left", "ltr:600");
  equal(layout.reconcile([420, 360], 600), true);
  equal(Math.round(layout.totalSize), 780);
}

function table_layout_defaults_to_content_without_filling_the_viewport(): void {
  const layout = new TableLayoutController("table-default");
  layout.configure(2, "left\u0000left", "ltr:1200");
  equal(layout.mode, "content");
  equal(layout.reconcile([96, 144], 1200), true);
  equal(Math.round(layout.totalSize), 240);
}

function table_layout_content_resize_does_not_reopen_or_grow_short_columns(): void {
  const layout = new TableLayoutController("table-content-resize", {
    mode: "content",
    autoWidth: "stable",
    minColumnWidth: 56,
    maxColumnWidth: 480,
    estimatedColumnWidth: 180,
  });
  const schema = "right\u0000center\u0000left";
  const initialContext = tableLayoutContextKey("content", "ltr", 1_200);
  layout.configure(3, schema, initialContext);
  equal(layout.reconcile([56, 72, 180], 1_200), true);
  layout.sealAutoWidths();
  equal(layout.needsAutoWidthMeasurement, false);

  for (const width of [1_000, 800, 640, 480]) {
    equal(tableLayoutContextKey("content", "ltr", width), initialContext);
    layout.configure(3, schema, tableLayoutContextKey("content", "ltr", width));
    equal(layout.reconcile([60, 72, 180], width), false);
    equal(layout.sizeAt(0), 56);
    equal(layout.needsAutoWidthMeasurement, false);
  }
}

function table_layout_adaptive_resize_uses_container_width_context(): void {
  const wide = tableLayoutContextKey("adaptive", "ltr", 1_200);
  const narrow = tableLayoutContextKey("adaptive", "ltr", 640);
  equal(wide === narrow, false);
  equal(tableLayoutContextKey("adaptive", "rtl", 640), "adaptive:rtl:640");
}

function table_layout_content_minimum_is_a_floor_not_remaining_space(): void {
  const widths = resolveTableColumnWidths(
    [12, 24, 36],
    1_200,
    { mode: "content", minColumnWidth: 72, maxColumnWidth: 480 },
  );
  equal(widths.length, 3);
  equal(widths[0], 72);
  equal(widths[1], 72);
  equal(widths[2], 72);
  equal(widths.reduce((sum, width) => sum + width, 0), 216);
}

function table_layout_content_fill_prioritizes_wrap_pressure_columns(): void {
  const evidence = {
    rowCount: 6,
    totalDisplayColumns: [18, 24, 42, 30, 96],
    maxDisplayColumns: [4, 4, 8, 6, 28],
    maxUnbreakableColumns: [4, 4, 8, 6, 28],
    nonEmptyCells: [6, 6, 6, 6, 6],
    demandWeights: [1, 2, 4, 3, 48],
  };
  const widths = resolveTableColumnWidths(
    [72, 72, 112, 72, 208],
    1_200,
    { mode: "content", fillRatio: 0.8, minColumnWidth: 72, maxColumnWidth: 720 },
    [],
    evidence,
  );
  equal(Math.round(widths.reduce((sum, width) => sum + width, 0)), 960);
  assert((widths[4] ?? 0) > (widths[0] ?? 0) * 4, "long text column should receive the main slack");
  assert((widths[4] ?? 0) > (widths[1] ?? 0) * 3, "compact level column should not absorb the slack");
}

function table_layout_content_fill_rebalances_after_returning_under_container(): void {
  const layout = new TableLayoutController("table-fill-transition", {
    mode: "content",
    autoWidth: "stable",
    fillRatio: 0.8,
    minColumnWidth: 72,
    maxColumnWidth: 720,
  });
  const context = tableLayoutContextKey("content", "ltr", 1_000, 0.8);
  layout.configure(3, "left\u0000left\u0000left", context);

  // 初始内容超过容器：content 模式保留横向滚动宽度。
  equal(layout.reconcile([500, 400, 300], 1_000, {
    rowCount: 10,
    demandWeights: [0, 0, 0],
  }), true);
  equal(Math.round(layout.totalSize), 1_200);
  layout.sealAutoWidths();

  // 编辑后所有列都变短，目标应回到容器的 80%，而不是停留在旧的溢出宽度
  // 或因为没有需求权重而保持最小列宽。
  layout.invalidateAutoWidths();
  equal(layout.reconcile([100, 100, 100], 1_000, {
    rowCount: 10,
    demandWeights: [0, 0, 0],
  }), true);
  equal(Math.round(layout.totalSize), 800);
  assert(layout.sizeAt(0) > 100, "short columns should receive the fallback fill width");
}

function table_layout_uses_full_table_maximum_as_intrinsic_floor(): void {
  const widths = resolveTableColumnWidths(
    [72, 72],
    600,
    { mode: "content", minColumnWidth: 72, maxColumnWidth: 720, estimatedColumnWidth: 180 },
    [],
    {
      rowCount: 2_000,
      maxDisplayColumns: [4, 28],
      maxUnbreakableColumns: [4, 28],
    },
  );
  equal(widths[0], 72);
  equal(widths[1], 252);
}

function table_layout_content_fill_keeps_user_columns_pinned(): void {
  const layout = new TableLayoutController("table-fill-pinned", {
    mode: "content",
    fillRatio: 0.8,
    minColumnWidth: 72,
    maxColumnWidth: 800,
  });
  layout.configure(3, "right\u0000left\u0000left", tableLayoutContextKey("content", "ltr", 1_200, 0.8));
  layout.setUserWidth(0, 96);
  equal(layout.reconcile(
    [96, 80, 200],
    1_200,
    {
      rowCount: 5,
      totalDisplayColumns: [12, 16, 100],
      maxDisplayColumns: [3, 4, 28],
      maxUnbreakableColumns: [3, 4, 28],
      nonEmptyCells: [5, 5, 5],
      demandWeights: [1, 2, 48],
    },
  ), true);
  equal(layout.sizeAt(0), 96);
  assert(layout.sizeAt(2) > layout.sizeAt(1), "unpinned wrap-pressure column should grow");
  assert(layout.totalSize >= 960, "filled table should reach its target width");
}

function table_layout_content_fill_context_tracks_container_width(): void {
  equal(
    tableLayoutContextKey("content", "ltr", 1_200, 0.8),
    "content:ltr:1200:0.8",
  );
  equal(
    tableLayoutContextKey("content", "ltr", 640, 0.8),
    "content:ltr:640:0.8",
  );
  equal(
    tableLayoutContextKey("content", "ltr", 640),
    "content:ltr",
  );
}

function table_layout_reads_rust_column_evidence(): void {
  const node = renderNode("table", { type: "deferred" }, [
    { name: "layoutRowCount", value: { type: "number", value: 10 } },
    { name: "layoutTotalDisplayColumns", value: { type: "numbers", value: [20, 80] } },
    { name: "layoutMaxDisplayColumns", value: { type: "numbers", value: [4, 28] } },
    { name: "layoutDemandWeights", value: { type: "numbers", value: [0, 48] } },
  ]);
  const evidence = tableLayoutEvidenceFromNode(node);
  equal(evidence?.rowCount, 10);
  equal(evidence?.maxDisplayColumns?.[1], 28);
  equal(evidence?.totalDisplayColumns?.[0], 20);
  equal(evidence?.demandWeights?.[1], 48);
}

function table_layout_evidence_version_tracks_measurement_inputs(): void {
  const before = {
    rowCount: 12,
    totalDisplayColumns: [24, 80],
    maxDisplayColumns: [4, 28],
    maxUnbreakableColumns: [4, 28],
    nonEmptyCells: [12, 12],
    demandWeights: [2, 48],
  };
  const oneCellChanged = {
    rowCount: 12,
    totalDisplayColumns: [24, 96],
    maxDisplayColumns: [4, 28],
    maxUnbreakableColumns: [4, 28],
    nonEmptyCells: [12, 12],
    demandWeights: [2, 64],
  };
  const columnInserted = {
    rowCount: 12,
    totalDisplayColumns: [24, 96, 12],
    maxDisplayColumns: [4, 28, 4],
    maxUnbreakableColumns: [4, 28, 4],
    nonEmptyCells: [12, 12, 12],
    demandWeights: [2, 64, 0],
  };
  equal(tableLayoutEvidenceKey(before) === tableLayoutEvidenceKey(oneCellChanged), false);
  equal(tableLayoutEvidenceKey(oneCellChanged) === tableLayoutEvidenceKey(columnInserted), false);
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
  ["table layout preserves user widths across context resets", table_layout_preserves_user_widths_across_context_resets],
  ["table layout exposes restore and persistence hooks", table_layout_exposes_restore_and_persistence_hooks],
  ["content table widths are intrinsic and stable", table_layout_content_mode_is_intrinsic_and_stable_after_sealing],
  ["live table widths follow later virtual rows", table_layout_live_mode_can_follow_later_virtual_rows],
  ["table layout reconciles soft-wrap candidates proportionally", table_layout_reconciles_soft_wrap_candidates_proportionally],
  ["soft-wrap candidates cap full-text width", table_layout_soft_wrap_does_not_turn_full_text_into_width],
  ["table edits reopen and can shrink widths", table_layout_reopens_on_edit_and_can_shrink_existing_columns],
  ["adaptive tables reclaim space before overflow", table_layout_adaptive_reclaims_space_before_overflowing],
  ["content tables keep intrinsic overflow width", table_layout_content_mode_keeps_overflow_as_scrollable_width],
  ["table layout defaults to compact content width", table_layout_defaults_to_content_without_filling_the_viewport],
  ["content table resize keeps short columns compact", table_layout_content_resize_does_not_reopen_or_grow_short_columns],
  ["adaptive table resize tracks container width", table_layout_adaptive_resize_uses_container_width_context],
  ["content table minimum is a floor without slack distribution", table_layout_content_minimum_is_a_floor_not_remaining_space],
  ["content table fill prioritizes wrap pressure columns", table_layout_content_fill_prioritizes_wrap_pressure_columns],
  ["content fill rebalances after returning under container", table_layout_content_fill_rebalances_after_returning_under_container],
  ["table layout uses full-table maximum as intrinsic floor", table_layout_uses_full_table_maximum_as_intrinsic_floor],
  ["content table fill keeps user columns pinned", table_layout_content_fill_keeps_user_columns_pinned],
  ["content table fill context tracks container width", table_layout_content_fill_context_tracks_container_width],
  ["table layout reads Rust column evidence", table_layout_reads_rust_column_evidence],
  ["table evidence tracks cell and schema measurement inputs", table_layout_evidence_version_tracks_measurement_inputs],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
