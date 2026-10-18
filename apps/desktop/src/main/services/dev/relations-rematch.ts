// The relation re-match harness (F3 T52b, spec 3.17). On a clone of a measurement profile it clears
// the relation state, checks that the library holds the pinned notes, and releases the library's
// roots one at a time behind a visibility fence, through the DEV heavy job `relation-rematch`. The
// job decides each root's notes with the call ingestion makes (`matchAtomicNotes`), queues the same
// link job, releases the next root as soon as the root's decide step committed, waits for the link
// jobs to drain, writes the run summary and quits the app. Extraction never runs again: the notes
// are the pinned ones, so quality samples cost no extraction quota (C4, D5).
//
//   MEMORA_RELATIONS_REMATCH=arrival:<seed>|burst
//     arrival:manifest (or S0)  tuning roots in manifest order, then held-out roots in manifest order
//     arrival:20261031 (S1), arrival:20261032 (S2)  the same with each partition in a seeded shuffle
//     burst                      the batch reference: every root visible from the start
//   MEMORA_RELATIONS_REMATCH_MAPPING=<file>     fixture mapping (partitions); default for an ENV-F profile
//   MEMORA_RELATIONS_REMATCH_ROOTS=<file>       roots to release (titles or IDs, in manifest order)
//   MEMORA_RELATIONS_REMATCH_BACKGROUND=matched the roots left out are already matched (TP-C200)
//   MEMORA_RELATIONS_REMATCH_DISCOVERY=on|off   off: no nearest-source discovery (no source judge call);
//                                              typing and promotion stay on (default on) (T57's M1)
//   MEMORA_RELATIONS_REMATCH_CANDIDATES=off|record  record: turns the clone's debug mode on, so every
//                                              note's candidate list is kept for the export (default off)
//   MEMORA_RELATIONS_REMATCH_DIGEST=<sha256>:<notes>   the pinned notes digest, when the profile has none
//   MEMORA_RELATIONS_REMATCH_OUT=<folder in .cache>    where the summary goes
//   MEMORA_RELATIONS_REMATCH_DRAIN_MS=<n>       how long the link jobs may take to drain
//   MEMORA_GOLDEN_MAX_TOKENS=<n>                the cap on live remote tokens (needed to record)
//   MEMORA_AI_CASSETTE=record|replay, MEMORA_AI_CASSETTE_DIR, MEMORA_AI_CASSETTE_TIMING=recorded
//   MEMORA_AI_LANES=serial|product              serial by default in a re-match run
//
// DEV only: refused when packaged, beside another DEV measurement knob, on a profile outside
// `.cache/profiles/`, without a cassette, and when the library's notes are not the pinned ones.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { resolveAiLaneRuntimeConfig, type AiCassette } from "@app/ai";
import { createAtomicNoteRepository, createJobRepository, type PgPool } from "@app/db";

import type { KnowledgeService } from "../knowledge-service.js";
import { isMeasurementProfilePath } from "../profile-reset.js";
import { setRelationLinkRuntime } from "../relations/link-runtime.js";
import { enqueueRematchLink, type StoredDecidedNote } from "../relations/relation-link.js";
import {
  assignPartitions,
  buildRematchPlan,
  parseRematchKnob,
  RematchPlanError,
  type RematchMode,
  type RematchPlan,
  type RematchRoot
} from "./relations-rematch-plan.js";
import { runRematch, type CassetteFacts, type RematchPorts } from "./relations-rematch-run.js";
import {
  clearRelationState,
  countOpenLinkJobs,
  enableCandidateRecording,
  listLibraryRoots,
  readNotesDigest,
  readRunFacts,
  seedBackgroundMatchState,
  type NotesDigest
} from "./relations-rematch-state.js";
import { rematchJobType, type RematchJobSlot } from "./relations-rematch-slot.js";
import type { RematchSummary } from "./relations-rematch-summary.js";

export const rematchKnob = "MEMORA_RELATIONS_REMATCH";

/** DEV knobs that import, wipe, reset or probe a library; a re-match never runs beside one. */
export const rematchConflictingKnobs = [
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_NOTE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_LEGACY_WIPE",
  "MEMORA_PROFILE_RESET",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK",
  "MEMORA_DEV_LANE_PROBE",
  "MEMORA_TYPER_CHECK"
] as const;

export type RematchRefusalCode =
  | "packaged"
  | "invalidValue"
  | "conflictingKnob"
  | "outsideProfiles"
  | "notDevelopmentDatabase"
  | "cassetteRequired"
  | "tokenCapRequired"
  | "digestUnknown"
  | "digestMismatch"
  | "mappingRequired"
  | "noPlan";

