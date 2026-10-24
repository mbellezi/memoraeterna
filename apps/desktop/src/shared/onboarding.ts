// What the first run's second step reads of this computer (F4 D31, D32). The hardware probe and the
// tier table are T97's; the onboarding takes from `hardware.profile` only what its card shows, so
// this is the one shape the controller and the first-run end-to-end test share. Allowlisted facts
// only (decision 32): no serial number, no identifier, nothing that names the person or the machine.
import { AiPresetIdSchema, type AiPresetId } from "@app/domain";
import { z } from "zod";

const bytes = z.number().int().nonnegative();

/** The informative monthly estimate of one setup; null when it is not metered or not known. */
export const OnboardingSetupEstimateSchema = z
  .object({
    preset: AiPresetIdSchema,
    /** US dollars a month, from the versioned price table; never a promise. */
    monthlyUsd: z.number().nonnegative().finite().nullable()
  })
  .strict();

/** Why Local does not run here, in the tier table's words (T97 `localUnavailableReasons`). */
export const localRefusals = [
  "requires_apple_silicon",
  "no_local_writer_for_platform",
  "memory"
] as const;
export const LocalRefusalSchema = z.enum(localRefusals);
export type LocalRefusal = z.infer<typeof LocalRefusalSchema>;

/**
 * The tier table's Local offer: whether Local runs and fits on this computer, why not, and the
 * catalog writer it installs (the same planner the main process applies).
 */
export const OnboardingLocalOfferSchema = z
  .object({
    available: z.boolean(),
    unavailableReason: LocalRefusalSchema.nullable(),
    writerCatalogId: z.string().min(1).nullable()
  })
  .strict()
  .refine((local) => local.available === (local.unavailableReason === null), {
    message: "Local is refused with a reason, and only then."
  })
  .refine((local) => !local.available || local.writerCatalogId !== null, {
    message: "An available Local names the writer it installs."
  });

export const OnboardingHardwareSchema = z
  .object({
    platform: z.enum(["darwin", "win32", "linux", "other"]),
    /** The processor's own architecture: an x64 app under Rosetta still reports arm64. */
    nativeArch: z.enum(["arm64", "x64", "other"]),
    /** The app runs translated (Rosetta): it works, but not as the native build would. */
    translated: z.boolean(),
    /** The chip or processor name when the probe found it. */
    chip: z.string().max(120).nullable(),
    memoryBytes: bytes,
    /** What the GPU may use of it (Apple unified memory); null when unknown. */
    workingSetBytes: bytes.nullable(),
    /** The tier table's pick for this machine. */
    recommended: AiPresetIdSchema,
    local: OnboardingLocalOfferSchema,
    estimates: z.array(OnboardingSetupEstimateSchema).max(3)
  })
  .strict();
export type OnboardingHardware = z.infer<typeof OnboardingHardwareSchema>;

/** What Settings gives a model added for generation (`AiSettingsView`): the capabilities of a writer. */
export const writerCapabilities = [
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "requires-network",
  "requires-api-key"
] as const;
/** The same for a ChatGPT sign-in, which needs no API key. */
export const codexWriterCapabilities = writerCapabilities.filter(
  (capability) => capability !== "requires-api-key"
);
export const codexProviderId = "openai-codex";

/** Whether this computer runs the MLX models (macOS on Apple silicon, translated or not). */
export function runsMlx(hardware: Pick<OnboardingHardware, "platform" | "nativeArch">): boolean {
  return hardware.platform === "darwin" && hardware.nativeArch === "arm64";
}

/**
 * Why the Local setup is refused here, or null when it runs: macOS with Apple silicon only (no GGUF
 * writers, decision 26), and only where the tier table says its writer fits (decision 25).
 */
export function localRefusal(
  hardware: Pick<OnboardingHardware, "platform" | "nativeArch" | "local">
): LocalRefusal | null {
  if (!runsMlx(hardware))
    return hardware.local.unavailableReason === "no_local_writer_for_platform"
      ? "no_local_writer_for_platform"
      : "requires_apple_silicon";
  return hardware.local.available ? null : (hardware.local.unavailableReason ?? "memory");
}

export function localSetupAvailable(
  hardware: Pick<OnboardingHardware, "platform" | "nativeArch" | "local">
): boolean {
  return localRefusal(hardware) === null;
}

/**
 * What the onboarding reads of T97's `hardware.profile` answer: a structural subset of its
 * `HardwareProfileResult`, so the real answer is accepted as it is and a renamed field fails the
 * build instead of the card.
 */
export interface HardwareProfileReading {
  profile: {
    platform: OnboardingHardware["platform"];
    nativeArch: OnboardingHardware["nativeArch"];
    translated: boolean;
    cpu: { brand: string | null };
    memoryBytes: number;
    workingSet: { bytes: number } | null;
  };
  recommendation: {
    recommended: AiPresetId;
    local: {
      offer: "available" | "unavailable";
      unavailableReason: LocalRefusal | null;
      writerCatalogId: string | null;
    };
    costs: Record<
      "local" | "hybrid" | "cloud",
      { routes: ReadonlyArray<{ kind: "local" | "subscription" | "api"; monthlyUsd: number }> }
    >;
  };
}

/**
 * The tier card's reading of a `hardware.profile` answer. The monthly estimate of a cloud setup is
 * its API key route (the copy says a ChatGPT subscription adds nothing); Local costs nothing.
 */
export function onboardingHardwareOf(reading: HardwareProfileReading): OnboardingHardware {
  const { profile, recommendation } = reading;
  const apiMonthly = (preset: "hybrid" | "cloud"): number | null =>
    recommendation.costs[preset].routes.find((route) => route.kind === "api")?.monthlyUsd ?? null;
  return OnboardingHardwareSchema.parse({
    platform: profile.platform,
    nativeArch: profile.nativeArch,
    translated: profile.translated,
    chip: profile.cpu.brand,
    memoryBytes: profile.memoryBytes,
    workingSetBytes: profile.workingSet?.bytes ?? null,
    recommended: recommendation.recommended,
    local: {
      available: recommendation.local.offer === "available",
      unavailableReason:
        recommendation.local.offer === "available"
          ? null
          : (recommendation.local.unavailableReason ?? "memory"),
      writerCatalogId: recommendation.local.writerCatalogId
    },
    estimates: [
      { preset: "local", monthlyUsd: null },
      { preset: "hybrid", monthlyUsd: apiMonthly("hybrid") },
      { preset: "cloud", monthlyUsd: apiMonthly("cloud") }
    ]
  });
}
