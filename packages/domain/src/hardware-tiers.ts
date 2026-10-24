// The hardware profile and the tier table (F4 D32, T97; plan decisions 25 and 26). Pure: the main
// process probes the machine (`apps/desktop/src/main/services/hardware`) and hands the profile to
// `recommendSetup`, which maps it to a tier, a recommended preset with alternatives, the local writer
// of today's catalog and the informative price of each preset. Decision 26 keeps every model of the
// program where it is: the table names only the catalog entries the presets already use, a local
// writer is recommended only once the owner marks its quality class verified (typed configuration,
// empty today), and nothing here downloads, routes or changes a setting. The profile holds an
// allowlist of fields and never leaves the device (docs/spikes/hardware-tiers-and-models.md 6.4).
import { z } from "zod";

import {
  AiPresetIdSchema,
  planAiPreset,
  presetCatalogIds,
  type AiPresetId,
  type PresetMachine
} from "./ai-presets.js";
import {
  PriceBillingSchema,
  defaultPriceTable,
  resolvePrice,
  tokensCostUsd,
  type PriceEntry,
  type PriceTable
} from "./price-table.js";

const gib = 1024 ** 3;

export const hardwarePlatforms = ["darwin", "win32", "linux", "other"] as const;
export const HardwarePlatformSchema = z.enum(hardwarePlatforms);
export type HardwarePlatform = z.infer<typeof HardwarePlatformSchema>;

export const hardwareArchitectures = ["arm64", "x64", "other"] as const;
export const HardwareArchitectureSchema = z.enum(hardwareArchitectures);
export type HardwareArchitecture = z.infer<typeof HardwareArchitectureSchema>;

export const gpuKinds = ["apple", "discrete", "integrated", "none", "unknown"] as const;
export const GpuKindSchema = z.enum(gpuKinds);
export type GpuKind = z.infer<typeof GpuKindSchema>;

/** Where the Apple working-set figure comes from: the explicit wired limit, or the estimate by memory. */
export const workingSetSources = ["wired_limit", "estimated"] as const;

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const macPattern = /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/iu;

/**
 * Whether a probed text may enter the profile: a product or chip name, never an identifier of the
 * machine, its owner or its network (serial, UUID, UDID, MAC address, path).
 */
export function isPublicDeviceLabel(text: string): boolean {
  return (
    !/\p{Cc}/u.test(text) &&
    !uuidPattern.test(text) &&
    !macPattern.test(text) &&
    !/[\\/]/u.test(text) &&
    !/serial|udid|uuid|hostname/iu.test(text)
  );
}

const DeviceLabelSchema = z.string().min(1).max(120).refine(isPublicDeviceLabel, {
  message: "a device label never carries an identifier of the machine"
});

/** The probed facts, an allowlist (spike 6.4): adding a field is a decision, not a convenience. */
export const HardwareProfileSchema = z
  .object({
    version: z.literal(1),
    platform: HardwarePlatformSchema,
    /** `process.arch` of the app. */
    processArch: HardwareArchitectureSchema,
    /** The machine's own architecture: `arm64` for Apple silicon even when the app runs under Rosetta. */
    nativeArch: HardwareArchitectureSchema,
    /** The app runs translated (Rosetta) on Apple silicon. */
    translated: z.boolean(),
    /** The kernel or build release, as the fingerprint reads it (`os.release()`). */
    osRelease: z.string().min(1).max(60),
    cpu: z
      .object({
        brand: DeviceLabelSchema.nullable(),
        physicalCores: z.number().int().positive().nullable(),
        logicalCores: z.number().int().positive().nullable()
      })
      .strict(),
    memoryBytes: z.number().int().positive(),
    gpu: z
      .object({
        kind: GpuKindSchema,
        name: DeviceLabelSchema.nullable(),
        /** Apple GPU cores. */
        cores: z.number().int().positive().nullable(),
        /** Dedicated video memory of a discrete GPU (never the 4 GB `AdapterRAM` of WMI). */
        vramBytes: z.number().int().positive().nullable()
      })
      .strict(),
    /** Apple silicon only: the memory the GPU may wire (the Metal working set), once per probe. */
    workingSet: z
      .object({ bytes: z.number().int().positive(), source: z.enum(workingSetSources) })
      .strict()
      .nullable(),
    /** Informational only: no runtime uses an NPU. */
    npu: z.object({ present: z.boolean(), name: DeviceLabelSchema.nullable() }).strict(),
    /** False when a command failed and the profile holds the Node figures only; never cached then. */
    complete: z.boolean(),
    probedAt: z.iso.datetime()
  })
  .strict();
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

