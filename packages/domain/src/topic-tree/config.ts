// The complete typed configuration of the F2 Topic Tree Engine. Every number the engine, its jobs
// and its AI calls use lives here (RULES.md: numbers live in typed configuration, not in rules).
// Start values come from Spike B ("F2 start values") and the F2 decisions; values marked *(cal.)*
// in the spec are calibrated by T29a/T29b, the only tasks that change defaults.
import { z } from "zod";

import { compareStrings } from "./ids.js";

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const share = z.number().min(0).max(1);
const cosine = z.number().min(-1).max(1);

/** I3: internal fan-out 2-12, target 4-9, hard above 16. */
const FanOutSchema = z
  .object({
    min: int(2, 64).default(2),
    max: int(2, 64).default(12),
    targetMin: int(2, 64).default(4),
    targetMax: int(2, 64).default(9),
    hardMax: int(2, 64).default(16),
    /** Areas the builders aim for when the root splits above the leaf level; 0 = balanced rule. */
    rootTarget: int(0, 64).default(9)
  })
  .strict();

/** I4: a leaf holds 3-30 direct items, target 15, hard above 45. */
const LeafSchema = z
  .object({
    min: int(1, 200).default(3),
    max: int(1, 200).default(30),
    target: int(1, 200).default(15),
    hardMax: int(1, 400).default(45),
    /** Builders split a last-level node into fanOut.targetMin leaves while leaves average at least this. */
    minForTargetFanOut: int(1, 200).default(8)
  })
  .strict();

/** I5: target depth 5, hard cap 7 (root = 0). */
const DepthSchema = z
  .object({
    target: int(1, 16).default(5),
    cap: int(1, 16).default(7)
  })
  .strict();

/** PLACE (D10): beam descent with node-relative admission max(a_min, m_c - z * max(s_c, floor)). */
const PlacementSchema = z
  .object({
    beam: int(1, 16).default(3),
    /** a_min: absolute admission floor. */
    admissionFloor: cosine.default(0.15),
    /** Extra absolute floor for leaves only; 0 disables. */
    leafFloor: cosine.default(0),
    /** z: spread factor. */
    spreadFactor: z.number().min(0).max(10).default(2.5),
    /** Lower bound on s_c for nodes too small to estimate it. */
    spreadFloor: z.number().min(0).max(1).default(0.03),
    /** top1 - top2 leaf score below this sends the item to the gate (theta_m). */
    ambiguityMargin: z.number().min(0).max(1).default(0.015),
    /** Use the leave-one-out mean member cosine for m_c. */
    leaveOneOutMean: z.boolean().default(true),
    /** Internal nodes also admit at this lower percentile (0-0.1) of member cosines; 0 disables. */
    internalPercentile: z.number().min(0).max(0.1).default(0.01),
    /** Weight of the topic-label similarity mixed into child scores (0 = centroid only). */
    labelWeight: share.default(0)
  })
  .strict();

/** The decision gate (D10): p = softmax([logOdds..., tau] / T); accept the best when p >= theta. */
const GateSchema = z
  .object({
    maxCandidates: int(1, 32).default(5),
    temperature: z.number().positive().max(100).default(1),
    tau: z.number().min(-50).max(50).default(0),
    theta: share.default(0.5),
    /** The note text excerpt in the gate query (fixed part of the prompt contract). */
    queryTextMaxChars: int(1, 4000).default(400),
    /** Central note titles per topic descriptor ("Examples"). */
    descriptorExamples: int(0, 20).default(3),
    /** Central note titles in a root-source query. */
    sourceQueryNoteTitles: int(0, 20).default(3)
  })
  .strict();

/** Up to 2 "also in" placements, never on the primary path. */
const SecondarySchema = z
  .object({
    max: int(0, 2).default(2),
    /** A secondary leaf must score within this of the primary leaf. */
    maxScoreGap: z.number().min(0).max(1).default(0.02)
  })
  .strict();

/** Items and the root-source vector (D8). */
const ItemsSchema = z
  .object({
    /** A root is re-placed only when its vector moved below this cosine to the last placed one. */
    sourceReplaceCosine: cosine.default(0.98),
    /** Refinement passes of the weighted root vector. */
    rootVectorRefinementPasses: int(0, 10).default(1)
  })
  .strict();

