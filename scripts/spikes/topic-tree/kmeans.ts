// Spherical k-means (cosine) with k-means++ seeding and an optional balanced
// assignment step that honors minimum and maximum cluster sizes.
import { createRng } from "./rng.js";
import type { Rng } from "./rng.js";
import { dotAt } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface KMeansOptions {
  k: number;
  seed: number;
  maxIterations?: number;
  /** Stop when at most this share of points changed cluster in an iteration. */
  tolerance?: number;
  /** Per-point weights by local index (e.g. topic sizes when clustering centroids). */
  weights?: ArrayLike<number>;
  /** Balanced assignment: cluster sizes (point counts) stay within [minSize, maxSize]. */
  minSize?: number;
  maxSize?: number;
}

export interface KMeansResult {
  k: number;
  /** Cluster per local index (position in `rows`). */
  assignments: Int32Array;
  /** Unit centroids. */
  centroids: Float32Array[];
  sizes: number[];
  iterations: number;
  /** Weighted mean cosine between points and their centroid. */
  meanCosine: number;
}

function weightOf(weights: ArrayLike<number> | undefined, index: number): number {
  return weights ? (weights[index] as number) : 1;
}

/** k-means++ seeding with cosine distance (1 - cos), weighted D^2 sampling. */
export function kmeansPlusPlus(
  matrix: EmbeddingMatrix,
  rows: ArrayLike<number>,
  k: number,
  rng: Rng,
  weights?: ArrayLike<number>
): Float32Array {
  const { dim, data } = matrix;
  const n = rows.length;
  const centers = new Float32Array(k * dim);
  const distance = new Float64Array(n).fill(Infinity);
  const chosen = new Uint8Array(n);

  let totalWeight = 0;
  for (let i = 0; i < n; i += 1) totalWeight += weightOf(weights, i);
  let target = rng.next() * totalWeight;
  let first = 0;
  for (let i = 0; i < n; i += 1) {
    target -= weightOf(weights, i);
    if (target <= 0) {
      first = i;
      break;
    }
  }

  let current = first;
  for (let c = 0; c < k; c += 1) {
    chosen[current] = 1;
    const sourceOffset = (rows[current] as number) * dim;
    centers.set(data.subarray(sourceOffset, sourceOffset + dim), c * dim);
    if (c === k - 1) break;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const cos = dotAt(data, (rows[i] as number) * dim, centers, c * dim, dim);
      const d = Math.max(0, 1 - cos);
      if (d < (distance[i] as number)) distance[i] = d;
      total += chosen[i] ? 0 : weightOf(weights, i) * (distance[i] as number) ** 2;
    }
    let next = -1;
    if (total > 0) {
      let pick = rng.next() * total;
      for (let i = 0; i < n; i += 1) {
        if (chosen[i]) continue;
        pick -= weightOf(weights, i) * (distance[i] as number) ** 2;
        if (pick <= 0) {
          next = i;
          break;
        }
      }
    }
    if (next < 0) {
      // All remaining points coincide with a center: take any unchosen point.
      const offset = rng.int(n);
      for (let step = 0; step < n; step += 1) {
        const i = (offset + step) % n;
        if (!chosen[i]) {
          next = i;
          break;
        }
      }
    }
    current = next < 0 ? first : next;
  }
  return centers;
}

/**
 * Greedy capacity assignment: points with the strongest preference (largest gap
 * between their best and second-best cluster) choose first among clusters with
 * capacity left; then under-filled clusters pull the cheapest points from
 * clusters that can spare them.
 */
export function balancedAssign(
  sims: Float32Array,
  n: number,
  k: number,
  minSize: number,
  maxSize: number
): Int32Array {
  const assignment = new Int32Array(n).fill(-1);
  const counts = new Int32Array(k);
  const regret = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let best = -Infinity;
    let second = -Infinity;
    for (let c = 0; c < k; c += 1) {
      const s = sims[i * k + c] as number;
      if (s > best) {
        second = best;
        best = s;
      } else if (s > second) second = s;
    }
    regret[i] = k > 1 ? best - second : 0;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (regret[b] as number) - (regret[a] as number) || a - b
  );
  for (const i of order) {
    let bestCluster = -1;
    let best = -Infinity;
    for (let c = 0; c < k; c += 1) {
      if ((counts[c] as number) >= maxSize) continue;
      const s = sims[i * k + c] as number;
      if (s > best) {
        best = s;
        bestCluster = c;
      }
    }
    if (bestCluster < 0) bestCluster = 0; // infeasible bounds; callers keep n <= k * maxSize
    assignment[i] = bestCluster;
    counts[bestCluster] = (counts[bestCluster] as number) + 1;
  }
  for (let c = 0; c < k; c += 1) {
    while ((counts[c] as number) < minSize) {
      let bestPoint = -1;
      let bestGain = -Infinity;
      for (let i = 0; i < n; i += 1) {
        const from = assignment[i] as number;
        if (from === c || (counts[from] as number) <= minSize) continue;
        const gain = (sims[i * k + c] as number) - (sims[i * k + from] as number);
        if (gain > bestGain) {
          bestGain = gain;
          bestPoint = i;
        }
      }
      if (bestPoint < 0) break;
      const from = assignment[bestPoint] as number;
      counts[from] = (counts[from] as number) - 1;
      counts[c] = (counts[c] as number) + 1;
      assignment[bestPoint] = c;
    }
  }
  return assignment;
}

