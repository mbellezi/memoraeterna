import { useEffect, useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  Bug,
  ClipboardCheck,
  Database,
  Download,
  Moon,
  RefreshCw,
  Search,
  Settings,
  SquareLibrary,
  Sun
} from "lucide-react";
import {
  createTranslator,
  normalizeLanguageCode,
  type LanguageCode,
  type MessageKey
} from "@app/i18n";
import type {
  AppSettings,
  AppSettingsUpdate,
  DatabaseStatus,
  StorageSettings,
  SystemInfo
} from "../shared/ipc";
import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  storageSettingsSchema
} from "../shared/ipc";
import { cn } from "./lib/cn";
import { SettingsView } from "./components/SettingsView";
import { ImportView } from "./components/ImportView";
import { JobsView } from "./components/JobsView";
import { SearchView } from "./components/SearchView";
import { LibraryView } from "./components/LibraryView";
import { ReviewQueueView } from "./components/ReviewQueueView";
import { DebugDashboard } from "./components/DebugDashboard";

type ViewId = "library" | "import" | "search" | "review" | "jobs" | "debug" | "settings";

interface NavItem {
  id: ViewId;
  label: MessageKey;
  icon: typeof SquareLibrary;
}

const navItems: NavItem[] = [
  { id: "library", label: "shell.navigation.library", icon: SquareLibrary },
  { id: "import", label: "shell.navigation.import", icon: Download },
  { id: "search", label: "shell.navigation.search", icon: Search },
  { id: "review", label: "shell.navigation.review", icon: ClipboardCheck },
  { id: "jobs", label: "shell.navigation.jobs", icon: BriefcaseBusiness },
  { id: "debug", label: "debug.title", icon: Bug },
  { id: "settings", label: "shell.navigation.settings", icon: Settings }
];

const emptyViews: Record<Exclude<ViewId, "settings" | "review" | "debug">, { title: MessageKey; empty: MessageKey }> = {
  library: { title: "shell.navigation.library", empty: "shell.states.empty" },
  import: { title: "shell.navigation.import", empty: "shell.states.empty" },
  search: { title: "shell.navigation.search", empty: "shell.states.empty" },
  jobs: { title: "jobs.title", empty: "shell.states.empty" }
};

const databasePollIntervalMs = 300;
const databaseStartupTimeoutMs = 60_000;

function createDefaultSettings(): StorageSettings {
  return storageSettingsSchema.parse({
    ...defaultStorageSettings,
    updatedAt: new Date(0).toISOString()
  });
}

function createDefaultAppSettings(locale?: string | null): AppSettings {
  return appSettingsSchema.parse({
    ...defaultAppSettings,
    language: normalizeLanguageCode(locale),
    updatedAt: new Date(0).toISOString()
  });
}

function createInitialDatabaseStatus(): DatabaseStatus {
  return {
    state: "starting",
    messageKey: "database.status.starting",
    updatedAt: new Date(0).toISOString()
  };
}

interface AppProps {
  initialDatabaseStatus?: DatabaseStatus;
  initialAppSettings?: AppSettings;
  initialSettings?: StorageSettings;
  initialSystemInfo?: SystemInfo | null;
}

