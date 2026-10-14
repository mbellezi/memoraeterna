import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import {
  DocumentDivisionCandidateSchema,
  ProcessingPlanRequestSchema,
  SourceDescriptorSchema,
  processingPresetStages,
  type ProcessingStage,
  type SourceDescriptor
} from "@app/domain";
import { captureWebPageRequestSchema } from "@app/integration-contracts";
import type { AiCassette } from "@app/ai";
import type { PgPool } from "@app/db";

import type { AppSettings, IngestionResult } from "../../shared/ipc.js";
import type { BackupService } from "./backup-service.js";
import type { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import type { IngestionService } from "./ingestion-service.js";
import type { JobSupervisor } from "./job-supervisor.js";
import type { LibraryResetService } from "./library-reset-service.js";
import type { MaintenanceService } from "./maintenance-service.js";
import type { OrganizationService } from "./organization-service.js";

/**
 * DEV-only golden library runner (MEMORA_GOLDEN_RUN=<manifest>). It imports the pinned public
 * sources downloaded by `scripts/golden/fetch.ts` through the normal ingestion services, processes
 * them with the full knowledge plan minus organizeKnowledge, waits until every run settles and
 * writes `.cache/golden/runs/<timestamp>/summary.json`. AI calls go through the AI cassette
 * (record or replay), which is required. Before it changes anything it takes a database backup.
 * Packaged builds refuse it. With MEMORA_GOLDEN_RESET=1 it first resets a library that holds nothing
 * but golden sources (proven against the manifest), through the same service as the Settings reset.
 */

/** Full knowledge processing without the legacy wiki stage. */
export const goldenRunStages: ProcessingStage[] = processingPresetStages.full_knowledge.filter(
  (stage) => stage !== "organizeKnowledge"
);

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
  exitWhenDone: boolean;
  /** Cap on live remote tokens: required when recording, where it also stops new provider calls. */
  maxLiveTokens: number | null;
  /** Top-level source keys to run (a dry run on a subset), or null for the whole manifest. */
  only: string[] | null;
}

