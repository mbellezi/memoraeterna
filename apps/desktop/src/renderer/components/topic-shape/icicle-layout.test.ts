import { describe, expect, it } from "vitest";

import { topicReadLimits } from "@app/domain";

import {
  buildIcicle,
  cellContent,
  cellSpan,
  cellTrail,
  drawnCells,
  emptyIcicle,
  fillShares,
  minDrawnWidth,
  moveFocus,
  stepZoom,
  topicCellKey,
  unsortedCellKey,
  zoomSteps,
  type IcicleCell,
  type IcicleLayout
} from "./icicle-layout";
import { bigNodes, sample, sampleNodes, shapeId, shapeNode } from "./shape-fixtures";

const key = (n: number) => topicCellKey(shapeId(n));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Every cell's children (of any kind) start where the cell starts and end where it ends. */
function expectTiling(layout: IcicleLayout): void {
  const below = new Map<string, IcicleCell[]>();
  for (const cell of layout.cells) {
    if (cell.parentKey === null) continue;
    below.set(cell.parentKey, [...(below.get(cell.parentKey) ?? []), cell]);
  }
  for (const [parentKey, cells] of below) {
    const parent = layout.byKey.get(parentKey)!;
    const sorted = [...cells].sort((a, b) => a.x0 - b.x0);
    expect(near(sorted[0]!.x0, parent.x0), parentKey).toBe(true);
    expect(near(sorted.at(-1)!.x1, parent.x1), parentKey).toBe(true);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(near(sorted[i]!.x0, sorted[i - 1]!.x1), parentKey).toBe(true);
    }
    expect(
      near(
        cells.reduce((sum, cell) => sum + cellSpan(cell), 0),
        cellSpan(parent)
      ),
      parentKey
    ).toBe(true);
  }
}

