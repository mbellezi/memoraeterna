/**
 * Spike A evaluation: tuning/validation metrics for every decider, written to
 * `.cache/spikes/reranker/evaluation.json` and `tables.md`.
 *
 *   npx tsx scripts/spikes/reranker/evaluate.ts
 *
 * Needs the score files from `score.ts` (frozen instruction, set `all`, MLX at batch 16 and 1,
 * both GGUF runtimes). The decision threshold of every decider is chosen on the TUNING split
 * only (zero forbidden root pairs, most expected pairs); the held-out split is only measured.
 *
 * Besides the quality tables it reports what limits how firmly they can be read: how close the
 * lowest held-out expected pair sits to the threshold (a tie counts as a pass), the resolution of
 * the bf16 log-odds, the held-out result across the whole tuning plateau, batch-size sensitivity of
 * both the one-direction and the max-of-both rule, the share of the old pipeline's reverse-only
 * acceptances that each rule keeps, and the old gate rebuilt from its parts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  aucVersusOldJudge,
  buildContext,
  evaluateSplit,
  logOddsLookup,
  oldJudgeYesAt,
  primaryPhase,
  type RowScore
} from "./core.js";
import {
  loadDataset,
  loadFrozen,
  outputDirectory,
  type DatasetRow,
  type Partition,
  type RuntimeName
} from "./dataset.js";
import {
  auc,
  chooseThreshold,
  mean,
  pairKey,
  pearson,
  percentile,
  rootOutcome,
  spearman
} from "./metrics.js";
import { loadScoreFile } from "./scores.js";

interface Decider {
  id: string;
  label: string;
  scale: "log-odds" | "probability" | "cosine";
  score: RowScore;
  /** Score of the opposite direction (rerankers only). */
  reverse?: RowScore;
}

const dataset = await loadDataset();
const context = buildContext(dataset);
const frozen = await loadFrozen();
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

async function rerankerLookup(runtime: RuntimeName, instructionId: string, batch: number) {
  const file = await loadScoreFile(runtime, instructionId, "all", batch);
  return { file, lookup: logOddsLookup(dataset.sets.all, file.logOdds) };
}

const mlx16 = await rerankerLookup("mlx", frozen.instructionId, 16);
const mlx1 = await rerankerLookup("mlx", frozen.instructionId, 1);
const ggufQwen = await rerankerLookup("gguf-qwen3", frozen.instructionId, 16);
const ggufBge = await rerankerLookup("gguf-bge", "none", 16);

function rerankerDecider(
  id: string,
  label: string,
  lookup: (query: string, doc: string) => number
): Decider {
  return {
    id,
    label,
    scale: "log-odds",
    score: (row) => lookup(row.query, row.doc),
    reverse: (row) => lookup(row.doc, row.query)
  };
}

const deciders: Decider[] = [
  rerankerDecider("mlx-qwen3", "MLX Qwen3-Reranker-0.6B (bf16)", mlx16.lookup),
  rerankerDecider("gguf-qwen3", "GGUF Qwen3-Reranker-0.6B Q8_0", ggufQwen.lookup),
  rerankerDecider("gguf-bge", "GGUF bge-reranker-v2-m3 Q8_0", ggufBge.lookup),
  { id: "cosine", label: "Cosine (vector_score)", scale: "cosine", score: (r) => r.cosine },
  {
    id: "old-llm-score",
    label: "Old LLM rerank_score (continuous)",
    scale: "probability",
    score: (r) => r.oldLlm
  }
];

// --- Per-decider assessment -------------------------------------------------------------------

interface SurvivalStats {
  candidates: number;
  survivors: number;
  share: number;
  sourceNotes: number;
  survivorsPerNote: { mean: number; median: number; p90: number; max: number; withNone: number };
  /** Survivors by the human label of their root pair (same-root pairs have no root pair). */
  byRootPairLabel: { expected: number; forbidden: number; unlabelled: number; sameRoot: number };
}

