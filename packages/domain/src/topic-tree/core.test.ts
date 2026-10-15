// Numeric core: seeded RNG, unit matrices, balanced spherical k-means and the kNN graph.
import { describe, expect, it } from "vitest";

import { gaussianClusters } from "./fixtures/synthetic.js";
import { groupsOf, sphericalKMeans } from "./kmeans.js";
import { exactKnnGraph, knnGraph, knnRecall } from "./knn.js";
import { createRng, deriveSeed } from "./rng.js";
import {
  dotRows,
  keyedVectors,
  matrixFromRows,
  maxUnitDeviation,
  rowVectors,
  sumRows,
  unit
} from "./vectors.js";

describe("seeded randomness", () => {
  it("repeats for a seed and differs across seeds and labels", () => {
    const sample = (seed: number): number[] => {
      const rng = createRng(seed);
      return Array.from({ length: 5 }, () => rng.next());
    };
    expect(sample(7)).toEqual(sample(7));
    expect(sample(7)).not.toEqual(sample(8));
    expect(deriveSeed(7, "split:a")).toBe(deriveSeed(7, "split:a"));
    expect(deriveSeed(7, "split:a")).not.toBe(deriveSeed(7, "split:b"));
    expect(deriveSeed(7, "x")).not.toBe(deriveSeed(8, "x"));
  });

  it("shuffles into a permutation and draws normal samples", () => {
    const rng = createRng(1);
    const values = Array.from({ length: 50 }, (_, index) => index);
    expect([...rng.shuffle([...values])].sort((a, b) => a - b)).toEqual(values);
    const draws = Array.from({ length: 4000 }, () => rng.gaussian());
    const mean = draws.reduce((total, value) => total + value, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });
});

describe("unit matrices", () => {
  it("normalizes rows and reports non-unit or corrupt rows", () => {
    const matrix = matrixFromRows([
      [3, 4],
      [0, 2]
    ]);
    expect(dotRows(matrix, 0, 0)).toBeCloseTo(1, 6);
    expect(maxUnitDeviation(matrix)).toBeLessThan(1e-6);
    const raw = matrixFromRows([[3, 4]], false);
    expect(maxUnitDeviation(raw)).toBeCloseTo(4, 6);
    raw.data[0] = Number.NaN;
    expect(maxUnitDeviation(raw)).toBe(Number.POSITIVE_INFINITY);
    expect(Array.from(unit(sumRows(matrix, [0, 1])))).toHaveLength(2);
  });

  it("resolves item vectors by key", () => {
    const matrix = matrixFromRows([
      [1, 0],
      [0, 1]
    ]);
    expect(keyedVectors(matrix, ["note:a", "note:b"]).rowOf("note:b")).toBe(1);
    expect(() => keyedVectors(matrix, ["note:a", "note:a"])).toThrow();
    expect(rowVectors(matrix).rowOf("row:1")).toBe(1);
    expect(rowVectors(matrix).rowOf("row:2")).toBeUndefined();
  });
});

describe("balanced spherical k-means", () => {
  const data = gaussianClusters({
    groups: 4,
    clustersPerGroup: 1,
    pointsPerCluster: 40,
    dim: 16,
    groupSpread: 0.8,
    pointNoise: 0.3,
    seed: 3
  });
  const rows = Array.from({ length: data.matrix.count }, (_, index) => index);

  it("recovers separated clusters deterministically", () => {
    const first = sphericalKMeans(data.matrix, rows, { k: 4, seed: 11 });
    const second = sphericalKMeans(data.matrix, rows, { k: 4, seed: 11 });
    expect(Array.from(first.assignments)).toEqual(Array.from(second.assignments));
    const groups = groupsOf(first, rows);
    expect(groups).toHaveLength(4);
    for (const group of groups) {
      expect(new Set(group.map((row) => data.clusters[row])).size).toBe(1);
    }
  });

  it("honors minimum and maximum sizes", () => {
    const result = sphericalKMeans(data.matrix, rows, { k: 5, seed: 2, minSize: 25, maxSize: 40 });
    for (const size of result.sizes) {
      expect(size).toBeGreaterThanOrEqual(25);
      expect(size).toBeLessThanOrEqual(40);
    }
  });
});

describe("kNN graph", () => {
  const data = gaussianClusters({
    groups: 6,
    clustersPerGroup: 4,
    pointsPerCluster: 25,
    dim: 32,
    groupSpread: 0.8,
    pointNoise: 0.5,
    seed: 5
  });
  const rows = Array.from({ length: data.matrix.count }, (_, index) => index);

  it("equals brute force when exact", () => {
    const k = 10;
    const graph = knnGraph(data.matrix, rows, k, { seed: 1 });
    expect(graph.exact).toBe(true);
    for (let i = 0; i < rows.length; i += 1) {
      const expected = rows
        .filter((j) => j !== i)
        .map((j) => ({ j, sim: dotRows(data.matrix, i, j) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k);
      const got = Array.from(graph.neighbors.subarray(i * k, (i + 1) * k));
      expect(got.map((j) => Math.fround(dotRows(data.matrix, i, j)))).toEqual(
        expected.map((entry) => Math.fround(entry.sim))
      );
      expect(new Set(got)).toEqual(new Set(expected.map((entry) => entry.j)));
    }
  });

  it("approximates with IVF above the exact limit at high recall", () => {
    const exact = exactKnnGraph(data.matrix, rows, 10);
    const approximate = knnGraph(data.matrix, rows, 10, { seed: 1, exactLimit: 100, nprobe: 8 });
    expect(approximate.exact).toBe(false);
    expect(knnRecall(approximate, exact)).toBeGreaterThanOrEqual(0.9);
    expect(knnRecall(exact, exact)).toBe(1);
  });
});
