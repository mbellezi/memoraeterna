import { describe, expect, it } from "vitest";

import { createRng, exactKnnGraph, matrixFromRows } from "@app/domain/topic-tree";

import { atlasCriterion, judgeAtlas, judgeDataset } from "./criterion.js";
import { branchComponents, chanceShare, nearestNeighbours2d, sharedLabelShare } from "./metrics.js";
import { pca2d } from "./pca.js";
import { procrustesDisparity } from "./procrustes.js";
import { encodePng, scatterPng } from "./png.js";

/** `clusters` Gaussian blobs of `size` points in `dim` dimensions, well apart (a unit step per axis). */
function blobs(clusters: number, size: number, dim: number, spread: number, seed = 7) {
  const rng = createRng(seed);
  const rows: number[][] = [];
  const labels: number[] = [];
  for (let cluster = 0; cluster < clusters; cluster += 1)
    for (let member = 0; member < size; member += 1) {
      const row = Array.from({ length: dim }, () => spread * rng.gaussian());
      row[cluster % dim] = (row[cluster % dim] as number) + 10;
      rows.push(row);
      labels.push(cluster);
    }
  return { rows, labels: Int32Array.from(labels) };
}

function flat(rows: number[][], dims = 2): Float64Array {
  const out = new Float64Array(rows.length * dims);
  rows.forEach((row, i) => row.slice(0, dims).forEach((value, c) => (out[i * dims + c] = value)));
  return out;
}

describe("neighbour purity and contiguity on synthetic clusters", () => {
  it("is 1 for separated clusters, in 1024-d-style cosine space and in 2-D", () => {
    const { rows, labels } = blobs(4, 30, 16, 0.2);
    const matrix = matrixFromRows(rows);
    const graph = exactKnnGraph(
      matrix,
      Array.from(labels, (_, i) => i),
      10
    );
    const purity = sharedLabelShare({ neighbors: graph.neighbors, stride: 10 }, labels, 10);
    expect(purity.overall).toBe(1);
    expect(purity.macro).toBe(1);
    expect(purity.byLabel).toHaveLength(4);

    const planar = flat(
      rows.map((row, i) => [(labels[i] as number) * 50 + (row[0] as number), row[1] as number])
    );
    const table = nearestNeighbours2d(planar, 10);
    expect(sharedLabelShare(table, labels, 10).overall).toBe(1);
  });

  it("falls to the chance share when the labels are unrelated to the geometry", () => {
    const { rows } = blobs(4, 60, 16, 1);
    const rng = createRng(11);
    const labels = Int32Array.from(rows.map(() => rng.int(4)));
    const matrix = matrixFromRows(rows.map((row) => row.map(() => rng.gaussian())));
    const graph = exactKnnGraph(
      matrix,
      Array.from(labels, (_, i) => i),
      10
    );
    const purity = sharedLabelShare({ neighbors: graph.neighbors, stride: 10 }, labels, 10).overall;
    expect(Math.abs(purity - chanceShare(labels))).toBeLessThan(0.08);
  });

  it("counts a neighbour without a branch as a miss and leaves unlabelled points out of the mean", () => {
    // Four points on a line: 0 and 1 share branch 0, point 2 is on the map but not measured.
    const points = Float64Array.from([0, 0, 1, 0, 2, 0, 50, 0]);
    const labels = Int32Array.from([0, 0, -1, 1]);
    const table = nearestNeighbours2d(points, 2);
    const report = sharedLabelShare(table, labels, 2, 1);
    expect(report.measured).toBe(3);
    // Point 0: neighbours 1 (same), 2 (unlabelled) -> 0.5; point 1: 0 (same), 2 -> 0.5; point 3: 0.
    expect(report.overall).toBeCloseTo((0.5 + 0.5 + 0) / 3, 10);
  });

  it("reports the chance share of the label frequencies", () => {
    expect(chanceShare(Int32Array.from([0, 0, 1, 1]))).toBeCloseTo(0.5, 10);
    expect(chanceShare(Int32Array.from([0, 0, 0, 1, -1]))).toBeCloseTo(0.75 ** 2 + 0.25 ** 2, 10);
  });
});

describe("components of the 2-D neighbour graph", () => {
  it("is one component for a contiguous branch and several for a scattered one", () => {
    // Branch 0: two tight groups far apart (two components); branch 1: one tight group.
    const points = Float64Array.from([
      0, 0, 1, 0, 0, 1, 1, 1, 100, 0, 101, 0, 100, 1, 101, 1, 200, 0, 201, 0, 200, 1, 201, 1
    ]);
    const labels = Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    const table = nearestNeighbours2d(points, 3);
    const components = branchComponents(table, labels, 3);
    expect(components.find((c) => c.label === 0)).toMatchObject({
      members: 8,
      components: 2,
      largestShare: 0.5
    });
    expect(components.find((c) => c.label === 1)).toMatchObject({
      members: 4,
      components: 1,
      largestShare: 1
    });
  });
});

