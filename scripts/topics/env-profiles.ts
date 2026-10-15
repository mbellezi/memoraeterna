// Measurement profiles ENV-G, ENV-F and ENV-C (F2 T22a, spec section 4).
//
//   npx tsx scripts/topics/env-profiles.ts create env-f --from <stopped DEV userData> [--name env-f]
//   npx tsx scripts/topics/env-profiles.ts recipe env-f [--name env-f] [--max-tokens 400000]
//   npx tsx scripts/topics/env-profiles.ts check  env-f [--name env-f]
//
// A profile is an APFS clone (`cp -cR`, so model weights are not duplicated) of a STOPPED DEV
// profile under `.cache/profiles/<name>`, so AI routes, credentials and installed models exist. The
// clone is started once with the DEV-only `MEMORA_PROFILE_RESET=1` (`profile-reset.ts`), which runs
// the Settings reset (routes, credentials and models stay) and records `profile-reset.json`; this
// script then checks that the library is empty and that the content language is the one the
// profile's cassette was recorded with, copies the cassette (`golden-small-v9-a` to
// `golden-small-f2`, never over an existing copy) and writes `profile.json`. The source profile is
// only read. `recipe` prints the command that populates the profile (record mode, G1 `full`, the
// per-source topic barrier). Starting the app takes the DEV-app slot (D35): the orchestrator runs it.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  profileResetConflictingKnobs,
  profileResetKnob,
  profileResetMarkerFile,
  profilesDirectory,
  readProfileResetMarker,
  type ProfileResetMarker
} from "../../apps/desktop/src/main/services/profile-reset.js";
import { repoRoot } from "./datasets.js";

export const profileKinds = ["env-g", "env-f", "env-c"] as const;
export type ProfileKind = (typeof profileKinds)[number];

export interface ProfileDefinition {
  kind: ProfileKind;
  label: string;
  description: string;
  /** The content language the profile's cassettes were recorded with (spec section 4). */
  contentLanguage: string;
  roots: number;
  notes: number;
  /** The golden manifest that populates it, relative to the repository; null for the corpus. */
  manifest: string | null;
  /** The cassette of the earlier recording and the copy F2 records its topic calls into. */
  cassette: { source: string; copy: string } | null;
  populate: "golden" | "corpus";
}

export const profileDefinitions: Readonly<Record<ProfileKind, ProfileDefinition>> = {
  "env-g": {
    kind: "env-g",
    label: "ENV-G",
    description: "golden-small: 10 roots, 160 pinned notes (pt-BR and en)",
    contentLanguage: "pt-BR",
    roots: 10,
    notes: 160,
    manifest: "scripts/golden/manifest.json",
    cassette: { source: "golden-small-v9-a", copy: "golden-small-f2" },
    populate: "golden"
  },
  "env-f": {
    kind: "env-f",
    label: "ENV-F",
    description: "matching fixture: 60 roots, 138 pinned notes",
    contentLanguage: "pt-BR",
    roots: 60,
    notes: 138,
    manifest: ".cache/golden/matching-fixture/manifest.json",
    cassette: { source: "matching-fixture-v9-a", copy: "matching-fixture-f2" },
    populate: "golden"
  },
  "env-c": {
    kind: "env-c",
    label: "ENV-C",
    description: "the 18,632-note corpus re-embedded through the app's embedding route (T22b)",
    contentLanguage: "pt-BR",
    roots: 800,
    notes: 18_632,
    manifest: null,
    cassette: null,
    populate: "corpus"
  }
};

export const profileNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const profileRecordFile = "profile.json";
const cassettesDirectory = [".cache", "golden", "cassettes"] as const;

export type ProfileErrorCode =
  | "invalidName"
  | "missingSource"
  | "notDevelopmentProfile"
  | "sourceRunning"
  | "targetExists"
  | "foreignTarget"
  | "appFailed"
  | "notReset"
  | "languageMismatch"
  | "notEmpty"
  | "cloneFailed";

