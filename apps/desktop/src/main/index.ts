import { aiConfigGeneration, createJobRepository } from "@app/db";
import { topicTreeConfigForPreset } from "@app/domain/topic-tree";
import {
  MatchingConfigurationSchema,
  backgroundBlockerOf,
  defaultKnowledgeControls,
  defaultPriceTable,
  defaultRemoteBudgetConfig,
  gardenerStatusKinds,
  relationExplainBackfillConfig
} from "@app/domain";
import { runPromptSamples } from "./services/prompt-samples.js";
import { PromptService } from "./services/prompt-service.js";
import {
  createApplicationShutdown,
  describeLanes,
  type ShutdownStep
} from "./services/application-shutdown.js";
import { registerPromptIpc } from "./services/prompt-ipc.js";
import { parseObsidianDeepLink, type ObsidianDeepLink } from "../shared/obsidian-deep-link.js";
import { ConsultationService } from "./services/consultation-service.js";
import { registerConsultationIpc } from "./services/consultation-ipc.js";
import { RemoteBudget } from "./services/gardener/remote-budget.js";
import {
  BudgetRelay,
  RemoteBudgetGate,
  meteredRouteCall
} from "./services/gardener/budget-gate.js";
import { registerBudgetIpc } from "./services/gardener/budget-ipc.js";
import {
  GardenerStatusService,
  distinctHolds,
  gardenerStatusStoreOf,
  routeLaneOf
} from "./services/gardener/status-service.js";
import { registerGardenerStatusIpc } from "./services/gardener/status-ipc.js";
import { HardwareService } from "./services/hardware/hardware-service.js";
import { registerHardwareIpc } from "./services/hardware/ipc.js";
import { registerOnboardingIpc } from "./services/onboarding/onboarding-ipc.js";
import { OnboardingService, pgOnboardingStore } from "./services/onboarding/onboarding-service.js";
import { registerKnowledgeControlsIpc } from "./services/gardener/knowledge-controls-ipc.js";
import { WikiService } from "./services/wiki-service.js";
import { registerWikiIpc } from "./services/wiki-ipc.js";
import { registerObjectsIpc } from "./services/objects-ipc.js";
import { ObjectsService } from "./services/objects-service.js";
import { registerNotePageIpc } from "./services/note-page-ipc.js";
import { NotePageService } from "./services/note-page-service.js";
import { registerRelationExplanationIpc } from "./services/relation-explanation-ipc.js";
import { registerRelationReviewIpc } from "./services/relation-review-ipc.js";
import { RelationReviewService } from "./services/relation-review-service.js";
import { RelationExplanationService } from "./services/relation-explanation-service.js";
import {
  createRelationExplanationWriterResolver,
  memoizeRelationExplanationWriter
} from "./services/relation-explanation-writer.js";
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
  powerMonitor,
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
import { createJobEmbeddingGenerators } from "./services/job-embedding.js";
import { JobSupervisor } from "./services/job-supervisor.js";
import { AppEventBus, budgetEventPublisher, changeSetEventHooks } from "./services/app-events.js";
import { connectJobProgress, type JobProgressPublisher } from "./services/job-progress.js";
import {
  createBackgroundPolicy,
  type BackgroundPolicy
} from "./services/gardener/background-policy.js";
import { SearchService } from "./services/search-service.js";
import { KnowledgeService } from "./services/knowledge-service.js";
import { ObsidianSyncService } from "./services/obsidian-sync-service.js";
import { IntegrationGateway } from "./services/integration-gateway.js";
import { FirstRunRanker, settingsFirstRunRankerStore } from "./services/first-run-ranker.js";
import { runLocalModelInstallStartup } from "./services/local-model-install-startup.js";
import { LocalModelService } from "./services/local-model-service.js";
import { BackupService } from "./services/backup-service.js";
import { runProfileResetStartup } from "./services/profile-reset.js";
import { laneProbeRequested, runLaneProbe } from "./services/lane-probe.js";
import { decisionsDevOptions } from "./services/dev/decisions-dev-options.js";
import { relationsConfigForRun } from "./services/dev/relations-dev-options.js";
import { explainProbeRequested, runExplainProbe } from "./services/dev/explain-probe.js";
import { prepareSoak, type SoakPreparation } from "./services/dev/soak-startup.js";
import { readSoakSetupKnob, runSoakSetup } from "./services/dev/soak-setup.js";
import { createRematchJobSlot } from "./services/dev/relations-rematch-slot.js";
import { resolveWorkspaceRoot } from "./services/workspace-paths.js";
import { LibraryResetService } from "./services/library-reset-service.js";
import { SimilarityDebugService } from "./services/similarity-debug-service.js";
import { MetadataEnrichmentService } from "./services/metadata-enrichment-service.js";
import { promptPinGeneration } from "./services/prompt-runtime.js";
import { createTopicTreeServices, type TopicTreeServices } from "./services/topic-tree/index.js";
import { ChangesService } from "./services/gardener/changes-service.js";
import { registerChangesIpc } from "./services/gardener/changes-ipc.js";
import { InboxService } from "./services/gardener/inbox-service.js";
import { registerInboxIpc } from "./services/gardener/inbox-ipc.js";
import {
  gardenerRetentionJobType,
  retentionJobExecutor,
  retentionStartDelayMs,
  scheduleRetention
} from "./services/gardener/retention.js";
import { createNoteMatchRequests } from "./services/relations/relation-match.js";
import { RelationMatchBacklog } from "./services/relations/relation-match-backlog.js";
import { createRouteSpaceResolver } from "./services/topic-tree/topic-space.js";
import { immediateDebounce } from "./services/topic-tree/topic-triggers.js";
import {
  explainBackfillExecutor,
  relationExplainBackfillJobType,
  scheduleExplainBackfillPass
} from "./services/relations/relation-explain-backfill.js";
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
/** F4 D14 (T76): meters background remote spend; the monthly cap is the typed default until T75. */
let remoteBudget: RemoteBudget | null = null;
let ingestionService: IngestionService | null = null;
let metadataEnrichmentService: MetadataEnrichmentService | null = null;
let hierarchicalIngestionService: HierarchicalIngestionService | null = null;
let jobSupervisor: JobSupervisor | null = null;
let appEvents: AppEventBus | null = null;
let jobProgress: JobProgressPublisher | null = null;
/** The Gardener's status (F4 D27, T86): what it does or why it does not, read and pushed. */
let gardenerStatus: GardenerStatusService | null = null;
/** The Inbox (F4 D29, T94): one list of what waits for the owner, and the verbs on it. */
let inboxService: InboxService | null = null;
let searchService: SearchService | null = null;
let knowledgeService: KnowledgeService | null = null;
/** F4 D16 (T83): the optional re-match a change of the note decider offers; the Inbox accepts it. */
let relationMatchBacklog: RelationMatchBacklog | null = null;
let obsidianSyncService: ObsidianSyncService | null = null;
let integrationGateway: IntegrationGateway | null = null;
let localModelService: LocalModelService | null = null;
let firstRunRanker: FirstRunRanker | null = null;
let backupService: BackupService | null = null;
let libraryResetService: LibraryResetService | null = null;
let similarityDebugService: SimilarityDebugService | null = null;
let topicTreeServices: TopicTreeServices | null = null;
let soakPreparation: SoakPreparation | null = null;
/** The Gardener's background policy (F4 T75): controls, power signals, gates and blockers. */
let backgroundPolicy: BackgroundPolicy | null = null;
let activeMainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serviceStartupPromise: Promise<void> | null = null;
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
    desktopLocale: app.getLocale(),
    // F4 Q4: a saved matching value applies to new decisions only; the earlier ones are offered
    // for re-matching in the Inbox (nothing is queued, nothing stored is rewritten).
    onMatchingValuesChanged: async (change) => {
      await relationMatchBacklog?.offerSettings({ before: change.before });
    }
  });
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const aiCassette = installDevelopmentAiCassette(workspaceRoot);
  if (aiCassette === undefined) return;
  // DEV soak profile setup (MEMORA_SOAK_SETUP=1, F3 T62): the Local preset on a clone, then quit. A
  // refusal stops an unpackaged app; nothing else starts meanwhile (see `verdictOnly` below).
  let soakSetup = false;
  try {
    soakSetup = readSoakSetupKnob(process.env, {
      isPackaged: app.isPackaged,
      workspaceRoot,
      userDataPath: app.getPath("userData")
    });
  } catch (error) {
    console.error(`SOAK_SETUP refused: ${error instanceof Error ? error.message : String(error)}`);
    if (!app.isPackaged) {
      app.exit(1);
      return;
    }
  }
  // DEV fake remote providers and soak driver (MEMORA_FAKE_REMOTE, MEMORA_SOAK, F3 T62): a refusal
  // stops an unpackaged app, so a soak never runs half-armed; a packaged build ignores both.
  try {
    soakPreparation = prepareSoak({
      env: process.env,
      isPackaged: app.isPackaged,
      workspaceRoot,
      userDataPath: app.getPath("userData")
    });
  } catch (error) {
    console.error(`SOAK refused: ${error instanceof Error ? error.message : String(error)}`);
    if (!app.isPackaged) {
      app.exit(1);
      return;
    }
  }
  soakPreparation?.installAdapterDecorator();
  // The typed event bus (F4 D26): services publish after commit; the windows hear one validated channel.
  const events = new AppEventBus({
    send: (event) => {
      for (const contents of webContents.getAllWebContents())
        if (!contents.isDestroyed()) contents.send(ipcChannels.appEvents, event);
    },
    onInvalid: (error) => console.error(error.message),
    onError: (error) => console.error(error instanceof Error ? error.message : String(error))
  });
  appEvents = events;
  // The RemoteBudget in the background policy (F4 D7, D14): the claim leaves out a background kind
  // whose route the budget refuses now, and the budget's changes re-gate the rows it held. Both read
  // the budget and the AI routes, which exist below; the gate answers only after its first read.
  const budgetGate = new RemoteBudgetGate({
    snapshot: () => remoteBudget!.snapshot(),
    metering: async (metered) => {
      const { task, context } = meteredRouteCall(metered);
      const route = await aiService?.taskRouteModel(task, context);
      if (!route || route.locality === "local") return "none";
      return remoteBudget!.price(route.provider, route.modelId).billing === "subscription"
        ? "calls"
        : "money";
    }
  });
  const budgetRelay = new BudgetRelay({
    budget: {
      snapshot: () => remoteBudget!.snapshot(),
      continuePastPause: () => remoteBudget!.continuePastPause()
    },
    gate: budgetGate,
    blockers: () => backgroundPolicy?.blockers ?? null,
    // The Activity drawer's budget section follows the meters (`budget.changed`, D26).
    publish: budgetEventPublisher(events),
    logger: console
  });
  // The Gardener's background policy (F4 T75). `MEMORA_DEV_POWER_BLOCKS` (DEV only, the soak's
  // activity and battery windows) is refused when it names an unknown block.
  try {
    backgroundPolicy = createBackgroundPolicy({
      getPool: () => databaseService?.getPool() ?? null,
      powerSource: powerMonitor,
      isPackaged: app.isPackaged,
      env: process.env,
      wake: () => jobSupervisor?.wake("light"),
      refreshLanes: () => aiService?.refreshLanes(),
      routesGeneration: aiConfigGeneration,
      kindGates: [budgetGate],
      refreshGates: () => (remoteBudget && aiService ? budgetGate.refresh() : Promise.resolve()),
      logger: console
    });
    // The monthly cap is a Knowledge control: a change moves the budget's meters (D13, D14).
    backgroundPolicy.controls.subscribe(() => budgetRelay.changed());
  } catch (error) {
    console.error(
      `POWER override refused: ${error instanceof Error ? error.message : String(error)}`
    );
    if (!app.isPackaged) {
      app.exit(1);
      return;
    }
  }
  const monitoringService = new MonitoringService(
    () => databaseService?.getPool() ?? null,
    () => settingsService!.getApp()
  );
  remoteBudget = new RemoteBudget({
    getPool: () => databaseService?.getPool() ?? null,
    // The person's monthly cap of background spend (`knowledge.controls.v1`, D13, Q3).
    monthlyCapUsd: () =>
      backgroundPolicy?.controls.current().monthlyCapUsd ??
      defaultRemoteBudgetConfig.defaultMonthlyCapUsd,
    onChange: () => budgetRelay.changed(),
    // The 7-day soak's DEV overrides (F4 T89): the mid-run Codex daily cap and the money window's fake.
    ...(soakPreparation?.subscriptionDailyCalls
      ? { subscriptionDailyCalls: soakPreparation.subscriptionDailyCalls }
      : {}),
    ...(soakPreparation ? { priceTable: soakPreparation.priceTable(defaultPriceTable) } : {}),
    logger: console
  });
  aiService = new AiService({
    monitoring: monitoringService,
    remoteBudget,
    userDataPath: app.getPath("userData"),
    getPool: () => databaseService?.getPool() ?? null,
    workspaceRoot,
    resourcesPath: getResourcesPath(),
    isPackaged: app.isPackaged,
    logger: soakPreparation?.logger ?? console,
    ...(soakPreparation ? { honourTreatAsRemote: true } : {}),
    // The 7-day soak's fault layer in front of the real Codex adapter (F4 T89).
    ...(soakPreparation?.codexFetch ? { codexFetch: soakPreparation.codexFetch } : {}),
    openExternal: (url) => shell.openExternal(url),
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    getUiLanguage: async () => (await settingsService!.getApp()).language,
    getKeepLocalEmbeddingModelsLoaded: async () =>
      (await settingsService!.getApp()).keepLocalEmbeddingModelsLoaded,
    onLocalEmbeddingLoadStatus: (status) => {
      const payload = localEmbeddingLoadStatusSchema.parse(status);
      // A model loading into memory is a wait the Activity explains (F4 D27).
      gardenerStatus?.noteEmbeddingLoad(payload.state);
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) contents.send(ipcChannels.aiLocalEmbeddingLoadStatus, payload);
      }
    },
    // Owner decision 19: the library's first embedding route installs the local ranker.
    onRoutesSeeded: (tasks) => firstRunRanker?.onRoutesSeeded(tasks),
    // Decision 30: a DEV cassette replay needs no Decisions key; `MEMORA_RELATIONS_DECISIONS=on`
    // (DEV only) turns the opt-in decider on for a proof run.
    ...(aiCassette ? { cassetteMode: aiCassette.mode } : {}),
    ...decisionsDevOptions(process.env, app.isPackaged),
    ...(backgroundPolicy ? { backgroundAdmission: backgroundPolicy.admission } : {}),
    // A job's call the budget refused sets the task aside even when its executor went on (D7).
    onBudgetRefusal: (jobId, refusal) => {
      const blocker = backgroundBlockerOf(refusal);
      if (blocker) backgroundPolicy?.gate.noteRefusal(jobId, blocker);
    },
    // A probe answered: the tasks a provider outage set aside run again (D7, `network_back`).
    onBreakerTransition: (_lane, transition) => {
      if (transition.to === "closed") void backgroundPolicy?.blockers.notify("network_back");
    }
  });
  soakPreparation?.attach(aiService);
  localModelService = new LocalModelService({
    getPool: () => databaseService?.getPool() ?? null,
    userDataPath: app.getPath("userData"),
    logger: console,
    isPackaged: app.isPackaged,
    workspaceRoot,
    isModelInUse: (localModelId) => aiService?.isLocalModelInUse(localModelId) ?? false,
    testModel: (localModelId) => aiService!.testLocalModel(localModelId),
    onModelSettled: (catalogId) => {
      void firstRunRanker?.onModelSettled(catalogId);
      // Tasks waiting for a model download or verification may run now (F4 D7).
      void backgroundPolicy?.blockers.notify("download_settled");
    },
    onDownload: (event) => events.publish(event),
    // F3 D13: a rebuilt runtime re-validates the ranker with its score-parity check. Golden runs
    // and AI cassettes run no live model, so they never re-validate.
    ...(!process.env.MEMORA_GOLDEN_RUN && aiCassette === null
      ? {
          rankerRuntimeBuild: (localModelId: string) => aiService!.rankerRuntimeBuild(localModelId)
        }
      : {})
  });
  // Owner decision 19: the first run installs the local ranker next to the embedding model, so the
  // topic gate has a decider from the start. Golden runs and DEV AI cassettes pin their own routes
  // and never download a model.
  firstRunRanker = new FirstRunRanker({
    models: localModelService,
    ai: aiService,
    store: settingsFirstRunRankerStore(() => databaseService?.getPool() ?? null),
    enabled: !process.env.MEMORA_GOLDEN_RUN && aiCassette === null,
    logger: console
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
  // The Topic Tree Engine (F2): the topic jobs run on the job supervisor's light lane. The AI
  // service resolves the embedding route's space without a call (D26).
  topicTreeServices = createTopicTreeServices({
    getPool: () => databaseService?.getPool() ?? null,
    spaceResolver: createRouteSpaceResolver({
      getPool: () => databaseService?.getPool() ?? null,
      ai: aiService,
      logger: console
    }),
    env: process.env,
    isPackaged: app.isPackaged,
    wake: () => jobSupervisor?.wake("light"),
    logger: console,
    // The topic IPC (T16) is registered once by the factory; `topicsChanged` reaches every window.
    ipc: { main: ipcMain, targets: () => webContents.getAllWebContents() },
    // Topic names and label vectors (T18) call the AI service in the library's content language.
    ai: aiService,
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    // F4 D16: a note a person edited or accepted is queued for MATCH, once its job type is claimed.
    noteMatching: createNoteMatchRequests({
      getPool: () => databaseService?.getPool() ?? null,
      isRegistered: (type) => jobSupervisor?.supportsJobType(type) === true
    }),
    // F4 T84: REFRESH applies or proposes under the Knowledge controls' autonomy (D12).
    autonomy: async () =>
      backgroundPolicy
        ? (await backgroundPolicy.controls.get()).autonomy
        : defaultKnowledgeControls.autonomy,
    // F4 D13: the tree is built to the shape the person chose (Balanced, the default, is the
    // engine's own configuration). A new shape differs structurally from the stored tree, so the
    // build proposes a rebuild, always for review.
    newTreeConfig: () =>
      topicTreeConfigForPreset(
        backgroundPolicy?.controls.current().treeShape ?? defaultKnowledgeControls.treeShape
      ),
    reviewConfigChanges: true
  });
  // `topicsChanged` stays until F5; the bus carries the same committed, coalesced change as `tree.changed`.
  topicTreeServices.changes.subscribe((change) =>
    events.publish({ type: "tree.changed", ...change })
  );
  libraryResetService = new LibraryResetService({
    // A reset leaves an empty active tree (D39).
    restoreDefaults: async () => {
      await initializeKnowledgeDefaults();
      await topicTreeServices?.ensureActiveTree();
      // The reset cleared the audit and the counters the budget meters with (F4 D14).
      await remoteBudget?.reload();
    },
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get(),
    userDataPath: app.getPath("userData")
  });
  hierarchicalIngestionService = new HierarchicalIngestionService({
    getPool: () => databaseService?.getPool() ?? null,
    topicHooks: topicTreeServices.hooks
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
  // Who writes a relation's explanation now (the prompt and the writer model): the key of a cached
  // explanation includes it, and the Note page judges explanations by it (F3 D22).
  const explanationWriter = createRelationExplanationWriterResolver(
    () => databaseService?.getPool() ?? null
  );
  // The Note page asks for the writer on every read: it is resolved again only when the AI
  // configuration, the prompts or the database change (the page's 5 ms budget).
  const pageExplanationWriter = memoizeRelationExplanationWriter(explanationWriter, () => ({
    pool: databaseService?.getPool() ?? null,
    configuration: aiConfigGeneration(),
    prompts: promptPinGeneration()
  }));
  registerNotePageIpc(
    ipcMain,
    new NotePageService(
      () => databaseService?.getPool() ?? null,
      async () => (await settingsService!.getApp()).contentLanguage,
      pageExplanationWriter
    )
  );
  // Notes whose relations changed outside a link job (a veto, a review) join the supervisor's
  // coalesced push, so open Note pages read their relations once per burst (F3 3.11, 3.19).
  const announceRelationsChanged = (noteIds: string[]) =>
    jobSupervisor?.announceRelationsChanged(noteIds);
  const relationExplanationService = new RelationExplanationService({
    getPool: () => databaseService?.getPool() ?? null,
    ai: aiService,
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    resolveWriter: explanationWriter,
    // An explanation that finds two notes unrelated withdraws the relation: open pages read it again.
    relationsChanged: announceRelationsChanged
  });
  registerRelationExplanationIpc(ipcMain, relationExplanationService);
  const relationReviewService = new RelationReviewService({
    getPool: () => databaseService?.getPool() ?? null,
    relationsChanged: announceRelationsChanged
  });
  registerRelationReviewIpc(ipcMain, relationReviewService);
  // F4 D10: the change-sets of every store through one view and one IPC; the topic engine, the
  // relation event log and the overview repository each undo and review their own exactly.
  const changesService = new ChangesService({
    getPool: () => databaseService?.getPool() ?? null,
    topics: () => topicTreeServices?.service ?? null,
    relationsChanged: announceRelationsChanged,
    // F4 D17: a proposal applied on a moved version is proposed again by REFRESH.
    overviewMoved: (topicId) => void topicTreeServices?.overviewRefresh?.requestTopic(topicId),
    // After an undo or a review committed: Activity, the Inbox and an open topic page read again.
    ...changeSetEventHooks(events)
  });
  registerChangesIpc(ipcMain, changesService);
  registerSourceRelationExplanationIpc(
    ipcMain,
    new SourceRelationExplanationService({
      getPool: () => databaseService?.getPool() ?? null,
      ai: aiService,
      getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage
    })
  );
  const devRelationsConfig = relationsConfigForRun(process.env, app.isPackaged);
  knowledgeService = new KnowledgeService({
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    getPool: () => databaseService?.getPool() ?? null,
    aiService,
    // DEV only: the ranker's helper batch (MEMORA_RELATIONS_HELPER_BATCH, F3 T63's B1) and the source
    // discovery neighbours (MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS, F4 C2) of this run.
    ...(devRelationsConfig ? { relationsConfig: devRelationsConfig } : {}),
    userDataPath: app.getPath("userData"),
    getStorageSettings: () => settingsService!.get(),
    getUploadedFilesBasePath: async () => (await settingsService!.get()).uploadCopiesFolderPath,
    isDebugEnabled: async () => (await settingsService!.getApp()).debugMode,
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
    topicHooks: topicTreeServices.hooks
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
    wake: () => jobSupervisor?.wake(),
    logger: console
  });
  registerConsultationIpc(ipcMain, consultationService, events);
  registerBudgetIpc(
    ipcMain,
    remoteBudget!,
    (task, context) => aiService!.taskRouteModel(task, context),
    budgetRelay
  );
  // DEV relation re-match (MEMORA_RELATIONS_REMATCH, F3 T52b): its heavy job type is registered
  // here; the harness binds its handler once its checks passed (below).
  const rematchSlot =
    !app.isPackaged && process.env.MEMORA_RELATIONS_REMATCH?.trim() ? createRematchJobSlot() : null;
  jobSupervisor = new JobSupervisor({
    ...(rematchSlot ? { devHeavyJobs: rematchSlot.registry } : {}),
    traceOperation: (operation, context, run) =>
      monitoringService.operation(operation, context, run),
    processRelationLabels: (job, signal) =>
      processRelationLabels(databaseService!.getPool()!, aiService!, job, signal),
    getPool: () => databaseService?.getPool() ?? null,
    logger: console,
    knowledgeService,
    obsidianSyncService,
    ...createJobEmbeddingGenerators(aiService!),
    releaseAiRuntime: async () =>
      aiService!.releaseLocalRuntime(
        false,
        (await settingsService!.getApp()).keepLocalEmbeddingModelsLoaded
      ),
    lightJobs: {
      ...topicTreeServices.jobs,
      // F4 D10: the daily retention pass over change-sets and finished jobs.
      [gardenerRetentionJobType]: retentionJobExecutor({
        getPool: () => databaseService?.getPool() ?? null
      }),
      // F4 D18 (T84): the explanation backfill of recently opened notes, on the `relations` worker.
      [relationExplainBackfillJobType]: explainBackfillExecutor({
        getPool: () => databaseService?.getPool() ?? null,
        backfill: (relationId, options) => relationExplanationService.backfill(relationId, options),
        wake: () => jobSupervisor?.wake("light"),
        // The 7-day soak's drop step 3 lowers the day's allowance (DEV, F4 T89).
        ...(soakPreparation?.backfillDailyRelations
          ? { dailyRelations: soakPreparation.backfillDailyRelations }
          : {})
      })
    },
    topicHooks: topicTreeServices.hooks,
    ...(backgroundPolicy ? { backgroundPolicy: backgroundPolicy.jobs } : {})
  });
  // `job.progress` (F4 D26): every state change the supervisor announces becomes one coalesced read of
  // the job counts. `relationsChanged` stays until F5; the bus carries it as `relation.created`.
  jobProgress = connectJobProgress({
    supervisor: jobSupervisor,
    getPool: () => databaseService?.getPool() ?? null,
    publish: (event) => events.publish(event),
    onError: (error) => console.warn(error instanceof Error ? error.message : String(error))
  });
  jobSupervisor.subscribeRelationsChanged((change) =>
    events.publish({ type: "relation.created", noteIds: change.noteIds })
  );
  relationMatchBacklog = new RelationMatchBacklog({
    getPool: () => databaseService!.getPool()!,
    deciderKey: () => knowledgeService!.currentRelationDeciderKey(),
    spaceKey: () => aiService!.embeddingRouteSpaceKey(),
    // F4 Q4: the matching values in force, for the offer that follows a change of them.
    matchingValues: async () => MatchingConfigurationSchema.parse(await settingsService!.getApp()),
    wake: () => jobSupervisor?.wake("light")
  });
  // The Gardener's status (F4 D27): composed from the gates, the blocked and waiting tasks, the AI
  // lanes, the downloads and the budget; pushed as `gardener.status` on change and read over IPC.
  gardenerStatus = new GardenerStatusService({
    store: () => {
      const pool = databaseService?.getPool();
      return pool ? gardenerStatusStoreOf(pool) : null;
    },
    gateHolds: () =>
      backgroundPolicy ? distinctHolds(backgroundPolicy.gate.forKinds(gardenerStatusKinds)) : [],
    budget: async () => (remoteBudget ? await remoteBudget.snapshot() : null),
    lanes: () => aiService?.laneSnapshots() ?? [],
    // A lane's problem holds only the work whose calls take that lane (spec 3.8).
    routeLane: routeLaneOf(() => aiService),
    models: async () => (localModelService ? await localModelService.listStatuses() : []),
    publish: (event) => events.publish(event),
    events,
    signals: backgroundPolicy
      ? [
          (listener) => backgroundPolicy!.controls.subscribe(() => listener()),
          (listener) => backgroundPolicy!.power.subscribe(() => listener())
        ]
      : [],
    logger: console
  });
  registerGardenerStatusIpc(ipcMain, gardenerStatus);
  // The Inbox (F4 D29, T94): the open items of every store in one list, each verb carried out by the
  // store's own writer; its counts are pushed as `inbox.changed`.
  inboxService = new InboxService({
    getPool: () => databaseService?.getPool() ?? null,
    changes: changesService,
    reviewRelation: (input) => relationReviewService.review(input),
    matchBacklog: () => relationMatchBacklog,
    retryJob: (jobId) => jobSupervisor!.retry(jobId),
    budget: {
      snapshot: () => remoteBudget!.snapshot(),
      continue: () => remoteBudget!.continuePastPause()
    },
    obsidianConflicts: async () => {
      const [editorial, wiki] = await Promise.all([
        obsidianSyncService!.editorial.conflicts(),
        obsidianSyncService!.wiki.status()
      ]);
      return [
        ...editorial.map((row) => ({
          id: row.id,
          path: row.path,
          variant: row.receipt.status === "deleted" ? ("deleted" as const) : ("editorial" as const),
          at: null
        })),
        ...wiki.conflicts.map((row) => ({
          id: row.id,
          path: row.relative_path,
          variant: "projection" as const,
          at: null
        }))
      ];
    },
    events,
    logger: console
  });
  registerInboxIpc(ipcMain, inboxService);
  // The hardware profile and the setup recommended for it (F4 D32, T97): probed on the first read,
  // cached under userData/hardware, informative only (decision 26).
  registerHardwareIpc(
    ipcMain,
    new HardwareService({ userDataPath: app.getPath("userData"), logger: console })
  );
  // F4 D31: whether the first-run view is due (an empty library and no record), and how it ended.
  registerOnboardingIpc(
    ipcMain,
    new OnboardingService({
      store: pgOnboardingStore(() => databaseService?.getPool() ?? null)
    })
  );
  // The six Knowledge controls (T98); a new tree shape proposes a rebuild for review (D13).
  registerKnowledgeControlsIpc(ipcMain, () => backgroundPolicy?.controls ?? null, {
    treeShapeChanged: () => void topicTreeServices?.shapeChanged()
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
        // The Knowledge controls, the power signals and the blocker service (F4 T75); the job
        // supervisor re-gates blocked rows before its workers start.
        backgroundPolicy?.start();
        // The tree is planned to the stored shape (D13): the controls are read before the topic
        // jobs can plan a build (the read `start` began is awaited; a failure keeps the defaults).
        await backgroundPolicy?.controls.get().catch(() => undefined);
        gardenerStatus?.start();
        // DEV-only note pair verdicts (MEMORA_GOLDEN_NOTE_PAIRS, golden-note-pairs.ts): exclusive of
        // every other golden knob and checked first, so a refusal quits before a wipe or a reset can run.
        const notePairs =
          !app.isPackaged && process.env.MEMORA_GOLDEN_NOTE_PAIRS
            ? await import("./services/golden-note-pairs.js")
                .then(({ prepareGoldenNotePairs }) =>
                  prepareGoldenNotePairs({
                    env: process.env,
                    isPackaged: app.isPackaged,
                    workspaceRoot,
                    cassette: aiCassette,
                    ai: aiService!,
                    settings: settingsService!,
                    quit: () => app.quit()
                  })
                )
                .catch((error: unknown) => {
                  console.error(
                    "GOLDEN_NOTE_PAIRS refused:",
                    error instanceof Error ? error.message : String(error)
                  );
                  return null;
                })
            : undefined;
        if (notePairs === null) {
          app.quit();
          return;
        }
        // DEV-only relation re-match (MEMORA_RELATIONS_REMATCH, F3 T52b, relations-rematch.ts): its
        // checks run here, before a wipe or a reset can, and a refusal quits with the library untouched.
        // Every other DEV knob is refused beside it; the job it queues starts with the supervisor.
        const rematch = process.env.MEMORA_RELATIONS_REMATCH?.trim()
          ? await import("./services/dev/relations-rematch.js")
              .then(({ prepareRelationsRematch }) =>
                prepareRelationsRematch({
                  env: process.env,
                  isPackaged: app.isPackaged,
                  userDataPath: app.getPath("userData"),
                  workspaceRoot,
                  pool: databaseService!.getPool()!,
                  cassette: aiCassette,
                  knowledge: knowledgeService!,
                  // X3's P0 probe (MEMORA_RELATIONS_REMATCH_P0_PROBE_MS): a query embedding at P0.
                  probeEmbedding: async (text) => {
                    await aiService!.runDefaultTask("embedding", text, {
                      stage: "rematch_p0_probe",
                      embeddingInputType: "query",
                      workloadClass: "embed",
                      priority: "P0",
                      budgetClass: "interactive"
                    });
                  },
                  jobs: jobSupervisor!,
                  slot: rematchSlot ?? createRematchJobSlot(),
                  quit: () => app.quit(),
                  logger: console
                })
              )
              .catch((error: unknown) => {
                console.error(
                  "RELATIONS_REMATCH refused:",
                  error instanceof Error ? error.message : String(error)
                );
                return null;
              })
          : undefined;
        if (rematch === null) {
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
                    // MEMORA_GOLDEN_TOPICS=full (G1, D23): the topic service's hold and release.
                    topicBarrier: topicTreeServices!.goldenBarrier,
                    // MEMORA_GOLDEN_SOURCE_PAIRS only: the source decider runs through the normal AI service.
                    ai: aiService!,
                    // MEMORA_GOLDEN_STRICT_PROBE only: the same AI service and the Ask's own service.
                    strictProbe: { ai: aiService!, consultation: consultationService },
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
        // may be one) start, so no job, capture or vault sync can change it meanwhile. So does the
        // DEV lane probe (MEMORA_DEV_LANE_PROBE, F3 B5): nothing else may use the lane it measures. Nor
        // does the typer's position-bias check (MEMORA_TYPER_CHECK), and the explanation probe
        // (MEMORA_DEV_EXPLAIN_PROBE, F3 T59): nothing else may use the writer it measures.
        const laneProbe = laneProbeRequested(process.env, {
          isPackaged: app.isPackaged,
          workspaceRoot
        });
        const explainProbe = explainProbeRequested(process.env, {
          isPackaged: app.isPackaged,
          workspaceRoot,
          userDataPath: app.getPath("userData")
        });
        const typerCheck = !app.isPackaged && Boolean(process.env.MEMORA_TYPER_CHECK);
        const verdictOnly =
          goldenRun?.sourcePairs?.mode === "verdict_only" ||
          notePairs !== undefined ||
          laneProbe ||
          explainProbe ||
          soakSetup ||
          typerCheck;
        // A re-match changes relations only: its job runs on the supervisor, but no topic sweep,
        // capture or vault sync may change the clone meanwhile.
        const libraryQuiet = verdictOnly || rematch !== undefined;
        // The active topic tree exists (D39) and its sweep is queued before the light lane starts.
        if (!libraryQuiet) await topicTreeServices?.start();
        // F4 D10: retention runs a while after the start, then daily; a pass already due stays due.
        if (!libraryQuiet) {
          await scheduleRetention(
            createJobRepository(databaseService!.getPool()!),
            retentionStartDelayMs
          ).catch((error: unknown) => console.error("Retention could not be scheduled", error));
        }
        // F4 D18: the explanation backfill's pass, a while after the start, then daily. Golden runs
        // and AI cassettes replay what they recorded and never queue it.
        if (!libraryQuiet && !process.env.MEMORA_GOLDEN_RUN && aiCassette === null) {
          await scheduleExplainBackfillPass(
            createJobRepository(databaseService!.getPool()!),
            relationExplainBackfillConfig.startDelayMs
          ).catch((error: unknown) =>
            console.error("The explanation backfill could not be scheduled", error)
          );
        }
        // DEV fake remote providers (MEMORA_FAKE_REMOTE, F3 T62): listening, and the routes that lead
        // to them in place, before any job can make a call.
        if (soakPreparation) {
          try {
            await soakPreparation.startFakes({
              pool: databaseService!.getPool()!,
              credentials: new CredentialService(app.getPath("userData")),
              setAnswerRoute: (profileId) =>
                aiService!.setClassRoute({ route: "answer", profileId })
            });
          } catch (error) {
            console.error(
              `SOAK fake providers failed: ${error instanceof Error ? error.message : String(error)}`
            );
            app.exit(1);
            return;
          }
        }
        await Promise.all([
          // DEV-only (MEMORA_LOCAL_MODEL_INSTALL, needs MEMORA_LOCAL_MODEL_SEED_DIR): once the local
          // models are started, installs the named catalog models from the seed folder and gives them
          // a profile, so `class:decide` routes to a ranker. It never throws, and the golden run and
          // the pilots below wait for it. Refused (logged, ignored) when packaged.
          localModelService
            ?.start()
            .then(() =>
              localModelService && aiService
                ? runLocalModelInstallStartup({
                    env: process.env,
                    isPackaged: app.isPackaged,
                    workspaceRoot,
                    models: localModelService,
                    ai: aiService,
                    logger: console
                  })
                : undefined
            )
            // Decision 19: finishes a first-run ranker an earlier start left (never throws).
            .then(() => firstRunRanker?.ensure()),
          verdictOnly ? undefined : jobSupervisor?.start(),
          libraryQuiet ? undefined : integrationGateway?.start(),
          libraryQuiet ? undefined : obsidianSyncService?.reconcileVault()
        ]);
        // F4 D16: a note decider that changed while the app was closed offers its optional re-match
        // (an Inbox item); nothing is queued until the owner accepts. Best effort, in the background.
        if (!libraryQuiet)
          void relationMatchBacklog?.offer().catch((error: unknown) => {
            console.warn("The MATCH backlog could not be offered", error);
          });
        // F4 D29: the Inbox follows the stores' events and the budget once the library is up.
        if (!libraryQuiet) inboxService?.start();
        // F4 Q4: the first sight of the matching values opens their history; a change made while the
        // app was closed is offered like one made in Settings. Nothing is queued either way.
        if (!libraryQuiet)
          void relationMatchBacklog?.offerSettings().catch((error: unknown) => {
            console.warn("The matching values could not be noted", error);
          });
        // DEV soak profile setup (MEMORA_SOAK_SETUP=1, F3 T62): the models are up, no job has started.
        // The Local preset, the checks and `.cache/f3/soak/setup.json`, then quit.
        if (soakSetup) {
          const outcome = await runSoakSetup({
            env: process.env,
            isPackaged: app.isPackaged,
            workspaceRoot,
            userDataPath: app.getPath("userData"),
            pool: databaseService!.getPool()!,
            ai: aiService!,
            logger: console
          }).catch((error: unknown) => {
            console.error(
              `SOAK_SETUP failed: ${error instanceof Error ? error.message : String(error)}`
            );
            return "failed" as const;
          });
          if (outcome !== "ok") process.exitCode = 1;
          app.quit();
          return;
        }
        // DEV soak driver (MEMORA_SOAK, F3 T62): the timeline of a day on the real services, until
        // its duration ends or a STOP file appears in its run directory, then the app quits.
        if (soakPreparation?.mode === "soak") {
          void soakPreparation
            .startDriver({
              pool: databaseService!.getPool()!,
              ai: aiService!,
              ingestion: ingestionService!,
              knowledge: knowledgeService!,
              consultation: consultationService,
              explanations: relationExplanationService,
              jobs: { wake: () => jobSupervisor?.wake() },
              // The 7-day profile's services (F4 T89). `status` is the Gardener's status service
              // (T86): the soak is refused without it.
              ...(backgroundPolicy && remoteBudget && topicTreeServices?.overview
                ? {
                    f4: {
                      topicOverview: (topicId: string) =>
                        topicTreeServices!.overview!.overview({ id: topicId }),
                      requestAudit: (treeId: string) =>
                        topicTreeServices!.triggers.request("topic-audit", treeId, null, {
                          debounce: immediateDebounce
                        }),
                      controls: backgroundPolicy.controls,
                      power: backgroundPolicy.power,
                      budget: remoteBudget,
                      budgetChanged: () => budgetRelay.changed(),
                      // The sentence E5 samples every minute (F4 D27): the app's own service.
                      status: gardenerStatus,
                      publishModelDownload: (event) => appEvents?.publish(event),
                      credentials: new CredentialService(app.getPath("userData"))
                    }
                  }
                : {})
            })
            .catch((error: unknown) =>
              console.error("SOAK failed:", error instanceof Error ? error.message : String(error))
            )
            .finally(() => {
              // The driver ended (its duration, a STOP file, or a failure): the app quits, and the
              // quit path bounds every step it takes (application-shutdown.ts).
              console.info("SOAK: the driver ended; quitting");
              if (!app.isPackaged) app.quit();
            });
        }
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
        // DEV-only lane probe (MEMORA_DEV_LANE_PROBE=<report path>, F3 B5): decide-sized calls at
        // concurrency 1, 2 and 3 through the AI service, a JSON report, then quit. Refused (logged,
        // ignored) when packaged or together with another DEV measurement knob.
        if (process.env.MEMORA_DEV_LANE_PROBE) {
          void runLaneProbe({
            env: process.env,
            isPackaged: app.isPackaged,
            workspaceRoot,
            ai: aiService!,
            logger: console
          })
            .then((outcome) => {
              if (outcome === "done" || outcome === "failed") app.quit();
            })
            .catch((error: unknown) => {
              console.error(
                "LANE_PROBE failed:",
                error instanceof Error ? error.message : String(error)
              );
              if (!app.isPackaged) app.quit();
            });
        }
        // DEV-only explanation probe (MEMORA_DEV_EXPLAIN_PROBE=<report path>, F3 T59): opens
        // relations the way the Note page does, twice, a JSON report, then quit. Refused (logged,
        // ignored, the app goes on) when packaged, on a profile that is not a clone inside
        // .cache/profiles/, or together with another DEV measurement knob.
        if (process.env.MEMORA_DEV_EXPLAIN_PROBE) {
          void runExplainProbe({
            env: process.env,
            isPackaged: app.isPackaged,
            workspaceRoot,
            userDataPath: app.getPath("userData"),
            pool: databaseService!.getPool()!,
            ai: aiService!,
            getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
            resolveWriter: explanationWriter,
            logger: console
          })
            .then((outcome) => {
              if (outcome === "done" || outcome === "failed") app.quit();
            })
            .catch((error: unknown) => {
              console.error(
                "EXPLAIN_PROBE failed:",
                error instanceof Error ? error.message : String(error)
              );
              if (!app.isPackaged) app.quit();
            });
        }
        if (typerCheck) {
          // F3 G25: types the pairs of a file in both orders and writes the report; persists nothing.
          // Its DEV options (plan decision 29) type in content order only or with a catalog
          // candidate of the typing prompt.
          void import("./services/relations/relation-typing-check.js")
            .then(({ readTyperCheckEnvironment, runTyperCheckFromEnvironment }) => {
              const environment = readTyperCheckEnvironment(process.env, {
                isPackaged: app.isPackaged,
                workspaceRoot
              });
              if (!environment) return undefined;
              return runTyperCheckFromEnvironment({
                environment,
                workspaceRoot,
                pool: databaseService!.getPool()!,
                ai: aiService!,
                readContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
                quit: () => app.quit()
              });
            })
            .catch((error: unknown) => {
              console.error(
                "TYPER_CHECK failed:",
                error instanceof Error ? error.message : String(error)
              );
              app.quit();
            });
        }
        void goldenRun?.start();
        void notePairs?.start();
        void rematch?.start();
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
  void applicationShutdown.begin();
});

/**
 * The quit path (application-shutdown.ts): the services stop in this order, each within its bound,
 * and a step that overruns is logged by name and left behind, so the database is always asked to
 * stop and the process always ends. The bounds are generous: a normal quit takes seconds.
 */
const applicationShutdown = createApplicationShutdown({
  steps: shutdownSteps,
  logger: console,
  quit: () => {
    isQuittingAfterShutdown = true;
    app.quit();
  },
  exit: () => app.exit(Number(process.exitCode ?? 0))
});

function shutdownSteps(): ShutdownStep[] {
  return [
    {
      name: "window and tray",
      timeoutMs: 2_000,
      run: () => {
        activeMainWindow?.destroy();
        activeMainWindow = null;
        tray?.destroy();
        tray = null;
      }
    },
    {
      name: "service startup",
      // A quit during the first start waits for the migrations the start runs, not for ever.
      timeoutMs: 300_000,
      run: async () => {
        await serviceStartupPromise;
        serviceStartupPromise = null;
      }
    },
    {
      name: "soak driver and fake providers",
      timeoutMs: 10_000,
      run: async () => {
        await soakPreparation?.stop();
        soakPreparation = null;
      }
    },
    {
      name: "integration gateway",
      timeoutMs: 10_000,
      run: async () => {
        await integrationGateway?.stop();
        integrationGateway = null;
      }
    },
    {
      name: "job supervisor",
      timeoutMs: 30_000,
      run: async () => {
        await jobSupervisor?.stop();
        jobSupervisor = null;
        relationMatchBacklog = null;
        backgroundPolicy?.stop();
      },
      describe: () =>
        `jobs in flight: ${jobSupervisor?.inFlightJobIds().join(", ") || "none"}; ${describeAiLanes()}`
    },
    {
      name: "topic tree",
      timeoutMs: 5_000,
      run: () => {
        topicTreeServices?.dispose();
        topicTreeServices = null;
      }
    },
    {
      name: "local models",
      timeoutMs: 15_000,
      run: async () => {
        await localModelService?.shutdown();
        localModelService = null;
        backupService = null;
        libraryResetService = null;
        searchService = null;
        knowledgeService = null;
      }
    },
    {
      name: "Obsidian sync",
      timeoutMs: 15_000,
      run: async () => {
        await obsidianSyncService?.shutdown();
        obsidianSyncService = null;
        ingestionService = null;
        metadataEnrichmentService = null;
      }
    },
    {
      name: "AI runtime",
      timeoutMs: 15_000,
      run: async () => {
        await aiService?.dispose();
      },
      describe: describeAiLanes
    },
    {
      name: "settings",
      timeoutMs: 5_000,
      run: async () => {
        aiService = null;
        await settingsService?.dispose();
        settingsService = null;
      }
    },
    {
      name: "event bus",
      timeoutMs: 2_000,
      run: () => {
        gardenerStatus?.stop();
        gardenerStatus = null;
        inboxService?.dispose();
        inboxService = null;
        jobProgress?.dispose();
        jobProgress = null;
        appEvents?.dispose();
        appEvents = null;
      }
    },
    {
      name: "database",
      timeoutMs: 45_000,
      run: async () => {
        await databaseService?.stop();
        databaseService = null;
      }
    }
  ];
}

function describeAiLanes(): string {
  return aiService ? describeLanes(aiService.laneSnapshots()) : "no AI service";
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

function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readGatewayPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}
