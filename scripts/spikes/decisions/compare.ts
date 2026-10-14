/**
 * Spike A2 comparison and robustness checks that need no API calls:
 *
 * - how often the Decisions predicate agrees with Spike A's MLX reranker on the same pairs;
 * - what a cascade would do: MLX decides, and only pairs in MLX's uncertain band go to Decisions,
 *   first with probabilities from the full-shortlist requests, then with band-only requests
 *   (`band.ts`), which is the shape a tiebreaker would send;
 * - how stable a pair's probability is across request compositions (1, 8 or 20 candidates).
 *
 *   npx tsx scripts/spikes/decisions/compare.ts
 *
 * Spike A's MLX score file is read-only input (`.cache/spikes/reranker/scores/`). Thresholds come
 * from the tuning split only, as in `evaluate.ts`.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildContext, evaluateSplit, logOddsLookup, type RowScore } from "../reranker/core.js";
import { loadDataset, loadFrozen, type DatasetRow, type Partition } from "../reranker/dataset.js";
import {
  chooseThreshold,
  logit,
  mean,
  percentile,
  rootOutcome,
  spearman
} from "../reranker/metrics.js";
import { loadScoreFile, scoreFileName, scoresDirectory } from "../reranker/scores.js";

import {
  bandDirectedPairs,
  bandLows,
  bandRunId,
  loadBandContext,
  partitionRows,
  planBand,
  type BandContext
} from "./band-plan.js";
import { costUsd, outputDirectory, readRaw, type RawRecord } from "./budget.js";
import { bandOrders, decisionsMaxBothThreshold, frozenBandPath } from "./frozen-band.js";
import { loadScores, pairId, predicatesOf } from "./scores.js";

const dataset = await loadDataset();
const context = buildContext(dataset);
const frozen = await loadFrozen();
const scores = await loadScores(dataset);
const lg = (p: number): number => logit(p, 0.005);
const probOf = (q: string, d: string): number => {
  const entry = scores.predicate.get(pairId(q, d));
  if (!entry) throw new Error(`No score for ${q} -> ${d}`);
  return entry.probability ?? 0;
};

const mlxFile = await loadScoreFile("mlx", frozen.instructionId, "all", 16);
const mlxLookup = logOddsLookup(dataset.sets.all, mlxFile.logOdds);
const mlxFileModified = (
  await stat(join(scoresDirectory, scoreFileName("mlx", frozen.instructionId, "all", 16)))
).mtime.toISOString();

const dForward: RowScore = (row) => lg(probOf(row.query, row.doc));
const dBackward: RowScore = (row) => lg(probOf(row.doc, row.query));
const dMax: RowScore = (row) => Math.max(dForward(row), dBackward(row));
const mMax: RowScore = (row) =>
  Math.max(mlxLookup(row.query, row.doc), mlxLookup(row.doc, row.query));

const tuningThreshold = (score: RowScore): number => {
  const choice = chooseThreshold(evaluateSplit(context, "tuning", score).labelled);
  if (!choice) throw new Error("no tuning threshold");
  return choice.threshold;
};
const decisionsThreshold = tuningThreshold(dMax);
const mlxThreshold = tuningThreshold(mMax);
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// The band planner (`band-plan.ts`) derives the same thresholds on its own; they must agree.
const bandContext: BandContext = await loadBandContext();
if (Math.abs(bandContext.mlxThreshold - mlxThreshold) > 1e-9)
  throw new Error("The band planner and compare.ts disagree on the MLX threshold");
if (Math.abs((await decisionsMaxBothThreshold(bandContext)) - decisionsThreshold) > 1e-9)
  throw new Error("The band freeze and compare.ts disagree on the Decisions threshold");

function rowsOf(partition: Partition): DatasetRow[] {
  return context.rowsByPhase.get(partition === "tuning" ? "economy" : "validate") ?? [];
}

// --- Agreement of the two deciders (max of both directions) ----------------------------------
const agreement = (["tuning", "holdout"] as const).map((partition) => {
  const rows = rowsOf(partition);
  let both = 0;
  let onlyMlx = 0;
  let onlyDecisions = 0;
  let neither = 0;
  for (const row of rows) {
    const m = mMax(row) >= mlxThreshold;
    const d = dMax(row) >= decisionsThreshold;
    if (m && d) both += 1;
    else if (m) onlyMlx += 1;
    else if (d) onlyDecisions += 1;
    else neither += 1;
  }
  return { partition, rows: rows.length, both, onlyMlx, onlyDecisions, neither };
});

// --- Cascade: MLX decides outside its uncertain band, Decisions inside ----------------------------
function cascade(
  lo: number,
  decision: RowScore = dMax,
  partitions: readonly Partition[] = ["tuning", "holdout"]
) {
  const accept: RowScore = (row) => {
    const m = mMax(row);
    if (m >= mlxThreshold) return 1;
    if (m >= lo) return decision(row) >= decisionsThreshold ? 1 : 0;
    return 0;
  };
  const sides = partitions.map((partition) => {
    const rows = rowsOf(partition);
    const split = evaluateSplit(context, partition, accept);
    const outcome = rootOutcome(split.labelled, 1);
    const gray = rows.filter((row) => mMax(row) < mlxThreshold && mMax(row) >= lo);
    const byNote = new Set(gray.map((row) => row.query));
    const accepted = rows.filter((row) => accept(row) === 1);
    const acceptedOnlyByDecisions = accepted.filter((row) => mMax(row) < mlxThreshold);
    const economy = partition === "tuning" ? rows : [];
    const byPair = new Map(economy.map((row) => [`${row.query}|${row.doc}`, row]));
    const reverseOnly = economy.filter((row) => {
      if (!row.accepted) return false;
      const reverse = byPair.get(`${row.doc}|${row.query}`);
      return reverse !== undefined && !reverse.accepted;
    });
    const kept = reverseOnly.filter((row) => accept(row) === 1).length;
    return {
      partition,
      expectedFound: outcome.expectedFound,
      expectedTotal: outcome.expectedTotal,
      forbiddenFound: outcome.forbiddenFound,
      rowsInBand: gray.length,
      shareOfRowsInBand: gray.length / rows.length,
      notesWithAtLeastOneBandRow: byNote.size,
      sourceNotes: new Set(rows.map((row) => row.query)).size,
      /** Unique directed pairs a tiebreaker scores (rows listed by both notes collapse). */
      directedPairsSent: bandDirectedPairs(bandContext, partition, lo).length,
      survivors: accepted.length,
      survivorsAddedByDecisions: acceptedOnlyByDecisions.length,
      survivorsAddedByDecisionsOldYes: acceptedOnlyByDecisions.filter((row) => row.oldLlm >= 0.65)
        .length,
      oldReverseOnlyAcceptances: partition === "tuning" ? reverseOnly.length : null,
      oldReverseOnlyKept: partition === "tuning" ? kept : null
    };
  });
  return { lo, hi: mlxThreshold, sides };
}
const cascades = [0, 1.5, 2.5].map((lo) => cascade(lo));