describe("the icicle of the sample tree", () => {
  const layout = buildIcicle(sampleNodes());

  it("spans the whole width at the root and one row per level", () => {
    const root = layout.byKey.get(key(sample.root))!;
    expect(root.row).toBe(0);
    expect(near(root.x0, 0) && near(root.x1, 1)).toBe(true);
    expect(layout.rows).toBe(4);
    expect(layout.total).toBe(161);
    expect(layout.rootKey).toBe(key(sample.root));
    for (const cell of layout.cells) {
      const depth = cell.node?.depth;
      if (depth !== undefined) expect(cell.row).toBe(depth);
    }
  });

  it("gives every parent exactly the width of its children, the direct items included", () => {
    expectTiling(layout);
  });

  it("makes widths proportional to items", () => {
    for (const cell of layout.cells) {
      expect(near(cellSpan(cell), cell.value / 161), cell.key).toBe(true);
    }
    expect(layout.byKey.get(key(sample.memory))!.value).toBe(90);
    expect(layout.byKey.get(key(sample.forgetting))!.value).toBe(26);
  });

  it("puts the items of the root that wait for a place in an Unsorted block of level 1", () => {
    const unsorted = layout.byKey.get(unsortedCellKey)!;
    expect(unsorted.kind).toBe("unsorted");
    expect(unsorted.row).toBe(1);
    expect(unsorted.value).toBe(3);
    expect(unsorted.parentKey).toBe(key(sample.root));
    expect(layout.byKey.get(key(sample.root))!.childKeys.at(-1)).toBe(unsortedCellKey);
  });

  it("shows the items placed directly in an internal topic as a block that is not a topic", () => {
    const direct = layout.byKey.get(`direct:${shapeId(sample.forgetting)}`)!;
    expect(direct.kind).toBe("direct");
    expect(direct.value).toBe(6);
    expect(direct.row).toBe(3);
    expect(layout.byKey.get(key(sample.forgetting))!.childKeys).toEqual([
      key(sample.decay),
      key(sample.replications)
    ]);
    // A leaf has no such block, and neither does an Area without direct items.
    expect([...layout.byKey.keys()].filter((k) => k.startsWith("direct:"))).toHaveLength(1);
  });

  it("lists the selectable blocks in table order: each topic before its subtopics, Unsorted last at its level", () => {
    expect(layout.order[0]).toBe(key(sample.root));
    expect(layout.order).toHaveLength(19);
    expect(layout.order.indexOf(key(sample.memory))).toBeLessThan(
      layout.order.indexOf(key(sample.forgetting))
    );
    expect(layout.order.indexOf(key(sample.forgetting))).toBeLessThan(
      layout.order.indexOf(key(sample.decay))
    );
    expect(layout.order.at(-1)).toBe(unsortedCellKey);
    expect(new Set(layout.order).size).toBe(layout.order.length);
  });

  it("lists the blocks of each level from the left", () => {
    expect(layout.rowKeys[1]).toEqual([
      key(sample.memory),
      key(sample.literature),
      key(sample.science),
      unsortedCellKey
    ]);
    for (const keys of layout.rowKeys) {
      const xs = keys.map((k) => layout.byKey.get(k)!.x0);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
  });
});

describe("the icicle of a branch", () => {
  it("calls the items placed directly in the root of the branch direct, not unsorted", () => {
    const branch = [
      shapeNode(sample.forgetting, null, 0, "Forgetting curve", 26, {
        directItems: 6,
        children: 2
      }),
      shapeNode(sample.decay, sample.forgetting, 1, "Decay models", 11),
      shapeNode(sample.replications, sample.forgetting, 1, "Replications", 9)
    ];
    const layout = buildIcicle(branch, { wholeTree: false });
    expect(layout.byKey.has(unsortedCellKey)).toBe(false);
    expect(layout.byKey.get(`direct:${shapeId(sample.forgetting)}`)!.kind).toBe("direct");
    expectTiling(layout);
  });
});

describe("edge cases", () => {
  it("returns the empty layout without nodes, without a root or without items", () => {
    expect(buildIcicle([])).toBe(emptyIcicle);
    expect(buildIcicle([shapeNode(2, 1, 1, "Orphan", 5)])).toBe(emptyIcicle);
    expect(buildIcicle([shapeNode(1, null, 0, null, 0, { directItems: 0 })])).toBe(emptyIcicle);
  });

  it("shows a root that holds only unsorted items as one Unsorted block", () => {
    const layout = buildIcicle([shapeNode(1, null, 0, null, 7, { directItems: 7 })]);
    expect(layout.cells.map((cell) => cell.kind)).toEqual(["topic", "unsorted"]);
    expectTiling(layout);
  });

  it("marks a topic whose subtopics the read left out", () => {
    const layout = buildIcicle([
      shapeNode(1, null, 0, null, 10, { directItems: 0, children: 1 }),
      shapeNode(2, 1, 1, "Cut", 10, { directItems: 10, children: 3 })
    ]);
    expect(layout.byKey.get(key(2))!.cut).toBe(true);
    expect(layout.byKey.get(key(1))!.cut).toBe(false);
  });

  it("keeps the width of items the read did not list, never drawing it", () => {
    // The parent holds 20 items, but only a child of 8 was listed (a node limit cut the others).
    const layout = buildIcicle([
      shapeNode(1, null, 0, null, 20, { directItems: 0, children: 3 }),
      shapeNode(2, 1, 1, "Listed", 8)
    ]);
    const rest = layout.byKey.get(`rest:${shapeId(1)}`)!;
    expect(rest.kind).toBe("rest");
    expect(rest.value).toBe(12);
    expect(near(cellSpan(layout.byKey.get(key(2))!), 0.4)).toBe(true);
    expectTiling(layout);
    expect(layout.order).not.toContain(rest.key);
    expect(drawnCells(layout, 1000).drawn.map((cell) => cell.kind)).not.toContain("rest");
  });

  it("builds a cycle or a duplicate once", () => {
    const layout = buildIcicle([
      shapeNode(1, null, 0, null, 4, { directItems: 0, children: 1 }),
      shapeNode(2, 1, 1, "A", 4),
      shapeNode(2, 1, 1, "A again", 4)
    ]);
    expect(layout.order).toEqual([key(1), key(2)]);
  });
});

describe("what is drawn", () => {
  const layout = buildIcicle(sampleNodes());

  it("drops blocks narrower than a few pixels and counts them, selectable ones only", () => {
    const wide = drawnCells(layout, 960);
    expect(wide.hidden).toBe(0);
    const narrow = drawnCells(layout, 100);
    // 6 / 161 of 100 px is under the minimum, 11 / 161 is not.
    expect(cellSpan(layout.byKey.get(key(sample.testing))!) * 100).toBeLessThan(minDrawnWidth + 4);
    expect(narrow.hidden).toBeGreaterThan(0);
    for (const cell of narrow.drawn)
      expect(cellSpan(cell) * 100).toBeGreaterThanOrEqual(minDrawnWidth);
    expect(narrow.reachable.size).toBe(layout.order.length - narrow.hidden);
  });

  it("says how much a block can show by its width", () => {
    expect(cellContent(300)).toBe("full");
    expect(cellContent(60)).toBe("count");
    expect(cellContent(10)).toBe("none");
  });
});

describe("keyboard moves", () => {
  const layout = buildIcicle(sampleNodes());
  const all = new Set(layout.order);

  it("moves along a level, to the parent and to the first subtopic", () => {
    expect(moveFocus(layout, key(sample.memory), "right", all)).toBe(key(sample.literature));
    expect(moveFocus(layout, key(sample.science), "right", all)).toBe(unsortedCellKey);
    expect(moveFocus(layout, unsortedCellKey, "right", all)).toBeNull();
    expect(moveFocus(layout, key(sample.literature), "left", all)).toBe(key(sample.memory));
    expect(moveFocus(layout, key(sample.memory), "left", all)).toBeNull();
    expect(moveFocus(layout, key(sample.memory), "down", all)).toBe(key(sample.forgetting));
    expect(moveFocus(layout, key(sample.forgetting), "up", all)).toBe(key(sample.memory));
    expect(moveFocus(layout, key(sample.root), "up", all)).toBeNull();
    expect(moveFocus(layout, key(sample.decay), "down", all)).toBeNull();
    expect(moveFocus(layout, unsortedCellKey, "up", all)).toBe(key(sample.root));
  });

  it("goes to the ends of a level with Home and End", () => {
    expect(moveFocus(layout, key(sample.literature), "home", all)).toBe(key(sample.memory));
    expect(moveFocus(layout, key(sample.literature), "end", all)).toBe(unsortedCellKey);
  });

  it("skips the blocks that are not drawn", () => {
    const drawn = new Set(all);
    drawn.delete(key(sample.literature));
    expect(moveFocus(layout, key(sample.memory), "right", drawn)).toBe(key(sample.science));
    drawn.delete(key(sample.forgetting));
    expect(moveFocus(layout, key(sample.memory), "down", drawn)).toBe(key(sample.retrieval));
  });

  it("walks every block from the root with arrows alone", () => {
    const seen = new Set<string>();
    const visit = (from: string) => {
      seen.add(from);
      let next = moveFocus(layout, from, "down", all);
      while (next !== null) {
        visit(next);
        next = moveFocus(layout, next, "right", all);
      }
    };
    visit(layout.rootKey!);
    expect(seen.size).toBe(layout.order.length);
  });

  it("finds the blocks above a block", () => {
    expect(cellTrail(layout, key(sample.decay)).map((cell) => cell.key)).toEqual([
      key(sample.root),
      key(sample.memory),
      key(sample.forgetting),
      key(sample.decay)
    ]);
    expect(cellTrail(layout, "nope")).toEqual([]);
  });
});

describe("zoom steps", () => {
  it("goes up and down the steps and stops at the ends", () => {
    expect(stepZoom(100, "out")).toBe(100);
    expect(stepZoom(100, "in")).toBe(150);
    expect(stepZoom(150, "in")).toBe(200);
    expect(stepZoom(200, "out")).toBe(150);
    expect(stepZoom(zoomSteps.at(-1)!, "in")).toBe(zoomSteps.at(-1));
  });
});

describe("a big tree", () => {
  it("tiles exactly and lays out 2,000 topics in a fraction of the 50 ms bar", () => {
    const nodes = bigNodes(2_000);
    expect(nodes.length).toBeGreaterThanOrEqual(1_900);
    // Warm the module, then time the layout alone.
    buildIcicle(nodes);
    const times: number[] = [];
    let layout = emptyIcicle;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      layout = buildIcicle(nodes);
      times.push(performance.now() - start);
    }
    expectTiling(layout);
    // Every topic is a block, and the root's own items make one more (Unsorted).
    expect(layout.order).toHaveLength(nodes.length + 1);
    // The bar is 50 ms; a loaded machine gets headroom here and the proof records the measured time.
    expect(Math.min(...times)).toBeLessThan(50);
  });
});

