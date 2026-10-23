/**
 * The pure half of `candidates-bench.ts` (F4 T79, C3): percentiles of the timed runs and the
 * comparison of two candidate lists, which must agree to 1e-9 on every signal.
 */

export interface Distribution {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** The nearest-rank percentile (`p` in 0..100) of the values, in the unit they come in. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(values: readonly number[]): Distribution {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : Number.NaN,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : Number.NaN,
    mean: values.length ? sum / values.length : Number.NaN
  };
}

export const signals = ["text", "title", "concept", "note", "entity", "relation"] as const;
/** What the statement returns for a passage besides its signals; these must be equal, not close. */
const exactFields = [
  "rootId",
  "chunkId",
  "sourceItemId",
  "documentId",
  "sourceSpanId",
  "contentHash",
  "excerpt",
  "sourceTitle",
  "chunkIndex",
  "documentCreatedAt",
  "locator",
  "total"
] as const;

export type CandidateRow = Record<string, unknown>;

export interface RowDifference {
  position: number;
  field: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Compares the rows of two runs of the statement, in order: the same passages in the same
 * positions, every exact field equal, every signal within `tolerance`. Returns what differs (the
 * first `limit` differences), or an empty list when the results are identical.
 */
export function compareCandidates(
  expected: readonly CandidateRow[],
  actual: readonly CandidateRow[],
  tolerance = 1e-9,
  limit = 20
): RowDifference[] {
  const differences: RowDifference[] = [];
  const add = (difference: RowDifference) => {
    if (differences.length < limit) differences.push(difference);
  };
  if (expected.length !== actual.length)
    add({ position: -1, field: "length", expected: expected.length, actual: actual.length });
  for (let position = 0; position < Math.min(expected.length, actual.length); position += 1) {
    const [a, b] = [expected[position]!, actual[position]!];
    for (const field of exactFields)
      if (!Object.is(a[field], b[field]) && String(a[field]) !== String(b[field]))
        add({ position, field, expected: a[field], actual: b[field] });
    for (const field of signals) {
      const [x, y] = [Number(a[field]), Number(b[field])];
      if (!(Math.abs(x - y) <= tolerance) && !(Number.isNaN(x) && Number.isNaN(y)))
        add({ position, field, expected: a[field], actual: b[field] });
    }
  }
  return differences;
}

/** Largest difference of any signal between two runs that agree on the passages (for the report). */
export function largestSignalDifference(
  expected: readonly CandidateRow[],
  actual: readonly CandidateRow[]
): number {
  let largest = 0;
  for (let position = 0; position < Math.min(expected.length, actual.length); position += 1)
    for (const field of signals)
      largest = Math.max(
        largest,
        Math.abs(Number(expected[position]![field]) - Number(actual[position]![field])) || 0
      );
  return largest;
}