export function sphericalKMeans(
  matrix: EmbeddingMatrix,
  rows: ArrayLike<number>,
  options: KMeansOptions
): KMeansResult {
  const { dim, data } = matrix;
  const n = rows.length;
  const k = Math.max(1, Math.min(options.k, n));
  const maxIterations = options.maxIterations ?? 25;
  const tolerance = options.tolerance ?? 0.002;
  const weights = options.weights;
  const balanced = options.minSize !== undefined || options.maxSize !== undefined;
  const minSize = Math.min(options.minSize ?? 0, Math.floor(n / k));
  const maxSize = Math.max(options.maxSize ?? n, Math.ceil(n / k));
  const rng = createRng(options.seed);

  const centers = k > 1 ? kmeansPlusPlus(matrix, rows, k, rng, weights) : new Float32Array(dim);
  const assignment = new Int32Array(n);
  const sims = balanced && k > 1 ? new Float32Array(n * k) : null;
  let iterations = 0;

  const recompute = (): number[] => {
    const sums = new Float64Array(k * dim);
    const sizes = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assignment[i] as number;
      const w = weightOf(weights, i);
      const offset = (rows[i] as number) * dim;
      const base = c * dim;
      for (let d = 0; d < dim; d += 1) {
        sums[base + d] = (sums[base + d] as number) + w * (data[offset + d] as number);
      }
      sizes[c] = (sizes[c] as number) + 1;
    }
    for (let c = 0; c < k; c += 1) {
      let length = 0;
      for (let d = 0; d < dim; d += 1) length += (sums[c * dim + d] as number) ** 2;
      length = Math.sqrt(length);
      if (length === 0) continue; // empty cluster keeps its previous center
      for (let d = 0; d < dim; d += 1)
        centers[c * dim + d] = (sums[c * dim + d] as number) / length;
    }
    return sizes;
  };

  if (k === 1) {
    recompute();
  } else {
    for (iterations = 1; iterations <= maxIterations; iterations += 1) {
      let changes = 0;
      if (sims) {
        for (let i = 0; i < n; i += 1) {
          const offset = (rows[i] as number) * dim;
          for (let c = 0; c < k; c += 1)
            sims[i * k + c] = dotAt(data, offset, centers, c * dim, dim);
        }
        const next = balancedAssign(sims, n, k, minSize, maxSize);
        for (let i = 0; i < n; i += 1) {
          if (next[i] !== assignment[i] || iterations === 1) changes += 1;
          assignment[i] = next[i] as number;
        }
      } else {
        for (let i = 0; i < n; i += 1) {
          const offset = (rows[i] as number) * dim;
          let best = -Infinity;
          let bestCluster = 0;
          for (let c = 0; c < k; c += 1) {
            const s = dotAt(data, offset, centers, c * dim, dim);
            if (s > best) {
              best = s;
              bestCluster = c;
            }
          }
          if (bestCluster !== assignment[i] || iterations === 1) changes += 1;
          assignment[i] = bestCluster;
        }
      }
      const sizes = recompute();
      if (!sims) {
        // Re-seed empty clusters with the point farthest from its centroid.
        for (let c = 0; c < k; c += 1) {
          if (sizes[c] !== 0) continue;
          let worst = -1;
          let worstCos = Infinity;
          for (let i = 0; i < n; i += 1) {
            const from = assignment[i] as number;
            if ((sizes[from] as number) <= 1) continue;
            const cos = dotAt(data, (rows[i] as number) * dim, centers, from * dim, dim);
            if (cos < worstCos) {
              worstCos = cos;
              worst = i;
            }
          }
          if (worst < 0) continue;
          const from = assignment[worst] as number;
          sizes[from] = (sizes[from] as number) - 1;
          sizes[c] = 1;
          assignment[worst] = c;
          const offset = (rows[worst] as number) * dim;
          centers.set(data.subarray(offset, offset + dim), c * dim);
          changes += 1;
        }
      }
      if (iterations > 1 && changes <= tolerance * n) break;
    }
    iterations = Math.min(iterations, maxIterations);
  }

  const sizes = new Array<number>(k).fill(0);
  let cosSum = 0;
  let weightSum = 0;
  for (let i = 0; i < n; i += 1) {
    const c = assignment[i] as number;
    sizes[c] = (sizes[c] as number) + 1;
    const w = weightOf(weights, i);
    cosSum += w * dotAt(data, (rows[i] as number) * dim, centers, c * dim, dim);
    weightSum += w;
  }
  return {
    k,
    assignments: assignment,
    centroids: Array.from({ length: k }, (_, c) => centers.slice(c * dim, (c + 1) * dim)),
    sizes,
    iterations,
    meanCosine: weightSum > 0 ? cosSum / weightSum : 0
  };
}

/** Groups local indices by cluster, dropping empty clusters. */
export function groupsOf(result: KMeansResult, rows: ArrayLike<number>): number[][] {
  const groups: number[][] = Array.from({ length: result.k }, () => []);
  for (let i = 0; i < rows.length; i += 1) {
    groups[result.assignments[i] as number]?.push(rows[i] as number);
  }
  return groups.filter((group) => group.length > 0);
}
