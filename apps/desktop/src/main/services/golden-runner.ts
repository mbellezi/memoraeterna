import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import {
  DocumentDivisionCandidateSchema,
  ProcessingPlanRequestSchema,
  SourceDescriptorSchema,
  SourceRelationSettingsSchema,
  processingPresetStages,
  type ProcessingStage,
  type SourceDescriptor
} from "@app/domain";
import { captureWebPageRequestSchema } from "@app/integration-contracts";
import type { AiCassette } from "@app/ai";
import type { PgPool } from "@app/db";

import type { AppSettings, IngestionResult } from "../../shared/ipc.js";
import type { AiService } from "./ai-service.js";
import type { BackupService } from "./backup-service.js";
import type {
  SourcePairReader,
  SourcePairVerdictsReport,
  SourcePairsFile
} from "./golden-source-pairs.js";
import type { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import type { IngestionService } from "./ingestion-service.js";
import type { JobSupervisor } from "./job-supervisor.js";
import {
  readGoldenTopicsConfig,
  topicJobTypePrefix,
  type GoldenTopicBarrier,
  type GoldenTopicsConfig
} from "./golden-topics.js";
import { readGoldenPinConfig, setExtractionPin, type GoldenPinConfig } from "./extraction-pin.js";
import {
  catalogHeaderPolicy,
  readCatalogHeaderFacts,
  type CatalogHeaderFacts
} from "./catalog-header-policy.js";
import {
  goldenLinkRuntime,
  readGoldenRelationsMode,
  setRelationLinkRuntime,
  type GoldenRelationsMode
} from "./relations/link-runtime.js";
import { readSchemaProbeCalls, runSchemaProbe } from "./schema-probe.js";
import type { LibraryResetService } from "./library-reset-service.js";

/**
 * DEV-only golden library runner (MEMORA_GOLDEN_RUN=<manifest>). It imports the pinned public
 * sources downloaded by `scripts/golden/fetch.ts` through the normal ingestion services, processes
 * them with the full knowledge plan minus organizeKnowledge, waits until every run settles and
 * writes `.cache/golden/runs/<timestamp>/summary.json`. AI calls go through the AI cassette
 * (record or replay), which is required. Before it changes anything it takes a database backup.
 * Packaged builds refuse it. With MEMORA_GOLDEN_RESET=1 it first resets a library that holds nothing
 * but golden sources (proven against the manifest), through the same service as the Settings reset.
 * With MEMORA_GOLDEN_SOURCE_PAIRS=<pair list> it also asks the live source decider about given pairs of
 * works and writes the raw verdicts, persisting nothing (see `golden-source-pairs.ts`).
 *
 * MEMORA_GOLDEN_TOPICS (G1, `golden-topics.ts`) decides what the Topic Tree Engine does during the
 * run. `deterministic` (the default) leaves the run exactly as before: one batch, and the engine makes
 * no topic AI call. `full` adds the topic barrier (D23): topic jobs are held while sources ingest
 * and the light lane is drained at every source boundary (MEMORA_GOLDEN_TOPICS_ARRIVAL=per-source:
 * the one batch's jobs are paced a source at a time in manifest order) or once after the whole batch
 * (`batch`), so the items present at each build and naming call do not depend on lane timing.
 */

/** Full knowledge processing, which no longer has the legacy wiki stage (F2 D14). */
export const goldenRunStages: ProcessingStage[] = [...processingPresetStages.full_knowledge];

export const goldenFormats = ["pdf", "html", "markdown", "text"] as const;
const formatExtension = { pdf: ".pdf", html: ".html", markdown: ".md", text: ".txt" } as const;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const zeroId = "00000000-0000-4000-8000-000000000000";
const containerTypes = ["Book", "PeriodicalIssue", "AcademicPaper"];
const keySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const descriptorFieldsSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => !("title" in value) && !("language" in value), {
    message: "title and language come from the entry"
  });

const fileShape = {
  key: keySchema,
  title: z.string().trim().min(1).max(1000),
  language: z.string().trim().min(2).max(16),
  license: z.string().trim().min(1),
  attribution: z.string().trim().min(1),
  format: z.enum(goldenFormats),
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "HTTPS only"),
  sha256: sha256Schema.nullable(),
  bytes: z.number().int().positive().nullable()
};
/** Keeps only the text between two marker lines (for example the Project Gutenberg body). */
const textTrimSchema = z.object({ start: z.string().min(1), end: z.string().min(1) }).strict();
const fileDocumentSchema = z
  .object({
    ...fileShape,
    kind: z.literal("document"),
    import: z.literal("file"),
    descriptor: descriptorFieldsSchema,
    trim: textTrimSchema.optional()
  })
  .strict();
const webCaptureDocumentSchema = z
  .object({
    ...fileShape,
    kind: z.literal("document"),
    import: z.literal("webCapture"),
    format: z.literal("html"),
    pageUrl: z.string().url()
  })
  .strict();
const containerSchema = z
  .object({
    key: keySchema,
    kind: z.literal("container"),
    title: fileShape.title,
    language: fileShape.language,
    license: fileShape.license,
    attribution: fileShape.attribution,
    descriptor: descriptorFieldsSchema,
    children: z.array(fileDocumentSchema).min(1)
  })
  .strict();
const sourceEntrySchema = z.union([fileDocumentSchema, webCaptureDocumentSchema, containerSchema]);

export const goldenManifestSchema = z
  .object({
    format: z.literal("memora-golden-manifest"),
    version: z.literal(1),
    name: z.string().min(1),
    description: z.string().min(1),
    capturedAt: z.string().datetime(),
    sources: z.array(sourceEntrySchema).min(1)
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const file of goldenManifestFiles(manifest))
      if ("trim" in file && file.trim && file.format !== "text")
        context.addIssue({
          code: "custom",
          message: `${file.key}: trim only applies to text files`
        });
    const keys = goldenManifestFiles(manifest).map((file) => file.key);
    keys.push(...manifest.sources.filter((s) => s.kind === "container").map((s) => s.key));
    for (const key of keys.filter((key, index) => keys.indexOf(key) !== index))
      context.addIssue({ code: "custom", message: `Duplicate key ${key}` });
    for (const source of manifest.sources) {
      if (source.kind === "container" && !containerTypes.includes(String(source.descriptor.type)))
        context.addIssue({ code: "custom", message: `${source.key}: not a container type` });
      const parentId = source.kind === "container" ? zeroId : undefined;
      const descriptors =
        source.kind === "container"
          ? [
              { entry: source, parent: undefined },
              ...source.children.map((child) => ({ entry: child, parent: parentId }))
            ]
          : source.import === "file"
            ? [{ entry: source, parent: undefined }]
            : [];
      for (const { entry, parent } of descriptors) {
        const parsed = SourceDescriptorSchema.safeParse(goldenDescriptor(entry, parent));
        if (!parsed.success)
          context.addIssue({
            code: "custom",
            message: `${entry.key}: invalid descriptor (${parsed.error.issues[0]?.message})`
          });
      }
    }
  });
export type GoldenManifest = z.infer<typeof goldenManifestSchema>;
export type GoldenFile =
  z.infer<typeof fileDocumentSchema> | z.infer<typeof webCaptureDocumentSchema>;

/** Every downloadable file of a manifest, in import order. */
export function goldenManifestFiles(manifest: Pick<GoldenManifest, "sources">): GoldenFile[] {
  return manifest.sources.flatMap((source) =>
    source.kind === "container" ? source.children : [source]
  );
}

export function goldenSourcePath(workspaceRoot: string, file: Pick<GoldenFile, "key" | "format">) {
  return join(
    workspaceRoot,
    ".cache",
    "golden",
    "sources",
    `${file.key}${formatExtension[file.format]}`
  );
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export type GoldenFileCheck =
  | { status: "ok" }
  | { status: "unpinned" | "missing" }
  | { status: "mismatch"; sha256: string; bytes: number };

/** Checks a downloaded file against its pinned size and SHA-256. */
export async function verifyGoldenFile(
  path: string,
  file: Pick<GoldenFile, "sha256" | "bytes">
): Promise<GoldenFileCheck> {
  if (!file.sha256 || !file.bytes) return { status: "unpinned" };
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  const actual = await sha256File(path);
  return actual.sha256 === file.sha256 && actual.bytes === file.bytes
    ? { status: "ok" }
    : { status: "mismatch", ...actual };
}

/**
 * Keeps the text between the line holding `start` (first occurrence) and the line holding `end` (last
 * occurrence), with LF line ends. A marker that is missing fails loudly instead of keeping boilerplate.
 */
export function trimGoldenText(text: string, trim: { start: string; end: string }): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const startIndex = normalized.indexOf(trim.start);
  if (startIndex < 0) throw new Error(`trim start marker "${trim.start}" not found`);
  const bodyStart = normalized.indexOf("\n", startIndex);
  if (bodyStart < 0) throw new Error("nothing follows the trim start marker");
  const endIndex = normalized.lastIndexOf(trim.end);
  if (endIndex <= startIndex)
    throw new Error(`trim end marker "${trim.end}" not found after the start marker`);
  const body = normalized.slice(bodyStart + 1, normalized.lastIndexOf("\n", endIndex) + 1).trim();
  if (body.length === 0) throw new Error("the trimmed text is empty");
  return `${body}\n`;
}