// The same cascade fed with the Decisions scores of another candidate order ("order B"), with the
// thresholds frozen on order A: does the local floor protect against Decisions' order noise?
async function cascadesOrderB() {
  const scoresB = await loadScores(dataset, "B");
  const p = (q: string, d: string): number => scoresB.predicate.get(pairId(q, d))?.probability ?? 0;
  const maxB: RowScore = (row) => Math.max(lg(p(row.query, row.doc)), lg(p(row.doc, row.query)));
  return [0, 1.5, 2.5].map((lo) => cascade(lo, maxB));
}

// --- Composition sensitivity --------------------------------------------------------------------
// Request makeup and candidate order are confounded unless stated: the latency requests use their
// own shuffle keys, so only two comparisons are clean. A single-candidate request has no order, so
// its difference to the primary request is makeup alone; a 20-candidate request that holds the
// same candidate set as the primary request differs by order alone.
interface PairInRequest {
  probability: number;
  /** Query note and sorted candidate ids of the request that scored the pair. */
  requestSet: string;
  candidates: number;
}
const requestSignature = (queryId: string, candidateIds: readonly string[]): string =>
  `${queryId}|${[...candidateIds].sort().join(",")}`;

/** The primary (full-shortlist) request that scored each directed pair. */
function primaryRequests(): Map<string, RawRecord> {
  const result = new Map<string, RawRecord>();
  for (const data of scores.stages.values()) {
    if (data.config !== "predicate") continue;
    for (const record of data.records) {
      for (const triple of predicatesOf(record)) {
        const id = pairId(triple.query, triple.doc);
        if (!result.has(id)) result.set(id, record);
      }
    }
  }
  return result;
}