export class RematchRefusal extends Error {
  public constructor(
    public readonly code: RematchRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "RematchRefusal";
  }
}

// --- the environment --------------------------------------------------------------------------------

export interface RematchEnvironment {
  mode: RematchMode;
  mappingPath: string | null;
  rootsPath: string | null;
  background: "none" | "matched";
  discovery: "on" | "off";
  candidates: "off" | "record";
  digestOverride: NotesDigest | null;
  outDirectory: string | null;
  drainTimeoutMs: number;
  maxLiveTokens: number | null;
}

const defaultDrainTimeoutMs = 2 * 60 * 60 * 1000;
const knownProfileDigests = [".cache", "f3", "m0", "digests.json"] as const;
const fixtureMappingPath = [".cache", "golden", "matching-fixture", "mapping.json"] as const;
const outputRoot = [".cache", "f3", "rematch"] as const;

function positiveInteger(name: string, value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new RematchRefusal("invalidValue", `${name} must be a positive integer`);
  return parsed;
}

/** Reads the knobs; null when `MEMORA_RELATIONS_REMATCH` is unset. */
export function readRematchEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): RematchEnvironment | null {
  const raw = env[rematchKnob]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new RematchRefusal("packaged", `${rematchKnob} is refused in packaged builds`);
  const others = rematchConflictingKnobs.filter((name) => env[name]?.trim());
  if (others.length > 0)
    throw new RematchRefusal(
      "conflictingKnob",
      `${rematchKnob} cannot run with ${others.join(", ")}`
    );
  let mode: RematchMode;
  try {
    mode = parseRematchKnob(raw);
  } catch (error) {
    throw new RematchRefusal(
      "invalidValue",
      error instanceof Error ? error.message : String(error)
    );
  }
  const path = (name: string): string | null => {
    const value = env[name]?.trim();
    return value ? resolve(options.workspaceRoot, value) : null;
  };
  const background = env[`${rematchKnob}_BACKGROUND`]?.trim() || "none";
  if (background !== "none" && background !== "matched")
    throw new RematchRefusal("invalidValue", `${rematchKnob}_BACKGROUND must be none or matched`);
  const discovery = env[`${rematchKnob}_DISCOVERY`]?.trim() || "on";
  if (discovery !== "on" && discovery !== "off")
    throw new RematchRefusal("invalidValue", `${rematchKnob}_DISCOVERY must be on or off`);
  const candidates = env[`${rematchKnob}_CANDIDATES`]?.trim() || "off";
  if (candidates !== "off" && candidates !== "record")
    throw new RematchRefusal("invalidValue", `${rematchKnob}_CANDIDATES must be off or record`);
  const rawDigest = env[`${rematchKnob}_DIGEST`]?.trim();
  const digest = rawDigest ? /^([0-9a-f]{64}):(\d+)$/u.exec(rawDigest) : null;
  if (rawDigest && !digest)
    throw new RematchRefusal("invalidValue", `${rematchKnob}_DIGEST must be <sha256>:<notes>`);
  const outDirectory = path(`${rematchKnob}_OUT`);
  if (outDirectory) {
    const inside = relative(resolve(options.workspaceRoot, ".cache"), outDirectory);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
      throw new RematchRefusal("invalidValue", `${rematchKnob}_OUT must be a folder inside .cache`);
  }
  return {
    mode,
    mappingPath: path(`${rematchKnob}_MAPPING`),
    rootsPath: path(`${rematchKnob}_ROOTS`),
    background,
    discovery,
    candidates,
    digestOverride: digest ? { sha256: digest[1]!, notes: Number(digest[2]) } : null,
    outDirectory,
    drainTimeoutMs:
      positiveInteger(`${rematchKnob}_DRAIN_MS`, env[`${rematchKnob}_DRAIN_MS`]) ??
      defaultDrainTimeoutMs,
    maxLiveTokens: positiveInteger("MEMORA_GOLDEN_MAX_TOKENS", env.MEMORA_GOLDEN_MAX_TOKENS)
  };
}

// --- files the run reads ----------------------------------------------------------------------------

