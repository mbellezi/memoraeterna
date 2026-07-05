import { useEffect, useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  Database,
  Download,
  RefreshCw,
  Search,
  Settings,
  SquareLibrary
} from "lucide-react";
import { createTranslator, type MessageKey } from "@app/i18n";
import type { DatabaseStatus, StorageSettings, SystemInfo } from "../shared/ipc";
import { defaultStorageSettings, storageSettingsSchema } from "../shared/ipc";
import { cn } from "./lib/cn";
import { SettingsView } from "./components/SettingsView";

type ViewId = "library" | "import" | "search" | "jobs" | "settings";

interface NavItem {
  id: ViewId;
  label: MessageKey;
  icon: typeof SquareLibrary;
}

const navItems: NavItem[] = [
  { id: "library", label: "shell.navigation.library", icon: SquareLibrary },
  { id: "import", label: "shell.navigation.import", icon: Download },
  { id: "search", label: "shell.navigation.search", icon: Search },
  { id: "jobs", label: "shell.navigation.jobs", icon: BriefcaseBusiness },
  { id: "settings", label: "shell.navigation.settings", icon: Settings }
];

const emptyViews: Record<Exclude<ViewId, "settings">, { title: MessageKey; empty: MessageKey }> = {
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

function createInitialDatabaseStatus(): DatabaseStatus {
  return {
    state: "starting",
    messageKey: "database.status.starting",
    updatedAt: new Date(0).toISOString()
  };
}

interface AppProps {
  initialDatabaseStatus?: DatabaseStatus;
  initialSettings?: StorageSettings;
  initialSystemInfo?: SystemInfo | null;
}

export function App({ initialDatabaseStatus, initialSettings, initialSystemInfo = null }: AppProps) {
  const [activeView, setActiveView] = useState<ViewId>("library");
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>(
    initialDatabaseStatus ?? createInitialDatabaseStatus()
  );
  const [settings, setSettings] = useState<StorageSettings>(initialSettings ?? createDefaultSettings());
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(initialSystemInfo);
  const [status, setStatus] = useState<MessageKey>("shell.states.loading");
  const [hasLoadedAppData, setHasLoadedAppData] = useState(Boolean(initialSettings));
  const [isSaving, setIsSaving] = useState(false);
  const locale = systemInfo?.locale ?? "en";
  const t = useMemo(() => createTranslator(locale), [locale]);

  async function loadAppData() {
    const [loadedSettings, loadedSystemInfo] = await Promise.all([
      window.app.settings.get(),
      window.app.system.getInfo()
    ]);

    setSettings(loadedSettings);
    setSystemInfo(loadedSystemInfo);
    setHasLoadedAppData(true);
    setStatus("shell.states.ready");
  }

  async function bootstrap() {
    setStatus("shell.states.loading");
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
      const saved = await window.app.settings.update({
        obsidianVaultPath: settings.obsidianVaultPath,
        managedRoot: settings.managedRoot,
        obsidianSyncEnabled: settings.obsidianSyncEnabled,
        obsidianSyncPaused: settings.obsidianSyncPaused,
        deletionPolicy: settings.deletionPolicy,
        uploadCopiesEnabled: settings.uploadCopiesEnabled,
        uploadCopiesFolderPath: settings.uploadCopiesFolderPath
      });
      setSettings(saved);
      setStatus("shell.states.saved");
    } catch (error) {
      const key = error instanceof Error && error.message.startsWith("errors.") ? error.message : "errors.common.unknown";
      setStatus(key as MessageKey);
    } finally {
      setIsSaving(false);
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

  const pageTitle = activeView === "settings" ? "settings.title" : emptyViews[activeView].title;

  if (databaseStatus.state !== "ready" || !hasLoadedAppData) {
    const isFailed = databaseStatus.state === "failed";
    const bootMessageKey = databaseStatus.state === "ready" ? "shell.states.loading" : databaseStatus.messageKey;

    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 px-6 text-slate-950">
        <section className="grid w-full max-w-sm justify-items-center gap-5 text-center">
          <div
            className={cn(
              "grid h-14 w-14 place-items-center rounded-md border bg-white",
              isFailed ? "border-rose-200 text-rose-700" : "border-cyan-200 text-cyan-700"
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
            <p className="text-sm text-slate-600" aria-live="polite">
              {t(bootMessageKey)}
            </p>
          </div>
          {isFailed ? (
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-cyan-700 px-4 text-sm font-medium text-white transition-colors hover:bg-cyan-800"
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
    <div className="flex min-h-screen bg-slate-50 text-slate-950">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
          <Database className="h-6 w-6 text-cyan-700" aria-hidden="true" />
          <span className="text-base font-semibold tracking-normal">{t("app.title")}</span>
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
                  isActive ? "bg-cyan-50 text-cyan-950" : "text-slate-700 hover:bg-slate-100"
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
        <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6">
          <h1 className="text-xl font-semibold text-slate-950">{t(pageTitle)}</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {activeView === "settings" ? (
            <SettingsView
              settings={settings}
              status={status}
              isSaving={isSaving}
              t={t}
              onChange={setSettings}
              onSave={saveSettings}
            />
          ) : (
            <section className="grid min-h-80 content-center justify-items-center gap-3 rounded-md border border-dashed border-slate-300 bg-white p-8 text-center">
              <h2 className="text-lg font-semibold text-slate-950">{t(emptyViews[activeView].title)}</h2>
              <p className="max-w-lg text-sm text-slate-600">{t(emptyViews[activeView].empty)}</p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