export class ProfileError extends Error {
  public constructor(
    public readonly code: ProfileErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

const recordSchema = z.looseObject({
  format: z.literal("memora-measurement-profile"),
  version: z.literal(1),
  kind: z.enum(profileKinds),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  contentLanguage: z.string().min(1)
});
export type ProfileRecord = z.infer<typeof recordSchema> & {
  reset: ProfileResetMarker;
  cassette: { source: string; copy: string; copied: boolean } | null;
  manifest: string | null;
};

export interface AppRunInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs: number;
  /** Polled while the app runs; once true the app gets a grace period to quit by itself. */
  isDone: () => Promise<boolean>;
}

export interface AppRunResult {
  exitCode: number | null;
  timedOut: boolean;
  /** The script had to stop the app after the reset was recorded. */
  stopped: boolean;
}

/** The effects of `create`; tests replace them. */
export interface ProfileDeps {
  /** `cp -cR from to`: an APFS clone. `to` must not exist. */
  clone(from: string, to: string): Promise<void>;
  runApp(input: AppRunInput): Promise<AppRunResult>;
  isProcessAlive(pid: number): boolean;
  now(): Date;
  log(line: string): void;
}

export const profilesRoot = (workspaceRoot: string): string =>
  resolve(workspaceRoot, ...profilesDirectory);

export function assertProfileName(name: string): void {
  if (!profileNamePattern.test(name))
    throw new ProfileError(
      "invalidName",
      `The profile name must match ${profileNamePattern} (lower case letters, digits and dashes)`
    );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** True when the DEV profile still has a running PostgreSQL sidecar or Electron instance. */
export async function findRunningProcess(
  userData: string,
  isAlive: (pid: number) => boolean
): Promise<string | null> {
  const postmaster = await readFile(
    join(userData, "database", "postgres-data", "postmaster.pid"),
    "utf8"
  ).catch(() => null);
  const pid = Number(postmaster?.split("\n")[0]);
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid))
    return `its PostgreSQL sidecar (pid ${pid})`;
  // Electron's single-instance lock is a symbolic link named <host>-<pid>.
  const lock = await readlink(join(userData, "SingletonLock")).catch(() => null);
  const lockPid = Number(lock?.split("-").at(-1));
  if (Number.isInteger(lockPid) && lockPid > 0 && isAlive(lockPid))
    return `the app (pid ${lockPid})`;
  return null;
}

/** Files Electron leaves in a running profile; a stale copy would stop the clone from starting. */
const singletonFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

export interface CreateProfileInput {
  kind: ProfileKind;
  /** The stopped DEV userData to clone. */
  from: string;
  /** The folder name under .cache/profiles (default: the kind). */
  name?: string;
  workspaceRoot: string;
  /** Replace a profile this script made earlier. */
  force?: boolean;
  /** Check everything and report the plan; clone and start nothing. */
  dryRun?: boolean;
  /** Overrides the definition's content language (a profile recorded in another language). */
  contentLanguage?: string;
  timeoutMs?: number;
}

export interface CreateProfileResult {
  profileDirectory: string;
  dryRun: boolean;
  record: ProfileRecord | null;
}

/** The environment the reset start gets: the profile, the knob, and no other DEV knob. */
export function resetStartEnvironment(
  env: NodeJS.ProcessEnv,
  profileDirectory: string,
  workspaceRoot: string
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of [
    ...profileResetConflictingKnobs,
    "MEMORA_GOLDEN_ONLY",
    "MEMORA_GOLDEN_EXIT",
    "MEMORA_GOLDEN_MAX_TOKENS",
    "MEMORA_GOLDEN_ALLOW_NONEMPTY",
    "MEMORA_GOLDEN_RESET_ALSO",
    "MEMORA_GOLDEN_TOPICS",
    "MEMORA_GOLDEN_TOPICS_ARRIVAL",
    "MEMORA_AI_CASSETTE",
    "MEMORA_AI_CASSETTE_DIR",
    "MEMORA_SMOKE_AUTO_QUIT_MS"
  ])
    delete clean[name];
  return {
    ...clean,
    MEMORA_USER_DATA_DIR: profileDirectory,
    MEMORA_WORKSPACE_ROOT: workspaceRoot,
    [profileResetKnob]: "1",
    MEMORA_DEV_BACKGROUND: "1"
  };
}

