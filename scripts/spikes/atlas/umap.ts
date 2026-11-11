// UMAP over a precomputed exact neighbour table (umap-js 1.4.0, a dev dependency of this spike only).
//
// umap-js builds its own neighbour table by approximate NN-descent when it is not given one. The spike
// needs the exact 1024-d neighbours anyway (kNN purity), so the same table feeds every seed and the
// seeds differ only in the random start and the sampling. umap-js has no spectral initialisation: the
// start is uniform noise, which makes the seed-to-seed Procrustes test a hard one.
import { UMAP } from "umap-js";

import { createRng } from "@app/domain/topic-tree";
import type { KnnGraph } from "@app/domain/topic-tree";

import { atlasCriterion } from "./criterion.js";

export interface UmapRun {
  seed: number;
  /** n x 2, row-major. */
  points: Float64Array;
  epochs: number;
  milliseconds: number;
}

/**
 * umap-js wants `nNeighbors` columns per row with the point itself first at distance 0 (it skips
 * `index === row`). `graph` holds cosine similarities of unit rows; the distance is the Euclidean one
 * of unit vectors, sqrt(2 - 2 cos), which orders neighbours as cosine does.
 */
export function umapNeighbourTable(
  graph: KnnGraph,
  nNeighbors: number
): { indices: number[][]; distances: number[][] } {
  if (graph.k < nNeighbors - 1) throw new Error("The neighbour graph is too small for UMAP.");
  const n = graph.rows.length;
  const indices: number[][] = [];
  const distances: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row = [i];
    const distance = [0];
    for (let slot = 0; slot < nNeighbors - 1; slot += 1) {
      const neighbour = graph.neighbors[i * graph.k + slot] as number;
      if (neighbour < 0) break;
      row.push(neighbour);
      distance.push(Math.sqrt(Math.max(0, 2 - 2 * (graph.sims[i * graph.k + slot] as number))));
    }
    indices.push(row);
    distances.push(distance);
  }
  return { indices, distances };
}

export function runUmap(
  graph: KnnGraph,
  seed: number,
  onEpoch?: (epoch: number, epochs: number) => void
): UmapRun {
  const started = performance.now();
  const n = graph.rows.length;
  const { nNeighbors, minDist, nComponents } = atlasCriterion.umap;
  const table = umapNeighbourTable(graph, nNeighbors);
  const umap = new UMAP({
    nNeighbors,
    minDist,
    nComponents,
    random: createRng(seed).next
  });
  umap.setPrecomputedKNN(table.indices, table.distances);
  // With a precomputed table umap-js reads only the length of the data.
  const placeholder: number[][] = Array.from({ length: n }, () => []);
  const epochs = umap.initializeFit(placeholder);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    umap.step();
    onEpoch?.(epoch + 1, epochs);
  }
  const embedding = umap.getEmbedding();
  const points = new Float64Array(n * 2);
  embedding.forEach((row, i) => {
    points[2 * i] = row[0] as number;
    points[2 * i + 1] = row[1] as number;
  });
  return { seed, points, epochs, milliseconds: performance.now() - started };
}