const profileRecordSchema = z.looseObject({
  kind: z.string().optional(),
  name: z.string().optional()
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** The profile's `profile.json` (written by `scripts/topics/env-profiles.ts`), when it has one. */
export async function readProfileRecord(
  userDataPath: string
): Promise<{ name: string; kind: string | null }> {
  const parsed = profileRecordSchema.safeParse(
    await readJson(join(userDataPath, "profile.json")).catch(() => null)
  );
  return {
    name: (parsed.success && parsed.data.name) || basename(userDataPath),
    kind: (parsed.success && parsed.data.kind) || null
  };
}

const digestsFileSchema = z.record(z.string(), z.unknown());
const digestEntrySchema = z.looseObject({
  notes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u)
});

/** The notes digest a profile must have: the override, else its kind's entry in the digests file. */
export async function resolveExpectedDigest(input: {
  override: NotesDigest | null;
  kind: string | null;
  workspaceRoot: string;
}): Promise<NotesDigest> {
  if (input.override) return input.override;
  if (!input.kind)
    throw new RematchRefusal(
      "digestUnknown",
      `The profile has no kind (profile.json), so the pinned notes digest is unknown: set ${rematchKnob}_DIGEST`
    );
  const file = await readJson(resolve(input.workspaceRoot, ...knownProfileDigests)).catch(
    () => null
  );
  const entry = digestEntrySchema.safeParse(digestsFileSchema.safeParse(file).data?.[input.kind]);
  if (!entry.success)
    throw new RematchRefusal(
      "digestUnknown",
      `No pinned notes digest is recorded for "${input.kind}" in ${knownProfileDigests.join("/")}: set ${rematchKnob}_DIGEST`
    );
  return { notes: entry.data.notes, sha256: entry.data.sha256 };
}

/** Refuses a library whose notes are not the pinned ones: a measurement on other notes means nothing. */
export function verifyPinnedDigest(actual: NotesDigest, expected: NotesDigest): void {
  if (actual.sha256 !== expected.sha256 || actual.notes !== expected.notes)
    throw new RematchRefusal(
      "digestMismatch",
      `The library holds ${actual.notes} notes (digest ${actual.sha256.slice(0, 12)}), not the pinned ${expected.notes} (digest ${expected.sha256.slice(0, 12)})`
    );
}

const mappingSchema = z.looseObject({
  roots: z.array(z.looseObject({ title: z.string().min(1), partition: z.string().min(1) })).min(1)
});

/** The partition of every root of a fixture mapping, by title. */
export async function readPartitionMapping(path: string): Promise<Map<string, string>> {
  const mapping = mappingSchema.parse(await readJson(path));
  return new Map(mapping.roots.map((root) => [root.title.trim(), root.partition]));
}

const selectionSchema = z.union([
  z.array(z.string().trim().min(1).max(500)).min(1),
  z.object({ roots: z.array(z.string().trim().min(1).max(500)).min(1) }).transform((v) => v.roots)
]);

/** The roots a run releases, in manifest order: a JSON list or `{ "roots": [...] }`. */
export async function readRootsSelection(path: string): Promise<string[]> {
  return selectionSchema.parse(await readJson(path));
}

/** Builds the plan of a run from the library's roots and the files the knobs name. */
export async function planRematch(input: {
  environment: RematchEnvironment;
  library: Array<Omit<RematchRoot, "partition">>;
  profileKind: string | null;
  workspaceRoot: string;
}): Promise<RematchPlan> {
  const { environment } = input;
  // An ENV-F profile releases tuning roots before held-out roots: without the mapping that order
  // would silently be the raw manifest's.
  const defaultMapping = resolve(input.workspaceRoot, ...fixtureMappingPath);
  const mappingPath =
    environment.mappingPath ?? (input.profileKind === "env-f" ? defaultMapping : null);
  let library: RematchRoot[];
  if (mappingPath) {
    const partitions = await readPartitionMapping(mappingPath).catch((error: unknown) => {
      throw new RematchRefusal(
        "mappingRequired",
        `The fixture mapping ${mappingPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    library = assignPartitions(input.library, partitions);
  } else library = input.library.map((root) => ({ ...root, partition: null }));
  const selection = environment.rootsPath ? await readRootsSelection(environment.rootsPath) : null;
  return buildRematchPlan(library, environment.mode, selection);
}

// --- the database ports -----------------------------------------------------------------------------

export interface RematchPortsOptions {
  pool: PgPool;
  knowledge: Pick<KnowledgeService, "currentRelationDeciderKey" | "matchAtomicNotes">;
  cassette: Pick<AiCassette, "stats"> | null;
  wake: (lane: "heavy" | "light") => void;
  logger: Pick<Console, "info">;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** The ports of a run on the app's own services and database. */
export function createRematchPorts(options: RematchPortsOptions): RematchPorts {
  const { pool, knowledge } = options;
  // The notes each root's records decided, until its link job is queued with them: no ingestion run
  // parks for a re-match, so the link job (T52) carries them in its payload.
  const decided = new Map<string, StoredDecidedNote[]>();
  return {
    deciderKey: () => knowledge.currentRelationDeciderKey(),
    clear: (input) => clearRelationState(pool, input),
    seedBackground: (rootIds) => seedBackgroundMatchState(pool, rootIds),
    recordCandidates: () => enableCandidateRecording(pool),
    // The same notes, in the same order, as the supervisor's matching stage.
    noteIds: async (recordId) =>
      (await createAtomicNoteRepository(pool).listBySourceItem(recordId))
        .filter((note) => note.status !== "rejected")
        .map((note) => note.id),
    matchRecord: async (input) => {
      const result = await knowledge.matchAtomicNotes(
        input.noteIds,
        input.signal,
        undefined,
        { jobId: input.jobId, sourceItemId: input.recordId, stage: "atomic_note_matching" },
        {
          fence: input.fence,
          // As the ingestion stage keeps them for its link job (D21): no relation row before it.
          onNoteDecided: (note) => {
            decided.set(input.rootId, [...(decided.get(input.rootId) ?? []), note]);
          }
        }
      );
      return { decided: result.decided, accepted: result.accepted, skipped: result.skipped };
    },
    // The link job of the root (T52): typing, persistence, promotion and discovery, with the notes
    // its records decided (`enqueueRematchLink` knows its payload).
    enqueueLink: async (rootId) => {
      await enqueueRematchLink(pool, { rootId, decided: decided.get(rootId) ?? [] });
      decided.delete(rootId);
      options.wake("light");
    },
    openLinkJobs: () => countOpenLinkJobs(pool),
    facts: (since) => readRunFacts(pool, since),
    cassette: (): CassetteFacts | null => {
      const stats = options.cassette?.stats();
      return stats
        ? {
            mode: stats.mode,
            directory: stats.directory,
            timing: stats.timing,
            served: stats.served,
            recorded: stats.recorded,
            misses: stats.misses,
            liveLocalMisses: stats.liveLocalMisses,
            liveTokens: stats.liveTokens,
            maxLiveTokens: stats.maxLiveTokens,
            waitedMs: stats.waitedMs,
            byTask: stats.byTask,
            missDetails: stats.missDetails.map((miss) => ({
              taskType: miss.taskType,
              key: miss.key
            }))
          }
        : null;
    },
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    log: (event, data) => options.logger.info(`RELATIONS_REMATCH ${event}`, data ?? "")
  };
}

// --- preparing and starting a run -------------------------------------------------------------------

export interface PrepareRematchOptions {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  userDataPath: string;
  workspaceRoot: string;
  pool: PgPool;
  cassette: Pick<AiCassette, "stats" | "limitLiveTokens"> | null;
  knowledge: RematchPortsOptions["knowledge"];
  /** The job supervisor: wakes a lane's workers. */
  jobs: { wake(lane?: "heavy" | "light"): void };
  slot: Pick<RematchJobSlot, "bind">;
  quit: () => void;
  logger: Pick<Console, "info" | "error">;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface PreparedRematch {
  plan: RematchPlan;
  environment: RematchEnvironment;
  /** Queues the heavy job, waits for it to end and quits the app. */
  start(): Promise<void>;
}

/**
 * Checks everything that can be checked before the first write, and binds the job. Throws a
 * `RematchRefusal` when the run must not happen: the caller quits without touching the library.
 */
export async function prepareRelationsRematch(
  options: PrepareRematchOptions
): Promise<PreparedRematch> {
  const environment = readRematchEnvironment(options.env, options);
  if (!environment) throw new RematchRefusal("invalidValue", `${rematchKnob} is not set`);
  if (!(await isMeasurementProfilePath(options.userDataPath, options.workspaceRoot)))
    throw new RematchRefusal(
      "outsideProfiles",
      `${rematchKnob} only runs on a clone inside .cache/profiles/ (set MEMORA_USER_DATA_DIR)`
    );
  const descriptor = z
    .object({ developmentOnly: z.literal(true) })
    .safeParse(
      await readJson(join(options.userDataPath, "database", "dev-connection.json")).catch(
        () => ({})
      )
    );
  if (!descriptor.success)
    throw new RematchRefusal(
      "notDevelopmentDatabase",
      `${rematchKnob} needs the DEV PostgreSQL sidecar (dev-connection.json)`
    );
  // Live remote calls are bounded and counted: a cassette is how (C8, D5).
  const cassette = options.cassette?.stats();
  if (!options.cassette || !cassette)
    throw new RematchRefusal(
      "cassetteRequired",
      `${rematchKnob} needs MEMORA_AI_CASSETTE=record or replay`
    );
  if (cassette.mode === "record") {
    if (environment.maxLiveTokens === null)
      throw new RematchRefusal(
        "tokenCapRequired",
        "Recording spends the configured remote route: set MEMORA_GOLDEN_MAX_TOKENS to a positive cap on live tokens"
      );
    options.cassette.limitLiveTokens(environment.maxLiveTokens);
  }
  const profile = await readProfileRecord(options.userDataPath);
  const expected = await resolveExpectedDigest({
    override: environment.digestOverride,
    kind: profile.kind,
    workspaceRoot: options.workspaceRoot
  });
  const actual = await readNotesDigest(options.pool);
  verifyPinnedDigest(actual, expected);
  let plan: RematchPlan;
  try {
    plan = await planRematch({
      environment,
      library: await listLibraryRoots(options.pool),
      profileKind: profile.kind,
      workspaceRoot: options.workspaceRoot
    });
  } catch (error) {
    if (error instanceof RematchPlanError) throw new RematchRefusal("noPlan", error.message);
    throw error;
  }
  const now = options.now ?? (() => new Date());
  const lanesMode = resolveAiLaneRuntimeConfig(
    {},
    { environment: options.env, packaged: false }
  ).mode;
  const ports = createRematchPorts({
    pool: options.pool,
    knowledge: options.knowledge,
    cassette: options.cassette,
    wake: (lane) => options.jobs.wake(lane),
    logger: options.logger,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {})
  });
  const runId = now().toISOString().replace(/[:.]/gu, "-");
  options.slot.bind(async (job, signal) => {
    const summary = await runRematch(ports, {
      runId,
      jobId: job.id,
      profile,
      plan,
      mode: environment.mode,
      background: environment.background,
      discovery: environment.discovery,
      candidates: environment.candidates,
      digest: { expected, actual },
      lanesMode,
      drainTimeoutMs: environment.drainTimeoutMs,
      drainPollMs: options.pollMs ?? 2_000,
      signal
    });
    const path = await writeRematchSummary(options.workspaceRoot, environment, summary);
    options.logger.info(
      `RELATIONS_REMATCH ${summary.outcome}: ${summary.matching.decided} notes decided, summary ${path}`
    );
    return { outcome: summary.outcome, summary: path };
  });
  // The link jobs drain one at a time in arrival order, as in a golden run (D24, link-runtime.ts):
  // every prompt is a function of the release order, and the run calls under no daily cap.
  // `discovery=off` (T57's M1) defers every root's discovery, so the run makes no source judge call.
  setRelationLinkRuntime({ drain: true, discoveryOff: environment.discovery === "off" });
  return {
    plan,
    environment,
    start: async () => {
      const jobs = createJobRepository(options.pool);
      const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
      try {
        const job = await jobs.create({
          type: rematchJobType,
          lane: "heavy",
          maxAttempts: 1,
          payload: { runId }
        });
        options.jobs.wake("heavy");
        for (;;) {
          const row = await jobs.findById(job.id);
          if (
            row &&
            (row.status === "succeeded" || row.status === "failed" || row.status === "canceled")
          ) {
            if (row.status !== "succeeded")
              options.logger.error(`RELATIONS_REMATCH job ${row.status}: ${row.error ?? ""}`);
            break;
          }
          await sleep(options.pollMs ?? 2_000);
        }
      } catch (error) {
        options.logger.error(
          `RELATIONS_REMATCH failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        options.quit();
      }
    }
  };
}

/** Writes `summary.json` under `.cache/f3/rematch/<run>/` (or the folder the knob names). */
export async function writeRematchSummary(
  workspaceRoot: string,
  environment: Pick<RematchEnvironment, "outDirectory">,
  summary: RematchSummary
): Promise<string> {
  const directory =
    environment.outDirectory ?? resolve(workspaceRoot, ...outputRoot, summary.runId);
  await mkdir(directory, { recursive: true });
  const target = join(directory, "summary.json");
  await writeFile(`${target}.tmp`, `${JSON.stringify(summary, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
  return target;
}
