// Synthetic hierarchical Gaussian clusters on the unit sphere for self-checks.
import { createRng } from "./rng.js";
import { createMatrix, normalizeRows } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface SyntheticOptions {
  groups: number;
  clustersPerGroup: number;
  pointsPerCluster: number;
  dim: number;
  /** Cluster-center offset from its group center (relative to a unit vector). */
  groupSpread: number;
  /** Point offset from its cluster center (relative to a unit vector). */
  pointNoise: number;
  seed: number;
}

export interface SyntheticData {
  matrix: EmbeddingMatrix;
  /** Cluster label per row. */
  clusters: Int32Array;
  /** Group label per row. */
  groups: Int32Array;
}

export const defaultSyntheticOptions: SyntheticOptions = {
  groups: 8,
  clustersPerGroup: 5,
  pointsPerCluster: 50,
  dim: 64,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 7
};

export function gaussianClusters(
  options: SyntheticOptions = defaultSyntheticOptions
): SyntheticData {
  const { groups, clustersPerGroup, pointsPerCluster, dim, seed } = options;
  const rng = createRng(seed);
  const randomUnit = (): Float64Array => {
    const vector = new Float64Array(dim);
    let sum = 0;
    for (let k = 0; k < dim; k += 1) {
      const value = rng.gaussian();
      vector[k] = value;
      sum += value * value;
    }
    const scale = 1 / Math.sqrt(sum);
    for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) * scale;
    return vector;
  };
  /** normalize(center + scale * random unit direction) */
  const offset = (center: Float64Array, scale: number): Float64Array => {
    const noise = randomUnit();
    const output = new Float64Array(dim);
    let sum = 0;
    for (let k = 0; k < dim; k += 1) {
      const value = (center[k] as number) + scale * (noise[k] as number);
      output[k] = value;
      sum += value * value;
    }
    const length = Math.sqrt(sum);
    for (let k = 0; k < dim; k += 1) output[k] = (output[k] as number) / length;
    return output;
  };

  const count = groups * clustersPerGroup * pointsPerCluster;
  const matrix = createMatrix(count, dim);
  const clusterLabels = new Int32Array(count);
  const groupLabels = new Int32Array(count);
  let row = 0;
  for (let g = 0; g < groups; g += 1) {
    const groupCenter = randomUnit();
    for (let c = 0; c < clustersPerGroup; c += 1) {
      const clusterCenter = offset(groupCenter, options.groupSpread);
      for (let p = 0; p < pointsPerCluster; p += 1) {
        const point = offset(clusterCenter, options.pointNoise);
        for (let k = 0; k < dim; k += 1) matrix.data[row * dim + k] = point[k] as number;
        clusterLabels[row] = g * clustersPerGroup + c;
        groupLabels[row] = g;
        row += 1;
      }
    }
  }
  normalizeRows(matrix);
  return { matrix, clusters: clusterLabels, groups: groupLabels };
}
