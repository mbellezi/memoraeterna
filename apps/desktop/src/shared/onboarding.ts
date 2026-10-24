// What the first run's second step reads of this computer (F4 D31, D32). The hardware probe and the
// tier table are T97's; the onboarding takes from `hardware.profile` only what its card shows, so
// this is the one shape the controller and the first-run end-to-end test share. Allowlisted facts
// only (decision 32): no serial number, no identifier, nothing that names the person or the machine.
import { AiPresetIdSchema } from "@app/domain";
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

export const OnboardingHardwareSchema = z
  .object({
    platform: z.enum(["darwin", "win32", "linux"]),
    /** The processor's own architecture: an x64 app under Rosetta still reports arm64. */
    nativeArch: z.enum(["arm64", "x64"]),
    /** The app runs translated (Rosetta): it works, but not as the native build would. */
    translated: z.boolean(),
    /** The chip or processor name when the probe found it. */
    chip: z.string().max(120).nullable(),
    memoryBytes: bytes,
    /** What the GPU may use of it (Apple unified memory); null when unknown. */
    workingSetBytes: bytes.nullable(),
    /** The tier table's pick for this machine. */
    recommended: AiPresetIdSchema,
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

/** The Local setup runs on macOS with Apple silicon only (no GGUF writers, decision 26). */
export function localSetupAvailable(
  hardware: Pick<OnboardingHardware, "platform" | "nativeArch">
): boolean {
  return hardware.platform === "darwin" && hardware.nativeArch === "arm64";
}
