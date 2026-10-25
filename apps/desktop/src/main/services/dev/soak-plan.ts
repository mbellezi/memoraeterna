import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { fakeRemoteKnob } from "@app/ai";
import { z } from "zod";

import { faultPlanSchema } from "./fault-decorator.js";
import { answerCaptureProfileFolder } from "./soak-capture.js";
import {
  insideSoakProfiles,
  resolveSoakPaths,
  soakWorktreeProblem,
  type SoakPaths
} from "./soak-data-root.js";
import { soakF4Schema } from "./soak-plan-f4.js";
import {
  decisionsAdmitKnobName,
  decisionsKnobsSet,
  readDecisionsAdmission,
  readRealWriterKnob,
  realWriterKnobName,
  type DecisionsAdmission,
  type RealWriterSettings
} from "./soak-real-writer.js";
import { SoakKnobRefusal, type SoakKnobRefusalCode } from "./soak-refusal.js";

export { SoakKnobRefusal, type SoakKnobRefusalCode };

/**
 * The soak plan (F3 T62, spec 5.9) and the two DEV knobs that read it. `scripts/soak/plan.json`
 * holds the profiles of the 24 h soak and of the 4 h pre-soak (gate P); `MEMORA_FAKE_REMOTE` arms
 * the fake remote providers from it and `MEMORA_SOAK` starts the driver from it, both refused when
 * packaged, together with another DEV measurement knob, and on a profile that is not a clone inside
 * `.cache/profiles/` (they write fake provider routes into the library's AI configuration, and the
 * driver imports, edits and deletes library content). F4 (T89) adds the 7-day Hybrid soak: a profile
 * with an `f4` section runs the real Codex writer (`MEMORA_SOAK_REAL_WRITER`, `soak-real-writer.ts`)
 * under a token cap, from the folder `MEMORA_SOAK_DATA_ROOT` names (`soak-data-root.ts`).
 */

export const soakPlanFormat = "memora-soak-plan";
export const fakeRemoteKnobName = fakeRemoteKnob;
export const soakKnobName = "MEMORA_SOAK";
export const soakProfileKnobName = "MEMORA_SOAK_PROFILE";
export const soakRunKnobName = "MEMORA_SOAK_RUN";
export const defaultSoakProfile = "soak24";
export const soakSetupKnobName = "MEMORA_SOAK_SETUP";
/** The DEV knob that sets the source discovery neighbours of a run (`relations-dev-options.ts`, F4 C2). */
export const discoveryNeighboursKnobName = "MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS";

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
  // Both change the relations configuration the soak measures (F3 T63's helper batch, F4 C2's
  // discovery neighbours): a soak keeps the shipped values, and records the effective ones.
  "MEMORA_RELATIONS_HELPER_BATCH",
  discoveryNeighboursKnobName,
  // The soak's own windows drive the power override (D15); a fixed one from the start would change
  // the ground truth of every window. An automatic quit would end the run as "the app gone".
  "MEMORA_DEV_POWER_BLOCKS",
  "MEMORA_SMOKE_AUTO_QUIT_MS",
  "MEMORA_SOAK_SETUP"
] as const;

const minutes = z.number().positive();
const every = z
  .object({
    everyMinutes: minutes,
    offsetMinutes: z.number().nonnegative().default(0),
    /** Only on the odd or the even days of the run (day 1 is the first 24 h); both by default. */
    days: z.enum(["all", "odd", "even"]).default("all")
  })
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
        /** A topic page opened (F4): its overview is written or patched at P0 when stale. */
        topicOpen: every.optional(),
        /**
         * A contention burst (F4, spec 5.4): AUDIT lints, `reembeds` notes embedded again, a rolling
         * re-placement batch and `edits` human edits across as many roots, `editSpacingMinutes` apart.
         */
        contentionBurst: every
          .extend({
            reembeds: z.number().int().nonnegative().default(20),
            edits: z.number().int().positive().max(12).default(6),
            editSpacingMinutes: minutes.default(2)
          })
          .optional(),
        /** An explanation opened this long after an outage of the Codex-wire fake ends (the probe that closes its breaker). */
        postOutageProbeSeconds: z.number().int().positive().default(35)
      })
      .strict(),
    /** The two fake remote providers of F3's soaks; the 7-day soak has none (its writer is real). */
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
      .strict()
      .optional(),
    /** The folder family the run writes to: `f3/soak/<run>` or F4's `f4/soak/<run>`. */
    runFolder: z.enum(["f3", "f4"]).default("f3"),
    /** The real Codex writer's part of the plan (T89); a profile with it needs `MEMORA_SOAK_REAL_WRITER`. */
    f4: soakF4Schema.optional(),
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
export type SoakLatencySpec = z.infer<typeof latencySchema>;

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
  /** Where the soak reads and writes: the data root `MEMORA_SOAK_DATA_ROOT` names, else the checkout's `.cache`. */
  paths: SoakPaths;
  /** The Codex configuration of the real writer, when `MEMORA_SOAK_REAL_WRITER` names one. */
  realWriter: RealWriterSettings | null;
  /** The admitted Decisions configuration (decision 32's remote check), when the dormant knob admits it. */
  decisions: DecisionsAdmission | null;
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

