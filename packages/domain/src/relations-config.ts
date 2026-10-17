// The typed configuration of relations v2 (F3 D46; spec 4.4): retrieval, decide, calibrations and
// bands. Every number note matching uses lives here, not in rules (RULES.md section 1). Values
// marked (cal.) in docs/f3-decisions.md are start values: T52 added the link job, the daily cap and
// coalescing; T53 adds discovery, and T58 writes the frozen calibrations and bands (defaults only).
import { z } from "zod";

import {
  RelationAggregationRuleSchema,
  RelationCalibrationEntrySchema,
  relationCalibrationIdentityKey,
  type RelationCalibrationEntry,
  type RelationCalibrationIdentity
} from "./relation-calibration.js";
import { relationPairTextTemplate } from "./relation-pair-text.js";

/**
 * The note decider modes (D16). `ranker` (Local and Hybrid presets) decides with the validated
 * ranker only and skips note matching while there is none; `ranker-else-generative` (Cloud, and a
 * profile with no preset whose `reranking` route holds a generative model) uses the generative
 * decider while no ranker validates; `generative` only when the user chooses it.
 */
export const noteDeciderModes = ["ranker", "ranker-else-generative", "generative"] as const;
export const NoteDeciderModeSchema = z.enum(noteDeciderModes);
export type NoteDeciderMode = z.infer<typeof NoteDeciderModeSchema>;

/** The setting the presets write (T54). Unset on a profile with no preset: the mode is derived. */
export const relationsDeciderModeSettingKey = "relations.deciderMode";

/** The skip reason of matching stages that wait for a validated ranker (mode `ranker`, C7). */
export const waitingForDeciderSkipReason = "waiting_for_decider";

/** The park reason of a run's `sourceMatching` stage while its link job runs (D24). */
export const linkingParkReason = "linking";

/** The daily counter of remote relation calls (D26): `{ day, calls, interactiveCalls }`. */
export const relationsDailyCallsSettingKey = "relations.ai.dailyCalls";

/** The decide contract of the ranker decider; part of its cache key and calibration identity. */
export const relationDecideContract = "relation-decide-v1";

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const logOdds = z.number().finite();

const RetrievalSchema = z
  .object({
    /** Vector candidates per note (partial HNSW, raw distance; D28). */
    vectorK: int(1, 200).default(24),
    /** Text candidates per note (`search_tsv` and the title trigram). */
    textK: int(0, 200).default(16),
    /** Graph candidates per note (the AGE entity paths); 0 turns the signal off. */
    graphK: int(0, 200).default(8),
    /**
     * Graph paths are read this deep, then filtered in SQL (current notes, the fence) and cut to
     * graphK before fusion, like gate 0's B4 arrival lists (40): an excluded note takes no slot.
     */
    graphPoolK: int(0, 1000).default(40),
    /**
     * Fused candidates per note (K). Gate 0 (lever 4) set it to 10: D17's recall-lossless limit,
     * every expected tuning root pair reached in arrival mode down to K = 8.
     */
    fusedK: int(1, 100).default(10),
    rrfK: int(1, 200).default(60),
    /** Graph-only candidates kept in the fused list even when they rank below K. */
    minimumGraphOnly: int(0, 100).default(3),
    /** The reverse guard looks at the note's vector top guardFactor x K (D19). */
    guardFactor: int(1, 10).default(2),
    /** D17: no lossy cosine floor before the decider. */
    cosineFloor: z.null().default(null)
  })
  .strict()
  .refine((retrieval) => retrieval.vectorK >= retrieval.guardFactor * retrieval.fusedK, {
    message: "The vector list must hold the reverse guard's window (guardFactor x fusedK)."
  })
  .refine((retrieval) => retrieval.graphPoolK >= retrieval.graphK, {
    message: "The graph list is read at least graphK deep (graphPoolK)."
  });

const DecideSchema = z
  .object({
    /**
     * Pairs per bounded local call (D16, gate 0 B1): 32 on MLX (876 ms), 16 on GGUF (712 ms), so a
     * P0 call waits for at most one call of about a second. Equal to the AI service's split.
     */
    rankPairsPerCall: z
      .object({ mlx: int(1, 64).default(32), gguf: int(1, 64).default(16) })
      .strict()
      .prefault({}),
    /** Sequences per MLX forward pass; part of the decider cache key. */
    helperBatchSize: int(1, 64).default(16),
    template: z.literal(relationPairTextTemplate).default(relationPairTextTemplate),
    /** Body characters of the rendered note (400 or 600; the bake-off chooses). */
    bodyCharacters: int(1, 10_000).default(400),
    /** Aggregation of the two directions (D18): max until T58 selects. */
    rule: RelationAggregationRuleSchema.default("max"),
    /**
     * The score an uncalibrated decider must reach to be suggested (it never applies, D18): a
     * ranker without a calibration entry, or whose parity check failed, at Spike A's thresholds in
     * log-odds; the generative decider on its own 0-1 scale at the v9 decider-only threshold.
     */
    uncalibratedPass: z
      .object({
        logOdds: z
          .object({ mlx: logOdds.default(3.3125), gguf: logOdds.default(3.16) })
          .strict()
          .prefault({}),
        probability: z.number().min(0).max(1).default(0.65)
      })
      .strict()
      .prefault({})
  })
  .strict();

const TypingSchema = z
  .object({
    /** Accepted pairs per `relations.type` call (D20). */
    pairsPerCall: int(1, 64).default(24),
    /** Typing attempts before a pair is persisted untyped. */
    maxAttempts: int(1, 5).default(2),
    /**
     * Small-source coalescing (D20, product only): a link job with fewer pairs than this to type
     * also types the pending pairs of other due link jobs, up to `pairsPerCall` in one call.
     */
    coalesceBelow: int(0, 64).default(6)
  })
  .strict();

