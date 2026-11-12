import { describe, expect, it } from "vitest";

import {
  boundedNodes,
  diffId,
  diffNode,
  diffTopics,
  sampleDiffNodes,
  standing
} from "./icicle-diff-fixtures";
import {
  buildDiffIcicle,
  cellSpan,
  diffCellContent,
  diffCellKey,
  diffFullWidth,
  diffGlyphWidth,
  drawnDiffCells,
  keyboardFocus,
  minDrawnWidth,
  moveFocus,
  movedWeight,
  tabStop,
  type DiffIcicle
} from "./icicle-layout";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const before = (n: number) => diffCellKey("before", diffId(n));
const after = (n: number) => diffCellKey("after", diffId(n));

/** Every block's children start where it starts and end where it ends; the tops tile the width. */
function expectTiling(layout: DiffIcicle): void {
  const tops = layout.cells.filter((cell) => cell.parentKey === null);
  const sortedTops = [...tops].sort((a, b) => a.x0 - b.x0);
  expect(near(sortedTops[0]!.x0, 0)).toBe(true);
  expect(near(sortedTops.at(-1)!.x1, 1)).toBe(true);
  for (let i = 1; i < sortedTops.length; i += 1)
    expect(near(sortedTops[i]!.x0, sortedTops[i - 1]!.x1)).toBe(true);
  for (const cell of layout.cells) {
    if (cell.childKeys.length === 0) continue;
    const children = cell.childKeys.map((key) => layout.byKey.get(key)!);
    expect(near(children[0]!.x0, cell.x0), cell.key).toBe(true);
    expect(near(children.at(-1)!.x1, cell.x1), cell.key).toBe(true);
    for (let i = 1; i < children.length; i += 1)
      expect(near(children[i]!.x0, children[i - 1]!.x1), cell.key).toBe(true);
  }
}

describe("the icicle of a structural diff", () => {
  const nodes = sampleDiffNodes();
  const beforeSide = buildDiffIcicle(nodes, "before");
  const afterSide = buildDiffIcicle(nodes, "after");

  it("draws each topic on the sides where it existed", () => {
    expect(beforeSide.byKey.has(before(diffTopics.misc))).toBe(true);
    expect(afterSide.byKey.has(after(diffTopics.misc))).toBe(false);
    expect(beforeSide.byKey.has(before(diffTopics.retrieval))).toBe(false);
    expect(afterSide.byKey.has(after(diffTopics.retrieval))).toBe(true);
    expect(beforeSide.cells).toHaveLength(6);
    expect(afterSide.cells).toHaveLength(6);
    expect(beforeSide.cells.every((cell) => cell.side === "before")).toBe(true);
  });

  it("hangs a moved topic from its old parent before and its new one after", () => {
    const spacing = diffTopics.spacing;
    expect(beforeSide.byKey.get(before(spacing))!.parentKey).toBe(before(diffTopics.language));
    expect(afterSide.byKey.get(after(spacing))!.parentKey).toBe(after(diffTopics.memory));
    expect(beforeSide.byKey.get(before(spacing))!.row).toBe(2);
    expect(afterSide.byKey.get(after(spacing))!.row).toBe(2);
  });

  it("titles a block with the title of its side", () => {
    expect(beforeSide.byKey.get(before(diffTopics.forgetting))!.title).toBe("Forgetting");
    expect(afterSide.byKey.get(after(diffTopics.forgetting))!.title).toBe("Forgetting curve");
  });

  it("tiles the whole width on every level, a parent spanning exactly its children", () => {
    expectTiling(beforeSide);
    expectTiling(afterSide);
    expect(beforeSide.rows).toBe(3);
    expect(afterSide.rows).toBe(3);
    const root = afterSide.byKey.get(after(diffTopics.root))!;
    expect(near(root.x0, 0) && near(root.x1, 1)).toBe(true);
    expect(root.row).toBe(0);
  });

  it("widens a block by the items moved: out of a topic before, into it after", () => {
    const misc = beforeSide.byKey.get(before(diffTopics.misc))!;
    const forgetting = beforeSide.byKey.get(before(diffTopics.forgetting))!;
    // Misc: 1 + sqrt(6) for the items moved out, against 1 for a topic that moved nothing.
    expect(near(cellSpan(misc) / cellSpan(forgetting), 1 + Math.sqrt(6))).toBe(true);
    const retrieval = afterSide.byKey.get(after(diffTopics.retrieval))!;
    const spacing = afterSide.byKey.get(after(diffTopics.spacing))!;
    expect(near(cellSpan(retrieval) / cellSpan(spacing), 3)).toBe(true);
    expect(near(beforeSide.total, 1 + Math.sqrt(6) + 1 + 1)).toBe(true);
    expect(near(afterSide.total, 3 + 1 + 1 + 1)).toBe(true);
  });

  it("damps the width, so a big merge leaves the other topics wide enough to read", () => {
    const small = diffNode(1, "added", { itemsIn: 1 });
    const huge = diffNode(2, "added", { itemsIn: 400 });
    expect(movedWeight(huge, "after") / movedWeight(small, "after")).toBeLessThan(11);
    expect(movedWeight(diffNode(3, "context"), "after")).toBe(1);
  });

  it("keeps the order of the read among siblings and lists a table order from the top down", () => {
    expect(afterSide.order).toEqual(
      [
        diffTopics.root,
        diffTopics.memory,
        diffTopics.retrieval,
        diffTopics.spacing,
        diffTopics.forgetting,
        diffTopics.language
      ].map(after)
    );
    expect(afterSide.rowKeys[2]).toEqual(
      [diffTopics.retrieval, diffTopics.spacing, diffTopics.forgetting].map(after)
    );
    const lefts = afterSide.rowKeys[2]!.map((key) => afterSide.byKey.get(key)!.x0);
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  });

  it("lets a host choose the width, never below one share or from a number that is not one", () => {
    const flat = buildDiffIcicle(nodes, "after", () => 1);
    const retrieval = flat.byKey.get(after(diffTopics.retrieval))!;
    const spacing = flat.byKey.get(after(diffTopics.spacing))!;
    expect(near(cellSpan(retrieval), cellSpan(spacing))).toBe(true);
    const odd = buildDiffIcicle(nodes, "after", (node) =>
      node.id === diffId(diffTopics.retrieval) ? Number.NaN : 0
    );
    expect(odd.byKey.get(after(diffTopics.retrieval))!.value).toBe(1);
    expect(odd.byKey.get(after(diffTopics.spacing))!.value).toBe(1);
    expectTiling(odd);
    expect(movedWeight(diffNode(1, "added", { itemsIn: 3, itemsOut: 9 }), "after")).toBeCloseTo(
      1 + Math.sqrt(3)
    );
    expect(movedWeight(diffNode(1, "added", { itemsIn: 3, itemsOut: 9 }), "before")).toBe(4);
  });

  it("is empty for a side nothing stood on", () => {
    const created = [diffNode(1, "added", { existedBefore: false })];
    const side = buildDiffIcicle(created, "before");
    expect(side.cells).toEqual([]);
    expect(side.rows).toBe(0);
    expect(side.total).toBe(0);
    expect(buildDiffIcicle([], "after").cells).toEqual([]);
  });
});