/** Reads MEMORA_GOLDEN_*; null when no golden run is requested. Packaged builds refuse it. */
export function readGoldenRunEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): GoldenRunEnvironment | null {
  const manifest = env.MEMORA_GOLDEN_RUN?.trim();
  if (!manifest) {
    if (options.isPackaged && env.MEMORA_GOLDEN_RESET?.trim() === "1")
      throw new Error("MEMORA_GOLDEN_RESET is refused in packaged builds");
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
  if (resetLibrary && env.MEMORA_GOLDEN_ALLOW_NONEMPTY === "1")
    throw new Error(
      "MEMORA_GOLDEN_RESET and MEMORA_GOLDEN_ALLOW_NONEMPTY contradict each other: the reset " +
        "empties the library, the other keeps its earlier work"
    );
  return {
    manifestPath: resolve(options.workspaceRoot, manifest),
    allowNonEmpty: env.MEMORA_GOLDEN_ALLOW_NONEMPTY === "1",
    resetLibrary,
    exitWhenDone: env.MEMORA_GOLDEN_EXIT === "1",
    maxLiveTokens: limit,
    only: only.length ? only : null
  };
}

type Query = Pick<PgPool, "query">;

export interface GoldenRunOptions {
  environment: GoldenRunEnvironment;
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
  jobs: Pick<JobSupervisor, "wake" | "cancelBatch">;
  organization: Pick<OrganizationService, "automaticCommand">;
  maintenance: Pick<MaintenanceService, "command">;
  settings: { getApp(): Promise<AppSettings> };
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
  automation: GoldenAutomationPause;
  /** Present only with MEMORA_GOLDEN_RESET=1. */
  reset?: GoldenReset;
  /** Imports, processes, waits and writes the summary; never rejects. */
  start(): Promise<GoldenRunSummary>;
}

export interface GoldenAutomationPause {
  pausedPolicies: string[];
  pausedSchedules: string[];
}

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
 * Runs before the job supervisor starts: validates the request, the files and the library, takes
 * the database backup and pauses the legacy wiki automation so that no curator or maintenance call
 * runs. Nothing is written before every check passed and the backup exists.
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
  const options: GoldenRunOptions = { ...rest, environment };
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
  let library = await countLibrary(options.pool);
  let pendingJobs = await countPendingJobs(options.pool);
  let routes: unknown[] | undefined;
  let backup: GoldenBackup | undefined;
  let reset: GoldenReset | undefined;
  if (environment.resetLibrary) {
    // The guard reads the whole manifest, not the MEMORA_GOLDEN_ONLY subset: a library left by a
    // full run may be reset before a dry run of two sources.
    const plan = await planGoldenReset(options, fullManifest);
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
  if (!options.environment.allowNonEmpty) {
    if (library.sources > 0 || library.notes > 0)
      throw new Error(
        `The library is not empty (${library.sources} sources, ${library.notes} notes); reset it, ` +
          "set MEMORA_GOLDEN_RESET=1 or set MEMORA_GOLDEN_ALLOW_NONEMPTY=1. Nothing was changed."
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
  const automation = await pauseLegacyAutomation(options);
  log(options, "prepared", {
    manifest: manifest.name,
    files: goldenManifestFiles(manifest).length,
    cassette: cassette.mode,
    library,
    pendingJobs,
    backup: backup.path,
    ...(reset ? { reset } : {}),
    ...automation
  });
  const preparedBackup = backup;
  const preparedRoutes = routes;
  return {
    manifest,
    backup: preparedBackup,
    automation,
    ...(reset ? { reset } : {}),
    start: () =>
      runGolden(options, manifest, automation, preparedRoutes, {
        backup: preparedBackup,
        pendingJobs,
        only: environment.only,
        ...(reset ? { reset } : {})
      })
  };
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
async function planGoldenReset(options: GoldenRunOptions, manifest: GoldenManifest) {
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

const policyListSchema = z.array(z.object({ id: z.string(), state: z.string() }).passthrough());
const maintenanceDashboardSchema = z
  .object({
    schedules: z.array(
      z
        .object({
          id: z.string(),
          revision: z.number().int(),
          policy: z.object({ enabled: z.boolean() }).passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

async function pauseLegacyAutomation(options: GoldenRunOptions): Promise<GoldenAutomationPause> {
  const pausedPolicies: string[] = [];
  for (const policy of policyListSchema.parse(
    await options.organization.automaticCommand({ command: "policies" })
  ))
    if (policy.state === "enabled") {
      await options.organization.automaticCommand({ command: "pause", policyId: policy.id });
      pausedPolicies.push(policy.id);
    }
  const pausedSchedules: string[] = [];
  for (const schedule of maintenanceDashboardSchema.parse(
    await options.maintenance.command({ command: "dashboard" })
  ).schedules)
    if (schedule.policy.enabled) {
      await options.maintenance.command({
        command: "pause",
        id: schedule.id,
        expectedRevision: schedule.revision
      });
      pausedSchedules.push(schedule.id);
    }
  const stillEnabled = policyListSchema
    .parse(await options.organization.automaticCommand({ command: "policies" }))
    .filter((policy) => policy.state === "enabled");
  if (stillEnabled.length)
    throw new Error("The legacy wiki automation could not be paused; the golden run stopped");
  return { pausedPolicies, pausedSchedules };
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
  automation: GoldenAutomationPause,
  routes: unknown[],
  preparation: Record<string, unknown>
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
  const context: Record<string, unknown> = { automation, routes, ...preparation };
  let summary: GoldenRunSummary;
  try {
    await mkdir(runDirectory, { recursive: true });
    context.settings = pickSettings(await options.settings.getApp());
    context.atomicNoteMatchingVersion = (
      await import("./knowledge-processing.js")
    ).atomicNoteMatchingVersion;
    const imported = await importSources(options, manifest);
    const importedAt = now();
    const rootIds = imported.map((source) => source.sourceItemId);
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
    options.jobs.wake();
    const outcome = await waitForBatch(options, batch.batchId, runDirectory);
    const finishedAt = now();
    summary = await buildGoldenSummary(options, {
      manifest,
      imported,
      batchId: batch.batchId,
      startedAt,
      importedAt,
      finishedAt,
      outcome,
      context
    });
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

const settingsKeys = [
  "contentLanguage",
  "atomicNoteRelationThreshold",
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
    // Note relations are stored as unordered pairs (endpoints sorted by UUID), so the
    // pair is digested in title order; directed storage arrives with Relations v2 (F3).
    noteRelations: contentDigest(
      await rows(`select least(sn.title, tn.title) || '|' || greatest(sn.title, tn.title) || '|' ||
          coalesce(r.relation_type::text, '') || '|' || coalesce(r.status::text, '') as line
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
