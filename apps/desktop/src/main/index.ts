import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { createTranslator } from "@app/i18n";
import { registerIpcHandlers } from "./ipc";
import { DatabaseService } from "./services/database-service";
import { SettingsService } from "./services/settings-service";
import { AiService } from "./services/ai-service.js";
import { IngestionService } from "./services/ingestion-service.js";
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

const configuredUserDataPath = process.env.MEMORA_USER_DATA_DIR?.trim();
if (configuredUserDataPath) app.setPath("userData", resolve(configuredUserDataPath));

const trayIconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR4nGNgoBH4jwNTpJkoQwhpxmsIsZqxGkKqZgxDRg2gggEURyNVEhKxhhAFKNJMEgAA0ICbZZSdbUEAAAAASUVORK5CYII=";

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
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
    mainWindow.hide();
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

  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      console.warn(`Renderer console: ${message}`);
    }
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
    getUiLanguage: async () => (await settingsService!.getApp()).language,
    debugLogLocalModelOutput: readBooleanFlag(process.env.MEMORA_DEBUG_LOCAL_MODEL_OUTPUT)
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
  ingestionService = new IngestionService({
    getPool: () => databaseService?.getPool() ?? null,
    getStorageSettings: () => settingsService!.get(),
    userDataPath: app.getPath("userData"),
    resourcesPath: getResourcesPath(),
    workspaceRoot,
    isPackaged: app.isPackaged
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
    getUploadedFilesBasePath: async () => (await settingsService!.get()).uploadCopiesFolderPath,
    isDebugEnabled: async () => (await settingsService!.getApp()).debugMode,
    getRelationThreshold: async () => (await settingsService!.getApp()).atomicNoteRelationThreshold,
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
    generateEmbedding: async (text) => {
      const result = await aiService?.runDefaultTask("embedding", text);
      if (!result || !Array.isArray(result.output)) return null;
      return {
        embedding: result.output.map(Number),
        provider: result.providerId,
        model: result.modelId,
        runtime: result.runtime
      };
    }
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
    jobSupervisor,
    searchService,
    aiService,
    knowledgeService,
    integrationGateway,
    localModelService,
    backupService,
    libraryResetService,
    similarityDebugService
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
  // Keep the app resident in the tray until the explicit quit action runs.
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

function readBooleanFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function readGatewayPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}
