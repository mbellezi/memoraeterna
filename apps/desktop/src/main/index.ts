import { CredentialService } from "./services/credential-service";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, shell, Tray, webContents } from "electron";
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
    mainWindow.show();
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

void app.whenReady().then(() => {
  app.setName(createTranslator(app.getLocale())("app.title"));
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
  aiService = new AiService({
    userDataPath: app.getPath("userData"),
    getPool: () => databaseService?.getPool() ?? null,
    workspaceRoot,
    resourcesPath: getResourcesPath(),
    isPackaged: app.isPackaged,
    logger: console,
    openExternal: (url) => shell.openExternal(url),
    getUiLanguage: async () => (await settingsService!.getApp()).language,
    getDashboardDebugMode: async () => (await settingsService!.getApp()).debugMode,
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
  const relationThreshold = readRelationThreshold(process.env.MEMORA_ATOMIC_NOTE_RELATION_THRESHOLD);
  knowledgeService = new KnowledgeService({
    getPool: () => databaseService?.getPool() ?? null,
    aiService,
    userDataPath: app.getPath("userData"),
    getStorageSettings: () => settingsService!.get(),
    getUploadedFilesBasePath: async () => (await settingsService!.get()).uploadCopiesFolderPath,
    isDebugEnabled: async () => (await settingsService!.getApp()).debugMode,
    getRelationThreshold: async () => (await settingsService!.getApp()).atomicNoteRelationThreshold,
    getSummaryMinimumWordCount: async () => (await settingsService!.getApp()).summaryMinimumWordCount,
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
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get()
  });
  jobSupervisor = new JobSupervisor({
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
        runtime: result.runtime
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
    obsidianSyncService
  );
  createApplicationTray();
  activeMainWindow = createMainWindow();
  serviceStartupPromise = databaseService.start().then(async (status) => {
    if (status.state === "ready") {
      await Promise.all([
        localModelService?.start(),
        jobSupervisor?.start(),
        integrationGateway?.start(),
        obsidianSyncService?.reconcileVault()
      ]);
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
