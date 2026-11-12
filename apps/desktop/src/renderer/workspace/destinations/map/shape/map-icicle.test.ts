import { describe, expect, it } from "vitest";

import { buildIcicle, topicCellKey } from "./icicle-layout";
import { drawnTrail, mapBoxes, mapColumnShares } from "./map-icicle";
import { bigNodes, sample, sampleNodes, shapeId, shapeNode } from "./shape-fixtures";

const key = (n: number) => topicCellKey(shapeId(n));
const size = { widthPx: 640, heightPx: 480 };

describe("the Map chart's geometry", () => {
  const layout = buildIcicle(sampleNodes(), { wholeTree: true, sortBySize: true });
  const { boxes, reachable } = mapBoxes(layout, size);
  const find = (n: number) => boxes.find((box) => box.id === key(n))!;

  it("runs depth left to right in columns of 25, 37.5 and 37.5 per cent", () => {
    expect(mapColumnShares).toEqual([0.25, 0.375, 0.375]);
    expect(find(sample.memory).column).toBe(0);
    expect(find(sample.memory).x).toBe(0);
    expect(find(sample.memory).w).toBe(160);
    expect(find(sample.forgetting).column).toBe(1);
    expect(find(sample.forgetting).x).toBe(160);
    expect(find(sample.forgetting).w).toBe(240);
    expect(find(sample.decay).column).toBe(2);
    expect(find(sample.decay).x).toBe(400);
  });

  it("makes a block's height proportional to its notes, largest first", () => {
    const memory = find(sample.memory);
    expect(memory.h).toBeCloseTo((90 / 161) * 480, 6);
    expect(memory.y).toBe(0);
    // Siblings are sorted by size: Memory (90), Literature (58), then Open science (10).
    expect(find(sample.literature).y).toBeGreaterThan(memory.y);
    expect(find(sample.science).y).toBeGreaterThan(find(sample.literature).y);
  });

  it("does not draw the root", () => {
    expect(boxes.some((box) => box.id === key(sample.root))).toBe(false);
  });

  it("reaches only blocks drawn on their own", () => {
    expect(reachable.has(key(sample.memory))).toBe(true);
    expect(reachable.has(key(sample.root))).toBe(false);
  });
});

describe("the merging of small blocks", () => {
  // A root with one large topic and ten topics of one note each, in a 400 px tall chart.
  const nodes = [
    shapeNode(1, null, 0, null, 150, { directItems: 0, children: 11 }),
    shapeNode(2, 1, 1, "Large", 100),
    ...Array.from({ length: 10 }, (_, index) => shapeNode(10 + index, 1, 1, `Small ${index}`, 5))
  ];
  const layout = buildIcicle(nodes, { wholeTree: true, sortBySize: true });

  it("puts a run of blocks under 18 px into one dashed block that counts them", () => {
    const { boxes, reachable } = mapBoxes(layout, { widthPx: 640, heightPx: 400 });
    const merged = boxes.filter((box) => box.kind === "merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.members).toHaveLength(10);
    expect(merged[0]!.items).toBe(50);
    expect(merged[0]!.h).toBeGreaterThanOrEqual(16);
    // A block inside the run is in the table, not under an arrow key.
    expect(reachable.has(topicCellKey(shapeId(10)))).toBe(false);
    expect(reachable.has(key(2))).toBe(true);
  });

  it("keeps a single small block, with its own label", () => {
    const one = buildIcicle(
      [
        shapeNode(1, null, 0, null, 101, { directItems: 0, children: 2 }),
        shapeNode(2, 1, 1, "Large", 100),
        shapeNode(3, 1, 1, "Small", 1)
      ],
      { wholeTree: true, sortBySize: true }
    );
    const { boxes } = mapBoxes(one, { widthPx: 640, heightPx: 400 });
    expect(boxes.filter((box) => box.kind === "merged")).toHaveLength(0);
    expect(boxes.find((box) => box.id === topicCellKey(shapeId(3)))).toBeDefined();
  });

  it("merges nothing when every block is tall enough", () => {
    const { boxes } = mapBoxes(layout, { widthPx: 640, heightPx: 4000 });
    expect(boxes.some((box) => box.kind === "merged")).toBe(false);
  });
});

describe("levels under the third", () => {
  it("counts the topics only the table and a zoom show", () => {
    const chain = [
      shapeNode(1, null, 0, null, 10, { directItems: 0, children: 1 }),
      shapeNode(2, 1, 1, "A", 10, { directItems: 0, children: 1 }),
      shapeNode(3, 2, 2, "B", 10, { directItems: 0, children: 1 }),
      shapeNode(4, 3, 3, "C", 10, { directItems: 0, children: 1 }),
      shapeNode(5, 4, 4, "D", 10, { directItems: 0, children: 1 }),
      shapeNode(6, 5, 5, "E", 10)
    ];
    const layout = buildIcicle(chain, { wholeTree: false, sortBySize: true });
    const { boxes, deeper } = mapBoxes(layout, size);
    expect(boxes.map((box) => box.column).sort()).toEqual([0, 1, 2]);
    expect(deeper).toBe(2);
    expect(drawnTrail(layout, topicCellKey(shapeId(3)))).toEqual([
      topicCellKey(shapeId(2)),
      topicCellKey(shapeId(3))
    ]);
  });

  it("stays fast on a large tree", () => {
    const layout = buildIcicle(bigNodes(2000, 6), { wholeTree: true, sortBySize: true });
    const started = performance.now();
    mapBoxes(layout, size);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
