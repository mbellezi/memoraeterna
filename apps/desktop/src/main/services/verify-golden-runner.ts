import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { AiCassette, type AiModelAdapter, type AiTaskRequest } from "@app/ai";
import { ProcessingPlanRequestSchema, SourceDescriptorSchema } from "@app/domain";

import { BackupService } from "./backup-service.js";
import {
  goldenManifestFiles,
  goldenManifestSchema,
  goldenSourcePath,
  importSources,
  prepareGoldenRun,
  selectGoldenSources,
  sha256File,
  type GoldenRunOptions,
  type GoldenRunSummary
} from "./golden-runner.js";
import { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import { IngestionService } from "./ingestion-service.js";
import { JobSupervisor } from "./job-supervisor.js";
import { LibraryResetService } from "./library-reset-service.js";

/**
 * Real-service check of the golden runner: no AI route, no network and no owner data. It starts a
 * throwaway PostgreSQL sidecar and runs the DEV runner against the real ingestion, hierarchy and job
 * services and a real pg_dump backup, with a tiny local manifest (web capture, hierarchical Markdown
 * paper, HTML book, plain text). It covers the pre-flight refusals, the backup, the live token cap
 * and the replay divergence stop (both through the real batch cancellation), and a complete run
 * whose stages that need an AI route do not execute. What it cannot cover: a PDF through Docling,
 * and any real AI call, so source matching waits for review in the complete run. It also covers
 * MEMORA_GOLDEN_RESET=1 with the real LibraryResetService (the Settings reset): a complete golden
 * library, then a record-style import of two golden sources, is reset and replayed in the same
 * database, an empty library is a no-op, and one non-golden source refuses the reset. It also
 * covers the import failing at its document insert (a database trigger rejects it): nothing is left
 * behind, no source row and no stored file, and the bare source row an earlier version of the
 * import could leave counts as golden for the reset only when its type and title are in the manifest.
 *
 *   tsx src/main/services/verify-golden-runner.ts   (from apps/desktop; MEMORA_VERIFY_DIR picks the
 *   folder that holds the throwaway database and fixtures, default: the system temp folder;
 *   MEMORA_VERIFY_KEEP=1 keeps it, with the run summaries)
 */

const execFileAsync = promisify(execFile);

// The packaged app bundles the worker host next to the main bundle; under tsx it is the TypeScript
// source, so point the supervisor's worker threads there (tsx's loader is inherited by the thread).
{
  const workerThreads = createRequire(import.meta.url)(
    "node:worker_threads"
  ) as typeof import("node:worker_threads");
  class SourceWorker extends workerThreads.Worker {
    public constructor(file: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      super(
        file instanceof URL && file.pathname.endsWith("/services/workers/worker-host.js")
          ? new URL("../workers/worker-host.ts", import.meta.url)
          : file,
        options
      );
    }
  }
  workerThreads.Worker = SourceWorker;
  syncBuiltinESMExports();
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repositoryRoot = resolve(desktopRoot, "../..");
const workBase = process.env.MEMORA_VERIFY_DIR ?? tmpdir();
await mkdir(workBase, { recursive: true });
const workDir = await mkdtemp(join(workBase, "memora-golden-verify-"));
const workspace = join(workDir, "workspace");
const userData = join(workDir, "userData");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: repositoryRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecarPaths.binDir,
  dataDir: join(workDir, "database"),
  database: "memora_golden_verify",
  user: "memora_golden_verify",
  password: `golden-${Math.random().toString(36).slice(2)}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const storageSettings = async () => ({
  obsidianVaultPath: null,
  managedRoot: "Memora",
  obsidianSyncEnabled: false,
  obsidianSyncPaused: false,
  deletionPolicy: "tombstone" as const,
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null,
  updatedAt: new Date().toISOString()
});

let pool: PgPool | null = null;
let jobs: JobSupervisor | null = null;
try {
  await mkdir(join(userData, "database"), { recursive: true });
  await writeFile(
    join(userData, "database", "dev-connection.json"),
    JSON.stringify({ developmentOnly: true })
  );
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 5 });
  await runMigrations(pool, resolve(repositoryRoot, "packages/db/drizzle"), {
    seedFolder: resolve(repositoryRoot, "packages/db/seed")
  });

  const manifestPath = await writeFixtures();
  const hierarchy = new HierarchicalIngestionService({ getPool: () => pool });
  const ingestion = new IngestionService({
    getPool: () => pool,
    getStorageSettings: storageSettings,
    userDataPath: userData,
    resourcesPath: repositoryRoot,
    workspaceRoot: repositoryRoot,
    isPackaged: false,
    hierarchicalIngestionService: hierarchy,
    fetchExternalPage: async () => new Response("", { status: 500 })
  });
  jobs = new JobSupervisor({ getPool: () => pool, logger: console });
  const backup = new BackupService({
    getDatabaseContext: () => ({
      connection: manager.getConnection()!,
      pgDumpPath: join(sidecarPaths.binDir, "pg_dump")
    }),
    getStorageSettings: storageSettings
  });

  // The legacy automation the runner must pause: one enabled curator policy and one schedule.
  const policy = { id: "11111111-1111-4111-8111-111111111111", state: "enabled" };
  const schedule = {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 4,
    policy: { enabled: true }
  };
  const automationCalls: string[] = [];
  const organization = {
    automaticCommand: async (command: { command: string }) => {
      automationCalls.push(`organization:${command.command}`);
      if (command.command === "pause") policy.state = "paused";
      return command.command === "pause" ? policy : [policy];
    }
  };
  const maintenance = {
    command: async (command: { command: string }) => {
      automationCalls.push(`maintenance:${command.command}`);
      if (command.command === "pause") schedule.policy.enabled = false;
      return command.command === "dashboard" ? { schedules: [schedule], runs: [] } : {};
    }
  };
  // The real Settings reset; restoring the defaults re-creates the (enabled) legacy automation,
  // which the runner must pause again after the reset.
  let defaultsRestored = 0;
  const libraryReset = new LibraryResetService({
    getPool: () => pool,
    getStorageSettings: storageSettings,
    userDataPath: userData,
    restoreDefaults: async () => {
      defaultsRestored += 1;
      policy.state = "enabled";
      schedule.policy.enabled = true;
    }
  });
  const events: string[] = [];
  const record = new AiCassette({ mode: "record", directory: join(workDir, "cassette") });
  const replay = new AiCassette({ mode: "replay", directory: join(workDir, "cassette") });
  const remote = fakeRemoteAdapter();
  const input = (overrides: Partial<Parameters<typeof prepareGoldenRun>[0]> = {}) =>
    ({
      env: { MEMORA_GOLDEN_RUN: manifestPath, MEMORA_GOLDEN_MAX_TOKENS: "100" },
      isPackaged: false,
      userDataPath: userData,
      workspaceRoot: workspace,
      pool: pool as unknown as GoldenRunOptions["pool"],
      cassette: record,
      backup,
      ingestion,
      hierarchy,
      jobs: jobs!,
      organization: organization as unknown as GoldenRunOptions["organization"],
      maintenance: maintenance as unknown as GoldenRunOptions["maintenance"],
      settings: { getApp: async () => ({ contentLanguage: "en" }) as never },
      quit: () => undefined,
      log: (event: string) => {
        events.push(event);
      },
      pollIntervalMs: 250,
      ...overrides
    }) satisfies Parameters<typeof prepareGoldenRun>[0];
  const withRoutes = { readRoutes: async () => [{ task: "embedding", provider: "verify" }] };
  const backupFolders = async () =>
    existsSync(join(workspace, ".cache", "f0", "backups"))
      ? readdir(join(workspace, ".cache", "f0", "backups"))
      : [];
  const resetLibrary = async () => {
    await pool!.query(`truncate table source_items, jobs, processing_batches cascade`);
    policy.state = "enabled";
    schedule.policy.enabled = true;
    events.length = 0;
  };
  // A canceled run's jobs stop asynchronously: wait for the queue to drain before moving on.
  const noJobsLeft = async (what: string) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const left = Number(
        (
          await pool!.query<{ n: number }>(
            `select count(*)::int as n from jobs where status::text in ('queued', 'running')`
          )
        ).rows[0]?.n
      );
      if (left === 0) return console.log(`ok  ${what}`);
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(`check failed: ${what}`);
  };

  // 1. Refusals that must change nothing: no AI routes (the real lookup) and pending jobs.
  await expectRejection(
    prepareGoldenRun(input()),
    /needs a configured embedding route/,
    "an unconfigured route"
  );
  check(automationCalls.length === 0, "a refused run must not touch the automation");
  check((await backupFolders()).length === 0, "a refused run must not take a backup");
  await pool.query(
    `insert into jobs (type, status, payload) values ('maintenance', 'queued', '{}')`
  );
  await expectRejection(
    prepareGoldenRun(input(withRoutes)),
    /1 jobs are queued or running \(maintenance 1\)/,
    "queued jobs"
  );
  await pool.query(`delete from jobs`);
  await jobs.start();

  // 2. The live token cap: the cassette is over it at the first poll, so the batch is canceled
  //    through the real supervisor while its jobs are starting.
  const capped = await prepareGoldenRun(input(withRoutes));
  check(record.stats().maxLiveTokens === 100, "the cap is armed on the cassette");
  await record.wrap(remote).run(modelRequest("first"));
  await expectRejection(
    record.wrap(remote).run(modelRequest("second")),
    /live token cap reached/,
    "a live call past the cap"
  );
  const cappedSummary = await withTimeout(capped.start(), 60_000, "the capped run");
  check(
    cappedSummary.status === "token_limit",
    `token limit stops the batch: ${cappedSummary.status}`
  );
  check(
    (cappedSummary.runs as Array<{ status: string }>).every((item) => item.status === "canceled"),
    "every run of the capped batch is canceled"
  );
  await noJobsLeft("no job is left after the cancellation");
  check(events.includes("token_limit"), "the stop is logged");

  // 3. Replay divergence: one cassette miss cancels the batch.
  await resetLibrary();
  await expectRejection(
    replay.wrap(remote).run(modelRequest("never recorded")),
    /AI cassette miss/,
    "a replay miss"
  );
  const diverged = await prepareGoldenRun(
    input({ ...withRoutes, cassette: replay, env: { MEMORA_GOLDEN_RUN: manifestPath } })
  );
  const divergedSummary = await withTimeout(diverged.start(), 60_000, "the diverged replay");
  check(
    divergedSummary.status === "diverged",
    `a replay miss stops the batch: ${divergedSummary.status}`
  );
  await noJobsLeft("no job is left after the divergence");

  // 4. A complete run with the supervisor: backup first, automation paused, whole manifest processed.
  await resetLibrary();
  const run = await prepareGoldenRun(
    input({
      ...withRoutes,
      env: { MEMORA_GOLDEN_RUN: manifestPath, MEMORA_GOLDEN_MAX_TOKENS: "1000" }
    })
  );
  const dump = await stat(join(run.backup.path, "database.dump"));
  check(dump.size > 0 && dump.size === run.backup.bytes, "the backup holds a database dump");
  const { stdout } = await execFileAsync(join(sidecarPaths.binDir, "pg_restore"), [
    "--list",
    join(run.backup.path, "database.dump")
  ]);
  check(/TABLE DATA public source_items/.test(stdout), "the backup dump lists the library tables");
  check(policy.state === "paused" && !schedule.policy.enabled, "the legacy automation is paused");
  check(
    run.automation.pausedPolicies.length === 1 && run.automation.pausedSchedules.length === 1,
    "the paused automation is recorded"
  );

  const summary = await withTimeout(run.start(), 180_000, "the golden run");
  report(summary);
  check(summary.status !== "failed", `the run did not fail: ${String(summary.error ?? "")}`);
  const sources = summary.sources as Array<{
    key: string;
    chunks: number;
    items: number;
    structure?: { divisions: number };
  }>;
  check(sources.length === 4, `four roots were imported, got ${sources.length}`);
  check(
    sources.every((source) => source.chunks > 0),
    "every root has chunks"
  );
  check(
    (sources.find((source) => source.key === "paper")?.structure?.divisions ?? 0) >= 2,
    "the paper's detected structure was confirmed through the real hierarchy service"
  );
  check(
    sources.find((source) => source.key === "book")?.items === 3,
    "the book holds the container and its two chapters"
  );
  const failures = summary.failures as {
    runs: number;
    stages: unknown[];
    stalledStages: Array<{ stage: string }>;
  };
  check(failures.runs === 0 && failures.stages.length === 0, "no run or stage failed");
  check(
    failures.stalledStages.every((item) => item.stage === "sourceMatching"),
    "only source matching waits (it needs the AI route this check does not have)"
  );
  check(
    Object.values(summary.outputs as Record<string, { count: number }>).every(
      (digest) => digest.count >= 0
    ) && (summary.outputs as { chunks: { count: number } }).chunks.count > 0,
    "the content digests are computed against the real schema"
  );
  check(
    (summary.backup as { path?: string }).path === run.backup.path,
    "the summary names the backup"
  );
  check(events.includes("summary") && !events.includes("failed"), "the run logged its summary");

  // 5. A second run refuses the now non-empty library, and a repeated import fails loudly.
  const backupsBefore = (await backupFolders()).length;
  await expectRejection(
    prepareGoldenRun(input(withRoutes)),
    /library is not empty/,
    "a non-empty library"
  );
  check((await backupFolders()).length === backupsBefore, "a refused run takes no new backup");
  const manifest = goldenManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  await expectRejection(
    importSources({ workspaceRoot: workspace, ingestion, hierarchy }, manifest),
    /web is already in the library/,
    "a repeated web capture"
  );
  // 6. MEMORA_GOLDEN_RESET=1 with the real LibraryResetService. The app resets before the job
  //    supervisor starts, so it is stopped here too.
  await jobs.stop();
  const rowCount = async (table: string) =>
    Number(
      (await pool!.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n
    );
  const resetEnv = (extra: Record<string, string> = {}) => ({
    MEMORA_GOLDEN_RUN: manifestPath,
    MEMORA_GOLDEN_MAX_TOKENS: "1000",
    MEMORA_GOLDEN_RESET: "1",
    ...extra
  });
  const withReset = { ...withRoutes, libraryReset };

  // 6a. The library the complete run left (a web capture, a paper with detected sections, a book
  //     with two chapters, a story) is proven golden by what the import stored, then reset.
  const sourcesBefore = await rowCount("source_items");
  check(
    sourcesBefore > 4 && (await rowCount("document_assets")) > 0,
    `the complete run left ${sourcesBefore} sources with their original files`
  );
  const backupsBeforeReset = (await backupFolders()).length;
  const restoredBefore = defaultsRestored;
  const fullReset = await prepareGoldenRun(input({ ...withReset, env: resetEnv() }));
  check(
    fullReset.reset?.performed === true && fullReset.reset.removedSources === sourcesBefore,
    `the reset removed all ${sourcesBefore} sources: ${JSON.stringify(fullReset.reset)}`
  );
  check(
    (await rowCount("source_items")) === 0 &&
      (await rowCount("chunks")) === 0 &&
      (await rowCount("documents")) === 0 &&
      (await rowCount("document_assets")) === 0 &&
      (await rowCount("atomic_notes")) === 0,
    "the library is empty after the reset"
  );
  check(
    (await readdir(join(userData, "assets"))).length === 0,
    "the imported original files are deleted, as Settings does"
  );
  check(
    (await backupFolders()).length === backupsBeforeReset + 1 &&
      fullReset.reset?.backupPath === fullReset.backup.path,
    "one backup, taken before the reset, is the run's backup"
  );
  const resetDump = await execFileAsync(join(sidecarPaths.binDir, "pg_restore"), [
    "--list",
    join(fullReset.backup.path, "database.dump")
  ]);
  check(
    (await stat(join(fullReset.backup.path, "database.dump"))).size === fullReset.backup.bytes &&
      /TABLE DATA public document_assets/.test(resetDump.stdout),
    "the pre-reset backup holds a dump of the library"
  );
  check(
    defaultsRestored === restoredBefore + 1 &&
      policy.state === "paused" &&
      !schedule.policy.enabled &&
      fullReset.automation.pausedPolicies.length === 1,
    "the defaults came back with the reset and the legacy automation is paused again"
  );

  // 6b. A record-style import of two golden sources, then a reset and a run in the same database.
  const twoSources = selectGoldenSources(manifest, ["web", "story"]);
  await importSources({ workspaceRoot: workspace, ingestion, hierarchy }, twoSources);
  check((await rowCount("source_items")) === 2, "two golden sources were imported");
  const replay2 = await prepareGoldenRun(
    input({ ...withReset, env: resetEnv({ MEMORA_GOLDEN_ONLY: "web,story" }) })
  );
  check(
    replay2.reset?.performed === true && replay2.reset.removedSources === 2,
    `the reset removed the two golden sources: ${JSON.stringify(replay2.reset)}`
  );
  check((await rowCount("source_items")) === 0, "the library is empty before the run starts");
  await jobs.start();
  const replaySummary = await withTimeout(replay2.start(), 120_000, "the run after the reset");
  check(
    replaySummary.status !== "failed" && (replaySummary.sources as unknown[]).length === 2,
    `the run imported the two sources again: ${replaySummary.status} ${String(replaySummary.error ?? "")}`
  );
  const runDirectories = (await readdir(join(workspace, ".cache", "golden", "runs"))).sort();
  const written = JSON.parse(
    await readFile(
      join(workspace, ".cache", "golden", "runs", runDirectories.at(-1)!, "summary.json"),
      "utf8"
    )
  ) as { reset?: unknown; backup?: { path?: string } };
  check(
    JSON.stringify(written.reset) ===
      JSON.stringify({
        performed: true,
        removedSources: 2,
        backupPath: replay2.backup.path
      }) && written.backup?.path === replay2.backup.path,
    "summary.json records reset { performed, removedSources, backupPath }"
  );
  check(events.includes("reset"), "the reset is logged");

  // 6c. One source that is not in the manifest refuses the reset and changes nothing.
  await jobs.stop();
  await ingestion.createManual({
    descriptor: SourceDescriptorSchema.parse({
      type: "PersonalNote",
      title: "My own note",
      language: "en"
    }),
    content: "A note that belongs to the owner and not to the golden library. ".repeat(4),
    duplicatePolicy: "ignore",
    processingPlan: ProcessingPlanRequestSchema.parse({
      preset: "import_only",
      requestedStages: []
    })
  });
  const mixedSources = await rowCount("source_items");
  check(mixedSources > 2, "the owner's note sits next to the golden sources");
  const backupsBeforeRefusal = (await backupFolders()).length;
  const callsBeforeRefusal = automationCalls.length;
  await expectRejection(
    prepareGoldenRun(input({ ...withReset, env: resetEnv() })),
    /library holds non-golden sources \(1\).*My own note/,
    "a library with one non-golden source"
  );
  check(
    (await rowCount("source_items")) === mixedSources &&
      (await backupFolders()).length === backupsBeforeRefusal &&
      automationCalls.length === callsBeforeRefusal,
    "the refusal deleted nothing, took no backup and touched no automation"
  );
  await expectRejection(
    prepareGoldenRun(input({ ...withRoutes, env: resetEnv({ MEMORA_GOLDEN_RESET: "yes" }) })),
    /MEMORA_GOLDEN_RESET must be 1/,
    "an ambiguous reset flag"
  );

  // 6d. An import that fails at its document insert persists nothing: no source row, no document,
  //     no asset row and no stored file (the persistence is one transaction). A trigger rejects the
  //     insert in the throwaway database; the paper is a hierarchical file import, as in the field.
  await resetLibrary();
  const storedFiles = async () =>
    (await readdir(join(userData, "assets"), { recursive: true, withFileTypes: true })).filter(
      (entry) => entry.isFile()
    ).length;
  const filesBefore = await storedFiles();
  const worksBefore = await rowCount("bibliographic_works");
  await pool.query(
    `create function verify_reject_document() returns trigger language plpgsql as $$
     begin
       if new.title = 'Replication study' then raise exception 'simulated document insert failure'; end if;
       return new;
     end $$`
  );
  await pool.query(
    `create trigger verify_reject_document before insert on documents
     for each row execute function verify_reject_document()`
  );
  await expectRejection(
    importSources(
      { workspaceRoot: workspace, ingestion, hierarchy },
      selectGoldenSources(manifest, ["paper"])
    ),
    /simulated document insert failure/,
    "an import whose document insert fails"
  );
  await pool.query(`drop trigger verify_reject_document on documents`);
  await pool.query(`drop function verify_reject_document()`);
  check(
    (await rowCount("source_items")) === 0 &&
      (await rowCount("documents")) === 0 &&
      (await rowCount("document_assets")) === 0 &&
      (await rowCount("document_structures")) === 0 &&
      (await rowCount("bibliographic_works")) === worksBefore &&
      (await storedFiles()) === filesBefore,
    "the failed import left no source, document, asset, structure, new bibliographic row or new stored file"
  );

  // 6e. The bare source row an earlier version of the import could leave (no document, no asset) is
  //     a leftover of a failed golden import: the reset accepts it when type and title are in the
  //     manifest, and still refuses a content-less row that is not.
  await pool.query(
    `insert into source_items (type, title, source_origin, language, metadata)
     values ('AcademicPaper', 'Something I started importing', 'file_upload', 'en', '{}')`
  );
  await expectRejection(
    prepareGoldenRun(input({ ...withReset, env: resetEnv() })),
    /library holds non-golden sources \(1\).*Something I started importing/,
    "a content-less source whose title is not in the manifest"
  );
  check((await rowCount("source_items")) === 1, "the refusal deleted nothing");
  await pool.query(`delete from source_items`);
  await pool.query(
    `insert into source_items (type, title, source_origin, language, metadata)
     values ('AcademicPaper', 'Replication study', 'file_upload', 'en', '{}')`
  );
  check(
    (await rowCount("documents")) === 0 && (await rowCount("document_assets")) === 0,
    "the leftover has no document and no asset"
  );
  const leftoverReset = await prepareGoldenRun(input({ ...withReset, env: resetEnv() }));
  check(
    leftoverReset.reset?.performed === true &&
      leftoverReset.reset.removedSources === 1 &&
      (await rowCount("source_items")) === 0,
    `the reset removed the leftover of the failed golden import: ${JSON.stringify(leftoverReset.reset)}`
  );

  // 6f. An empty library needs no reset: the flag is a no-op and the run's usual backup is taken.
  await resetLibrary();
  const noop = await prepareGoldenRun(input({ ...withReset, env: resetEnv() }));
  check(
    noop.reset?.performed === false &&
      noop.reset.removedSources === 0 &&
      noop.reset.backupPath === null,
    "an empty library is a no-op"
  );

  console.log("GOLDEN_RUNNER_VERIFY ok");
} catch (error) {
  console.error("GOLDEN_RUNNER_VERIFY failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await jobs?.stop().catch(() => undefined);
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  if (process.env.MEMORA_VERIFY_KEEP === "1") console.log(`kept ${workDir}`);
  else await rm(workDir, { recursive: true, force: true });
}

async function writeFixtures() {
  const text = (topic: string, sentences: number) =>
    Array.from(
      { length: sentences },
      (_, index) =>
        `Observation ${index + 1} about ${topic}: retrieval gets harder as time passes, and spaced review restores it.`
    ).join(" ");
  const contents: Record<string, string> = {
    web: `<html><head><title>Forgetting curve</title></head><body><main><h1>Forgetting curve</h1><p>${text("the forgetting curve", 12)}</p><p>${text("spacing", 12)}</p></main></body></html>`,
    paper: `# Replication study\n\n## Introduction\n\n${text("replication", 14)}\n\n## Methods\n\n${text("method", 14)}\n\n## Results\n\n${text("results", 14)}\n`,
    "book-01": `<html><body><h1>Chapter one</h1><p>${text("the asylum", 14)}</p></body></html>`,
    "book-02": `<html><body><h1>Chapter two</h1><p>${text("the town", 14)}</p></body></html>`,
    story: `${text("a gift", 20)}\n\n${text("a watch chain", 20)}\n`
  };
  const entry = (key: string, format: "html" | "markdown" | "text", extra: object) => ({
    key,
    kind: "document",
    title: key,
    language: "en",
    license: "CC-BY-4.0",
    attribution: "Verification fixture",
    format,
    url: `https://example.org/${key}`,
    sha256: null,
    bytes: null,
    ...extra
  });
  const manifest = goldenManifestSchema.parse({
    format: "memora-golden-manifest",
    version: 1,
    name: "verify",
    description: "Verification fixtures",
    capturedAt: "2026-10-14T00:00:00.000Z",
    sources: [
      entry("web", "html", {
        title: "Forgetting curve",
        import: "webCapture",
        pageUrl: "https://example.org/wiki/forgetting-curve"
      }),
      entry("paper", "markdown", {
        title: "Replication study",
        import: "file",
        descriptor: { type: "AcademicPaper" }
      }),
      {
        key: "book",
        kind: "container",
        title: "A book",
        language: "en",
        license: "public-domain",
        attribution: "Verification fixture",
        descriptor: { type: "Book" },
        children: [
          entry("book-01", "html", {
            title: "Chapter one",
            import: "file",
            descriptor: { type: "BookChapter", chapterNumber: "I" }
          }),
          entry("book-02", "html", {
            title: "Chapter two",
            import: "file",
            descriptor: { type: "BookChapter", chapterNumber: "II" }
          })
        ]
      },
      entry("story", "text", {
        title: "A story",
        import: "file",
        descriptor: { type: "StandaloneArticle" }
      })
    ]
  });
  for (const file of goldenManifestFiles(manifest)) {
    const path = goldenSourcePath(workspace, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents[file.key]!);
    const pin = await sha256File(path);
    file.sha256 = pin.sha256;
    file.bytes = pin.bytes;
  }
  const manifestPath = join(workDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

/** A remote model that answers instantly with fixed usage (120 tokens), for the cassette only. */
function fakeRemoteAdapter(): AiModelAdapter {
  const description = {
    providerId: "verify-remote",
    modelId: "verify-1",
    runtime: "remote" as const,
    capabilities: [],
    parameterCapabilities: {},
    limits: {},
    requirements: {}
  };
  return {
    describe: () => description,
    canHandle: () => true,
    run: async (request) => ({
      taskType: request.taskType,
      output: "ok",
      providerId: description.providerId,
      modelId: description.modelId,
      runtime: description.runtime,
      durationMs: 1,
      inputTokens: 90,
      outputTokens: 30
    })
  };
}

function modelRequest(text: string): AiTaskRequest {
  return {
    taskType: "summarization",
    input: text,
    requiredCapabilities: []
  } as unknown as AiTaskRequest;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`ok  ${message}`);
}

async function expectRejection(promise: Promise<unknown>, pattern: RegExp, what: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  if (!(error instanceof Error) || !pattern.test(error.message))
    throw new Error(
      `check failed: ${what} should be refused with ${pattern}, got ${String(error)}`
    );
  console.log(`ok  ${what} is refused`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function report(summary: GoldenRunSummary) {
  const stages = summary.stages as Record<string, { statuses: Record<string, number> }>;
  console.log(
    "summary",
    JSON.stringify({
      status: summary.status,
      wallMs: summary.wallMs,
      stages: Object.fromEntries(
        Object.entries(stages ?? {}).map(([stage, value]) => [stage, value.statuses])
      ),
      sources: summary.sources,
      outputs: summary.outputs
    })
  );
}
