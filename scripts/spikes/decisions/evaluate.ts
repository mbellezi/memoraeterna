/**
 * Spike A2 evaluation: Decisions API predicate scores against Spike A's protocol, written to
 * `.cache/spikes/decisions/evaluation.json` and `tables.md`.
 *
 *   npx tsx scripts/spikes/decisions/evaluate.ts
 *
 * Reads only stored results (raw request logs, Spike A's dataset/frozen files); sends nothing.
 * Splits and ground truth, text formatting and metric definitions are Spike A's: its pure
 * helpers (`core.ts`, `metrics.ts`, `dataset.ts`) are imported read-only. Decision thresholds
 * are chosen on the TUNING split only (zero forbidden root pairs, most expected pairs, midpoint of
 * the plateau). The held-out split is measured only when its stages are complete.
 *
 * Score scale: the predicate probability, as log-odds with the probability clipped to
 * [0.005, 0.995] (the API returns probabilities with two decimals, so 0.00 and 1.00 are the
 * saturated values and would otherwise sit at +-16 log-odds).
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  aucVersusOldJudge,
  buildContext,
  evaluateSplit,
  oldJudgeYesAt,
  primaryPhase,
  type Context,
  type RowScore
} from "../reranker/core.js";
import {
  loadDataset,
  loadFrozen,
  repositoryRoot,
  type DatasetRow,
  type Partition
} from "../reranker/dataset.js";
import {
  auc,
  chooseThreshold,
  logit,
  mean,
  pairKey,
  pearson,
  percentile,
  rootOutcome,
  spearman
} from "../reranker/metrics.js";

import { costUsd, outputDirectory, readAllRaw, readRaw, summarizeSpend } from "./budget.js";
import { designFingerprint } from "./design.js";
import { loadScores, pairId, type Scores } from "./scores.js";

const dataset = await loadDataset();
const context: Context = buildContext(dataset);
const frozen = await loadFrozen();
const scores = await loadScores(dataset);
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const lg = (probability: number): number => logit(probability, 0.005);

// --- Availability -----------------------------------------------------------------------------

const complete = (stage: string, config: string): boolean =>
  scores.stages.get(`${stage}/${config}`)?.complete === true;
const available: Record<Partition, boolean> = {
  tuning: complete("tuning-forward", "predicate") && complete("tuning-reverse", "predicate"),
  holdout: complete("holdout-forward", "predicate") && complete("holdout-reverse", "predicate")
};
if (!available.tuning) throw new Error("The tuning stages are not complete; nothing to evaluate");

function probability(map: Scores["predicate"], query: string, doc: string): number {
  const entry = map.get(pairId(query, doc));
  if (entry === undefined) throw new Error(`No score for ${query} -> ${doc}`);
  return entry.probability ?? 0; // a refusal counts as "not related"
}

const forward: RowScore = (row) => lg(probability(scores.predicate, row.query, row.doc));
const backward: RowScore = (row) => lg(probability(scores.predicate, row.doc, row.query));

type Variant = "retrieved" | "max-both" | "mean-both";
const variantScore = (variant: Variant): RowScore =>
  variant === "max-both"
    ? (row) => Math.max(forward(row), backward(row))
    : variant === "mean-both"
      ? (row) => (forward(row) + backward(row)) / 2
      : forward;

// --- Survivors (replicates Spike A's evaluate.ts) ---------------------------------------------

function survival(
  partition: Partition,
  rows: readonly DatasetRow[],
  keep: (row: DatasetRow) => boolean
) {
  const labels = context.labelKeys[partition];
  const byRootPairLabel = { expected: 0, forbidden: 0, unlabelled: 0, sameRoot: 0 };
  for (const row of rows) {
    if (!keep(row)) continue;
    const a = context.noteById.get(row.query)!.root;
    const b = context.noteById.get(row.doc)!.root;
    const key = pairKey(a, b);
    if (a === b) byRootPairLabel.sameRoot += 1;
    else if (labels.expected.includes(key)) byRootPairLabel.expected += 1;
    else if (labels.forbidden.includes(key)) byRootPairLabel.forbidden += 1;
    else byRootPairLabel.unlabelled += 1;
  }
  const perNote = new Map<string, number>();
  for (const row of rows)
    perNote.set(row.query, (perNote.get(row.query) ?? 0) + (keep(row) ? 1 : 0));
  const counts = [...perNote.values()];
  const survivors = counts.reduce((a, b) => a + b, 0);
  return {
    candidates: rows.length,
    survivors,
    share: survivors / rows.length,
    sourceNotes: counts.length,
    survivorsPerNote: {
      mean: mean(counts),
      median: percentile(counts, 0.5),
      p90: percentile(counts, 0.9),
      max: Math.max(...counts),
      withNone: counts.filter((count) => count === 0).length
    },
    byRootPairLabel
  };
}

function rankedLabelled(rootScores: ReadonlyMap<string, number>, keys: readonly string[]) {
  return keys
    .map((key) => ({ key, value: rootScores.get(key) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map(({ key, value }) => ({ key, score: Number.isFinite(value) ? value : null }));
}

function assess(variant: Variant) {
  const score = variantScore(variant);
  const partitions = (["tuning", "holdout"] as const).filter((p) => available[p]);
  const splits = Object.fromEntries(
    partitions.map((p) => [p, evaluateSplit(context, p, score)])
  ) as Record<Partition, ReturnType<typeof evaluateSplit>>;
  const choice = chooseThreshold(splits.tuning.labelled);
  const threshold = choice?.threshold ?? null;
  const side = (partition: Partition) => {
    const split = splits[partition];
    const labels = context.labelKeys[partition];
    const outcome = threshold === null ? null : rootOutcome(split.labelled, threshold);
    const retrievedExpected = split.labelled.expected.filter(Number.isFinite);
    const retrievedForbidden = split.labelled.forbidden.filter(Number.isFinite);
    const expectedRanked = rankedLabelled(split.rootScores, labels.expected);
    const forbiddenRanked = rankedLabelled(split.rootScores, labels.forbidden).filter(
      (entry) => entry.score !== null
    );
    const lowestExpected = expectedRanked[0] ?? null;
    const agreement = { tp: 0, fp: 0, fn: 0, tn: 0 };
    if (threshold !== null) {
      for (const row of split.rows) {
        const yes = score(row) >= threshold;
        if (yes && row.accepted) agreement.tp += 1;
        else if (yes) agreement.fp += 1;
        else if (row.accepted) agreement.fn += 1;
        else agreement.tn += 1;
      }
    }
    return {
      rootAuc: split.rootAuc,
      rootAucRetrievedOnly: auc(retrievedExpected, retrievedForbidden),
      forbiddenRetrieved: retrievedForbidden.length,
      expectedTotal: labels.expected.length,
      forbiddenTotal: labels.forbidden.length,
      expectedRetrieved: split.labelled.expected.filter((s) => s > Number.NEGATIVE_INFINITY).length,
      expectedFound: outcome?.expectedFound ?? null,
      forbiddenFound: outcome?.forbiddenFound ?? null,
      lowestExpected,
      highestRetrievedForbidden: forbiddenRanked.at(-1) ?? null,
      lowestExpectedMargin:
        threshold === null || lowestExpected?.score == null
          ? null
          : lowestExpected.score - threshold,
      /** Expected pairs scoring within 0.01 probability above the threshold's step. */
      missedExpected:
        threshold === null
          ? []
          : labels.expected.filter(
              (key) => (split.rootScores.get(key) ?? Number.NEGATIVE_INFINITY) < threshold
            ),
      forbiddenViolations:
        threshold === null
          ? []
          : labels.forbidden.filter(
              (key) => (split.rootScores.get(key) ?? Number.NEGATIVE_INFINITY) >= threshold
            ),
      noteAucVersusLlmYes: aucVersusOldJudge(split.rows, score, "llm-yes"),
      noteAucVersusAccepted: aucVersusOldJudge(split.rows, score, "accepted"),
      agreementWithOldAccepted: agreement,
      survival:
        threshold === null
          ? null
          : survival(partition, split.rows, (row) => score(row) >= threshold)
    };
  };
  return {
    variant,
    threshold:
      threshold === null
        ? null
        : {
            logOdds: threshold,
            probability: sigmoid(threshold),
            maxTuningForbidden: choice?.maxForbidden ?? null,
            maxTuningForbiddenProbability: Number.isFinite(choice?.maxForbidden ?? Number.NaN)
              ? sigmoid(choice!.maxForbidden)
              : null,
            lowestTuningExpectedAbove: choice?.lowestExpectedAbove ?? null,
            lowestTuningExpectedAboveProbability: choice
              ? sigmoid(choice.lowestExpectedAbove)
              : null
          },
    tuning: side("tuning"),
    holdout: available.holdout ? side("holdout") : null
  };
}