export async function createProfile(
  input: CreateProfileInput,
  deps: ProfileDeps
): Promise<CreateProfileResult> {
  const definition = profileDefinitions[input.kind];
  const name = input.name ?? input.kind;
  assertProfileName(name);
  const workspaceRoot = resolve(input.workspaceRoot);
  const root = profilesRoot(workspaceRoot);
  const profileDirectory = join(root, name);
  const from = resolve(input.from);

  if (!(await exists(from)))
    throw new ProfileError("missingSource", `The DEV profile ${from} does not exist`);
  const descriptor = z
    .object({ developmentOnly: z.literal(true) })
    .safeParse(await readJson(join(from, "database", "dev-connection.json")));
  if (!descriptor.success)
    throw new ProfileError(
      "notDevelopmentProfile",
      `${from} is not a DEV profile (database/dev-connection.json with developmentOnly is missing)`
    );
  // A profile of a profile is fine, the clone of the clone being measured is not.
  if (from === profileDirectory)
    throw new ProfileError("targetExists", "The source and the target are the same folder");
  const running = await findRunningProcess(from, deps.isProcessAlive);
  if (running)
    throw new ProfileError(
      "sourceRunning",
      `${from} is in use by ${running}: stop the app first (a clone of a running database is not a clean copy)`
    );

  if (await exists(profileDirectory)) {
    if (!input.force)
      throw new ProfileError(
        "targetExists",
        `${profileDirectory} exists; use --force to replace it`
      );
    // Only a profile this script made may be replaced.
    if (!(await exists(join(profileDirectory, profileRecordFile))))
      throw new ProfileError(
        "foreignTarget",
        `${profileDirectory} has no ${profileRecordFile}: it was not made by this script, so it is not replaced`
      );
  }

  const expectedLanguage = (input.contentLanguage ?? definition.contentLanguage).trim();
  const plan = [
    `clone ${from} -> ${profileDirectory} (cp -cR)`,
    `start the app once with ${profileResetKnob}=1 (timeout ${Math.round((input.timeoutMs ?? 900_000) / 1000)} s)`,
    `check the library is empty and the content language is ${expectedLanguage}`,
    definition.cassette
      ? `copy the cassette ${definition.cassette.source} to ${definition.cassette.copy} unless it exists`
      : "no cassette (the corpus runner records its own)",
    `write ${profileRecordFile}`
  ];
  if (input.dryRun) {
    for (const line of plan) deps.log(`[dry run] ${line}`);
    return { profileDirectory, dryRun: true, record: null };
  }

  await mkdir(root, { recursive: true });
  if (await exists(profileDirectory)) await rm(profileDirectory, { recursive: true, force: true });
  deps.log(`cloning ${basename(from)} into ${relative(workspaceRoot, profileDirectory)}`);
  try {
    await deps.clone(from, profileDirectory);
  } catch (error) {
    await rm(profileDirectory, { recursive: true, force: true });
    throw new ProfileError(
      "cloneFailed",
      `The clone failed (profiles need an APFS volume for cp -c): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  for (const file of singletonFiles) await rm(join(profileDirectory, file), { force: true });
  // Never started with a stale marker or record from the source's own history.
  await rm(join(profileDirectory, profileResetMarkerFile), { force: true });
  await rm(join(profileDirectory, profileRecordFile), { force: true });

  const started = deps.now();
  deps.log(`starting the reset (${profileResetKnob}=1); the app quits when it is done`);
  const logPath = join(root, `${name}.reset.log`);
  const run = await deps.runApp({
    cwd: workspaceRoot,
    env: resetStartEnvironment(process.env, profileDirectory, workspaceRoot),
    logPath,
    timeoutMs: input.timeoutMs ?? 900_000,
    isDone: async () => (await readProfileResetMarker(profileDirectory)) !== null
  });
  const marker = await readProfileResetMarker(profileDirectory);
  if (!marker || new Date(marker.resetAt).getTime() < started.getTime() - 1000)
    throw new ProfileError(
      "notReset",
      `The reset did not complete (${run.timedOut ? "timed out" : `exit code ${run.exitCode ?? "none"}`}); ` +
        `see ${logPath}. The clone is left in ${profileDirectory}`
    );
  if (marker.library.sources !== 0 || marker.library.notes !== 0)
    throw new ProfileError(
      "notEmpty",
      `The library is not empty after the reset (${marker.library.sources} sources, ${marker.library.notes} notes)`
    );
  if (marker.contentLanguage.toLowerCase() !== expectedLanguage.toLowerCase())
    throw new ProfileError(
      "languageMismatch",
      `The profile's content language is ${marker.contentLanguage}, but ${definition.label}'s cassette ` +
        `was recorded in ${expectedLanguage}: a replay would miss every prompt. Set the content ` +
        "language of the DEV profile (or pass --content-language for another recording) and clone again"
    );

  let cassette: ProfileRecord["cassette"] = null;
  if (definition.cassette) {
    const base = resolve(workspaceRoot, ...cassettesDirectory);
    const source = join(base, definition.cassette.source);
    const copy = join(base, definition.cassette.copy);
    let copied = false;
    if (!(await exists(copy)) && (await exists(source))) {
      await deps.clone(source, copy);
      copied = true;
      deps.log(`copied the cassette ${definition.cassette.source} to ${definition.cassette.copy}`);
    } else if (!(await exists(source)) && !(await exists(copy))) {
      deps.log(`note: the cassette ${definition.cassette.source} is not in ${base}`);
    }
    cassette = { ...definition.cassette, copied };
  }

  const record: ProfileRecord = {
    format: "memora-measurement-profile",
    version: 1,
    kind: input.kind,
    name,
    createdAt: deps.now().toISOString(),
    contentLanguage: marker.contentLanguage,
    clonedFrom: from,
    reset: marker,
    cassette,
    manifest: definition.manifest
  };
  const target = join(profileDirectory, profileRecordFile);
  await writeFile(`${target}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
  return { profileDirectory, dryRun: false, record };
}

export interface ProfileCheck {
  ok: boolean;
  profileDirectory: string;
  problems: string[];
  record: ProfileRecord | null;
}

/** Checks a profile made by `create`: it is in .cache/profiles, was reset and has the right language. */
export async function checkProfile(input: {
  kind: ProfileKind;
  name?: string;
  workspaceRoot: string;
}): Promise<ProfileCheck> {
  const name = input.name ?? input.kind;
  assertProfileName(name);
  const root = profilesRoot(input.workspaceRoot);
  const profileDirectory = join(root, name);
  const problems: string[] = [];
  if (!(await exists(profileDirectory)))
    return { ok: false, profileDirectory, problems: ["the profile does not exist"], record: null };
  const realRoot = await realpath(root).catch(() => root);
  const real = await realpath(profileDirectory);
  if (relative(realRoot, real).startsWith(".."))
    problems.push("the folder is outside .cache/profiles");
  const parsed = recordSchema.safeParse(await readJson(join(profileDirectory, profileRecordFile)));
  if (!parsed.success) {
    problems.push(
      `${profileRecordFile} is missing or invalid (the profile was not made by create)`
    );
    return { ok: false, profileDirectory, problems, record: null };
  }
  const record = parsed.data as unknown as ProfileRecord;
  const definition = profileDefinitions[record.kind];
  if (record.kind !== input.kind) problems.push(`the profile is ${record.kind}, not ${input.kind}`);
  const marker = await readProfileResetMarker(profileDirectory);
  if (!marker)
    problems.push(`${profileResetMarkerFile} is missing: the library reset never completed`);
  else if (marker.contentLanguage !== record.contentLanguage)
    problems.push("the reset marker and the record disagree on the content language");
  if (record.contentLanguage.toLowerCase() !== definition.contentLanguage.toLowerCase())
    problems.push(
      `the content language is ${record.contentLanguage}, ${definition.label} expects ${definition.contentLanguage}`
    );
  if (definition.cassette) {
    const copy = join(
      resolve(input.workspaceRoot, ...cassettesDirectory),
      definition.cassette.copy
    );
    if (!(await exists(copy)))
      problems.push(`the cassette copy ${definition.cassette.copy} is missing`);
  }
  return { ok: problems.length === 0, profileDirectory, problems, record };
}

/** The commands that populate a profile (the orchestrator runs them in the DEV-app slot). */
export function populateRecipe(input: {
  kind: ProfileKind;
  name?: string;
  workspaceRoot: string;
  maxTokens?: number;
}): string {
  const definition = profileDefinitions[input.kind];
  const profile = join(profilesRoot(input.workspaceRoot), input.name ?? input.kind);
  if (definition.populate === "corpus") {
    const cap = input.maxTokens === undefined ? "<cap on live tokens>" : String(input.maxTokens);
    const base = [
      `MEMORA_USER_DATA_DIR=${profile}`,
      `MEMORA_WORKSPACE_ROOT=${input.workspaceRoot}`,
      "MEMORA_TOPIC_CORPUS=1",
      "MEMORA_TOPIC_CORPUS_EXIT=1",
      "MEMORA_DEV_BACKGROUND=1"
    ];
    const recorded = [
      "MEMORA_AI_CASSETTE=record",
      `MEMORA_AI_CASSETTE_DIR=${join(".cache", "golden", "cassettes", "corpus-f2")}`,
      `MEMORA_TOPIC_CORPUS_MAX_TOKENS=${cap}`
    ];
    const start = (extra: readonly string[]): string =>
      `  ${[...base, ...extra].join(" \\\n  ")} \\\n  npm run dev -w @app/desktop`;
    return [
      `${definition.label}: ${definition.description}.`,
      "Populate it with the DEV corpus runner (T22b, MEMORA_TOPIC_CORPUS) in separate starts of the DEV app,",
      "one at a time (the DEV-app slot, and the local-model slot while the notes embed):",
      "",
      "1. Seed the base library and embed it through the app's route (no AI cassette: it would record",
      "   every embedding call). Topic jobs stay held; 40 held-out articles wait for step 3.",
      start(["MEMORA_TOPIC_CORPUS_STAGE=seed", "MEMORA_TOPIC_CORPUS_HOLDOUT=articles:40"]),
      "",
      "2. Build, name and group the tree once (topic AI is recorded to the cassette, with a token cap):",
      start(["MEMORA_TOPIC_CORPUS_STAGE=build", ...recorded]),
      "",
      "3. Let the held-out articles arrive one at a time (the live gate spot check):",
      start(["MEMORA_TOPIC_CORPUS_STAGE=arrive", ...recorded]),
      "",
      "Each start writes .cache/topics/corpus-runs/<time>.json (seed and embedding times, the space",
      "check, the embedding route, live tokens). Then: npm run topics:export, npm run topics:report."
    ].join("\n");
  }
  const cassettes = join(".cache", "golden", "cassettes");
  const cap = input.maxTokens === undefined ? "<cap on live tokens>" : String(input.maxTokens);
  const common = [
    `MEMORA_USER_DATA_DIR=${profile}`,
    `MEMORA_GOLDEN_RUN=${definition.manifest}`,
    `MEMORA_AI_CASSETTE_DIR=${join(cassettes, definition.cassette!.copy)}`,
    "MEMORA_GOLDEN_TOPICS=full",
    "MEMORA_GOLDEN_TOPICS_ARRIVAL=per-source",
    "MEMORA_GOLDEN_EXIT=1",
    "MEMORA_DEV_BACKGROUND=1"
  ];
  return [
    `${definition.label}: ${definition.description}.`,
    "",
    `Record (the first run; extraction is served from the cassette copy, only the topic calls are new):`,
    `  ${[...common, "MEMORA_AI_CASSETTE=record", `MEMORA_GOLDEN_MAX_TOKENS=${cap}`].join(" \\\n  ")} \\\n  npm run dev -w @app/desktop`,
    "",
    "Replay (later runs, $0; it must show 0 misses):",
    `  ${[...common, "MEMORA_AI_CASSETTE=replay", "MEMORA_GOLDEN_RESET=1"].join(" \\\n  ")} \\\n  npm run dev -w @app/desktop`,
    "",
    `Content language ${definition.contentLanguage}; the run summary in .cache/golden/runs/<time>/summary.json`,
    "records topics.mode, topics.arrival, one boundary per source and the topic job counts."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Real effects

export const realProfileDeps: ProfileDeps = {
  clone: (from, to) =>
    new Promise((done, fail) => {
      const child = spawn("cp", ["-cR", from, to], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", fail);
      child.on("close", (code) =>
        code === 0 ? done() : fail(new Error(stderr.trim().slice(0, 400) || `cp exited ${code}`))
      );
    }),
  runApp: async (input) => {
    await mkdir(dirname(input.logPath), { recursive: true });
    const log = openSync(input.logPath, "w", 0o600);
    // `npm run dev` from the repository root, as RULES.md prescribes; its own process group, so a
    // stuck app can be stopped with its children.
    const child = spawn("npm", ["run", "dev", "-w", "@app/desktop"], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", log, log],
      detached: true
    });
    closeSync(log);
    const stopGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    let exited = false;
    const exit = new Promise<number | null>((done) => {
      child.on("exit", (code) => {
        exited = true;
        done(code);
      });
      child.on("error", () => {
        exited = true;
        done(null);
      });
    });
    const deadline = Date.now() + input.timeoutMs;
    let timedOut = false;
    let stopped = false;
    let doneAt: number | null = null;
    while (!exited) {
      await new Promise((tick) => setTimeout(tick, 1000));
      if (exited) break;
      if (Date.now() > deadline) {
        timedOut = true;
        stopGroup("SIGTERM");
        break;
      }
      if (doneAt === null && (await input.isDone())) doneAt = Date.now();
      // The reset is recorded: the app quits by itself within seconds; stop it if it does not.
      if (doneAt !== null && Date.now() - doneAt > 30_000) {
        stopped = true;
        stopGroup("SIGTERM");
        break;
      }
    }
    const result = await Promise.race([
      exit,
      new Promise<number | null>((done) =>
        setTimeout(() => {
          stopGroup("SIGKILL");
          done(null);
        }, 15_000)
      )
    ]);
    return { exitCode: result, timedOut, stopped };
  },
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  now: () => new Date(),
  log: (line) => console.error(`[env-profiles] ${line}`)
};

// ---------------------------------------------------------------------------
// Command line

export const envProfilesUsage = `Usage: npx tsx scripts/topics/env-profiles.ts <command> <env-g|env-f|env-c> [options]

  create   Clone a STOPPED DEV profile into .cache/profiles/<name>, reset its library once and record it.
             --from <userData>          the DEV profile to clone (required; it is only read)
             --name <folder>            profile folder (default: the profile kind)
             --force                    replace a profile this script made earlier
             --dry-run                  check everything and print the plan only
             --content-language <code>  expected content language (default: the profile's recording)
             --timeout <seconds>        reset start timeout (default 900)
  recipe   Print the command that populates the profile (record, then replay).
             --name <folder>  --max-tokens <n>
  check    Verify a profile made by create.
             --name <folder>

Common: --workspace <folder> picks the repository whose .cache holds the profiles and cassettes.
The reset start uses the DEV app slot: run it when nothing else uses the app.`;

export type ProfilesCommand =
  | { kind: "help" }
  | {
      kind: "create";
      profile: ProfileKind;
      from: string;
      name: string | undefined;
      force: boolean;
      dryRun: boolean;
      contentLanguage: string | undefined;
      timeoutMs: number;
      workspaceRoot: string;
    }
  | {
      kind: "recipe";
      profile: ProfileKind;
      name: string | undefined;
      maxTokens: number | undefined;
      workspaceRoot: string;
    }
  | { kind: "check"; profile: ProfileKind; name: string | undefined; workspaceRoot: string };

export function parseProfilesArgs(argv: readonly string[]): ProfilesCommand {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      from: { type: "string" },
      name: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "content-language": { type: "string" },
      timeout: { type: "string" },
      "max-tokens": { type: "string" },
      workspace: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: true
  });
  if (values.help || positionals.length === 0) return { kind: "help" };
  const [command, profile, ...extra] = positionals;
  if (extra.length > 0) throw new Error(`Unexpected argument: ${extra[0]}`);
  if (command !== "create" && command !== "recipe" && command !== "check")
    throw new Error(`Unknown command "${command}" (create, recipe or check).`);
  if (!profile || !(profileKinds as readonly string[]).includes(profile))
    throw new Error(`The profile must be one of ${profileKinds.join(", ")}.`);
  const kind = profile as ProfileKind;
  const workspaceRoot = resolve(values.workspace ?? repoRoot);
  if (values.name !== undefined) assertProfileName(values.name);
  if (command === "create") {
    if (!values.from) throw new Error("--from is required.");
    const timeout = Number(values.timeout ?? 900);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 7200)
      throw new Error("--timeout must be between 30 and 7200 seconds.");
    return {
      kind: "create",
      profile: kind,
      from: resolve(values.from),
      name: values.name,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
      contentLanguage: values["content-language"],
      timeoutMs: timeout * 1000,
      workspaceRoot
    };
  }
  if (command === "recipe") {
    const maxTokens = values["max-tokens"] === undefined ? undefined : Number(values["max-tokens"]);
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0))
      throw new Error("--max-tokens must be a positive integer.");
    return { kind: "recipe", profile: kind, name: values.name, maxTokens, workspaceRoot };
  }
  return { kind: "check", profile: kind, name: values.name, workspaceRoot };
}

