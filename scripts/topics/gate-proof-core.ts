// The measurements of the gate proof (T23, D19): pure, so the arithmetic is tested apart from
// the ranker run in gate-proof.ts.

/** Nearest-rank percentile of `values` (0 for none). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}

/** One held-out note the frozen tree gated. */
export interface GatedNote {
  domain: string;
  /** Majority domain of the best admitted leaf (the margin-only placement). */
  bestDomain: string | null;
  /** Majority domain of the leaf the gate accepted; null for "none of these". */
  chosenDomain: string | null;
  /** Majority domain of the ranker's highest-scored candidate, whatever the D10 rule says. */
  topDomain: string | null;
  /** Wall time of a fresh rank call; null when the scores came from the gate-score cache. */
  rankMs: number | null;
  /** Documents the ranker cut to fit its sequence bound. */
  truncated: number;
}

export interface SplitCounts {
  holdout: number;
  auto: number;
  autoCorrect: number;
  unadmitted: number;
  /** Every gated held-out note; `gated` may hold fewer (`--limit`). */
  gatedTotal: number;
  gated: readonly GatedNote[];
}

const share = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

export interface SplitSummary {
  holdout: number;
  gatedShare: number | null;
  unadmittedShare: number | null;
  autoPrecision: number | null;
  gate: {
    gated: number;
    accepted: number;
    none: number;
    noneShare: number | null;
    /** Accepted leaves whose majority domain is the note's. */
    precision: number | null;
    /** The margin-only baseline: the best admitted leaf of every gated note. */
    baselinePrecision: number | null;
    /** The baseline on the notes the gate accepted (same items as `precision`). */
    baselinePrecisionOnAccepted: number | null;
    /** "None" where the baseline leaf was wrong (a none that avoided a misplacement). */
    noneAvoidedError: number | null;
    /** The ranker's best candidate on every gated note (its ranking signal before the rule). */
    rankerTop1Precision: number | null;
    /** Gated notes placed correctly: accepted and right, out of all gated. */
    correctShare: number | null;
    baselineCorrectShare: number | null;
    truncatedDocuments: number;
  };
  latency: { calls: number; p50Ms: number; p95Ms: number; maxMs: number };
}

export function summarizeSplit(counts: SplitCounts): SplitSummary {
  const gated = counts.gated;
  const accepted = gated.filter((note) => note.chosenDomain !== null);
  const none = gated.filter((note) => note.chosenDomain === null);
  const right = (domain: string | null, note: GatedNote) =>
    domain !== null && domain === note.domain;
  const calls = gated.flatMap((note) => (note.rankMs === null ? [] : [note.rankMs]));
  return {
    holdout: counts.holdout,
    gatedShare: share(counts.gatedTotal, counts.holdout),
    unadmittedShare: share(counts.unadmitted, counts.holdout),
    autoPrecision: share(counts.autoCorrect, counts.auto),
    gate: {
      gated: gated.length,
      accepted: accepted.length,
      none: none.length,
      noneShare: share(none.length, gated.length),
      precision: share(
        accepted.filter((note) => right(note.chosenDomain, note)).length,
        accepted.length
      ),
      baselinePrecision: share(
        gated.filter((note) => right(note.bestDomain, note)).length,
        gated.length
      ),
      baselinePrecisionOnAccepted: share(
        accepted.filter((note) => right(note.bestDomain, note)).length,
        accepted.length
      ),
      noneAvoidedError: share(
        none.filter((note) => !right(note.bestDomain, note)).length,
        none.length
      ),
      correctShare: share(
        accepted.filter((note) => right(note.chosenDomain, note)).length,
        gated.length
      ),
      baselineCorrectShare: share(
        gated.filter((note) => right(note.bestDomain, note)).length,
        gated.length
      ),
      rankerTop1Precision: share(
        gated.filter((note) => right(note.topDomain, note)).length,
        gated.length
      ),
      truncatedDocuments: gated.reduce((sum, note) => sum + note.truncated, 0)
    },
    latency: {
      calls: calls.length,
      p50Ms: Math.round(percentile(calls, 50) * 10) / 10,
      p95Ms: Math.round(percentile(calls, 95) * 10) / 10,
      maxMs: Math.round(percentile(calls, 100) * 10) / 10
    }
  };
}

/** The most frequent value (ties: the first in code-unit order), or null for none. */
export function majority(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