describe("procrustes disparity", () => {
  const shape = Float64Array.from([0, 0, 4, 0, 4, 2, 1, 3, 2, 1, 3, 3]);

  it("is 0 for the same shape rotated, reflected, scaled and shifted", () => {
    const angle = 0.7;
    const moved = new Float64Array(shape.length);
    for (let i = 0; i < shape.length; i += 2) {
      const x = shape[i] as number;
      const y = shape[i + 1] as number;
      moved[i] = 3 * (Math.cos(angle) * x - Math.sin(angle) * y) + 40;
      moved[i + 1] = -3 * (Math.sin(angle) * x + Math.cos(angle) * y) - 9; // reflected
    }
    expect(procrustesDisparity(shape, moved)).toBeCloseTo(0, 10);
  });

  it("is large for unrelated shapes and symmetric", () => {
    const rng = createRng(5);
    const other = Float64Array.from({ length: 12 }, () => rng.gaussian());
    const forward = procrustesDisparity(shape, other);
    expect(forward).toBeGreaterThan(0.3);
    expect(forward).toBeLessThanOrEqual(1);
    expect(procrustesDisparity(other, shape)).toBeCloseTo(forward, 10);
  });

  it("matches the exact residual of the optimal fit on a perturbed shape", () => {
    const rng = createRng(9);
    const noisy = shape.map((value) => value + 0.05 * rng.gaussian());
    const disparity = procrustesDisparity(shape, noisy);
    expect(disparity).toBeGreaterThan(0);
    expect(disparity).toBeLessThan(0.01);
  });

  it("refuses a degenerate map", () => {
    expect(() => procrustesDisparity(Float64Array.from([1, 1, 1, 1]), shape.slice(0, 4))).toThrow();
  });
});

describe("pca2d", () => {
  it("finds the two directions that carry the variance and is deterministic", () => {
    const rng = createRng(3);
    const rows = Array.from({ length: 200 }, () => [
      5 * rng.gaussian(),
      2 * rng.gaussian(),
      0.1 * rng.gaussian(),
      0.1 * rng.gaussian()
    ]);
    const matrix = matrixFromRows(rows, false);
    const first = pca2d(matrix, 1);
    const second = pca2d(matrix, 1);
    expect(Array.from(first.points)).toEqual(Array.from(second.points));
    expect(first.explained[0]).toBeGreaterThan(0.75);
    expect(first.explained[0] + first.explained[1]).toBeGreaterThan(0.97);
    // The first component follows the widest axis: the projection correlates with column 0.
    const xs = Array.from({ length: 200 }, (_, i) => first.points[2 * i] as number);
    const cols = rows.map((row) => row[0] as number);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const mx = mean(xs);
    const mc = mean(cols);
    const cov = xs.reduce((sum, x, i) => sum + (x - mx) * ((cols[i] as number) - mc), 0);
    const correlation =
      cov /
      Math.sqrt(
        xs.reduce((s, x) => s + (x - mx) ** 2, 0) * cols.reduce((s, c) => s + (c - mc) ** 2, 0)
      );
    expect(Math.abs(correlation)).toBeGreaterThan(0.99);
  });
});

describe("png", () => {
  it("writes a valid PNG signature, header and end chunk", () => {
    const png = encodePng(2, 1, Uint8Array.from([255, 0, 0, 0, 255, 0]));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("draws a coloured disc per point", () => {
    const points = Float64Array.from([0, 0, 10, 10]);
    const png = scatterPng(points, Int32Array.from([0, -1]), { size: 64, radius: 3, margin: 8 });
    expect(png.length).toBeGreaterThan(100);
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });
});

describe("the frozen go criterion", () => {
  it("carries the registered thresholds", () => {
    expect(atlasCriterion.minLevelOneContiguity).toBe(0.7);
    expect(atlasCriterion.maxProcrustesDisparity).toBe(0.2);
    expect(atlasCriterion.umap).toMatchObject({ nNeighbors: 15, minDist: 0.1 });
    expect(atlasCriterion.umap.seeds).toHaveLength(3);
    expect(Object.isFrozen(atlasCriterion)).toBe(true);
  });

  it("judges each bar and needs both datasets for a go", () => {
    const good = { name: "enc", weak: false, contiguity: 0.7, disparity: 0.2 };
    expect(judgeDataset(good).met).toBe(true);
    expect(judgeDataset({ ...good, contiguity: 0.69 })).toMatchObject({
      met: false,
      contiguityMet: false,
      disparityMet: true
    });
    expect(judgeDataset({ ...good, disparity: 0.21 })).toMatchObject({
      met: false,
      disparityMet: false
    });
    expect(judgeAtlas([good, { ...good, name: "gs", weak: true }]).verdict).toBe("go");
    expect(judgeAtlas([good]).verdict).toBe("no-go");
    expect(judgeAtlas([good, { ...good, contiguity: 0.1 }]).verdict).toBe("no-go");
  });
});