const assessments = (["retrieved", "max-both", "mean-both"] as const).map(assess);

/** Held-out result at every threshold on the tuning plateau (a diagnostic, never used to pick). */
function thresholdSweep(variant: Variant) {
  if (!available.holdout) return null;
  const score = variantScore(variant);
  const tuning = evaluateSplit(context, "tuning", score);
  const holdout = evaluateSplit(context, "holdout", score);
  const choice = chooseThreshold(tuning.labelled);
  if (!choice) return null;
  const labelled = [
    ...tuning.labelled.expected,
    ...tuning.labelled.forbidden,
    ...holdout.labelled.expected,
    ...holdout.labelled.forbidden
  ];
  const grid = [...new Set(labelled)]
    .filter((v) => v > choice.maxForbidden && v <= choice.lowestExpectedAbove)
    .sort((a, b) => a - b);
  return {
    variant,
    plateau: { exclusiveLow: choice.maxForbidden, inclusiveHigh: choice.lowestExpectedAbove },
    chosen: choice.threshold,
    points: grid.map((threshold) => {
      const t = rootOutcome(tuning.labelled, threshold);
      const h = rootOutcome(holdout.labelled, threshold);
      return {
        threshold,
        probability: sigmoid(threshold),
        tuningFound: t.expectedFound,
        tuningForbidden: t.forbiddenFound,
        holdoutFound: h.expectedFound,
        holdoutForbidden: h.forbiddenFound
      };
    })
  };
}
const sweeps = (["retrieved", "max-both", "mean-both"] as const).map(thresholdSweep);

