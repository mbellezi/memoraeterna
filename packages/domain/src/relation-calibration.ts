// Calibration of the relation decider (F3 D13, D18; spec 3.9). Pure functions only: the
// aggregation of a pair's two directions, the weighted isotonic fit, the bands, weighted precision
// with its Wilson bound, the pre-registered band selection and reconcile. The values they work with
// live in `relations-config.ts`; T58 fits and freezes them, and recalibration re-applies bands to
// stored raw scores without deciding again.
import { z } from "zod";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const score = z.number().finite();
const probability = z.number().min(0).max(1);

/** How a pair's two directed log-odds become one score `s` (D18; the selection rule picks). */
export const relationAggregationRules = ["max", "mean"] as const;
export const RelationAggregationRuleSchema = z.enum(relationAggregationRules);
export type RelationAggregationRule = z.infer<typeof RelationAggregationRuleSchema>;

/**
 * What a calibration belongs to (D13): the decide contract, the exact instruction text (its hash),
 * the text template and its body length, the aggregation rule and the ranker model (provider,
 * model, runtime kind, repository, revision, quantization and artifact). The runtime build and the
 * helper batch size are not part of it: a rebuilt helper keeps its calibration while the parity
 * check passes.
 */
export const RelationCalibrationIdentitySchema = z
  .object({
    contract: z.string().min(1).max(100),
    instructionSha256: sha256Hex,
    template: z.string().min(1).max(100),
    bodyCharacters: z.number().int().min(1).max(10_000),
    rule: RelationAggregationRuleSchema,
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    runtimeKind: z.enum(["mlx", "gguf"]),
    repository: z.string().min(1).max(300),
    revision: z.string().min(1).max(200),
    quantization: z.string().min(1).max(100),
    artifactSha256: sha256Hex
  })
  .strict();
export type RelationCalibrationIdentity = z.infer<typeof RelationCalibrationIdentitySchema>;

/** The lookup key of an identity: its fields in a fixed order, whatever the object's key order. */
export function relationCalibrationIdentityKey(identity: RelationCalibrationIdentity): string {
  return JSON.stringify([
    identity.contract,
    identity.instructionSha256,
    identity.template,
    identity.bodyCharacters,
    identity.rule,
    identity.provider,
    identity.model,
    identity.runtimeKind,
    identity.repository,
    identity.revision,
    identity.quantization,
    identity.artifactSha256
  ]);
}

/**
 * One step of an isotonic map: scores from `fromScore` up to the next block's map to
 * `probability`. A score below the first block takes the first block's probability (flat outside
 * the observed range).
 */
export const RelationCalibrationBlockSchema = z.object({ fromScore: score, probability }).strict();
export type RelationCalibrationBlock = z.infer<typeof RelationCalibrationBlockSchema>;

/** The 64-pair scores a calibration was fitted with, compared on every runtime-build change (D13). */
export const RelationCalibrationParitySchema = z
  .object({ referenceHash: sha256Hex, scores: z.array(score).min(1) })
  .strict();

/**
 * A calibration of one identity. `threshold`: a provisional rule on the raw score (Spike A's frozen
 * thresholds until T58 freezes), with no probability. `isotonic`: the frozen calibration of T58, a
 * probability per score (the panel's weighted isotonic map, reported) and the bands as score edges:
 * plan decision 29 chooses the suggest edge on the fixture tuning partition, which a probability
 * level of a step map could express only at a block start, and sets no apply band (null).
 */
export const RelationCalibrationEntrySchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("threshold"),
        identity: RelationCalibrationIdentitySchema,
        /** The apply band starts at this score. */
        applyAt: score,
        /** The suggest band starts here; null means no suggest band. */
        suggestAt: score.nullable(),
        /** Where the thresholds come from. */
        basis: z.string().min(1).max(300)
      })
      .strict(),
    z
      .object({
        kind: z.literal("isotonic"),
        identity: RelationCalibrationIdentitySchema,
        blocks: z.array(RelationCalibrationBlockSchema).min(1),
        /** The apply band starts at this score; null: no apply band (decision 29). */
        applyFrom: score.nullable(),
        /** The suggest band starts at this score; null: no suggest band. */
        suggestFrom: score.nullable(),
        /** How the edges were chosen. */
        basis: z.string().min(1).max(300),
        labelSetHash: sha256Hex,
        freezeHash: sha256Hex,
        fittedAt: z.iso.datetime(),
        parity: RelationCalibrationParitySchema
      })
      .strict()
  ])
  .superRefine((entry, context) => {
    if (entry.kind === "threshold") {
      if (entry.suggestAt !== null && entry.suggestAt > entry.applyAt)
        context.addIssue({ code: "custom", message: "The suggest band starts above apply." });
      return;
    }
    for (let index = 1; index < entry.blocks.length; index++) {
      const previous = entry.blocks[index - 1]!,
        current = entry.blocks[index]!;
      if (current.fromScore <= previous.fromScore || current.probability < previous.probability)
        context.addIssue({
          code: "custom",
          message: "Calibration blocks increase in score and never decrease in probability.",
          path: ["blocks", index]
        });
    }
    if (
      entry.suggestFrom !== null &&
      entry.applyFrom !== null &&
      entry.suggestFrom > entry.applyFrom
    )
      context.addIssue({ code: "custom", message: "The suggest band starts above apply." });
  });
export type RelationCalibrationEntry = z.infer<typeof RelationCalibrationEntrySchema>;

/** One score of a pair from its two directed log-odds. */
export function aggregateDirections(
  loToHi: number,
  hiToLo: number,
  rule: RelationAggregationRule
): number {
  if (!Number.isFinite(loToHi) || !Number.isFinite(hiToLo))
    throw new Error("Both directions need a finite score.");
  return rule === "max" ? Math.max(loToHi, hiToLo) : (loToHi + hiToLo) / 2;
}

/** The probability of a score under an isotonic map (a step function, flat outside its range). */
export function calibrate(value: number, blocks: readonly RelationCalibrationBlock[]): number {
  if (blocks.length === 0) throw new Error("A calibration needs at least one block.");
  let low = 0,
    high = blocks.length - 1,
    found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.fromScore <= value) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return blocks[found]!.probability;
}

/** One labelled score of a fit. `weight` is the label's population weight (default 1). */
export interface IsotonicPoint {
  score: number;
  positive: boolean;
  weight?: number;
}

interface Pool {
  fromScore: number;
  /** Labels in the pool. */
  count: number;
  /** Weighted labels and weighted positives. */
  weight: number;
  positive: number;
}

const merged = (left: Pool, right: Pool): Pool => ({
  fromScore: left.fromScore,
  count: left.count + right.count,
  weight: left.weight + right.weight,
  positive: left.positive + right.positive
});

/** Pool-adjacent-violators: merges neighbours until `value` never decreases. */
function poolAdjacentViolators(pools: readonly Pool[], value: (pool: Pool) => number): Pool[] {
  const stack: Pool[] = [];
  for (const pool of pools) {
    stack.push(pool);
    while (stack.length > 1 && value(stack.at(-2)!) > value(stack.at(-1)!)) {
      const right = stack.pop()!,
        left = stack.pop()!;
      stack.push(merged(left, right));
    }
  }
  return stack;
}

/**
 * The weighted isotonic fit of D18 (R18): labels of tied scores are grouped, weighted PAV runs on
 * the positive share, adjacent blocks merge until each holds at least `minBlock` labels, each block
 * is smoothed to (k + a) / (n + a + b) on its weighted counts, and weighted PAV runs again so the
 * smoothed map never decreases. Weights are normalized to a mean of 1, so weighted counts stay on
 * the scale of the label counts the prior is meant for. Throws without points.
 */
