// The typed configuration of relations v2 (F3 D46; spec 4.4): retrieval, decide, calibrations and
// bands. Every number note matching uses lives here, not in rules (RULES.md section 1). Values
// marked (cal.) in docs/f3-decisions.md are start values: T52 added the link job, the daily cap and
// coalescing; T53 adds discovery, and T58 wrote the frozen calibrations and bands (defaults only).
import { z } from "zod";

import {
  RelationAggregationRuleSchema,
  RelationCalibrationEntrySchema,
  relationCalibrationIdentityKey,
  type LocalRelationCalibrationIdentity,
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

/**
 * The decide contract of the Decisions API decider (plan decision 30): one predicate probability per
 * candidate, both directions, the mean of two candidate orders; part of its calibration identity.
 */
export const relationDecideDecisionsContract = "relation-decide-decisions-v1";

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
    /** Body characters of the rendered note: 600, the F3 bake-off's choice (D13). */
    bodyCharacters: int(1, 10_000).default(600),
    /** Aggregation of the two directions (D18): mean, the F3 bake-off's choice. */
    rule: RelationAggregationRuleSchema.default("mean"),
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

/** The largest daily spend cap of the Decisions decider in US$, whoever sets it (a DEV proof run too). */
export const decisionsDailyCapMaxUsd = 1_000;

/**
 * The Decisions API decider (plan decision 30), opt-in in the Hybrid and Cloud presets. Its request
 * design, price and deadlines are typed limits in `packages/ai`; its frozen calibration is among
 * `calibrations`. This holds what the relation pipeline decides: the day's spend cap and the score a
 * Decisions decider without a matching calibration (an edited instruction) must reach to be
 * suggested; it never applies then.
 */
const DecisionsDeciderSchema = z
  .object({
    /** Spend cap per local day in US$, from the provider's usage at the typed price (D26's sibling). */
    dailyCapUsd: z.number().min(0).max(decisionsDailyCapMaxUsd).default(0.5),
    /**
     * Spike A2's frozen directed threshold p >= 0.79, as the log-odds of the mean of both
     * directions on the bake-off scale.
     */
    uncalibratedPassLogOdds: logOdds.default(1.3249)
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
    /** The Decisions API decider (plan decision 30): its spend cap and its uncalibrated pass. */
    decisions: DecisionsDeciderSchema.prefault({}),
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

/** Spike A's `mechanism` instruction (`relations.decide.instruction` revision 1): the provisional rule's. */
const spikeAInstructionSha256 = "1fc9a2eee90e36636d344db2c7c2566974ac47e67bcbc43eeff250bfd78b0164";

const provisionalIdentity = (
  ranker: Pick<
    LocalRelationCalibrationIdentity,
    "model" | "runtimeKind" | "repository" | "revision" | "quantization" | "artifactSha256"
  >
): LocalRelationCalibrationIdentity => ({
  contract: relationDecideContract,
  instructionSha256: spikeAInstructionSha256,
  template: relationPairTextTemplate,
  bodyCharacters: 400,
  rule: "max",
  provider: "local",
  ...ranker
});

/**
 * The provisional calibrations of the two catalog rankers before T58 froze (spec 3.8 step 6): max of
 * both directions applies at Spike A's frozen thresholds, with no suggest band. They hold Spike A's
 * identity (mechanism, 400, max), which the shipped defaults no longer have; kept as the record and
 * as the base identity of the bake-off's selections.
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

/**
 * The calibrations T58 froze, copied from `.cache/f3/freeze/frozen.json` and never edited by hand (a
 * re-freeze replaces them). The two local rankers (plan decision 29; config 745469e5a7acce86, frozen
 * at 2026-10-18T07:10:50.254Z): relation / 600 / mean, the panel's weighted isotonic map for the
 * reported probability, no apply band, and the suggest edge chosen on the fixture tuning partition.
 * The Decisions API decider (plan decision 30; added by the re-freeze 8017633d05452997 at
 * 2026-10-18T07:53:06.300Z): its own identity (model, instruction, request design), D18's apply and
 * suggest bands on dense two-order requests; its parity is the request design's fingerprint. That
 * design is the bake-off's: each note's whole batch neighbourhood, uncapped. The product asks
 * online, in arrival order, with a capped neighbourhood and one request per reverse direction
 * (`decisionsRequestDesign` in `packages/ai`), which is another identity: this entry does not apply
 * to it, so the decider only suggests until the dense partitions are replayed through the product's
 * request builder and the calibration is frozen again for that identity.
 */
export const frozenRelationCalibrations: readonly RelationCalibrationEntry[] = [
  {
    kind: "isotonic",
    identity: {
      contract: "relation-decide-v1",
      instructionSha256: "991ad3a617c4ca6cabab1cb8d45a5806b1e258ef0e5e80a7380d750a09b89c5b",
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      provider: "local",
      model: "mlx-qwen3-reranker-0.6b",
      runtimeKind: "mlx",
      repository: "Qwen/Qwen3-Reranker-0.6B",
      revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
      quantization: "bf16",
      artifactSha256: "174f5d43f89c73d2b8935f36af5f6a80a9fb31267d05ba7172393e978f6a3a01"
    },
    blocks: [
      { fromScore: -10.234375, probability: 0.013586464290411849 },
      { fromScore: -6.4375, probability: 0.015537299377036256 },
      { fromScore: -2.1875, probability: 0.17771307874961412 },
      { fromScore: -0.96875, probability: 0.3859252426000536 },
      { fromScore: 2, probability: 0.6348038320852363 },
      { fromScore: 3.90625, probability: 0.7236861722530442 }
    ],
    applyFrom: null,
    suggestFrom: 0.125,
    basis:
      "plan decision 29: suggest from the fixture tuning partition's edge that finds the most expected root pairs at 0 forbidden (ties: the higher edge); no apply band",
    labelSetHash: "70ee96f7ed1925cef50557469f8207cfc74d5cebc54507309c955411d51b338d",
    freezeHash: "745469e5a7acce86ece3f6d271a9646fd2f06116926080a34d9a9b371760b371",
    fittedAt: "2026-10-18T05:42:47.694Z",
    parity: {
      referenceHash: "77c2d41683fc4b9697e5925ae95b1a8f2b18a3a2673e52bd560118750b9854f9",
      scores: [
        -14.0546875, -12.65625, -12.640625, -12.1875, -12.765625, -11.125, -10.5625, -12.140625,
        -11.0625, -10.15625, -10.78125, -9.53125, -8.625, -10.40625, -8.3125, -9, -8.90625, -7.125,
        -9.21875, -5.8125, -10, -3.4375, -5.375, -6.625, -5.6875, -5.1875, -5.0625, -4.25, -6.5625,
        -1.5, -3.1875, -3.6875, -0.875, -4.5625, -4.3125, 0, 0.5, -3.1875, 2, -3.5625, -0.75, 0.75,
        -2.0625, 3.75, 2.75, -0.375, 0.75, 3.25, 3.9375, 1.5, 6.125, 0.375, 1.875, 5.9375, 5.5625,
        3.625, 4.75, 6.0625, 6.8125, 5.1875, 7.625, 5.8125, 7.6875, 6.9375
      ]
    }
  },
  {
    kind: "isotonic",
    identity: {
      contract: "relation-decide-v1",
      instructionSha256: "991ad3a617c4ca6cabab1cb8d45a5806b1e258ef0e5e80a7380d750a09b89c5b",
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      provider: "local",
      model: "gguf-qwen3-reranker-0.6b-q8-0",
      runtimeKind: "gguf",
      repository: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
      revision: "a02f48bb4f057028298c21fa033da2b30d7742d5",
      quantization: "Q8_0",
      artifactSha256: "22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48"
    },
    blocks: [
      { fromScore: -10.05329106624119, probability: 0.013586464290411849 },
      { fromScore: -6.330080728980645, probability: 0.017573326860467284 },
      { fromScore: -2.5470474785561086, probability: 0.12203578013037089 },
      { fromScore: -1.4054030838884093, probability: 0.32044405242505963 },
      { fromScore: 0.5518530589600384, probability: 0.41105723830443475 },
      { fromScore: 1.7995876376203648, probability: 0.6080726679167734 },
      { fromScore: 4.256137532103466, probability: 0.7292117680690456 }
    ],
    applyFrom: null,
    suggestFrom: 0.6186392038897985,
    basis:
      "plan decision 29: suggest from the fixture tuning partition's edge that finds the most expected root pairs at 0 forbidden (ties: the higher edge); no apply band",
    labelSetHash: "70ee96f7ed1925cef50557469f8207cfc74d5cebc54507309c955411d51b338d",
    freezeHash: "745469e5a7acce86ece3f6d271a9646fd2f06116926080a34d9a9b371760b371",
    fittedAt: "2026-10-18T05:42:47.694Z",
    parity: {
      referenceHash: "77c2d41683fc4b9697e5925ae95b1a8f2b18a3a2673e52bd560118750b9854f9",
      scores: [
        -13.979554351772022, -11.956564139434244, -13.116980861168143, -11.987827114564771,
        -13.679491403032161, -10.646373600118558, -10.733213942474451, -12.352076894896431,
        -11.781102370433945, -10.815447609089599, -12.052484496748752, -9.776902090113285,
        -9.435445550863715, -10.761592883284798, -8.40931707531615, -8.606384050912244,
        -8.049385160361076, -7.6717871958725325, -9.077499567041428, -5.652110041136986,
        -8.975402340566173, -4.545490045038014, -6.869924624721169, -6.2174641827800485,
        -6.308344910304574, -5.504241682182784, -5.653672055355986, -5.5433826740913466,
        -6.786654560311466, -2.059238381721378, -4.1949796417033935, -3.314390234859011,
        0.6629086809476934, -5.135674527887624, -4.914860732502787, 0.8452471092558945,
        -1.8582418533188416, -3.159220731139479, 1.8775537770859754, -2.8234625046608306,
        -0.6970329578667336, 0.7333355613966511, -1.77724070285174, 3.0831981723685935,
        2.0732303490660167, -0.7810019142072288, 1.0615177381999448, 3.4603710547774935,
        2.2574267943658133, 1.0301057151137094, 6.320724227874671, -0.11848247994976793,
        0.874366911270387, 6.165143253861916, 5.520282459257673, 2.381741288403319,
        4.932301608676971, 6.100450384850788, 7.008080622592154, 5.416012038611887,
        7.582506893393163, 5.6989027670023695, 7.502277557267472, 6.956802437806665
      ]
    }
  },
  {
    kind: "isotonic",
    identity: {
      contract: "relation-decide-decisions-v1",
      instructionSha256: "1fc9a2eee90e36636d344db2c7c2566974ac47e67bcbc43eeff250bfd78b0164",
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      provider: "openai",
      model: "gpt-6-luna",
      runtimeKind: "remote",
      requestDesignSha256: "0e1ebd94857f256b1ea72cd5883c803c2b0db6d87277009b78c6679eaca4098c"
    },
    blocks: [
      { fromScore: -16.118095550958316, probability: 0.013538958304543831 },
      { fromScore: -10.705700187841405, probability: 0.029158550414730408 },
      { fromScore: -2.3798644729023444, probability: 0.04706630461376537 },
      { fromScore: -1.6918955246777925, probability: 0.05180954665532005 },
      { fromScore: -1.1558174642569816, probability: 0.060311203111925255 },
      { fromScore: -0.06474549154375886, probability: 0.3111784670606614 },
      { fromScore: 0.7420854002313838, probability: 0.5590779918930682 },
      { fromScore: 1.4970033237932603, probability: 0.7226752405029679 },
      { fromScore: 2.036718938701393, probability: 0.7791987927777894 },
      { fromScore: 2.3719827388660772, probability: 0.9458604984516219 }
    ],
    applyFrom: 2.3719827388660772,
    suggestFrom: 1.4970033237932603,
    basis:
      "D18 on dense two-order requests (plan decision 30): p_apply 0.8706812712335298, p_suggest 0.6009455768505877, cross-validated, cell weights, 0 forbidden tuning root pairs",
    labelSetHash: "70ee96f7ed1925cef50557469f8207cfc74d5cebc54507309c955411d51b338d",
    freezeHash: "8017633d054529975c25e2bbd2ae50f03d245e93e3c46c872215c9cb4be3e6e3",
    fittedAt: "2026-10-18T07:51:57.188Z",
    parity: {
      requestDesignSha256: "0e1ebd94857f256b1ea72cd5883c803c2b0db6d87277009b78c6679eaca4098c"
    }
  }
];

export const relationsConfig: RelationsConfig = RelationsConfigSchema.parse({
  calibrations: frozenRelationCalibrations
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
