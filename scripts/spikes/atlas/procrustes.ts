// Procrustes disparity of two 2-D point sets (the number scipy.spatial.procrustes returns): both are
// centred and scaled to unit Frobenius norm, one is fitted onto the other by the best orthogonal map
// (rotation or reflection) and the residual sum of squares is the disparity, in [0, 1]. 0 means the
// two maps are the same shape up to rotation, reflection, scale and translation.

function standardise(points: Float64Array): Float64Array {
  const n = points.length / 2;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += points[2 * i] as number;
    my += points[2 * i + 1] as number;
  }
  mx /= n;
  my /= n;
  const out = new Float64Array(points.length);
  let norm = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (points[2 * i] as number) - mx;
    const y = (points[2 * i + 1] as number) - my;
    out[2 * i] = x;
    out[2 * i + 1] = y;
    norm += x * x + y * y;
  }
  const scale = Math.sqrt(norm);
  if (scale === 0) throw new Error("A map with every point in one place has no shape.");
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) / scale;
  return out;
}

export function procrustesDisparity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length || a.length % 2 !== 0 || a.length < 4)
    throw new Error("Procrustes needs two maps of the same size with at least two points.");
  const x = standardise(a);
  const y = standardise(b);
  // M = X^T Y (2 x 2). For a 2 x 2 matrix the sum of the singular values is
  // sqrt(||M||_F^2 + 2 |det M|), and the residual is 1 - (sum of singular values)^2.
  let m00 = 0;
  let m01 = 0;
  let m10 = 0;
  let m11 = 0;
  for (let i = 0; i < x.length; i += 2) {
    const x0 = x[i] as number;
    const x1 = x[i + 1] as number;
    const y0 = y[i] as number;
    const y1 = y[i + 1] as number;
    m00 += x0 * y0;
    m01 += x0 * y1;
    m10 += x1 * y0;
    m11 += x1 * y1;
  }
  const frobenius = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11;
  const determinant = m00 * m11 - m01 * m10;
  const nuclear = Math.sqrt(frobenius + 2 * Math.abs(determinant));
  return Math.min(1, Math.max(0, 1 - nuclear * nuclear));
}

/** The largest disparity over every pair of maps (the statistic of the go criterion). */
export function maxPairwiseDisparity(maps: readonly Float64Array[]): {
  max: number;
  pairs: { a: number; b: number; disparity: number }[];
} {
  const pairs: { a: number; b: number; disparity: number }[] = [];
  for (let a = 0; a < maps.length; a += 1)
    for (let b = a + 1; b < maps.length; b += 1)
      pairs.push({ a, b, disparity: procrustesDisparity(maps[a]!, maps[b]!) });
  return {
    max: pairs.length === 0 ? Number.NaN : Math.max(...pairs.map((p) => p.disparity)),
    pairs
  };
}