/** Structural operations (REBALANCE and the forced pass that finishes a build). */
const RepairSchema = z
  .object({
    /** Direct items on an internal node that trigger forming new leaves from them. */
    directItemsSplitAt: int(2, 200).default(8),
    /** A tiny leaf merges into a sibling only if the result stays at or below this. */
    mergeMaxSize: int(1, 400).default(22),
    /** Sibling leaves merge when their centroids reach this cosine (result <= mergeMaxSize). */
    siblingMergeCosine: cosine.default(0.85),
    /**
     * Soft repairs on a node wait this many inserts after its previous repair (the E3 stability
     * calibration, see StabilitySchema; Spike B start value 25).
     */
    cooldownInserts: int(0, 100_000).default(931),
    /** Push-down groups children into groups of about this size. */
    pushDownGroupSize: int(2, 64).default(6),
    /** Churn budget: a soft repair re-pathing more than this share of all items is skipped. */
    softMoveShare: share.default(0.05)
  })
  .strict();

/**
 * E3 stability calibration (gate A, 2026-10-15): `npm run topics:replay -- calibrate --engine real`
 * replayed the E3 protocol with T07 PLACE and T08 REBALANCE on corpus-notitle, calibration seeds
 * 7-12, chronological and shuffled arrival, over a 60-point grid of `stability.churnWeight`,
 * `stability.dailyMovedShare`, `repair.cooldownInserts` and `audit.misParentMargin`
 * (scripts/topics/calibration.ts holds the grid and the rule, registered before any evaluation
 * seed ran; report `.cache/topics/reports/calibration-stability/calibration-corpus-notitle.md`).
 * The rule chose lambda 6, 0.2% moved items a day, a 931-insert cooldown (one simulated week of
 * arrivals) and a 0.1 re-parent margin: worst weekly churn 2.98% over the 12 runs (start values
 * 5.90%), median fan-out 4-9 75.2%, median depth 3.45; leaves within 3-30 fall to 82.9% (99.5%),
 * because lambda 6 leaves most soft splits to the hard limit. On the evaluation seeds (20261014,
 * 1-5, both orders) the worst weekly churn was then 2.59%.
 */
const StabilitySchema = z
  .object({
    /** lambda (E3 calibration, above; start value 1). */
    churnWeight: z.number().min(0).max(1000).default(6),
    /** Churn of items in recently opened topics counts this many times. */
    recentChurnWeight: z.number().min(1).max(1000).default(3),
    /** Topics opened or edited within this many hours are frozen for soft operations. */
    freezeHours: z
      .number()
      .min(0)
      .max(24 * 365)
      .default(24),
    /** Soft operations applied per local day. */
    dailyOperations: int(0, 100_000).default(60),
    /**
     * Items whose primary path a day's soft operations may change: max(min, share * items)
     * (E3 calibration, above; start value 0.02).
     */
    dailyMovedShare: share.default(0.002),
    dailyMovedMin: int(0, 1_000_000).default(30)
  })
  .strict();

/** I8: split-candidate signal; off until calibration shows AUC >= 0.75. */
const SplitSignalSchema = z
  .object({
    signal: z
      .enum([
        "off",
        "coherence",
        "bimodality",
        "two-means-silhouette",
        "knn-modularity",
        "none-share"
      ])
      .default("off"),
    /** Threshold of the active signal (for `coherence`: the coherence floor). */
    threshold: z.number().min(-1).max(1).nullable().default(null)
  })
  .strict();

/** Louvain over the cosine kNN graph (the Spike B builder). */
const LouvainSchema = z
  .object({
    knn: int(2, 100).default(10),
    resolution: z.number().positive().max(100).default(1),
    resolutionTries: int(1, 64).default(8),
    /** The resolution is multiplied or divided by this between tries. */
    resolutionStep: z.number().min(1.01).max(10).default(1.6),
    /** A community count within [acceptBelow, acceptAbove] x the wanted k is accepted. */
    acceptBelow: z.number().min(0.1).max(1).default(0.7),
    acceptAbove: z.number().min(1).max(10).default(1.5)
  })
  .strict();