describe("a block whose parent is not in the read", () => {
  // Spacing moved away from a parent that nothing else touched: the read lists only Spacing's new place.
  const nodes = [
    standing(diffTopics.root, "context", null, null),
    standing(diffTopics.memory, "context", diffTopics.root, "Memory"),
    standing(diffTopics.spacing, "moved", diffTopics.memory, "Spaced repetition", {
      parentBefore: diffId(diffTopics.elsewhere)
    })
  ];

  it("hangs from the top of its side, marked as detached, and the side still tiles", () => {
    const beforeSide = buildDiffIcicle(nodes, "before");
    const spacing = beforeSide.byKey.get(before(diffTopics.spacing))!;
    expect(spacing.detached).toBe(true);
    expect(spacing.row).toBe(0);
    expect(spacing.parentKey).toBeNull();
    expect(beforeSide.cells.filter((cell) => cell.detached)).toHaveLength(1);
    expectTiling(beforeSide);
    const afterSide = buildDiffIcicle(nodes, "after");
    expect(afterSide.cells.some((cell) => cell.detached)).toBe(false);
    expect(afterSide.byKey.get(after(diffTopics.spacing))!.row).toBe(2);
  });

  it("never loops on a parent cycle and shows each topic once", () => {
    const loop = [
      standing(1, "renamed", 2, "One"),
      standing(2, "renamed", 1, "Two"),
      standing(3, "renamed", 3, "Itself")
    ];
    const side = buildDiffIcicle(loop, "after");
    expect(side.cells.map((cell) => cell.topicId).sort()).toEqual(
      [diffId(1), diffId(2), diffId(3)].sort()
    );
    expectTiling(side);
    const twice = buildDiffIcicle([loop[0]!, loop[0]!, loop[2]!], "after");
    expect(twice.cells).toHaveLength(2);
  });
});

describe("a bounded diff", () => {
  const nodes = boundedNodes(200);

  it("lays out 200 topics on both sides, tiling every level", () => {
    expect(nodes).toHaveLength(200);
    for (const side of ["before", "after"] as const) {
      const layout = buildDiffIcicle(nodes, side);
      expect(layout.cells).toHaveLength(200);
      expect(layout.rows).toBe(5);
      expect(layout.order).toHaveLength(200);
      expectTiling(layout);
    }
  });

  it("draws only what is wide enough and reaches only what is drawn", () => {
    const layout = buildDiffIcicle(nodes, "after");
    const narrow = drawnDiffCells(layout, 200);
    expect(narrow.hidden).toBeGreaterThan(0);
    expect(narrow.drawn.length + narrow.hidden).toBe(200);
    for (const cell of narrow.drawn)
      expect(cellSpan(cell) * 200).toBeGreaterThanOrEqual(minDrawnWidth);
    expect(narrow.reachable.size).toBe(narrow.drawn.length);
    const wide = drawnDiffCells(layout, 100_000);
    expect(wide.hidden).toBe(0);
    expect(wide.drawn).toHaveLength(200);
  });
});

