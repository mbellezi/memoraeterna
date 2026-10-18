import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { fakeRemoteKnob } from "@app/ai";
import { z } from "zod";

import { faultPlanSchema } from "./fault-decorator.js";

/**
 * The soak plan (F3 T62, spec 5.9) and the two DEV knobs that read it. `scripts/soak/plan.json`
 * holds the profiles of the 24 h soak and of the 4 h pre-soak (gate P); `MEMORA_FAKE_REMOTE` arms
 * the fake remote providers from it and `MEMORA_SOAK` starts the driver from it, both refused when
 * packaged, together with another DEV measurement knob, and on a profile that is not a clone inside
 * `.cache/profiles/` (they write fake provider routes into the library's AI configuration, and the
 * driver imports, edits and deletes library content).
 */

export const soakPlanFormat = "memora-soak-plan";
export const fakeRemoteKnobName = fakeRemoteKnob;
export const soakKnobName = "MEMORA_SOAK";
export const soakProfileKnobName = "MEMORA_SOAK_PROFILE";
export const soakRunKnobName = "MEMORA_SOAK_RUN";
export const defaultSoakProfile = "soak24";
export const soakSetupKnobName = "MEMORA_SOAK_SETUP";

/** Other DEV knobs that change what a call does or own the library, which a soak would then measure. */
export const soakConflictingKnobs = [
  "MEMORA_AI_CASSETTE",
  "MEMORA_LEGACY_WIPE",
  "MEMORA_PROFILE_RESET",
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_GOLDEN_NOTE_PAIRS",
  "MEMORA_GOLDEN_TOPICS",
  "MEMORA_GOLDEN_PIN",
  "MEMORA_GOLDEN_RELATIONS",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK",
  "MEMORA_DEV_LANE_PROBE",
  "MEMORA_DEV_EXPLAIN_PROBE",
  "MEMORA_TYPER_CHECK",
  "MEMORA_RELATIONS_REMATCH",
  "MEMORA_SOAK_SETUP"
] as const;

const minutes = z.number().positive();
const every = z
  .object({ everyMinutes: minutes, offsetMinutes: z.number().nonnegative().default(0) })
  .strict();

/** What the recorded Codex durations stand in for: one task of the fit per fake. */
const latencySchema = z
  .object({
    /** The JSON `scripts/soak/latency-fit.ts` wrote; null uses `fixedMs`. */
    fit: z.string().nullable().default(null),
    /** The task of the fit whose durations this fake draws from. */
    task: z.string().nullable().default(null),
    fixedMs: z.number().int().nonnegative().default(2_000),
    minMs: z.number().int().nonnegative().default(300),
    maxMs: z.number().int().positive().default(90_000),
    firstByteFraction: z.number().min(0).max(0.9).default(0.3)
  })
  .strict();

export const soakProfileSchema = z
  .object({
    description: z.string().default(""),
    /** Seed of every random draw: the faults, the latencies, the order of articles and questions. */
    seed: z.number().int(),
    durationHours: z.number().positive(),
    /** The start of the run is warm-up: the swap bar counts from its end. */
    warmupMinutes: z.number().nonnegative().default(30),
    sampleEveryMinutes: z.number().positive().default(1),
    driver: z
      .object({
        /** A public corpus article through the real ingestion path. */
        article: every,
        /** An Ask question (P0). */
        ask: every,
        /** An explanation opened through the service (P0). */
        explain: every,
        /** A burst of explanations opened together. */
        explainBurst: every.extend({ count: z.number().int().positive().max(50) }),
        /** A human edit of a note (re-embed). */
        noteEdit: every,
        /** A source deleted and imported again as a new version. */
        sourceReimport: every,
        /** A source whose typing fails deterministically. */
        typingFault: every,
        /** An explanation opened this long after an outage of the Codex-wire fake ends (the probe that closes its breaker). */
        postOutageProbeSeconds: z.number().int().positive().default(35)
      })
      .strict(),
    remote: z
      .object({
        openAiCompatible: z.object({ latency: latencySchema, faults: faultPlanSchema }).strict(),
        codexWire: z
          .object({
            latency: latencySchema,
            faults: faultPlanSchema,
            notRelatedRate: z.number().min(0).max(1).default(0.02)
          })
          .strict()
      })
      .strict(),
    local: z
      .object({
        /** SIGKILL of the MLX helper, every so often, plus or minus a seeded jitter. */
        mlxKill: z
          .object({ everyMinutes: minutes, jitterMinutes: z.number().nonnegative().default(0) })
          .strict(),
        /** A forced abort of the GGUF embedder during an embedding batch. */
        ggufAbort: z.object({ everyMinutes: minutes }).strict()
      })
      .strict(),
    /** The deadline bounds of the remote adapters the fakes are checked against (the defaults). */
    bounds: z
      .object({
        connectMs: z.number().int().positive().default(10_000),
        firstByteMs: z.number().int().positive().default(30_000),
        stallMs: z.number().int().positive().default(20_000)
      })
      .strict()
      .default({ connectMs: 10_000, firstByteMs: 30_000, stallMs: 20_000 })
  })
  .strict();
export type SoakProfile = z.infer<typeof soakProfileSchema>;
export type SoakLatencySpec = SoakProfile["remote"]["codexWire"]["latency"];

/**
 * The recorded duration distribution `scripts/soak/latency-fit.ts` writes: per task, the durations
 * of the recorded Codex entries at 21 evenly spaced quantiles (the minimum, every 5th percentile,
 * the maximum).
 */
