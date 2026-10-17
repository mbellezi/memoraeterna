import { createHash } from "node:crypto";

import { z } from "zod";

import reference from "./ranker-parity-reference.json" with { type: "json" };
import type { RankPairsRequest, RankResult } from "./ranker-input.js";

/**
 * The score-parity check of a local ranker (F3 D13, R1). A calibration is keyed by an identity
 * without the runtime build, so a rebuilt or packaged helper (or a node-llama-cpp upgrade) reuses
 * it only after the new build scores a fixed set of 64 directed pairs within `tolerance` log-odds
 * of the scores stored when the calibration was fitted. A build that drifts further leaves the
 * decider uncalibrated, visibly: the relation decider then only suggests and the topic gate takes
 * its no-decider path.
 *
 * Scores are comparable only under the batching they were measured with (bf16 batch makeup moves a
 * score by up to a few tenths), so the check always scores the reference in the same calls, at the
 * same helper batch, whatever `rankPairsLimits` says.
 */

export const rankerParityConfig = {
  /** Largest allowed |Δ| of any pair, in log-odds (D13). */
  tolerance: 0.125,
  /** Directed pairs of the reference. */
  pairs: 64,
  /**
   * The calls the reference is scored in: pairs per call by runtime, and the MLX helper's batch.
   * Part of the protocol; a baseline recorded under another plan does not apply.
   */
  plan: { mlx: { pairsPerCall: 32, helperBatchSize: 16 }, gguf: { pairsPerCall: 16 } }
} as const;

const finite = z.number().finite();
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const rankerParityReferenceSchema = z
  .object({
    version: z.literal(1),
    description: z.string().min(1),
    /** The instruction every pair is scored under; fixed here, independent of the prompt catalog. */
    instruction: z.string().min(1),
    pairs: z
      .array(
        z
          .object({ id: z.string().min(1), query: z.string().min(1), document: z.string().min(1) })
          .strict()
      )
      .length(rankerParityConfig.pairs)
  })
  .strict();
export type RankerParityReference = z.infer<typeof rankerParityReferenceSchema>;

let parsedReference: RankerParityReference | null = null;

/** The shipped reference, validated. */
export function rankerParityReference(): RankerParityReference {
  parsedReference ??= rankerParityReferenceSchema.parse(reference);
  return parsedReference;
}

/**
 * SHA-256 of what decides the scores: the version, the instruction and every pair's texts in order.
 * The description and the pair ids are not part of it.
 */
export function rankerParityReferenceHash(
  value: RankerParityReference = rankerParityReference()
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: value.version,
        instruction: value.instruction,
        pairs: value.pairs.map((pair) => [pair.query, pair.document])
      })
    )
    .digest("hex");
}

/** The batching the parity run of a runtime uses (see {@link rankerParityConfig}). */
export interface RankerParityPlan {
  pairsPerCall: number;
  /** The MLX helper's batch size; absent for a GGUF ranker, which scores pairs one by one. */
  helperBatchSize?: number;
}

export function rankerParityPlan(runtime: "mlx" | "gguf"): RankerParityPlan {
  return runtime === "mlx"
    ? { ...rankerParityConfig.plan.mlx }
    : { ...rankerParityConfig.plan.gguf };
}

/**
 * Scores the reference through `score` in the calls of the runtime's parity plan and returns the
 * log-odds of the 64 pairs in reference order. `score` sends one pairs request (at most
 * `plan.pairsPerCall` pairs) to the ranker, with `plan.helperBatchSize` when the plan has one.
 */
export async function scoreRankerParityReference(
  runtime: "mlx" | "gguf",
  score: (request: RankPairsRequest, plan: RankerParityPlan) => Promise<RankResult>,
  value: RankerParityReference = rankerParityReference()
): Promise<number[]> {
  const plan = rankerParityPlan(runtime);
  const logOdds: number[] = [];
  for (let start = 0; start < value.pairs.length; start += plan.pairsPerCall) {
    const chunk = value.pairs.slice(start, start + plan.pairsPerCall);
    const result = await score(
      {
        instruction: value.instruction,
        pairs: chunk.map((pair) => ({ query: pair.query, document: pair.document }))
      },
      plan
    );
    if (result.logOdds.length !== chunk.length) {
      throw new Error("The parity run did not score every pair.");
    }
    logOdds.push(...result.logOdds);
  }
  return logOdds;
}

export interface RankerParityDelta {
  /** The largest |Δ| over the pairs; infinite when any score is not finite. */
  maxDelta: number;
  meanDelta: number;
  /** Index of the pair with the largest |Δ|. */
  worstIndex: number;
}