async function composition() {
  const requestOfPair = primaryRequests();
  const read = async (runId: string) => {
    const map = new Map<string, PairInRequest>();
    for (const record of (await readRaw(runId)).filter((r) => r.ok)) {
      if ((record.meta as { repeat?: number }).repeat !== 0) continue;
      const meta = record.meta as { queryId: string; candidateIds: string[] };
      for (const triple of predicatesOf(record))
        map.set(pairId(triple.query, triple.doc), {
          probability: triple.probability ?? 0,
          requestSet: requestSignature(meta.queryId, meta.candidateIds),
          candidates: meta.candidateIds.length
        });
    }
    return map;
  };
  const single = await read("latency-c1-single");
  const note8 = await read("latency-c1-note8");
  const note20 = await read("latency-c1-note20");
  const threshold = sigmoid(decisionsThreshold);
  const summarize = (diffs: number[], flips: number, identical: number) => ({
    pairs: diffs.length,
    identicalShare: diffs.length ? identical / diffs.length : null,
    meanAbsDiff: diffs.length ? mean(diffs) : null,
    p95AbsDiff: diffs.length ? percentile(diffs, 0.95) : null,
    maxAbsDiff: diffs.length ? Math.max(...diffs) : null,
    decisionFlips: flips
  });
  const compare = (
    label: string,
    what: string,
    a: Map<string, PairInRequest>,
    b: Map<string, PairInRequest>
  ) => {
    const all = { diffs: [] as number[], flips: 0, identical: 0 };
    const sameSet = { diffs: [] as number[], flips: 0, identical: 0 };
    let candidatesA = 0;
    let candidatesB = 0;
    for (const [id, left] of a) {
      const right = b.get(id);
      if (right === undefined) continue;
      candidatesA += left.candidates;
      candidatesB += right.candidates;
      const targets = left.requestSet === right.requestSet ? [all, sameSet] : [all];
      for (const target of targets) {
        target.diffs.push(Math.abs(left.probability - right.probability));
        if (left.probability === right.probability) target.identical += 1;
        if (left.probability >= threshold !== right.probability >= threshold) target.flips += 1;
      }
    }
    return {
      label,
      whatDiffers: what,
      ...summarize(all.diffs, all.flips, all.identical),
      meanCandidatesPerRequest: [
        all.diffs.length ? candidatesA / all.diffs.length : null,
        all.diffs.length ? candidatesB / all.diffs.length : null
      ],
      sameCandidateSetShare: all.diffs.length ? sameSet.diffs.length / all.diffs.length : null,
      sameCandidateSetOnly: summarize(sameSet.diffs, sameSet.flips, sameSet.identical)
    };
  };
  const primary = new Map<string, PairInRequest>();
  for (const [id, entry] of scores.predicate) {
    const record = requestOfPair.get(id);
    if (!record) continue;
    const meta = record.meta as { queryId: string; candidateIds: string[] };
    primary.set(id, {
      probability: entry.probability ?? 0,
      requestSet: requestSignature(meta.queryId, meta.candidateIds),
      candidates: meta.candidateIds.length
    });
  }
  return {
    thresholdProbability: threshold,
    comparisons: [
      compare(
        "20-candidate request vs primary request",
        "order (the candidate set is the primary one for most pairs)",
        note20,
        primary
      ),
      compare(
        "8-candidate request vs primary request",
        "makeup and order together",
        note8,
        primary
      ),
      compare(
        "single-candidate request vs primary request",
        "makeup alone (a single candidate has no order)",
        single,
        primary
      ),
      compare("8-candidate vs 20-candidate request", "makeup and order together", note8, note20),
      compare(
        "single-candidate vs 20-candidate request",
        "makeup alone (a single candidate has no order)",
        single,
        note20
      )
    ]
  };
}