// --- Resolution of the scores -----------------------------------------------------------------

function resolution() {
  const values = [...scores.predicate.values()].map((entry) => entry.probability ?? 0);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const at = (target: number): number => counts.get(target) ?? 0;
  return {
    pairs: values.length,
    distinctValues: counts.size,
    shareAt0: at(0) / values.length,
    shareAt1: at(1) / values.length,
    shareBetween01And99: values.filter((v) => v > 0 && v < 1).length / values.length,
    topValues: sorted.slice(-6).map(([value, count]) => ({ value, count })),
    decimals: values.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9) ? 2 : "more"
  };
}

// --- Calibration -------------------------------------------------------------------------------

const calibrationBuckets: Array<{ label: string; test: (p: number) => boolean }> = [
  { label: "0.00", test: (p) => p === 0 },
  { label: "0.01-0.09", test: (p) => p > 0 && p < 0.1 },
  { label: "0.10-0.29", test: (p) => p >= 0.1 && p < 0.3 },
  { label: "0.30-0.49", test: (p) => p >= 0.3 && p < 0.5 },
  { label: "0.50-0.69", test: (p) => p >= 0.5 && p < 0.7 },
  { label: "0.70-0.89", test: (p) => p >= 0.7 && p < 0.9 },
  { label: "0.90-0.99", test: (p) => p >= 0.9 && p < 1 },
  { label: "1.00", test: (p) => p === 1 }
];

function calibration(partition: Partition) {
  const rows = context.rowsByPhase.get(primaryPhase[partition]) ?? [];
  const labels = context.labelKeys[partition];
  return calibrationBuckets.map((bucket) => {
    const inBucket = rows.filter((row) =>
      bucket.test(probability(scores.predicate, row.query, row.doc))
    );
    let expected = 0;
    let forbidden = 0;
    let unlabelled = 0;
    let sameRoot = 0;
    for (const row of inBucket) {
      const a = context.noteById.get(row.query)!.root;
      const b = context.noteById.get(row.doc)!.root;
      const key = pairKey(a, b);
      if (a === b) sameRoot += 1;
      else if (labels.expected.includes(key)) expected += 1;
      else if (labels.forbidden.includes(key)) forbidden += 1;
      else unlabelled += 1;
    }
    const probs = inBucket.map((row) => probability(scores.predicate, row.query, row.doc));
    return {
      bucket: bucket.label,
      rows: inBucket.length,
      meanProbability: probs.length ? mean(probs) : null,
      oldLlmYesShare: inBucket.length
        ? inBucket.filter((r) => r.oldLlm >= oldJudgeYesAt).length / inBucket.length
        : null,
      oldAcceptedShare: inBucket.length
        ? inBucket.filter((r) => r.accepted).length / inBucket.length
        : null,
      rootExpected: expected,
      rootForbidden: forbidden,
      rootUnlabelled: unlabelled,
      sameRoot,
      expectedShareOfLabelled: expected + forbidden > 0 ? expected / (expected + forbidden) : null
    };
  });
}

// --- Direction stability ------------------------------------------------------------------------

