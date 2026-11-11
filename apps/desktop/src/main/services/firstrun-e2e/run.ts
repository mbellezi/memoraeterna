// The first-run Hybrid end-to-end test (F4 T90, exit criterion E6). One pass makes a fresh scratch
// workspace and an empty PostgreSQL database, "launches the app" (the database starts and migrates,
// the product's own services start, with the Gardener's background policy and the event bus wired as
// the app wires them), then plays the onboarding's second step through the product's IPC handlers
// (the writer signs in, the embedder is asked for and waited for, the Hybrid preset is applied, one
// test per class runs), and imports two sources through the Import handlers with the default plan.
// The first-run ranker is on: it installs next to the embedder (downloaded for real in a recording,
// installed from the DEV seed folder in a replay) and the held topic jobs are released only once it
// settled. They are released by policy a2 (`topic-release.ts`): at the first division boundary where
// the first source has enough notes, by a heavy job of the harness's own that drains the light lane
// between two divisions, then once per source. The link jobs run in drain mode (one at a time, the
// heavy lane waiting for them), so every prompt is a function of the arrival order and two replays
// make the same calls. T0 is the instant before the database starts; T1 is the first time a note of
// the first source sits in a named topic with a shown relation; D is the time the recording spent
// waiting for the downloads with nothing else to do (a replay adds the recording's D to its own
// T1 - T0).
//
// Import this module only after `electron` resolves to the stub (`topics-e2e/electron-stub.ts`).
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiCassette, readAiCassetteLocalMisses, setAiAdapterDecorator } from "@app/ai";
import {
  closePgPool,
  createJobRepository,
  createLocalModelRepository,
  createPgPool,
  PostgresSidecarManager,
  aiConfigGeneration,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";
import type { JobRecord, JsonObject, PgPool } from "@app/db";
import { gardenerStatusKinds, type TopicsStatus } from "@app/domain";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { registerIpcHandlers } from "../../ipc.js";
import { ipcChannels } from "../../../shared/ipc.js";
import type { ModelDownloadEvent } from "../../../shared/app-events.js";
import { AiService } from "../ai-service.js";
import { AppEventBus } from "../app-events.js";
import {
  holdCatalogHeaderRefresh,
  readCatalogHeaderFacts,
  type CatalogHeaderFacts
} from "../catalog-header-policy.js";
import { setExtractionPin } from "../extraction-pin.js";
import { FirstRunRanker, settingsFirstRunRankerStore } from "../first-run-ranker.js";
import { createBackgroundPolicy } from "../gardener/background-policy.js";
import type { BackgroundPolicy } from "../gardener/background-policy.js";
import {
  GardenerStatusService,
  distinctHolds,
  gardenerStatusStoreOf
} from "../gardener/status-service.js";
import { goldenManifestSchema, selectGoldenSources, verifyGoldenFile } from "../golden-runner.js";
import { HierarchicalIngestionService } from "../hierarchical-ingestion-service.js";
import { IngestionService } from "../ingestion-service.js";
import { createJobEmbeddingGenerators } from "../job-embedding.js";
import { JobSupervisor } from "../job-supervisor.js";
import { KnowledgeService } from "../knowledge-service.js";
import type { LocalModelService } from "../local-model-service.js";
import { PromptService } from "../prompt-service.js";
import { registerOnboardingIpc } from "../onboarding/onboarding-ipc.js";
import { OnboardingService, pgOnboardingStore } from "../onboarding/onboarding-service.js";
import { registerPromptIpc } from "../prompt-ipc.js";
import {
  goldenLinkRuntime,
  resetRelationLinkRuntime,
  setRelationLinkRuntime
} from "../relations/link-runtime.js";
import { SearchService } from "../search-service.js";
import { SettingsService } from "../settings-service.js";
import { SimilarityDebugService } from "../similarity-debug-service.js";
import { seedArticle } from "../topic-tree/corpus-library.js";
import type { SeededArticle } from "../topic-tree/corpus-library.js";
import { createTopicTreeServices } from "../topic-tree/index.js";
import type { ClusterTopics } from "../topic-tree/topic-build.js";
import { createStoredVectorSpaceResolver } from "../topic-tree/topic-space.js";
import type { ElectronStub } from "../topics-e2e/electron-stub.js";
import { collectStoreFacts } from "../topics-e2e/facts.js";
import type { StoreFacts } from "../topics-e2e/facts.js";
import { importPaper, paperFromManifest } from "../topics-e2e/import-flow.js";
import { waitForLocalModelSlot } from "../topics-e2e/run.js";
import type { WaitStop } from "../topics-e2e/wait.js";
import { evaluateFirstRun, renderFirstRunMarkdown } from "./assertions.js";
import type { ClockFacts, FirstRunFacts, FirstRunReport } from "./assertions.js";
import { UsageError, firstRunCassetteName, recordedWriter, replayWriter } from "./config.js";
import type { FirstRunConfig, RecordedFirstRun, WriterRoute } from "./config.js";
import {
  activeJobs,
  readBlockedJobs,
  readBoundary,
  readFirstRunRanker,
  readFirstSourceConnection,
  readHybridRoutes,
  readModelFacts,
  heldGardenerTasks,
  readPipelineBusy,
  readRelationFacts,
  readSourceFacts,
  unfinishedRuns
} from "./facts.js";
import type { FirstSourceConnection } from "./facts.js";
import { recordedHardwareProfile } from "./hardware.js";
import {
  assertModelsSeeded,
  copyModelsToSeed,
  createFirstRunModels,
  firstRunModelPlan,
  pinnedBytes
} from "./models.js";
import type { ModelsMode } from "./models.js";
import {
  checkRecordMatches,
  placeholderCodexCredential,
  readApiKey,
  readCodexCredential,
  readRecordedFirstRun,
  writeRecordedFirstRun
} from "./route.js";
import { invokedSetupChannels } from "./sequence.js";
import { SequencedIpc } from "./sequenced-ipc.js";
import { SetupError, runHybridSetup } from "./setup.js";
import type { SetupFacts } from "./setup.js";
import {
  hybridSyntheticProvider,
  seedSyntheticRelation,
  syntheticArticle,
  syntheticCorpus,
  syntheticLanguage,
  syntheticSecondArticle,
  writeSyntheticHelper
} from "./synthetic.js";
import {
  TopicReleasePlan,
  harnessLinkRuntime,
  topicReleaseJob,
  topicReleasePriority
} from "./topic-release.js";
import type { ReleaseSource, TopicRelease } from "./topic-release.js";
import { waitQuiet } from "./wait.js";
import type { WaitOutcome } from "./wait.js";
import {
  Busy,
  DownloadTrace,
  Marks,
  criticalPathDownload,
  startSampler,
  statusAtStalls
} from "./timeline.js";
import type { RunPhase, StatusReading } from "./timeline.js";

export interface RunDeps {
  /** The stub `electron` resolves to; the harness picks the import file through its dialog. */
  electron: ElectronStub;
  env: Readonly<Record<string, string | undefined>>;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Polling of the job queues and the models (default 500 ms). */
  pollIntervalMs?: number;
  /** Quiet polls in a row that count as a drained queue (default 6). */
  quietPolls?: number;
  /** How long the imports' heavy work may take (default 6 hours). */
  heavyTimeoutMs?: number;
  /** Clusters builds in process (tests); the app's clustering worker otherwise. */
  clusterTopics?: ClusterTopics;
  /** The configuration of the new tree (tests shorten the debounce); the engine's defaults otherwise. */
  newTreeConfig?: () => TopicTreeConfig;
  /** Waits for other local-model work to end (record mode only; tests skip it). */
  waitForLocalModelSlot?: () => Promise<void>;
  /** The self-test's simulated install takes this long (default 300 ms). */
  syntheticInstallMs?: number;
  /**
   * The Gardener's status, read while a download holds everything up: the run proves the status says
   * why. The product's own `GardenerStatusService` (T86) over the pass's services when left out.
   */
  status?: { snapshot(): Promise<StatusReading> };
  now?: () => Date;
}

export interface PassResult {
  mode: "record" | "replay";
  /** 1-based position among the passes of this mode. */
  index: number;
  report: FirstRunReport;
  store: StoreFacts;
  markdown: string;
  workDir: string;
  kept: boolean;
  /** The catalog-header refresh is off in a measurement run (T53h): the policy and the jobs it saw. */
  catalogHeaders: CatalogHeaderFacts;
  /** What a recording keeps next to its cassette; null for a replay. */
  record: RecordedFirstRun | null;
}

/** The first-run ranker starts with the embedding route; a state still missing after this is a defect. */
const rankerStartGraceMs = 30_000;

const quietLogger = { info: () => undefined, warn: console.warn, error: console.error };

/** The whole test: one pass, or a recording and then its replays (the self-test), or n replays. */
export async function runFirstRunE2e(config: FirstRunConfig, deps: RunDeps): Promise<PassResult[]> {
  const results: PassResult[] = [];
  const passes: Array<{ mode: "record" | "replay"; index: number }> = [];
  if (config.mode !== "replay") passes.push({ mode: "record", index: 1 });
  if (config.mode !== "record")
    for (let index = 1; index <= config.replays; index += 1) passes.push({ mode: "replay", index });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // The synthetic cassette is throwaway and outlives only the passes; the real one is kept.
  let scratchCassette: string | null = null;
  if (config.synthetic && !config.cassetteDir) {
    await mkdir(config.workDir ?? tmpdir(), { recursive: true });
    scratchCassette = await mkdtemp(
      join(config.workDir ?? tmpdir(), "memora-firstrun-e2e-cassette-")
    );
  }
  const cassetteDir =
    config.cassetteDir ??
    scratchCassette ??
    join(config.repositoryRoot, ".cache", "topics", "cassettes", firstRunCassetteName);
  try {
    for (const pass of passes) {
      const result = await runPass(config, deps, pass, cassetteDir, stamp);
      results.push(result);
      // A recording that failed is not replayed.
      if (pass.mode === "record" && !result.report.passed) break;
    }
  } finally {
    if (scratchCassette && !config.keep)
      await removeScratch(scratchCassette, deps.log ?? (() => undefined));
  }
  return results;
}

/**
 * Starts the throwaway database. A start on a loaded machine can run past the sidecar's own command
 * bound (creating the database takes a few seconds when other work holds the CPU): it is stopped and
 * tried once more, before anything is measured against it. A second failure is the run's.
 */
async function startDatabase(
  manager: PostgresSidecarManager,
  log: (event: string, data?: Record<string, unknown>) => void
) {
  try {
    return await manager.start();
  } catch (error) {
    log("database_retry", {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error)
    });
    await manager.stop().catch(() => undefined);
    await new Promise<void>((done) => setTimeout(done, 2000));
    return manager.start();
  }
}

