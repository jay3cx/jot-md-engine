import { FoldedVirtualAxis, type HiddenBlockRange } from "../../src/core/virtual/folded-axis.js";
import { VirtualAxis } from "../../src/core/virtual/virtual-axis.js";

// Compare visible indices and pixel positions against an independent flat model.
const count = 257;
const base = new VirtualAxis(10);
base.resize(count);
const heights = Array.from({ length: count }, (_, i) => 10 + i % 13);
heights.forEach((height, i) => base.setSize(i, height));
const axis = new FoldedVirtualAxis(base, 10);
const active: HiddenBlockRange[] = [];
let seed = 37821;
function random(max: number): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
function check(condition: boolean, message: string): void { if (!condition) throw new Error(message); }

for (let step = 0; step < 2_000; step++) {
  if (active.length === 0 || random(2) === 0) {
    const a = random(count), b = random(count);
    active.push({ from: Math.min(a, b), toExclusive: Math.max(a, b) + 1 });
  } else active.splice(random(active.length), 1);
  axis.setHidden(active);
  const visible = Array.from({ length: count }, (_, i) => i)
    .filter(i => !active.some(range => range.from <= i && i < range.toExclusive));
  check(axis.count === visible.length, `count mismatch at ${step}`);
  let height = 0;
  for (let i = 0; i < visible.length; i++) {
    check(axis.physicalAt(i) === visible[i], `mapping mismatch at ${step}/${i}`);
    check(axis.offsetAt(i) === height, `offset mismatch at ${step}/${i}`);
    check(axis.indexAt(height) === i, `pixel lookup mismatch at ${step}/${i}`);
    height += heights[visible[i]!]!;
  }
  check(axis.totalSize === height, `height mismatch at ${step}`);
  check(axis.offsetAt(axis.count) === height, `end mismatch at ${step}`);
  const projected = axis.physicalRanges(0, axis.count).flatMap(range =>
    Array.from({ length: range.toExclusive - range.from }, (_, i) => range.from + i));
  check(JSON.stringify(projected) === JSON.stringify(visible), `ranges mismatch at ${step}`);
}

const lateBase = new VirtualAxis(12);
const lateAxis = new FoldedVirtualAxis(lateBase, 12);
lateAxis.setHidden([{ from: 2, toExclusive: 8 }]);
lateAxis.resize(10);
check(lateAxis.count === 4 && lateAxis.physicalAt(2) === 8, "ranges survive initial resize");