/** Reads a response body, stopping the transfer as soon as it exceeds `maxBytes`. */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`too large (${declared} bytes)`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`too large (more than ${maxBytes} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** The download User-Agent: hosts such as Wikimedia ask for a contact in it. */
export function goldenUserAgent(contact: string | undefined): string {
  const value = contact?.trim();
  if (!value)
    throw new Error(
      "Set MEMORA_GOLDEN_CONTACT to a contact URL or email address: Wikimedia and other hosts ask for one in the User-Agent"
    );
  if (/[\r\n()]/.test(value))
    throw new Error("MEMORA_GOLDEN_CONTACT must not contain line breaks or parentheses");
  return `MemoraEterna-golden/0.1 (${value}; local reference library, no redistribution)`;
}

/** The manifest restricted to some top-level sources (a dry run); unknown keys fail. */
export function selectGoldenSources(manifest: GoldenManifest, only: readonly string[] | null) {
  if (!only) return manifest;
  const known = manifest.sources.map((source) => source.key);
  const unknown = only.filter((key) => !known.includes(key));
  if (unknown.length)
    throw new Error(
      `MEMORA_GOLDEN_ONLY names unknown sources: ${unknown.join(", ")} (top-level keys: ${known.join(", ")})`
    );
  return { ...manifest, sources: manifest.sources.filter((source) => only.includes(source.key)) };
}

function goldenDescriptor(
  entry: { title: string; language: string; descriptor: Record<string, unknown> },
  parentSourceItemId?: string
): unknown {
  return {
    ...entry.descriptor,
    title: entry.title,
    language: entry.language,
    ...(parentSourceItemId ? { parentSourceItemId } : {})
  };
}

export interface GoldenRunEnvironment {
  manifestPath: string;
  allowNonEmpty: boolean;
  /** MEMORA_GOLDEN_RESET=1: reset a library that holds only golden sources before the run. */
  resetLibrary: boolean;
  /**
   * MEMORA_GOLDEN_RESET_ALSO: other golden manifests whose sources the reset may also remove, so one
   * profile can switch between golden libraries (for example the small library and the matching fixture).
   */
  resetAlsoManifestPaths: string[];
  exitWhenDone: boolean;
  /** Cap on live remote tokens: required when recording, where it also stops new provider calls. */
  maxLiveTokens: number | null;
  /** Top-level source keys to run (a dry run on a subset), or null for the whole manifest. */
  only: string[] | null;
  /**
   * MEMORA_GOLDEN_SOURCE_PAIRS: a JSON list of pairs of works to ask the source decider about (DEV
   * only, with MEMORA_GOLDEN_RUN). The verdicts are written; no relation is persisted.
   */
  sourcePairsPath: string | null;
  /** G1 (MEMORA_GOLDEN_TOPICS and MEMORA_GOLDEN_TOPICS_ARRIVAL): the engine's AI work and its barrier. */
  topics: GoldenTopicsConfig;
  /** MEMORA_GOLDEN_PIN (F3 D5): `extraction` (the default of a golden run) keeps the recording-era parse path. */
  pin: GoldenPinConfig;
  /**
   * MEMORA_GOLDEN_RELATIONS (F3 5.6): `live` (the default) or `local`, which switches relation
   * remote calls off for a non-regression replay. Link jobs drain one at a time either way (D24).
   */
  relations: GoldenRelationsMode;
  /**
   * MEMORA_GOLDEN_SCHEMA_PROBE=<calls> (F3 T55): instead of the manifest, a few structured calls carry a
   * strict output schema through the AI service and the cassette. Null when not requested.
   */
  schemaProbeCalls: number | null;
}

/** Reads MEMORA_GOLDEN_*; null when no golden run is requested. Packaged builds refuse it. */
export function readGoldenRunEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): GoldenRunEnvironment | null {
  const manifest = env.MEMORA_GOLDEN_RUN?.trim();
  const rawSourcePairs = env.MEMORA_GOLDEN_SOURCE_PAIRS?.trim();
  if (!manifest) {
    if (options.isPackaged && env.MEMORA_GOLDEN_RESET?.trim() === "1")
      throw new Error("MEMORA_GOLDEN_RESET is refused in packaged builds");
    if (options.isPackaged && rawSourcePairs)
      throw new Error("MEMORA_GOLDEN_SOURCE_PAIRS is refused in packaged builds");
    if (rawSourcePairs) throw new Error("MEMORA_GOLDEN_SOURCE_PAIRS needs MEMORA_GOLDEN_RUN");
    return null;
  }
  if (options.isPackaged) throw new Error("MEMORA_GOLDEN_RUN is refused in packaged builds");
  const rawLimit = env.MEMORA_GOLDEN_MAX_TOKENS?.trim();
  const limit = rawLimit ? Number(rawLimit) : null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0))
    throw new Error("MEMORA_GOLDEN_MAX_TOKENS must be a positive integer");
  const only = (env.MEMORA_GOLDEN_ONLY ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  for (const key of only)
    if (!keySchema.safeParse(key).success)
      throw new Error(`MEMORA_GOLDEN_ONLY holds an invalid source key: ${key}`);
  // A destructive switch: only an explicit 1 turns it on, and anything else that is set is an error.
  const rawReset = env.MEMORA_GOLDEN_RESET?.trim();
  if (rawReset && rawReset !== "0" && rawReset !== "1")
    throw new Error("MEMORA_GOLDEN_RESET must be 1 (or unset)");
  const resetLibrary = rawReset === "1";
  const resetAlso = (env.MEMORA_GOLDEN_RESET_ALSO ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  if (resetAlso.length && !resetLibrary)
    throw new Error("MEMORA_GOLDEN_RESET_ALSO only applies with MEMORA_GOLDEN_RESET=1");
  if (resetLibrary && env.MEMORA_GOLDEN_ALLOW_NONEMPTY === "1")
    throw new Error(
      "MEMORA_GOLDEN_RESET and MEMORA_GOLDEN_ALLOW_NONEMPTY contradict each other: the reset " +
        "empties the library, the other keeps its earlier work"
    );
  return {
    manifestPath: resolve(options.workspaceRoot, manifest),
    allowNonEmpty: env.MEMORA_GOLDEN_ALLOW_NONEMPTY === "1",
    resetLibrary,
    resetAlsoManifestPaths: resetAlso.map((path) => resolve(options.workspaceRoot, path)),
    exitWhenDone: env.MEMORA_GOLDEN_EXIT === "1",
    maxLiveTokens: limit,
    only: only.length ? only : null,
    sourcePairsPath: rawSourcePairs ? resolve(options.workspaceRoot, rawSourcePairs) : null,
    topics: readGoldenTopicsConfig(env, { isPackaged: false }),
    pin: readGoldenPinConfig(env, { isPackaged: false }),
    relations: readGoldenRelationsMode(env, { isPackaged: false }) ?? "live",
    schemaProbeCalls: readSchemaProbeCalls(env)
  };
}

type Query = Pick<PgPool, "query">;

export interface GoldenRunOptions {
  environment: GoldenRunEnvironment;
  /** The environment the run was read from; the summary records the policies it implies. */
  env?: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  userDataPath: string;
  workspaceRoot: string;
  pool: Query;
  cassette: Pick<AiCassette, "stats" | "limitLiveTokens"> | null;
  /** Takes the pre-run database backup; the runner writes nothing before it succeeded. */
  backup: Pick<BackupService, "create">;
  /**
   * The library reset behind MEMORA_GOLDEN_RESET: the Settings reset (it keeps AI routes, credentials
   * and installed models), run while the job supervisor and the local-model service are not started.
   */
  libraryReset?: Pick<LibraryResetService, "reset">;
  ingestion: Pick<IngestionService, "importFile" | "captureWebPage" | "createContainerSource">;
  hierarchy: Pick<HierarchicalIngestionService, "process" | "getStructure" | "confirmStructure">;
  jobs: Pick<JobSupervisor, "wake" | "cancelBatch" | "start" | "stop">;
  /**
   * The topic service's job barrier. Required with MEMORA_GOLDEN_TOPICS=full (D23); a deterministic
   * run never holds topic jobs.
   */
  topicBarrier?: GoldenTopicBarrier;
  /** How long a drain of the topic lane may take before the run fails (default 30 minutes). */
  topicDrainTimeoutMs?: number;
  settings: { getApp(): Promise<AppSettings> };
  /** Runs the source decider for MEMORA_GOLDEN_SOURCE_PAIRS (the normal AI service: the cassette records it). */
  ai?: Pick<AiService, "runDefaultTask">;
  /** The read queries behind a pair verdict; tests replace them. */
  sourcePairReader?: SourcePairReader;
  quit: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Reads the AI routes the run needs (tests replace it). */
  readRoutes?: (pool: Query) => Promise<unknown[]>;
}

export interface GoldenRun {
  manifest: GoldenManifest;
  backup: GoldenBackup;
  /** Present only with MEMORA_GOLDEN_RESET=1. */
  reset?: GoldenReset;
  /**
   * Present only with MEMORA_GOLDEN_SOURCE_PAIRS. `verdict_only`: the library already holds the
   * manifest's roots, so nothing is imported or processed; `after_batch`: the pairs are judged once
   * the batch has settled.
   */
  sourcePairs?: { mode: SourcePairsMode; pairs: number };
  /** Imports, processes, waits and writes the summary; never rejects. */
  start(): Promise<GoldenRunSummary>;
}

export type SourcePairsMode = "verdict_only" | "after_batch";

export interface GoldenBackup {
  path: string;
  createdAt: string;
  bytes: number;
}

/** What MEMORA_GOLDEN_RESET=1 did; recorded in summary.json as `reset`. */
export interface GoldenReset {
  /** False when the library held no source, so there was nothing to reset. */
  performed: boolean;
  /** Source items the reset deleted (the roots and everything under them). */
  removedSources: number;
  /** The pg_dump backup taken right before the reset (the run's backup); null when none was needed. */
  backupPath: string | null;
}

/**
 * Runs before the job supervisor starts: validates the request, the files and the library and takes
 * the database backup. Nothing is written before every check passed and the backup exists.
 */
export async function prepareGoldenRun(
  input: Omit<GoldenRunOptions, "environment"> & {
    env: Readonly<Record<string, string | undefined>>;
  }
): Promise<GoldenRun> {
  const { env, ...rest } = input;
  if (input.isPackaged) throw new Error("The golden runner never runs in packaged builds");
  const environment = readGoldenRunEnvironment(env, input);
  if (!environment) throw new Error("MEMORA_GOLDEN_RUN must name a golden manifest");
  const options: GoldenRunOptions = { ...rest, environment, env };
  // G1 `full` schedules the engine's AI work through the topic service; without it the run would
  // let topic jobs race the heavy lane, which is what the barrier exists to prevent.
  if (environment.topics.mode === "full" && !options.topicBarrier)
    throw new Error(
      "MEMORA_GOLDEN_TOPICS=full needs the topic service and its job barrier; " +
        "nothing was changed"
    );
  const cassette = options.cassette?.stats();
  if (!options.cassette || !cassette)
    throw new Error("The golden runner needs MEMORA_AI_CASSETTE=record or replay");
  if (cassette.mode === "record" && environment.maxLiveTokens === null)
    throw new Error(
      "Recording spends the configured remote route: set MEMORA_GOLDEN_MAX_TOKENS to a positive " +
        "cap on live tokens (a recording resumes from the cassette, so a cap that was too low can be raised)"
    );
  const descriptor = z
    .object({ developmentOnly: z.literal(true) })
    .safeParse(
      JSON.parse(
        await readFile(join(options.userDataPath, "database", "dev-connection.json"), "utf8").catch(
          () => "{}"
        )
      )
    );
  if (!descriptor.success)
    throw new Error("The golden runner needs the DEV PostgreSQL sidecar (dev-connection.json)");
  if (environment.schemaProbeCalls !== null)
    return prepareSchemaProbeRun(options, environment.schemaProbeCalls);
  const fullManifest = goldenManifestSchema.parse(
    JSON.parse(await readFile(options.environment.manifestPath, "utf8"))
  );
  const manifest = selectGoldenSources(fullManifest, environment.only);
  const problems: string[] = [];
  for (const file of goldenManifestFiles(manifest)) {
    const check = await verifyGoldenFile(goldenSourcePath(options.workspaceRoot, file), file);
    if (check.status !== "ok") problems.push(`${file.key}: ${check.status}`);
  }
  if (problems.length)
    throw new Error(
      `Golden sources are not ready (run npx tsx scripts/golden/fetch.ts): ${problems.join(", ")}`
    );
  // The pair list is validated with the rest, before anything is changed.
  const pairsFile = environment.sourcePairsPath
    ? await (
        await import("./golden-source-pairs.js")
      ).readSourcePairsFile(environment.sourcePairsPath)
    : null;
  if (pairsFile && !options.ai)
    throw new Error("MEMORA_GOLDEN_SOURCE_PAIRS needs the AI service; nothing was changed");
  let library = await countLibrary(options.pool);
  let pendingJobs = await countPendingJobs(options.pool);
  let routes: unknown[] | undefined;
  let backup: GoldenBackup | undefined;
  let reset: GoldenReset | undefined;
  if (environment.resetLibrary) {
    // The guard reads the whole manifest, not the MEMORA_GOLDEN_ONLY subset: a library left by a
    // full run may be reset before a dry run of two sources. MEMORA_GOLDEN_RESET_ALSO adds the
    // sources of other golden manifests.
    const others = [];
    for (const path of environment.resetAlsoManifestPaths)
      others.push(goldenManifestSchema.parse(JSON.parse(await readFile(path, "utf8"))));
    const plan = await planGoldenReset(options, mergeGoldenManifests([fullManifest, ...others]));
    if (plan.roots === 0) {
      reset = { performed: false, removedSources: 0, backupPath: null };
      log(options, "reset", { ...reset, roots: 0 });
    } else {
      // Everything that can stop the run is checked before the library is touched; the reset keeps
      // the AI routes, so they are read first.
      routes = await (options.readRoutes ?? readRoutes)(options.pool);
      backup = await backUpBeforeWriting(options);
      reset = await resetGoldenLibrary(options, plan, backup, pendingJobs);
      library = await countLibrary(options.pool);
      pendingJobs = await countPendingJobs(options.pool);
    }
  }
  const pending = pendingJobs.reduce((sum, job) => sum + job.count, 0);
  // The per-source barrier stops the supervisor to queue the batch; a job another run left behind
  // would be aborted by it.
  if (environment.topics.mode === "full" && pending > 0)
    throw new Error(
      `MEMORA_GOLDEN_TOPICS=full needs an idle job queue, but ${pending} jobs are queued or running ` +
        `(${pendingJobs.map((job) => `${job.type} ${job.count}`).join(", ")}). Nothing was changed.`
    );
  // With a pair list, a library that already holds the manifest's roots (and the explicit
  // MEMORA_GOLDEN_ALLOW_NONEMPTY=1) is not processed again: the run only judges the pairs.
  const sourcePairsMode: SourcePairsMode | null = !pairsFile
    ? null
    : environment.allowNonEmpty && (library.sources > 0 || library.notes > 0)
      ? "verdict_only"
      : "after_batch";
  if (sourcePairsMode === "verdict_only") await requireVerdictOnlyLibrary(options, fullManifest);
  if (!options.environment.allowNonEmpty) {
    if (library.sources > 0 || library.notes > 0)
      throw new Error(
        `The library is not empty (${library.sources} sources, ${library.notes} notes); reset it, ` +
          "set MEMORA_GOLDEN_RESET=1 or set MEMORA_GOLDEN_ALLOW_NONEMPTY=1" +
          `${pairsFile ? " (with MEMORA_GOLDEN_SOURCE_PAIRS that only judges the pairs)" : ""}. ` +
          "Nothing was changed."
      );
    if (pending > 0)
      throw new Error(
        `${pending} jobs are queued or running (${pendingJobs.map((job) => `${job.type} ${job.count}`).join(", ")}) ` +
          "and would run when the job supervisor starts; let them finish or cancel them. Nothing was changed."
      );
  }
  routes ??= await (options.readRoutes ?? readRoutes)(options.pool);
  // One backup per run: with a reset it was taken before the library was emptied.
  backup ??= await backUpBeforeWriting(options);
  // A recording may spend the remote route: past the cap the cassette makes no further provider call.
  if (cassette.mode === "record") options.cassette.limitLiveTokens(environment.maxLiveTokens);
  log(options, "prepared", {
    manifest: manifest.name,
    files: goldenManifestFiles(manifest).length,
    cassette: cassette.mode,
    library,
    pendingJobs,
    backup: backup.path,
    ...(reset ? { reset } : {}),
    ...(pairsFile && sourcePairsMode
      ? { sourcePairs: { mode: sourcePairsMode, pairs: pairsFile.pairs.length } }
      : {})
  });
  const preparedBackup = backup;
  const preparedRoutes = routes;
  const sourcePairs =
    pairsFile && sourcePairsMode
      ? { file: pairsFile, mode: sourcePairsMode, manifest: fullManifest }
      : null;
  // Everything that can stop the run has passed: extraction now runs the path the pin names (D5).
  setExtractionPin(environment.pin);
  log(options, "pin", { mode: environment.pin.mode });
  // Link jobs run first in, first out with no coalescing, so replays are deterministic (D24).
  setRelationLinkRuntime(goldenLinkRuntime(environment.relations));
  log(options, "relations", { mode: environment.relations, linkPool: "drain" });
  return {
    manifest,
    backup: preparedBackup,
    ...(reset ? { reset } : {}),
    ...(sourcePairs
      ? { sourcePairs: { mode: sourcePairs.mode, pairs: sourcePairs.file.pairs.length } }
      : {}),
    start: () =>
      runGolden(
        options,
        manifest,
        preparedRoutes,
        {
          backup: preparedBackup,
          pendingJobs,
          only: environment.only,
          pin: environment.pin.mode,
          topics: {
            mode: environment.topics.mode,
            arrival: environment.topics.mode === "full" ? environment.topics.arrival : null
          },
          ...(reset ? { reset } : {})
        },
        sourcePairs
      )
  };
}

/**
 * The strict-schema probe (MEMORA_GOLDEN_SCHEMA_PROBE, F3 T55): no source is imported, no job runs and
 * the library is not read. It reports itself as a verdict-only run, so the app starts neither the job
 * supervisor nor the topic engine; the calls only add AI audit rows. Recording needs the token cap
 * like any golden recording, and the cassette records the answers it makes live.
 */
async function prepareSchemaProbeRun(options: GoldenRunOptions, calls: number): Promise<GoldenRun> {
  const { environment } = options;
  if (environment.resetLibrary || environment.sourcePairsPath)
    throw new Error(
      "MEMORA_GOLDEN_SCHEMA_PROBE runs alone: drop MEMORA_GOLDEN_RESET and MEMORA_GOLDEN_SOURCE_PAIRS; " +
        "nothing was changed"
    );
  if (!options.ai)
    throw new Error("MEMORA_GOLDEN_SCHEMA_PROBE needs the AI service; nothing was changed");
  const manifest = goldenManifestSchema.parse(
    JSON.parse(await readFile(environment.manifestPath, "utf8"))
  );
  const cassette = options.cassette!;
  if (cassette.stats().mode === "record") cassette.limitLiveTokens(environment.maxLiveTokens);
  const now = options.now ?? (() => new Date());
  log(options, "schema_probe", { calls });
  return {
    manifest,
    backup: { path: "", createdAt: now().toISOString(), bytes: 0 },
    sourcePairs: { mode: "verdict_only", pairs: calls },
    start: async () => {
      const startedAt = now();
      const base = {
        format: "memora-golden-run" as const,
        version: 1 as const,
        mode: "schema_probe",
        startedAt: startedAt.toISOString(),
        manifest: { name: manifest.name, path: environment.manifestPath }
      };
      let summary: GoldenRunSummary;
      try {
        const probe = await runSchemaProbe({ ai: options.ai!, calls });
        summary = {
          ...base,
          status:
            probe.failed === 0 && probe.invalid === 0 ? "completed" : "completed_with_failures",
          finishedAt: now().toISOString(),
          cassette: cassette.stats(),
          probe
        };
      } catch (error) {
        summary = {
          ...base,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: now().toISOString(),
          cassette: cassette.stats()
        };
      }
      try {
        const directory = join(
          options.workspaceRoot,
          ".cache",
          "golden",
          "runs",
          startedAt.toISOString().replace(/[:.]/g, "-")
        );
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
        log(options, "summary", { status: summary.status, path: join(directory, "summary.json") });
      } catch (error) {
        log(options, "summary_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (environment.exitWhenDone) options.quit();
      return summary;
    }
  };
}

/**
 * The verdict-only mode (MEMORA_GOLDEN_SOURCE_PAIRS on a non-empty library with
 * MEMORA_GOLDEN_ALLOW_NONEMPTY=1) judges pairs of an existing library. It needs the whole manifest in
 * the library, found by root title, so MEMORA_GOLDEN_ONLY must be empty. Jobs left in the library are
 * harmless: the app does not start the job supervisor in this mode. Changes nothing.
 */
async function requireVerdictOnlyLibrary(options: GoldenRunOptions, manifest: GoldenManifest) {
  if (options.environment.only)
    throw new Error(
      "MEMORA_GOLDEN_ONLY cannot be set when MEMORA_GOLDEN_SOURCE_PAIRS runs on a library that " +
        "already holds the manifest's roots (it judges pairs of that library without importing). " +
        "Nothing was changed."
    );
  const { listLibraryRoots, missingManifestRoots } = await import("./golden-source-pairs.js");
  const missing = missingManifestRoots(manifest, await listLibraryRoots(options.pool));
  if (missing.length)
    throw new Error(
      `The library does not hold ${missing.length} of the manifest's ${manifest.sources.length} roots ` +
        `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}): a verdict-only ` +
        "run needs the library the pair list was made for, found by root title. Nothing was changed."
    );
}

