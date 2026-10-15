import { runPromptSamples } from "./services/prompt-samples.js";
import { PromptService } from "./services/prompt-service.js";
import { registerPromptIpc } from "./services/prompt-ipc.js";
import { parseObsidianDeepLink, type ObsidianDeepLink } from "../shared/obsidian-deep-link.js";
import { ConsultationService } from "./services/consultation-service.js";
import { registerConsultationIpc } from "./services/consultation-ipc.js";
import { WikiService } from "./services/wiki-service.js";
import { registerWikiIpc } from "./services/wiki-ipc.js";
import { registerObjectsIpc } from "./services/objects-ipc.js";
import { ObjectsService } from "./services/objects-service.js";
import { registerNotePageIpc } from "./services/note-page-ipc.js";
import { NotePageService } from "./services/note-page-service.js";
import { registerRelationExplanationIpc } from "./services/relation-explanation-ipc.js";
import { RelationExplanationService } from "./services/relation-explanation-service.js";
import { registerSourceRelationExplanationIpc } from "./services/source-relation-explanation-ipc.js";
import { SourceRelationExplanationService } from "./services/source-relation-explanation-service.js";
import { ViewHistoryService } from "./services/view-history-service.js";
import { registerViewHistoryIpc } from "./services/view-history-ipc.js";
import { createApplicationMenuController, registerApplicationMenuIpc } from "./application-menu.js";
import { MonitoringService } from "./services/monitoring-service.js";
import { processRelationLabels } from "./services/relation-label-processing.js";
import { CredentialService } from "./services/credential-service";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  session,
  shell,
  Tray,
  webContents
} from "electron";
import { createTranslator } from "@app/i18n";
import { createAiCassetteFromEnvironment, setAiAdapterDecorator, type AiCassette } from "@app/ai";
import { registerIpcHandlers } from "./ipc";
import { DatabaseService } from "./services/database-service";
import { SettingsService } from "./services/settings-service";
import { AiService } from "./services/ai-service.js";
import { IngestionService } from "./services/ingestion-service.js";
import { HierarchicalIngestionService } from "./services/hierarchical-ingestion-service.js";
import { JobSupervisor } from "./services/job-supervisor.js";
import { SearchService } from "./services/search-service.js";
import { KnowledgeService } from "./services/knowledge-service.js";
import { ObsidianSyncService } from "./services/obsidian-sync-service.js";
import { IntegrationGateway } from "./services/integration-gateway.js";
import { LocalModelService } from "./services/local-model-service.js";
import { BackupService } from "./services/backup-service.js";
import { runLegacyWipeStartup } from "./services/legacy-wipe-service.js";
import { runProfileResetStartup } from "./services/profile-reset.js";
import { resolveWorkspaceRoot } from "./services/workspace-paths.js";
import { LibraryResetService } from "./services/library-reset-service.js";
import { SimilarityDebugService } from "./services/similarity-debug-service.js";
import { MetadataEnrichmentService } from "./services/metadata-enrichment-service.js";
import { createTopicTreeServices, type TopicTreeServices } from "./services/topic-tree/index.js";
import { createStoredVectorSpaceResolver } from "./services/topic-tree/topic-space.js";
import {
  navigationDirectionFromAppCommand,
  navigationDirectionFromInput,
  navigationDirectionFromSwipe,
  type WindowNavigationDirection
} from "./window-navigation.js";
import { ipcChannels, localEmbeddingLoadStatusSchema } from "../shared/ipc.js";

const configuredUserDataPath = process.env.MEMORA_USER_DATA_DIR?.trim();
if (configuredUserDataPath) app.setPath("userData", resolve(configuredUserDataPath));

const trayIconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR4nGNgoBH4jwNTpJkoQwhpxmsIsZqxGkKqZgxDRg2gggEURyNVEhKxhhAFKNJMEgAA0ICbZZSdbUEAAAAASUVORK5CYII=";

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1200,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: createTranslator(app.getLocale())("app.title"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuittingAfterShutdown || isShutdownInProgress) {
      return;
    }

    event.preventDefault();
    app.quit();
  });

  mainWindow.on("closed", () => {
    if (mainWindow === activeMainWindow) {
      activeMainWindow = null;
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!app.isPackaged && process.env.MEMORA_DEV_BACKGROUND === "1") {
      mainWindow.showInactive();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload failed: ${preloadPath}: ${error.message}`);
  });

  mainWindow.webContents.on("console-message", (event) => {
    if (event.level === "warning" || event.level === "error") {
      console.warn(`Renderer console: ${event.message}`);
    }
  });

  function sendNavigation(direction: WindowNavigationDirection | null) {
    if (direction) mainWindow.webContents.send(ipcChannels.windowNavigation, direction);
  }

  mainWindow.on("app-command", (_event, command) => {
    sendNavigation(navigationDirectionFromAppCommand(command));
  });

  mainWindow.on("swipe", (_event, direction) => {
    sendNavigation(navigationDirectionFromSwipe(direction));
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const direction = navigationDirectionFromInput(input, process.platform);
    if (!direction) return;
    event.preventDefault();
    sendNavigation(direction);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

let settingsService: SettingsService | null = null;
let databaseService: DatabaseService | null = null;
let aiService: AiService | null = null;
let ingestionService: IngestionService | null = null;
let metadataEnrichmentService: MetadataEnrichmentService | null = null;
let hierarchicalIngestionService: HierarchicalIngestionService | null = null;
let jobSupervisor: JobSupervisor | null = null;
let searchService: SearchService | null = null;
let knowledgeService: KnowledgeService | null = null;
let obsidianSyncService: ObsidianSyncService | null = null;
let integrationGateway: IntegrationGateway | null = null;
let localModelService: LocalModelService | null = null;
let backupService: BackupService | null = null;
let libraryResetService: LibraryResetService | null = null;
let similarityDebugService: SimilarityDebugService | null = null;
let topicTreeServices: TopicTreeServices | null = null;
let activeMainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serviceStartupPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let isShutdownInProgress = false;
let isQuittingAfterShutdown = false;

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let pendingObsidianOpen: ObsidianDeepLink | null = null;
function receiveObsidianOpen(raw: string) {
  const target = parseObsidianDeepLink(raw);
  if (!target) return;
  pendingObsidianOpen = target;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isLoading())
      window.webContents.send(ipcChannels.obsidianDeepLink, target);
  }
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveObsidianOpen(url);
});
app.on("second-instance", (_event, args) => {
  for (const arg of args) if (arg.startsWith("memora:")) receiveObsidianOpen(arg);
});
for (const arg of process.argv) if (arg.startsWith("memora:")) receiveObsidianOpen(arg);
ipcMain.handle(ipcChannels.obsidianDeepLinkPending, () => {
  const target = pendingObsidianOpen;
  pendingObsidianOpen = null;
  return target;
});

void app.whenReady().then(() => {
  if (!primaryInstance) return;
  app.setName(createTranslator(app.getLocale())("app.title"));
  if (app.isPackaged) app.setAsDefaultProtocolClient("memora");
  databaseService = new DatabaseService({
    userDataPath: app.getPath("userData"),
    cwd: process.cwd(),
    resourcesPath: getResourcesPath(),
    isPackaged: app.isPackaged,
    logger: console
  });
  settingsService = new SettingsService(app.getPath("userData"), {
    getDatabasePool: () => databaseService?.getPool() ?? null,
    requireDatabase: true,
    desktopLocale: app.getLocale()
  });
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const aiCassette = installDevelopmentAiCassette(workspaceRoot);
  if (aiCassette === undefined) return;
  const monitoringService = new MonitoringService(
    () => databaseService?.getPool() ?? null,
    () => settingsService!.getApp()
  );
  aiService = new AiService({
    monitoring: monitoringService,
    userDataPath: app.getPath("userData"),
    getPool: () => databaseService?.getPool() ?? null,
    workspaceRoot,
    resourcesPath: getResourcesPath(),
    isPackaged: app.isPackaged,
    logger: console,
    openExternal: (url) => shell.openExternal(url),
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    getUiLanguage: async () => (await settingsService!.getApp()).language,
    getKeepLocalEmbeddingModelsLoaded: async () =>
      (await settingsService!.getApp()).keepLocalEmbeddingModelsLoaded,
    onLocalEmbeddingLoadStatus: (status) => {
      const payload = localEmbeddingLoadStatusSchema.parse(status);
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) contents.send(ipcChannels.aiLocalEmbeddingLoadStatus, payload);
      }
    }
  });
  localModelService = new LocalModelService({
    getPool: () => databaseService?.getPool() ?? null,
    userDataPath: app.getPath("userData"),
    logger: console,
    isPackaged: app.isPackaged,
    workspaceRoot,
    isModelInUse: (localModelId) => aiService?.isLocalModelInUse(localModelId) ?? false,
    testModel: (localModelId) => aiService!.testLocalModel(localModelId)
  });
  backupService = new BackupService({
    getDatabaseContext: () => databaseService?.getBackupContext() ?? null,
    getStorageSettings: () => settingsService!.get()
  });
  // A start and a library reset restore the prompt catalog only. The legacy wiki areas, curator
  // policy and followed questions are never created again (F2 D3).
  async function initializeKnowledgeDefaults() {
    await promptService.initialize();
  }
  // The Topic Tree Engine (F2): the topic jobs run on the job supervisor's light lane. The space
  // resolver reads the newest stored note vector until the AI service resolves the route's space.
  topicTreeServices = createTopicTreeServices({
    getPool: () => databaseService?.getPool() ?? null,
    spaceResolver: createStoredVectorSpaceResolver(() => databaseService?.getPool() ?? null),
    env: process.env,
    isPackaged: app.isPackaged,
    wake: () => jobSupervisor?.wake("light"),
    logger: console
  });
  libraryResetService = new LibraryResetService({
    // A reset leaves an empty active tree (D39).
    restoreDefaults: async () => {
      await initializeKnowledgeDefaults();
      await topicTreeServices?.ensureActiveTree();
    },
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get(),
    userDataPath: app.getPath("userData")
  });
  hierarchicalIngestionService = new HierarchicalIngestionService({
    getPool: () => databaseService?.getPool() ?? null
  });
  ingestionService = new IngestionService({
    traceOperation: (operation, context, run) =>
      monitoringService.operation(operation, context, run),
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get(),
    userDataPath: app.getPath("userData"),
    resourcesPath: getResourcesPath(),
    workspaceRoot,
    isPackaged: app.isPackaged,
    hierarchicalIngestionService,
    fetchExternalPage: (url, init) =>
      net.fetch(url, { ...init, bypassCustomProtocolHandlers: true })
  });
  metadataEnrichmentService = new MetadataEnrichmentService({
    credentials: new CredentialService(app.getPath("userData")),
    getPool: () => databaseService?.getPool() ?? null,
    getEnabled: async () => (await settingsService!.getApp()).metadataEnrichmentEnabled,
    getBookProvider: async () => (await settingsService!.getApp()).bookMetadataProvider,
    userDataPath: app.getPath("userData"),
    logger: console
  });
  searchService = new SearchService(
    () => databaseService?.getPool() ?? null,
    aiService,
    async () => (await settingsService!.getApp()).debugMode
  );
  registerWikiIpc(ipcMain, new WikiService(() => databaseService?.getPool() ?? null));
  registerObjectsIpc(ipcMain, new ObjectsService(() => databaseService?.getPool() ?? null));
  registerNotePageIpc(
    ipcMain,
    new NotePageService(
      () => databaseService?.getPool() ?? null,
      async () => (await settingsService!.getApp()).contentLanguage
    )
  );
  registerRelationExplanationIpc(
    ipcMain,
    new RelationExplanationService({
      getPool: () => databaseService?.getPool() ?? null,
      ai: aiService,
      getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage
    })
  );
  registerSourceRelationExplanationIpc(
    ipcMain,
    new SourceRelationExplanationService({
      getPool: () => databaseService?.getPool() ?? null,
      ai: aiService,
      getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage
    })
  );
  const relationThreshold = readRelationThreshold(
    process.env.MEMORA_ATOMIC_NOTE_RELATION_THRESHOLD
  );
  knowledgeService = new KnowledgeService({
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    getPool: () => databaseService?.getPool() ?? null,
    aiService,
    userDataPath: app.getPath("userData"),
    getStorageSettings: () => settingsService!.get(),
    getUploadedFilesBasePath: async () => (await settingsService!.get()).uploadCopiesFolderPath,
    isDebugEnabled: async () => (await settingsService!.getApp()).debugMode,
    getRelationThreshold: async () => (await settingsService!.getApp()).atomicNoteRelationThreshold,
    getAtomicNoteMatchingSettings: async () =>
      (await settingsService!.getApp()).atomicNoteMatchingSettings,
    getCanonicalMatchingSettings: async () =>
      (await settingsService!.getApp()).canonicalMatchingSettings,
    getSourceRelationSettings: async () => (await settingsService!.getApp()).sourceRelationSettings,
    getSummaryMinimumWordCount: async () =>
      (await settingsService!.getApp()).summaryMinimumWordCount,
    getEntityIdentitySimilarityThreshold: async () =>
      (await settingsService!.getApp()).entityIdentitySimilarityThreshold,
    getRelationTypeSimilarityThreshold: async () =>
      (await settingsService!.getApp()).relationTypeSimilarityThreshold,
    getKnowledgeGraphLimits: async () => {
      const settings = await settingsService!.getApp();
      return {
        maxEntities: settings.knowledgeGraphMaxEntitiesPerSource,
        maxRelations: settings.knowledgeGraphMaxRelationsPerSource
      };
    },
    logger: console,
    ...(relationThreshold !== undefined ? { relationThreshold } : {})
  });
  obsidianSyncService = new ObsidianSyncService({
    getLocale: async () => (await settingsService!.getApp()).contentLanguage,
    assetRoots: async () => ({
      app_internal: join(app.getPath("userData"), "assets"),
      ...((await settingsService!.get()).uploadCopiesFolderPath
        ? { uploaded_files: (await settingsService!.get()).uploadCopiesFolderPath! }
        : {})
    }),
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get()
  });
  const promptService = new PromptService({
    getPool: () => databaseService?.getPool() ?? null,
    ai: aiService,
    sample: (contexts, options) => runPromptSamples(aiService!, contexts, options)
  });
  registerPromptIpc(ipcMain, promptService);
  const consultationService = new ConsultationService({
    getPool: () => databaseService?.getPool() ?? null,
    ai: aiService,
    contentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    wake: () => jobSupervisor?.wake()
  });
  registerConsultationIpc(ipcMain, consultationService);
  jobSupervisor = new JobSupervisor({
    traceOperation: (operation, context, run) =>
      monitoringService.operation(operation, context, run),
    processRelationLabels: (job, signal) =>
      processRelationLabels(databaseService!.getPool()!, aiService!, job, signal),
    getPool: () => databaseService?.getPool() ?? null,
    logger: console,
    knowledgeService,
    obsidianSyncService,
    generateEmbedding: async (text, signal, context) => {
      const result = await aiService?.runDefaultTask("embedding", text, context, signal);
      if (!result || !Array.isArray(result.output)) return null;
      return {
        embedding: result.output.map(Number),
        provider: result.providerId,
        model: result.modelId,
        runtime: result.runtime,
        ...(result.embeddingSpaceKey ? { spaceKey: result.embeddingSpaceKey } : {})
      };
    },
    releaseAiRuntime: async () =>
      aiService!.releaseLocalRuntime(
        false,
        (await settingsService!.getApp()).keepLocalEmbeddingModelsLoaded
      ),
    lightJobs: topicTreeServices.jobs
  });
  const gatewayPort = readGatewayPort(process.env.MEMORA_INTEGRATION_GATEWAY_PORT);
  integrationGateway = new IntegrationGateway({
    getPool: () => databaseService?.getPool() ?? null,
    ingestionService,
    obsidianSyncService,
    jobSupervisor,
    ...(gatewayPort !== undefined ? { preferredPort: gatewayPort } : {}),
    logger: console
  });
  similarityDebugService = new SimilarityDebugService(() => databaseService?.getPool() ?? null);
  // Cmd-W closes a panel through the menu; there is no Close Window item, so it cannot quit the app.
  registerApplicationMenuIpc(
    ipcMain,
    createApplicationMenuController({
      initialLanguage: app.getLocale(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      apply: (template) => {
        try {
          Menu.setApplicationMenu(Menu.buildFromTemplate(template));
        } catch (error) {
          // The menu is not essential: a failure must not stop the application from starting.
          console.error(
            `Application menu failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
      send: (command) => sendToMainWindow(ipcChannels.menuCommand, command),
      navigate: (direction) => sendToMainWindow(ipcChannels.windowNavigation, direction)
    })
  );
  registerViewHistoryIpc(
    ipcMain,
    new ViewHistoryService({
      getPool: () => databaseService?.getPool() ?? null,
      onChanged: () => {
        for (const contents of webContents.getAllWebContents())
          if (!contents.isDestroyed()) contents.send(ipcChannels.viewHistoryChanged);
      }
    })
  );
  registerIpcHandlers(
    ipcMain,
    settingsService,
    databaseService,
    ingestionService,
    metadataEnrichmentService,
    hierarchicalIngestionService,
    jobSupervisor,
    searchService,
    aiService,
    knowledgeService,
    integrationGateway,
    localModelService,
    backupService,
    libraryResetService,
    similarityDebugService,
    obsidianSyncService,
    monitoringService
  );
  createApplicationTray();
  activeMainWindow = createMainWindow();
  serviceStartupPromise = databaseService
    .start()
    .then(async (status) => {
      if (status.state === "ready") {
        await initializeKnowledgeDefaults();
        await monitoringService.recover();
        // The LEGACY_RECREATED check, then the DEV-only one-shot legacy wipe
        // (MEMORA_LEGACY_WIPE=preview|<token>): a preview, a wipe or a refusal quits here, before
        // the local models, job supervisor, gateway and vault reconcile start.
        const legacyWipe = await runLegacyWipeStartup({
          env: process.env,
          isPackaged: app.isPackaged,
          pool: databaseService!.getPool()!,
          workspaceRoot,
          getDatabaseContext: () => databaseService?.getBackupContext() ?? null,
          getStorageSettings: () => settingsService!.get(),
          logger: console
        });
        if (legacyWipe === "quit") {
          app.quit();
          return;
        }
        // DEV-only measurement profile reset (MEMORA_PROFILE_RESET=1, scripts/topics/env-profiles.ts):
        // the Settings reset of a profile under .cache/profiles/, then quit. Refused for any other
        // profile. Nothing else has started, so there is nothing to stop first.
        const profileReset = await runProfileResetStartup({
          env: process.env,
          isPackaged: app.isPackaged,
          userDataPath: app.getPath("userData"),
          workspaceRoot,
          pool: databaseService!.getPool()!,
          libraryReset: {
            reset: async () => {
              await metadataEnrichmentService!.clearCache();
              await session.defaultSession.clearCache();
              return libraryResetService!.reset();
            }
          },
          readContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
          logger: console
        });
        if (profileReset === "quit") {
          app.quit();
          return;
        }
        // DEV-only golden run: prepared before the job supervisor starts, so nothing runs before
        // the checks and the backup have passed.
        // MEMORA_GOLDEN_SOURCE_PAIRS alone is refused by the same path, not silently ignored.
        const goldenRun =
          !app.isPackaged &&
          (process.env.MEMORA_GOLDEN_RUN || process.env.MEMORA_GOLDEN_SOURCE_PAIRS)
            ? await import("./services/golden-runner.js")
                .then(({ prepareGoldenRun }) =>
                  prepareGoldenRun({
                    env: process.env,
                    isPackaged: app.isPackaged,
                    userDataPath: app.getPath("userData"),
                    workspaceRoot,
                    pool: databaseService!.getPool()!,
                    cassette: aiCassette,
                    backup: backupService!,
                    // MEMORA_GOLDEN_RESET=1 only: the Settings reset sequence (see ipc.ts). The
                    // gateway, job supervisor and local-model service are not started yet, so there
                    // is nothing to stop first.
                    libraryReset: {
                      reset: async () => {
                        await metadataEnrichmentService!.clearCache();
                        await session.defaultSession.clearCache();
                        return libraryResetService!.reset();
                      }
                    },
                    ingestion: ingestionService!,
                    hierarchy: hierarchicalIngestionService!,
                    jobs: jobSupervisor!,
                    settings: settingsService!,
                    // MEMORA_GOLDEN_SOURCE_PAIRS only: the source decider runs through the normal AI service.
                    ai: aiService!,
                    quit: () => app.quit()
                  })
                )
                .catch((error: unknown) => {
                  console.error(
                    "GOLDEN_RUN refused:",
                    error instanceof Error ? error.message : String(error)
                  );
                  return null;
                })
            : undefined;
        if (goldenRun === null) {
          app.quit();
          return;
        }
        // A verdict-only source pair run leaves the library alone: only the local models (the decider
        // may be one) start, so no job, capture or vault sync can change it meanwhile.
        const verdictOnly = goldenRun?.sourcePairs?.mode === "verdict_only";
        // The active topic tree exists (D39) and its sweep is queued before the light lane starts.
        if (!verdictOnly) await topicTreeServices?.start();
        await Promise.all([
          localModelService?.start(),
          verdictOnly ? undefined : jobSupervisor?.start(),
          verdictOnly ? undefined : integrationGateway?.start(),
          verdictOnly ? undefined : obsidianSyncService?.reconcileVault()
        ]);
        if (!app.isPackaged && process.env.MEMORA_MATCHING_PILOT) {
          void import("./services/matching-pilot.js")
            .then(({ runMatchingPilot }) =>
              runMatchingPilot({
                mode: process.env.MEMORA_MATCHING_PILOT!,
                isPackaged: app.isPackaged,
                userDataPath: app.getPath("userData"),
                workspaceRoot,
                pool: databaseService!.getPool()!,
                ingestion: ingestionService!,
                hierarchy: hierarchicalIngestionService!,
                settings: settingsService!,
                jobs: jobSupervisor!,
                backup: backupService!
              })
            )
            .catch((error: unknown) =>
              console.error(
                "MATCHING_PILOT failed:",
                error instanceof Error ? error.message : String(error)
              )
            );
        }
        if (!app.isPackaged && process.env.MEMORA_MATCHING_BENCHMARK) {
          void import("./services/matching-benchmark.js")
            .then(({ runMatchingBenchmark }) =>
              runMatchingBenchmark({
                mode: "benchmark",
                isPackaged: app.isPackaged,
                userDataPath: app.getPath("userData"),
                workspaceRoot,
                pool: databaseService!.getPool()!,
                ingestion: ingestionService!,
                hierarchy: hierarchicalIngestionService!,
                settings: settingsService!,
                jobs: jobSupervisor!,
                backup: backupService!,
                ai: aiService!
              })
            )
            .catch((error: unknown) =>
              console.error(
                "MATCHING_BENCHMARK failed:",
                error instanceof Error ? error.message : String(error)
              )
            );
        }
        void goldenRun?.start();
        const autoQuitMs = readPositiveInteger(process.env.MEMORA_SMOKE_AUTO_QUIT_MS);
        if (autoQuitMs !== undefined) setTimeout(() => app.quit(), autoQuitMs);
      }
    })
    .catch((error: unknown) => {
      console.error(
        `Service startup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isShutdownInProgress && !isQuittingAfterShutdown) app.quit();
});

app.on("before-quit", (event) => {
  if (isQuittingAfterShutdown) {
    return;
  }

  event.preventDefault();
  isShutdownInProgress = true;
  shutdownPromise ??= shutdownServices().finally(() => {
    isQuittingAfterShutdown = true;
    app.quit();
  });
});

async function shutdownServices(): Promise<void> {
  activeMainWindow?.destroy();
  activeMainWindow = null;
  tray?.destroy();
  tray = null;
  await serviceStartupPromise;
  serviceStartupPromise = null;
  await integrationGateway?.stop();
  integrationGateway = null;
  await jobSupervisor?.stop();
  jobSupervisor = null;
  topicTreeServices?.dispose();
  topicTreeServices = null;
  await localModelService?.shutdown();
  localModelService = null;
  backupService = null;
  libraryResetService = null;
  searchService = null;
  knowledgeService = null;
  await obsidianSyncService?.shutdown();
  obsidianSyncService = null;
  ingestionService = null;
  metadataEnrichmentService = null;
  await aiService?.dispose();
  aiService = null;
  await settingsService?.dispose();
  settingsService = null;
  await databaseService?.stop();
  databaseService = null;
}

function createApplicationTray(): void {
  if (tray !== null) {
    return;
  }

  const translate = createTranslator(app.getLocale());
  tray = new Tray(createTrayIcon());
  tray.setToolTip(translate("app.title"));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: translate("app.tray.open"),
        click: () => showMainWindow()
      },
      { type: "separator" },
      {
        label: translate("app.tray.quit"),
        click: () => app.quit()
      }
    ])
  );
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
}

function createTrayIcon() {
  const image = nativeImage.createFromDataURL(trayIconDataUrl);
  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  return image;
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const contents = activeMainWindow?.webContents;
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

function showMainWindow(): void {
  if (isShutdownInProgress || isQuittingAfterShutdown) return;
  if (activeMainWindow === null || activeMainWindow.isDestroyed()) {
    activeMainWindow = createMainWindow();
  }

  if (activeMainWindow.isMinimized()) {
    activeMainWindow.restore();
  }

  activeMainWindow.show();
  activeMainWindow.focus();
}

/**
 * DEV-only AI cassette (MEMORA_AI_CASSETTE=record|replay, MEMORA_AI_CASSETTE_DIR). A DEV
 * misconfiguration stops the app (undefined); a packaged build refuses cassettes and runs normally.
 */
function installDevelopmentAiCassette(workspaceRoot: string): AiCassette | null | undefined {
  try {
    const cassette = createAiCassetteFromEnvironment(process.env, {
      isPackaged: app.isPackaged,
      baseDirectory: workspaceRoot
    });
    if (cassette) {
      setAiAdapterDecorator((adapter) => cassette.wrap(adapter));
      console.info(`AI cassette: ${cassette.mode} ${cassette.directory}`);
    }
    return cassette;
  } catch (error) {
    console.error(`AI cassette refused: ${error instanceof Error ? error.message : String(error)}`);
    if (app.isPackaged) return null;
    app.exit(1);
    return undefined;
  }
}

function getResourcesPath(): string {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.cwd();
}

function readRelationThreshold(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readGatewayPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}