function directionStability() {
  const retrieved = assessments.find((a) => a.variant === "retrieved")!;
  const maxBoth = assessments.find((a) => a.variant === "max-both")!;
  const thr = retrieved.threshold?.logOdds ?? Number.POSITIVE_INFINITY;
  const lookup = (q: string, d: string): number => lg(probability(scores.predicate, q, d));
  const has = (q: string, d: string): boolean => scores.predicate.has(pairId(q, d));
  const undirected = (pairs: ReadonlyArray<readonly [string, string]>): Array<[string, string]> => {
    const unique = new Map<string, [string, string]>();
    for (const [q, d] of pairs) {
      const [a, b] = q < d ? [q, d] : [d, q];
      if (has(a, b) && has(b, a)) unique.set(`${a}|${b}`, [a, b]);
    }
    return [...unique.values()];
  };
  const shareOf = (pairs: ReadonlyArray<readonly [string, string]>, threshold: number) => {
    if (pairs.length < 3) return null;
    const f = pairs.map(([a, b]) => lookup(a, b));
    const r = pairs.map(([a, b]) => lookup(b, a));
    const both = f.filter((v, i) => v >= threshold && r[i]! >= threshold).length;
    const either = f.filter((v, i) => v >= threshold || r[i]! >= threshold).length;
    return {
      undirectedPairs: pairs.length,
      pearsonLogOdds: pearson(f, r),
      spearman: spearman(f, r),
      meanAbsDifference: mean(f.map((v, i) => Math.abs(v - r[i]!))),
      acceptedBothDirections: both,
      acceptedEitherDirection: either,
      oneDirectionOnlyShare: either === 0 ? null : (either - both) / either
    };
  };
  const primaryRows = dataset.rows
    .filter((row) => row.phase === "economy" || (available.holdout && row.phase === "validate"))
    .map((row) => [row.query, row.doc] as const);
  const tuningNotesOnly = dataset.rows
    .filter((row) => row.phase !== "validate")
    .map((row) => [row.query, row.doc] as const);
  const allPairs = dataset.sets.all;

  const economy = context.rowsByPhase.get("economy") ?? [];
  const byPair = new Map(economy.map((row) => [`${row.query}|${row.doc}`, row]));
  const judgedBoth = economy.filter(
    (row) => row.query < row.doc && byPair.has(`${row.doc}|${row.query}`)
  );
  const oldForward = judgedBoth.map((row) => row.oldLlm);
  const oldBackward = judgedBoth.map((row) => byPair.get(`${row.doc}|${row.query}`)!.oldLlm);
  const newForward = judgedBoth.map((row) => lookup(row.query, row.doc));
  const newBackward = judgedBoth.map((row) => lookup(row.doc, row.query));

  const accepted = economy.filter((row) => row.accepted);
  const reverseOnly = accepted.filter((row) => {
    const reverse = byPair.get(`${row.doc}|${row.query}`);
    return reverse !== undefined && !reverse.accepted;
  });
  const classOf = (row: DatasetRow): string => {
    const a = context.noteById.get(row.query)!.root;
    const b = context.noteById.get(row.doc)!.root;
    if (a === b) return "sameRoot";
    const key = pairKey(a, b);
    return context.labelKeys.tuning.expected.includes(key)
      ? "expected"
      : context.labelKeys.tuning.forbidden.includes(key)
        ? "forbidden"
        : "unlabelled";
  };
  const retention = (rows: DatasetRow[], threshold: number) => {
    const dropped = rows.filter((row) => Math.max(forward(row), backward(row)) < threshold);
    const byClass: Record<string, number> = {};
    for (const row of dropped) byClass[classOf(row)] = (byClass[classOf(row)] ?? 0) + 1;
    return {
      total: rows.length,
      kept: rows.length - dropped.length,
      dropped: dropped.length,
      lossShare: rows.length === 0 ? null : dropped.length / rows.length,
      droppedByRootPairLabel: byClass
    };
  };
  const breakdown = (rows: DatasetRow[]) => {
    const count = { keptOldDirection: 0, keptBothDirections: 0, keptReverseOnly: 0, dropped: 0 };
    for (const row of rows) {
      const f = forward(row) >= thr;
      const r = backward(row) >= thr;
      if (f) count.keptOldDirection += 1;
      if (f && r) count.keptBothDirections += 1;
      if (!f && r) count.keptReverseOnly += 1;
      if (!f && !r) count.dropped += 1;
    }
    return count;
  };
  const maxBothThreshold = maxBoth.threshold?.logOdds ?? Number.POSITIVE_INFINITY;
  const tuningMaxBoth = evaluateSplit(context, "tuning", variantScore("max-both"));
  const lossCurve = [0, 0.5, 1, 1.5, 2, 3].map((offset) => {
    const threshold = maxBothThreshold - offset;
    const outcome = rootOutcome(tuningMaxBoth.labelled, threshold);
    return {
      threshold,
      probability: sigmoid(threshold),
      reverseOnlyLossShare: retention(reverseOnly, threshold).lossShare,
      tuningExpectedFound: outcome.expectedFound,
      tuningForbiddenFound: outcome.forbiddenFound
    };
  });
  return {
    thresholds: { retrieved: thr, maxBoth: maxBothThreshold },
    primaryPairs: shareOf(undirected(primaryRows), thr),
    tuningNotesOnlyAllPhases: shareOf(undirected(tuningNotesOnly), thr),
    allSpikeAPairs: shareOf(undirected(allPairs), thr),
    economyJudgedBothWays: {
      pairs: judgedBoth.length,
      oldLlmPearson: pearson(oldForward, oldBackward),
      oldLlmSpearman: spearman(oldForward, oldBackward),
      newPearson: pearson(newForward, newBackward),
      newSpearman: spearman(newForward, newBackward)
    },
    oldAcceptedRelations: accepted.length,
    oldReverseOnly: {
      count: reverseOnly.length,
      share: accepted.length ? reverseOnly.length / accepted.length : null,
      byRootPairLabel: reverseOnly.reduce<Record<string, number>>((acc, row) => {
        acc[classOf(row)] = (acc[classOf(row)] ?? 0) + 1;
        return acc;
      }, {}),
      newDecider: breakdown(reverseOnly),
      maxBoth: retention(reverseOnly, maxBothThreshold),
      lossCurve
    },
    allOldAccepted: {
      newDecider: breakdown(accepted),
      maxBoth: retention(accepted, maxBothThreshold)
    }
  };
}

// --- Runs: tokens, cost, latency, errors ---------------------------------------------------------

function summarizeTimes(values: number[]) {
  if (values.length === 0) return null;
  return {
    samples: values.length,
    meanMs: mean(values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values)
  };
}

