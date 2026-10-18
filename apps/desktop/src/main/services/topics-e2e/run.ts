// The zero-config end-to-end test (F2 T32, exit criterion E6). One pass makes a fresh scratch
// workspace and an empty PostgreSQL database, starts the product's own services without Electron,
// configures one writer profile plus the default local embedding model the way the first run does,
// imports one paper through the product's IPC handlers with the default plan and waits for the
// light lane. The AI calls run through a cassette (record, or replay with 0 misses), the topic jobs
// are held while the import's heavy work runs (D23) and released when it completes, and no ranker
// exists on purpose (`e2eRanker`: the product's first-run ranker install stays off), so every
// ambiguous note takes the gate's no-decider fallback (owner decision 19). Then E6 is evaluated
// (`assertions.ts`).
//
// Import this module only after `electron` resolves to the stub (`electron-stub.ts`).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiCassette, readAiCassetteLocalMisses, setAiAdapterDecorator } from "@app/ai";
import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";
import type { PgPool } from "@app/db";
import type { TopicsStatus } from "@app/domain";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { registerIpcHandlers } from "../../ipc.js";
import { ipcChannels } from "../../../shared/ipc.js";
import { AiService } from "../ai-service.js";
import { readE2ePinConfig, setExtractionPin } from "../extraction-pin.js";
import { FirstRunRanker, settingsFirstRunRankerStore } from "../first-run-ranker.js";
import { goldenManifestSchema, selectGoldenSources, verifyGoldenFile } from "../golden-runner.js";
import { HierarchicalIngestionService } from "../hierarchical-ingestion-service.js";
import { IngestionService } from "../ingestion-service.js";
import { createJobEmbeddingGenerators } from "../job-embedding.js";
import { JobSupervisor } from "../job-supervisor.js";
import { KnowledgeService } from "../knowledge-service.js";
import { LocalModelService } from "../local-model-service.js";
import { registerPromptIpc } from "../prompt-ipc.js";
import { PromptService } from "../prompt-service.js";
import { SearchService } from "../search-service.js";
import { SettingsService } from "../settings-service.js";
import { SimilarityDebugService } from "../similarity-debug-service.js";
import { seedArticle } from "../topic-tree/corpus-library.js";
import { createTopicTreeServices } from "../topic-tree/index.js";
import type { ClusterTopics } from "../topic-tree/topic-build.js";
import { createStoredVectorSpaceResolver } from "../topic-tree/topic-space.js";
import { evaluateE6, renderE6Markdown } from "./assertions.js";
import type { E6Report, RunFacts } from "./assertions.js";
import {
  UsageError,
  defaultCassetteName,
  defaultEmbeddingCatalogId,
  generationCapabilities,
  recordedRoute,
  routeFileName
} from "./config.js";
import type { E2eConfig, RecordedRoute, RouteSpec } from "./config.js";
import { collectStoreFacts } from "./facts.js";
import type { StoreFacts } from "./facts.js";
import { importPaper, paperFromManifest } from "./import-flow.js";
import { RecordingIpc } from "./ipc-counters.js";
import {
  checkReplayModelPaths,
  readApiKey,
  readRecordedRoute,
  replayRoute,
  resolveRoute,
  seedFirstRun
} from "./route.js";
import type { ElectronStub } from "./electron-stub.js";
import { waitQuiet } from "./wait.js";
import type { WaitStop } from "./wait.js";
import {
  syntheticArticle,
  syntheticCorpus,
  syntheticLanguage,
  syntheticProvider
} from "./synthetic.js";

export interface RunDeps {
  /** The stub `electron` resolves to; the harness picks the import file through its dialog. */
  electron: ElectronStub;
  env: Readonly<Record<string, string | undefined>>;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Polling of the job queues (default 500 ms). */
  pollIntervalMs?: number;
  /** Quiet polls in a row that count as a drained queue (default 6). */
  quietPolls?: number;
  /** How long the import's heavy work may take (default 6 hours). */
  heavyTimeoutMs?: number;
  /** Clusters builds in process (tests); the app's clustering worker otherwise. */
  clusterTopics?: ClusterTopics;
  /** The configuration of the new tree (tests shorten the debounce); the engine's defaults otherwise. */
  newTreeConfig?: () => TopicTreeConfig;
  /** Waits for other local-model work to end (record mode only; tests skip it). */
  waitForLocalModelSlot?: () => Promise<void>;
}

