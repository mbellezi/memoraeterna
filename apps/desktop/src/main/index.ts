import { parseObsidianDeepLink, type ObsidianDeepLink } from "../shared/obsidian-deep-link.js";
import { MaintenanceService } from "./services/maintenance-service.js";
import { MaintenanceCommandSchema } from "@app/domain";
import { reconcileOrganizationParticipation } from "./services/organization-participation.js";
import { ConsultationService } from "./services/consultation-service.js";
import { registerConsultationIpc } from "./services/consultation-ipc.js";
import { OrganizationService } from "./services/organization-service.js";
import { registerOrganizationIpc } from "./services/organization-ipc.js";
import { WikiService } from "./services/wiki-service.js";
import { registerWikiIpc } from "./services/wiki-ipc.js";
import { MonitoringService } from "./services/monitoring-service.js";
import { processRelationLabels } from "./services/relation-label-processing.js";
import { CredentialService } from "./services/credential-service";
import { join, resolve } from "node:path";
import { app, powerMonitor, BrowserWindow, ipcMain, Menu, nativeImage, net, shell, Tray, webContents } from "electron";
import { createTranslator } from "@app/i18n";
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
import { resolveWorkspaceRoot } from "./services/workspace-paths.js";
import { LibraryResetService } from "./services/library-reset-service.js";
import { SimilarityDebugService } from "./services/similarity-debug-service.js";
import { MetadataEnrichmentService } from "./services/metadata-enrichment-service.js";
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
    const direction = navigationDirectionFromInput(input);
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
let activeMainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serviceStartupPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let isShutdownInProgress = false;
let isQuittingAfterShutdown = false;

const primaryInstance=app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
let pendingObsidianOpen:ObsidianDeepLink|null=null;
function receiveObsidianOpen(raw:string){const target=parseObsidianDeepLink(raw);if(!target)return;pendingObsidianOpen=target;for(const window of BrowserWindow.getAllWindows()){if(!window.webContents.isLoading())window.webContents.send(ipcChannels.obsidianDeepLink,target);}}
app.on('open-url',(event,url)=>{event.preventDefault();receiveObsidianOpen(url);});
app.on('second-instance',(_event,args)=>{for(const arg of args)if(arg.startsWith('memora:'))receiveObsidianOpen(arg);});
for(const arg of process.argv)if(arg.startsWith('memora:'))receiveObsidianOpen(arg);
ipcMain.handle(ipcChannels.obsidianDeepLinkPending,()=>{const target=pendingObsidianOpen;pendingObsidianOpen=null;return target;});

