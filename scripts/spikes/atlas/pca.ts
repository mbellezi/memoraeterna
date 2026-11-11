// A two-component PCA by power iteration with deflation over a row-major Float32 matrix, so no
// covariance matrix of dim x dim is built. Deterministic for a seed. The linear baseline the UMAP
// map is compared with.
import { createRng } from "@app/domain/topic-tree";
import type { EmbeddingMatrix } from "@app/domain/topic-tree";

export interface Pca2d {
  /** n x 2, row-major. */
  points: Float64Array;
  /** Share of the total variance each component keeps. */
  explained: [number, number];
}

function multiplyCovariance(
  matrix: EmbeddingMatrix,
  mean: Float64Array,
  vector: Float64Array,
  scratch: Float64Array,
  out: Float64Array
): void {
  const { dim, count, data } = matrix;
  const offsetDot = (() => {
    let sum = 0;
    for (let k = 0; k < dim; k += 1) sum += (mean[k] as number) * (vector[k] as number);
    return sum;
  })();
  out.fill(0);
  for (let row = 0; row < count; row += 1) {
    const base = row * dim;
    let projection = -offsetDot;
    for (let k = 0; k < dim; k += 1)
      projection += (data[base + k] as number) * (vector[k] as number);
    scratch[row] = projection;
    for (let k = 0; k < dim; k += 1)
      out[k] = (out[k] as number) + projection * (data[base + k] as number);
  }
  // Subtract the mean's part of X^T p: sum(p) * mean.
  let sumP = 0;
  for (let row = 0; row < count; row += 1) sumP += scratch[row] as number;
  for (let k = 0; k < dim; k += 1)
    out[k] = ((out[k] as number) - sumP * (mean[k] as number)) / count;
}

export function pca2d(matrix: EmbeddingMatrix, seed = 1): Pca2d {
  const { dim, count, data } = matrix;
  if (count < 3) throw new Error("PCA needs at least three rows.");
  const mean = new Float64Array(dim);
  for (let row = 0; row < count; row += 1)
    for (let k = 0; k < dim; k += 1)
      mean[k] = (mean[k] as number) + (data[row * dim + k] as number);
  for (let k = 0; k < dim; k += 1) mean[k] = (mean[k] as number) / count;
  let totalVariance = 0;
  for (let row = 0; row < count; row += 1)
    for (let k = 0; k < dim; k += 1) {
      const centred = (data[row * dim + k] as number) - (mean[k] as number);
      totalVariance += centred * centred;
    }
  totalVariance /= count;

  const rng = createRng(seed);
  const scratch = new Float64Array(count);
  const components: Float64Array[] = [];
  const eigenvalues: number[] = [];
  for (let component = 0; component < 2; component += 1) {
    let vector = new Float64Array(dim).map(() => rng.gaussian());
    const next = new Float64Array(dim);
    let eigenvalue = 0;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      multiplyCovariance(matrix, mean, vector, scratch, next);
      for (const earlier of components) {
        let overlap = 0;
        for (let k = 0; k < dim; k += 1) overlap += (next[k] as number) * (earlier[k] as number);
        for (let k = 0; k < dim; k += 1)
          next[k] = (next[k] as number) - overlap * (earlier[k] as number);
      }
      let norm = 0;
      for (let k = 0; k < dim; k += 1) norm += (next[k] as number) ** 2;
      norm = Math.sqrt(norm);
      if (norm === 0) break;
      const updated = new Float64Array(dim).map((_, k) => (next[k] as number) / norm);
      let change = 0;
      for (let k = 0; k < dim; k += 1)
        change += Math.abs((updated[k] as number) - (vector[k] as number));
      vector = updated;
      eigenvalue = norm;
      if (change < 1e-9) break;
    }
    components.push(vector);
    eigenvalues.push(eigenvalue);
  }
  const points = new Float64Array(count * 2);
  for (let row = 0; row < count; row += 1)
    for (let c = 0; c < 2; c += 1) {
      const vector = components[c]!;
      let projection = 0;
      for (let k = 0; k < dim; k += 1)
        projection +=
          ((data[row * dim + k] as number) - (mean[k] as number)) * (vector[k] as number);
      points[row * 2 + c] = projection;
    }
  return {
    points,
    explained: [
      totalVariance === 0 ? 0 : (eigenvalues[0] as number) / totalVariance,
      totalVariance === 0 ? 0 : (eigenvalues[1] as number) / totalVariance
    ]
  };
}