export const hardwareTierIds = [
  "apple-8",
  "apple-16",
  "apple-24",
  "apple-32",
  "apple-48",
  "apple-64",
  "apple-96",
  "apple-128",
  "mac-intel",
  "windows-basic",
  "windows-standard",
  "windows-large",
  "other"
] as const;
export const HardwareTierIdSchema = z.enum(hardwareTierIds);
export type HardwareTierId = z.infer<typeof HardwareTierIdSchema>;

/** Why a recommendation reads the way it does; the onboarding renders each code in its own words. */
export const hardwareReasons = [
  "local_quality_unverified",
  "local_memory_too_small",
  "local_requires_apple_silicon",
  "local_writer_unavailable",
  "running_under_rosetta",
  "ranker_slow_on_cpu",
  "probe_incomplete"
] as const;
export const HardwareReasonSchema = z.enum(hardwareReasons);
export type HardwareReason = z.infer<typeof HardwareReasonSchema>;

/** The writer quality classes of the spike (S: 5B and below, M: 9-12B, L: 26-35B). */
export const localQualityClasses = ["S", "M", "L"] as const;
export const LocalQualityClassSchema = z.enum(localQualityClasses);
export type LocalQualityClass = z.infer<typeof LocalQualityClassSchema>;

export const HardwareTierConfigSchema = z
  .object({
    /** Memory kept for macOS, Electron and PostgreSQL beside the local models (cal.). */
    hostReserveBytes: z.number().int().positive(),
    /** The embedder and ranker kept resident beside the writer, their peak (cal.). */
    residentPairBytes: z.number().int().positive(),
    /** The share of the working set node-llama-cpp keeps free, up to `workingSetPadMaxBytes`. */
    workingSetPadShare: z.number().min(0).max(0.5),
    workingSetPadMaxBytes: z.number().int().nonnegative(),
    /**
     * The default working set by memory when `iogpu.wired_limit_mb` is unset: the share applies to
     * memory up to `upToBytes` (66.7% measured at 16 GB, about 74% at 24 GB; the rest inferred and
     * kept at the lowest value reported, 75%; 81.0% was measured at 64 GB on macOS 27).
     */
    workingSetShares: z
      .array(
        z.object({ upToBytes: z.number().positive(), share: z.number().gt(0).lte(1) }).strict()
      )
      .min(1),
    /** The writers the presets use, by catalog id (decision 26: no other model is named). */
    localWriters: z.record(
      z.string(),
      z
        .object({
          qualityClass: LocalQualityClassSchema,
          /** The budget below which the writer is not offered: footprint at 8k context times 1.25 (cal.). */
          minimumBudgetBytes: z.number().int().positive()
        })
        .strict()
    ),
    /**
     * The classes whose local writers the owner accepted as a default. A class "S" never qualifies;
     * "M" qualifies after the quality check of the benchmark (decision 26: the owner decides after the
     * program), so the list is empty today and Local is offered, never recommended.
     */
    verifiedQualityClasses: z.array(z.enum(["M", "L"])),
    /** Memory from which a Windows machine without a discrete GPU is no longer "basic". */
    windowsBasicBelowBytes: z.number().int().positive(),
    /** The VRAM or memory from which a Windows machine is "large" (a local writer fits once one ships). */
    windowsLargeVramBytes: z.number().int().positive(),
    windowsLargeMemoryBytes: z.number().int().positive(),
    /** The price table entries each cost estimate reads (informative, decision 26). */
    costReferences: z
      .object({
        subscription: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict(),
        api: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()
      })
      .strict(),
    /** The tokens of a typical month (spike 9.1; 250 notes, 60 questions, 60 explanations) (cal.). */
    typicalMonth: z
      .object({
        writingInputTokens: z.number().int().nonnegative(),
        writingOutputTokens: z.number().int().nonnegative(),
        /** The generative decide calls of the Cloud preset (the Hybrid ranker decides locally). */
        decideInputTokens: z.number().int().nonnegative(),
        decideOutputTokens: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type HardwareTierConfig = z.infer<typeof HardwareTierConfigSchema>;

export const defaultHardwareTierConfig: HardwareTierConfig = HardwareTierConfigSchema.parse({
  hostReserveBytes: 9 * gib,
  residentPairBytes: 2 * gib,
  workingSetPadShare: 0.08,
  workingSetPadMaxBytes: Math.round(1.6 * gib),
  workingSetShares: [
    { upToBytes: 16 * gib, share: 2 / 3 },
    { upToBytes: 24 * gib, share: 0.74 },
    { upToBytes: Number.MAX_SAFE_INTEGER, share: 0.75 }
  ],
  localWriters: {
    [presetCatalogIds.writerSmall]: {
      qualityClass: "S",
      minimumBudgetBytes: Math.round(4.5 * gib)
    },
    [presetCatalogIds.writerLarge]: { qualityClass: "M", minimumBudgetBytes: Math.round(8.8 * gib) }
  },
  verifiedQualityClasses: [],
  windowsBasicBelowBytes: 12 * gib,
  windowsLargeVramBytes: 20 * gib,
  windowsLargeMemoryBytes: 48 * gib,
  costReferences: {
    subscription: { provider: "openai-codex", model: "gpt-5.6-luna" },
    api: { provider: "openai-compatible", model: "gpt-6-luna" }
  },
  typicalMonth: {
    writingInputTokens: 1_520_000,
    writingOutputTokens: 470_000,
    decideInputTokens: 262_500,
    decideOutputTokens: 60_000
  }
});

/** The memory the GPU of an Apple silicon Mac may wire by default, estimated from its memory. */
export function estimateAppleWorkingSetBytes(
  memoryBytes: number,
  config: HardwareTierConfig = defaultHardwareTierConfig
): number {
  const row =
    config.workingSetShares.find((candidate) => memoryBytes <= candidate.upToBytes) ??
    config.workingSetShares[config.workingSetShares.length - 1]!;
  return Math.floor(memoryBytes * row.share);
}

/**
 * What a local writer may use on an Apple silicon Mac: the working set less its padding, bounded by
 * the memory the host leaves, less the resident embedder and ranker (spike 6.2). It can be negative
 * (an 8 GB Mac); null off Apple silicon, where no local writer runs.
 */
export function localWriterBudgetBytes(
  profile: HardwareProfile,
  config: HardwareTierConfig = defaultHardwareTierConfig
): number | null {
  if (profile.platform !== "darwin" || profile.nativeArch !== "arm64") return null;
  const workingSet =
    profile.workingSet?.bytes ?? estimateAppleWorkingSetBytes(profile.memoryBytes, config);
  const padding = Math.min(workingSet * config.workingSetPadShare, config.workingSetPadMaxBytes);
  const usable = Math.min(workingSet - padding, profile.memoryBytes - config.hostReserveBytes);
  return Math.floor(usable - config.residentPairBytes);
}

/** The machine the preset planner reads, with the facts the probe adds to the Node figures. */
export function presetMachineFromProfile(profile: HardwareProfile): PresetMachine {
  return {
    platform: profile.platform,
    arch: profile.processArch,
    nativeArch: profile.nativeArch,
    translated: profile.translated,
    totalMemoryBytes: profile.memoryBytes,
    ...(profile.workingSet ? { workingSetBytes: profile.workingSet.bytes } : {})
  };
}

/** One row of the table: the preset it starts from, and the machines it covers (first match wins). */
export interface HardwareTierRow {
  id: HardwareTierId;
  /** The preset when Local does not qualify; Hybrid unless the machine cannot run the local ranker well. */
  baseline: Exclude<AiPresetId, "local">;
  matches(profile: HardwareProfile, config: HardwareTierConfig): boolean;
}

const appleSilicon = (profile: HardwareProfile): boolean =>
  profile.platform === "darwin" && profile.nativeArch === "arm64";

/** Memory classes of Apple silicon, by the next marketing size up; Macs report binary GiB. */
const appleRow = (id: HardwareTierId, belowGiB: number, fromGiB: number): HardwareTierRow => ({
  id,
  baseline: "hybrid",
  matches: (profile) =>
    appleSilicon(profile) &&
    profile.memoryBytes >= fromGiB * gib &&
    profile.memoryBytes < belowGiB * gib
});

/**
 * The tier table. Apple silicon rows are the spike's memory tiers (8, 16, 24, 32/36, 48, 64, 96 and
 * 128 GB and up); Windows rows have no Local preset, because the catalog holds no GGUF writer
 * (decision 26) and the probe is untested on hardware.
 */
export const hardwareTierRows: readonly HardwareTierRow[] = [
  appleRow("apple-8", 12, 0),
  appleRow("apple-16", 20, 12),
  appleRow("apple-24", 28, 20),
  appleRow("apple-32", 40, 28),
  appleRow("apple-48", 56, 40),
  appleRow("apple-64", 80, 56),
  appleRow("apple-96", 112, 80),
  appleRow("apple-128", Number.POSITIVE_INFINITY, 112),
  { id: "mac-intel", baseline: "hybrid", matches: (profile) => profile.platform === "darwin" },
  {
    id: "windows-large",
    baseline: "hybrid",
    matches: (profile, config) =>
      profile.platform === "win32" &&
      ((profile.gpu.kind === "discrete" &&
        (profile.gpu.vramBytes ?? 0) >= config.windowsLargeVramBytes) ||
        profile.memoryBytes >= config.windowsLargeMemoryBytes)
  },
  {
    // Without a discrete GPU the CPU ranker is slower than the 150 ms per pair the repository accepts,
    // so the generative decider of the Cloud preset is the better start (spike 3.1, derived).
    id: "windows-basic",
    baseline: "cloud",
    matches: (profile, config) =>
      profile.platform === "win32" &&
      profile.gpu.kind !== "discrete" &&
      profile.memoryBytes < config.windowsBasicBelowBytes
  },
  {
    id: "windows-standard",
    baseline: "hybrid",
    matches: (profile) => profile.platform === "win32"
  },
  { id: "other", baseline: "hybrid", matches: () => true }
];

/** The tier of a machine; every machine has one. */
export function classifyHardware(
  profile: HardwareProfile,
  config: HardwareTierConfig = defaultHardwareTierConfig
): HardwareTierId {
  return (hardwareTierRows.find((row) => row.matches(profile, config)) ?? hardwareTierRows.at(-1)!)
    .id;
}

export const localUnavailableReasons = [
  "requires_apple_silicon",
  "no_local_writer_for_platform",
  "memory"
] as const;
export const LocalUnavailableReasonSchema = z.enum(localUnavailableReasons);

/** What the Local preset is on this machine. */
export const LocalOfferSchema = z
  .object({
    offer: z.enum(["available", "unavailable"]),
    unavailableReason: LocalUnavailableReasonSchema.nullable(),
    /** The catalog entry the Local preset gives every write class here; null when no catalog writer applies. */
    writerCatalogId: z.string().nullable(),
    qualityClass: LocalQualityClassSchema.nullable(),
    /** The owner accepted this class as a default (empty until the program ends, decision 26). */
    qualityVerified: z.boolean(),
    /** What a local writer may use (see `localWriterBudgetBytes`); null off Apple silicon. */
    budgetBytes: z.number().int().nullable()
  })
  .strict();
export type LocalOffer = z.infer<typeof LocalOfferSchema>;

const CostRouteSchema = z
  .object({
    /** `local`: on this Mac, no charge. `subscription`: a ChatGPT plan through Codex, not metered. `api`: a key, per token. */
    kind: z.enum(["local", "subscription", "api"]),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    billing: PriceBillingSchema.nullable(),
    inputUsdPerM: z.number().nonnegative(),
    outputUsdPerM: z.number().nonnegative(),
    /** US$ for a typical month, list price; 0 where nothing is metered. */
    monthlyUsd: z.number().nonnegative(),
    /** The price was read on the provider's own page (the price table says so). */
    verified: z.boolean(),
    /** The price table version the figures come from; null for Local. */
    priceTableVersion: z.string().nullable()
  })
  .strict();
export type PresetCostRoute = z.infer<typeof CostRouteSchema>;

export const PresetCostSchema = z.object({ routes: z.array(CostRouteSchema).min(1) }).strict();
export type PresetCost = z.infer<typeof PresetCostSchema>;

export const TierRecommendationSchema = z
  .object({
    tier: HardwareTierIdSchema,
    recommended: AiPresetIdSchema,
    /** Every other preset that can run here, in the order to show them. Never blocking. */
    alternatives: z.array(AiPresetIdSchema),
    reasons: z.array(HardwareReasonSchema),
    local: LocalOfferSchema,
    /** Price and estimated monthly cost of each preset, informative (decisions 25 and 26). */
    costs: z
      .object({ local: PresetCostSchema, hybrid: PresetCostSchema, cloud: PresetCostSchema })
      .strict()
  })
  .strict();
export type TierRecommendation = z.infer<typeof TierRecommendationSchema>;

/** `hardware.profile`: the cached profile, the figures read now and the recommendation. */
export const HardwareProfileResultSchema = z
  .object({
    profile: HardwareProfileSchema,
    /** Free bytes where the app keeps its data, read at the call (never cached); null when unreadable. */
    freeDiskBytes: z.number().int().nonnegative().nullable(),
    /** The pinned download size of the local writer the recommendation names; null without one. */
    localWriterBytes: z.number().int().positive().nullable(),
    recommendation: TierRecommendationSchema
  })
  .strict();
export type HardwareProfileResult = z.infer<typeof HardwareProfileResultSchema>;

/** `hardware.profile` takes nothing, or asks for a full re-probe ("Re-detect"). */
export const HardwareProfileInputSchema = z.object({ refresh: z.boolean().optional() }).strict();
export type HardwareProfileInput = z.infer<typeof HardwareProfileInputSchema>;

function priceEntryOf(table: PriceTable, provider: string, model: string): PriceEntry | undefined {
  const entries = table.entries.filter((entry) => entry.provider === provider);
  return (
    entries.find((entry) => entry.model === model) ?? entries.find((entry) => entry.model === "*")
  );
}

const roundCents = (usd: number): number => Math.round(usd * 100) / 100;

function costRoute(
  kind: "subscription" | "api",
  withDecide: boolean,
  table: PriceTable,
  config: HardwareTierConfig
): PresetCostRoute {
  const reference = config.costReferences[kind];
  const price = resolvePrice(table, reference.provider, reference.model);
  const month = config.typicalMonth;
  const tokens = {
    inputTokens: month.writingInputTokens + (withDecide ? month.decideInputTokens : 0),
    outputTokens: month.writingOutputTokens + (withDecide ? month.decideOutputTokens : 0)
  };
  return {
    kind,
    provider: reference.provider,
    model: reference.model,
    billing: price.billing,
    inputUsdPerM: price.inputUsdPerM,
    outputUsdPerM: price.outputUsdPerM,
    monthlyUsd: roundCents(tokensCostUsd(price, tokens)),
    verified:
      price.known && (priceEntryOf(table, reference.provider, reference.model)?.verified ?? false),
    priceTableVersion: price.priceTableVersion
  };
}

const localCost: PresetCost = {
  routes: [
    {
      kind: "local",
      provider: null,
      model: null,
      billing: null,
      inputUsdPerM: 0,
      outputUsdPerM: 0,
      monthlyUsd: 0,
      verified: true,
      priceTableVersion: null
    }
  ]
};

/** The price and the estimated month of each preset from the price table (T76), the same on every machine. */
export function presetCosts(
  table: PriceTable = defaultPriceTable,
  config: HardwareTierConfig = defaultHardwareTierConfig
): TierRecommendation["costs"] {
  return {
    local: localCost,
    hybrid: {
      routes: [
        costRoute("subscription", false, table, config),
        costRoute("api", false, table, config)
      ]
    },
    cloud: {
      routes: [
        costRoute("subscription", true, table, config),
        costRoute("api", true, table, config)
      ]
    }
  };
}

function localOffer(profile: HardwareProfile, config: HardwareTierConfig): LocalOffer {
  const budgetBytes = localWriterBudgetBytes(profile, config);
  const planned = planAiPreset("local", presetMachineFromProfile(profile));
  const none = {
    offer: "unavailable",
    writerCatalogId: null,
    qualityClass: null,
    qualityVerified: false,
    budgetBytes
  } as const;
  if (!planned.ok)
    return {
      ...none,
      unavailableReason:
        profile.platform === "win32" || profile.platform === "linux"
          ? "no_local_writer_for_platform"
          : "requires_apple_silicon"
    };
  const writer = planned.plan.classes["write-fast"];
  const catalogId = writer.kind === "local-model" ? writer.catalogId : null;
  const spec = catalogId ? config.localWriters[catalogId] : undefined;
  if (!catalogId || !spec) return { ...none, unavailableReason: "no_local_writer_for_platform" };
  const fits = budgetBytes !== null && budgetBytes >= spec.minimumBudgetBytes;
  return {
    offer: fits ? "available" : "unavailable",
    unavailableReason: fits ? null : "memory",
    writerCatalogId: catalogId,
    qualityClass: spec.qualityClass,
    qualityVerified:
      spec.qualityClass !== "S" &&
      config.verifiedQualityClasses.some((verified) => verified === spec.qualityClass),
    budgetBytes
  };
}

/**
 * The recommended setup of a machine (decision 25): one predefined preset, the others one click away,
 * nothing blocked. Local is recommended only where it fits and its writer's quality class is verified;
 * otherwise Hybrid (Cloud on a Windows machine whose CPU ranker would be slow), with Local offered where
 * it fits as a private mode.
 */
export function recommendSetup(
  profile: HardwareProfile,
  options: { priceTable?: PriceTable; config?: HardwareTierConfig } = {}
): TierRecommendation {
  const config = options.config ?? defaultHardwareTierConfig;
  const row = hardwareTierRows.find((candidate) => candidate.matches(profile, config))!;
  const local = localOffer(profile, config);
  const recommended: AiPresetId =
    local.offer === "available" && local.qualityVerified ? "local" : row.baseline;

  const reasons: HardwareReason[] = [];
  if (local.unavailableReason === "memory") reasons.push("local_memory_too_small");
  else if (local.unavailableReason === "requires_apple_silicon")
    reasons.push("local_requires_apple_silicon");
  else if (local.unavailableReason === "no_local_writer_for_platform")
    reasons.push("local_writer_unavailable");
  else if (!local.qualityVerified) reasons.push("local_quality_unverified");
  if (profile.translated && profile.nativeArch === "arm64") reasons.push("running_under_rosetta");
  if (row.id === "windows-basic") reasons.push("ranker_slow_on_cpu");
  if (!profile.complete) reasons.push("probe_incomplete");

  const order: AiPresetId[] =
    recommended === "cloud" ? ["hybrid", "local", "cloud"] : ["local", "hybrid", "cloud"];
  const alternatives = order.filter(
    (preset) => preset !== recommended && (preset !== "local" || local.offer === "available")
  );
  return {
    tier: row.id,
    recommended,
    alternatives,
    reasons,
    local,
    costs: presetCosts(options.priceTable, config)
  };
}
