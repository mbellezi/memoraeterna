// Dense embedding matrix helpers over Float32Array (row-major, unit rows). Sums of vectors
// (topic LS statistics) are kept in Float64Array so add/subtract stays exact enough (D7).
import { rowOfItemKey } from "./ids.js";

export interface EmbeddingMatrix {
  readonly dim: number;
  readonly count: number;
  readonly data: Float32Array;
}

/**
 * Where the engine reads item vectors: one matrix plus the row of each item key. A key with no
 * row has no current vector (missing or stale); it keeps its placement but stays out of the
 * statistics until its vector exists (D7).
 */
export interface ItemVectorSource {
  readonly matrix: EmbeddingMatrix;
  rowOf(item: string): number | undefined;
}

export function createMatrix(count: number, dim: number): EmbeddingMatrix {
  return { dim, count, data: new Float32Array(count * dim) };
}

/** Builds a matrix from rows; rows are L2-normalized unless `normalize` is false. */
export function matrixFromRows(
  rows: readonly ArrayLike<number>[],
  normalize = true
): EmbeddingMatrix {
  const dim = rows[0]?.length ?? 0;
  const matrix = createMatrix(rows.length, dim);
  rows.forEach((row, index) => {
    if (row.length !== dim) throw new Error(`Row ${index} has ${row.length} dims, expected ${dim}`);
    matrix.data.set(row, index * dim);
  });
  if (normalize) normalizeRows(matrix);
  return matrix;
}

export function normalizeRows(matrix: EmbeddingMatrix): void {
  const { dim, data } = matrix;
  for (let row = 0; row < matrix.count; row += 1) {
    const offset = row * dim;
    let sum = 0;
    for (let k = 0; k < dim; k += 1) {
      const value = data[offset + k] as number;
      sum += value * value;
    }
    const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    for (let k = 0; k < dim; k += 1) data[offset + k] = (data[offset + k] as number) * scale;
  }
}

/**
 * Largest |1 - |row|| over the rows, or Infinity when a value is not finite. Callers that
 * receive vectors across a boundary use it to reject non-unit or corrupt rows.
 */
export function maxUnitDeviation(matrix: EmbeddingMatrix): number {
  const { dim, data } = matrix;
  let worst = 0;
  for (let row = 0; row < matrix.count; row += 1) {
    let sum = 0;
    for (let k = 0; k < dim; k += 1) {
      const value = data[row * dim + k] as number;
      if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
      sum += value * value;
    }
    worst = Math.max(worst, Math.abs(1 - Math.sqrt(sum)));
  }
  return worst;
}

export function rowView(matrix: EmbeddingMatrix, row: number): Float32Array {
  return matrix.data.subarray(row * matrix.dim, (row + 1) * matrix.dim);
}

/** Dot product of a[aOffset..] and b[bOffset..] over `dim` values. */
export function dotAt(
  a: Float32Array | Float64Array,
  aOffset: number,
  b: Float32Array | Float64Array,
  bOffset: number,
  dim: number
): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let k = 0;
  for (; k + 3 < dim; k += 4) {
    s0 += (a[aOffset + k] as number) * (b[bOffset + k] as number);
    s1 += (a[aOffset + k + 1] as number) * (b[bOffset + k + 1] as number);
    s2 += (a[aOffset + k + 2] as number) * (b[bOffset + k + 2] as number);
    s3 += (a[aOffset + k + 3] as number) * (b[bOffset + k + 3] as number);
  }
  for (; k < dim; k += 1) s0 += (a[aOffset + k] as number) * (b[bOffset + k] as number);
  return s0 + s1 + s2 + s3;
}

export function dot(a: Float32Array | Float64Array, b: Float32Array | Float64Array): number {
  return dotAt(a, 0, b, 0, a.length);
}

export function dotRowVec(
  matrix: EmbeddingMatrix,
  row: number,
  vector: Float32Array | Float64Array
): number {
  return dotAt(matrix.data, row * matrix.dim, vector, 0, matrix.dim);
}

export function dotRows(matrix: EmbeddingMatrix, a: number, b: number): number {
  return dotAt(matrix.data, a * matrix.dim, matrix.data, b * matrix.dim, matrix.dim);
}

export function norm(vector: Float32Array | Float64Array): number {
  return Math.sqrt(dot(vector, vector));
}

/** target += scale * row */
export function addRow(
  target: Float32Array | Float64Array,
  matrix: EmbeddingMatrix,
  row: number,
  scale = 1
): void {
  const offset = row * matrix.dim;
  for (let k = 0; k < matrix.dim; k += 1) {
    target[k] = (target[k] as number) + scale * (matrix.data[offset + k] as number);
  }
}

/** target += scale * source */
export function addVec(
  target: Float32Array | Float64Array,
  source: Float32Array | Float64Array,
  scale = 1
): void {
  for (let k = 0; k < target.length; k += 1) {
    target[k] = (target[k] as number) + scale * (source[k] as number);
  }
}

/** Unit-length Float32 copy; a zero vector stays zero. */
export function unit(vector: Float32Array | Float64Array): Float32Array {
  const length = norm(vector);
  const output = new Float32Array(vector.length);
  if (length === 0) return output;
  for (let k = 0; k < vector.length; k += 1) output[k] = (vector[k] as number) / length;
  return output;
}

export function sumRows(matrix: EmbeddingMatrix, rows: ArrayLike<number>): Float64Array {
  const sum = new Float64Array(matrix.dim);
  for (let index = 0; index < rows.length; index += 1) addRow(sum, matrix, rows[index] as number);
  return sum;
}

/** Copies the selected rows into a new matrix (row i of the result = rows[i]). */
export function subMatrix(matrix: EmbeddingMatrix, rows: ArrayLike<number>): EmbeddingMatrix {
  const output = createMatrix(rows.length, matrix.dim);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as number;
    output.data.set(
      matrix.data.subarray(row * matrix.dim, (row + 1) * matrix.dim),
      index * matrix.dim
    );
  }
  return output;
}

/** Item vectors of a batch build: key `row:<n>` is matrix row n. */
export function rowVectors(matrix: EmbeddingMatrix): ItemVectorSource {
  return {
    matrix,
    rowOf: (item) => {
      const row = rowOfItemKey(item);
      return row !== undefined && row < matrix.count ? row : undefined;
    }
  };
}

/** Item vectors keyed by explicit keys (key i is row i). */
export function keyedVectors(matrix: EmbeddingMatrix, keys: readonly string[]): ItemVectorSource {
  if (keys.length !== matrix.count) {
    throw new Error(`Expected ${matrix.count} keys, got ${keys.length}`);
  }
  const rows = new Map<string, number>();
  keys.forEach((key, row) => {
    if (rows.has(key)) throw new Error(`Duplicate item key ${key}`);
    rows.set(key, row);
  });
  return { matrix, rowOf: (item) => rows.get(item) };
}
