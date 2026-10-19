import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createLegacyStateRepository,
  createPgPool,
  hasLegacyContent,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { AiCassette, type AiModelAdapter, type AiTaskRequest } from "@app/ai";
import { ProcessingPlanRequestSchema, SourceDescriptorSchema } from "@app/domain";

import "./verify-worker-host.js";
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
import type { GoldenTopicBarrier } from "./golden-topics.js";
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
 * Finally it covers MEMORA_GOLDEN_SOURCE_PAIRS on the complete library (verdict-only, a fake decider):
 * the real read queries build the requests, the verdicts are written and no relation, decision or
 * run state is persisted. The legacy wiki, organization and maintenance tables stay empty through
 * every run and reset (the runner no longer pauses legacy automation: none can exist). Last it covers
 * MEMORA_GOLDEN_TOPICS=full (G1, D23): a fake topic barrier on the real supervisor and jobs table, one
 * batch whose jobs are paced a source at a time in manifest order, the topic lane drained and the hold
 * re-armed in between and released after the last drain.
 *
 *   tsx src/main/services/verify-golden-runner.ts   (from apps/desktop; MEMORA_VERIFY_DIR picks the
 *   folder that holds the throwaway database and fixtures, default: the system temp folder;
 *   MEMORA_VERIFY_KEEP=1 keeps it, with the run summaries)
 */