export interface PassResult {
  mode: "record" | "replay";
  report: E6Report;
  store: StoreFacts;
  markdown: string;
  workDir: string;
  kept: boolean;
}

const quietLogger = { info: () => undefined, warn: console.warn, error: console.error };

/** Local inference runs one call at a time per machine: wait until no other local-model job runs. */
export async function waitForLocalModelSlot(): Promise<void> {
  const job = /memora-mlx-helper|node-llama-cpp|scripts\/spikes\/.*(score|embed)/u;
  for (;;) {
    const others = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => job.test(line) && !line.includes("grep"))
      .filter((line) => !line.trim().startsWith(`${process.pid} `));
    if (others.length === 0) return;
    console.info(`Waiting for other local-model jobs:\n  ${others.join("\n  ")}`);
    await new Promise((done) => setTimeout(done, 30_000));
  }
}

/** The whole test: one pass, or (synthetic `both`) a recording and then its replay. */
export async function runTopicsE2e(config: E2eConfig, deps: RunDeps): Promise<PassResult[]> {
  const results: PassResult[] = [];
  const modes: Array<"record" | "replay"> =
    config.mode === "both" ? ["record", "replay"] : [config.mode];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // The synthetic cassette is throwaway and outlives only the two passes; the real one is kept.
  let scratchCassette: string | null = null;
  if (config.synthetic && !config.cassetteDir) {
    await mkdir(config.workDir ?? tmpdir(), { recursive: true });
    scratchCassette = await mkdtemp(
      join(config.workDir ?? tmpdir(), "memora-topics-e2e-cassette-")
    );
  }
  const cassetteDir =
    config.cassetteDir ??
    scratchCassette ??
    join(config.repositoryRoot, ".cache", "topics", "cassettes", defaultCassetteName);
  try {
    for (const mode of modes) {
      const pass = await runPass(config, deps, mode, cassetteDir, stamp);
      results.push(pass);
      // A recording that failed is not replayed.
      if (!pass.report.passed) break;
    }
  } finally {
    if (scratchCassette && !config.keep)
      await rm(scratchCassette, { recursive: true, force: true });
  }
  return results;
}

