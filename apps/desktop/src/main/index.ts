import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { createTranslator } from "@app/i18n";
import { registerIpcHandlers } from "./ipc";
import { DatabaseService } from "./services/database-service";
import { SettingsService } from "./services/settings-service";

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
    if (isQuittingAfterShutdown) {
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
let activeMainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let shutdownPromise: Promise<void> | null = null;
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
  registerIpcHandlers(ipcMain, settingsService, databaseService);
  createApplicationTray();
  activeMainWindow = createMainWindow();
  void databaseService.start();

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
  shutdownPromise ??= shutdownServices().finally(() => {
    isQuittingAfterShutdown = true;
    app.quit();
  });
});

async function shutdownServices(): Promise<void> {
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
