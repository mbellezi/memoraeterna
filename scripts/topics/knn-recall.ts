// IVF recall@k against exact kNN (spec section 5, T09: "IVF recall@10 against exact kNN on 3k and
// 6k samples, target >= 0.90; retune nprobe otherwise and record it"). Above `knn.exactLimit`
// rows the builders use an inverted-file approximation (`knnGraph`); every large-scale number of
// Spike B rests on it, and its recall was never measured.
//
// Two measurements:
// - subset: a seeded sample of `sampleSize` rows; the IVF and the exact graph are both built over
//   that sample (the T09 proof; IVF quality depends on the list size, so this is optimistic for
//   the full corpus, whose lists probe a smaller share of the points);
// - queries: the IVF graph over ALL rows against exact neighbours of `queries` sampled rows
//   scanned over all rows (the production setting; the gate A figure).
import {
  createRng,
  deriveSeed,
  dotAt,
  exactKnnGraph,
  knnGraph,
  knnRecall
} from "@app/domain/topic-tree";
import type { EmbeddingMatrix } from "@app/domain/topic-tree";

export interface KnnRecallPoint {
  nprobe: number;
  /** Mean share of the exact top-k neighbours the IVF lists contain. */
  recall: number;
  /** Lists the IVF index holds (sqrt(rows)). */
  lists: number;
  ivfMs: number;
}

export interface SubsetRecall {
  mode: "subset";
  sample: number;
  k: number;
  exactMs: number;
  points: KnnRecallPoint[];
}

export interface QueryRecall {
  mode: "queries";
  rows: number;
  queries: number;
  k: number;
  exactMs: number;
  /** Lowest per-query recall (a floor for the worst-served query). */
  minRecall: number;
  point: KnnRecallPoint;
}

/** `count` distinct rows of `[0, total)`, seeded, in ascending order. */
export function sampleRows(total: number, count: number, seed: number, label: string): number[] {
  const rows = Array.from({ length: total }, (_, row) => row);
  return createRng(deriveSeed(seed, label))
    .shuffle(rows)
    .slice(0, Math.min(count, total))
    .sort((a, b) => a - b);
}

function listCount(rows: number): number {
  return Math.max(2, Math.round(Math.sqrt(rows)));
}

export function measureSubsetRecall(
  matrix: EmbeddingMatrix,
  options: { sampleSize: number; nprobes: readonly number[]; k?: number; seed: number }
): SubsetRecall {
  const k = options.k ?? 10;
  const rows = sampleRows(
    matrix.count,
    options.sampleSize,
    options.seed,
    `knn-subset:${options.sampleSize}`
  );
  let started = performance.now();
  const exact = exactKnnGraph(matrix, rows, k);
  const exactMs = performance.now() - started;
  const points: KnnRecallPoint[] = [];
  for (const nprobe of options.nprobes) {
    started = performance.now();
    // exactLimit 0 forces the IVF path even for a small sample.
    const ivf = knnGraph(matrix, rows, k, { seed: options.seed, exactLimit: 0, nprobe });
    const ivfMs = performance.now() - started;
    points.push({ nprobe, recall: knnRecall(ivf, exact), lists: listCount(rows.length), ivfMs });
  }
  return { mode: "subset", sample: rows.length, k, exactMs, points };
}

/** Exact top-k neighbour set of one row over `rows` (ties keep the earlier local index). */
function exactNeighbors(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  self: number,
  k: number
): number[] {
  const { dim, data } = matrix;
  const offset = (rows[self] as number) * dim;
  const best: { index: number; sim: number }[] = [];
  for (let j = 0; j < rows.length; j += 1) {
    if (j === self) continue;
    const sim = dotAt(data, offset, data, (rows[j] as number) * dim, dim);
    if (best.length === k && sim <= (best[k - 1] as { sim: number }).sim) continue;
    let at = best.length;
    while (at > 0 && (best[at - 1] as { sim: number }).sim < sim) at -= 1;
    best.splice(at, 0, { index: j, sim });
    if (best.length > k) best.pop();
  }
  return best.map((entry) => entry.index);
}

/** Production-setting recall: the IVF graph over all rows against exact scans for sampled rows. */
export function measureQueryRecall(
  matrix: EmbeddingMatrix,
  options: { queries: number; nprobe: number; k?: number; seed: number }
): QueryRecall {
  const k = options.k ?? 10;
  const rows = Array.from({ length: matrix.count }, (_, row) => row);
  let started = performance.now();
  const ivf = knnGraph(matrix, rows, k, {
    seed: options.seed,
    exactLimit: 0,
    nprobe: options.nprobe
  });
  const ivfMs = performance.now() - started;
  const queries = sampleRows(matrix.count, options.queries, options.seed, "knn-queries");
  started = performance.now();
  let found = 0;
  let total = 0;
  let minRecall = 1;
  for (const query of queries) {
    const truth = exactNeighbors(matrix, rows, query, k);
    const listed = new Set<number>();
    for (let slot = 0; slot < k; slot += 1) {
      const neighbor = ivf.neighbors[query * k + slot] as number;
      if (neighbor >= 0) listed.add(neighbor);
    }
    const hits = truth.filter((neighbor) => listed.has(neighbor)).length;
    found += hits;
    total += truth.length;
    if (truth.length > 0) minRecall = Math.min(minRecall, hits / truth.length);
  }
  const exactMs = performance.now() - started;
  return {
    mode: "queries",
    rows: matrix.count,
    queries: queries.length,
    k,
    exactMs,
    minRecall,
    point: {
      nprobe: options.nprobe,
      recall: total > 0 ? found / total : 1,
      lists: listCount(matrix.count),
      ivfMs
    }
  };
}

/** The smallest probed nprobe whose recall reaches `target`, or null when none does. */
export function smallestNprobeReaching(
  points: readonly KnnRecallPoint[],
  target = 0.9
): number | null {
  const reaching = points.filter((point) => point.recall >= target).map((point) => point.nprobe);
  return reaching.length > 0 ? Math.min(...reaching) : null;
}
