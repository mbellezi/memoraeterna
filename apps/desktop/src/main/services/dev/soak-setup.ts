import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { bumpAiConfigGeneration, withTransaction, type PgPool } from "@app/db";
import { aiClassIds } from "@app/domain";
import { z } from "zod";

import {
  aiApplyPresetInputSchema,
  type AiApplyPresetInput,
  type AiApplyPresetResult,
  type AiClassRouteTarget,
  type AiClassRoutes
} from "../../../shared/ipc.js";
import { isMeasurementProfilePath } from "../profile-reset.js";
import { findRealRemoteReach, realRemoteProblem } from "./soak-routes.js";
import {
  SoakKnobRefusal,
  fakeRemoteKnobName,
  insideProfiles,
  soakConflictingKnobs,
  soakKnobName,
  soakSetupKnobName,
  type SoakKnobEnvironment
} from "./soak-plan.js";

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

/**
 * True when the knob asks for the setup and may run; false when unset. Refused (thrown) when
 * packaged, for a value other than `1`, outside `<workspaceRoot>/.cache/profiles/` and beside any
 * other DEV knob.
 */
export function readSoakSetupKnob(env: Env, options: SoakKnobEnvironment): boolean {
  const raw = env[soakSetupKnobName]?.trim();
  if (!raw) return false;
  if (options.isPackaged)
    throw new SoakKnobRefusal("packaged", `${soakSetupKnobName} is refused in packaged builds`);
  if (raw !== "1")
    throw new SoakKnobRefusal("invalidValue", `${soakSetupKnobName} must be 1 (or unset)`);
  if (!insideProfiles(options))
    throw new SoakKnobRefusal(
      "outsideProfiles",
      `${soakSetupKnobName} only runs on a clone inside .cache/profiles/ (set MEMORA_USER_DATA_DIR)`
    );
  const conflict = soakSetupConflictingKnobs.find(
    (knob) => knob !== soakSetupKnobName && env[knob]?.trim()
  );
  if (conflict)
    throw new SoakKnobRefusal(
      "conflictingKnob",
      `${soakSetupKnobName} is refused with ${conflict}`
    );
  return true;
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
        requested: z.literal("local"),
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
  try {
    if (!readSoakSetupKnob(options.env, options)) return "off";
    // The folder may be a link out of the profiles (the read above only compares paths).
    if (!(await isMeasurementProfilePath(options.userDataPath, options.workspaceRoot)))
      throw new SoakKnobRefusal(
        "outsideProfiles",
        `${soakSetupKnobName} only runs on a clone inside .cache/profiles/`
      );
  } catch (error) {
    logger.error(`SOAK_SETUP refused: ${failureText(error)}`);
    return "refused";
  }

  const problems: string[] = [];
  let applied: AiApplyPresetResult = {
    applied: false,
    blocked: [],
    view: await options.ai.classRoutes()
  };
  try {
    // The Settings button applies without tests and then tests the classes one by one.
    applied = await options.ai.applyPreset(
      aiApplyPresetInputSchema.parse({ preset: "local", test: false })
    );
  } catch (error) {
    problems.push(`The Local preset failed: ${failureText(error)}`);
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

  // No call of the product may reach a real remote provider; the soak's own fakes do not count.
  let defaultProfileChanged: SoakSetupResult["remote"]["defaultProfileChanged"] = null;
  const fakeIds = (
    await options.pool.query<{ id: string }>(
      "select id from ai_provider_configs where display_name like 'DEV fake %'"
    )
  ).rows.map((row) => row.id);
  let reach = await findRealRemoteReach(options.pool, fakeIds);
  if (applied.applied && reach.defaultProfile && reach.reachable.length === 0) {
    const writer = view.classes.find((entry) => entry.id === "write-fast");
    if (writer?.profileId && !writer.remote) {
      await setDefaultProfile(options.pool, writer.profileId);
      defaultProfileChanged = {
        from: reach.defaultProfile.name,
        to: writer.profileName ?? writer.profileId
      };
      reach = await findRealRemoteReach(options.pool, fakeIds);
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
      requested: "local",
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
    remote: { reachable: reach.reachable, defaultProfileChanged, residual: reach.residual }
  });

  const target = soakSetupPath(options.workspaceRoot);
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