export const latencyFitFormat = "memora-soak-latency-fit";
export const latencyFitSchema = z
  .object({
    format: z.literal(latencyFitFormat),
    version: z.literal(1),
    generatedAt: z.string().datetime(),
    /** Where the entries came from (cassette directories, relative to the repository). */
    sources: z.array(z.string()),
    tasks: z.record(
      z.string(),
      z
        .object({
          count: z.number().int().positive(),
          quantilesMs: z.array(z.number().int().nonnegative()).min(2),
          p50: z.number().int().nonnegative(),
          p90: z.number().int().nonnegative(),
          p99: z.number().int().nonnegative()
        })
        .strict()
    )
  })
  .strict();
export type LatencyFit = z.infer<typeof latencyFitSchema>;

export const soakPlanFileSchema = z
  .object({
    format: z.literal(soakPlanFormat),
    version: z.literal(1),
    profiles: z.record(z.string(), soakProfileSchema)
  })
  .strict();
export type SoakPlanFile = z.infer<typeof soakPlanFileSchema>;

export type SoakKnobRefusalCode =
  | "packaged"
  | "outsideProfiles"
  | "invalidPlan"
  | "unknownProfile"
  | "conflictingKnob"
  | "needsFakeRemote"
  | "catalogHeadersOff"
  | "invalidValue";

export class SoakKnobRefusal extends Error {
  public constructor(
    public readonly code: SoakKnobRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "SoakKnobRefusal";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export interface SoakKnobEnvironment {
  isPackaged: boolean;
  workspaceRoot: string;
  /** The profile folder the app runs on. */
  userDataPath: string;
}

export interface SoakKnobSettings {
  /** The plan file's absolute path. */
  planPath: string;
  profileName: string;
  profile: SoakProfile;
  /** The run directory name, from `MEMORA_SOAK_RUN` or built by the caller. */
  run: string | null;
}

/** Reads and validates a plan file; the profile must exist in it. */
export function readSoakPlan(
  planPath: string,
  profileName: string
): { profile: SoakProfile; profiles: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (error) {
    throw new SoakKnobRefusal(
      "invalidPlan",
      `The soak plan ${planPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = soakPlanFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new SoakKnobRefusal(
      "invalidPlan",
      `The soak plan ${planPath} is not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`
    );
  const profile = parsed.data.profiles[profileName];
  if (!profile)
    throw new SoakKnobRefusal(
      "unknownProfile",
      `The soak plan has no profile ${profileName} (it has ${Object.keys(parsed.data.profiles).join(", ")}).`
    );
  return { profile, profiles: Object.keys(parsed.data.profiles) };
}

export function insideProfiles(options: SoakKnobEnvironment): boolean {
  const profiles = resolve(options.workspaceRoot, ".cache", "profiles");
  const inside = relative(profiles, resolve(options.userDataPath));
  return !(inside === "" || inside.startsWith("..") || isAbsolute(inside));
}

/**
 * Reads one of the two knobs (`MEMORA_FAKE_REMOTE` or `MEMORA_SOAK`): null when unset, the plan and
 * the profile it selects otherwise. Refused when packaged, on a profile that is not inside
 * `<workspaceRoot>/.cache/profiles/`, together with another DEV measurement knob, with the catalog-
 * header catch-up switched off (the soak keeps the product's behaviour), for a plan that is not
 * valid, and for the driver without the fake providers (a real remote route would spend quota).
 */
export function readSoakKnob(
  name: typeof fakeRemoteKnobName | typeof soakKnobName,
  env: Env,
  options: SoakKnobEnvironment
): SoakKnobSettings | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new SoakKnobRefusal("packaged", `${name} is refused in packaged builds`);
  if (!insideProfiles(options))
    throw new SoakKnobRefusal(
      "outsideProfiles",
      `${name} only runs on a clone inside .cache/profiles/ (set MEMORA_USER_DATA_DIR)`
    );
  const conflict = soakConflictingKnobs.find((knob) => env[knob]?.trim());
  if (conflict) throw new SoakKnobRefusal("conflictingKnob", `${name} is refused with ${conflict}`);
  if (env.MEMORA_CATALOG_HEADERS?.trim().toLowerCase() === "off")
    throw new SoakKnobRefusal(
      "catalogHeadersOff",
      `${name} keeps the catalog-header catch-up on, as the product does; unset MEMORA_CATALOG_HEADERS`
    );
  if (name === soakKnobName && !env[fakeRemoteKnobName]?.trim())
    throw new SoakKnobRefusal(
      "needsFakeRemote",
      `${soakKnobName} needs ${fakeRemoteKnobName}: the soak's remote side is the fake providers`
    );
  const root = resolve(options.workspaceRoot);
  const planPath = resolve(root, raw);
  const inside = relative(root, planPath);
  if (inside.startsWith("..") || isAbsolute(inside) || !planPath.endsWith(".json"))
    throw new SoakKnobRefusal(
      "invalidPlan",
      `${name} must name a .json file inside the repository`
    );
  const profileName = env[soakProfileKnobName]?.trim() || defaultSoakProfile;
  const { profile } = readSoakPlan(planPath, profileName);
  return { planPath, profileName, profile, run: env[soakRunKnobName]?.trim() || null };
}

/** Whether the knob asks for the soak and may run (the job supervisor then stays under its control). */
export function soakRequested(env: Env, options: SoakKnobEnvironment): boolean {
  try {
    return readSoakKnob(soakKnobName, env, options) !== null;
  } catch {
    return false;
  }
}