/** Distance between the baseline scores and the current ones, pair by pair. */
export function compareRankerParity(
  baseline: readonly number[],
  scores: readonly number[]
): RankerParityDelta {
  if (baseline.length !== scores.length || baseline.length === 0) {
    throw new Error("The parity scores do not cover the same pairs.");
  }
  let maxDelta = 0;
  let worstIndex = 0;
  let total = 0;
  baseline.forEach((expected, index) => {
    const actual = scores[index]!;
    const delta =
      Number.isFinite(expected) && Number.isFinite(actual)
        ? Math.abs(actual - expected)
        : Number.POSITIVE_INFINITY;
    total += delta;
    if (delta > maxDelta) {
      maxDelta = delta;
      worstIndex = index;
    }
  });
  return { maxDelta, meanDelta: total / baseline.length, worstIndex };
}

const planSchema = z
  .object({
    pairsPerCall: z.number().int().positive(),
    helperBatchSize: z.number().int().positive().optional()
  })
  .strict();

/** Scores the parity run is measured against. */
export const rankerParityBaselineSchema = z
  .object({
    /** `calibration`: stored with a calibration entry (D13). `validation`: this install's first run. */
    source: z.enum(["calibration", "validation"]),
    referenceHash: z.string().regex(sha256Pattern),
    plan: planSchema,
    /** The runtime build the scores were measured on; null when the source does not say. */
    runtimeBuild: z.string().min(1).max(500).nullable(),
    scores: z.array(finite).length(rankerParityConfig.pairs)
  })
  .strict();
export type RankerParityBaseline = z.infer<typeof rankerParityBaselineSchema>;

/** The parity check of one validation, stored in `decideValidation.parity`. */
export const rankerParityRecordSchema = z
  .object({
    version: z.literal(1),
    tolerance: z.number().positive(),
    baseline: rankerParityBaselineSchema,
    /** The scores of the build that was validated, in reference order. */
    scores: z.array(finite).length(rankerParityConfig.pairs),
    maxDelta: z.number().nonnegative(),
    meanDelta: z.number().nonnegative(),
    /** `maxDelta ≤ tolerance`. A record that did not pass leaves the decider uncalibrated. */
    passed: z.boolean(),
    checkedAt: z.iso.datetime()
  })
  .strict();
export type RankerParityRecord = z.infer<typeof rankerParityRecordSchema>;

/**
 * Whether a stored baseline applies to a run: the same reference and the same batching. Anything
 * else is not comparable and counts as no baseline.
 */
export function rankerParityBaselineApplies(
  baseline: RankerParityBaseline | null | undefined,
  runtime: "mlx" | "gguf",
  referenceHash: string = rankerParityReferenceHash()
): baseline is RankerParityBaseline {
  if (!baseline || baseline.referenceHash !== referenceHash) return false;
  const plan = rankerParityPlan(runtime);
  return (
    baseline.plan.pairsPerCall === plan.pairsPerCall &&
    baseline.plan.helperBatchSize === plan.helperBatchSize
  );
}

/**
 * The parity record of a run. With no applicable `baseline` the run's own scores become the
 * baseline of this install (`source: "validation"`, distance 0): there is nothing yet to drift from.
 * A baseline from a calibration entry or an earlier validation is kept as it is, so a series of
 * small drifts cannot each pass against the one before.
 */
export function createRankerParityRecord(input: {
  runtime: "mlx" | "gguf";
  scores: readonly number[];
  runtimeBuild: string;
  baseline?: RankerParityBaseline | null | undefined;
  tolerance?: number;
  checkedAt?: Date;
}): RankerParityRecord {
  const referenceHash = rankerParityReferenceHash();
  const baseline = rankerParityBaselineApplies(input.baseline, input.runtime, referenceHash)
    ? input.baseline
    : rankerParityBaselineSchema.parse({
        source: "validation",
        referenceHash,
        plan: rankerParityPlan(input.runtime),
        runtimeBuild: input.runtimeBuild,
        scores: [...input.scores]
      });
  const tolerance = input.tolerance ?? rankerParityConfig.tolerance;
  const delta = compareRankerParity(baseline.scores, input.scores);
  return rankerParityRecordSchema.parse({
    version: 1,
    tolerance,
    baseline,
    scores: [...input.scores],
    maxDelta: delta.maxDelta,
    meanDelta: delta.meanDelta,
    passed: delta.maxDelta <= tolerance,
    checkedAt: (input.checkedAt ?? new Date()).toISOString()
  });
}