async function countLibrary(pool: Query) {
  const result = await pool.query<{ sources: number; notes: number }>(
    `select (select count(*)::int from source_items) as sources,
            (select count(*)::int from atomic_notes) as notes`
  );
  return {
    sources: Number(result.rows[0]?.sources ?? 0),
    notes: Number(result.rows[0]?.notes ?? 0)
  };
}

/** Queued or running jobs of any type: the supervisor would claim them as soon as it starts. */
async function countPendingJobs(pool: Query) {
  const result = await pool.query<{ type: string; count: number }>(
    `select type, count(*)::int as count from jobs
     where status::text in ('queued', 'running') group by type order by type`
  );
  return result.rows.map((row) => ({ type: String(row.type), count: Number(row.count) }));
}

/** A custom-format dump of the live database, taken before the first write and checked for content. */
async function backUpBeforeWriting(options: GoldenRunOptions): Promise<GoldenBackup> {
  const root = join(options.workspaceRoot, ".cache", "f0", "backups");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const backup = await options.backup.create(root);
  const dump = await stat(join(backup.path, "database.dump")).catch(() => null);
  if (!dump?.isFile() || dump.size === 0)
    throw new Error(
      `The pre-run backup has no database dump (${backup.path}); nothing was changed`
    );
  return { path: backup.path, createdAt: backup.createdAt, bytes: dump.size };
}