async function runPass(
  config: E2eConfig,
  deps: RunDeps,
  mode: "record" | "replay",
  cassetteDir: string,
  stamp: string
): Promise<PassResult> {
  const log = deps.log ?? (() => undefined);
  const now = () => new Date();
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  // The scratch workspace is only made once every check that needs no database has passed.
  const workDir = join(config.workDir ?? tmpdir(), `memora-topics-e2e-${randomUUID().slice(0, 8)}`);
  const userData = join(workDir, "userData");
  const modelsDirectory = join(workDir, "models");

  // The route: a recording configures what it was given; a replay rebuilds what was recorded.
  let route: RouteSpec;
  let apiKey: string | null;
  let recorded: RecordedRoute | null = null;
  let locale = config.locale;
  if (mode === "replay") {
    // A replay rebuilds what was recorded, in the content language it was recorded with.
    recorded = await readRecordedRoute(cassetteDir);
    locale = recorded.contentLanguage;
    const source = config.synthetic ? "synthetic" : config.sourceKey;
    if (recorded.source !== source)
      throw new UsageError(
        `The cassette was recorded with source ${recorded.source}, not ${source}: replay it with --source ${recorded.source}`
      );
    // A miss on a local runtime runs live (D41) only on a real model: the paths are checked first.
    if (!config.synthetic)
      checkReplayModelPaths(
        recorded,
        config.replayModelPaths,
        readAiCassetteLocalMisses(deps.env),
        existsSync
      );
  }
  if (config.synthetic) {
    route = syntheticRoute(modelsDirectory);
    apiKey = "synthetic-key";
  } else if (mode === "record") {
    route = await resolveRoute(config);
    apiKey = await readApiKey(route.writer, deps.env);
  } else {
    route = replayRoute(recorded!, modelsDirectory, config.replayModelPaths);
    apiKey = "replay-placeholder-key";
  }
  // The paper, checked before anything is created.
  let paper: ReturnType<typeof paperFromManifest> | null = null;
  if (!config.synthetic) {
    const manifest = selectGoldenSources(
      goldenManifestSchema.parse(JSON.parse(await readFile(config.manifestPath, "utf8"))),
      [config.sourceKey]
    );
    paper = paperFromManifest(manifest, config.sourceKey, config.repositoryRoot);
    const entry = manifest.sources[0];
    if (entry?.kind === "document" && entry.import === "file") {
      const check = await verifyGoldenFile(paper.path, entry);
      if (check.status !== "ok")
        throw new UsageError(
          `The golden source ${paper.key} is ${check.status} at ${paper.path} (run npx tsx scripts/golden/fetch.ts)`
        );
    }
  }

  if (mode === "record" && !config.synthetic)
    await (deps.waitForLocalModelSlot ?? waitForLocalModelSlot)();

  await mkdir(userData, { recursive: true });
  await mkdir(modelsDirectory, { recursive: true });
  // Placeholder model files: a replay loads nothing, but the profile needs an installed path.
  if (mode === "replay" || config.synthetic) {
    for (const path of [
      route.embedding.path,
      route.writer.kind === "local" ? route.writer.path : null
    ]) {
      if (path && !existsSync(path)) await writeFile(path, "");
    }
  }

  const sidecar = resolvePostgresSidecarPaths({ cwd: config.repositoryRoot, env: process.env });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: join(workDir, "database"),
    database: "memora_topics_e2e",
    user: "memora_topics_e2e",
    password: `topics-e2e-${Math.random().toString(36).slice(2)}`,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000
  });
  let pool: PgPool | null = null;
  let jobs: JobSupervisor | null = null;
  let topicServices: ReturnType<typeof createTopicTreeServices> | null = null;
  let ai: AiService | null = null;
  let localModels: LocalModelService | null = null;
  let firstRunRanker: FirstRunRanker | null = null;
  let keep = config.keep;
  const errors: string[] = [];
  try {
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
    const db = pool;
    await runMigrations(db, join(config.repositoryRoot, "packages/db/drizzle"), {
      seedFolder: join(config.repositoryRoot, "packages/db/seed")
    });
    const empty = await db.query<{ n: number }>(
      `select (select count(*) from source_items)::int + (select count(*) from atomic_notes)::int
         + (select count(*) from ai_profile_sets)::int + (select count(*) from ai_provider_configs)::int as n`
    );
    if (Number(empty.rows[0]?.n) !== 0) throw new Error("The scratch database is not empty");

    // MEMORA_GOLDEN_PIN (F3 D5, default `extraction`: the cassette is F2-era) and the local-miss replay
    // policy (D41) are DEV knobs of this runner, as they are of the golden runner.
    const pin = readE2ePinConfig(deps.env);
    setExtractionPin(pin);
    log("pin", { mode: pin.mode });
    const localMisses = readAiCassetteLocalMisses(deps.env);
    const cassette = new AiCassette({
      mode,
      directory: cassetteDir,
      ...(localMisses === "live" ? { localMisses } : {})
    });
    if (mode === "record" && config.maxTokens !== null) cassette.limitLiveTokens(config.maxTokens);
    const syntheticLang = config.synthetic ? syntheticLanguage(locale) : null;
    setAiAdapterDecorator((adapter) =>
      cassette.wrap(
        syntheticLang
          ? syntheticProvider(adapter, { language: syntheticLang, contentLanguage: locale })
          : adapter
      )
    );

    // The product's services, wired as the main process wires them (no Electron window).
    const ipc = new RecordingIpc();
    const settings = new SettingsService(userData, {
      getDatabasePool: () => db,
      requireDatabase: true,
      desktopLocale: locale
    });
    const contentLanguage = (await settings.getApp()).contentLanguage;
    if (recorded && contentLanguage !== recorded.contentLanguage)
      throw new UsageError(
        `The profile starts in ${contentLanguage}, but the cassette was recorded in ${recorded.contentLanguage}`
      );
    const service = new AiService({
      userDataPath: userData,
      getPool: () => db,
      workspaceRoot: config.repositoryRoot,
      resourcesPath: config.repositoryRoot,
      isPackaged: false,
      logger: quietLogger,
      getContentLanguage: async () => (await settings.getApp()).contentLanguage,
      getUiLanguage: async () => (await settings.getApp()).language,
      getKeepLocalEmbeddingModelsLoaded: async () =>
        (await settings.getApp()).keepLocalEmbeddingModelsLoaded,
      // Wired as the product wires it; E6 keeps it off (`e2eRanker`).
      onRoutesSeeded: (tasks) => firstRunRanker?.onRoutesSeeded(tasks)
    });
    ai = service;
    const models = new LocalModelService({
      getPool: () => db,
      userDataPath: userData,
      logger: quietLogger,
      isPackaged: false,
      workspaceRoot: config.repositoryRoot,
      env: {},
      isModelInUse: (id) => service.isLocalModelInUse(id),
      testModel: (id) => service.testLocalModel(id),
      onModelSettled: (catalogId) => void firstRunRanker?.onModelSettled(catalogId)
    });
    localModels = models;
    firstRunRanker = new FirstRunRanker({
      models,
      ai: service,
      store: settingsFirstRunRankerStore(() => db),
      enabled: config.ranker !== "none",
      logger: quietLogger
    });
    const prompts = new PromptService({ getPool: () => db });
    const topics = createTopicTreeServices({
      getPool: () => db,
      spaceResolver: createStoredVectorSpaceResolver(() => db),
      env: {},
      isPackaged: false,
      wake: () => jobs?.wake("light"),
      logger: quietLogger,
      ipc: { main: ipc.main, targets: () => [] },
      ai: service,
      getContentLanguage: async () => (await settings.getApp()).contentLanguage,
      ...(deps.clusterTopics ? { clusterTopics: deps.clusterTopics } : {}),
      ...(deps.newTreeConfig ? { newTreeConfig: deps.newTreeConfig } : {})
    });
    topicServices = topics;
    const hierarchy = new HierarchicalIngestionService({
      getPool: () => db,
      topicHooks: topics.hooks
    });
    const ingestion = new IngestionService({
      getPool: () => db,
      getStorageSettings: () => settings.get(),
      userDataPath: userData,
      resourcesPath: config.repositoryRoot,
      workspaceRoot: config.repositoryRoot,
      isPackaged: false,
      hierarchicalIngestionService: hierarchy,
      fetchExternalPage: async () => new Response("", { status: 500 })
    });
    const knowledge = new KnowledgeService({
      getContentLanguage: async () => (await settings.getApp()).contentLanguage,
      getPool: () => db,
      aiService: service,
      userDataPath: userData,
      getStorageSettings: () => settings.get(),
      getUploadedFilesBasePath: async () => (await settings.get()).uploadCopiesFolderPath,
      isDebugEnabled: async () => (await settings.getApp()).debugMode,
      getRelationThreshold: async () => (await settings.getApp()).atomicNoteRelationThreshold,
      getAtomicNoteMatchingSettings: async () =>
        (await settings.getApp()).atomicNoteMatchingSettings,
      getCanonicalMatchingSettings: async () => (await settings.getApp()).canonicalMatchingSettings,
      getSourceRelationSettings: async () => (await settings.getApp()).sourceRelationSettings,
      getSummaryMinimumWordCount: async () => (await settings.getApp()).summaryMinimumWordCount,
      getEntityIdentitySimilarityThreshold: async () =>
        (await settings.getApp()).entityIdentitySimilarityThreshold,
      getRelationTypeSimilarityThreshold: async () =>
        (await settings.getApp()).relationTypeSimilarityThreshold,
      getKnowledgeGraphLimits: async () => {
        const app = await settings.getApp();
        return {
          maxEntities: app.knowledgeGraphMaxEntitiesPerSource,
          maxRelations: app.knowledgeGraphMaxRelationsPerSource
        };
      },
      logger: quietLogger,
      topicHooks: topics.hooks
    });
    const supervisor = new JobSupervisor({
      getPool: () => db,
      logger: quietLogger,
      knowledgeService: knowledge,
      ...createJobEmbeddingGenerators(service),
      releaseAiRuntime: async () =>
        service.releaseLocalRuntime(
          false,
          (await settings.getApp()).keepLocalEmbeddingModelsLoaded
        ),
      lightJobs: topics.jobs,
      topicHooks: topics.hooks,
      pollIntervalMs: 100
    });
    jobs = supervisor;
    registerIpcHandlers(
      ipc.main,
      settings,
      {
        getStatus: () => ({ state: "ready" }) as never,
        start: async () => ({ state: "ready" }) as never
      },
      ingestion,
      {} as never,
      hierarchy,
      supervisor,
      new SearchService(
        () => db,
        service,
        async () => false
      ),
      service,
      knowledge,
      {} as never,
      models,
      {} as never,
      {} as never,
      new SimilarityDebugService(() => db),
      {} as never
    );
    registerPromptIpc(ipc.main, prompts);

    // The app starts on an empty database: prompts, the topic engine and the job queues.
    await prompts.initialize();
    await topics.start();
    await supervisor.start();

    // 1. First run: the Settings handlers configure the writer and the embedding model.
    ipc.phase("setup");
    const seeded = await seedFirstRun({ ipc, pool: db, route, apiKey });
    // The product's first run would install the ranker now; E6 keeps it off (`e2eRanker`).
    const firstRun = await firstRunRanker.ensure();
    log("seeded", { routes: seeded.routes, firstRunRanker: firstRun });

    // 2. The user: import the paper and wait. No Settings handler may be called from here on.
    ipc.phase("user");
    const stopReason = async (): Promise<WaitStop | null> => {
      const stats = cassette.stats();
      if (stats.mode === "replay" && stats.misses > 0) return "cassette_miss";
      if (
        stats.mode === "record" &&
        config.maxTokens !== null &&
        stats.liveTokens >= config.maxTokens
      )
        return "token_limit";
      return null;
    };
    const timing: RunFacts["timing"] = {
      importStartedAt: now(),
      heavyDoneAt: null,
      drainedAt: null
    };
    let stoppedBy: RunFacts["stoppedBy"] = null;
    let engine: TopicsStatus | null = null;
    topics.holdTopicJobs();
    try {
      timing.importStartedAt = now();
      if (paper) {
        const imported = await importPaper(ipc, (path) => deps.electron.chooseFile(path), paper);
        log("imported", { batch: imported.batchId, divisions: imported.divisions });
      } else {
        await seedArticle(db, syntheticCorpus, syntheticArticle(syntheticLang!));
        supervisor.wake();
      }
      const heavy = await waitQuiet({
        count: async () => (await activeJobs(db, false)) + (await unfinishedRuns(db)),
        stopReason,
        timeoutMs: deps.heavyTimeoutMs ?? 6 * 3_600_000,
        pollIntervalMs: deps.pollIntervalMs ?? 500,
        quietPolls: deps.quietPolls ?? 6,
        sleep
      });
      timing.heavyDoneAt = now();
      if (heavy !== "settled") stoppedBy = heavy === "timeout" ? "drain_timeout" : heavy;
      if (stoppedBy === null) {
        // D23: the topic jobs run once the import's heavy work completed.
        await topics.releaseTopicJobs();
        supervisor.wake("light");
        const lane = await waitQuiet({
          count: async () => activeJobs(db, true),
          stopReason,
          timeoutMs: config.laneTimeoutMs,
          pollIntervalMs: deps.pollIntervalMs ?? 500,
          quietPolls: deps.quietPolls ?? 6,
          sleep
        });
        timing.drainedAt = now();
        if (lane !== "settled") stoppedBy = lane === "timeout" ? "drain_timeout" : lane;
      }
      // What the screens read once the library is organized.
      engine = await ipc.invoke<TopicsStatus>(ipcChannels.topicsStatus);
      await ipc.invoke(ipcChannels.topicsTree, {});
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      stoppedBy = "error";
      log("failed", { error: errors.at(-1) });
    } finally {
      if (stoppedBy !== null) {
        // A stopped run must not let queued topic work reach the provider.
        topics.holdTopicJobs();
      }
    }

    const store = await collectStoreFacts(db);
    const stats = cassette.stats();
    const facts: RunFacts = {
      mode,
      source: config.synthetic ? "synthetic" : config.sourceKey,
      contentLanguage,
      ipc: ipc.summary(),
      settingsCalls: { setup: ipc.calls("setup", "settings"), user: ipc.calls("user", "settings") },
      cassette: {
        mode: stats.mode,
        served: stats.served,
        recorded: stats.recorded,
        misses: stats.misses,
        liveTokens: stats.liveTokens,
        byTask: stats.byTask,
        missDetails: stats.missDetails,
        maxLiveTokens: stats.maxLiveTokens
      },
      routes: seeded.routes,
      timing,
      stoppedBy,
      errors,
      engine,
      recorded: recorded ? recorded.result : null,
      ranker: { setting: config.ranker, firstRun }
    };
    const report = evaluateE6(store, facts);
    const markdown = renderE6Markdown(report, store);
    const directory =
      config.reportDir !== null
        ? config.mode === "both"
          ? join(config.reportDir, mode)
          : config.reportDir
        : join(config.repositoryRoot, ".cache", "topics", "e2e", stamp, mode);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify({ report, store }, null, 2)}\n`
    );
    await writeFile(join(directory, "report.md"), markdown);
    if (mode === "record" && report.passed) {
      const description = recordedRoute(route, {
        contentLanguage,
        source: facts.source,
        notes: store.currentNotes,
        topics: store.topics.length,
        recordedAt: now()
      });
      await mkdir(cassetteDir, { recursive: true });
      await writeFile(
        join(cassetteDir, routeFileName),
        `${JSON.stringify(description, null, 2)}\n`
      );
    }
    if (!report.passed) keep = true;
    log("report", { passed: report.passed, directory });
    return { mode, report, store, markdown, workDir, kept: keep };
  } finally {
    setAiAdapterDecorator(null);
    setExtractionPin(false);
    await jobs?.stop().catch(() => undefined);
    topicServices?.dispose();
    await ai?.dispose().catch(() => undefined);
    await localModels?.shutdown().catch(() => undefined);
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager.stop().catch(() => undefined);
    if (!keep) await rm(workDir, { recursive: true, force: true });
  }
}

/** The route of the synthetic proof: a remote writer that is never called and the embedding model. */
function syntheticRoute(modelsDirectory: string): RouteSpec {
  return {
    writer: {
      kind: "remote",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "synthetic-writer",
      capabilities: [...generationCapabilities],
      apiKeyEnv: "MEMORA_E2E_API_KEY"
    },
    embedding: {
      catalogId: defaultEmbeddingCatalogId,
      path: join(modelsDirectory, "synthetic-embedding.gguf")
    }
  };
}

/** Queued or running jobs: the topic ones (the light lane) or everything else (the heavy work). */
async function activeJobs(pool: PgPool, topic: boolean): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `select count(*)::int as n from jobs
     where status::text in ('queued', 'running') and (type::text like 'topic-%') = $1`,
    [topic]
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Ingestion runs that have not ended: the import's heavy work is over only when none is left. */
async function unfinishedRuns(pool: PgPool): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "select count(*)::int as n from ingestion_runs where status::text in ('pending', 'running')"
  );
  return Number(result.rows[0]?.n ?? 0);
}