/**
 * True when the profile folder is a folder inside `profiles/` of the soak's paths: the data root's
 * when `env` names one, else `<workspaceRoot>/.cache/profiles/`.
 */
export function insideProfiles(options: SoakKnobEnvironment, env: Env = {}): boolean {
  return insideSoakProfiles(options.userDataPath, resolveSoakPaths(env, options));
}

/**
 * Reads one of the two knobs (`MEMORA_FAKE_REMOTE` or `MEMORA_SOAK`): null when unset, the plan and
 * the profile it selects otherwise. Refused when packaged, on a profile that is not inside the
 * soak's `profiles/` folder, together with another DEV measurement knob (the discovery neighbours
 * and the Decisions decider's included, unless the dormant admission names the latter), with the
 * catalog-header catch-up switched off (the soak keeps the product's behaviour), for a plan that is
 * not valid, and for the driver without a remote side that spends nothing: the fake providers for a
 * plan without an `f4` section (a real remote route would spend quota), or the one Codex writer the
 * real-writer knob names for a plan with one (its token cap bounds the spend).
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
  const paths = resolveSoakPaths(env, options);
  if (!insideSoakProfiles(options.userDataPath, paths))
    throw new SoakKnobRefusal(
      "outsideProfiles",
      `${name} only runs on a clone inside ${paths.profilesDirectory}/ (set MEMORA_USER_DATA_DIR)`
    );
  const realWriter = readRealWriterKnob(env, {
    isPackaged: options.isPackaged,
    userDataPath: options.userDataPath,
    paths
  });
  const conflict = soakConflictingKnobs.find((knob) => env[knob]?.trim());
  if (conflict) throw new SoakKnobRefusal("conflictingKnob", `${name} is refused with ${conflict}`);
  if (env.MEMORA_CATALOG_HEADERS?.trim().toLowerCase() === "off")
    throw new SoakKnobRefusal(
      "catalogHeadersOff",
      `${name} keeps the catalog-header catch-up on, as the product does; unset MEMORA_CATALOG_HEADERS`
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
  const decisions = readDecisionsAdmission(env, {
    isPackaged: options.isPackaged,
    realWriter,
    profileDecisions: profile.f4?.decisions ?? "off"
  });
  const decisionsKnob = decisions ? undefined : decisionsKnobsSet(env)[0];
  if (decisionsKnob)
    throw new SoakKnobRefusal(
      "conflictingKnob",
      `${name} is refused with ${decisionsKnob}: the Decisions decider calls a real provider (only ${decisionsAdmitKnobName} admits it)`
    );
  if (name === soakKnobName) {
    if (profile.f4) {
      if (!realWriter)
        throw new SoakKnobRefusal(
          "needsRealWriter",
          `The plan profile ${profileName} runs the real Codex writer: set ${realWriterKnobName} to its provider configuration`
        );
      // D1: from a worktree outside the checkout, on the main checkout's data root and lock.
      const problem = soakWorktreeProblem(options.workspaceRoot, paths);
      if (problem) throw new SoakKnobRefusal("dataRoot", problem);
      // Full capture retains content: the owner's confirmation covers gate S's profile alone.
      if (
        profile.f4.capture === "answers" &&
        basename(options.userDataPath) !== answerCaptureProfileFolder
      )
        throw new SoakKnobRefusal(
          "capture",
          `The plan profile ${profileName} keeps every answer (full capture), which the owner confirmed for the profile folder ${answerCaptureProfileFolder} only`
        );
    } else {
      if (!env[fakeRemoteKnobName]?.trim())
        throw new SoakKnobRefusal(
          "needsFakeRemote",
          `${soakKnobName} needs ${fakeRemoteKnobName}: the soak's remote side is the fake providers`
        );
      if (realWriter)
        throw new SoakKnobRefusal(
          "realWriter",
          `The plan profile ${profileName} has no f4 section: the real writer would run with no token cap`
        );
    }
  }
  return {
    planPath,
    profileName,
    profile,
    run: env[soakRunKnobName]?.trim() || null,
    paths,
    realWriter,
    decisions
  };
}

/** Whether the knob asks for the soak and may run (the job supervisor then stays under its control). */
export function soakRequested(env: Env, options: SoakKnobEnvironment): boolean {
  try {
    return readSoakKnob(soakKnobName, env, options) !== null;
  } catch {
    return false;
  }
}