/** What the reset guard reads about one source of the library. */
export interface GoldenLibrarySource {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  origin: string;
  /** The capture request ID of a web capture (`metadata.captureRequestId`). */
  captureRequestId: string | null;
  /** SHA-256 of the original file bytes the import stored (`document_assets`, role `original`). */
  originalSha256: string[];
  /** Documents of the source (a failed import can leave a source row that has none). */
  documents: number;
  /** Assets of any role attached to the source or to one of its documents. */
  assets: number;
}

export interface GoldenForeignSource {
  id: string;
  type: string;
  title: string;
  reason: string;
}

/**
 * Proves which root sources of the library belong to the golden manifest. Identities, from the most
 * to the least robust:
 *
 * - a file import: the SHA-256 of the original bytes that the import stored equals a pin of the
 *   manifest (a source and everything materialized under it, such as detected divisions, is covered
 *   by its root);
 * - a web capture, which stores no original bytes: the capture request ID the runner derives from
 *   the manifest key (`stableUuid("golden:<key>")`) and the `web_capture` origin;
 * - a container (a book), which has no content of its own: the manifest container's type and title,
 *   and every direct child must be a pinned file of that same container. An empty container left by
 *   an interrupted import qualifies; it holds nothing to lose;
 * - a leftover of a failed import: a root that has no document and no asset, with no content anywhere
 *   under it, whose type and title equal those of a manifest entry. Imports persist atomically now, but
 *   an earlier failure could leave the bare source row behind; it holds nothing to lose, and any
 *   other row (a document, an asset, content under it, another type or title) keeps it foreign.
 *
 * A source that cannot be traced to a root (a parent cycle) is foreign too.
 */
/** The sources of several golden manifests, for the reset guard: golden in any of them is golden. */
export function mergeGoldenManifests(
  manifests: ReadonlyArray<Pick<GoldenManifest, "sources">>
): Pick<GoldenManifest, "sources"> {
  return { sources: manifests.flatMap((manifest) => manifest.sources) };
}

export function classifyGoldenLibrary(
  manifest: Pick<GoldenManifest, "sources">,
  sources: readonly GoldenLibrarySource[]
): { golden: GoldenLibrarySource[]; foreign: GoldenForeignSource[] } {
  const pinnedShas = (files: readonly GoldenFile[]) =>
    new Set(files.flatMap((file) => (file.import === "file" && file.sha256 ? [file.sha256] : [])));
  const containers = manifest.sources.flatMap((source) =>
    source.kind === "container" ? [{ source, shas: pinnedShas(source.children) }] : []
  );
  const captureIds = new Set(
    manifest.sources.flatMap((source) =>
      source.kind === "document" && source.import === "webCapture"
        ? [stableUuid(`golden:${source.key}`)]
        : []
    )
  );
  const allShas = pinnedShas(goldenManifestFiles(manifest));
  const entryIdentities = new Set(
    manifest.sources.map((source) =>
      identity(
        source.kind === "document" && source.import === "webCapture"
          ? "WebArticle"
          : String(source.descriptor.type),
        source.title
      )
    )
  );
  const known = new Set(sources.map((source) => source.id));
  const children = new Map<string, GoldenLibrarySource[]>();
  for (const source of sources)
    if (source.parentId && known.has(source.parentId))
      children.set(source.parentId, [...(children.get(source.parentId) ?? []), source]);
  const roots = sources.filter((source) => !source.parentId || !known.has(source.parentId));
  const golden: GoldenLibrarySource[] = [];
  const foreign: GoldenForeignSource[] = [];
  const reachable = new Set<string>();
  const markReachable = (source: GoldenLibrarySource) => {
    if (reachable.has(source.id)) return;
    reachable.add(source.id);
    for (const child of children.get(source.id) ?? []) markReachable(child);
  };
  for (const root of roots) {
    markReachable(root);
    const reason = foreignReason(root);
    if (reason === null) golden.push(root);
    else foreign.push({ id: root.id, type: root.type, title: root.title, reason });
  }
  for (const source of sources)
    if (!reachable.has(source.id))
      foreign.push({
        id: source.id,
        type: source.type,
        title: source.title,
        reason: "its parent chain never reaches a root"
      });
  return { golden, foreign };

  /** Null when the root is golden. */
  function foreignReason(root: GoldenLibrarySource): string | null {
    if (root.originalSha256.some((sha) => allShas.has(sha))) return null;
    if (
      root.origin === "web_capture" &&
      root.captureRequestId &&
      captureIds.has(root.captureRequestId)
    )
      return null;
    if (entryIdentities.has(identity(root.type, root.title)) && !hasContent(root)) return null;
    const container = containers.find(
      ({ source }) => source.title === root.title && String(source.descriptor.type) === root.type
    );
    if (!container) return "it matches no source of the manifest";
    const stray = (children.get(root.id) ?? []).find(
      (child) => !child.originalSha256.some((sha) => container.shas.has(sha))
    );
    return stray
      ? `its child "${shorten(stray.title)}" is not a pinned file of the container`
      : null;
  }

  /** A document or an asset on the source or anywhere under it. */
  function hasContent(source: GoldenLibrarySource): boolean {
    return (
      source.documents > 0 ||
      source.assets > 0 ||
      (children.get(source.id) ?? []).some((child) => hasContent(child))
    );
  }
}

const identity = (type: string, title: string) => JSON.stringify([type, title]);

const shorten = (text: string, max = 60) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

async function readLibrarySources(pool: Query): Promise<GoldenLibrarySource[]> {
  const result = await pool.query<GoldenLibrarySource>(
    `select s.id, s.parent_source_item_id as "parentId", s.type::text as type, s.title,
            s.source_origin as origin, s.metadata->>'captureRequestId' as "captureRequestId",
            coalesce((select array_agg(distinct a.sha256::text) from document_assets a
                      where a.source_item_id = s.id and a.role = 'original'), '{}') as "originalSha256",
            (select count(*)::int from documents d where d.source_item_id = s.id) as documents,
            (select count(*)::int from document_assets a
              where a.source_item_id = s.id
                 or a.document_id in (select d.id from documents d where d.source_item_id = s.id)) as assets
     from source_items s order by s.created_at, s.id`
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    parentId: row.parentId === null ? null : String(row.parentId),
    type: String(row.type),
    title: String(row.title),
    origin: String(row.origin),
    captureRequestId: row.captureRequestId === null ? null : String(row.captureRequestId),
    originalSha256: (row.originalSha256 ?? []).map(String),
    documents: Number(row.documents ?? 0),
    assets: Number(row.assets ?? 0)
  }));
}

/**
 * MEMORA_GOLDEN_RESET=1, first half: lists the library and refuses unless every root source is
 * golden. Changes nothing. `roots` is 0 for an empty library, which needs no reset.
 */
async function planGoldenReset(
  options: GoldenRunOptions,
  manifest: Pick<GoldenManifest, "sources">
) {
  if (!options.libraryReset)
    throw new Error("MEMORA_GOLDEN_RESET needs the library reset service; nothing was changed");
  const { golden, foreign } = classifyGoldenLibrary(
    manifest,
    await readLibrarySources(options.pool)
  );
  if (foreign.length) {
    const examples = foreign
      .slice(0, 5)
      .map((source) => `${source.id} ${source.type} "${shorten(source.title)}" (${source.reason})`);
    throw new Error(
      `library holds non-golden sources (${foreign.length}): ${examples.join("; ")}` +
        `${foreign.length > examples.length ? "; ..." : ""}. MEMORA_GOLDEN_RESET only empties a ` +
        "library of golden sources; reset a mixed library from Settings if that is intended. " +
        "Nothing was changed."
    );
  }
  return { roots: golden.length };
}

/**
 * Second half: the same reset Settings runs (AI routes, credentials and installed models stay), after
 * the backup. The library must be empty afterwards; the backup path is in the error otherwise.
 */
async function resetGoldenLibrary(
  options: GoldenRunOptions,
  plan: { roots: number },
  backup: GoldenBackup,
  pendingJobs: ReadonlyArray<{ type: string; count: number }>
): Promise<GoldenReset> {
  const result = await options.libraryReset!.reset().catch((error: unknown) => {
    throw new Error(
      `The library reset failed (${error instanceof Error ? error.message : String(error)}); ` +
        `the pre-reset backup is ${backup.path}. The golden run stopped.`,
      { cause: error }
    );
  });
  const library = await countLibrary(options.pool);
  if (library.sources > 0 || library.notes > 0)
    throw new Error(
      `The library is not empty after the reset (${library.sources} sources, ${library.notes} notes); ` +
        `the golden run stopped. The pre-reset backup is ${backup.path}.`
    );
  const performed: GoldenReset = {
    performed: true,
    removedSources: result.deletedSources,
    backupPath: backup.path
  };
  log(options, "reset", {
    ...performed,
    roots: plan.roots,
    droppedPendingJobs: pendingJobs.reduce((sum, job) => sum + job.count, 0)
  });
  return performed;
}

