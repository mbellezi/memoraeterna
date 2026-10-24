import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { bumpAiConfigGeneration, withTransaction, type PgPool } from "@app/db";
import { aiClassIds, supportsTask } from "@app/domain";
import { z } from "zod";

import {
  aiApplyPresetInputSchema,
  type AiApplyPresetInput,
  type AiApplyPresetResult,
  type AiClassRouteTarget,
  type AiClassRoutes
} from "../../../shared/ipc.js";
import { isSoakProfilePath, resolveSoakPaths, type SoakPaths } from "./soak-data-root.js";
import {
  SoakKnobRefusal,
  fakeRemoteKnobName,
  insideProfiles,
  soakConflictingKnobs,
  soakKnobName,
  soakSetupKnobName,
  type SoakKnobEnvironment
} from "./soak-plan.js";
import {
  decisionsKnobsSet,
  decisionsOptInProblem,
  readRealWriterKnob,
  realWriterProblems,
  type RealWriterSettings
} from "./soak-real-writer.js";
import { findRealRemoteReach, realRemoteProblem } from "./soak-routes.js";

/**
 * The scripted setup of a soak profile (F3 T62, `MEMORA_SOAK_SETUP=1`): on a clone inside
 * `.cache/profiles/`, applies the Local preset through the AI service, the path the Settings > AI
 * preset button takes, tests each class one by one as the button does, checks that no call of the
 * product can reach a real remote provider, prints the library and the effective routes per class,
 * writes them to `.cache/f3/soak/setup.json` and quits. It starts no job, no gateway and no vault
 * sync, and it is refused when packaged, beside any other DEV knob, or outside the profiles folder.
 *
 * A real remote default profile is the one thing it changes besides the preset: a task that no route
 * names would fall to it, so it makes the profile of the `write-fast` class (a local writer) the
 * default, and says so in the file.
 *
 * With `MEMORA_SOAK_REAL_WRITER=<codex providerConfigId>` (F4 T89) it sets up the 7-day soak's
 * Hybrid profile instead: the Codex configuration must exist with a sign-in, its profile becomes the
 * default remote writer, `hybrid` is applied (embedder and ranker local; write-fast, write-quality,
 * answer and the generative-decide routes on that profile), each class is tested with one real call
 * (the check that the token works), and the reach check admits that one configuration and no other
 * real provider. The Decisions decider must be off. The result goes to `<data root>/f4/soak/setup.json`.
 */

export const soakSetupFormat = "memora-soak-setup";

/** DEV knobs beside which the setup is refused: the library-changing and measurement ones, the soak itself. */
export const soakSetupConflictingKnobs = [
  ...soakConflictingKnobs,
  soakKnobName,
  fakeRemoteKnobName,
  "MEMORA_LOCAL_MODEL_INSTALL"
] as const;

/** Where the setup writes its result, under the repository. */
export const soakSetupPath = (workspaceRoot: string) =>
  join(workspaceRoot, ".cache", "f3", "soak", "setup.json");

type Env = Readonly<Record<string, string | undefined>>;

/** What a setup that may run is asked to do. */
export interface SoakSetupRequest {
  paths: SoakPaths;
  /** The Codex configuration of the Hybrid setup; null for the Local one. */
  realWriter: RealWriterSettings | null;
}

/**
 * The setup the knob asks for, or null when unset. Refused (thrown) when packaged, for a value other
 * than `1`, outside the soak's `profiles/` folder (`<workspaceRoot>/.cache/profiles/`, or the data
 * root's), beside any other DEV knob or a Decisions knob, and for a real-writer knob that does not
 * name a Codex configuration id.
 */
export function readSoakSetup(env: Env, options: SoakKnobEnvironment): SoakSetupRequest | null {
  const raw = env[soakSetupKnobName]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new SoakKnobRefusal("packaged", `${soakSetupKnobName} is refused in packaged builds`);
  if (raw !== "1")
    throw new SoakKnobRefusal("invalidValue", `${soakSetupKnobName} must be 1 (or unset)`);
  const paths = resolveSoakPaths(env, options);
  if (!insideProfiles(options, env))
    throw new SoakKnobRefusal(
      "outsideProfiles",
      `${soakSetupKnobName} only runs on a clone inside ${paths.profilesDirectory}/ (set MEMORA_USER_DATA_DIR)`
    );
  const conflict = soakSetupConflictingKnobs.find(
    (knob) => knob !== soakSetupKnobName && env[knob]?.trim()
  );
  if (conflict)
    throw new SoakKnobRefusal(
      "conflictingKnob",
      `${soakSetupKnobName} is refused with ${conflict}`
    );
  const decisions = decisionsKnobsSet(env)[0];
  if (decisions)
    throw new SoakKnobRefusal(
      "conflictingKnob",
      `${soakSetupKnobName} is refused with ${decisions}: the Decisions decider calls a real provider`
    );
  const realWriter = readRealWriterKnob(env, {
    isPackaged: options.isPackaged,
    userDataPath: options.userDataPath,
    paths
  });
  return { paths, realWriter };
}