async function runSummaries() {
  const all = await readAllRaw();
  const ids = [...new Set(all.map((record) => record.runId))].sort();
  const result = [];
  for (const runId of ids) {
    const records = await readRaw(runId);
    const ok = records.filter((record) => record.ok);
    const failed = records.filter((record) => !record.ok);
    const latestOk = new Map(ok.map((record) => [record.key, record]));
    const unique = [...latestOk.values()];
    const pairs = unique.reduce(
      (n, record) => n + ((record.meta as { candidateIds?: string[] }).candidateIds?.length ?? 0),
      0
    );
    const spend = summarizeSpend(records);
    const answers = unique.flatMap((record) => (record.answers ?? []) as Array<{ type: string }>);
    result.push({
      runId,
      requestsOk: unique.length,
      requestsFailedRecords: failed.length,
      errorKinds: failed.reduce<Record<string, number>>((acc, record) => {
        const kind = record.error?.kind ?? "unknown";
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, {}),
      retriedRequests: unique.filter((record) => (record.attemptStatuses?.length ?? 1) > 1).length,
      candidatePairs: pairs,
      inputTokens: spend.inputTokens,
      usd: spend.usd,
      tokensPerPair: pairs ? spend.inputTokens / pairs : null,
      usdPer1kPairs: pairs ? (costUsd(spend.inputTokens) / pairs) * 1000 : null,
      tokensPerRequestMean: unique.length
        ? mean(unique.map((r) => r.usage?.inputTokens ?? 0))
        : null,
      questionsPerRequestMean: unique.length ? mean(unique.map((r) => r.questions)) : null,
      attemptMs: summarizeTimes(unique.map((r) => r.attemptMs ?? 0)),
      serverMs: summarizeTimes(unique.flatMap((r) => (r.serverMs ? [r.serverMs] : []))),
      refusalAnswers: answers.filter((a) => a.type === "refusal").length,
      cachedTokens: unique.reduce((n, r) => n + (r.usage?.cachedTokens ?? 0), 0),
      reasoningTokens: unique.reduce((n, r) => n + (r.usage?.reasoningTokens ?? 0), 0),
      models: [...new Set(unique.map((r) => r.model ?? "?"))]
    });
  }
  return { runs: result, total: summarizeSpend(all) };
}

// --- Typed configuration -------------------------------------------------------------------------

const relationRowSchema = z.object({
  source_atomic_note_id: z.string(),
  target_atomic_note_id: z.string(),
  relation_type: z.string()
});

const oldToNewType: Record<string, string | null> = {
  supports: "supports",
  extends: "extends",
  clarifies: "clarifies",
  depends_on: "depends_on",
  contrasts: "contradicts",
  similar_to: null,
  mentions: null,
  related: null
};

async function typedAnalysis() {
  if (!complete("tuning-forward", "typed") || !complete("tuning-reverse", "typed")) return null;
  const economy = context.rowsByPhase.get("economy") ?? [];
  const results = z
    .object({ noteRelations: z.array(relationRowSchema.passthrough()) })
    .passthrough()
    .parse(
      JSON.parse(
        await readFile(
          join(repositoryRoot, ".cache", "matching-benchmark", "economy", "results.json"),
          "utf8"
        )
      )
    );
  const typedForward: RowScore = (row) =>
    lg(probability(scores.typedPredicate, row.query, row.doc));
  const retrieved = assessments.find((a) => a.variant === "retrieved")!;

  // Forward-only quality of the predicate answers inside the typed request, against predicate-only.
  const forwardOnly = (score: RowScore) => {
    const split = evaluateSplit(context, "tuning", score);
    const choice = chooseThreshold(split.labelled);
    const outcome = choice ? rootOutcome(split.labelled, choice.threshold) : null;
    return {
      threshold: choice?.threshold ?? null,
      thresholdProbability: choice ? sigmoid(choice.threshold) : null,
      expectedFound: outcome?.expectedFound ?? null,
      forbiddenFound: outcome?.forbiddenFound ?? null,
      expectedTotal: split.labelled.expected.length,
      noteAucVersusLlmYes: aucVersusOldJudge(split.rows, score, "llm-yes"),
      noteAucVersusAccepted: aucVersusOldJudge(split.rows, score, "accepted"),
      survivors: choice ? economy.filter((row) => score(row) >= choice.threshold).length : null
    };
  };
  const predicateAlone = forwardOnly(forward);
  const predicateInTyped = forwardOnly(typedForward);
  const spearmanBetween = spearman(economy.map(forward), economy.map(typedForward));
  const flips =
    retrieved.threshold === null
      ? null
      : economy.filter(
          (row) =>
            forward(row) >= retrieved.threshold!.logOdds !==
            typedForward(row) >= retrieved.threshold!.logOdds
        ).length;

  // Type agreement for the old pipeline's stored relations. Each relation is stored in one
  // direction (source -> target); the typed answer for exactly that direction is compared, which
  // is in the forward or in the reverse typed stage depending on the relation.
  const relations = results.noteRelations;
  const matrix: Record<string, Record<string, number>> = {};
  let withCounterpart = 0;
  let exact = 0;
  let noneCount = 0;
  let answeredRelations = 0;
  let predicateYes = 0;
  const survivorTypes: Record<string, number> = {};
  for (const relation of relations) {
    const id = pairId(relation.source_atomic_note_id, relation.target_atomic_note_id);
    const choice = scores.typedChoice.get(id);
    if (!choice) continue;
    answeredRelations += 1;
    const old = relation.relation_type;
    matrix[old] ??= {};
    matrix[old]![choice.choice] = (matrix[old]![choice.choice] ?? 0) + 1;
    if (choice.choice === "none") noneCount += 1;
    const mapped = oldToNewType[old] ?? null;
    if (mapped !== null) {
      withCounterpart += 1;
      if (mapped === choice.choice) exact += 1;
    }
    const probabilityYes =
      retrieved.threshold !== null &&
      lg(
        probability(
          scores.typedPredicate,
          relation.source_atomic_note_id,
          relation.target_atomic_note_id
        )
      ) >= retrieved.threshold.logOdds;
    if (probabilityYes) {
      predicateYes += 1;
      survivorTypes[choice.choice] = (survivorTypes[choice.choice] ?? 0) + 1;
    }
  }
  // Consistency between the two question kinds on every tuning row.
  const consistency = { predicateYesTypeNone: 0, predicateNoTypeNotNone: 0, rows: 0 };
  if (retrieved.threshold !== null) {
    for (const row of economy) {
      const choice = scores.typedChoice.get(pairId(row.query, row.doc));
      if (!choice) continue;
      consistency.rows += 1;
      const yes = typedForward(row) >= retrieved.threshold.logOdds;
      if (yes && choice.choice === "none") consistency.predicateYesTypeNone += 1;
      if (!yes && choice.choice !== "none") consistency.predicateNoTypeNotNone += 1;
    }
  }
  const choiceDistribution: Record<string, number> = {};
  for (const choice of scores.typedChoice.values()) {
    choiceDistribution[choice.choice] = (choiceDistribution[choice.choice] ?? 0) + 1;
  }
  return {
    predicateAlone,
    predicateInTyped,
    spearmanBetweenPredicateSets: spearmanBetween,
    decisionFlipsAtPredicateOnlyThreshold: flips,
    oldRelations: relations.length,
    answeredRelations,
    relationsKeptByPredicate: predicateYes,
    oldTypeCounts: Object.fromEntries(
      Object.entries(matrix).map(([type, row]) => [
        type,
        Object.values(row).reduce((a, b) => a + b, 0)
      ])
    ),
    confusionOldByNew: matrix,
    withCounterpart,
    exactMatches: exact,
    exactAgreement: withCounterpart ? exact / withCounterpart : null,
    typedNoneForOldRelations: noneCount,
    typeOfRelationsKeptByPredicate: survivorTypes,
    consistency,
    choiceDistributionAllRows: choiceDistribution
  };
}

// --- Spike A comparators (read-only) ---------------------------------------------------------------

async function spikeAReference() {
  const dir = join(repositoryRoot, ".cache", "spikes", "reranker");
  const evaluationPath = join(dir, "evaluation.json");
  const latencyPath = join(dir, "latency.json");
  try {
    const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as {
      generatedAt: string;
      assessments: Array<{
        deciderId: string;
        variant: string;
        threshold: { value: number } | null;
        tuning: {
          expectedFound: number;
          expectedTotal: number;
          forbiddenFound: number;
          noteAucVersusLlmYes: number;
          survival: { share: number; survivorsPerNote: { mean: number; withNone: number } };
        };
        holdout: {
          expectedFound: number;
          expectedTotal: number;
          forbiddenFound: number;
          noteAucVersusLlmYes: number;
          survival: { share: number; survivorsPerNote: { mean: number; withNone: number } };
        };
      }>;
      stability: Array<{
        deciderId: string;
        allPairs: {
          pearsonLogOdds: number;
          spearman: number;
          oneDirectionOnlyShare: number;
          undirectedPairs: number;
        };
        oldReverseOnly: { maxBoth: { dropped: number; lossShare: number }; count: number };
      }>;
    };
    const latency = JSON.parse(await readFile(latencyPath, "utf8")) as {
      measuredAt: string;
      results: unknown[];
    };
    return {
      note: "From Spike A (read-only). Spike A may still be revised; the file times below say which version was read.",
      evaluationGeneratedAt: evaluation.generatedAt,
      evaluationFileModified: (await stat(evaluationPath)).mtime.toISOString(),
      latencyMeasuredAt: latency.measuredAt,
      latencyFileModified: (await stat(latencyPath)).mtime.toISOString(),
      assessments: evaluation.assessments.filter((a) =>
        ["mlx-qwen3", "gguf-qwen3", "cosine", "old-llm-score"].includes(a.deciderId)
      ),
      stability: evaluation.stability,
      latency: latency.results
    };
  } catch {
    return null;
  }
}

// --- Output -------------------------------------------------------------------------------------------

const f = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits);
const pct = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value)
    ? "n/a"
    : `${(value * 100).toFixed(1)}%`;