const execFileAsync = promisify(execFile);

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

  // The legacy-content tables (wiki pages, organization and maintenance runs and settings, curator
  // policy revisions, investigations) must stay empty: nothing creates legacy state any more.
  const legacyCounts = () => createLegacyStateRepository(pool!).legacyContentCounts();
  const noLegacyContent = async () => !hasLegacyContent(await legacyCounts());
  // The real Settings reset; restoring the defaults is the prompt catalog only (a counter here).
  let defaultsRestored = 0;
  const libraryReset = new LibraryResetService({
    getPool: () => pool,
    getStorageSettings: storageSettings,
    userDataPath: userData,
    restoreDefaults: async () => {
      defaultsRestored += 1;
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
  check(await noLegacyContent(), "a refused run must not create legacy state");
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

  // 4. A complete run with the supervisor: backup first, whole manifest processed, no legacy state.
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
  check(await noLegacyContent(), "the prepared run created no legacy state");

  const summary = await withTimeout(run.start(), 180_000, "the golden run");
  report(summary);
  check(summary.status !== "failed", `the run did not fail: ${String(summary.error ?? "")}`);
  check(!("automation" in summary), "summary.json lists no paused legacy automation");
  check(
    await noLegacyContent(),
    `the full-knowledge import wrote no legacy state: ${JSON.stringify(await legacyCounts())}`
  );
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
  // 5b. MEMORA_GOLDEN_SOURCE_PAIRS on this complete library (ALLOW_NONEMPTY, no MEMORA_GOLDEN_ONLY):
  //     a verdict-only run through the real read queries and a fake decider. It judges the pairs of
  //     the library, writes the raw verdicts and persists no relation, decision or run state.
  const persistedTables = [
    "source_items",
    "chunks",
    "atomic_notes",
    "source_relations",
    "source_relation_evidence",
    "source_matching_decisions",
    "source_matching_runs"
  ];
  const persisted = async () =>
    JSON.stringify(
      await Promise.all(
        persistedTables.map(async (table) => [
          table,
          Number(
            (await pool!.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n
          )
        ])
      )
    );
  const pairsPath = join(workDir, "pairs.json");
  await writeFile(
    pairsPath,
    JSON.stringify([
      { left: "web", right: "paper", label: "web/paper" },
      { left: "A story", right: "book" },
      { left: "web", right: "Forgetting curve" },
      { left: "web", right: "no such work" }
    ])
  );
  const requests: string[] = [];
  const fakeDecider = {
    // Relates a source of each of the two works (a book answers with its chapters), citing its first
    // passage; sources and passages are read from the prompt the matcher builds.
    runDefaultTask: async (_task: string, text: string) => {
      requests.push(text);
      const listed = <T>(heading: string) =>
        JSON.parse(new RegExp(`${heading}:\n(\\[.*\\])\n`).exec(text)![1]!) as T[];
      const sources = listed<{ key: string; root: string }>("Sources");
      const chunks = listed<{ key: string; source: string }>("Original chunks");
      const from = sources.find((source) => source.root === "w1")!.key;
      const to = sources.find((source) => source.root === "w2")!.key;
      const first = (source: string) => chunks.find((chunk) => chunk.source === source)!.key;
      return {
        taskType: "reranking",
        output: {
          relations: [[from, to, "supports", 90, 85, [first(from)], [first(to)]]]
        },
        providerId: "verify-remote",
        modelId: "verify-1",
        runtime: "remote",
        durationMs: 1,
        inputTokens: 100,
        outputTokens: 20,
        profileId: "verify",
        aiTaskRunId: "verify-run",
        outputLanguage: "en"
      };
    }
  };
  const tablesBeforePairs = await persisted();
  const pairRun = await prepareGoldenRun(
    input({
      ...withRoutes,
      cassette: replay,
      ai: fakeDecider as never,
      env: {
        MEMORA_GOLDEN_RUN: manifestPath,
        MEMORA_GOLDEN_SOURCE_PAIRS: pairsPath,
        MEMORA_GOLDEN_ALLOW_NONEMPTY: "1"
      }
    })
  );
  check(
    pairRun.sourcePairs?.mode === "verdict_only" && pairRun.sourcePairs.pairs === 4,
    "a complete library with the pair list is a verdict-only run"
  );
  const pairSummary = await withTimeout(pairRun.start(), 60_000, "the pair verdict run");
  check(pairSummary.status === "completed", `the pair run completed: ${pairSummary.status}`);
  const verdictsPath = (pairSummary.sourcePairs as { verdicts: string }).verdicts;
  const verdicts = JSON.parse(await readFile(verdictsPath, "utf8")) as {
    state: string;
    pairs: Array<{ status: string; verdict: string | null; kept: unknown[] }>;
  };
  check(
    verdicts.state === "finished" &&
      JSON.stringify(verdicts.pairs.map((pair) => pair.status)) ===
        JSON.stringify(["judged", "judged", "same_root", "unresolved"]),
    `the verdicts file reports each pair: ${verdicts.pairs.map((pair) => pair.status).join(", ")}`
  );
  check(
    requests.length === 2 &&
      verdicts.pairs
        .slice(0, 2)
        .every((pair) => pair.verdict === "related" && pair.kept.length === 1),
    "the decider was asked about the two resolvable pairs and its items passed the floors"
  );
  check(
    (await persisted()) === tablesBeforePairs,
    "the verdict run persisted no source, chunk, note, relation, decision or run state"
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
    defaultsRestored === restoredBefore + 1 && (await noLegacyContent()),
    "the defaults came back with the reset and the reset created no legacy state"
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
  await expectRejection(
    prepareGoldenRun(input({ ...withReset, env: resetEnv() })),
    /library holds non-golden sources \(1\).*My own note/,
    "a library with one non-golden source"
  );
  check(
    (await rowCount("source_items")) === mixedSources &&
      (await backupFolders()).length === backupsBeforeRefusal &&
      (await noLegacyContent()),
    "the refusal deleted nothing, took no backup and created no legacy state"
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

  // 7. A real full_knowledge plan, organizeKnowledge included as the Library and the gateway admit
  //    it, on a library with no curator policy (nothing creates one any more): the stage is
  //    recorded as skipped and the legacy-content tables stay empty (F2 D3).
  await resetLibrary();
  const [story] = await importSources(
    { workspaceRoot: workspace, ingestion, hierarchy },
    selectGoldenSources(manifest, ["story"])
  );
  check(story !== undefined, "one source was imported for the full-knowledge plan");
  const batch = await hierarchy.process({
    runKind: "initial",
    trigger: "library_action",
    plan: ProcessingPlanRequestSchema.parse({
      preset: "full_knowledge",
      requestedStages: [],
      scope: "source_and_children",
      targetSourceItemIds: [story!.sourceItemId]
    })
  });
  check(batch.queued.length === 1, "the full-knowledge plan queued one run");
  await jobs.start();
  jobs.wake();
  await noJobsLeft("the full-knowledge batch left no queued or running job");
  const organizeStages = (
    await pool.query<{ status: string; skip_reason: string | null }>(
      `select s.status::text, s.skip_reason
       from ingestion_run_stages s join ingestion_runs r on r.id = s.ingestion_run_id
       where s.stage = 'organizeKnowledge' and r.batch_id = $1`,
      [batch.batchId]
    )
  ).rows;
  // organizeKnowledge left the processing plan with the legacy detach (D14): no run has the stage.
  check(
    organizeStages.length === 0,
    `organizeKnowledge is no longer a stage of the plan: ${JSON.stringify(organizeStages)}`
  );
  check(
    (await noLegacyContent()) &&
      (await rowCount("organization_runs")) === 0 &&
      (await rowCount("maintenance_runs")) === 0,
    `the full-knowledge import wrote no legacy state: ${JSON.stringify(await legacyCounts())}`
  );

  // 8. G1 `full` with the topic barrier (D23) on the real services, the real supervisor and the real
  //    jobs table. The topic service is not part of this check: a fake barrier answers the hold and
  //    the release, queues a `topic-place` job at each release (as the held PLACE jobs would be) and
  //    finishes it a moment later. The run must stay ONE batch (as the recorded run did) and its jobs
  //    must be paced: each source's jobs are claimed
  //    only after the previous source's jobs finished and the light lane was drained, in manifest
  //    order, with the heavy lane idle at every drain.
  await resetLibrary();
  const barrierEvents: Array<{ event: string; at: number; running: number; heldBack: number }> = [];
  const observeLanes = async (event: string) => {
    const state = await pool!.query<{ running: number; heldBack: number }>(
      `select count(*) filter (where lane = 'heavy' and status::text = 'running')::int as running,
              count(*) filter (where type = 'ingestion' and status::text = 'queued'
                               and run_after > now())::int as "heldBack"
       from jobs`
    );
    barrierEvents.push({
      event,
      at: Date.now(),
      running: Number(state.rows[0]?.running),
      heldBack: Number(state.rows[0]?.heldBack)
    });
  };
  const queuedTopicJobs = async () =>
    Number(
      (
        await pool!.query<{ n: number }>(
          `select count(*)::int as n from jobs
           where type like 'topic-%' and status::text in ('queued', 'running')`
        )
      ).rows[0]?.n
    );
  const topicBarrier: GoldenTopicBarrier = {
    hold: () => observeLanes("hold"),
    release: async () => {
      await observeLanes("release");
      await pool!.query(
        `insert into jobs (type, status, lane, payload) values ('topic-place', 'queued', 'light', '{}')`
      );
      setTimeout(() => {
        void pool!.query(
          `update jobs set status = 'succeeded', finished_at = now()
           where type like 'topic-%' and status::text = 'queued'`
        );
      }, 400);
    }
  };
  const fullRun = await prepareGoldenRun(
    input({
      ...withRoutes,
      topicBarrier,
      env: {
        MEMORA_GOLDEN_RUN: manifestPath,
        MEMORA_GOLDEN_MAX_TOKENS: "1000",
        MEMORA_GOLDEN_TOPICS: "full"
      },
      pollIntervalMs: 100
    })
  );
  const fullSummary = await withTimeout(fullRun.start(), 180_000, "the per-source topic run");
  report(fullSummary);
  check(
    fullSummary.status !== "failed",
    `the run did not fail: ${String(fullSummary.error ?? "")}`
  );
  const sequence = barrierEvents.map((entry) => entry.event).join(",");
  check(
    sequence === "hold,release,hold,release,hold,release,hold,release",
    `the hold is armed at the start and after each drain but the last: ${sequence}`
  );
  const releases = barrierEvents.filter((entry) => entry.event === "release");
  check(
    releases.every((entry) => entry.running === 0),
    `the heavy lane is idle at every drain: ${releases.map((entry) => entry.running).join(",")}`
  );
  const heldBack = releases.map((entry) => entry.heldBack);
  check(
    heldBack[0]! > heldBack[1]! &&
      heldBack[1]! > heldBack[2]! &&
      heldBack[2]! > 0 &&
      heldBack[3] === 0,
    `later sources' jobs are held back until their turn: ${heldBack.join(",")}`
  );
  check((await queuedTopicJobs()) === 0, "the last drain left no topic job behind");
  const claimed = await pool.query<{ title: string; claimedAt: Date }>(
    `with recursive up(origin_id, id, parent_id) as (
       select s.id, s.id, s.parent_source_item_id from source_items s
       union all
       select up.origin_id, s.id, s.parent_source_item_id from source_items s join up on s.id = up.parent_id)
     select root.title, r.started_at as "claimedAt"
     from ingestion_runs r
     join up on up.origin_id = r.source_item_id and up.parent_id is null
     join source_items root on root.id = up.id
     where r.started_at is not null order by r.started_at, r.id`
  );
  const order = claimed.rows
    .map((row) => row.title)
    .filter((title, index, titles) => title !== titles[index - 1]);
  check(
    order.join("|") === "Forgetting curve|Replication study|A book|A story",
    `the sources ran in manifest order: ${order.join("|")}`
  );
  // Every source after the first was claimed only after the drain that preceded it ended.
  const drainEnds = barrierEvents.filter((entry) => entry.event === "hold").slice(1);
  const firstClaim = (title: string) =>
    Math.min(
      ...claimed.rows.filter((row) => row.title === title).map((row) => row.claimedAt.getTime())
    );
  check(
    ["Replication study", "A book", "A story"].every(
      (title, index) => firstClaim(title) >= drainEnds[index]!.at - 50
    ),
    "no source started before the previous source was drained"
  );
  const batches = await pool.query<{ n: number }>(
    `select count(distinct batch_id)::int as n from ingestion_runs where job_id is not null`
  );
  check(
    Number(batches.rows[0]?.n) === 1 && !("batchIds" in fullSummary),
    "the paced run is one batch, as the recorded run is"
  );
  const topics = fullSummary.topics as {
    mode: string;
    arrival: string;
    held: boolean;
    boundaries: Array<{ source: string; drainMs: number }>;
    jobs: Array<{ type: string; status: string; count: number }>;
  };
  check(
    topics.mode === "full" && topics.arrival === "per-source" && topics.held === false,
    `the summary records the barrier: ${JSON.stringify(topics)}`
  );
  check(
    topics.boundaries.map((boundary) => boundary.source).join(",") === "web,paper,book,story",
    `one boundary per source, in manifest order: ${JSON.stringify(topics.boundaries)}`
  );
  check(
    topics.jobs.length === 1 &&
      topics.jobs[0]!.type === "topic-place" &&
      topics.jobs[0]!.status === "succeeded" &&
      topics.jobs[0]!.count === 4,
    `the summary counts the topic jobs from the real table: ${JSON.stringify(topics.jobs)}`
  );
  const fullStalled = (fullSummary.failures as { stalledStages: Array<{ stage: string }> })
    .stalledStages;
  check(
    (fullSummary.failures as { runs: number }).runs === 0 &&
      fullStalled.every((item) => item.stage === "sourceMatching") &&
      (fullSummary.sources as unknown[]).length === 4,
    "the paced run ended as the plain run did: no failure, only source matching waits"
  );
  check(await noLegacyContent(), "the barrier run wrote no legacy state");

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
