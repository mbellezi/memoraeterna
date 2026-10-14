/** Descriptive statistics for the KPI report. All functions are pure. */

export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  readonly sum: number;
}

/** Linear-interpolation percentile of an ascending array (same method as SQL `percentile_cont`). */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  if (!(fraction >= 0 && fraction <= 1)) throw new RangeError("fraction must be in [0, 1]");
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

/** Summarizes finite numbers; null when there are none. Non-finite values are ignored. */
export function summarize(values: Iterable<number | null | undefined>): Distribution | null {
  const sorted: number[] = [];
  for (const value of values)
    if (typeof value === "number" && Number.isFinite(value)) sorted.push(value);
  if (sorted.length === 0) return null;
  sorted.sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: sorted[0] as number,
    p50: percentile(sorted, 0.5) as number,
    p95: percentile(sorted, 0.95) as number,
    max: sorted[sorted.length - 1] as number,
    mean: sum / sorted.length,
    sum
  };
}

/** Converts a millisecond distribution to seconds. */
export function toSeconds(distribution: Distribution | null): Distribution | null {
  if (!distribution) return null;
  return {
    n: distribution.n,
    min: distribution.min / 1000,
    p50: distribution.p50 / 1000,
    p95: distribution.p95 / 1000,
    max: distribution.max / 1000,
    mean: distribution.mean / 1000,
    sum: distribution.sum / 1000
  };
}

/** Counts items by a string key; items whose key is null or empty are counted under `unknown`. */
export function tally<T>(
  items: Iterable<T>,
  key: (item: T) => string | null | undefined
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = key(item) || "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** Share in [0, 1], or null when the denominator is zero (unknown stays unknown). */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Sums the numbers that are present; `reported` counts how many values were present. */
export function sumReported(values: Iterable<number | null | undefined>): {
  sum: number;
  reported: number;
} {
  let sum = 0;
  let reported = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      reported += 1;
    }
  }
  return { sum, reported };
}