const requiredRoutes = [
  "embedding",
  "summarization",
  "atomic-note-generation",
  "knowledge-graph-generation",
  "reranking"
] as const;

/** The routes the pipeline uses; a missing one stops the run before anything changes. */
async function readRoutes(pool: Query): Promise<unknown[]> {
  const { createAiConfigRepository } = await import("@app/db");
  const repository = createAiConfigRepository(pool as PgPool);
  const routes = [];
  for (const task of requiredRoutes) {
    const route = await repository.getDefaultTask(task);
    if (!route) throw new Error(`The golden run needs a configured ${task} route`);
    routes.push({
      task,
      provider: route.provider,
      modelId: route.modelId,
      runtime: route.runtime,
      revision: route.revision,
      repository: route.repository,
      quantization: route.quantization,
      parameters: { ...route.modelDefaultParameters, ...route.parameters }
    });
  }
  return routes;
}

interface ImportedSource {
  key: string;
  kind: "document" | "container";
  sourceItemId: string;
  structure?: { id: string; divisions: number };
  children?: Array<{ key: string; sourceItemId: string }>;
}

export type GoldenRunStatus =
  "completed" | "completed_with_failures" | "diverged" | "token_limit" | "failed";

export interface GoldenRunSummary {
  format: "memora-golden-run";
  version: 1;
  status: GoldenRunStatus;
  error?: string;
  [key: string]: unknown;
}