// --- Robustness to candidate order: the same requests with another shuffle ("order B") -----------
async function orderRobustness() {
  const scoresB = await loadScores(dataset, "B");
  const complete = (["tuning", "holdout"] as const).every(
    (partition) =>
      scoresB.stages.get(`${partition}-forward/predicate`)?.complete === true &&
      scoresB.stages.get(`${partition}-reverse/predicate`)?.complete === true
  );
  if (!complete) return null;
  const probOfB = (q: string, d: string): number =>
    scoresB.predicate.get(pairId(q, d))?.probability ?? 0;
  const make = (p: (q: string, d: string) => number) => {
    const forward: RowScore = (row) => lg(p(row.query, row.doc));
    const backward: RowScore = (row) => lg(p(row.doc, row.query));
    return {
      retrieved: forward,
      maxBoth: ((row) => Math.max(forward(row), backward(row))) as RowScore
    };
  };
  const a = make(probOf);
  const b = make(probOfB);
  const avg = make((q, d) => (probOf(q, d) + probOfB(q, d)) / 2);
  const lowest = make((q, d) => Math.min(probOf(q, d), probOfB(q, d)));
  const result = (score: RowScore, threshold: number) =>
    (["tuning", "holdout"] as const).map((partition) => {
      const split = evaluateSplit(context, partition, score);
      const outcome = rootOutcome(split.labelled, threshold);
      return {
        partition,
        expectedFound: outcome.expectedFound,
        expectedTotal: outcome.expectedTotal,
        forbiddenFound: outcome.forbiddenFound,
        forbiddenTotal: outcome.forbiddenTotal
      };
    });
  const variants = (["retrieved", "maxBoth"] as const).map((variant) => {
    const thresholdA = tuningThreshold(a[variant]);
    const thresholdB = tuningThreshold(b[variant]);
    const thresholdAvg = tuningThreshold(avg[variant]);
    const thresholdMin = tuningThreshold(lowest[variant]);
    return {
      variant,
      orderA: {
        threshold: thresholdA,
        probability: sigmoid(thresholdA),
        result: result(a[variant], thresholdA)
      },
      orderBAtOrderAThreshold: { result: result(b[variant], thresholdA) },
      orderBOwnTuningThreshold: {
        threshold: thresholdB,
        probability: sigmoid(thresholdB),
        result: result(b[variant], thresholdB)
      },
      averageOfAAndB: {
        threshold: thresholdAvg,
        probability: sigmoid(thresholdAvg),
        result: result(avg[variant], thresholdAvg)
      },
      lowestOfAAndB: {
        threshold: thresholdMin,
        probability: sigmoid(thresholdMin),
        result: result(lowest[variant], thresholdMin)
      }
    };
  });
  // Pair level: A against B over every scored primary pair.
  const aValues: number[] = [];
  const bValues: number[] = [];
  for (const [id, entry] of scoresB.predicate) {
    const other = scores.predicate.get(id);
    if (!other || entry.probability === null || other.probability === null) continue;
    aValues.push(other.probability);
    bValues.push(entry.probability);
  }
  const threshold = sigmoid(decisionsThreshold);
  // The labelled root pairs closest to the threshold, per order, to see which pairs move.
  const nearestLabelled = (partition: Partition, score: RowScore) => {
    const split = evaluateSplit(context, partition, score);
    const entries = [
      ...context.labelKeys[partition].expected.map((key) => ({
        key,
        kind: "expected",
        value: split.rootScores.get(key) ?? Number.NEGATIVE_INFINITY
      })),
      ...context.labelKeys[partition].forbidden.map((key) => ({
        key,
        kind: "forbidden",
        value: split.rootScores.get(key) ?? Number.NEGATIVE_INFINITY
      }))
    ].filter((entry) => Number.isFinite(entry.value));
    const forbidden = entries
      .filter((e) => e.kind === "forbidden")
      .sort((x, y) => y.value - x.value);
    const expected = entries.filter((e) => e.kind === "expected").sort((x, y) => x.value - y.value);
    const asP = (e: { key: string; value: number }) => ({
      key: e.key,
      probability: sigmoid(e.value)
    });
    return { highestForbidden: asP(forbidden[0]!), lowestExpected: asP(expected[0]!) };
  };
  const nearest = (["tuning", "holdout"] as const).map((partition) => ({
    partition,
    orderA: nearestLabelled(partition, a.maxBoth),
    orderB: nearestLabelled(partition, b.maxBoth)
  }));
  const diffs = aValues.map((v, i) => Math.abs(v - bValues[i]!));
  const nearBand = aValues
    .map((v, i) => ({ a: v, b: bValues[i]! }))
    .filter((pair) => Math.abs(pair.a - threshold) <= 0.25 || Math.abs(pair.b - threshold) <= 0.25);
  return {
    pairs: aValues.length,
    identicalShare: diffs.filter((d) => d === 0).length / diffs.length,
    meanAbsDiff: mean(diffs),
    p95AbsDiff: percentile(diffs, 0.95),
    maxAbsDiff: Math.max(...diffs),
    spearman: spearman(aValues, bValues),
    decisionFlipsAtThreshold: aValues.filter((v, i) => v >= threshold !== bValues[i]! >= threshold)
      .length,
    pairsWithinQuarterOfThreshold: nearBand.length,
    flipsAmongThose: nearBand.filter((pair) => pair.a >= threshold !== pair.b >= threshold).length,
    nearestLabelledPairsMaxBoth: nearest,
    variants
  };
}

