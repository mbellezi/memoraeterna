/**
 * B1 (F3 T46a, spec 3.0 and 5.4 step 4): milliseconds per directed pair when a ranker scores a call of
 * 16, 32 or 48 pairs, which fixes `rankPairsPerCall`, the helper batch and t_pair of the gate-0
 * throughput forecast. Each call is one `pairs` request as the product's `rankPairs` would send it; the
 * pairs are a seeded draw from a profile's own candidate pairs (real note text, about 300 tokens a
 * pair), the same draw for every combination, repeated, with the combinations interleaved so that a
 * drift of the host load touches all of them alike. The first call (the model load) is reported apart.
 */
import { mean, percentile, seededRandom } from "../spikes/reranker/metrics.ts";
import type { PairText } from "../spikes/reranker/runtimes.ts";
import type { PairScorer } from "./pair-scoring.ts";

/** The P0 budget of decision D16: a bounded local call takes at most this long. */
export const p0BudgetMs = 1_000;

export interface B1Options {
  /** Pairs per call (`rankPairsPerCall`). */
  callSizes: readonly number[];
  /** Helper batch sizes tried inside a call, each at most the call size; ignored when not batched. */
  helperBatches: readonly number[];
  /** MLX batches pairs inside a call; GGUF ranks them one after another. */
  batched: boolean;
  repeats: number;
  callsPerRepeat: number;
  seed: number;
  onCall?: (done: number, total: number) => void;
}

export interface Stats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface B1Combination {
  callSize: number;
  helperBatch: number | null;
  calls: number;
  /** Wall time of a call as the caller sees it, IPC included. */
  callMs: Stats;
  /** callMs divided by the pairs of the call. */
  msPerPair: Stats;
  /** MLX only: forward-pass time per pair as the helper reports it. */
  inferenceMsPerPair: number | null;
  meanTokensPerPair: number | null;
  /** Calls longer than the P0 budget. */
  callsOverBudget: number;
  /** The mean call fits the P0 budget / the p95 call does. */
  withinBudgetMean: boolean;
  withinBudgetP95: boolean;
}

export interface B1Result {
  seed: number;
  repeats: number;
  callsPerRepeat: number;
  poolPairs: number;
  /** The first call, which loads the model, in ms. */
  firstCallMs: number;
  combinations: B1Combination[];
}

function stats(values: readonly number[]): Stats {
  return {
    mean: mean(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values)
  };
}

/** A seeded draw without replacement (Fisher-Yates on a copy). */
export function drawPairs<T>(pool: readonly T[], count: number, seed: number): T[] {
  if (count > pool.length) throw new Error(`Cannot draw ${count} pairs from ${pool.length}.`);
  const random = seededRandom(seed);
  const copy = [...pool];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy.slice(0, count);
}

export interface Combination {
  callSize: number;
  helperBatch: number | null;
}

export function combinationsOf(
  options: Pick<B1Options, "callSizes" | "helperBatches" | "batched">
): Combination[] {
  return [...new Set(options.callSizes)]
    .sort((a, b) => a - b)
    .flatMap((callSize): Combination[] =>
      options.batched
        ? [...new Set(options.helperBatches)]
            .sort((a, b) => a - b)
            .filter((helperBatch) => helperBatch <= callSize)
            .map((helperBatch) => ({ callSize, helperBatch }))
        : [{ callSize, helperBatch: null }]
    );
}