async function main(argv: readonly string[]): Promise<number> {
  const command = parseProfilesArgs(argv);
  if (command.kind === "help") {
    console.info(envProfilesUsage);
    return 0;
  }
  if (command.kind === "recipe") {
    console.info(
      populateRecipe({
        kind: command.profile,
        workspaceRoot: command.workspaceRoot,
        ...(command.name ? { name: command.name } : {}),
        ...(command.maxTokens ? { maxTokens: command.maxTokens } : {})
      })
    );
    return 0;
  }
  if (command.kind === "check") {
    const result = await checkProfile({
      kind: command.profile,
      workspaceRoot: command.workspaceRoot,
      ...(command.name ? { name: command.name } : {})
    });
    console.info(JSON.stringify({ ok: result.ok, problems: result.problems }, null, 2));
    return result.ok ? 0 : 1;
  }
  const result = await createProfile(
    {
      kind: command.profile,
      from: command.from,
      workspaceRoot: command.workspaceRoot,
      force: command.force,
      dryRun: command.dryRun,
      timeoutMs: command.timeoutMs,
      ...(command.name ? { name: command.name } : {}),
      ...(command.contentLanguage ? { contentLanguage: command.contentLanguage } : {})
    },
    realProfileDeps
  );
  if (result.record) {
    console.info(
      JSON.stringify(
        {
          profile: result.profileDirectory,
          contentLanguage: result.record.contentLanguage,
          removed: result.record.reset.removed,
          cassette: result.record.cassette
        },
        null,
        2
      )
    );
    console.info(
      populateRecipe({
        kind: command.profile,
        workspaceRoot: command.workspaceRoot,
        ...(command.name ? { name: command.name } : {})
      })
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[env-profiles] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
      );
      process.exitCode = 1;
    }
  );
}