// --- Band-only cascade: the requests a tiebreaker would actually send -----------------------------
// `band.ts` scores only the pairs in MLX's uncertain band (both directions, grouped by query note).
// The cascade is then evaluated with those probabilities instead of the full-shortlist ones.
interface BandRun {
  probabilities: Map<string, number>;
  requests: number;
  directedPairs: number;
  inputTokens: number;
}

async function readBandRun(
  partition: Partition,
  lo: number,
  order: (typeof bandOrders)[number]
): Promise<BandRun | null> {
  const jobs = planBand(bandContext, partition, lo);
  const byKey = new Map(
    (await readRaw(bandRunId(partition, lo, order)))
      .filter((record) => record.ok)
      .map((record) => [record.key, record])
  );
  if (!jobs.every((job) => byKey.has(job.key))) return null;
  const probabilities = new Map<string, number>();
  let inputTokens = 0;
  for (const job of jobs) {
    const record = byKey.get(job.key)!;
    inputTokens += record.usage?.inputTokens ?? 0;
    for (const triple of predicatesOf(record))
      probabilities.set(pairId(triple.query, triple.doc), triple.probability ?? 0);
  }
  for (const [query, doc] of bandDirectedPairs(bandContext, partition, lo)) {
    if (!probabilities.has(pairId(query, doc)))
      throw new Error(`Band run misses ${query} -> ${doc}`);
  }
  return {
    probabilities,
    requests: jobs.length,
    directedPairs: probabilities.size,
    inputTokens
  };
}