const runInfo = await runSummaries();
const evaluation = {
  generatedAt: new Date().toISOString(),
  endpoint: "POST https://api.openai.com/v1/decisions",
  model: "gpt-6-luna",
  frozenInstructionId: frozen.instructionId,
  designFingerprint: designFingerprint(frozen.instruction),
  scale: "log-odds of the predicate probability clipped to [0.005, 0.995]",
  oldJudgeYesAt,
  available,
  refusalAnswers: scores.refusals,
  resolution: resolution(),
  assessments,
  sweeps,
  calibration: {
    tuning: calibration("tuning"),
    holdout: available.holdout ? calibration("holdout") : null
  },
  direction: directionStability(),
  runs: runInfo.runs,
  totalSpend: runInfo.total,
  typed: await typedAnalysis(),
  spikeA: await spikeAReference()
};
await writeFile(
  join(outputDirectory, "evaluation.json"),
  `${JSON.stringify(evaluation, null, 2)}\n`
);

const lines: string[] = [];
lines.push(
  `Decisions API (gpt-6-luna), predicate per candidate, frozen instruction \`${frozen.instructionId}\`. Held-out stages: ${available.holdout ? "complete" : "not run"}.`,
  ""
);
lines.push("### Root-level quality (threshold chosen on tuning)", "");
lines.push(
  "| Variant | Threshold (p) | Tuning found / forb. | Tuning root AUC / retrieved-only | Holdout found / forb. | Holdout root AUC / retrieved-only | Lowest holdout expected (score p, margin) |",
  "|---|---|---|---|---|---|---|"
);
for (const a of assessments) {
  const h = a.holdout;
  lines.push(
    `| ${a.variant} | ${a.threshold ? `${f(a.threshold.logOdds, 2)} (${f(a.threshold.probability, 4)})` : "n/a"} | ` +
      `${a.tuning.expectedFound}/${a.tuning.expectedTotal}, ${a.tuning.forbiddenFound}/${a.tuning.forbiddenTotal} | ${f(a.tuning.rootAuc)} / ${f(a.tuning.rootAucRetrievedOnly)} | ` +
      (h
        ? `${h.expectedFound}/${h.expectedTotal}, ${h.forbiddenFound}/${h.forbiddenTotal} | ${f(h.rootAuc)} / ${f(h.rootAucRetrievedOnly)} | ${h.lowestExpected?.key ?? "n/a"} ${f(h.lowestExpected?.score == null ? null : sigmoid(h.lowestExpected.score), 3)} (${f(h.lowestExpectedMargin, 2)}) |`
        : "n/a | n/a | n/a |")
  );
}
lines.push("", "### Note level: AUC against the old judge and survivors", "");
lines.push(
  "| Variant | Split | AUC vs old verdict | AUC vs accepted | Survivors share | Per note mean | Notes with none | Survivors by root label: expected / unlabelled / same-root / forbidden |",
  "|---|---|---|---|---|---|---|---|"
);
for (const a of assessments) {
  for (const partition of ["tuning", "holdout"] as const) {
    const s = a[partition];
    if (!s || !s.survival) continue;
    lines.push(
      `| ${a.variant} | ${partition} | ${f(s.noteAucVersusLlmYes)} | ${f(s.noteAucVersusAccepted)} | ${pct(s.survival.share)} | ${f(s.survival.survivorsPerNote.mean, 2)} | ${s.survival.survivorsPerNote.withNone}/${s.survival.sourceNotes} | ${s.survival.byRootPairLabel.expected} / ${s.survival.byRootPairLabel.unlabelled} / ${s.survival.byRootPairLabel.sameRoot} / ${s.survival.byRootPairLabel.forbidden} |`
    );
  }
}
lines.push("", "### Calibration (primary rows, predicate probability buckets)", "");
for (const partition of ["tuning", "holdout"] as const) {
  const table = evaluation.calibration[partition];
  if (!table) continue;
  lines.push(
    `**${partition}**`,
    "",
    "| Bucket | Rows | Mean p | Old LLM yes | Old accepted | Root expected / forbidden / unlabelled / same-root | Expected share of labelled |",
    "|---|---|---|---|---|---|---|"
  );
  for (const row of table) {
    lines.push(
      `| ${row.bucket} | ${row.rows} | ${f(row.meanProbability, 2)} | ${pct(row.oldLlmYesShare)} | ${pct(row.oldAcceptedShare)} | ${row.rootExpected} / ${row.rootForbidden} / ${row.rootUnlabelled} / ${row.sameRoot} | ${pct(row.expectedShareOfLabelled)} |`
    );
  }
  lines.push("");
}
const d = evaluation.direction;
lines.push("### Direction stability", "");
for (const [label, s] of [
  ["primary pairs", d.primaryPairs],
  ["tuning notes, all phases", d.tuningNotesOnlyAllPhases],
  ["all Spike A pairs", d.allSpikeAPairs]
] as const) {
  if (!s) continue;
  lines.push(
    `- ${label}: ${s.undirectedPairs} undirected pairs, Pearson ${f(s.pearsonLogOdds, 2)}, Spearman ${f(s.spearman, 2)}, mean |diff| ${f(s.meanAbsDifference, 2)}; at ${f(d.thresholds.retrieved, 2)}: ${s.acceptedBothDirections} both ways, ${s.acceptedEitherDirection} either way (one direction only ${pct(s.oneDirectionOnlyShare)})`
  );
}
lines.push(
  `- Pairs judged both ways by the old pipeline (${d.economyJudgedBothWays.pairs}): old LLM Pearson ${f(d.economyJudgedBothWays.oldLlmPearson, 2)} / Spearman ${f(d.economyJudgedBothWays.oldLlmSpearman, 2)}; Decisions ${f(d.economyJudgedBothWays.newPearson, 2)} / ${f(d.economyJudgedBothWays.newSpearman, 2)}`
);
lines.push(
  `- Old reverse-only acceptances: ${d.oldReverseOnly.count}/${d.oldAcceptedRelations}; one direction keeps ${d.oldReverseOnly.newDecider.keptOldDirection} (${d.oldReverseOnly.newDecider.keptBothDirections} also reverse), reverse only ${d.oldReverseOnly.newDecider.keptReverseOnly}, neither ${d.oldReverseOnly.newDecider.dropped}; max of both loses ${d.oldReverseOnly.maxBoth.dropped} (${pct(d.oldReverseOnly.maxBoth.lossShare)}), by root label ${JSON.stringify(d.oldReverseOnly.maxBoth.droppedByRootPairLabel)}`
);
lines.push(
  `- Loss as the max-both threshold falls: ${d.oldReverseOnly.lossCurve.map((p) => `${f(p.threshold, 2)}: ${pct(p.reverseOnlyLossShare)}, tuning ${p.tuningExpectedFound}/${p.tuningForbiddenFound} forb.`).join("; ")}`
);
lines.push(
  `- All ${d.oldAcceptedRelations} old acceptances: max of both loses ${d.allOldAccepted.maxBoth.dropped} (${pct(d.allOldAccepted.maxBoth.lossShare)})`
);
lines.push("", "### Runs: tokens, cost, latency", "");
lines.push(
  "| Run | Requests ok / failed | Pairs | Questions per request | Input tokens | US$ | US$ per 1k pairs | Tokens per pair | Request p50 / p95 ms | Server p50 ms | Refusals | Retried |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|"
);
for (const r of evaluation.runs) {
  lines.push(
    `| ${r.runId} | ${r.requestsOk} / ${r.requestsFailedRecords} | ${r.candidatePairs} | ${f(r.questionsPerRequestMean, 1)} | ${r.inputTokens} | ${f(r.usd, 4)} | ${f(r.usdPer1kPairs, 4)} | ${f(r.tokensPerPair, 0)} | ${r.attemptMs ? `${f(r.attemptMs.p50Ms, 0)} / ${f(r.attemptMs.p95Ms, 0)}` : "n/a"} | ${r.serverMs ? f(r.serverMs.p50Ms, 0) : "n/a"} | ${r.refusalAnswers} | ${r.retriedRequests} |`
  );
}
lines.push(
  "",
  `Total spend so far: US$ ${f(evaluation.totalSpend.usd, 4)} over ${evaluation.totalSpend.requests} requests (${evaluation.totalSpend.inputTokens} input tokens).`
);
lines.push(
  "",
  "### Score resolution",
  "",
  `${evaluation.resolution.pairs} pairs, ${evaluation.resolution.distinctValues} distinct probability values (${evaluation.resolution.decimals} decimals); ${pct(evaluation.resolution.shareAt0)} at 0.00, ${pct(evaluation.resolution.shareAt1)} at 1.00, ${pct(evaluation.resolution.shareBetween01And99)} strictly between.`
);
if (evaluation.typed) {
  const t = evaluation.typed;
  lines.push("", "### Typed configuration (tuning)", "");
  lines.push(
    `- Predicate alone: threshold p ${f(t.predicateAlone.thresholdProbability, 3)}, forward-only ${t.predicateAlone.expectedFound}/${t.predicateAlone.expectedTotal} with ${t.predicateAlone.forbiddenFound} forbidden, AUC vs old verdict ${f(t.predicateAlone.noteAucVersusLlmYes)}, ${t.predicateAlone.survivors} survivors`
  );
  lines.push(
    `- Predicate inside typed request: threshold p ${f(t.predicateInTyped.thresholdProbability, 3)}, ${t.predicateInTyped.expectedFound}/${t.predicateInTyped.expectedTotal} with ${t.predicateInTyped.forbiddenFound} forbidden, AUC ${f(t.predicateInTyped.noteAucVersusLlmYes)}, ${t.predicateInTyped.survivors} survivors; Spearman between the two ${f(t.spearmanBetweenPredicateSets, 3)}; decision flips at the predicate-only threshold ${t.decisionFlipsAtPredicateOnlyThreshold}`
  );
  lines.push(
    `- Old stored relations ${t.oldRelations} (${t.answeredRelations} answered, ${t.relationsKeptByPredicate} kept by the predicate threshold): exact type agreement ${t.exactMatches}/${t.withCounterpart} (${pct(t.exactAgreement)}) for old types with a counterpart; typed answer none for ${t.typedNoneForOldRelations}; old type counts ${JSON.stringify(t.oldTypeCounts)}`
  );
  lines.push(`- Old type -> new type: ${JSON.stringify(t.confusionOldByNew)}`);
  lines.push(
    `- Types given to the old relations that the predicate keeps: ${JSON.stringify(t.typeOfRelationsKeptByPredicate)}`
  );
  lines.push(
    `- Consistency (${t.consistency.rows} rows): predicate yes but type none ${t.consistency.predicateYesTypeNone}; predicate no but type not none ${t.consistency.predicateNoTypeNotNone}`
  );
  lines.push(
    `- Type distribution over all typed answers (forward and reverse): ${JSON.stringify(t.choiceDistributionAllRows)}`
  );
}
await writeFile(join(outputDirectory, "tables.md"), `${lines.join("\n")}\n`);
console.info(lines.join("\n"));