void app.whenReady().then(() => {
  if(!primaryInstance)return;
  app.setName(createTranslator(app.getLocale())("app.title"));
  if(app.isPackaged)app.setAsDefaultProtocolClient("memora");
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
  const monitoringService = new MonitoringService(() => databaseService?.getPool() ?? null, () => settingsService!.getApp());
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
    getKeepLocalEmbeddingModelsLoaded: async () => (await settingsService!.getApp()).keepLocalEmbeddingModelsLoaded,
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
    isModelInUse: (localModelId) => aiService?.isLocalModelInUse(localModelId) ?? false,
    testModel: (localModelId) => aiService!.testLocalModel(localModelId)
  });
  backupService = new BackupService({
    getDatabaseContext: () => databaseService?.getBackupContext() ?? null,
    getStorageSettings: () => settingsService!.get()
  });
  libraryResetService = new LibraryResetService({
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get(),
    userDataPath: app.getPath("userData")
  });
  hierarchicalIngestionService = new HierarchicalIngestionService({
    getPool: () => databaseService?.getPool() ?? null
  });
  ingestionService = new IngestionService({
    traceOperation: (operation, context, run) => monitoringService.operation(operation, context, run),
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get(),
    userDataPath: app.getPath("userData"),
    resourcesPath: getResourcesPath(),
    workspaceRoot,
    isPackaged: app.isPackaged,
    hierarchicalIngestionService,
    fetchExternalPage: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true })
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
  const relationThreshold = readRelationThreshold(process.env.MEMORA_ATOMIC_NOTE_RELATION_THRESHOLD);
  knowledgeService = new KnowledgeService({
    getContentLanguage: async () => (await settingsService!.getApp()).contentLanguage,
    getPool: () => databaseService?.getPool() ?? null,
    aiService,
    userDataPath: app.getPath("userData"),
    getStorageSettings: () => settingsService!.get(),
    getUploadedFilesBasePath: async () => (await settingsService!.get()).uploadCopiesFolderPath,
    isDebugEnabled: async () => (await settingsService!.getApp()).debugMode,
    getRelationThreshold: async () => (await settingsService!.getApp()).atomicNoteRelationThreshold,
    getAtomicNoteMatchingSettings: async () => (await settingsService!.getApp()).atomicNoteMatchingSettings,
    getCanonicalMatchingSettings: async () => (await settingsService!.getApp()).canonicalMatchingSettings,
    getSourceRelationSettings: async () => (await settingsService!.getApp()).sourceRelationSettings,
    getSummaryMinimumWordCount: async () => (await settingsService!.getApp()).summaryMinimumWordCount,
    getEntityIdentitySimilarityThreshold: async () => (await settingsService!.getApp()).entityIdentitySimilarityThreshold,
    getRelationTypeSimilarityThreshold: async () => (await settingsService!.getApp()).relationTypeSimilarityThreshold,
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
    getLocale:async()=>(await settingsService!.getApp()).contentLanguage,
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get()
  });
  const consultationService=new ConsultationService({getPool:()=>databaseService?.getPool()??null,ai:aiService,contentLanguage:async()=>(await settingsService!.getApp()).contentLanguage,wake:()=>jobSupervisor?.wake()});
  const maintenanceService=new MaintenanceService({getPool:()=>databaseService?.getPool()??null,ai:aiService,contentLanguage:async()=>(await settingsService!.getApp()).contentLanguage,wake:()=>jobSupervisor?.wake(),cancelJob:id=>jobSupervisor!.requestCancel(id),idleSeconds:()=>powerMonitor.getSystemIdleTime(),aiBusy:()=>aiService!.isBusy()});
  ipcMain.handle(ipcChannels.maintenanceCommand,(_event,input:unknown)=>maintenanceService.command(MaintenanceCommandSchema.parse(input)));
  const organizationService = new OrganizationService({sampleMaintenance:(...args)=>maintenanceService.sample(...args),validateMaintenanceActivation:(...args)=>maintenanceService.validateActivation(...args),sampleConsultation:(revisionId,profileId,privacy,domainId)=>consultationService.sample(revisionId,profileId,privacy,domainId),getPool:()=>databaseService?.getPool()??null,ai:aiService,contentLanguage:async()=>(await settingsService!.getApp()).contentLanguage,wake:()=>jobSupervisor?.wake(),cancelJob:(id)=>jobSupervisor!.requestCancel(id)});
  registerOrganizationIpc(ipcMain,organizationService);
  registerConsultationIpc(ipcMain,consultationService);
  jobSupervisor = new JobSupervisor({
    maintenanceTick:()=>maintenanceService.tick(),maintenanceReady:job=>maintenanceService.ready(job),processMaintenance:(job,signal)=>maintenanceService.execute(job,signal),
    reconcileOrganization:()=>reconcileOrganizationParticipation(databaseService!.getPool()!,organizationService),
    processOrganization:(job,signal)=>organizationService.execute(job,signal),
    traceOperation: (operation, context, run) => monitoringService.operation(operation, context, run),
    processRelationLabels: (job, signal) => processRelationLabels(databaseService!.getPool()!, aiService!, job, signal),
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
    releaseAiRuntime: async () => aiService!.releaseLocalRuntime(
      false,
      (await settingsService!.getApp()).keepLocalEmbeddingModelsLoaded
    )
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
  serviceStartupPromise = databaseService.start().then(async (status) => {
    if (status.state === "ready") {
      await monitoringService.recover();
      await Promise.all([
        localModelService?.start(),
        jobSupervisor?.start(),
        integrationGateway?.start(),
        obsidianSyncService?.reconcileVault()
      ]);
      if (!app.isPackaged && process.env.MEMORA_MATCHING_PILOT) {
        void import("./services/matching-pilot.js").then(({ runMatchingPilot }) => runMatchingPilot({
          mode: process.env.MEMORA_MATCHING_PILOT!, isPackaged: app.isPackaged,
          userDataPath: app.getPath("userData"), workspaceRoot, pool: databaseService!.getPool()!,
          ingestion: ingestionService!, hierarchy: hierarchicalIngestionService!, settings: settingsService!, jobs: jobSupervisor!, backup: backupService!
        })).catch((error: unknown) => console.error("MATCHING_PILOT failed:", error instanceof Error ? error.message : String(error)));
      }
      if (!app.isPackaged && process.env.MEMORA_MATCHING_BENCHMARK) {
        void import("./services/matching-benchmark.js").then(({ runMatchingBenchmark }) => runMatchingBenchmark({
          mode: "benchmark", isPackaged: app.isPackaged, userDataPath: app.getPath("userData"), workspaceRoot,
          pool: databaseService!.getPool()!, ingestion: ingestionService!, hierarchy: hierarchicalIngestionService!,
          settings: settingsService!, jobs: jobSupervisor!, backup: backupService!, ai: aiService!
        })).catch((error: unknown) => console.error("MATCHING_BENCHMARK failed:", error instanceof Error ? error.message : String(error)));
      }
      const autoQuitMs = readPositiveInteger(process.env.MEMORA_SMOKE_AUTO_QUIT_MS);
      if (autoQuitMs !== undefined) setTimeout(() => app.quit(), autoQuitMs);
    }
  }).catch((error: unknown) => {
    console.error(`Service startup failed: ${error instanceof Error ? error.message : String(error)}`);
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