const LinkSchema = z
  .object({
    /** Link jobs the `relations` worker runs at once (D24, cal.). */
    poolSize: int(1, 8).default(2),
    /** The pool of golden and re-match runs: first in, first out, so replays are deterministic. */
    drainPoolSize: int(1, 8).default(1)
  })
  .strict();

const RelationAiSchema = z
  .object({
    /**
     * Background (P2, P3) remote typing and discovery calls per local day (D26, cal.); interactive
     * (P1) link-job calls count toward it but are never refused. Golden and re-match runs are not
     * counted (their token cap bounds them).
     */
    maxBackgroundCallsPerDay: int(0, 1_000_000).default(500)
  })
  .strict();

export const RelationsConfigSchema = z
  .object({
    retrieval: RetrievalSchema.prefault({}),
    decide: DecideSchema.prefault({}),
    /** Calibrations by identity (D13); a decider without one is uncalibrated. */
    calibrations: z.array(RelationCalibrationEntrySchema).default([]),
    /** Accepted pairs one decided note hands on (the former per-note relation cap). */
    maxShownPerNote: int(1, 100).default(10),
    /** Reconcile keeps a relation applied until its score falls this far below apply (log-odds). */
    hysteresisLogOdds: z.number().min(0).max(10).default(0.5),
    typing: TypingSchema.prefault({}),
    link: LinkSchema.prefault({}),
    ai: RelationAiSchema.prefault({}),
    /** The uncertain-band escalation (T58e); off until the selection rule adopts it. */
    escalation: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({}),
    /** Source discovery of design E (D27): 2 neighbours is S1's fallback. */
    discovery: z
      .object({ neighbours: int(1, 2).default(1) })
      .strict()
      .prefault({}),
    /** The source judge (`sources.decide` v5, D27). */
    sourceJudge: z
      .object({
        /** Uncited note relations a judged pair's prompt lists as hypotheses (the spike's 4). */
        noteRelationsPerPair: int(0, 30).default(4),
        /** Q14: stored v5 `similar_to` verdicts are dropped as weak unless tuning recall needs them. */
        keepSimilarTo: z.boolean().default(false),
        /**
         * Evidence of a pair whose two roots hold more passage pairs than this (R19: a book pair of
         * 500 chunks each is 250,000) is selected by D27's fallback: the note-relation passages and
         * bounded exact vector pairs, not the lexical and concept cross joins (cal., S1's SQL bar).
         */
        exactEvidencePairs: int(0, 10_000_000).default(10_000),
        /** The fallback's passages per root nearest to the other root's centroid. */
        boundedEvidenceChunks: int(1, 64).default(16)
      })
      .strict()
      .prefault({})
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of config.calibrations.entries()) {
      const key = relationCalibrationIdentityKey(entry.identity);
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          message: "Two calibrations share one identity.",
          path: ["calibrations", index]
        });
      seen.add(key);
    }
  });
export type RelationsConfig = z.infer<typeof RelationsConfigSchema>;
export type RelationsConfigInput = z.input<typeof RelationsConfigSchema>;

/** The catalog instruction `relations.decide.instruction` as shipped: Spike A's `mechanism`. */
const shippedInstructionSha256 = "1fc9a2eee90e36636d344db2c7c2566974ac47e67bcbc43eeff250bfd78b0164";

const provisionalIdentity = (
  ranker: Pick<
    RelationCalibrationIdentity,
    "model" | "runtimeKind" | "repository" | "revision" | "quantization" | "artifactSha256"
  >
): RelationCalibrationIdentity => ({
  contract: relationDecideContract,
  instructionSha256: shippedInstructionSha256,
  template: relationPairTextTemplate,
  bodyCharacters: 400,
  rule: "max",
  provider: "local",
  ...ranker
});

/**
 * Provisional calibrations of the two catalog rankers until T58 freezes (spec 3.8 step 6): max of
 * both directions applies at Spike A's frozen thresholds, with no suggest band.
 */
export const provisionalRelationCalibrations: readonly RelationCalibrationEntry[] = [
  {
    kind: "threshold",
    identity: provisionalIdentity({
      model: "mlx-qwen3-reranker-0.6b",
      runtimeKind: "mlx",
      repository: "Qwen/Qwen3-Reranker-0.6B",
      revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
      quantization: "bf16",
      artifactSha256: "174f5d43f89c73d2b8935f36af5f6a80a9fb31267d05ba7172393e978f6a3a01"
    }),
    applyAt: 3.3125,
    suggestAt: null,
    basis: "Spike A frozen rule: max of both directions at 3.3125 log-odds (MLX)"
  },
  {
    kind: "threshold",
    identity: provisionalIdentity({
      model: "gguf-qwen3-reranker-0.6b-q8-0",
      runtimeKind: "gguf",
      repository: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
      revision: "a02f48bb4f057028298c21fa033da2b30d7742d5",
      quantization: "Q8_0",
      artifactSha256: "22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48"
    }),
    applyAt: 3.16,
    suggestAt: null,
    basis: "Spike A frozen rule: max of both directions at 3.16 log-odds (GGUF)"
  }
];

export const relationsConfig: RelationsConfig = RelationsConfigSchema.parse({
  calibrations: provisionalRelationCalibrations
});

/** The calibration of an identity, or null: the decider is then uncalibrated (suggest only). */
export function findRelationCalibration(
  config: Pick<RelationsConfig, "calibrations">,
  identity: RelationCalibrationIdentity
): RelationCalibrationEntry | null {
  const key = relationCalibrationIdentityKey(identity);
  return (
    config.calibrations.find((entry) => relationCalibrationIdentityKey(entry.identity) === key) ??
    null
  );
}
