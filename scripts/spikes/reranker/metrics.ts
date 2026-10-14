/**
 * Pure metric helpers for Spike A (reranker go/no-go). No I/O; covered by `selfcheck.ts`.
 *
 * Conventions: higher score = more related. A root pair that no candidate row links ("not
 * retrieved") scores `-Infinity`, which ranks below every real score and never passes a threshold.
 */

export type Label = "expected" | "forbidden";

/** Canonical undirected root-pair key, identical to the matching benchmark's `pair()`. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("/");
}

function compare(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ranks (1-based) with ties sharing their average rank. */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((_, index) => index).sort((i, j) => compare(values[i]!, values[j]!));
  const result = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && values[order[end + 1]!] === values[order[start]!]) end += 1;
    const average = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) result[order[k]!] = average;
    start = end + 1;
  }
  return result;
}

/** Area under the ROC curve (Mann-Whitney U with tie correction). Null when a class is empty. */
export function auc(positives: readonly number[], negatives: readonly number[]): number | null {
  if (positives.length === 0 || negatives.length === 0) return null;
  const all = [...positives, ...negatives];
  const allRanks = ranks(all);
  let positiveRankSum = 0;
  for (let index = 0; index < positives.length; index += 1) positiveRankSum += allRanks[index]!;
  const n = positives.length;
  return (positiveRankSum - (n * (n + 1)) / 2) / (n * negatives.length);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

export function pearson(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index]! - mx;
    const dy = y[index]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(x: readonly number[], y: readonly number[]): number {
  return pearson(ranks(x), ranks(y));
}

/** Linear-interpolation percentile, `q` in [0, 1]. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort(compare);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export function logit(probability: number, epsilon = 1e-7): number {
  const p = Math.min(1 - epsilon, Math.max(epsilon, probability));
  return Math.log(p / (1 - p));
}

/** Deterministic PRNG (mulberry32) for bootstrap resampling. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RootRow {
  rootA: string;
  rootB: string;
  score: number;
}

/** Max score per undirected root pair; rows inside one root are ignored. */
export function rootPairScores(rows: readonly RootRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.rootA === row.rootB) continue;
    const key = pairKey(row.rootA, row.rootB);
    const current = result.get(key);
    if (current === undefined || row.score > current) result.set(key, row.score);
  }
  return result;
}

export interface LabelledScores {
  expected: number[];
  forbidden: number[];
}

/** Score of each labelled root pair; `-Infinity` when no candidate row linked the pair. */
export function labelledScores(
  scores: ReadonlyMap<string, number>,
  expected: readonly string[],
  forbidden: readonly string[]
): LabelledScores {
  const lookup = (key: string): number => scores.get(key) ?? Number.NEGATIVE_INFINITY;
  return { expected: expected.map(lookup), forbidden: forbidden.map(lookup) };
}

export interface ThresholdChoice {
  threshold: number;
  /** Largest forbidden-pair score on the tuning split (-Infinity when none was retrieved). */
  maxForbidden: number;
  /** Lowest expected-pair score above `maxForbidden` (the upper end of the optimal plateau). */
  lowestExpectedAbove: number;
  /** Expected pairs found on the tuning split at `threshold`. */
  expectedFound: number;
}

/**
 * Threshold that keeps zero forbidden root pairs and finds the most expected ones on the tuning
 * split. Coverage is a step function of the threshold, so the optimum is the whole plateau
 * (maxForbidden, lowestExpectedAbove]; the midpoint gives equal margin on both sides.
 */
export function chooseThreshold(tuning: LabelledScores): ThresholdChoice | null {
  const maxForbidden = tuning.forbidden.length
    ? Math.max(...tuning.forbidden)
    : Number.NEGATIVE_INFINITY;
  const above = tuning.expected.filter((score) => score > maxForbidden);
  if (above.length === 0) return null;
  const lowestExpectedAbove = Math.min(...above);
  const threshold = Number.isFinite(maxForbidden)
    ? (maxForbidden + lowestExpectedAbove) / 2
    : lowestExpectedAbove;
  return {
    threshold,
    maxForbidden,
    lowestExpectedAbove,
    expectedFound: tuning.expected.filter((score) => score >= threshold).length
  };
}

export interface RootOutcome {
  expectedFound: number;
  expectedTotal: number;
  forbiddenFound: number;
  forbiddenTotal: number;
  /** Expected pairs with at least one candidate row at all (the retrieval ceiling). */
  expectedRetrieved: number;
}

export function rootOutcome(scores: LabelledScores, threshold: number): RootOutcome {
  return {
    expectedFound: scores.expected.filter((score) => score >= threshold).length,
    expectedTotal: scores.expected.length,
    forbiddenFound: scores.forbidden.filter((score) => score >= threshold).length,
    forbiddenTotal: scores.forbidden.length,
    expectedRetrieved: scores.expected.filter((score) => score > Number.NEGATIVE_INFINITY).length
  };
}