/** True when the knob asks for the setup and may run; false when unset (see {@link readSoakSetup}). */
export function readSoakSetupKnob(env: Env, options: SoakKnobEnvironment): boolean {
  return readSoakSetup(env, options) !== null;
}

const iso = z.string().datetime();
const testSchema = z
  .object({
    state: z.enum(["untested", "passed", "failed", "none"]),
    ms: z.number().int().nonnegative().nullable(),
    error: z.string().nullable()
  })
  .strict();
const routeSchema = z
  .object({
    profile: z.string().nullable(),
    model: z.string().nullable(),
    runtime: z.string().nullable(),
    remote: z.boolean(),
    test: testSchema
  })
  .strict();

export const soakSetupSchema = z
  .object({
    format: z.literal(soakSetupFormat),
    version: z.literal(1),
    at: iso,
    userDataPath: z.string(),
    /** `ok`: the profile is ready; `blocked`: the preset needs a model that is not installed; `failed`: see `problems`. */
    status: z.enum(["ok", "blocked", "failed"]),
    problems: z.array(z.string()),
    preset: z
      .object({
        requested: z.enum(["local", "hybrid"]),
        applied: z.boolean(),
        mode: z.string().nullable(),
        blocked: z.array(
          z
            .object({
              route: z.string().nullable(),
              reason: z.string(),
              modelName: z.string().nullable()
            })
            .strict()
        )
      })
      .strict(),
    /** Sources that have no parent, all sources and all notes of the library. */
    library: z
      .object({ roots: z.number().int(), sources: z.number().int(), notes: z.number().int() })
      .strict(),
    classes: z.array(routeSchema.extend({ id: z.string() })),
    judge: routeSchema.extend({ routed: z.boolean(), deciderMode: z.string().nullable() }),
    /** The Codex writer of a Hybrid setup: its provider configuration and the profile that serves it. */
    writer: z
      .object({ providerConfigId: z.string(), profile: z.string().nullable() })
      .strict()
      .optional(),
    remote: z
      .object({
        /** Calls of the product that resolve to a real remote provider after the setup: empty when ready. */
        reachable: z.array(z.string()),
        defaultProfileChanged: z.object({ from: z.string(), to: z.string() }).strict().nullable(),
        /** Stored routes to a real provider that no call of the product resolves to (informational). */
        residual: z.array(z.string())
      })
      .strict()
  })
  .strict();
export type SoakSetupResult = z.infer<typeof soakSetupSchema>;

/** What the setup needs of the AI service: the three calls the Settings view makes. */
export interface SoakSetupAi {
  applyPreset(input: AiApplyPresetInput): Promise<AiApplyPresetResult>;
  testClassRoute(route: AiClassRouteTarget): Promise<AiClassRoutes>;
  classRoutes(): Promise<AiClassRoutes>;
}

export interface SoakSetupOptions extends SoakKnobEnvironment {
  env: Env;
  pool: PgPool;
  ai: SoakSetupAi;
  logger: Pick<Console, "info" | "error">;
  now?: () => Date;
}

async function countLibrary(pool: Pick<PgPool, "query">) {
  const result = await pool.query<{ roots: number; sources: number; notes: number }>(
    `select (select count(*)::int from source_items where parent_source_item_id is null) as roots,
            (select count(*)::int from source_items) as sources,
            (select count(*)::int from atomic_notes) as notes`
  );
  const row = result.rows[0];
  return {
    roots: Number(row?.roots ?? 0),
    sources: Number(row?.sources ?? 0),
    notes: Number(row?.notes ?? 0)
  };
}

/** Makes `profileId` the only default profile. */
async function setDefaultProfile(pool: PgPool, profileId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      "update ai_profile_sets set is_default = false, updated_at = now() where is_default"
    );
    await client.query(
      "update ai_profile_sets set is_default = true, updated_at = now() where id = $1",
      [profileId]
    );
  });
  bumpAiConfigGeneration();
}

/** The provider configuration each profile serves (null for a local model's profile). */
async function profileConfigOwners(
  pool: Pick<PgPool, "query">
): Promise<Map<string, string | null>> {
  const result = await pool.query<{ id: string; config: string | null }>(
    "select id, provider_config_id as config from ai_profile_sets"
  );
  return new Map(result.rows.map((row) => [row.id, row.config]));
}

/**
 * The profile the Hybrid preset must choose as the remote writer: the oldest active profile of the
 * Codex configuration that can write structured output, made the library's only default profile when
 * it is not (the preset takes the default remote profile first). Null when there is none.
 */