const KnnSchema = z
  .object({
    /** Exact kNN up to this many rows; IVF above. */
    exactLimit: int(2, 1_000_000).default(3000),
    /** IVF lists probed per query. */
    nprobe: int(1, 4096).default(8)
  })
  .strict();

const KMeansSchema = z
  .object({
    maxIterations: int(1, 1000).default(25),
    /** Stop when fewer than this share of points change cluster. */
    tolerance: share.default(0.002)
  })
  .strict();

/** Bottom-up (Clio-like) comparator builder. */
const BottomUpSchema = z
  .object({
    childrenTarget: int(2, 64).default(8),
    topTopicsMax: int(2, 64).default(10)
  })
  .strict();

/** Where builds and splits run (section 3.4). */
const BuildSchema = z
  .object({
    /** Splits and merges at or below this many items run in main; larger builds go to the worker. */
    workerThreshold: int(1, 1_000_000).default(45),
    /** Worker timeout = base + perRow * rows. */
    workerTimeoutBaseMs: int(1000, 3_600_000).default(30_000),
    workerTimeoutPerRowMs: z.number().min(0).max(1000).default(5)
  })
  .strict();

/** Cold start (T19): items wait at the root below minItems; then one bootstrap build. */
const BootstrapSchema = z
  .object({
    minItems: int(1, 10_000).default(12),
    /** Up to this many items the bootstrap keeps one topic unless a split beats it. */
    singleTopicMaxItems: int(1, 400).default(30),
    /** The largest initial split tried for a single-topic-sized library. */
    maxInitialSplit: int(2, 16).default(4),
    /** Modularity a 2..maxInitialSplit split must reach to beat a single topic. */
    modularityMin: z.number().min(0).max(1).default(0.1),
    /** Chapter seeding: share of items from one root with at least chapterMinChildren children. */
    chapterSeedShare: share.default(0.8),
    chapterMinChildren: int(1, 1000).default(2)
  })
  .strict();

/** Rebuild triggers (T19): doubling while small, a quality drop or an unadmitted burst. */
const RebuildSchema = z
  .object({
    /** Rebuild each time the library doubles, up to this many items. */
    doublingMaxItems: int(0, 1_000_000).default(1000),
    /** Drop of the weighted leaf coherence since the last build that triggers a rebuild. */
    qualityDrop: share.default(0.05),
    /** Share of recent placements left unadmitted that triggers a rebuild. */
    unadmittedBurstShare: share.default(0.1),
    unadmittedBurstMinItems: int(1, 100_000).default(20),
    /** A rebuild re-pathing more than this share of items waits for review. */
    reviewChurnShare: share.default(0.25),
    /** Old-to-new topic mapping is exact (Hungarian) up to this many topics, greedy above. */
    hungarianExactMaxTopics: int(1, 100_000).default(300)
  })
  .strict();

/** Naming (D11): one write-fast call per batch, content language, one repair, TF-IDF fallback. */
const NamingSchema = z
  .object({
    maxTopicsPerCall: int(1, 100).default(24),
    centralMembers: int(1, 20).default(5),
    ideaMaxChars: int(1, 2000).default(200),
    titleMaxChars: int(1, 120).default(80),
    descriptionMaxChars: int(1, 400).default(200),
    maxAliases: int(0, 10).default(5),
    repairAttempts: int(0, 3).default(1),
    /** Re-name when the share of members changed since naming reaches this. */
    renameDrift: share.default(0.3),
    /** The TF-IDF fallback needs at least this many content-language members. */
    fallbackMinItems: int(1, 100).default(2),
    fallbackMaxTerms: int(1, 10).default(3)
  })
  .strict();

/** Areas (D12): an LLM grouping of the level-2 topics, validated by code. */
const AreasSchema = z
  .object({
    min: int(2, 64).default(7),
    max: int(2, 64).default(16),
    target: int(2, 64).default(10),
    /** Grouping runs after a build with at least this many level-2 topics. */
    minLevel2Topics: int(2, 10_000).default(20),
    /** Accepted when the level-2 centroid silhouette is not lower than the current one minus this. */
    silhouetteTolerance: z.number().min(0).max(1).default(0.01),
    /** Central titles shown per level-2 topic in the grouping prompt. */
    centralTitles: int(0, 20).default(3)
  })
  .strict();