export async function measureB1(
  scorer: PairScorer,
  candidates: readonly PairText[],
  options: B1Options
): Promise<B1Result> {
  const combinations = combinationsOf(options);
  if (combinations.length === 0) throw new Error("B1 has no call size and batch combination.");
  const biggest = Math.max(...combinations.map((combo) => combo.callSize));
  const poolSize = biggest * options.callsPerRepeat;
  const pool = drawPairs(candidates, poolSize, options.seed);

  // The first call loads the model; then each combination runs once untimed, so shapes and kernels
  // a combination meets for the first time do not land in its first measured repeat.
  const first = await scorer.scorePairs(pool.slice(0, Math.min(16, pool.length)), 16);
  const firstCallMs = first.wallMs;
  for (const combo of combinations)
    await scorer.scorePairs(pool.slice(0, combo.callSize), combo.helperBatch ?? 1);

  const samples = combinations.map(() => ({
    wall: [] as number[],
    inference: [] as number[],
    tokens: [] as number[],
    perPair: [] as number[]
  }));
  const total = options.repeats * combinations.length * options.callsPerRepeat;
  let done = 0;
  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    for (const [index, combo] of combinations.entries()) {
      const bucket = samples[index]!;
      for (let call = 0; call < options.callsPerRepeat; call += 1) {
        const pairs = pool.slice(call * combo.callSize, (call + 1) * combo.callSize);
        const result = await scorer.scorePairs(pairs, combo.helperBatch ?? 1);
        if (result.logOdds.length !== pairs.length || !result.logOdds.every(Number.isFinite))
          throw new Error("B1: the scorer returned missing or non-finite scores.");
        bucket.wall.push(result.wallMs);
        bucket.perPair.push(result.wallMs / pairs.length);
        if (result.inferenceMs !== undefined)
          bucket.inference.push(result.inferenceMs / pairs.length);
        if (result.tokenCounts) bucket.tokens.push(...result.tokenCounts);
        done += 1;
        options.onCall?.(done, total);
      }
    }
  }
  return {
    seed: options.seed,
    repeats: options.repeats,
    callsPerRepeat: options.callsPerRepeat,
    poolPairs: pool.length,
    firstCallMs,
    combinations: combinations.map((combo, index) => {
      const bucket = samples[index]!;
      const callMs = stats(bucket.wall);
      return {
        ...combo,
        calls: bucket.wall.length,
        callMs,
        msPerPair: stats(bucket.perPair),
        inferenceMsPerPair: bucket.inference.length > 0 ? mean(bucket.inference) : null,
        meanTokensPerPair: bucket.tokens.length > 0 ? mean(bucket.tokens) : null,
        callsOverBudget: bucket.wall.filter((ms) => ms > p0BudgetMs).length,
        withinBudgetMean: callMs.mean <= p0BudgetMs,
        withinBudgetP95: callMs.p95 <= p0BudgetMs
      };
    })
  };
}

const fixed = (value: number | null, digits = 1): string =>
  value === null ? "n/a" : value.toFixed(digits);

export function renderB1Markdown(
  result: B1Result,
  context: { runtime: string; hostLoadAverage: { before: number[]; after: number[] } }
): string {
  const load = (values: number[]): string => values.map((value) => value.toFixed(2)).join(" ");
  return [
    `B1 ${context.runtime}: ${result.repeats} repeats of ${result.callsPerRepeat} calls per combination, seeded draw ${result.seed}`,
    `first call (model load) ${fixed(result.firstCallMs, 0)} ms; host load average ${load(context.hostLoadAverage.before)} before, ${load(context.hostLoadAverage.after)} after`,
    "",
    "| Pairs per call | Helper batch | Calls | Call ms mean | p50 | p95 | max | ms per pair mean | p50 | p95 | Device ms per pair | Tokens per pair | Mean in 1.0 s | p95 in 1.0 s |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...result.combinations.map(
      (row) =>
        `| ${row.callSize} | ${row.helperBatch ?? "n/a"} | ${row.calls} | ${fixed(row.callMs.mean)} | ${fixed(row.callMs.p50)} | ${fixed(row.callMs.p95)} | ${fixed(row.callMs.max)} | ${fixed(row.msPerPair.mean, 2)} | ${fixed(row.msPerPair.p50, 2)} | ${fixed(row.msPerPair.p95, 2)} | ${fixed(row.inferenceMsPerPair, 2)} | ${fixed(row.meanTokensPerPair, 0)} | ${row.withinBudgetMean ? "yes" : "no"} | ${row.withinBudgetP95 ? "yes" : "no"} |`
    ),
    ""
  ].join("\n");
}