function survival(
  partition: Partition,
  rows: readonly DatasetRow[],
  keep: (row: DatasetRow) => boolean
): SurvivalStats {
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

function missingKeys(scores: Map<string, number>, keys: string[], threshold: number): string[] {
  return keys.filter((key) => (scores.get(key) ?? Number.NEGATIVE_INFINITY) < threshold);
}

function foundKeys(scores: Map<string, number>, keys: string[], threshold: number): string[] {
  return keys.filter((key) => (scores.get(key) ?? Number.NEGATIVE_INFINITY) >= threshold);
}

type Variant = "retrieved" | "max-both" | "mean-both";

function variantScore(decider: Decider, variant: Variant): RowScore {
  const reverse = decider.reverse;
  if (variant === "max-both" && reverse) return (row) => Math.max(decider.score(row), reverse(row));
  if (variant === "mean-both" && reverse) return (row) => (decider.score(row) + reverse(row)) / 2;
  return decider.score;
}

/** Labelled root pairs of one split with their score, lowest expected first (null = not retrieved). */
function rankedLabelled(
  rootScores: ReadonlyMap<string, number>,
  keys: readonly string[]
): Array<{ key: string; score: number | null }> {
  return keys
    .map((key) => ({ key, value: rootScores.get(key) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map(({ key, value }) => ({ key, score: Number.isFinite(value) ? value : null }));
}

function assess(decider: Decider, variant: Variant, fixedThreshold?: number) {
  const score = variantScore(decider, variant);
  const splits = {
    tuning: evaluateSplit(context, "tuning", score),
    holdout: evaluateSplit(context, "holdout", score)
  };
  const choice = chooseThreshold(splits.tuning.labelled);
  const threshold = fixedThreshold ?? choice?.threshold ?? null;
  const side = (partition: Partition) => {
    const split = splits[partition];
    const labels = context.labelKeys[partition];
    const outcome = threshold === null ? null : rootOutcome(split.labelled, threshold);
    const maxForbidden = Math.max(...split.labelled.forbidden);
    const retrievedExpected = split.labelled.expected.filter(Number.isFinite);
    const retrievedForbidden = split.labelled.forbidden.filter(Number.isFinite);
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
    const expectedRanked = rankedLabelled(split.rootScores, labels.expected);
    const forbiddenRanked = rankedLabelled(split.rootScores, labels.forbidden).filter(
      (entry) => entry.score !== null
    );
    const lowestExpected = expectedRanked[0] ?? null;
    return {
      rootAuc: split.rootAuc,
      /**
       * Root AUC over the labelled pairs that reached the decider (excludes unretrieved ones).
       * With every retrieved pair separated this is 1 by construction; it carries no interval.
       */
      rootAucRetrievedOnly: auc(retrievedExpected, retrievedForbidden),
      forbiddenRetrieved: retrievedForbidden.length,
      /** Note-level agreement with the old pipeline's accepted relations (same direction). */
      agreementWithOldAccepted: agreement,
      expectedTotal: labels.expected.length,
      forbiddenTotal: labels.forbidden.length,
      expectedRetrieved: split.labelled.expected.filter((s) => s > Number.NEGATIVE_INFINITY).length,
      expectedFound: outcome?.expectedFound ?? null,
      forbiddenFound: outcome?.forbiddenFound ?? null,
      /** Informational oracle: expected pairs ranked above the worst forbidden pair. */
      expectedAboveWorstForbidden: split.labelled.expected.filter((s) => s > maxForbidden).length,
      /** Lowest expected root pair and the highest retrieved forbidden one (null = none). */
      lowestExpected,
      highestRetrievedForbidden: forbiddenRanked.at(-1) ?? null,
      /** Score of the lowest expected pair minus the threshold; 0 means it passes on a tie. */
      lowestExpectedMargin:
        threshold === null || lowestExpected?.score == null
          ? null
          : lowestExpected.score - threshold,
      /** Expected pairs at the threshold or within one bf16 step (0.125 log-odds) above it. */
      expectedWithinOneStep:
        threshold === null || decider.scale !== "log-odds"
          ? null
          : split.labelled.expected.filter((s) => s >= threshold && s <= threshold + 0.125).length,
      missedExpected:
        threshold === null ? [] : missingKeys(split.rootScores, labels.expected, threshold),
      forbiddenViolations:
        threshold === null ? [] : foundKeys(split.rootScores, labels.forbidden, threshold),
      noteAucVersusLlmYes: aucVersusOldJudge(split.rows, score, "llm-yes"),
      noteAucVersusAccepted: aucVersusOldJudge(split.rows, score, "accepted"),
      survival:
        threshold === null
          ? null
          : survival(partition, split.rows, (row) => score(row) >= threshold)
    };
  };
  return {
    deciderId: decider.id,
    label: decider.label,
    variant,
    scale: decider.scale,
    threshold:
      threshold === null
        ? null
        : {
            value: threshold,
            probability: decider.scale === "log-odds" ? sigmoid(threshold) : null,
            fixed: fixedThreshold !== undefined,
            maxTuningForbidden: choice?.maxForbidden ?? null,
            lowestTuningExpectedAbove: choice?.lowestExpectedAbove ?? null
          },
    tuning: side("tuning"),
    holdout: side("holdout")
  };
}

/**
 * Sensitivity of the held-out result to the threshold, across the optimal tuning plateau. A
 * diagnostic only: the threshold is never chosen from it. It shows how many held-out pairs depend
 * on a single quantised log-odds step.
 */
function thresholdSweep(decider: Decider, variant: Variant) {
  const score = variantScore(decider, variant);
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
    .filter((value) => value > choice.maxForbidden && value <= choice.lowestExpectedAbove)
    .sort((a, b) => a - b);
  return {
    deciderId: decider.id,
    variant,
    plateau: { exclusiveLow: choice.maxForbidden, inclusiveHigh: choice.lowestExpectedAbove },
    chosen: choice.threshold,
    points: grid.map((threshold) => {
      const t = rootOutcome(tuning.labelled, threshold);
      const h = rootOutcome(holdout.labelled, threshold);
      return {
        threshold,
        tuningFound: t.expectedFound,
        tuningForbidden: t.forbiddenFound,
        holdoutFound: h.expectedFound,
        holdoutForbidden: h.forbiddenFound
      };
    })
  };
}

/** Compact view of an assessment for the batch-size comparison. */
function compactAssessment(a: ReturnType<typeof assess>) {
  return {
    threshold: a.threshold?.value ?? null,
    tuning: {
      found: a.tuning.expectedFound,
      total: a.tuning.expectedTotal,
      forbidden: a.tuning.forbiddenFound
    },
    holdout: {
      found: a.holdout.expectedFound,
      total: a.holdout.expectedTotal,
      forbidden: a.holdout.forbiddenFound,
      missed: a.holdout.missedExpected,
      lowestExpected: a.holdout.lowestExpected,
      lowestExpectedMargin: a.holdout.lowestExpectedMargin
    }
  };
}

// --- Old pipeline reference -------------------------------------------------------------------

/**
 * Root-level result of the old production rule rebuilt from its parts: the old LLM verdict
 * (`rerank_score >= 0.65`) AND the blended final score at least 0.6. Rows passing both gates but
 * not accepted show that the rebuilt gate is not exactly the production rule.
 */
const oldFinalScoreMinimum = 0.6;
function oldGate() {
  const passes = (row: DatasetRow): boolean =>
    row.oldLlm >= oldJudgeYesAt && row.finalScore >= oldFinalScoreMinimum;
  const side = (partition: Partition) => {
    const split = evaluateSplit(context, partition, (row) => (passes(row) ? 1 : 0));
    const outcome = rootOutcome(split.labelled, 1);
    const passedNotAccepted = split.rows.filter((row) => passes(row) && !row.accepted);
    return {
      expectedFound: outcome.expectedFound,
      expectedTotal: outcome.expectedTotal,
      forbiddenFound: outcome.forbiddenFound,
      passedBothGatesButNotAccepted: passedNotAccepted.length,
      ofWhichSameRoot: passedNotAccepted.filter(
        (row) => context.noteById.get(row.query)!.root === context.noteById.get(row.doc)!.root
      ).length,
      acceptedWithoutPassing: split.rows.filter((row) => row.accepted && !passes(row)).length
    };
  };
  return { tuning: side("tuning"), holdout: side("holdout") };
}

function oldPipeline() {
  const side = (partition: Partition) => {
    const split = evaluateSplit(context, partition, (row) => (row.accepted ? 1 : 0));
    const outcome = rootOutcome(split.labelled, 1);
    return {
      noteLevelExpectedFound: outcome.expectedFound,
      noteLevelForbiddenFound: outcome.forbiddenFound,
      expectedTotal: outcome.expectedTotal,
      forbiddenTotal: outcome.forbiddenTotal,
      sourceLevel: dataset.oldSourceLevel[partition],
      survival: survival(partition, split.rows, (row) => row.accepted)
    };
  };
  return { tuning: side("tuning"), holdout: side("holdout") };
}

// --- Direction stability ----------------------------------------------------------------------

/** Thresholds of the two ways to use a reranker: as retrieved (one direction) and max of both. */
interface DirectionThresholds {
  retrieved: number;
  maxBoth: number;
}

function directionStability(
  decider: Decider,
  lookup: (q: string, d: string) => number,
  thresholds: DirectionThresholds
) {
  const thr = thresholds.retrieved;
  const undirected = (rows: ReadonlyArray<readonly [string, string]>) => {
    const pairs = new Map<string, [string, string]>();
    for (const [query, doc] of rows) {
      const [a, b] = query < doc ? [query, doc] : [doc, query];
      pairs.set(`${a}|${b}`, [a, b]);
    }
    return [...pairs.values()];
  };
  const shareOf = (pairs: ReadonlyArray<readonly [string, string]>, threshold: number) => {
    const forward = pairs.map(([a, b]) => lookup(a, b));
    const backward = pairs.map(([a, b]) => lookup(b, a));
    const both = forward.filter((v, i) => v >= threshold && backward[i]! >= threshold).length;
    const either = forward.filter((v, i) => v >= threshold || backward[i]! >= threshold).length;
    return {
      undirectedPairs: pairs.length,
      pearsonLogOdds: pearson(forward, backward),
      spearman: spearman(forward, backward),
      meanAbsDifference: mean(forward.map((v, i) => Math.abs(v - backward[i]!))),
      acceptedBothDirections: both,
      acceptedEitherDirection: either,
      oneDirectionOnlyShare: either === 0 ? null : (either - both) / either
    };
  };
  const allPairs = undirected(dataset.sets.all);
  // Pairs between tuning notes only (every phase but `validate`): evidence that does not touch the
  // held-out split.
  const tuningPairs = undirected(
    dataset.rows
      .filter((row) => row.phase !== "validate")
      .map((row) => [row.query, row.doc] as const)
  );

  // The pairs the old pipeline judged in both directions (economy phase).
  const economy = context.rowsByPhase.get("economy") ?? [];
  const byPair = new Map(economy.map((row) => [`${row.query}|${row.doc}`, row]));
  const judgedBoth = economy.filter(
    (row) => row.query < row.doc && byPair.has(`${row.doc}|${row.query}`)
  );
  const oldForward = judgedBoth.map((row) => row.oldLlm);
  const oldBackward = judgedBoth.map((row) => byPair.get(`${row.doc}|${row.query}`)!.oldLlm);
  const newForward = judgedBoth.map((row) => lookup(row.query, row.doc));
  const newBackward = judgedBoth.map((row) => lookup(row.doc, row.query));

  // Old acceptances whose reverse direction was judged and rejected ("reverse-only").
  const accepted = economy.filter((row) => row.accepted);
  const reverseOnly = accepted.filter((row) => {
    const reverse = byPair.get(`${row.doc}|${row.query}`);
    return reverse !== undefined && !reverse.accepted;
  });
  const classOf = (row: DatasetRow): "expected" | "forbidden" | "unlabelled" | "sameRoot" => {
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
  const countByClass = (rows: readonly DatasetRow[]): Record<string, number> =>
    rows.reduce<Record<string, number>>((acc, row) => {
      acc[classOf(row)] = (acc[classOf(row)] ?? 0) + 1;
      return acc;
    }, {});
  const breakdown = (rows: DatasetRow[]) => {
    const count = { keptOldDirection: 0, keptBothDirections: 0, keptReverseOnly: 0, dropped: 0 };
    for (const row of rows) {
      const forwardKept = lookup(row.query, row.doc) >= thr;
      const reverseKept = lookup(row.doc, row.query) >= thr;
      if (forwardKept) count.keptOldDirection += 1;
      if (forwardKept && reverseKept) count.keptBothDirections += 1;
      if (!forwardKept && reverseKept) count.keptReverseOnly += 1;
      if (!forwardKept && !reverseKept) count.dropped += 1;
    }
    return count;
  };
  // Loss of the old acceptances when the decider scores both directions and takes the max (the
  // recommended use): an old acceptance is lost when neither direction reaches the max-both
  // threshold. The plan's F3 exit asks for at most 5% loss of the reverse-only acceptances.
  const retention = (rows: DatasetRow[], threshold = thresholds.maxBoth) => {
    const dropped = rows.filter(
      (row) => Math.max(lookup(row.query, row.doc), lookup(row.doc, row.query)) < threshold
    );
    return {
      total: rows.length,
      kept: rows.length - dropped.length,
      dropped: dropped.length,
      lossShare: rows.length === 0 ? null : dropped.length / rows.length,
      droppedByRootPairLabel: countByClass(dropped)
    };
  };
  // What lowering the max-both threshold buys: reverse-only loss against the tuning root-pair
  // result (a lower threshold admits tuning forbidden pairs, the reason the threshold sits where
  // it does).
  const tuningMaxBoth = evaluateSplit(context, "tuning", variantScore(decider, "max-both"));
  const lossCurve = [0, 0.5, 1, 1.5, 2, 3].map((offset) => {
    const threshold = thresholds.maxBoth - offset;
    const outcome = rootOutcome(tuningMaxBoth.labelled, threshold);
    return {
      threshold,
      reverseOnlyLossShare: retention(reverseOnly, threshold).lossShare,
      tuningExpectedFound: outcome.expectedFound,
      tuningForbiddenFound: outcome.forbiddenFound
    };
  });
  return {
    deciderId: decider.id,
    thresholds,
    undirectedPairs: allPairs.length,
    allPairs: shareOf(allPairs, thr),
    tuningPairsOnly: shareOf(tuningPairs, thr),
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
      share: reverseOnly.length / accepted.length,
      byRootPairLabel: countByClass(reverseOnly),
      newDecider: breakdown(reverseOnly),
      maxBoth: retention(reverseOnly),
      lossCurve
    },
    allOldAccepted: { newDecider: breakdown(accepted), maxBoth: retention(accepted) }
  };
}

// --- Run ---------------------------------------------------------------------------------------

const assessments = deciders.flatMap((decider) => [
  assess(decider, "retrieved"),
  ...(decider.reverse ? [assess(decider, "max-both"), assess(decider, "mean-both")] : [])
]);
const assessmentOf = (id: string, variant: Variant = "retrieved") =>
  assessments.find((a) => a.deciderId === id && a.variant === variant)!;

const lookups: Record<string, (q: string, d: string) => number> = {
  "mlx-qwen3": mlx16.lookup,
  "gguf-qwen3": ggufQwen.lookup,
  "gguf-bge": ggufBge.lookup
};
const stability = deciders
  .filter((decider) => decider.reverse)
  .map((decider) => {
    const retrieved = assessmentOf(decider.id).threshold;
    const maxBoth = assessmentOf(decider.id, "max-both").threshold;
    if (!retrieved || !maxBoth) return null;
    return directionStability(decider, lookups[decider.id]!, {
      retrieved: retrieved.value,
      maxBoth: maxBoth.value
    });
  })
  .filter((entry) => entry !== null);

// MLX batch-size sensitivity: the same pairs at batch 1 and batch 16. Checked for the one-direction
// rule and for the max-of-both rule (the recommended one), each with the threshold frozen on the
// batch-16 scores and with the threshold re-picked on the batch-1 scores; the mean-of-both rule is
// shown with a re-picked threshold.
const mlxThreshold = assessmentOf("mlx-qwen3").threshold?.value ?? Number.NaN;
const mlxMaxBothThreshold = assessmentOf("mlx-qwen3", "max-both").threshold?.value ?? Number.NaN;
const differences = mlx16.file.logOdds.map((v, i) => Math.abs(v - mlx1.file.logOdds[i]!));
const mlxBatch1 = rerankerDecider("mlx-qwen3-b1", "MLX batch 1", mlx1.lookup);
const undirectedAll = new Map<string, [string, string]>();
for (const [query, doc] of dataset.sets.all) {
  const [a, b] = query < doc ? [query, doc] : [doc, query];
  undirectedAll.set(`${a}|${b}`, [a, b]);
}
const maxBothScore = (lookup: (q: string, d: string) => number, a: string, b: string): number =>
  Math.max(lookup(a, b), lookup(b, a));
const batchSensitivity = {
  pairs: differences.length,
  meanAbsDifference: mean(differences),
  p99AbsDifference: percentile(differences, 0.99),
  maxAbsDifference: Math.max(...differences),
  pearson: pearson(mlx16.file.logOdds, mlx1.file.logOdds),
  decisionFlipsAtThreshold: mlx16.file.logOdds.filter(
    (v, i) => v >= mlxThreshold !== mlx1.file.logOdds[i]! >= mlxThreshold
  ).length,
  /** Undirected pairs whose max-of-both decision differs between batch 16 and batch 1. */
  maxBothDecisionFlipsAtThreshold: [...undirectedAll.values()].filter(
    ([a, b]) =>
      maxBothScore(mlx16.lookup, a, b) >= mlxMaxBothThreshold !==
      maxBothScore(mlx1.lookup, a, b) >= mlxMaxBothThreshold
  ).length,
  oneDirection: {
    batch16: compactAssessment(assessmentOf("mlx-qwen3")),
    batch1AtBatch16Threshold: compactAssessment(assess(mlxBatch1, "retrieved", mlxThreshold)),
    batch1ThresholdRepicked: compactAssessment(assess(mlxBatch1, "retrieved"))
  },
  meanBoth: {
    batch16: compactAssessment(assessmentOf("mlx-qwen3", "mean-both")),
    batch1ThresholdRepicked: compactAssessment(assess(mlxBatch1, "mean-both"))
  },
  maxBoth: {
    batch16: compactAssessment(assessmentOf("mlx-qwen3", "max-both")),
    batch1AtBatch16Threshold: compactAssessment(assess(mlxBatch1, "max-both", mlxMaxBothThreshold)),
    batch1ThresholdRepicked: compactAssessment(assess(mlxBatch1, "max-both"))
  }
};

// Resolution of the MLX log-odds around the recommended threshold (bf16 logits are coarse).
const distinctMlx = [...new Set(mlx16.file.logOdds)].sort((a, b) => a - b);
const nearThreshold = distinctMlx.filter((value) => Math.abs(value - mlxMaxBothThreshold) <= 1);
const logOddsResolution = {
  pairs: mlx16.file.logOdds.length,
  distinctValues: distinctMlx.length,
  nearThresholdWithinOne: {
    distinctValues: nearThreshold.length,
    minStep: Math.min(...nearThreshold.slice(1).map((v, i) => v - nearThreshold[i]!)),
    maxStep: Math.max(...nearThreshold.slice(1).map((v, i) => v - nearThreshold[i]!))
  }
};

const thresholdSweeps = [
  thresholdSweep(deciders[0]!, "retrieved"),
  thresholdSweep(deciders[0]!, "max-both"),
  thresholdSweep(deciders[1]!, "retrieved"),
  thresholdSweep(deciders[1]!, "max-both")
].filter((entry) => entry !== null);

// Value beyond cosine: AUC against the old judge's verdict inside the stratum the cosine already
// passes (rows at or above the cosine threshold chosen on tuning). A decider that only repeats
// the cosine would sit near 0.5 here.
const cosineThreshold = assessmentOf("cosine").threshold?.value ?? Number.NaN;
const cosineStratum = Object.fromEntries(
  (["tuning", "holdout"] as const).map((partition) => {
    const rows = (context.rowsByPhase.get(primaryPhase[partition]) ?? []).filter(
      (row) => row.cosine >= cosineThreshold
    );
    const entry = (score: RowScore) => aucVersusOldJudge(rows, score, "llm-yes");
    return [
      partition,
      {
        rows: rows.length,
        oldJudgeYes: rows.filter((row) => row.oldLlm >= oldJudgeYesAt).length,
        aucCosine: entry((row) => row.cosine),
        aucMlx: entry(deciders[0]!.score),
        aucGgufQwen3: entry(deciders[1]!.score),
        aucGgufBge: entry(deciders[2]!.score)
      }
    ];
  })
);

// Retrieval ceiling of each phase's shortlist (expected tuning pairs with any candidate row).
const retrievalCeiling = (["baseline", "economy", "coverage"] as const).map((phase) => {
  const rows = context.rowsByPhase.get(phase) ?? [];
  const linked = new Set(
    rows.map((row) =>
      pairKey(context.noteById.get(row.query)!.root, context.noteById.get(row.doc)!.root)
    )
  );
  return {
    phase,
    candidatesPerNote: rows.length / new Set(rows.map((row) => row.query)).size,
    expectedWithACandidate: context.labelKeys.tuning.expected.filter((key) => linked.has(key))
      .length,
    expectedTotal: context.labelKeys.tuning.expected.length
  };
});

let latency: unknown;
try {
  latency = JSON.parse(await readFile(join(outputDirectory, "latency.json"), "utf8"));
} catch {
  latency = null;
}

const evaluation = {
  generatedAt: new Date().toISOString(),
  frozenInstruction: frozen,
  oldJudgeYesAt,
  primaryPhases: primaryPhase,
  scoreFiles: {
    mlx: { ...mlx16.file, logOdds: undefined },
    ggufQwen3: { ...ggufQwen.file, logOdds: undefined },
    ggufBge: { ...ggufBge.file, logOdds: undefined },
    mlxBatch1: { ...mlx1.file, logOdds: undefined }
  },
  oldPipeline: oldPipeline(),
  oldGate: oldGate(),
  assessments,
  stability,
  batchSensitivity,
  logOddsResolution,
  thresholdSweeps,
  cosineStratum: { cosineThreshold, ...cosineStratum },
  retrievalCeiling,
  latency
};
await writeFile(
  join(outputDirectory, "evaluation.json"),
  `${JSON.stringify(evaluation, null, 2)}\n`
);

// --- Tables ------------------------------------------------------------------------------------

const f = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits);
const pct = (value: number | null | undefined): string =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;

const labelBreakdown = (b: SurvivalStats["byRootPairLabel"]): string =>
  `${b.expected} / ${b.unlabelled} / ${b.sameRoot} / ${b.forbidden}`;

const lines: string[] = [];
lines.push(`Frozen instruction: ${frozen.instructionId}`);
lines.push("", "### Root-level quality (threshold chosen on tuning)", "");
lines.push(
  "Root AUC counts a pair that never reached the decider as the lowest score; the second AUC uses only the labelled pairs that did reach it (with perfect separation it is 1 by construction and has no interval).",
  "",
  "| Decider | Variant | Threshold | Tuning found / forb. | Tuning root AUC / retrieved-only AUC | Holdout found / forb. | Holdout root AUC / retrieved-only AUC | Lowest holdout expected pair (score, margin over threshold) | Holdout separable (oracle) | Forbidden pairs that reach the decider (tuning / holdout) |",
  "|---|---|---|---|---|---|---|---|---|---|"
);
for (const a of assessments) {
  const t = a.threshold;
  const low = a.holdout.lowestExpected;
  lines.push(
    `| ${a.label} | ${a.variant} | ${t ? f(t.value, 4) : "none"} | ` +
      `${a.tuning.expectedFound}/${a.tuning.expectedTotal}, ${a.tuning.forbiddenFound}/${a.tuning.forbiddenTotal} | ` +
      `${f(a.tuning.rootAuc)} / ${f(a.tuning.rootAucRetrievedOnly)} | ` +
      `${a.holdout.expectedFound}/${a.holdout.expectedTotal}, ${a.holdout.forbiddenFound}/${a.holdout.forbiddenTotal} | ` +
      `${f(a.holdout.rootAuc)} / ${f(a.holdout.rootAucRetrievedOnly)} | ` +
      `${low ? `${low.key} ${f(low.score, 4)} (${f(a.holdout.lowestExpectedMargin, 4)})` : "n/a"} | ${a.holdout.expectedAboveWorstForbidden}/${a.holdout.expectedTotal} | ` +
      `${a.tuning.forbiddenRetrieved}/${a.tuning.forbiddenTotal} / ${a.holdout.forbiddenRetrieved}/${a.holdout.forbiddenTotal} |`
  );
}
const old = evaluation.oldPipeline;
lines.push(
  `| Old LLM pipeline, note level | production rule | n/a | ${old.tuning.noteLevelExpectedFound}/${old.tuning.expectedTotal}, ${old.tuning.noteLevelForbiddenFound}/${old.tuning.forbiddenTotal} | n/a | ${old.holdout.noteLevelExpectedFound}/${old.holdout.expectedTotal}, ${old.holdout.noteLevelForbiddenFound}/${old.holdout.forbiddenTotal} | n/a | n/a | n/a | n/a |`,
  `| Old LLM pipeline, source level | production rule | n/a | ${old.tuning.sourceLevel.expectedFound}/${old.tuning.sourceLevel.expectedTotal}, ${old.tuning.sourceLevel.forbiddenFound}/${old.tuning.forbiddenTotal} | n/a | ${old.holdout.sourceLevel.expectedFound}/${old.holdout.sourceLevel.expectedTotal}, ${old.holdout.sourceLevel.forbiddenFound}/${old.holdout.forbiddenTotal} | n/a | n/a | n/a | n/a |`
);
const gate = evaluation.oldGate;
lines.push(
  "",
  `Old gate rebuilt (old LLM >= ${oldJudgeYesAt} and final >= ${oldFinalScoreMinimum}), root level: tuning ${gate.tuning.expectedFound}/${gate.tuning.expectedTotal}, ${gate.tuning.forbiddenFound} forbidden; holdout ${gate.holdout.expectedFound}/${gate.holdout.expectedTotal}, ${gate.holdout.forbiddenFound} forbidden. ` +
    `Rows passing both gates but not accepted: tuning ${gate.tuning.passedBothGatesButNotAccepted} (${gate.tuning.ofWhichSameRoot} same-root), holdout ${gate.holdout.passedBothGatesButNotAccepted} (${gate.holdout.ofWhichSameRoot} same-root); accepted without passing: tuning ${gate.tuning.acceptedWithoutPassing}, holdout ${gate.holdout.acceptedWithoutPassing}.`
);

lines.push("", "### Log-odds resolution and threshold sensitivity", "");
lines.push(
  `MLX batch-16 log-odds: ${logOddsResolution.distinctValues} distinct values over ${logOddsResolution.pairs} pairs; within 1.0 of the max-both threshold ${f(mlxMaxBothThreshold, 4)}: ${logOddsResolution.nearThresholdWithinOne.distinctValues} values, adjacent steps ${f(logOddsResolution.nearThresholdWithinOne.minStep, 4)} to ${f(logOddsResolution.nearThresholdWithinOne.maxStep, 4)}.`,
  "",
  "Diagnostic only (the threshold is never chosen from it): every threshold on the tuning plateau (worst tuning forbidden pair, exclusive, up to the lowest tuning expected pair above it, inclusive) with its tuning and held-out result.",
  ""
);
for (const sweep of thresholdSweeps) {
  // The result is constant on (previous grid value, grid value]; print each run of equal results
  // as one half-open threshold range.
  const runs: string[] = [];
  let start = 0;
  let lower = sweep.plateau.exclusiveLow;
  for (let index = 1; index <= sweep.points.length; index += 1) {
    const first = sweep.points[start]!;
    const next = sweep.points[index];
    if (
      next &&
      next.tuningFound === first.tuningFound &&
      next.holdoutFound === first.holdoutFound &&
      next.holdoutForbidden === first.holdoutForbidden
    )
      continue;
    const last = sweep.points[index - 1]!;
    runs.push(
      `(${f(lower, 4)}, ${f(last.threshold, 4)}]: tuning ${first.tuningFound}/${context.labelKeys.tuning.expected.length}, holdout ${first.holdoutFound}/${context.labelKeys.holdout.expected.length} with ${first.holdoutForbidden} forbidden`
    );
    lower = last.threshold;
    start = index;
  }
  lines.push(
    `- ${sweep.deciderId} (${sweep.variant}), plateau (${f(sweep.plateau.exclusiveLow, 4)}, ${f(sweep.plateau.inclusiveHigh, 4)}], chosen ${f(sweep.chosen, 4)}: ${runs.join("; ")}`
  );
}

lines.push("", "### Misses and violations at the frozen threshold (retrieved variant)", "");
for (const a of assessments.filter((x) => x.variant === "retrieved")) {
  lines.push(
    `- ${a.deciderId}: tuning missed [${a.tuning.missedExpected.join(", ")}] violations [${a.tuning.forbiddenViolations.join(", ")}]; ` +
      `holdout missed [${a.holdout.missedExpected.join(", ")}] violations [${a.holdout.forbiddenViolations.join(", ")}]`
  );
}

lines.push("", "### Note level: AUC against the old judge, and survivors", "");
lines.push(
  "| Decider | Split | AUC vs old verdict (rerank >= 0.65) | AUC vs old accepted | Candidates | Survivors | Share | Survivors per note mean / median / p90 / max | Notes with none | Survivors by root-pair label: expected / unlabelled / same-root / forbidden |",
  "|---|---|---|---|---|---|---|---|---|---|"
);
for (const a of assessments) {
  for (const partition of ["tuning", "holdout"] as const) {
    const side = a[partition];
    const s = side.survival;
    lines.push(
      `| ${a.label} (${a.variant}) | ${partition} | ${f(side.noteAucVersusLlmYes)} | ${f(side.noteAucVersusAccepted)} | ${s?.candidates ?? "n/a"} | ${s?.survivors ?? "n/a"} | ${pct(s?.share)} | ` +
        `${s ? `${f(s.survivorsPerNote.mean, 2)} / ${f(s.survivorsPerNote.median, 1)} / ${f(s.survivorsPerNote.p90, 1)} / ${s.survivorsPerNote.max}` : "n/a"} | ${s ? `${s.survivorsPerNote.withNone}/${s.sourceNotes}` : "n/a"} | ${s ? labelBreakdown(s.byRootPairLabel) : "n/a"} |`
    );
  }
}
for (const partition of ["tuning", "holdout"] as const) {
  const s = old[partition].survival;
  lines.push(
    `| Old LLM pipeline (accepted) | ${partition} | n/a | n/a | ${s.candidates} | ${s.survivors} | ${pct(s.share)} | ${f(s.survivorsPerNote.mean, 2)} / ${f(s.survivorsPerNote.median, 1)} / ${f(s.survivorsPerNote.p90, 1)} / ${s.survivorsPerNote.max} | ${s.survivorsPerNote.withNone}/${s.sourceNotes} | ${labelBreakdown(s.byRootPairLabel)} |`
  );
}

lines.push("", "### Direction stability", "");
for (const s of stability) {
  const reverse = s.oldReverseOnly;
  lines.push(
    `- ${s.deciderId}: all ${s.undirectedPairs} undirected pairs scored both ways; Pearson ${f(s.allPairs.pearsonLogOdds)}, Spearman ${f(s.allPairs.spearman)}, mean |diff| ${f(s.allPairs.meanAbsDifference, 2)} log-odds; ` +
      `at the one-direction threshold ${f(s.thresholds.retrieved, 4)}: ${s.allPairs.acceptedBothDirections} accepted both ways, ${s.allPairs.acceptedEitherDirection} either way (one direction only: ${pct(s.allPairs.oneDirectionOnlyShare)}). ` +
      `Tuning notes only (${s.tuningPairsOnly.undirectedPairs} pairs): Pearson ${f(s.tuningPairsOnly.pearsonLogOdds)}, ${s.tuningPairsOnly.acceptedBothDirections} both ways, ${s.tuningPairsOnly.acceptedEitherDirection} either way (one direction only: ${pct(s.tuningPairsOnly.oneDirectionOnlyShare)}). ` +
      `Pairs judged both ways by the old pipeline (${s.economyJudgedBothWays.pairs}): old LLM Pearson ${f(s.economyJudgedBothWays.oldLlmPearson)} / Spearman ${f(s.economyJudgedBothWays.oldLlmSpearman)} vs new ${f(s.economyJudgedBothWays.newPearson)} / ${f(s.economyJudgedBothWays.newSpearman)}. ` +
      `Old reverse-only acceptances: ${reverse.count}/${s.oldAcceptedRelations} (${pct(reverse.share)}), root-pair labels ${JSON.stringify(reverse.byRootPairLabel)}; one direction at ${f(s.thresholds.retrieved, 4)} keeps the old direction for ${reverse.newDecider.keptOldDirection} (${reverse.newDecider.keptBothDirections} also in the reverse), accepts only the reverse for ${reverse.newDecider.keptReverseOnly}, neither direction for ${reverse.newDecider.dropped}. ` +
      `Max of both directions at ${f(s.thresholds.maxBoth, 4)}: keeps ${reverse.maxBoth.kept}, loses ${reverse.maxBoth.dropped} (${pct(reverse.maxBoth.lossShare)}; plan target at most 5%), lost by root-pair label ${JSON.stringify(reverse.maxBoth.droppedByRootPairLabel)}. ` +
      `Loss as the max-both threshold falls (threshold: loss, tuning found/forbidden): ${reverse.lossCurve.map((point) => `${f(point.threshold, 2)}: ${pct(point.reverseOnlyLossShare)}, ${point.tuningExpectedFound}/${context.labelKeys.tuning.expected.length}/${point.tuningForbiddenFound}`).join("; ")}. ` +
      `Of all ${s.oldAcceptedRelations} old acceptances: the old direction passes for ${s.allOldAccepted.newDecider.keptOldDirection} at ${f(s.thresholds.retrieved, 4)}; max of both loses ${s.allOldAccepted.maxBoth.dropped} (${pct(s.allOldAccepted.maxBoth.lossShare)}).`
  );
}

lines.push("", "### MLX batch-size sensitivity (batch 1 vs 16)", "");
const compactLine = (label: string, c: ReturnType<typeof compactAssessment>): string =>
  `${label}: threshold ${f(c.threshold, 4)}, tuning ${c.tuning.found}/${c.tuning.total} with ${c.tuning.forbidden} forbidden, holdout ${c.holdout.found}/${c.holdout.total} with ${c.holdout.forbidden} forbidden` +
  (c.holdout.missed.length ? ` (missed ${c.holdout.missed.join(", ")})` : "") +
  (c.holdout.lowestExpected
    ? `; lowest holdout expected ${c.holdout.lowestExpected.key} ${f(c.holdout.lowestExpected.score, 4)} (margin ${f(c.holdout.lowestExpectedMargin, 4)})`
    : "");
lines.push(
  `pairs ${batchSensitivity.pairs}, Pearson ${f(batchSensitivity.pearson, 5)}, mean |diff| ${f(batchSensitivity.meanAbsDifference, 3)}, p99 ${f(batchSensitivity.p99AbsDifference, 3)}, max ${f(batchSensitivity.maxAbsDifference, 3)} log-odds; ` +
    `directed decision flips at the one-direction threshold: ${batchSensitivity.decisionFlipsAtThreshold}; undirected max-of-both decision flips at its threshold: ${batchSensitivity.maxBothDecisionFlipsAtThreshold}.`,
  "",
  `- One direction, ${compactLine("batch 16", batchSensitivity.oneDirection.batch16)}`,
  `- One direction, ${compactLine("batch 1, batch-16 threshold", batchSensitivity.oneDirection.batch1AtBatch16Threshold)}`,
  `- One direction, ${compactLine("batch 1, threshold re-picked", batchSensitivity.oneDirection.batch1ThresholdRepicked)}`,
  `- Max of both, ${compactLine("batch 16", batchSensitivity.maxBoth.batch16)}`,
  `- Max of both, ${compactLine("batch 1, batch-16 threshold", batchSensitivity.maxBoth.batch1AtBatch16Threshold)}`,
  `- Max of both, ${compactLine("batch 1, threshold re-picked", batchSensitivity.maxBoth.batch1ThresholdRepicked)}`,
  `- Mean of both, ${compactLine("batch 16", batchSensitivity.meanBoth.batch16)}`,
  `- Mean of both, ${compactLine("batch 1, threshold re-picked", batchSensitivity.meanBoth.batch1ThresholdRepicked)}`
);

lines.push("", "### Agreement with the old verdict inside the cosine-passing stratum", "");
for (const partition of ["tuning", "holdout"] as const) {
  const c = cosineStratum[partition]!;
  lines.push(
    `- ${partition}: ${c.rows} rows with cosine >= ${f(cosineThreshold, 2)}, ${c.oldJudgeYes} of them yes for the old judge; AUC cosine ${f(c.aucCosine)}, MLX ${f(c.aucMlx)}, GGUF Qwen3 ${f(c.aucGgufQwen3)}, GGUF bge ${f(c.aucGgufBge)}`
  );
}

lines.push("", "### Retrieval ceiling (tuning)", "");
for (const c of retrievalCeiling) {
  lines.push(
    `- ${c.phase}: ${f(c.candidatesPerNote, 1)} candidates per note, ${c.expectedWithACandidate}/${c.expectedTotal} expected root pairs have at least one candidate row`
  );
}
lines.push("", "### Note-level agreement with the old pipeline's accepted relations", "");
for (const a of assessments) {
  for (const partition of ["tuning", "holdout"] as const) {
    const g = a[partition].agreementWithOldAccepted;
    lines.push(
      `- ${a.deciderId} (${a.variant}) ${partition}: both accept ${g.tp}, only the decider ${g.fp}, only the old pipeline ${g.fn}, neither ${g.tn}`
    );
  }
}

if (latency) {
  lines.push("", "### Latency", "");
  const l = latency as {
    results: Array<{
      runtime: string;
      singlePairCall: { wall: { p50Ms: number; p95Ms: number }; device?: { p50Ms: number } };
      perNote8: { wall: { meanMs: number; p95Ms: number } };
      perNote20: { wall: { meanMs: number; p95Ms: number } };
      perNote20Batch32?: { wall: { meanMs: number } };
      meanTokensPerPair: number | null;
      openMs: number;
      firstCallMs: number;
      estimate200Notes8Candidates: { minutesAtMeanPerNote: number };
    }>;
  };
  // Minutes for 200 notes, every note taking the given time, in `directions` scoring passes. The p95
  // column assumes every note is as slow as the per-note p95, so it is an upper bound.
  const minutes = (perNoteMs: number, directions: number): number =>
    (200 * directions * perNoteMs) / 60_000;
  lines.push(
    "| Runtime | Single pair p50 / p95 (ms) | Note x8 mean / p95 (ms) | Note x20 mean / p95 (ms) | ms per pair at x8 / x20 | 200 notes x 8, one direction (min, mean) | 200 notes x 8, both ways (min, mean / p95) | 200 notes x 20, both ways (min, mean / p95) | Open + first call (ms) |",
    "|---|---|---|---|---|---|---|---|---|"
  );
  for (const r of l.results) {
    lines.push(
      `| ${r.runtime} | ${f(r.singlePairCall.wall.p50Ms, 1)} / ${f(r.singlePairCall.wall.p95Ms, 1)} | ${f(r.perNote8.wall.meanMs, 0)} / ${f(r.perNote8.wall.p95Ms, 0)} | ` +
        `${f(r.perNote20.wall.meanMs, 0)} / ${f(r.perNote20.wall.p95Ms, 0)} | ${f(r.perNote8.wall.meanMs / 8, 1)} / ${f(r.perNote20.wall.meanMs / 20, 1)} | ` +
        `${f(r.estimate200Notes8Candidates.minutesAtMeanPerNote, 2)} | ` +
        `${f(minutes(r.perNote8.wall.meanMs, 2), 2)} / ${f(minutes(r.perNote8.wall.p95Ms, 2), 2)} | ` +
        `${f(minutes(r.perNote20.wall.meanMs, 2), 2)} / ${f(minutes(r.perNote20.wall.p95Ms, 2), 2)} | ${f(r.openMs, 0)} + ${f(r.firstCallMs, 0)} |`
    );
  }
}

await writeFile(join(outputDirectory, "tables.md"), `${lines.join("\n")}\n`);
console.info(lines.join("\n"));