const AuditSchema = z
  .object({
    /** Run an audit every this many change-sets. */
    everyChangeSets: int(1, 100_000).default(50),
    /** Topics whose statistics an audit recomputes exactly and compares. */
    exactRecomputeSample: int(0, 100_000).default(20),
    /**
     * Re-parent proposals need an uncle centroid closer than the parent's by this much: the
     * re-parent hysteresis (the E3 stability calibration, see StabilitySchema; start value 0.05).
     */
    misParentMargin: z.number().min(0).max(2).default(0.1)
  })
  .strict();

/** Embedding-space change (D26). */
const SpaceSchema = z
  .object({
    /** The tree rebuilds in the new space once this share of current notes has a vector there. */
    reembedCoverage: share.default(0.95)
  })
  .strict();

/** Unsorted (D27): a soft target, reported from minItems items. */
const UnsortedSchema = z
  .object({
    shareTarget: share.default(0.02),
    minItems: int(0, 1_000_000).default(50)
  })
  .strict();

/** Background topic AI (D34): naming, Areas and label embeddings per local day. */
const AiSchema = z
  .object({
    maxBackgroundCallsPerDay: int(0, 1_000_000).default(300)
  })
  .strict();

/** Light-lane topic jobs: run_after = now + debounce, re-enqueue capped at created_at + cap. */
const JobsSchema = z
  .object({
    debounceMs: int(0, 3_600_000).default(10_000),
    debounceCapMs: int(0, 86_400_000).default(60_000)
  })
  .strict();

/** Lazy overviews (T31): evidence is whole items by centrality within a token budget. */
const OverviewSchema = z
  .object({
    evidenceTokenBudget: int(100, 200_000).default(3000),
    maxEvidenceItems: int(1, 100).default(12)
  })
  .strict();

export const TopicTreeConfigSchema = z
  .object({
    fanOut: FanOutSchema.prefault({}),
    leaf: LeafSchema.prefault({}),
    depth: DepthSchema.prefault({}),
    placement: PlacementSchema.prefault({}),
    gate: GateSchema.prefault({}),
    secondary: SecondarySchema.prefault({}),
    items: ItemsSchema.prefault({}),
    repair: RepairSchema.prefault({}),
    stability: StabilitySchema.prefault({}),
    splitSignal: SplitSignalSchema.prefault({}),
    louvain: LouvainSchema.prefault({}),
    knn: KnnSchema.prefault({}),
    kmeans: KMeansSchema.prefault({}),
    bottomUp: BottomUpSchema.prefault({}),
    build: BuildSchema.prefault({}),
    bootstrap: BootstrapSchema.prefault({}),
    rebuild: RebuildSchema.prefault({}),
    naming: NamingSchema.prefault({}),
    areas: AreasSchema.prefault({}),
    audit: AuditSchema.prefault({}),
    space: SpaceSchema.prefault({}),
    unsorted: UnsortedSchema.prefault({}),
    ai: AiSchema.prefault({}),
    jobs: JobsSchema.prefault({}),
    overview: OverviewSchema.prefault({})
  })
  .strict()
  .superRefine((config, context) => {
    const fail = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: "custom", path, message });
    };
    const { fanOut, leaf, depth, areas } = config;
    if (!(
      fanOut.min <= fanOut.targetMin &&
      fanOut.targetMin <= fanOut.targetMax &&
      fanOut.targetMax <= fanOut.max &&
      fanOut.max <= fanOut.hardMax
    )) {
      fail(["fanOut"], "Fan-out must satisfy min <= targetMin <= targetMax <= max <= hardMax");
    }
    if (
      fanOut.rootTarget !== 0 &&
      (fanOut.rootTarget < fanOut.min || fanOut.rootTarget > fanOut.max)
    ) {
      fail(["fanOut", "rootTarget"], "rootTarget must be 0 or within fan-out min..max");
    }
    if (!(leaf.min <= leaf.target && leaf.target <= leaf.max && leaf.max <= leaf.hardMax)) {
      fail(["leaf"], "Leaf size must satisfy min <= target <= max <= hardMax");
    }
    if (depth.target > depth.cap) fail(["depth"], "Depth target must not exceed the cap");
    if (!(
      fanOut.min <= areas.min &&
      areas.min <= areas.target &&
      areas.target <= areas.max &&
      areas.max <= fanOut.hardMax
    )) {
      fail(["areas"], "Areas must satisfy fanOut.min <= min <= target <= max <= fanOut.hardMax");
    }
    if (config.bootstrap.singleTopicMaxItems > leaf.hardMax) {
      fail(
        ["bootstrap", "singleTopicMaxItems"],
        "A single bootstrap topic cannot exceed leaf.hardMax"
      );
    }
    if (config.repair.mergeMaxSize > leaf.hardMax) {
      fail(["repair", "mergeMaxSize"], "A merge result cannot exceed leaf.hardMax");
    }
    if (config.jobs.debounceMs > config.jobs.debounceCapMs) {
      fail(["jobs"], "The debounce cannot exceed its cap");
    }
    if (config.splitSignal.signal !== "off" && config.splitSignal.threshold === null) {
      fail(["splitSignal", "threshold"], "An active split signal needs a threshold");
    }
  });