/**
 * Removes the scratch workspace. A machine that is indexing or scanning what the run just wrote can
 * hold a directory for a moment, so the removal retries; one that still fails is told, never thrown:
 * the verdict of the run does not depend on the clean-up.
 */
export async function removeScratch(
  path: string,
  log: (event: string, data?: Record<string, unknown>) => void
): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    log("scratch_not_removed", {
      path,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error)
    });
  }
}

/** Whether the replays of one invocation made the same library (two replays of one recording must). */
export function replaysAgree(results: readonly PassResult[]): boolean {
  const digests = new Set(
    results
      .filter((result) => result.mode === "replay")
      .map((result) => result.store.endState.digest)
  );
  return digests.size <= 1;
}

async function runPass(
  config: FirstRunConfig,
  deps: RunDeps,
  pass: { mode: "record" | "replay"; index: number },
  cassetteDir: string,
  stamp: string
): Promise<PassResult> {
  const { mode } = pass;
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const pollMs = deps.pollIntervalMs ?? 500;
  const plan = firstRunModelPlan();
  const modelsMode: ModelsMode = config.synthetic
    ? "synthetic"
    : mode === "record"
      ? "download"
      : "seed";

  // Everything that needs no database is checked before anything is created.
  let recorded: RecordedFirstRun | null = null;
  let locale = config.locale;
  let writer: WriterRoute;
  let codexCredential: Awaited<ReturnType<typeof readCodexCredential>> | null = null;
  let apiKey: string | null = null;
  if (mode === "replay") {
    recorded = await readRecordedFirstRun(cassetteDir);
    checkRecordMatches(recorded, config, plan);
    locale = recorded.contentLanguage;
    writer = replayWriter(recorded.writer);
    if (writer.kind === "codex") codexCredential = placeholderCodexCredential(now().getTime());
    else apiKey = "replay-placeholder-key";
    if (!config.synthetic) {
      if (!config.seedDir) throw new UsageError("A replay needs the seed folder of the models");
      await assertModelsSeeded(plan, config.seedDir);
    }
  } else if (config.synthetic) {
    writer = { kind: "codex", modelId: "synthetic-codex", credentialFile: "synthetic" };
    codexCredential = placeholderCodexCredential(now().getTime());
  } else {
    if (!config.writer) throw new UsageError("A recording needs a writer");
    writer = config.writer;
    if (writer.kind === "codex")
      codexCredential = await readCodexCredential(writer, now().getTime());
    else apiKey = await readApiKey(writer, deps.env);
  }
  let papers: {
    first: ReturnType<typeof paperFromManifest>;
    second: ReturnType<typeof paperFromManifest>;
  } | null = null;
  if (!config.synthetic) {
    const manifest = selectGoldenSources(
      goldenManifestSchema.parse(JSON.parse(await readFile(config.manifestPath, "utf8"))),
      [config.sources.first, config.sources.second]
    );
    const resolved = [config.sources.first, config.sources.second].map((key) => {
      const paper = paperFromManifest(manifest, key, config.repositoryRoot);
      return { paper, entry: manifest.sources.find((source) => source.key === key) };
    });
    for (const { paper, entry } of resolved) {
      if (entry?.kind === "document" && entry.import === "file") {
        const check = await verifyGoldenFile(paper.path, entry);
        if (check.status !== "ok")
          throw new UsageError(
            `The golden source ${paper.key} is ${check.status} at ${paper.path} (run npx tsx scripts/golden/fetch.ts)`
          );
      }
    }
    papers = { first: resolved[0]!.paper, second: resolved[1]!.paper };
    if (plan.rankerRuntime === "mlx") {
      const helper = join(
        config.repositoryRoot,
        "native",
        "mlx-helper",
        ".build",
        "release",
        "memora-mlx-helper"
      );
      if (!existsSync(helper))
        throw new UsageError(
          `The MLX helper is not built at ${helper}: the ranker's validation needs it (npm run mlx:build)`
        );
    }
  }
  // A served call answers at once, so a take resumed from an earlier cassette has no live clock.
  let resumed = false;
  if (mode === "record") {
    resumed = (await readdir(join(cassetteDir, "entries")).catch(() => [])).length > 0;
    if (resumed && !config.resume)
      throw new UsageError(
        `${cassetteDir} already holds recorded calls: a live clock needs an empty cassette (delete it, ` +
          "or pass --resume to continue that take, whose clock cannot gate a replay)"
      );
  }
  if (mode === "record" && !config.synthetic)
    await (deps.waitForLocalModelSlot ?? waitForLocalModelSlot)();

  const workDir = join(
    config.workDir ?? tmpdir(),
    `memora-firstrun-e2e-${randomUUID().slice(0, 8)}`
  );
  const userData = join(workDir, "userData");
  await mkdir(userData, { recursive: true });
  // The AI service finds the MLX helper under its workspace root: the self-test gives it a stand-in file.
  const aiRoot = config.synthetic ? join(workDir, "workspace") : config.repositoryRoot;
  const helperPath = config.synthetic ? await writeSyntheticHelper(aiRoot) : "";

  const sidecar = resolvePostgresSidecarPaths({ cwd: config.repositoryRoot, env: process.env });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: join(workDir, "database"),
    database: "memora_firstrun_e2e",
    user: "memora_firstrun_e2e",
    password: `firstrun-e2e-${Math.random().toString(36).slice(2)}`,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000
  });
  let pool: PgPool | null = null;
  let jobs: JobSupervisor | null = null;
  let topicServices: ReturnType<typeof createTopicTreeServices> | null = null;
  let ai: AiService | null = null;
  let models: LocalModelService | null = null;
  let policy: BackgroundPolicy | null = null;
  let bus: AppEventBus | null = null;
  let gardenerStatus: GardenerStatusService | null = null;
  let firstRunRanker: FirstRunRanker | null = null;
  let sampler: ReturnType<typeof startSampler> | null = null;
  let keep = config.keep;
  const errors: string[] = [];
  // T0: the app launch. Everything below it, up to the last service started, is the launch.
  const t0 = now();
  const marks = new Marks(t0, now, (name, ms) => log("mark", { name, atMs: ms }));
  const trace = new DownloadTrace(marks);
  const busy = new Busy();
  let phase: RunPhase = "launch";
  try {
    const connection = await startDatabase(manager, log);
    pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
    const db = pool;
    marks.mark("launch.database");
    await runMigrations(db, join(config.repositoryRoot, "packages/db/drizzle"), {
      seedFolder: join(config.repositoryRoot, "packages/db/seed")
    });
    marks.mark("launch.migrations");
    const empty = await db.query<{ n: number }>(
      `select (select count(*) from source_items)::int + (select count(*) from atomic_notes)::int
         + (select count(*) from ai_profile_sets)::int + (select count(*) from ai_provider_configs)::int as n`
    );
    if (Number(empty.rows[0]?.n) !== 0) throw new Error("The scratch database is not empty");

    // A measurement run never refreshes catalog headers (T53h) and runs the product's extraction path.
    holdCatalogHeaderRefresh("topics_e2e");
    setExtractionPin(false);
    // Link jobs drain one at a time in admission order and the heavy lane waits for them (D24, 5.6):
    // the next division's import can no longer win the root's scope from a link job and make it
    // type two divisions' pairs together, so the record and its replays make the same calls.
    setRelationLinkRuntime(goldenLinkRuntime("live"));
    log("relations", { linkRuntime: harnessLinkRuntime });
    const localMisses = readAiCassetteLocalMisses(deps.env);
    const cassette = new AiCassette({
      mode,
      directory: cassetteDir,
      ...(localMisses === "live" && mode === "replay" ? { localMisses } : {}),
      ...(mode === "replay" && config.timing === "recorded" ? { timing: "recorded" as const } : {})
    });
    if (mode === "record" && config.maxTokens !== null) cassette.limitLiveTokens(config.maxTokens);
    const syntheticLang = config.synthetic ? syntheticLanguage(locale) : null;
    setAiAdapterDecorator((adapter) =>
      cassette.wrap(
        syntheticLang
          ? hybridSyntheticProvider(adapter, { language: syntheticLang, contentLanguage: locale })
          : adapter
      )
    );

    // The product's services, wired as the main process wires them for a first run (no Electron window).
    const ipc = new SequencedIpc();
    const settings = new SettingsService(userData, {
      getDatabasePool: () => db,
      requireDatabase: true,
      desktopLocale: locale
    });
    const app = await settings.getApp();
    const contentLanguage = app.contentLanguage;
    if (recorded && contentLanguage !== recorded.contentLanguage)
      throw new UsageError(
        `The profile starts in ${contentLanguage}, but the cassette was recorded in ${recorded.contentLanguage}`
      );
    bus = new AppEventBus({
      send: () => undefined,
      onInvalid: (error) => errors.push(error.message),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error))
    });
    const downloadEvents: Record<string, { delivered: number; last: string | null }> = {};
    const lastDownloadLog = new Map<string, { status: string; at: number }>();
    bus.subscribe("model.download", (event) => {
      const entry = downloadEvents[event.catalogId] ?? { delivered: 0, last: null };
      entry.delivered += 1;
      entry.last = event.status;
      downloadEvents[event.catalogId] = entry;
    });
    // The Gardener's background policy, as the app wires it: tasks wait for their blocker (a model
    // that is not there yet) and resume when it settles. No power source, no budget gate.
    policy = createBackgroundPolicy({
      getPool: () => db,
      powerSource: null,
      isPackaged: false,
      env: {},
      wake: () => jobs?.wake("light"),
      refreshLanes: () => ai?.refreshLanes(),
      routesGeneration: aiConfigGeneration,
      logger: quietLogger
    });
    const service = new AiService({
      userDataPath: userData,
      getPool: () => db,
      workspaceRoot: aiRoot,
      resourcesPath: config.repositoryRoot,
      isPackaged: false,
      logger: quietLogger,
      getContentLanguage: async () => (await settings.getApp()).contentLanguage,
      getUiLanguage: async () => (await settings.getApp()).language,
      getKeepLocalEmbeddingModelsLoaded: async () =>
        (await settings.getApp()).keepLocalEmbeddingModelsLoaded,
      // Owner decision 19: the library's first embedding route installs the local ranker.
      onRoutesSeeded: (tasks) => firstRunRanker?.onRoutesSeeded(tasks),
      cassetteMode: mode,
      backgroundAdmission: policy.admission
    });
    ai = service;
    const localModels = createFirstRunModels({
      mode: modelsMode,
      repositoryRoot: config.repositoryRoot,
      seedDir: config.seedDir,
      ...(config.synthetic
        ? {
            synthetic: {
              modelsDirectory: join(workDir, "models"),
              installDelayMs: deps.syntheticInstallMs ?? 300,
              helperPath
            }
          }
        : {}),
      getPool: () => db,
      userDataPath: userData,
      logger: quietLogger,
      isModelInUse: (id) => service.isLocalModelInUse(id),
      testModel: (id) => service.testLocalModel(id),
      onModelSettled: (catalogId) => {
        void firstRunRanker?.onModelSettled(catalogId);
        // Tasks waiting for a model download or verification may run now (F4 D7).
        void policy?.blockers.notify("download_settled");
      },
      onDownload: (event: ModelDownloadEvent) => {
        trace.record(event, now());
        bus?.publish(event);
        // A long download is watched: one line on every change of state, then every 15 seconds.
        const last = lastDownloadLog.get(event.catalogId);
        if (!last || last.status !== event.status || Date.now() - last.at >= 15_000) {
          lastDownloadLog.set(event.catalogId, { status: event.status, at: Date.now() });
          log("download", {
            catalogId: event.catalogId,
            status: event.status,
            downloadedBytes: event.downloadedBytes,
            totalBytes: event.totalBytes,
            bytesPerSecond: event.bytesPerSecond
          });
        }
      }
    });
    models = localModels;
    firstRunRanker = new FirstRunRanker({
      models: localModels,
      ai: service,
      store: settingsFirstRunRankerStore(() => db),
      enabled: true,
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
        const current = await settings.getApp();
        return {
          maxEntities: current.knowledgeGraphMaxEntitiesPerSource,
          maxRelations: current.knowledgeGraphMaxRelationsPerSource
        };
      },
      logger: quietLogger,
      topicHooks: topics.hooks
    });
    // The a2 release (E6A2): the end of each heavy job of a source is a division boundary (an
    // import's division; the self-test's seeded notes' embeddings stand in for divisions), read
    // before the supervisor claims its next job. The boundary hook and the release job's body are
    // bound below, once the pass's waits exist; until then a boundary decides nothing.
    const boundaryJob = config.synthetic ? "note-embedding" : "ingestion";
    const release: {
      atBoundary: (sourceItemId: string) => Promise<void>;
      run: (job: JobRecord, signal: AbortSignal) => Promise<JsonObject>;
    } = {
      atBoundary: async () => undefined,
      run: async () => ({ released: false })
    };
    const supervisor = new JobSupervisor({
      // The hook runs once the job's work returned and before its row is finished, so it holds no
      // scope: it only reads and, at most, queues the release job.
      traceOperation: async <T>(
        operation: string,
        context: Record<string, unknown>,
        run: () => Promise<T>
      ): Promise<T> => {
        const result = await run();
        if (
          operation === boundaryJob &&
          context.origin === "job" &&
          typeof context.sourceItemId === "string"
        )
          await release.atBoundary(context.sourceItemId);
        return result;
      },
      devHeavyJobs: {
        [topicReleaseJob]: { execute: (job, signal) => release.run(job, signal) }
      },
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
      backgroundPolicy: policy.jobs,
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
      localModels,
      {} as never,
      {} as never,
      new SimilarityDebugService(() => db),
      {} as never
    );
    registerPromptIpc(ipc.main, prompts);
    // The first-run view's two reads (F4 D31): the stored state on the empty database, for real, and a
    // recorded profile of this computer for the tier card.
    registerOnboardingIpc(ipc.main, new OnboardingService({ store: pgOnboardingStore(() => db) }));
    ipc.main.handle(ipcChannels.hardwareProfile, async () => recordedHardwareProfile);

    // The Gardener's status as the app composes it (F4 D27, T86): gates, tasks, lanes, downloads.
    const backgroundPolicy = policy;
    const eventBus = bus;
    gardenerStatus = new GardenerStatusService({
      store: () => gardenerStatusStoreOf(db),
      gateHolds: () => distinctHolds(backgroundPolicy.gate.forKinds(gardenerStatusKinds)),
      // No RemoteBudget runs here: the first run meters no money.
      budget: async () => null,
      lanes: () => service.laneSnapshots(),
      models: async () => localModels.listStatuses(),
      publish: (event) => eventBus.publish(event),
      events: eventBus,
      signals: [
        (listener) => backgroundPolicy.controls.subscribe(() => listener()),
        (listener) => backgroundPolicy.power.subscribe(() => listener())
      ],
      logger: quietLogger
    });
    const productStatus = gardenerStatus;
    const status: { snapshot(): Promise<StatusReading> } = deps.status ?? {
      snapshot: async () => {
        const snapshot = await productStatus.snapshot();
        return {
          state: snapshot.state,
          ...(snapshot.class ? { class: snapshot.class, reason: snapshot.reason } : {})
        };
      }
    };

    // The app starts on an empty database: prompts, the policy, the topic engine, the local models
    // (a first-run ranker an earlier start left is finished), and the job queues.
    await prompts.initialize();
    policy.start();
    gardenerStatus.start();
    await topics.start();
    await Promise.all([
      localModels.start().then(() => firstRunRanker?.ensure()),
      supervisor.start()
    ]);
    marks.mark("launch.services");
    const appLaunchMs = marks.get("launch.services")!;

    // Whether anything could progress, and whether a model is on its way: D reads these.
    sampler = startSampler({
      intervalMs: pollMs,
      marks,
      phase: () => phase,
      read: async () => {
        const downloading = trace.downloading();
        // A release job waiting for the ranker is the person waiting for the download, so it is
        // on D's clock; its drain is the topic jobs' work, which counts by itself.
        const idle = !busy.active && !(await readPipelineBusy(db, [topicReleaseJob]));
        // The status is read only where it matters: a download holds everything up. The Gardener's
        // tasks that wait then tell whether its sentence must name a class.
        const reading =
          downloading && idle
            ? await Promise.all([
                status.snapshot(),
                heldGardenerTasks(db, gardenerStatusKinds)
              ]).catch(() => undefined)
            : undefined;
        return {
          downloading,
          busy: !idle,
          ...(reading ? { status: { ...reading[0], held: reading[1] } } : {})
        };
      }
    });

    type Stop = WaitStop | "model_failed";
    const stopReason = async (): Promise<Stop | null> => {
      const stats = cassette.stats();
      if (stats.mode === "replay" && stats.misses > 0) return "cassette_miss";
      if (
        stats.mode === "record" &&
        config.maxTokens !== null &&
        stats.liveTokens >= config.maxTokens
      )
        return "token_limit";
      if (trace.all().some((install) => install.failedAtMs !== null)) return "model_failed";
      return null;
    };

    const waitForModel = async (catalogId: string): Promise<void> => {
      const deadline = Date.now() + config.downloadTimeoutMs;
      const repository = createLocalModelRepository(db);
      for (;;) {
        const model = (await repository.listModels()).find(
          (entry) => entry.catalogId === catalogId
        );
        if (model?.status === "ready") return;
        if (model?.status === "failed")
          throw new Error(`${catalogId} could not be installed: ${model.lastError ?? "failed"}`);
        if (Date.now() >= deadline)
          throw new Error(
            `${catalogId} was not installed within ${Math.round(config.downloadTimeoutMs / 60_000)} minutes`
          );
        await sleep(pollMs);
      }
    };
    /**
     * The first-run ranker is done: validated and routed, or it failed or was skipped. It starts when
     * the preset gave the library its embedding route, so a state that never appears is a defect of
     * the setup, not a download to wait for.
     */
    const waitForRanker = async (): Promise<"ready" | "failed" | "skipped"> => {
      const started = Date.now();
      const deadline = started + config.downloadTimeoutMs;
      for (;;) {
        const state = await readFirstRunRanker(db);
        if (state && state.state !== "requested") return state.state;
        if (!state && Date.now() - started > rankerStartGraceMs) {
          errors.push("The first-run ranker never started: the embedding route did not trigger it");
          return "failed";
        }
        if (Date.now() >= deadline)
          throw new Error(
            `The first-run ranker was not ready within ${Math.round(config.downloadTimeoutMs / 60_000)} minutes`
          );
        await sleep(pollMs);
      }
    };

    // What the run learns, in one place the closures below can write.
    const outcome: {
      stoppedBy: FirstRunFacts["stoppedBy"];
      setup: SetupFacts | null;
      engine: TopicsStatus | null;
      connection: FirstSourceConnection | null;
      firstRootId: string | null;
      secondRootId: string | null;
      stood: string[];
    } = {
      stoppedBy: null,
      setup: null,
      engine: null,
      connection: null,
      firstRootId: null,
      secondRootId: null,
      stood: []
    };

    // 1. First run: the second step of the onboarding, through the product's handlers.
    phase = "setup";
    ipc.phase("setup");
    try {
      outcome.setup = await runHybridSetup({
        ipc,
        service,
        writer,
        codexCredential,
        apiKey,
        languages: { language: app.language, contentLanguage },
        embedderCatalogId: plan.embedding,
        waitForModel,
        busy,
        marks,
        log
      });
      log("setup", { tests: outcome.setup.tests.map((test) => `${test.route} ${test.state}`) });
    } catch (error) {
      outcome.stoppedBy =
        error instanceof SetupError && error.step === "models" ? "model_failed" : "setup_failed";
      errors.push(error instanceof Error ? error.message : String(error));
      log("failed", { step: "setup", error: errors.at(-1) });
    }

    // T1: the first time a note of the first source sits in a named topic with a shown relation.
    const observeT1 = async (): Promise<void> => {
      if (outcome.connection || !outcome.firstRootId) return;
      const found = await readFirstSourceConnection(db, outcome.firstRootId);
      if (found) {
        outcome.connection = found;
        marks.mark("t1");
      }
    };
    /**
     * The imports' heavy work: no job running or due (a release job included), no ingestion run
     * unfinished. A stop a release met ends the wait too (`stopped`: the release recorded why).
     */
    const heavy = () =>
      waitQuiet<Stop | "stopped">({
        count: async () => {
          await observeT1();
          return (await activeJobs(db, false)) + (await unfinishedRuns(db));
        },
        stopReason: async () => (outcome.stoppedBy !== null ? "stopped" : stopReason()),
        timeoutMs: deps.heavyTimeoutMs ?? 6 * 3_600_000,
        pollIntervalMs: pollMs,
        quietPolls: deps.quietPolls ?? 6,
        sleep
      });
    const stopOf = (reason: Exclude<WaitOutcome<Stop>, "settled">) =>
      reason === "timeout" ? ("drain_timeout" as const) : reason;

    // The topic releases (a2, E6A2). Each waits for the ranker first (the relations and the gate
    // need it; a recording may still be downloading it while a replay seeds it in seconds, and the
    // two must not order the work differently), lets the held topic jobs run, waits for the light
    // lane to drain and, unless it is the last, holds them again.
    const releasePlan = new TopicReleasePlan(config.topicRelease);
    const releases: TopicRelease[] = [];
    const releaseTopics = async (
      entry: TopicRelease,
      options: { hold: boolean; signal?: AbortSignal }
    ): Promise<WaitOutcome<Stop | "aborted">> => {
      const ranker = await waitForRanker();
      if (ranker !== "ready") {
        entry.outcome = `the first-run ranker ended ${ranker}`;
        return "model_failed";
      }
      entry.releasedAtMs = marks.mark(`topics.release.${releases.indexOf(entry) + 1}`);
      try {
        await topics.releaseTopicJobs();
        supervisor.wake("light");
        const lane = await waitQuiet<Stop | "aborted">({
          count: async () => {
            await observeT1();
            return activeJobs(db, true);
          },
          stopReason: async () => (options.signal?.aborted ? "aborted" : stopReason()),
          timeoutMs: config.laneTimeoutMs,
          pollIntervalMs: pollMs,
          quietPolls: deps.quietPolls ?? 6,
          sleep
        });
        entry.drainedAtMs = marks.since();
        entry.outcome = lane === "settled" ? "drained" : lane;
        log("topics_released", { ...entry });
        return lane;
      } finally {
        if (options.hold) topics.holdTopicJobs();
      }
    };
    /** Records why a release ended early, unless the run already stopped for another reason. */
    const releaseStopped = (lane: Exclude<WaitOutcome<Stop | "aborted">, "settled">) => {
      if (outcome.stoppedBy === null)
        outcome.stoppedBy = lane === "aborted" ? "error" : stopOf(lane);
    };
    // A boundary: the policy reads the source's notes and whether T1 stands, and may queue a
    // release job, which the heavy lane claims after the boundary's link jobs (drain mode).
    release.atBoundary = async (sourceItemId) => {
      try {
        if (outcome.stoppedBy !== null) return;
        const reading = await readBoundary(
          db,
          sourceItemId,
          config.synthetic ? "embedded" : "current"
        );
        if (!reading) return;
        const source: ReleaseSource =
          outcome.firstRootId === null || reading.rootId === outcome.firstRootId
            ? "first"
            : "second";
        await observeT1();
        const decision = releasePlan.boundary({
          source,
          notes: reading.notes,
          t1Seen: outcome.connection !== null
        });
        log("boundary", { source, ...decision, notes: reading.notes });
        if (!decision.release) return;
        await createJobRepository(db).create({
          type: topicReleaseJob,
          lane: "heavy",
          priority: topicReleasePriority,
          maxAttempts: 1,
          payload: { source, division: decision.division, notes: reading.notes }
        });
      } catch (error) {
        errors.push(
          `A topic release boundary could not be read: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
    release.run = async (job, signal) => {
      const entry: TopicRelease = {
        at: "division",
        source: job.payload.source === "second" ? "second" : "first",
        division: typeof job.payload.division === "number" ? job.payload.division : null,
        notes: typeof job.payload.notes === "number" ? job.payload.notes : 0,
        releasedAtMs: null,
        drainedAtMs: null,
        outcome: "the run had stopped"
      };
      releases.push(entry);
      if (outcome.stoppedBy !== null) return { released: false };
      try {
        const lane = await releaseTopics(entry, { hold: true, signal });
        if (lane !== "settled") releaseStopped(lane);
      } catch (error) {
        errors.push(
          `A topic release failed: ${error instanceof Error ? error.message : String(error)}`
        );
        if (outcome.stoppedBy === null) outcome.stoppedBy = "error";
      }
      return { released: entry.releasedAtMs !== null, outcome: entry.outcome };
    };

    if (outcome.stoppedBy === null) {
      // 2. The user: drop two sources. No Settings handler may be called from here on.
      phase = "user";
      ipc.phase("user");
      topics.holdTopicJobs();
      const seededArticles: Partial<Record<"first" | "second", SeededArticle>> = {};
      try {
        const importSource = async (which: "first" | "second"): Promise<string> => {
          marks.mark(`import.${which}.started`);
          let rootId: string;
          if (papers) {
            const paper = papers[which];
            const imported = await busy.during(() =>
              importPaper(ipc, (path) => deps.electron.chooseFile(path), paper)
            );
            log("imported", {
              source: paper.key,
              batch: imported.batchId,
              divisions: imported.divisions
            });
            rootId = imported.sourceItemId;
          } else {
            const article =
              which === "first"
                ? syntheticArticle(syntheticLang!)
                : syntheticSecondArticle(syntheticLang!);
            const seeded = await busy.during(() => seedArticle(db, syntheticCorpus, article));
            supervisor.wake();
            rootId = seeded.rootSourceId;
            seededArticles[which] = seeded;
          }
          marks.mark(`import.${which}.queued`);
          return rootId;
        };
        /**
         * A source is settled when the ranker is ready and the heavy work is done. The relations need
         * the ranker, so the next step waits for it: the download the person would be waiting for,
         * which is on the clock. Waiting for the ranker first costs nothing once it is ready, and the
         * heavy work then sees every task its arrival released.
         */
        const settle = async (what: string): Promise<boolean> => {
          const ranker = await waitForRanker();
          if (ranker !== "ready") {
            outcome.stoppedBy = "model_failed";
            errors.push(`The first-run ranker ended ${ranker}`);
            return false;
          }
          const done = await heavy();
          if (done !== "settled") {
            if (done !== "stopped") outcome.stoppedBy = stopOf(done);
            return false;
          }
          // A release job that ran during the heavy work may have stopped the run.
          if (outcome.stoppedBy !== null) return false;
          marks.mark(`heavy.${what}`);
          return true;
        };
        /** The release after a source's heavy work (a2's per-source part). */
        const releaseSource = async (source: ReleaseSource, hold: boolean): Promise<boolean> => {
          const rootId = source === "first" ? outcome.firstRootId : outcome.secondRootId;
          const entry: TopicRelease = {
            at: "source",
            source,
            division: null,
            notes: rootId ? ((await readSourceFacts(db, [rootId]))[0]?.notes ?? 0) : 0,
            releasedAtMs: null,
            drainedAtMs: null,
            outcome: "not run"
          };
          releases.push(entry);
          releasePlan.sourceReleased();
          const lane = await releaseTopics(entry, { hold });
          if (lane === "settled") return true;
          releaseStopped(lane);
          return false;
        };

        outcome.firstRootId = await importSource("first");
        if ((await settle("first")) && (await releaseSource("first", true))) {
          outcome.secondRootId = await importSource("second");
          if (await settle("second")) {
            if (config.synthetic) {
              await seedSyntheticRelation(db, seededArticles.first!, seededArticles.second!);
              outcome.stood.push(
                "the two papers are seeded, not imported",
                "one relation between them is seeded, not matched",
                "the division boundaries are the seeded notes' embedding jobs (a2 counts embedded notes)"
              );
              supervisor.wake();
            }
            // The last release: the topic jobs run to the end, as nothing holds them any more.
            phase = "drain";
            await releaseSource("second", false);
            marks.mark("drained");
          }
        }
        if (outcome.stoppedBy === null) await observeT1();
        // What the screens read once the library is organized.
        outcome.engine = await ipc.invoke<TopicsStatus>(ipcChannels.topicsStatus);
        await ipc.invoke(ipcChannels.topicsTree, {});
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        outcome.stoppedBy = "error";
        log("failed", { step: "user", error: errors.at(-1) });
      }
    }
    // A stopped run must not let queued topic work reach the provider.
    if (outcome.stoppedBy !== null) topics.holdTopicJobs();

    const endMs = marks.since();
    const samples = await sampler.stop();
    sampler = null;
    bus.flush();
    const t1Ms = marks.get("t1");
    const download = criticalPathDownload(samples, t1Ms ?? endMs);
    const window = trace.window();

    // What the run made.
    const store = await collectStoreFacts(db);
    const catalogHeaders = await readCatalogHeaderFacts(db, { env: deps.env, since: new Date(0) });
    const rootIds = [outcome.firstRootId, outcome.secondRootId].filter(
      (id): id is string => id !== null
    );
    const [sourceFacts, relations, modelFacts, rankerState, hybrid, blockedJobs] =
      await Promise.all([
        readSourceFacts(db, rootIds),
        outcome.firstRootId
          ? readRelationFacts(db, { first: outcome.firstRootId, second: outcome.secondRootId })
          : { shown: 0, betweenSources: 0, byState: {} },
        readModelFacts(db, plan),
        readFirstRunRanker(db),
        readHybridRoutes(db, plan),
        readBlockedJobs(db)
      ]);
    const stats = cassette.stats();
    const installs = trace.all().map((install) => ({
      catalogId: install.catalogId,
      requestedAtMs: install.requestedAtMs,
      readyAtMs: install.readyAtMs,
      bytes: install.totalBytes || pinnedBytes(install.catalogId)
    }));
    const clock: ClockFacts = {
      t0: t0.toISOString(),
      appLaunchMs,
      marks: marks.toObject(),
      t1Ms,
      drainedMs: marks.get("drained"),
      download: recorded
        ? {
            source: "the recording",
            criticalPathMs: recorded.timing.downloadCriticalPathMs,
            setupMs: null,
            userMs: null,
            windowMs: recorded.timing.downloadWindowMs
          }
        : {
            source: "this run",
            criticalPathMs: download.totalMs,
            setupMs: download.setupMs,
            userMs: download.userMs,
            windowMs: window?.ms ?? 0
          },
      installs
    };
    const facts: FirstRunFacts = {
      mode,
      synthetic: config.synthetic,
      sources: config.sources,
      contentLanguage,
      writerKind: writer.kind,
      ipc: ipc.summary(),
      settingsCalls: { setup: ipc.calls("setup", "settings"), user: ipc.calls("user", "settings") },
      setupChannels: ipc.channels("setup"),
      expectedSetupChannels: invokedSetupChannels(writer.kind),
      cassette: {
        mode: stats.mode,
        served: stats.served,
        recorded: stats.recorded,
        misses: stats.misses,
        liveTokens: stats.liveTokens,
        byTask: stats.byTask,
        missDetails: stats.missDetails,
        maxLiveTokens: stats.maxLiveTokens,
        ...(stats.timing ? { timing: stats.timing } : {}),
        ...(stats.waitedMs !== undefined ? { waitedMs: stats.waitedMs } : {})
      },
      setup: outcome.setup,
      hybrid,
      models: modelFacts,
      modelSource: modelsMode,
      firstRunRanker: rankerState,
      downloadEvents,
      clock,
      connection: outcome.connection,
      relations,
      sourceFacts,
      blockedJobs,
      statusAtStalls: statusAtStalls(samples.filter((sample) => sample.atMs <= (t1Ms ?? endMs))),
      stoodIn: outcome.stood,
      stoppedBy: outcome.stoppedBy,
      errors,
      engine: outcome.engine,
      topicRelease: {
        settings: config.topicRelease,
        linkRuntime: harnessLinkRuntime,
        divisions: {
          first: releasePlan.divisionsOf("first"),
          second: releasePlan.divisionsOf("second")
        },
        releases
      },
      recorded,
      budgetMs: config.budgetMs
    };
    const report = evaluateFirstRun(store, facts);
    const markdown = renderFirstRunMarkdown(report, store);
    const name = mode === "replay" && config.replays > 1 ? `replay-${pass.index}` : mode;
    const directory =
      config.reportDir !== null
        ? config.mode === "replay" && config.replays === 1
          ? config.reportDir
          : join(config.reportDir, name)
        : join(config.repositoryRoot, ".cache", "topics", "firstrun-e2e", stamp, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify({ report, store, catalogHeaders }, null, 2)}\n`
    );
    await writeFile(join(directory, "report.md"), markdown);

    // What a passing recording keeps next to its cassette: the route, the result and the live clock.
    let record: RecordedFirstRun | null = null;
    if (mode === "record" && report.passed && t1Ms !== null) {
      const embeddingInstall = trace.get(plan.embedding);
      const rankerInstall = trace.get(plan.ranker);
      const installMs = (install: ReturnType<DownloadTrace["get"]>) =>
        install?.requestedAtMs != null && install.readyAtMs != null
          ? install.readyAtMs - install.requestedAtMs
          : null;
      record = {
        format: "memora-firstrun-e2e-record",
        version: 1,
        recordedAt: now().toISOString(),
        synthetic: config.synthetic,
        contentLanguage,
        sources: config.sources,
        writer: recordedWriter(writer),
        topicRelease: config.topicRelease,
        linkRuntime: harnessLinkRuntime,
        models: {
          embedding: {
            catalogId: plan.embedding,
            runtime: "gguf",
            bytes: pinnedBytes(plan.embedding),
            installMs: installMs(embeddingInstall)
          },
          ranker: {
            catalogId: plan.ranker,
            runtime: plan.rankerRuntime,
            bytes: pinnedBytes(plan.ranker),
            installMs: installMs(rankerInstall)
          }
        },
        result: {
          notes: store.currentNotes,
          topics: store.topics.length,
          noteRelations: store.endState.noteRelations,
          digest: store.endState.digest
        },
        timing: {
          t1MinusT0Ms: t1Ms,
          appLaunchMs,
          downloadCriticalPathMs: download.totalMs,
          downloadWindowMs: window?.ms ?? 0,
          live: !resumed
        }
      };
      await writeRecordedFirstRun(cassetteDir, record);
      if (config.copyModelsTo) {
        try {
          const copied = await copyModelsToSeed(plan, userData, config.copyModelsTo);
          log("models_copied", { seedDir: config.copyModelsTo, copied });
        } catch (error) {
          // The record and the report are kept; the replays' preflight names what the seed lacks.
          log("models_not_copied", {
            seedDir: config.copyModelsTo,
            error: error instanceof Error ? error.message.slice(0, 200) : String(error)
          });
        }
      }
    }
    if (!report.passed) keep = true;
    log("report", {
      passed: report.passed,
      directory,
      t1Ms,
      downloadCriticalPathMs: download.totalMs
    });
    return {
      mode,
      index: pass.index,
      report,
      store,
      markdown,
      workDir,
      kept: keep,
      catalogHeaders,
      record
    };
  } finally {
    await sampler?.stop().catch(() => undefined);
    gardenerStatus?.stop();
    setAiAdapterDecorator(null);
    setExtractionPin(false);
    holdCatalogHeaderRefresh(null);
    policy?.stop();
    await jobs?.stop().catch(() => undefined);
    // Back to the product's link runtime once no loop of this pass can claim a job.
    resetRelationLinkRuntime();
    topicServices?.dispose();
    await ai?.dispose().catch(() => undefined);
    await models?.shutdown().catch(() => undefined);
    bus?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager.stop().catch(() => undefined);
    if (!keep) await removeScratch(workDir, log);
  }
}