describe("a tree at the depth cap (7)", () => {
  /** A chain of eight topics, the root at depth 0 and the last at depth 7, each holding items. */
  const chain = Array.from({ length: topicReadLimits.shapeDepthMax + 1 }, (_, depth) =>
    shapeNode(
      depth + 1,
      depth === 0 ? null : depth,
      depth,
      `Level ${depth}`,
      // A parent spans its subtopic and its own two items.
      2 * (topicReadLimits.shapeDepthMax - depth) + 1,
      { directItems: depth === 7 ? 1 : 2, children: depth === 7 ? 0 : 1 }
    )
  );

  it("lays one row per level down to depth 7, each parent spanning exactly its children", () => {
    const layout = buildIcicle(chain, { wholeTree: false });
    expect(layout.rows).toBe(8);
    for (const cell of layout.cells) {
      if (cell.kind === "topic") expect(cell.row).toBe(cell.node!.depth);
    }
    const deepest = layout.byKey.get(topicCellKey(shapeId(8)))!;
    expect(deepest.row).toBe(7);
    expect(deepest.cut).toBe(false);
    expect(cellTrail(layout, deepest.key)).toHaveLength(8);
    expectTiling(layout);
    expect(layout.total).toBe(chain[0]!.items);
  });

  it("walks the focus down and back up all seven steps", () => {
    const layout = buildIcicle(chain, { wholeTree: false });
    const reachable = new Set(layout.order);
    let at = layout.rootKey!;
    for (let step = 0; step < 7; step += 1) {
      const next = moveFocus(layout, at, "down", reachable);
      expect(next, `down from level ${step}`).not.toBeNull();
      at = next!;
    }
    expect(layout.byKey.get(at)!.row).toBe(7);
    expect(moveFocus(layout, at, "down", reachable)).toBeNull();
    for (let step = 0; step < 7; step += 1) at = moveFocus(layout, at, "up", reachable)!;
    expect(at).toBe(layout.rootKey);
  });

  it("marks a topic whose subtopics the read left out below depth 7 as cut", () => {
    const stopped = chain.map((node, index) =>
      index === 7 ? { ...node, children: 3, directItems: 0, items: 1 } : node
    );
    const layout = buildIcicle(stopped, { wholeTree: false });
    expect(layout.byKey.get(topicCellKey(shapeId(8)))!.cut).toBe(true);
  });

  it("lays out 2,000 topics seven levels deep, as many blocks as topics, within the bar", () => {
    const nodes = bigNodes(topicReadLimits.shapeNodesMax, topicReadLimits.shapeDepthMax);
    expect(nodes.length).toBeLessThanOrEqual(topicReadLimits.shapeNodesMax);
    expect(Math.max(...nodes.map((node) => node.depth))).toBe(7);
    buildIcicle(nodes);
    const times: number[] = [];
    let layout = emptyIcicle;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      layout = buildIcicle(nodes);
      times.push(performance.now() - start);
    }
    expectTiling(layout);
    expect(layout.rows).toBeGreaterThanOrEqual(8);
    expect(layout.order).toHaveLength(nodes.length + 1);
    // The bar is 50 ms; the best of five keeps a loaded machine from deciding it.
    expect(Math.min(...times)).toBeLessThan(50);
  });

  it("tints every level the read can reach: the shares only get paler with depth", () => {
    expect(fillShares.length).toBeGreaterThan(0);
    for (let i = 1; i < fillShares.length; i += 1) {
      expect(fillShares[i]!).toBeLessThanOrEqual(fillShares[i - 1]!);
    }
  });
});