export type TopicTreeConfig = z.output<typeof TopicTreeConfigSchema>;
export type TopicTreeConfigInput = z.input<typeof TopicTreeConfigSchema>;
export type TopicTreeConfigOverrides = {
  [K in keyof TopicTreeConfig]?: Partial<TopicTreeConfig[K]>;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const defaultTopicTreeConfig: TopicTreeConfig = deepFreeze(TopicTreeConfigSchema.parse({}));

/** The default configuration with some groups overridden; the result is validated. */
export function topicTreeConfigWith(
  overrides: TopicTreeConfigOverrides,
  base: TopicTreeConfig = defaultTopicTreeConfig
): TopicTreeConfig {
  const merged: Record<string, unknown> = {};
  for (const [group, values] of Object.entries(base)) {
    merged[group] = { ...values, ...(overrides as Record<string, object | undefined>)[group] };
  }
  return deepFreeze(TopicTreeConfigSchema.parse(merged));
}

/**
 * Shape presets (plan 4.1: "The Broad/Balanced/Deep preference shifts I3/I4"). They change only
 * the soft fan-out range and targets (I3) and the soft leaf range and target (I4); hard limits,
 * placement and stability values are untouched.
 */
export const topicTreePresets = ["broad", "balanced", "deep"] as const;
export type TopicTreePreset = (typeof topicTreePresets)[number];

const presetShapes: Record<
  TopicTreePreset,
  {
    fanOut: Pick<TopicTreeConfig["fanOut"], "min" | "max" | "targetMin" | "targetMax">;
    leaf: Pick<TopicTreeConfig["leaf"], "min" | "max" | "target">;
  }
> = {
  broad: {
    fanOut: { min: 2, max: 14, targetMin: 6, targetMax: 11 },
    leaf: { min: 4, max: 40, target: 20 }
  },
  balanced: {
    fanOut: { min: 2, max: 12, targetMin: 4, targetMax: 9 },
    leaf: { min: 3, max: 30, target: 15 }
  },
  deep: {
    fanOut: { min: 2, max: 10, targetMin: 3, targetMax: 7 },
    leaf: { min: 3, max: 22, target: 10 }
  }
};

export function topicTreeConfigForPreset(
  preset: TopicTreePreset,
  base: TopicTreeConfig = defaultTopicTreeConfig
): TopicTreeConfig {
  const shape = presetShapes[preset];
  return topicTreeConfigWith(
    { fanOut: { ...base.fanOut, ...shape.fanOut }, leaf: { ...base.leaf, ...shape.leaf } },
    base
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareStrings(a, b)
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** Canonical JSON (sorted keys) of a configuration: the input of `topic_trees.config_hash`. */
export function canonicalTopicTreeConfig(config: TopicTreeConfig): string {
  return canonicalJson(TopicTreeConfigSchema.parse(config));
}