export function fitIsotonic(
  points: readonly IsotonicPoint[],
  options: { minBlock?: number; prior?: readonly [number, number] } = {}
): RelationCalibrationBlock[] {
  if (points.length === 0) throw new Error("An isotonic fit needs labelled points.");
  const minBlock = Math.max(1, Math.floor(options.minBlock ?? 15));
  const [priorPositive, priorNegative] = options.prior ?? [1, 1];
  for (const point of points)
    if (!Number.isFinite(point.score) || !((point.weight ?? 1) > 0))
      throw new Error("Every point needs a finite score and a positive weight.");
  const totalWeight = points.reduce((total, point) => total + (point.weight ?? 1), 0);
  const scale = points.length / totalWeight;
  const sorted = [...points].sort((left, right) => left.score - right.score);
  const ties: Pool[] = [];
  for (const point of sorted) {
    const weight = (point.weight ?? 1) * scale;
    const last = ties.at(-1);
    const pool = {
      fromScore: point.score,
      count: 1,
      weight,
      positive: point.positive ? weight : 0
    };
    if (last && last.fromScore === point.score) ties[ties.length - 1] = merged(last, pool);
    else ties.push(pool);
  }
  const raw = poolAdjacentViolators(ties, (pool) => pool.positive / pool.weight);
  // Adjacent merges of a monotone sequence stay monotone; a short tail joins the block before it.
  const sized: Pool[] = [];
  let open: Pool | null = null;
  for (const pool of raw) {
    open = open ? merged(open, pool) : pool;
    if (open.count >= minBlock) {
      sized.push(open);
      open = null;
    }
  }
  if (open) {
    const last = sized.pop();
    sized.push(last ? merged(last, open) : open);
  }
  const smoothed = (pool: Pool) =>
    (pool.positive + priorPositive) / (pool.weight + priorPositive + priorNegative);
  return poolAdjacentViolators(sized, smoothed).map((pool) => ({
    fromScore: pool.fromScore,
    probability: smoothed(pool)
  }));
}

/** The calibration state a band was decided under. */
export type RelationCalibrationState = "frozen" | "provisional" | "uncalibrated";

export interface RelationBandDecision {
  band: "apply" | "suggest" | null;
  /** The calibrated probability; null when no isotonic map produced one (unknown stays unknown). */
  probability: number | null;
  calibration: RelationCalibrationState;
}

/**
 * The band of a score. With no calibration entry, or an entry the decider no longer matches (a
 * failed parity check), the decider is uncalibrated: a score at or above `uncalibratedPass` is only
 * suggested, never applied (D18).
 */
export function bandScore(
  value: number,
  entry: RelationCalibrationEntry | null,
  uncalibratedPass: number
): RelationBandDecision {
  if (!entry)
    return {
      band: value >= uncalibratedPass ? "suggest" : null,
      probability: null,
      calibration: "uncalibrated"
    };
  if (entry.kind === "threshold")
    return {
      band:
        value >= entry.applyAt
          ? "apply"
          : entry.suggestAt !== null && value >= entry.suggestAt
            ? "suggest"
            : null,
      probability: null,
      calibration: "provisional"
    };
  return {
    band:
      entry.applyFrom !== null && value >= entry.applyFrom
        ? "apply"
        : entry.suggestFrom !== null && value >= entry.suggestFrom
          ? "suggest"
          : null,
    probability: calibrate(value, entry.blocks),
    calibration: "frozen"
  };
}

/**
 * Where the bands start in score space: the lowest score that applies or is suggested, null when
 * there is no such band.
 */
export function bandThresholds(entry: RelationCalibrationEntry): {
  apply: number | null;
  suggest: number | null;
} {
  if (entry.kind === "threshold") return { apply: entry.applyAt, suggest: entry.suggestAt };
  return { apply: entry.applyFrom, suggest: entry.suggestFrom };
}

