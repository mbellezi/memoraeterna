import { describe, expect, it } from "vitest";

import { defaultSyntheticOptions, gaussianClusters } from "@app/domain/topic-tree";

import {
  measureQueryRecall,
  measureSubsetRecall,
  sampleRows,
  smallestNprobeReaching
} from "./knn-recall.js";

// 20 groups of 3 clusters of 20 points: 1,200 rows, 100+ IVF lists, so nprobe matters.
const data = gaussianClusters({
  ...defaultSyntheticOptions,
  groups: 20,
  clustersPerGroup: 3,
  pointsPerCluster: 20,
  dim: 32,
  seed: 5
});

describe("sampleRows", () => {
  it("draws distinct rows, ascending, deterministic per seed and label", () => {
    const rows = sampleRows(1000, 100, 7, "a");
    expect(rows).toHaveLength(100);
    expect(new Set(rows).size).toBe(100);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(sampleRows(1000, 100, 7, "a")).toEqual(rows);
    expect(sampleRows(1000, 100, 7, "b")).not.toEqual(rows);
    expect(sampleRows(10, 100, 7, "a")).toHaveLength(10);
  });
});

describe("IVF recall", () => {
  it("is exact when every list is probed, and grows with nprobe", () => {
    const result = measureSubsetRecall(data.matrix, {
      sampleSize: 800,
      nprobes: [1, 4, 1000],
      k: 10,
      seed: 20261014
    });
    expect(result.sample).toBe(800);
    const [one, four, all] = result.points;
    expect(all?.recall).toBe(1);
    expect(four?.recall).toBeGreaterThanOrEqual(one?.recall ?? 1);
    expect(one?.recall).toBeLessThan(1);
    expect(one?.lists).toBe(28);
    expect(smallestNprobeReaching(result.points, 1)).toBeGreaterThan(1);
    expect(smallestNprobeReaching(result.points, 1)).toBeLessThanOrEqual(1000);
    expect(smallestNprobeReaching(result.points, 0)).toBe(1);
    expect(
      smallestNprobeReaching([{ nprobe: 4, recall: 0.5, lists: 9, ivfMs: 0 }], 0.9)
    ).toBeNull();
  });

  it("measures the production setting against exact scans of sampled queries", () => {
    const full = measureQueryRecall(data.matrix, { queries: 60, nprobe: 1000, k: 10, seed: 3 });
    expect(full.rows).toBe(1200);
    expect(full.queries).toBe(60);
    expect(full.point.recall).toBe(1);
    expect(full.minRecall).toBe(1);
    const narrow = measureQueryRecall(data.matrix, { queries: 60, nprobe: 1, k: 10, seed: 3 });
    expect(narrow.point.recall).toBeLessThan(1);
    expect(narrow.minRecall).toBeLessThanOrEqual(narrow.point.recall);
  });
});