async function runGolden(
  options: GoldenRunOptions,
  manifest: GoldenManifest,
  routes: unknown[],
  preparation: Record<string, unknown>,
  sourcePairs: SourcePairsRequest | null = null
): Promise<GoldenRunSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runDirectory = join(
    options.workspaceRoot,
    ".cache",
    "golden",
    "runs",
    startedAt.toISOString().replace(/[:.]/g, "-")
  );
  const context: Record<string, unknown> = { routes, ...preparation };
  let summary: GoldenRunSummary;
  try {
    await mkdir(runDirectory, { recursive: true });
    context.settings = pickSettings(await options.settings.getApp());
    context.atomicNoteMatchingVersion = (
      await import("./knowledge-processing.js")
    ).atomicNoteMatchingVersion;
    if (sourcePairs?.mode === "verdict_only") {
      // The library already holds the manifest's roots: nothing is imported, queued or processed.
      const pairRun = await runSourcePairs(options, sourcePairs, runDirectory);
      summary = {
        format: "memora-golden-run",
        version: 1,
        status: pairRun.report.status ?? "failed",
        mode: "source_pair_verdicts",
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        manifest: { name: manifest.name, path: options.environment.manifestPath },
        cassette: options.cassette?.stats() ?? null,
        sourcePairs: pairRun.summary,
        ...context
      };
    } else {
      // G1 `full` runs under the topic barrier (D23); a deterministic run is one plain batch.
      const barrier = options.environment.topics.mode === "full" ? options.topicBarrier : undefined;
      const processed = barrier
        ? await processUnderTopicBarrier(options, manifest, barrier, runDirectory, now)
        : await processInOneBatch(options, manifest, runDirectory, now);
      const { imported, importedAt, outcome } = processed;
      if (processed.topics) context.topics = { ...(context.topics as object), ...processed.topics };
      const finishedAt = now();
      summary = await buildGoldenSummary(options, {
        manifest,
        imported,
        batchId: processed.batchId,
        startedAt,
        importedAt,
        finishedAt,
        outcome,
        context
      });
      // The pair verdicts follow the batch and stay out of its summary figures; a failure here
      // never discards the batch's results.
      if (sourcePairs) {
        if (outcome !== "settled")
          summary.sourcePairs = { status: "skipped", reason: `the batch ended with ${outcome}` };
        else
          summary.sourcePairs = await runSourcePairs(options, sourcePairs, runDirectory).then(
            (run) => run.summary,
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              log(options, "source_pairs_failed", { error: message });
              return { status: "failed", error: message };
            }
          );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(options, "failed", { error: message });
    summary = {
      format: "memora-golden-run",
      version: 1,
      status: "failed",
      error: message,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      manifest: { name: manifest.name, path: options.environment.manifestPath },
      cassette: options.cassette?.stats() ?? null,
      ...context
    };
  }
  // A golden run pins its extraction and replays a recording: the catalog-header refresh is off in
  // it (T53h), and the summary says so and counts the refresh jobs the app run queued (none).
  summary.catalogHeaders = await readCatalogHeaderFacts(options.pool, {
    ...(options.env ? { env: options.env } : {})
  }).catch((): CatalogHeaderFacts => ({ ...catalogHeaderPolicy(options.env), jobs: 0 }));
  try {
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    log(options, "summary", { status: summary.status, path: join(runDirectory, "summary.json") });
  } catch (error) {
    log(options, "summary_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  if (options.environment.exitWhenDone) options.quit();
  else log(options, "left_running", { reason: "MEMORA_GOLDEN_EXIT is not 1" });
  return summary;
}

interface ProcessedRun {
  imported: ImportedSource[];
  batchId: string;
  importedAt: Date;
  outcome: BatchOutcome;
  /** What the topic barrier did (`full` runs only); merged into the summary's `topics`. */
  topics?: Record<string, unknown>;
}

/** A queued batch: its ID and, per run, the source it processes and its job (null when nothing is left to run). */
interface QueuedBatch {
  batchId: string;
  queued: Array<{ sourceItemId: string; jobId: string | null }>;
}

/** Queues the full knowledge plan for the given root sources. */
async function queueBatch(options: GoldenRunOptions, rootIds: string[]): Promise<QueuedBatch> {
  const batch = await options.hierarchy.process({
    runKind: "initial",
    trigger: "library_action",
    plan: ProcessingPlanRequestSchema.parse({
      preset: "custom",
      requestedStages: goldenRunStages,
      scope: "source_and_children",
      targetSourceItemIds: rootIds
    })
  });
  log(options, "queued", { batchId: batch.batchId, runs: batch.queued.length });
  return {
    batchId: batch.batchId,
    queued: batch.queued.map(({ sourceItemId, jobId }) => ({ sourceItemId, jobId }))
  };
}

/** The plain run: import the whole manifest, queue one batch, wait for it. */
async function processInOneBatch(
  options: GoldenRunOptions,
  manifest: GoldenManifest,
  runDirectory: string,
  now: () => Date
): Promise<ProcessedRun> {
  const imported = await importSources(options, manifest);
  const importedAt = now();
  const { batchId } = await queueBatch(
    options,
    imported.map((source) => source.sourceItemId)
  );
  options.jobs.wake();
  const outcome = await waitForBatch(options, batchId, runDirectory);
  return { imported, batchId, importedAt, outcome };
}

/** One drain of the light lane: how long it took and how often the jobs table was polled. */
export interface TopicBoundary {
  /** The manifest key whose notes the drain admitted, or `*` for the whole manifest (`batch`). */
  source: string;
  batchId: string;
  drainMs: number;
  polls: number;
}

/**
 * The topic barrier (D23). Topic jobs are held while sources ingest, so the items present at every
 * build and naming call are a function of the manifest order, not of lane timing. The ingestion
 * itself is never changed: it stays ONE batch, because the collective matching stages run once every
 * run has reached them and the recorded cassette holds exactly those prompts.
 *
 * - `batch`: the batch runs as usual with the topic jobs held, then the light lane is drained once.
 * - `per-source`: the batch's run jobs are paced. The supervisor is stopped while the batch is
 *   queued (so no job can start early) and the jobs of every source after the first are pushed far
 *   into the future; each source's jobs are then released only after the previous source's jobs
 *   finished and the light lane was drained. The heavy lane is idle at every drain, so nothing else
 *   can enqueue topic work, and the hold is re-armed before the next source runs. The last source
 *   also runs the batch's collective matching; its drain follows the whole batch.
 *
 * A divergence or token limit leaves the topic jobs held (and logs it): a stopped run must not let
 * queued topic work reach the provider or add cassette misses. The hold is released after the last
 * drain, so the app then runs as it normally does.
 */
async function processUnderTopicBarrier(
  options: GoldenRunOptions,
  manifest: GoldenManifest,
  barrier: GoldenTopicBarrier,
  runDirectory: string,
  now: () => Date
): Promise<ProcessedRun> {
  const { arrival } = options.environment.topics;
  const boundaries: TopicBoundary[] = [];
  let released = false;
  const drain = async (source: string, batchId: string, holdAgain: boolean) => {
    const drained = await drainTopicLane(options, barrier, source, batchId, holdAgain);
    boundaries.push(drained.boundary);
    if (!holdAgain && drained.outcome === "settled") released = true;
    return drained.outcome;
  };
  /** `batch`: the batch as usual, then one drain. */
  const underHold = async (rootIds: string[]) => {
    const { batchId } = await queueBatch(options, rootIds);
    options.jobs.wake();
    let outcome = await waitForBatch(options, batchId, runDirectory);
    if (outcome === "settled") outcome = await drain("*", batchId, false);
    return { batchId, outcome };
  };
  /** `per-source`: the same batch, its jobs paced a source at a time. */
  const paced = async (imported: readonly ImportedSource[], rootIds: string[]) => {
    // Nothing may run between queueing the batch and holding the later sources' jobs back.
    await options.jobs.stop();
    let queued: QueuedBatch | null = null;
    try {
      queued = await queueBatch(options, rootIds);
      const { batchId } = queued;
      const groups = await groupJobsBySource(options.pool, imported, queued);
      await holdBackJobs(
        options.pool,
        groups.slice(1).flatMap((group) => group.jobIds)
      );
      await options.jobs.start();
      let outcome: BatchOutcome = "settled";
      for (const [index, group] of groups.entries()) {
        if (index === groups.length - 1) break;
        outcome = await waitForJobs(options, batchId, group.jobIds);
        if (outcome === "settled") outcome = await drain(group.key, batchId, true);
        if (outcome !== "settled") break;
        await releaseJobs(options.pool, groups[index + 1]!.jobIds);
        options.jobs.wake();
      }
      if (outcome === "settled") {
        // The last source and the collective matching, then the last drain.
        outcome = await waitForBatch(options, batchId, runDirectory);
        if (outcome === "settled") outcome = await drain(groups.at(-1)?.key ?? "*", batchId, false);
      }
      return { batchId, outcome };
    } catch (error) {
      // A batch that is half held back must not be left to run later on its own.
      if (queued) await options.jobs.cancelBatch(queued.batchId).catch(() => undefined);
      // The supervisor was stopped for the queueing; it must run again whatever happened.
      await options.jobs.start();
      throw error;
    }
  };
  try {
    await barrier.hold();
    log(options, "topics_held", { arrival, sources: manifest.sources.length });
    const imported = await importSources(options, manifest);
    const importedAt = now();
    const rootIds = imported.map((source) => source.sourceItemId);
    const ran = arrival === "batch" ? await underHold(rootIds) : await paced(imported, rootIds);
    if (ran.outcome === "settled" && !released) {
      await barrier.release();
      released = true;
    }
    if (ran.outcome !== "settled") log(options, "topics_left_held", { reason: ran.outcome });
    return {
      imported,
      batchId: ran.batchId,
      importedAt,
      outcome: ran.outcome,
      topics: {
        held: !released,
        boundaries,
        drainMs: boundaries.reduce((sum, boundary) => sum + boundary.drainMs, 0),
        jobs: await readTopicJobCounts(options.pool)
      }
    };
  } catch (error) {
    log(options, "topics_left_held", {
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * The jobs of a queued batch grouped by the root source (manifest key) they belong to, in manifest
 * order and, within a root, in the order they were queued. A run's source may be a chapter or a
 * detected division; its root is found through the source tree.
 */
async function groupJobsBySource(
  pool: Query,
  imported: readonly ImportedSource[],
  batch: QueuedBatch
): Promise<Array<{ key: string; jobIds: string[] }>> {
  const roots = await pool.query<{ originId: string; rootId: string }>(
    `with recursive up(origin_id, id, parent_id) as (
       select s.id, s.id, s.parent_source_item_id from source_items s where s.id = any($1::uuid[])
       union all
       select up.origin_id, s.id, s.parent_source_item_id
       from source_items s join up on s.id = up.parent_id)
     select origin_id as "originId", id as "rootId" from up where parent_id is null`,
    [batch.queued.map((run) => run.sourceItemId)]
  );
  const rootOf = new Map(roots.rows.map((row) => [row.originId, row.rootId]));
  const groups = imported.map((source) => ({ key: source.key, jobIds: [] as string[] }));
  const index = new Map(imported.map((source, position) => [source.sourceItemId, position]));
  for (const run of batch.queued) {
    const position = index.get(rootOf.get(run.sourceItemId) ?? "");
    if (position === undefined)
      throw new Error(`Run of source ${run.sourceItemId} does not belong to an imported root`);
    if (run.jobId) groups[position]!.jobIds.push(run.jobId);
  }
  return groups;
}

/** Pushes queued jobs far into the future; any job that is not queued any more is a lost race. */
async function holdBackJobs(pool: Query, jobIds: readonly string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const held = await pool.query(
    `update jobs set run_after = now() + interval '100 years', updated_at = now()
     where id = any($1::uuid[]) and status::text = 'queued' returning id`,
    [jobIds]
  );
  if (held.rows.length !== jobIds.length)
    throw new Error(
      `${jobIds.length - held.rows.length} of the later sources' jobs were not queued when they ` +
        "were to be held back; the run stops before anything runs out of order"
    );
}

/** Makes held jobs claimable again, in the order they were queued. */
async function releaseJobs(pool: Query, jobIds: readonly string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update jobs set run_after = clock_timestamp() + t.position * interval '1 millisecond',
       updated_at = now()
     from unnest($1::uuid[]) with ordinality as t(id, position)
     where jobs.id = t.id and jobs.status::text = 'queued'`,
    [jobIds]
  );
}

/** Waits until none of the given jobs is queued or running (two quiet polls); stops like a batch wait. */
async function waitForJobs(
  options: GoldenRunOptions,
  batchId: string,
  jobIds: readonly string[]
): Promise<BatchOutcome> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const interval = options.pollIntervalMs ?? 5000;
  let quiet = 0;
  for (;;) {
    const stopped = await stopReason(options);
    if (stopped) {
      await options.jobs.cancelBatch(batchId);
      return stopped;
    }
    const active = await options.pool.query<{ active: number }>(
      `select count(*)::int as active from jobs
       where id = any($1::uuid[]) and status::text in ('queued', 'running')`,
      [jobIds]
    );
    quiet = Number(active.rows[0]?.active ?? 0) === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return "settled";
    await sleep(interval);
  }
}

/** A replay miss or the live token cap, the two reasons a golden run stops by itself. */
async function stopReason(options: GoldenRunOptions): Promise<BatchOutcome | null> {
  const cassette = options.cassette?.stats();
  if (cassette?.mode === "replay" && cassette.misses > 0) {
    log(options, "diverged", { misses: cassette.missDetails });
    return "diverged";
  }
  const limit = options.environment.maxLiveTokens;
  if (cassette?.mode === "record" && limit !== null && cassette.liveTokens >= limit) {
    log(options, "token_limit", { limit, liveTokens: cassette.liveTokens });
    return "token_limit";
  }
  return null;
}

/** Releases the hold, waits for the light lane to run what is queued, then holds again if asked. */
async function drainTopicLane(
  options: GoldenRunOptions,
  barrier: GoldenTopicBarrier,
  source: string,
  batchId: string,
  holdAgain: boolean
): Promise<{ boundary: TopicBoundary; outcome: BatchOutcome }> {
  const began = Date.now();
  await barrier.release();
  const waited = await waitForTopicLane(options).catch(async (error: unknown) => {
    await barrier.hold();
    throw error;
  });
  if (waited.outcome !== "settled" || holdAgain) await barrier.hold();
  const boundary: TopicBoundary = {
    source,
    batchId,
    drainMs: Date.now() - began,
    polls: waited.polls
  };
  log(options, "topics_drained", { ...boundary, outcome: waited.outcome });
  return { boundary, outcome: waited.outcome };
}

/**
 * Waits until no topic job is queued or running, like `waitForBatch` waits for a batch: two quiet
 * polls in a row. A queued job counts even before its debounce has elapsed, because it will run.
 * A replay miss or the live token cap stops it (`diverged`, `token_limit`); a lane that never
 * drains within `topicDrainTimeoutMs` is an error.
 */
export async function waitForTopicLane(
  options: GoldenRunOptions
): Promise<{ outcome: BatchOutcome; polls: number }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const interval = options.pollIntervalMs ?? 1000;
  const timeoutMs = options.topicDrainTimeoutMs ?? 1_800_000;
  const maxPolls = Math.max(2, Math.ceil(timeoutMs / interval));
  let quiet = 0;
  for (let polls = 1; polls <= maxPolls; polls += 1) {
    const stopped = await stopReason(options);
    if (stopped) return { outcome: stopped, polls };
    const active = await options.pool.query<{ active: number }>(
      `select count(*)::int as active from jobs
       where type::text like $1 and status::text in ('queued', 'running')`,
      [`${topicJobTypePrefix}%`]
    );
    // Two quiet polls in a row: no queued, running or retrying topic job is left.
    quiet = Number(active.rows[0]?.active ?? 0) === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return { outcome: "settled", polls };
    await sleep(interval);
  }
  throw new Error(
    `The topic lane still had queued or running topic jobs after ${timeoutMs} ms; ` +
      "the topic jobs are held again"
  );
}

/** Topic jobs by type and status, for the run summary. */
async function readTopicJobCounts(pool: Query) {
  const result = await pool.query<{ type: string; status: string; count: number }>(
    `select type::text as type, status::text as status, count(*)::int as count from jobs
     where type::text like $1 group by 1, 2 order by 1, 2`,
    [`${topicJobTypePrefix}%`]
  );
  return result.rows.map((row) => ({
    type: String(row.type),
    status: String(row.status),
    count: Number(row.count)
  }));
}

interface SourcePairsRequest {
  file: SourcePairsFile;
  mode: SourcePairsMode;
  /** The whole manifest: a pair names a root by its manifest key, imported or not. */
  manifest: GoldenManifest;
}

/**
 * MEMORA_GOLDEN_SOURCE_PAIRS: asks the live source decider about the listed pairs and writes
 * `source-pair-verdicts.json` into the run directory. Persists nothing (golden-source-pairs.ts).
 */
async function runSourcePairs(
  options: GoldenRunOptions,
  request: SourcePairsRequest,
  runDirectory: string
): Promise<{ report: SourcePairVerdictsReport; summary: Record<string, unknown> }> {
  const pairs = await import("./golden-source-pairs.js");
  const app = await options.settings.getApp();
  const report = await pairs.runSourcePairVerdicts({
    mode: request.mode,
    file: request.file,
    manifest: request.manifest,
    roots: await pairs.listLibraryRoots(options.pool),
    reader: options.sourcePairReader ?? pairs.createSourcePairReader(options.pool),
    ai: options.ai!,
    settings: SourceRelationSettingsSchema.parse(app.sourceRelationSettings ?? {}),
    contentLanguage: app.contentLanguage ?? "en",
    cassette: options.cassette,
    ...(options.now ? { now: options.now } : {}),
    onUpdate: async (current) => {
      await pairs.writeSourcePairVerdicts(runDirectory, current);
    },
    onPair: (pair, total) =>
      log(options, "source_pair", {
        pair: `${pair.index + 1}/${total}`,
        ...(pair.label ? { label: pair.label } : {}),
        status: pair.status,
        verdict: pair.verdict,
        calls: pair.attempts.length,
        wallMs: pair.wallMs,
        ...(pair.reason ? { reason: pair.reason } : {})
      })
  });
  const path = join(runDirectory, pairs.sourcePairVerdictsFile);
  log(options, "source_pairs", { status: report.status, path, ...report.totals });
  return {
    report,
    summary: {
      mode: request.mode,
      status: report.status,
      ...(report.stopReason ? { stopReason: report.stopReason } : {}),
      file: report.pairsFile,
      verdicts: path,
      totals: report.totals
    }
  };
}

const settingsKeys = [
  "contentLanguage",
  "atomicNoteMatchingSettings",
  "canonicalMatchingSettings",
  "sourceRelationSettings",
  "summaryMinimumWordCount",
  "entityIdentitySimilarityThreshold",
  "relationTypeSimilarityThreshold",
  "knowledgeGraphMaxEntitiesPerSource",
  "knowledgeGraphMaxRelationsPerSource",
  "keepLocalEmbeddingModelsLoaded",
  "activeMatchingPresetId"
] as const;

function pickSettings(settings: AppSettings) {
  const values = settings as Record<string, unknown>;
  return Object.fromEntries(
    settingsKeys.filter((key) => key in values).map((key) => [key, values[key]])
  );
}

const importOnlyPlan = () =>
  ProcessingPlanRequestSchema.parse({ preset: "import_only", requestedStages: [] });

/**
 * Imports the manifest in order; the first failure stops the run before any AI work is queued. The
 * run processes exactly the pinned content as new sources, so an import that finds the source
 * already in the library (an earlier run, or a repeated file) fails instead of reusing it.
 */
export async function importSources(
  options: Pick<GoldenRunOptions, "workspaceRoot" | "ingestion" | "hierarchy" | "log">,
  manifest: GoldenManifest
): Promise<ImportedSource[]> {
  const imported: ImportedSource[] = [];
  for (const source of manifest.sources) {
    if (source.kind === "container") {
      const root = requireNew(
        source.key,
        await options.ingestion.createContainerSource({
          descriptor: parseDescriptor(source),
          duplicatePolicy: "ignore"
        })
      );
      const children = [];
      for (const child of source.children) {
        const result = await importFile(child, root.sourceItemId);
        children.push({ key: child.key, sourceItemId: result.sourceItemId });
      }
      imported.push({
        key: source.key,
        kind: "container",
        sourceItemId: root.sourceItemId,
        children
      });
    } else if (source.import === "webCapture") {
      const html = await readFile(goldenSourcePath(options.workspaceRoot, source), "utf8");
      const result = requireNew(
        source.key,
        await options.ingestion.captureWebPage(
          captureWebPageRequestSchema.parse({
            requestId: stableUuid(`golden:${source.key}`),
            url: source.pageUrl,
            title: source.title,
            capturedAt: manifest.capturedAt,
            metadata: { language: source.language },
            html
          })
        )
      );
      imported.push(document(source.key, result));
    } else {
      const result = await importFile(source);
      imported.push(document(source.key, await confirmDetectedStructure(result)));
    }
    log(options, "imported", { key: source.key, sourceItemId: imported.at(-1)?.sourceItemId });
  }
  return imported;

  function document(
    key: string,
    result: IngestionResult & { structure?: ImportedSource["structure"] }
  ) {
    return {
      key,
      kind: "document" as const,
      sourceItemId: result.sourceItemId,
      ...(result.structure ? { structure: result.structure } : {})
    };
  }

  function requireNew(key: string, result: IngestionResult) {
    if (result.duplicate)
      throw new Error(
        `${key} is already in the library (duplicate source ${result.sourceItemId}); the golden run ` +
          "needs it as a new source. Reset the library first. Nothing was queued."
      );
    return result;
  }

  async function importFile(file: z.infer<typeof fileDocumentSchema>, parentSourceItemId?: string) {
    return requireNew(
      file.key,
      await options.ingestion.importFile(goldenSourcePath(options.workspaceRoot, file), {
        descriptor: parseDescriptor(file, parentSourceItemId),
        duplicatePolicy: "ignore",
        processingPlan: importOnlyPlan()
      })
    );
  }

  /** Hierarchical file types produce a detected structure; it is confirmed as detected. */
  async function confirmDetectedStructure(result: IngestionResult) {
    if (!result.requiresStructureReview || !result.structureId) return result;
    const structure = await options.hierarchy.getStructure(result.structureId);
    if (!structure) throw new Error(`Structure ${result.structureId} disappeared`);
    await options.hierarchy.confirmStructure({
      structureId: result.structureId,
      divisions: structure.divisions.map((division) =>
        DocumentDivisionCandidateSchema.parse({
          id: division.id,
          parentId: division.parentId,
          kind: division.kind,
          title: division.title,
          level: division.level,
          position: division.position,
          startSelector: division.startSelector,
          endSelector: division.endSelector,
          ...(division.startPage === undefined ? {} : { startPage: division.startPage }),
          ...(division.endPage === undefined ? {} : { endPage: division.endPage }),
          ...(division.markdownStart === undefined
            ? {}
            : { markdownStart: division.markdownStart }),
          ...(division.markdownEnd === undefined ? {} : { markdownEnd: division.markdownEnd }),
          confidence: division.confidence,
          evidence: division.evidence,
          reviewStatus: division.reviewStatus,
          isProcessable: division.isProcessable,
          metadata: division.metadata
        })
      ),
      plan: importOnlyPlan()
    });
    return {
      ...result,
      structure: { id: result.structureId, divisions: structure.divisions.length }
    };
  }
}

function parseDescriptor(
  entry: { title: string; language: string; descriptor: Record<string, unknown> },
  parentSourceItemId?: string
): SourceDescriptor {
  return SourceDescriptorSchema.parse(goldenDescriptor(entry, parentSourceItemId));
}

/** A UUID-shaped identifier derived from a name, so repeated runs send the same capture ID. */
export function stableUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type BatchOutcome = "settled" | "diverged" | "token_limit";

export async function waitForBatch(
  options: GoldenRunOptions,
  batchId: string,
  runDirectory: string
): Promise<BatchOutcome> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const interval = options.pollIntervalMs ?? 5000;
  let quiet = 0;
  let previous = "";
  for (;;) {
    const progress = await options.pool.query<{
      title: string;
      status: string;
      currentStage: string;
      checkpoint: Record<string, { status?: string }> | null;
      error: string | null;
    }>(
      `select s.title, r.status::text as status, r.current_stage as "currentStage",
              r.stages_checkpoint as checkpoint, r.error
       from ingestion_runs r join source_items s on s.id = r.source_item_id
       where r.batch_id = $1 order by s.title, r.id`,
      [batchId]
    );
    const cassette = options.cassette?.stats();
    const usage = {
      served: cassette?.served ?? 0,
      recorded: cassette?.recorded ?? 0,
      liveTokens: cassette?.liveTokens ?? 0
    };
    const runs = progress.rows.map((run) => ({
      title: run.title,
      status: run.status,
      stage: run.currentStage,
      stages: Object.fromEntries(
        Object.entries(run.checkpoint ?? {}).map(([stage, value]) => [stage, value?.status ?? null])
      ),
      ...(run.error ? { error: run.error } : {})
    }));
    const snapshot = JSON.stringify(runs);
    if (snapshot !== previous) {
      previous = snapshot;
      const settled = runs.filter((run) =>
        ["succeeded", "failed", "canceled"].includes(run.status)
      );
      log(options, "progress", { settled: settled.length, runs: runs.length, ...usage });
      await writeFile(
        join(runDirectory, "progress.json"),
        `${JSON.stringify({ batchId, at: new Date().toISOString(), usage, runs }, null, 2)}\n`
      );
    }
    if (cassette?.mode === "replay" && cassette.misses > 0) {
      log(options, "diverged", { misses: cassette.missDetails });
      await options.jobs.cancelBatch(batchId);
      return "diverged";
    }
    const limit = options.environment.maxLiveTokens;
    if (cassette?.mode === "record" && limit !== null && usage.liveTokens >= limit) {
      log(options, "token_limit", { limit, ...usage });
      await options.jobs.cancelBatch(batchId);
      return "token_limit";
    }
    const active = await options.pool.query<{ active: number }>(
      `select count(*)::int as active from jobs j
       where j.status::text in ('queued', 'running')
         and (j.id in (select job_id from ingestion_runs where batch_id = $1 and job_id is not null)
              or j.payload->>'batchId' = $1::text)`,
      [batchId]
    );
    // Two quiet polls in a row: no queued, running or retrying job is left for the batch.
    quiet = Number(active.rows[0]?.active ?? 0) === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return "settled";
    await sleep(interval);
  }
}

interface StageRow {
  sourceItemId: string;
  stage: string;
  status: string;
  attempts: number | null;
  reused: boolean;
  wallMs: number | null;
  error: string | null;
}

const terminalStageStatuses = new Set(["completed", "skipped", "failed", "canceled"]);

/** Stage outcomes and wall-time percentiles (executed stages only; reused ones are counted apart). */
export function summarizeStages(rows: readonly StageRow[]) {
  const byStage = new Map<string, StageRow[]>();
  for (const row of rows) byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row]);
  return Object.fromEntries(
    [...byStage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stage, list]) => {
        const statuses: Record<string, number> = {};
        for (const row of list) {
          const status = terminalStageStatuses.has(row.status)
            ? row.status
            : `stalled:${row.status}`;
          statuses[status] = (statuses[status] ?? 0) + 1;
        }
        const executed = list.filter(
          (row) =>
            row.status === "completed" && !row.reused && row.wallMs !== null && row.wallMs >= 0
        );
        return [
          stage,
          {
            statuses,
            reused: list.filter((row) => row.reused).length,
            retried: list.filter((row) => (row.attempts ?? 0) > 1).length,
            wallMs: distribution(executed.map((row) => row.wallMs!))
          }
        ];
      })
  );
}

export function distribution(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number) => {
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low));
  };
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: Math.round(sorted.at(-1)!),
    total: Math.round(sorted.reduce((sum, value) => sum + value, 0))
  };
}

/** Order-independent digest of content lines; equal digests mean equal content. */
export function contentDigest(lines: readonly string[]) {
  const sorted = [...lines].sort();
  return {
    count: sorted.length,
    sha256: createHash("sha256").update(sorted.join("\n")).digest("hex")
  };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reads the run results from the database (exported for verification against a real schema). */
export async function buildGoldenSummary(
  options: GoldenRunOptions,
  run: {
    manifest: GoldenManifest;
    imported: ImportedSource[];
    batchId: string;
    startedAt: Date;
    importedAt: Date;
    finishedAt: Date;
    outcome: BatchOutcome;
    context: Record<string, unknown>;
  }
): Promise<GoldenRunSummary> {
  const pool = options.pool;
  const rootIds = run.imported.map((source) => source.sourceItemId);
  const tree = await pool.query<{
    rootId: string;
    id: string;
    title: string;
    type: string;
    parentTitle: string | null;
    chunks: number;
    notes: number;
  }>(
    `with recursive tree as (
       select id, id as root_id from source_items where id = any($1::uuid[])
       union all
       select child.id, tree.root_id from source_items child
       join tree on child.parent_source_item_id = tree.id
     )
     select tree.root_id as "rootId", s.id, s.title, s.type::text as type, p.title as "parentTitle",
            (select count(*)::int from chunks c where c.source_item_id = s.id) as chunks,
            (select count(*)::int from atomic_notes n
              where n.created_from_source_item_id = s.id and n.status::text <> 'rejected') as notes
     from tree join source_items s on s.id = tree.id
     left join source_items p on p.id = s.parent_source_item_id
     order by tree.root_id, p.title nulls first, s.title`,
    [rootIds]
  );
  const ids = tree.rows.map((row) => row.id);
  const runs = await pool.query<{
    id: string;
    sourceItemId: string;
    batchId: string | null;
    status: string;
    error: string | null;
    wallMs: number | null;
    queueMs: number | null;
  }>(
    `select r.id, r.source_item_id as "sourceItemId", r.batch_id as "batchId", r.status::text as status,
            r.error,
            (extract(epoch from (r.completed_at - r.started_at)) * 1000)::float8 as "wallMs",
            (extract(epoch from (r.started_at - r.created_at)) * 1000)::float8 as "queueMs"
     from ingestion_runs r where r.batch_id = $1 order by r.created_at`,
    [run.batchId]
  );
  const stages = await pool.query<StageRow>(
    `select r.source_item_id as "sourceItemId", st.stage, st.status::text as status,
            nullif(st.attempts, 0) as attempts, st.error,
            coalesce((st.metadata->>'reused') = 'true', false) as reused,
            (extract(epoch from (st.completed_at - st.started_at)) * 1000)::float8 as "wallMs"
     from ingestion_run_stages st join ingestion_runs r on r.id = st.ingestion_run_id
     where r.batch_id = $1`,
    [run.batchId]
  );
  const ai = await pool.query(
    `select r.task_type as "taskType", r.provider, r.model_id as "modelId", r.status,
            count(*)::int as calls,
            count(*) filter (where m.token_usage ? 'cassette.replayed')::int as replayed,
            sum(r.input_tokens)::float8 as "inputTokens",
            sum(r.output_tokens)::float8 as "outputTokens",
            sum((m.token_usage->>'reasoningTokens')::numeric)::float8 as "reasoningTokens",
            sum(r.cost_estimate)::float8 as "costEstimate",
            count(r.cost_estimate)::int as "callsWithCost",
            sum(r.duration_ms)::float8 as "durationMs",
            percentile_cont(0.5) within group (order by r.duration_ms) as "durationP50Ms",
            percentile_cont(0.95) within group (order by r.duration_ms) as "durationP95Ms",
            count(r.queue_ms)::int as "queueMeasured",
            sum(r.queue_ms)::float8 as "queueMs",
            percentile_cont(0.5) within group (order by r.queue_ms) as "queueP50Ms",
            percentile_cont(0.95) within group (order by r.queue_ms) as "queueP95Ms"
     from ai_task_runs r
     left join lateral (select token_usage from monitoring_operations
                        where ai_task_run_id = r.id limit 1) m on true
     where r.started_at >= $1
     group by r.task_type, r.provider, r.model_id, r.status
     order by r.task_type, r.provider, r.model_id, r.status`,
    [run.startedAt]
  );
  const outputs = await contentDigests(pool, ids);
  const stageRows = stages.rows;
  const failedRuns = runs.rows.filter((row) => row.status !== "succeeded");
  const unsettledStages = stageRows.filter((row) => !terminalStageStatuses.has(row.status));
  const failedStages = stageRows.filter((row) => ["failed", "canceled"].includes(row.status));
  const status: GoldenRunStatus =
    run.outcome !== "settled"
      ? run.outcome
      : failedRuns.length || unsettledStages.length || failedStages.length
        ? "completed_with_failures"
        : "completed";
  const titleById = new Map(tree.rows.map((row) => [row.id, row.title]));
  return {
    format: "memora-golden-run",
    version: 1,
    status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    wallMs: {
      total: run.finishedAt.getTime() - run.startedAt.getTime(),
      import: run.importedAt.getTime() - run.startedAt.getTime(),
      processing: run.finishedAt.getTime() - run.importedAt.getTime()
    },
    manifest: {
      name: run.manifest.name,
      path: options.environment.manifestPath,
      sha256: sha(JSON.stringify(run.manifest))
    },
    cassette: options.cassette?.stats() ?? null,
    plan: { requestedStages: goldenRunStages, excluded: ["organizeKnowledge"] },
    batchId: run.batchId,
    ...run.context,
    sources: run.imported.map((source) => {
      const rows = tree.rows.filter((row) => row.rootId === source.sourceItemId);
      return {
        ...source,
        items: rows.length,
        chunks: rows.reduce((sum, row) => sum + Number(row.chunks), 0),
        notes: rows.reduce((sum, row) => sum + Number(row.notes), 0)
      };
    }),
    runs: runs.rows.map((row) => ({
      title: titleById.get(row.sourceItemId) ?? row.sourceItemId,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      wallMs: row.wallMs === null ? null : Math.round(row.wallMs),
      queueMs: row.queueMs === null ? null : Math.round(row.queueMs),
      stages: Object.fromEntries(
        stageRows
          .filter((stage) => stage.sourceItemId === row.sourceItemId)
          .map((stage) => [stage.stage, stage.status])
      )
    })),
    stages: summarizeStages(stageRows),
    ai: ai.rows,
    outputs,
    failures: {
      runs: failedRuns.length,
      stages: failedStages.map((row) => ({
        title: titleById.get(row.sourceItemId) ?? row.sourceItemId,
        stage: row.stage,
        status: row.status,
        error: row.error
      })),
      stalledStages: unsettledStages.map((row) => ({
        title: titleById.get(row.sourceItemId) ?? row.sourceItemId,
        stage: row.stage,
        status: row.status
      }))
    }
  };
}

/** ID-free content digests used by `scripts/golden/compare.ts` to compare two runs. */
async function contentDigests(pool: Query, ids: string[]) {
  const rows = async (sql: string) =>
    (await pool.query<{ line: string }>(sql, [ids])).rows.map((row) => row.line);
  const source = `coalesce(p.title || ' / ', '') || s.title`;
  return {
    chunks: contentDigest(
      await rows(`select ${source} || '|' || c.chunk_index || '|' || c.content_hash as line
        from chunks c join source_items s on s.id = c.source_item_id
        left join source_items p on p.id = s.parent_source_item_id
        where c.source_item_id = any($1::uuid[])`)
    ),
    notes: contentDigest(
      await rows(`select ${source} || '|' || n.title || '|' ||
          md5(coalesce(n.idea_statement, '') || '|' || coalesce(n.body_markdown, '')) || '|' ||
          n.status::text as line
        from atomic_notes n join source_items s on s.id = n.created_from_source_item_id
        left join source_items p on p.id = s.parent_source_item_id
        where n.created_from_source_item_id = any($1::uuid[])`)
    ),
    // Note relations as unordered pairs in title order (comparable with runs recorded before
    // relations v2), and the directed tuples of relations v2 (F3 D8): subject > object for a
    // directed relation, ~ for a symmetric one, ? for a legacy one whose direction is unknown, with
    // the type, status, band and veto source.
    noteRelations: contentDigest(
      await rows(`select least(sn.title, tn.title) || '|' || greatest(sn.title, tn.title) || '|' ||
          coalesce(r.relation_type::text, '') || '|' || coalesce(r.status::text, '') as line
        from atomic_note_relations r
        join atomic_notes sn on sn.id = r.source_atomic_note_id
        join atomic_notes tn on tn.id = r.target_atomic_note_id
        where sn.created_from_source_item_id = any($1::uuid[])
           or tn.created_from_source_item_id = any($1::uuid[])`)
    ),
    noteRelationsDirected: contentDigest(
      await rows(`select case r.direction
            when 'lo_to_hi' then sn.title || ' > ' || tn.title
            when 'hi_to_lo' then tn.title || ' > ' || sn.title
            when 'symmetric' then least(sn.title, tn.title) || ' ~ ' || greatest(sn.title, tn.title)
            else least(sn.title, tn.title) || ' ? ' || greatest(sn.title, tn.title) end || '|' ||
          coalesce(r.relation_type::text, '') || '|' || r.status::text || '|' ||
          coalesce(r.band, '') || '|' || coalesce(r.veto_source, '') as line
        from atomic_note_relations r
        join atomic_notes sn on sn.id = r.source_atomic_note_id
        join atomic_notes tn on tn.id = r.target_atomic_note_id
        where sn.created_from_source_item_id = any($1::uuid[])
           or tn.created_from_source_item_id = any($1::uuid[])`)
    ),
    sourceRelations: contentDigest(
      await rows(`select s.title || '|' || t.title || '|' ||
          coalesce(r.relation_type::text, '') || '|' || coalesce(r.status::text, '') as line
        from source_relations r
        join source_items s on s.id = r.source_item_id
        join source_items t on t.id = r.target_source_item_id
        where r.source_item_id = any($1::uuid[]) or r.target_source_item_id = any($1::uuid[])`)
    ),
    summaries: contentDigest(
      await rows(`select ${source} || '|' || md5(coalesce(ss.summary, '')) as line
        from source_summaries ss join source_items s on s.id = ss.source_item_id
        left join source_items p on p.id = s.parent_source_item_id
        where ss.is_current and ss.source_item_id = any($1::uuid[])`)
    ),
    entities: contentDigest(
      await rows(`select distinct e.type::text || '|' || e.normalized_name as line
        from entities e join entity_mentions m on m.entity_id = e.id
        where m.source_item_id = any($1::uuid[])`)
    )
  };
}

function log(
  options: Pick<GoldenRunOptions, "log">,
  event: string,
  data: Record<string, unknown> = {}
) {
  (
    options.log ??
    ((name, payload) => console.log("GOLDEN_RUN", JSON.stringify({ event: name, ...payload })))
  )(event, data);
}