/** What the earlier, full-shortlist cascade would have had to send to keep its request makeup. */
function fullContextCost(partition: Partition, lo: number) {
  const requestOfPair = primaryRequests();
  const stageKeys = [`${partition}-forward/predicate`, `${partition}-reverse/predicate`];
  const stageRecords = stageKeys.flatMap((key) => scores.stages.get(key)?.records ?? []);
  const inStage = new Set(stageRecords.map((record) => record.key));
  const touched = new Map<string, RawRecord>();
  for (const [query, doc] of bandDirectedPairs(bandContext, partition, lo)) {
    const record = requestOfPair.get(pairId(query, doc));
    if (!record || !inStage.has(record.key))
      throw new Error(`No ${partition} primary request for ${query} -> ${doc}`);
    touched.set(record.key, record);
  }
  const tokens = (records: Iterable<RawRecord>): number => {
    let total = 0;
    for (const record of records) total += record.usage?.inputTokens ?? 0;
    return total;
  };
  const pairs = (records: Iterable<RawRecord>): number => {
    let total = 0;
    for (const record of records)
      total += (record.meta as { candidateIds: string[] }).candidateIds.length;
    return total;
  };
  return {
    requestsTouched: touched.size,
    requestsTotal: stageRecords.length,
    shareOfRequests: touched.size / stageRecords.length,
    directedPairsInTouchedRequests: pairs(touched.values()),
    directedPairsTotal: pairs(stageRecords),
    inputTokensTouched: tokens(touched.values()),
    inputTokensTotal: tokens(stageRecords),
    shareOfInputTokens: tokens(touched.values()) / tokens(stageRecords),
    usdTouched: costUsd(tokens(touched.values())),
    usdTotal: costUsd(tokens(stageRecords))
  };
}

async function bandCascades() {
  const results = [];
  const thresholdProbability = sigmoid(decisionsThreshold);
  for (const lo of bandLows) {
    for (const partition of ["tuning", "holdout"] as const) {
      for (const order of bandOrders) {
        const run = await readBandRun(partition, lo, order);
        if (!run) continue;
        const band = (query: string, doc: string): number => {
          const probability = run.probabilities.get(pairId(query, doc));
          if (probability === undefined) throw new Error(`Band run misses ${query} -> ${doc}`);
          return probability;
        };
        const bandMax: RowScore = (row) =>
          Math.max(lg(band(row.query, row.doc)), lg(band(row.doc, row.query)));
        const side = cascade(lo, bandMax, [partition]).sides[0]!;
        const rows = partitionRows(bandContext, partition).filter((row) => {
          const m = mMax(row);
          return m >= lo && m < mlxThreshold;
        });
        // Band probability against the full-shortlist probability of the same directed pair.
        const diffs: number[] = [];
        let identical = 0;
        let flips = 0;
        for (const [id, probability] of run.probabilities) {
          const [query, doc] = id.split("|") as [string, string];
          const full = probOf(query, doc);
          diffs.push(Math.abs(probability - full));
          if (probability === full) identical += 1;
          if (probability >= thresholdProbability !== full >= thresholdProbability) flips += 1;
        }
        // Row decisions: full-shortlist probabilities against band-only ones.
        let acceptedOnlyFull = 0;
        let acceptedOnlyBand = 0;
        for (const row of rows) {
          const full = dMax(row) >= decisionsThreshold;
          const alone = bandMax(row) >= decisionsThreshold;
          if (full && !alone) acceptedOnlyFull += 1;
          if (!full && alone) acceptedOnlyBand += 1;
        }
        // Labelled root pairs: who reaches the band and where the tiebreaker puts them.
        const composite: RowScore = (row) => {
          const m = mMax(row);
          if (m >= mlxThreshold) return Number.POSITIVE_INFINITY;
          if (m >= lo) return bandMax(row);
          return Number.NEGATIVE_INFINITY;
        };
        const labelled = evaluateSplit(context, partition, composite).labelled;
        const inBandScores = (values: number[]): number[] => values.filter(Number.isFinite);
        const expectedInBand = inBandScores(labelled.expected);
        const forbiddenInBand = inBandScores(labelled.forbidden);
        const plateau = partition === "tuning" ? chooseThreshold(labelled) : null;
        const keyed = (kind: "expected" | "forbidden") =>
          context.labelKeys[partition][kind]
            .map((key, index) => ({ key, value: labelled[kind][index]! }))
            .filter((entry) => Number.isFinite(entry.value))
            .map((entry) => ({ key: entry.key, probability: sigmoid(entry.value) }));
        const asProbability = (value: number | undefined): number | null =>
          value === undefined || !Number.isFinite(value) ? null : sigmoid(value);
        results.push({
          lo,
          order: order || "A",
          requests: run.requests,
          directedPairs: run.directedPairs,
          inputTokens: run.inputTokens,
          usd: costUsd(run.inputTokens),
          usdPer1kPairs: (costUsd(run.inputTokens) / run.directedPairs) * 1000,
          ...side,
          decisionsThresholdProbability: thresholdProbability,
          bandVsFullShortlist: {
            pairs: diffs.length,
            identicalShare: diffs.length ? identical / diffs.length : null,
            meanAbsDiff: diffs.length ? mean(diffs) : null,
            p95AbsDiff: diffs.length ? percentile(diffs, 0.95) : null,
            maxAbsDiff: diffs.length ? Math.max(...diffs) : null,
            directedPairFlipsAtThreshold: flips,
            rowsInBand: rows.length,
            rowsAcceptedOnlyWithFullShortlist: acceptedOnlyFull,
            rowsAcceptedOnlyBandOnly: acceptedOnlyBand
          },
          labelledRootPairs: {
            expectedAcceptedByMlxAlone: labelled.expected.filter((v) => v === Infinity).length,
            expectedDecidedInBand: expectedInBand.length,
            expectedLowestBandProbability: asProbability(
              expectedInBand.length ? Math.min(...expectedInBand) : undefined
            ),
            forbiddenReachingBand: forbiddenInBand.length,
            forbiddenHighestBandProbability: asProbability(
              forbiddenInBand.length ? Math.max(...forbiddenInBand) : undefined
            ),
            expectedPairsInBand: keyed("expected"),
            forbiddenPairsInBand: keyed("forbidden")
          },
          // Tuning only: the threshold range that keeps zero forbidden root pairs in this shape.
          tuningPlateau: plateau
            ? {
                highestForbiddenProbability: asProbability(plateau.maxForbidden),
                lowestExpectedAboveProbability: asProbability(plateau.lowestExpectedAbove),
                midpointProbability: asProbability(plateau.threshold)
              }
            : null,
          fullShortlistContextCost: fullContextCost(partition, lo)
        });
      }
    }
  }
  return results;
}

