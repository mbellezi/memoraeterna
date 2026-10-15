// Cosine k-nearest-neighbour graphs over unit rows: exact search up to `exactLimit` rows, an
// inverted-file (IVF) approximation above it (ported from Spike B). Neighbour lists are sorted
// by decreasing similarity; ties keep the earlier local index, so the graph is deterministic.
import { sphericalKMeans } from "./kmeans.js";
import { deriveSeed } from "./rng.js";
import { dotAt } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface KnnGraph {
  k: number;
  /** Matrix rows in local order (local index i is matrix row rows[i]). */
  rows: number[];
  /** n * k local neighbour indices (-1 when fewer than k exist). */
  neighbors: Int32Array;
  /** n * k cosine similarities (-Infinity in empty slots). */
  sims: Float32Array;
  /** True when every list is exact (n <= exactLimit). */
  exact: boolean;
}

export interface KnnOptions {
  seed: number;
  /** Exact search up to this many rows; inverted-file (IVF) search above. */
  exactLimit?: number;
  /** IVF lists probed per query. */
  nprobe?: number;
}

function pushTopK(
  neighbors: Int32Array,
  sims: Float32Array,
  base: number,
  k: number,
  candidate: number,
  sim: number
): void {
  if (sim <= (sims[base + k - 1] as number)) return;
  let position = k - 1;
  while (position > 0 && (sims[base + position - 1] as number) < sim) {
    sims[base + position] = sims[base + position - 1] as number;
    neighbors[base + position] = neighbors[base + position - 1] as number;
    position -= 1;
  }
  sims[base + position] = sim;
  neighbors[base + position] = candidate;
}

/** Exact cosine kNN by brute force over every pair (O(n^2 * dim)). */
export function exactKnnGraph(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  k: number
): KnnGraph {
  const n = rows.length;
  const { dim, data } = matrix;
  const neighbors = new Int32Array(n * k).fill(-1);
  const sims = new Float32Array(n * k).fill(-Infinity);
  for (let i = 0; i < n; i += 1) {
    const offset = (rows[i] as number) * dim;
    for (let j = i + 1; j < n; j += 1) {
      const sim = dotAt(data, offset, data, (rows[j] as number) * dim, dim);
      pushTopK(neighbors, sims, i * k, k, j, sim);
      pushTopK(neighbors, sims, j * k, k, i, sim);
    }
  }
  return { k, rows: [...rows], neighbors, sims, exact: true };
}

export function knnGraph(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  k: number,
  options: KnnOptions
): KnnGraph {
  const n = rows.length;
  const exactLimit = options.exactLimit ?? 3000;
  if (n <= exactLimit) return exactKnnGraph(matrix, rows, k);
  const { dim, data } = matrix;
  const neighbors = new Int32Array(n * k).fill(-1);
  const sims = new Float32Array(n * k).fill(-Infinity);
  const local = rows.map((_, index) => index);
  const listCount = Math.max(2, Math.round(Math.sqrt(n)));
  const coarse = sphericalKMeans(matrix, rows, {
    k: listCount,
    seed: deriveSeed(options.seed, "ivf"),
    maxIterations: 8
  });
  const lists: number[][] = Array.from({ length: coarse.k }, () => []);
  for (const i of local) lists[coarse.assignments[i] as number]?.push(i);
  const nprobe = Math.min(coarse.k, options.nprobe ?? 8);
  const centroidSims = new Float64Array(coarse.k);
  const order = Array.from({ length: coarse.k }, (_, index) => index);
  for (let i = 0; i < n; i += 1) {
    const offset = (rows[i] as number) * dim;
    coarse.centroids.forEach((centroid, c) => {
      centroidSims[c] = dotAt(data, offset, centroid, 0, dim);
    });
    order.sort((a, b) => (centroidSims[b] as number) - (centroidSims[a] as number));
    for (let p = 0; p < nprobe; p += 1) {
      for (const j of lists[order[p] as number] ?? []) {
        if (j === i) continue;
        pushTopK(
          neighbors,
          sims,
          i * k,
          k,
          j,
          dotAt(data, offset, data, (rows[j] as number) * dim, dim)
        );
      }
    }
  }
  return { k, rows: [...rows], neighbors, sims, exact: false };
}

/**
 * Mean recall@k of `approximate` against `exact` over the same rows: the share of each exact
 * neighbour list (non-empty slots) found in the approximate list.
 */
export function knnRecall(approximate: KnnGraph, exact: KnnGraph): number {
  if (approximate.rows.length !== exact.rows.length || approximate.k !== exact.k) {
    throw new Error("kNN graphs differ in shape");
  }
  const { k } = exact;
  let found = 0;
  let total = 0;
  for (let i = 0; i < exact.rows.length; i += 1) {
    const candidates = new Set<number>();
    for (let slot = 0; slot < k; slot += 1) {
      const neighbor = approximate.neighbors[i * k + slot] as number;
      if (neighbor >= 0) candidates.add(neighbor);
    }
    for (let slot = 0; slot < k; slot += 1) {
      const neighbor = exact.neighbors[i * k + slot] as number;
      if (neighbor < 0) continue;
      total += 1;
      if (candidates.has(neighbor)) found += 1;
    }
  }
  return total > 0 ? found / total : 1;
}
