import { describe, expect, it } from "vitest";

import { percentile, share, sumReported, summarize, tally, toSeconds } from "./stats.js";
import { treeShape } from "./tree.js";

describe("percentile", () => {
  it("interpolates linearly like SQL percentile_cont", () => {
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 0.5)).toBe(25);
    expect(percentile(sorted, 0.95)).toBeCloseTo(38.5, 10);
    expect(percentile(sorted, 1)).toBe(40);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("returns null for no data and rejects fractions outside [0, 1]", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
  });
});

describe("summarize", () => {
  it("summarizes unsorted values and ignores missing or non-finite ones", () => {
    const result = summarize([
      5,
      null,
      1,
      undefined,
      Number.NaN,
      3,
      Number.POSITIVE_INFINITY,
      2,
      4
    ]);
    expect(result).toEqual({ n: 5, min: 1, p50: 3, p95: 4.8, max: 5, mean: 3, sum: 15 });
  });

  it("returns null when nothing is measurable", () => {
    expect(summarize([])).toBeNull();
    expect(summarize([null, undefined])).toBeNull();
  });

  it("converts milliseconds to seconds", () => {
    expect(toSeconds(summarize([1000, 3000]))).toEqual({
      n: 2,
      min: 1,
      p50: 2,
      p95: 2.9,
      max: 3,
      mean: 2,
      sum: 4
    });
    expect(toSeconds(null)).toBeNull();
  });
});

describe("tally, share and sumReported", () => {
  it("counts by key and files empty keys under unknown", () => {
    expect(tally(["a", "b", "a", "", null], (value) => value)).toEqual({ a: 2, b: 1, unknown: 2 });
  });

  it("keeps unknown shares unknown", () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(0, 0)).toBeNull();
  });

  it("sums only the reported numbers and says how many there were", () => {
    expect(sumReported([1, null, 2.5, undefined, Number.NaN])).toEqual({ sum: 3.5, reported: 2 });
    expect(sumReported([])).toEqual({ sum: 0, reported: 0 });
  });
});

describe("treeShape", () => {
  it("measures depth and fan-out of a forest", () => {
    const shape = treeShape([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "a" },
      { id: "d", parentId: "b" },
      { id: "e", parentId: null }
    ]);
    expect(shape).toMatchObject({
      nodes: 5,
      roots: 2,
      danglingParents: 0,
      unreachable: 0,
      maxDepth: 2,
      byDepth: { 0: 2, 1: 2, 2: 1 },
      internalNodes: 2,
      leaves: 3
    });
    expect(shape.fanOut).toMatchObject({ n: 2, min: 1, max: 2, sum: 3 });
    expect(shape.depth).toMatchObject({ n: 5, max: 2, mean: 0.8 });
  });

  it("treats a parent outside the set as a root and counts it as dangling", () => {
    const shape = treeShape([
      { id: "a", parentId: "archived" },
      { id: "b", parentId: "a" }
    ]);
    expect(shape).toMatchObject({ roots: 1, danglingParents: 1, maxDepth: 1, unreachable: 0 });
  });

  it("reports nodes in a parent loop as unreachable instead of looping forever", () => {
    const shape = treeShape([
      { id: "root", parentId: null },
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
      { id: "z", parentId: "x" }
    ]);
    expect(shape.unreachable).toBe(3);
    expect(shape.roots).toBe(1);
    expect(shape.internalNodes).toBe(0);
    expect(shape.leaves).toBe(1);
  });

  it("handles an empty forest", () => {
    expect(treeShape([])).toMatchObject({
      nodes: 0,
      roots: 0,
      maxDepth: 0,
      depth: null,
      fanOut: null,
      internalNodes: 0,
      leaves: 0
    });
  });
});