export function App({
  initialDatabaseStatus,
  initialAppSettings,
  initialSettings,
  initialSystemInfo = null
}: AppProps) {
  const [activeView, setActiveView] = useState<ViewId>("library");
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>(
    initialDatabaseStatus ?? createInitialDatabaseStatus()
  );
  const [appSettings, setAppSettings] = useState<AppSettings>(
    initialAppSettings ?? createDefaultAppSettings(initialSystemInfo?.locale ?? getBrowserLocale())
  );
  const [settings, setSettings] = useState<StorageSettings>(initialSettings ?? createDefaultSettings());
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(initialSystemInfo);
  const [status, setStatus] = useState<MessageKey>("shell.states.loading");
  const [hasLoadedAppData, setHasLoadedAppData] = useState(Boolean(initialSettings));
  const [isSaving, setIsSaving] = useState(false);
  const t = useMemo(() => createTranslator(appSettings.language), [appSettings.language]);
  const isDarkMode = appSettings.themeMode === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
    document.documentElement.style.colorScheme = isDarkMode ? "dark" : "light";
  }, [isDarkMode]);

  async function loadAppData() {
    const [loadedAppSettings, loadedSettings, loadedSystemInfo] = await Promise.all([
      window.app.settings.getApp(),
      window.app.settings.get(),
      window.app.system.getInfo()
    ]);

    setAppSettings(loadedAppSettings);
    setSettings(loadedSettings);
    setSystemInfo(loadedSystemInfo);
    setHasLoadedAppData(true);
    setStatus("shell.states.ready");
  }

  async function bootstrap() {
    setStatus("shell.states.loading");
    void loadSystemInfo();
    setDatabaseStatus((current) => ({
      ...current,
      state: current.state === "failed" ? "starting" : current.state,
      messageKey: current.state === "failed" ? "database.status.starting" : current.messageKey,
      updatedAt: new Date().toISOString()
    }));

    void window.app.database.start().catch(() => undefined);
    const nextDatabaseStatus = await waitForDatabaseReady();
    setDatabaseStatus(nextDatabaseStatus);

    if (nextDatabaseStatus.state !== "ready") {
      setStatus("errors.database.notReady");
      return;
    }

    await loadAppData();
  }

  async function loadSystemInfo() {
    try {
      const loadedSystemInfo = await window.app.system.getInfo();
      setSystemInfo(loadedSystemInfo);
      setAppSettings((current) => {
        if (current.updatedAt !== new Date(0).toISOString()) {
          return current;
        }

        return appSettingsSchema.parse({
          ...current,
          language: normalizeLanguageCode(loadedSystemInfo.locale)
        });
      });
    } catch {
      setAppSettings((current) => ({
        ...current,
        language: normalizeLanguageCode(current.language)
      }));
    }
  }

  useEffect(() => {
    let isMounted = true;

    async function load() {
      try {
        await bootstrap();
      } catch {
        if (isMounted) {
          setStatus("errors.common.unknown");
          setDatabaseStatus({
            state: "failed",
            messageKey: "database.status.failed",
            updatedAt: new Date().toISOString()
          });
        }
      }
    }

    if (!hasLoadedAppData) {
      void load();
    }

    return () => {
      isMounted = false;
    };
  }, [hasLoadedAppData]);

  async function saveSettings() {
    setIsSaving(true);
    setStatus("shell.states.loading");

    try {
      const [savedAppSettings, savedStorageSettings] = await Promise.all([
        window.app.settings.updateApp({
          language: appSettings.language,
          themeMode: appSettings.themeMode,
          atomicNoteRelationThreshold: appSettings.atomicNoteRelationThreshold
        }),
        window.app.settings.update({
          obsidianVaultPath: settings.obsidianVaultPath,
          managedRoot: settings.managedRoot,
          obsidianSyncEnabled: settings.obsidianSyncEnabled,
          obsidianSyncPaused: settings.obsidianSyncPaused,
          deletionPolicy: settings.deletionPolicy,
          uploadCopiesEnabled: settings.uploadCopiesEnabled,
          uploadCopiesFolderPath: settings.uploadCopiesFolderPath
        })
      ]);
      setAppSettings(savedAppSettings);
      setSettings(savedStorageSettings);
      setStatus("shell.states.saved");
    } catch (error) {
      const key = error instanceof Error && error.message.startsWith("errors.") ? error.message : "errors.common.unknown";
      setStatus(key as MessageKey);
    } finally {
      setIsSaving(false);
    }
  }

  async function updateAppSettings(update: AppSettingsUpdate) {
    setAppSettings((current) =>
      appSettingsSchema.parse({
        ...current,
        ...update,
        updatedAt: new Date().toISOString()
      })
    );
  }

  async function persistRelationThreshold(atomicNoteRelationThreshold: number) {
    try {
      setAppSettings(await window.app.settings.updateApp({ atomicNoteRelationThreshold }));
      setStatus("shell.states.saved");
    } catch {
      setStatus("errors.common.unknown");
      throw new Error("relation_threshold_update_failed");
    }
  }

  async function toggleThemeMode() {
    const previous = appSettings;
    const nextThemeMode = appSettings.themeMode === "dark" ? "light" : "dark";
    const nextSettings = appSettingsSchema.parse({
      ...appSettings,
      themeMode: nextThemeMode,
      updatedAt: new Date().toISOString()
    });

    setAppSettings(nextSettings);
    try {
      setAppSettings(await window.app.settings.updateApp({ themeMode: nextThemeMode }));
      setStatus("shell.states.saved");
    } catch {
      setAppSettings(previous);
      setStatus("errors.common.unknown");
    }
  }

  async function setDebugMode(debugMode: boolean) {
    const previous = appSettings;
    setAppSettings((current) => appSettingsSchema.parse({
      ...current,
      debugMode,
      updatedAt: new Date().toISOString()
    }));
    try {
      setAppSettings(await window.app.settings.updateApp({ debugMode }));
      setStatus("shell.states.saved");
    } catch (error) {
      setAppSettings(previous);
      throw error;
    }
  }

  async function waitForDatabaseReady(): Promise<DatabaseStatus> {
    const startedAt = Date.now();
    await delay(100);

    while (Date.now() - startedAt < databaseStartupTimeoutMs) {
      try {
        const nextStatus = await window.app.database.getStatus();
        setDatabaseStatus(nextStatus);

        if (nextStatus.state === "ready" || nextStatus.state === "failed") {
          return nextStatus;
        }
      } catch {
        return {
          state: "failed",
          messageKey: "database.status.failed",
          updatedAt: new Date().toISOString()
        };
      }

      await delay(databasePollIntervalMs);
    }

    return {
      state: "failed",
      messageKey: "database.status.failed",
      updatedAt: new Date().toISOString(),
      error: "Database startup timed out."
    };
  }

  const pageTitle = activeView === "settings"
    ? "settings.title"
    : activeView === "review"
      ? "knowledge.review.title"
      : activeView === "debug"
        ? "debug.title"
      : emptyViews[activeView].title;

  if (databaseStatus.state !== "ready" || !hasLoadedAppData) {
    const isFailed = databaseStatus.state === "failed";
    const bootMessageKey = databaseStatus.state === "ready" ? "shell.states.loading" : databaseStatus.messageKey;

    return (
      <main
        className={cn(
          "grid min-h-screen place-items-center bg-slate-50 px-6 text-slate-950 dark:bg-slate-950 dark:text-slate-50",
          isDarkMode && "dark"
        )}
      >
        <section className="grid w-full max-w-sm justify-items-center gap-5 text-center">
          <div
            className={cn(
              "grid h-14 w-14 place-items-center rounded-md border bg-white dark:bg-slate-900",
              isFailed
                ? "border-rose-200 text-rose-700 dark:border-rose-900 dark:text-rose-300"
                : "border-cyan-200 text-cyan-700 dark:border-cyan-900 dark:text-cyan-300"
            )}
          >
            {isFailed ? (
              <Database className="h-6 w-6" aria-hidden="true" />
            ) : (
              <RefreshCw
                className="h-6 w-6 animate-spin"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold tracking-normal">
              {t(isFailed ? "database.startup.failedTitle" : "database.startup.title")}
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
              {t(bootMessageKey)}
            </p>
          </div>
          {isFailed ? (
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-cyan-700 px-4 text-sm font-medium text-white transition-colors hover:bg-cyan-600"
              onClick={() => {
                void bootstrap().catch(() => {
                  setDatabaseStatus({
                    state: "failed",
                    messageKey: "database.status.failed",
                    updatedAt: new Date().toISOString()
                  });
                });
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("shell.actions.retry")}
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50",
        isDarkMode && "dark"
      )}
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5 dark:border-slate-800">
          <Database className="h-6 w-6 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-base font-semibold tracking-normal">{t("app.title")}</span>
          <button
            type="button"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-slate-200 text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-900"
            aria-label={t("shell.actions.toggleTheme")}
            title={t("shell.actions.toggleTheme")}
            onClick={() => {
              void toggleThemeMode();
            }}
          >
            {isDarkMode ? (
              <Sun className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
        <nav className="grid gap-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;

            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex h-10 items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors",
                  isActive
                    ? "bg-cyan-50 text-cyan-950 dark:bg-cyan-950 dark:text-cyan-50"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"
                )}
                onClick={() => setActiveView(item.id)}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {t(item.label)}
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6 dark:border-slate-800 dark:bg-slate-950">
          <h1 className="text-xl font-semibold text-slate-950 dark:text-slate-50">{t(pageTitle)}</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {activeView === "settings" ? (
            <SettingsView
              appSettings={appSettings}
              settings={settings}
              status={status}
              isSaving={isSaving}
              t={t}
              onAppSettingsChange={(update) => {
                void updateAppSettings(update);
              }}
              onRelationThresholdChange={persistRelationThreshold}
              onChange={setSettings}
              onSave={saveSettings}
            />
          ) : activeView === "import" ? (
            <ImportView t={t} />
          ) : activeView === "search" ? (
            <SearchView t={t} />
          ) : activeView === "jobs" ? (
            <JobsView t={t} />
          ) : activeView === "review" ? (
            <ReviewQueueView t={t} />
          ) : activeView === "debug" ? (
            <DebugDashboard
              enabled={appSettings.debugMode}
              t={t}
              onEnabledChange={setDebugMode}
            />
          ) : activeView === "library" ? (
            <LibraryView t={t} />
          ) : (
            null
          )}
        </div>
      </main>
    </div>
  );
}

function getBrowserLocale(): LanguageCode {
  if (typeof navigator === "undefined") {
    return "en";
  }

  return normalizeLanguageCode(navigator.language);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