/** The Wilson score interval's lower bound of a share `p` over `n` observations (95% by default). */
export function wilsonLowerBound(p: number, n: number, z = 1.959963984540054): number {
  if (!(n > 0)) return 0;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/**
 * Population-weighted precision of labelled pairs (D4): the weighted share of positives, the
 * effective number of labels (Kish: (sum w)^2 / sum w^2) and the Wilson lower bound at that
 * number. Null without labels.
 */
export function weightedPrecision(
  labels: ReadonlyArray<{ positive: boolean; weight?: number }>
): { precision: number; effectiveCount: number; wilsonLower: number } | null {
  let total = 0,
    squares = 0,
    positive = 0;
  for (const label of labels) {
    const weight = label.weight ?? 1;
    if (!(weight > 0)) throw new Error("A label weight is positive.");
    total += weight;
    squares += weight * weight;
    if (label.positive) positive += weight;
  }
  if (total === 0) return null;
  const precision = positive / total;
  const effectiveCount = (total * total) / squares;
  return { precision, effectiveCount, wilsonLower: wilsonLowerBound(precision, effectiveCount) };
}

/**
 * The population weight of each stratum (D4): the candidates of the stratum in the population over
 * the labels of the stratum. A stratum with labels and no population count is an error.
 */
export function stratumWeights(
  population: Readonly<Record<string, number>>,
  labelStrata: readonly string[]
): Map<string, number> {
  const labelled = new Map<string, number>();
  for (const stratum of labelStrata) labelled.set(stratum, (labelled.get(stratum) ?? 0) + 1);
  const weights = new Map<string, number>();
  for (const [stratum, count] of labelled) {
    const size = population[stratum];
    if (size === undefined || !(size > 0))
      throw new Error(`The population has no candidates in stratum ${stratum}.`);
    weights.set(stratum, size / count);
  }
  return weights;
}

/**
 * The pre-registered band rule of D18, on cross-validated probabilities of the fit labels:
 * p_apply is the smallest probability whose accepted labels have weighted precision >= 0.95 with a
 * Wilson lower bound >= 0.85, and p_suggest the smallest with weighted precision >= 0.80; neither
 * may leave a forbidden fixture-tuning root pair (its best probability) at or above it. A suggest
 * band that would start at or above p_apply is none. Plan decision 29 no longer freezes these
 * levels (the suggest edge comes from the fixture tuning partition); the bake-off reports them.
 */
export function selectBands(input: {
  points: ReadonlyArray<{ probability: number; positive: boolean; weight?: number }>;
  forbidden: readonly number[];
  applyPrecision?: number;
  applyWilsonLower?: number;
  suggestPrecision?: number;
}): { pApply: number | null; pSuggest: number | null } {
  const applyPrecision = input.applyPrecision ?? 0.95;
  const applyWilsonLower = input.applyWilsonLower ?? 0.85;
  const suggestPrecision = input.suggestPrecision ?? 0.8;
  const thresholds = [...new Set(input.points.map((point) => point.probability))].sort(
    (left, right) => left - right
  );
  let pApply: number | null = null,
    pSuggest: number | null = null;
  for (const threshold of thresholds) {
    if (input.forbidden.some((value) => value >= threshold)) continue;
    const precision = weightedPrecision(
      input.points.filter((point) => point.probability >= threshold)
    );
    if (!precision) continue;
    if (pSuggest === null && precision.precision >= suggestPrecision) pSuggest = threshold;
    if (
      pApply === null &&
      precision.precision >= applyPrecision &&
      precision.wilsonLower >= applyWilsonLower
    )
      pApply = threshold;
  }
  if (pApply !== null && pSuggest !== null && pSuggest >= pApply) pSuggest = null;
  return { pApply, pSuggest };
}

/** A banded relation reconcile looks at: its current band and its score under the new rule. */
export interface ReconcileRow {
  id: string;
  score: number;
  band: "apply" | "suggest";
}

export interface ReconcileTransition {
  id: string;
  from: "apply" | "suggest";
  /** Null: the relation leaves the accept band. */
  to: "apply" | "suggest" | null;
  probability: number | null;
}

/**
 * The band changes a new calibration makes on stored scores, with 0 model calls (D18). A relation
 * leaves `apply` only when its score falls below the new apply threshold minus the hysteresis (in
 * the score's units, log-odds for a ranker); every other change follows the new band.
 */
export function reconcileBands(input: {
  rows: readonly ReconcileRow[];
  entry: RelationCalibrationEntry | null;
  uncalibratedPass: number;
  hysteresis: number;
}): ReconcileTransition[] {
  if (!(input.hysteresis >= 0)) throw new Error("The hysteresis is not negative.");
  const applyFrom = input.entry ? bandThresholds(input.entry).apply : null;
  const transitions: ReconcileTransition[] = [];
  for (const row of input.rows) {
    const next = bandScore(row.score, input.entry, input.uncalibratedPass);
    const kept =
      row.band === "apply" &&
      next.band !== "apply" &&
      applyFrom !== null &&
      row.score >= applyFrom - input.hysteresis;
    const to = kept ? "apply" : next.band;
    if (to !== row.band)
      transitions.push({ id: row.id, from: row.band, to, probability: next.probability });
  }
  return transitions;
}