// --- Spike A comparators (read-only): the table of the report needs them side by side ---------------
async function spikeAComparators() {
  const path = join(scoresDirectory, "..", "evaluation.json");
  const evaluation = JSON.parse(await readFile(path, "utf8")) as {
    assessments: Array<{
      deciderId: string;
      variant: string;
      threshold: { value: number; probability: number | null };
      tuning: Record<string, unknown>;
      holdout: Record<string, unknown>;
    }>;
  };
  const pick = (side: Record<string, unknown>) => ({
    expectedFound: side.expectedFound,
    expectedTotal: side.expectedTotal,
    forbiddenFound: side.forbiddenFound,
    forbiddenTotal: side.forbiddenTotal,
    rootAuc: side.rootAuc,
    lowestExpected: side.lowestExpected,
    highestRetrievedForbidden: side.highestRetrievedForbidden,
    lowestExpectedMargin: side.lowestExpectedMargin,
    noteAucVersusLlmYes: side.noteAucVersusLlmYes
  });
  return {
    file: path,
    modified: (await stat(path)).mtime.toISOString(),
    deciders: evaluation.assessments
      .filter((a) => ["mlx-qwen3", "gguf-qwen3", "old-llm-score", "cosine"].includes(a.deciderId))
      .map((a) => ({
        deciderId: a.deciderId,
        variant: a.variant,
        threshold: a.threshold.value,
        thresholdProbability: a.threshold.probability,
        tuning: pick(a.tuning),
        holdout: pick(a.holdout)
      }))
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  note: "Spike A's MLX scores are read-only input; Spike A may still be revised.",
  mlxScoreFileModified: mlxFileModified,
  thresholds: {
    decisionsMaxBoth: { logOdds: decisionsThreshold, probability: sigmoid(decisionsThreshold) },
    mlxMaxBoth: { logOdds: mlxThreshold }
  },
  agreement,
  cascades,
  cascadesOrderB: await cascadesOrderB(),
  bandFrozenFile: frozenBandPath,
  bandOnlyCascades: await bandCascades(),
  spikeAComparators: await spikeAComparators(),
  composition: await composition(),
  orderRobustness: await orderRobustness()
};
await writeFile(join(outputDirectory, "compare.json"), `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