async function chooseWriterProfile(
  pool: PgPool,
  writer: RealWriterSettings
): Promise<{
  profile: { id: string; name: string };
  defaultProfileChanged: SoakSetupResult["remote"]["defaultProfileChanged"];
} | null> {
  const found = await pool.query<{
    id: string;
    name: string;
    isDefault: boolean;
    capabilities: string[];
  }>(
    `select id, name, is_default as "isDefault", capabilities from ai_profile_sets
      where provider_config_id = $1 and status = 'active' and model_id is not null
      order by created_at, id`,
    [writer.providerConfigId]
  );
  const able = found.rows.filter((row) => supportsTask("structured-output", row.capabilities));
  const profile = able.find((row) => row.isDefault) ?? able[0];
  if (!profile) return null;
  if (profile.isDefault) {
    const others = await pool.query<{ count: number }>(
      "select count(*)::int as count from ai_profile_sets where is_default and id <> $1",
      [profile.id]
    );
    if ((others.rows[0]?.count ?? 0) === 0)
      return { profile: { id: profile.id, name: profile.name }, defaultProfileChanged: null };
  }
  const previous = await pool.query<{ name: string }>(
    "select name from ai_profile_sets where is_default and id <> $1 order by created_at limit 1",
    [profile.id]
  );
  await setDefaultProfile(pool, profile.id);
  return {
    profile: { id: profile.id, name: profile.name },
    defaultProfileChanged: { from: previous.rows[0]?.name ?? "none", to: profile.name }
  };
}

const describeRoute = (route: AiClassRoutes["classes"][number] | AiClassRoutes["judge"]) => ({
  profile: route.profileName,
  model: route.modelId,
  runtime: route.runtime,
  remote: route.remote,
  test: { state: route.test.state, ms: route.test.ms, error: route.test.error }
});

const failureText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 300);

/**
 * Runs the setup. `off` without the knob, `refused` when it may not run (nothing was changed),
 * else the status written to the file. The app quits after any answer but `off`.
 */