describe("what a block says and how a key moves between blocks", () => {
  it("names a block in full, only by its glyph, or not at all by its width", () => {
    expect(diffCellContent(diffFullWidth)).toBe("full");
    expect(diffCellContent(diffFullWidth - 1)).toBe("glyph");
    expect(diffCellContent(diffGlyphWidth)).toBe("glyph");
    expect(diffCellContent(diffGlyphWidth - 1)).toBe("none");
  });

  const layout = buildDiffIcicle(sampleDiffNodes(), "after");
  const all = drawnDiffCells(layout, 10_000).reachable;
  const key = after;

  it("moves along a level, up to the parent, down to the first child and to either end", () => {
    const retrieval = key(diffTopics.retrieval);
    expect(moveFocus(layout, retrieval, "right", all)).toBe(key(diffTopics.spacing));
    expect(moveFocus(layout, key(diffTopics.spacing), "left", all)).toBe(retrieval);
    expect(moveFocus(layout, retrieval, "left", all)).toBeNull();
    expect(moveFocus(layout, retrieval, "up", all)).toBe(key(diffTopics.memory));
    expect(moveFocus(layout, key(diffTopics.root), "up", all)).toBeNull();
    expect(moveFocus(layout, key(diffTopics.root), "down", all)).toBe(key(diffTopics.memory));
    expect(moveFocus(layout, retrieval, "down", all)).toBeNull();
    expect(moveFocus(layout, key(diffTopics.spacing), "home", all)).toBe(retrieval);
    expect(moveFocus(layout, retrieval, "end", all)).toBe(key(diffTopics.forgetting));
    expect(moveFocus(layout, "after:unknown", "right", all)).toBeNull();
  });

  it("handles the arrows, Home and End and leaves every other key to the page", () => {
    const from = key(diffTopics.spacing);
    expect(keyboardFocus(layout, from, "ArrowLeft", all)).toEqual({
      handled: true,
      to: key(diffTopics.retrieval)
    });
    expect(keyboardFocus(layout, from, "ArrowRight", all).to).toBe(key(diffTopics.forgetting));
    expect(keyboardFocus(layout, from, "ArrowUp", all).to).toBe(key(diffTopics.memory));
    expect(keyboardFocus(layout, from, "Home", all).to).toBe(key(diffTopics.retrieval));
    expect(keyboardFocus(layout, from, "End", all).to).toBe(key(diffTopics.forgetting));
    // Nowhere to go: still handled, so the page does not scroll.
    expect(keyboardFocus(layout, from, "ArrowDown", all)).toEqual({ handled: true, to: null });
    for (const other of ["Tab", "Enter", " ", "Escape", "a", "constructor", "PageDown"])
      expect(keyboardFocus(layout, from, other, all)).toEqual({ handled: false, to: null });
  });

  it("reaches every drawn block from the first one with the four arrows", () => {
    const seen = new Set<string>([layout.order[0]!]);
    const queue = [layout.order[0]!];
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const move of ["left", "right", "up", "down"] as const) {
        const to = moveFocus(layout, from, move, all);
        if (to !== null && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...layout.order].sort());
  });

  it("skips blocks that are not drawn", () => {
    const drawn = new Set(
      [diffTopics.root, diffTopics.memory, diffTopics.spacing, diffTopics.forgetting].map(key)
    );
    expect(moveFocus(layout, key(diffTopics.spacing), "left", drawn)).toBeNull();
    expect(moveFocus(layout, key(diffTopics.spacing), "right", drawn)).toBe(
      key(diffTopics.forgetting)
    );
    expect(moveFocus(layout, key(diffTopics.memory), "down", drawn)).toBe(key(diffTopics.spacing));
    drawn.delete(key(diffTopics.memory));
    expect(moveFocus(layout, key(diffTopics.spacing), "up", drawn)).toBeNull();
  });

  it("holds the tab stop on the selected topic when it is drawn, otherwise on the first block", () => {
    expect(tabStop(layout, key(diffTopics.spacing), all)).toBe(key(diffTopics.spacing));
    expect(tabStop(layout, key(diffTopics.misc), all)).toBe(key(diffTopics.root));
    expect(tabStop(layout, null, all)).toBe(key(diffTopics.root));
    const rest = new Set([key(diffTopics.memory), key(diffTopics.spacing)]);
    expect(tabStop(layout, key(diffTopics.forgetting), rest)).toBe(key(diffTopics.memory));
    expect(tabStop(layout, null, new Set())).toBeNull();
  });
});