export async function runSoakSetup(
  options: SoakSetupOptions
): Promise<"off" | "refused" | SoakSetupResult["status"]> {
  const { logger } = options;
  let request: SoakSetupRequest;
  try {
    const read = readSoakSetup(options.env, options);
    if (!read) return "off";
    request = read;
    // The folder may be a link out of the profiles (the read above only compares paths).
    if (!(await isSoakProfilePath(options.userDataPath, request.paths)))
      throw new SoakKnobRefusal(
        "outsideProfiles",
        `${soakSetupKnobName} only runs on a clone inside ${request.paths.profilesDirectory}/`
      );
  } catch (error) {
    logger.error(`SOAK_SETUP refused: ${failureText(error)}`);
    return "refused";
  }
  const { realWriter } = request;
  const presetName = realWriter ? "hybrid" : "local";

  const problems: string[] = [];
  // The Hybrid setup's writer must exist before anything is written, and be the profile the preset
  // chooses for the write classes (the default remote one).
  let writerProfile: { id: string; name: string } | null = null;
  let defaultProfileChanged: SoakSetupResult["remote"]["defaultProfileChanged"] = null;
  let blockedForWriter = false;
  if (realWriter) {
    problems.push(...(await realWriterProblems(options.pool, realWriter)));
    const optIn = await decisionsOptInProblem(options.pool, false);
    if (optIn) problems.push(optIn);
    if (problems.length === 0) {
      const prepared = await chooseWriterProfile(options.pool, realWriter);
      if (!prepared) {
        problems.push(
          "The Codex configuration has no active profile that can write structured output"
        );
      } else {
        writerProfile = prepared.profile;
        defaultProfileChanged = prepared.defaultProfileChanged;
      }
    }
    blockedForWriter = problems.length > 0;
  }
  let applied: AiApplyPresetResult = {
    applied: false,
    blocked: [],
    view: await options.ai.classRoutes()
  };
  if (!blockedForWriter) {
    try {
      // The Settings button applies without tests and then tests the classes one by one.
      applied = await options.ai.applyPreset(
        aiApplyPresetInputSchema.parse({ preset: presetName, test: false })
      );
    } catch (error) {
      problems.push(
        `The ${presetName === "hybrid" ? "Hybrid" : "Local"} preset failed: ${failureText(error)}`
      );
    }
  }
  let view = applied.view;
  if (applied.applied) {
    for (const route of [...aiClassIds, "judge"] as const) {
      try {
        view = await options.ai.testClassRoute(route);
      } catch (error) {
        problems.push(`The ${route} test failed to run: ${failureText(error)}`);
      }
    }
    view = await options.ai.classRoutes();
    for (const route of [...view.classes, { ...view.judge, id: "judge" }])
      if (route.test.state !== "passed")
        problems.push(
          `${route.id}: test ${route.test.state}${route.test.error ? ` (${route.test.error})` : ""}`
        );
  } else if (applied.blocked.length > 0) {
    for (const entry of applied.blocked)
      problems.push(
        `${entry.route ?? "the preset"}: ${entry.reason}${entry.modelName ? ` (${entry.modelName})` : ""}`
      );
  }

  // The write classes and the judge must lead to the Codex writer the knob names, no other profile.
  if (realWriter && applied.applied) {
    const owners = await profileConfigOwners(options.pool);
    for (const route of [
      ...view.classes.filter((entry) =>
        ["write-fast", "write-quality", "answer"].includes(entry.id)
      ),
      { ...view.judge, id: "judge" }
    ])
      if (!route.profileId || owners.get(route.profileId) !== realWriter.providerConfigId)
        problems.push(
          `${route.id}: the Hybrid preset chose ${route.profileName ?? "no profile"}, not the Codex writer of the knob`
        );
  }

  // No call of the product may reach a real remote provider; the soak's own fakes do not count, and
  // a Hybrid setup admits the one Codex configuration its knob names.
  const fakeIds = (
    await options.pool.query<{ id: string }>(
      "select id from ai_provider_configs where display_name like 'DEV fake %'"
    )
  ).rows.map((row) => row.id);
  const allowed = realWriter ? [...fakeIds, realWriter.providerConfigId] : fakeIds;
  let reach = await findRealRemoteReach(options.pool, allowed);
  if (!realWriter && applied.applied && reach.defaultProfile && reach.reachable.length === 0) {
    const writer = view.classes.find((entry) => entry.id === "write-fast");
    if (writer?.profileId && !writer.remote) {
      await setDefaultProfile(options.pool, writer.profileId);
      defaultProfileChanged = {
        from: reach.defaultProfile.name,
        to: writer.profileName ?? writer.profileId
      };
      reach = await findRealRemoteReach(options.pool, allowed);
    }
  }
  if (applied.applied) {
    const problem = realRemoteProblem(reach);
    if (problem) problems.push(problem);
  }

  const library = await countLibrary(options.pool);
  const status: SoakSetupResult["status"] =
    !applied.applied && applied.blocked.length > 0
      ? "blocked"
      : problems.length > 0
        ? "failed"
        : "ok";
  const result = soakSetupSchema.parse({
    format: soakSetupFormat,
    version: 1,
    at: (options.now ?? (() => new Date()))().toISOString(),
    userDataPath: options.userDataPath,
    status,
    problems,
    preset: {
      requested: presetName,
      applied: applied.applied,
      mode: view.preset,
      blocked: applied.blocked.map((entry) => ({
        route: entry.route,
        reason: entry.reason,
        modelName: entry.modelName
      }))
    },
    library,
    classes: view.classes.map((route) => ({ id: route.id, ...describeRoute(route) })),
    judge: {
      ...describeRoute(view.judge),
      routed: view.judge.routed,
      deciderMode: view.judge.deciderMode
    },
    ...(realWriter
      ? {
          writer: {
            providerConfigId: realWriter.providerConfigId,
            profile: writerProfile?.name ?? null
          }
        }
      : {}),
    remote: { reachable: reach.reachable, defaultProfileChanged, residual: reach.residual }
  });

  const target = request.paths.setupFile(realWriter ? "f4" : "f3");
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporary, target);

  logger.info(
    `SOAK_SETUP library: ${library.roots} roots (${library.sources} sources), ${library.notes} notes`
  );
  for (const route of result.classes) {
    const where = `${route.runtime ?? "-"}${route.remote ? ", REMOTE" : ", local"}`;
    const took = route.test.ms === null ? "" : ` ${route.test.ms} ms`;
    logger.info(
      `SOAK_SETUP class ${route.id}: ${route.profile ?? "-"} / ${route.model ?? "-"} (${where}), test ${route.test.state}${took}`
    );
  }
  if (result.writer)
    logger.info(
      `SOAK_SETUP writer: Codex configuration ${result.writer.providerConfigId}, profile ${result.writer.profile ?? "-"}`
    );
  logger.info(
    `SOAK_SETUP judge: ${result.judge.profile ?? "-"} / ${result.judge.model ?? "-"}, decider ${result.judge.deciderMode ?? "-"}, test ${result.judge.test.state}`
  );
  if (defaultProfileChanged)
    logger.info(
      `SOAK_SETUP default profile: ${defaultProfileChanged.from} -> ${defaultProfileChanged.to}`
    );
  if (result.remote.residual.length > 0)
    logger.info(
      `SOAK_SETUP residual routes to a real provider that no call resolves to: ${result.remote.residual.join("; ")}`
    );
  for (const problem of problems) logger.error(`SOAK_SETUP problem: ${problem}`);
  logger.info(`SOAK_SETUP ${status}: ${target}`);
  return status;
}
