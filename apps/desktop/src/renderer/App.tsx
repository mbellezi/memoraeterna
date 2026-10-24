import { subscribeWindowNavigation } from "./lib/window-navigation";
import {
  closePanelPriority,
  closeTopDialog,
  dispatchClosePanel,
  openDialogs,
  subscribeClosePanel
} from "./lib/close-panel";
import { applyMenuCommand } from "./lib/menu-commands";
import type { AppMenuCommand, AppViewId } from "../shared/app-menu";
import { WikiWorkspace } from "./components/WikiWorkspace";
import type { WikiNoticeKind } from "./components/topics/WikiPlaceholder";
import { TopicNoticeHost } from "./components/topics/ops/TopicNoticeHost";
import {
  currentWikiTopic,
  showInWiki,
  startWikiTopicHistory,
  wikiNavigationStep
} from "./components/topics/wiki-topic-history";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BriefcaseBusiness,
  Activity,
  ClipboardCheck,
  Database,
  FilePlus2,
  Inbox,
  Moon,
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Network,
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
  KnowledgeGraphDashboardMode,
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
import { createObsidianLinkOpener, type ObsidianLinkActions } from "./lib/obsidian-link";
import { libraryTargetForNavigation, type PassageAnchor } from "./lib/object-navigation";
import { useStableCallback } from "./lib/stable-callback";
import { useDocumentLanguage } from "./lib/document-language";
import { readRememberedTheme, rememberTheme, useResolvedTheme } from "./lib/theme";
import { SettingsScopeMenu, SettingsView, type SettingsScope } from "./components/SettingsView";
import { ImportView } from "./components/ImportView";
import { JobsView } from "./components/JobsView";
import { defaultSearchViewState, SearchView, type SearchViewState } from "./components/SearchView";
import { LibraryView, type LibraryExternalTarget } from "./components/LibraryView";
import type { OpenableNavigation } from "./components/WhereIsThis";
import { ReviewQueueView } from "./components/ReviewQueueView";
import { MonitoringDashboard } from "./components/MonitoringDashboard";
import { ActivityHost } from "./components/activity/ActivityHost";
import type { ActivityNavigation } from "./components/activity/activity-model";
import { InboxScreen } from "./components/inbox/InboxScreen";
import { useInboxTotal } from "./components/inbox/use-inbox-total";
import { useFirstRun } from "./components/onboarding/use-first-run";
import { ToastViewport, useToasts } from "./components/ui/toast";
import type { KnowledgeGraphViewState } from "./components/KnowledgeGraphDashboard";

type ViewId = AppViewId;

const KnowledgeGraphDashboard = lazy(async () => {
  const module = await import("./components/KnowledgeGraphDashboard");
  return { default: module.KnowledgeGraphDashboard };
});

interface NavItem {
  id: ViewId;
  label: MessageKey;
  icon: typeof SquareLibrary;
}

const navItems: NavItem[] = [
  { id: "wiki", label: "wiki.title", icon: BookOpen },
  { id: "library", label: "shell.navigation.library", icon: SquareLibrary },
  { id: "inbox", label: "inbox.title", icon: Inbox },
  { id: "import", label: "shell.navigation.import", icon: FilePlus2 },
  { id: "search", label: "shell.navigation.search", icon: Search },
  { id: "review", label: "shell.navigation.review", icon: ClipboardCheck },
  { id: "jobs", label: "shell.navigation.jobs", icon: BriefcaseBusiness },
  { id: "knowledgeGraph", label: "shell.navigation.knowledgeGraph", icon: Network },
  { id: "debug", label: "debug.title", icon: Activity },
  { id: "settings", label: "shell.navigation.settings", icon: Settings }
];

const emptyViews: Record<
  Exclude<ViewId, "settings" | "review" | "debug" | "inbox">,
  { title: MessageKey; empty: MessageKey }
> = {
  wiki: { title: "wiki.title", empty: "wiki.empty" },
  library: { title: "shell.navigation.library", empty: "shell.states.empty" },
  import: { title: "shell.navigation.import", empty: "shell.states.empty" },
  search: { title: "shell.navigation.search", empty: "shell.states.empty" },
  jobs: { title: "jobs.title", empty: "shell.states.empty" },
  knowledgeGraph: { title: "shell.navigation.knowledgeGraph", empty: "shell.states.empty" }
};

const databasePollIntervalMs = 300;
const databaseStartupTimeoutMs = 60_000;

function createDefaultSettings(): StorageSettings {
  return storageSettingsSchema.parse({
    ...defaultStorageSettings,
    updatedAt: new Date(0).toISOString()
  });
}

/**
 * The settings the interface starts from before the stored ones load. The theme is the one the last
 * session remembered, so the startup screen of an existing install is not drawn in the OS theme.
 */
function createDefaultAppSettings(locale?: string | null): AppSettings {
  return appSettingsSchema.parse({
    ...defaultAppSettings,
    language: normalizeLanguageCode(locale),
    themeMode: readRememberedTheme() ?? defaultAppSettings.themeMode,
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
  /** False in a render of the shell alone: the first-run view is not asked for. */
  firstRun?: boolean;
}

export function App({
  initialDatabaseStatus,
  initialAppSettings,
  initialSettings,
  initialSystemInfo = null,
  firstRun = true
}: AppProps) {
  // Changes each time a link asks for a page of the removed wiki or for a topic that is gone.
  const [wikiNotice, setWikiNotice] = useState<{ token: number; kind: WikiNoticeKind } | null>(
    null
  );
  // What the Wiki shows (a topic, or where to start), as the history its Back and Forward follow.
  const [wikiHistory, setWikiHistory] = useState(startWikiTopicHistory);
  // What Back and Forward step from: they arrive outside render, after the last commit.
  const wikiHistoryRef = useRef(wikiHistory);
  useEffect(() => {
    wikiHistoryRef.current = wikiHistory;
  }, [wikiHistory]);
  const [activeView, setActiveView] = useState<ViewId>("library");
  const [activeSettingsScope, setActiveSettingsScope] = useState<SettingsScope>("overview");
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>(
    initialDatabaseStatus ?? createInitialDatabaseStatus()
  );
  const [appSettings, setAppSettings] = useState<AppSettings>(
    () =>
      initialAppSettings ??
      createDefaultAppSettings(initialSystemInfo?.locale ?? getBrowserLocale())
  );
  const [settings, setSettings] = useState<StorageSettings>(
    initialSettings ?? createDefaultSettings()
  );
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(initialSystemInfo);
  const [hasLoadedAppData, setHasLoadedAppData] = useState(Boolean(initialSettings));
  const [isSaving, setIsSaving] = useState(false);
  const [searchState, setSearchState] = useState<SearchViewState>(defaultSearchViewState);
  const [libraryTarget, setLibraryTarget] = useState<LibraryExternalTarget | null>(null);
  const [knowledgeGraphMode, setKnowledgeGraphMode] =
    useState<KnowledgeGraphDashboardMode>("sources");
  const knowledgeGraphViewStates = useRef<
    Partial<Record<KnowledgeGraphDashboardMode, KnowledgeGraphViewState>>
  >({});
  const libraryTargetToken = useRef(0);
  const activeViewRef = useRef(activeView);
  const scrollPositions = useRef<Partial<Record<ViewId, number>>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastPersistedAppSettings = useRef<AppSettings | null>(initialAppSettings ?? null);
  const lastPersistedSettings = useRef<StorageSettings | null>(initialSettings ?? null);
  const pendingAppUpdate = useRef<AppSettingsUpdate>({});
  const appSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const appSettingsRevision = useRef(0);
  const pendingStorageSettings = useRef<StorageSettings | null>(null);
  const storageSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const t = useMemo(() => createTranslator(appSettings.language), [appSettings.language]);
  const inboxTotal = useInboxTotal(databaseStatus.state === "ready" && hasLoadedAppData);
  const isDarkMode = useResolvedTheme(appSettings.themeMode) === "dark";
  // The preference the startup screen of the next launch starts from; the boot defaults are not stored.
  useEffect(() => {
    if (hasLoadedAppData) rememberTheme(appSettings.themeMode);
  }, [hasLoadedAppData, appSettings.themeMode]);
  // Assistive technology and the browser read the interface language from the document.
  useDocumentLanguage(appSettings.language);
  const preserveKnowledgeGraphViewState = useCallback(
    (mode: KnowledgeGraphDashboardMode, state: KnowledgeGraphViewState) => {
      knowledgeGraphViewStates.current[mode] = state;
    },
    []
  );
  function openLibrarySource(target: Omit<LibraryExternalTarget, "token">) {
    libraryTargetToken.current += 1;
    setLibraryTarget({ ...target, token: libraryTargetToken.current });
    setActiveView("library");
  }
  // The Library keeps the target it opened; dropping ours stops a later open from reusing it.
  const consumeLibraryTarget = useStableCallback((token: number) => {
    setLibraryTarget((current) => (current?.token === token ? null : current));
  });
  // The graph renderer is expensive to rebuild: these keep one identity across App renders.
  const openGraphSource = useStableCallback((sourceItemId: string) =>
    openLibrarySource({ sourceItemId, origin: "knowledgeGraph" })
  );
  const openGraphNote = useStableCallback((sourceItemId: string, atomicNoteId: string) =>
    openLibrarySource({ sourceItemId, atomicNoteId, origin: "knowledgeGraph" })
  );
  // A citation of an answer from Ask in the Wiki opens its source; Back returns to the Wiki.
  const openAskSource = useStableCallback(
    (sourceItemId: string, atomicNoteId?: string, passage?: PassageAnchor) => {
      libraryTargetToken.current += 1;
      setLibraryTarget({
        sourceItemId,
        origin: "wiki",
        ...(atomicNoteId ? { atomicNoteId } : {}),
        ...(passage ? { passage } : {}),
        token: libraryTargetToken.current
      });
      setActiveView("library");
    }
  );
  // A topic opens in the Wiki, which keeps showing it while the Library or another view is in front.
  const openTopic = useStableCallback((topicId: string) => {
    setWikiHistory((current) => showInWiki(current, topicId));
    setActiveView("wiki");
  });
  // A link from Obsidian: the Wiki shows its notice where it starts, so an open topic gives way to it.
  const showWikiNotice = useStableCallback((kind: WikiNoticeKind) => {
    setWikiNotice((current) => ({ token: (current?.token ?? 0) + 1, kind }));
    setWikiHistory((current) => showInWiki(current, null));
    setActiveView("wiki");
  });
  // What each kind of link does here; a topic that was merged opens its successor and says so.
  const obsidianLinkActions = useStableCallback((): ObsidianLinkActions => ({
    removedWikiPage: () => showWikiNotice("removedPage"),
    source: (target) => {
      libraryTargetToken.current += 1;
      setLibraryTarget({ ...target, token: libraryTargetToken.current });
      setActiveView("library");
    },
    topic: (topicId, redirected) => {
      openTopic(topicId);
      if (redirected) pushToast(t("topics.page.redirected"), "info");
    },
    topicNotFound: () => showWikiNotice("topicNotFound")
  }));
  const [openObsidianLink] = useState(() =>
    createObsidianLinkOpener({ topics: () => window.app.topics, actions: obsidianLinkActions })
  );
  useEffect(() => {
    const off = window.app.obsidian.onOpen((link) => void openObsidianLink(link));
    void window.app.obsidian.pendingOpen().then((target) => {
      if (target) void openObsidianLink(target);
    });
    return off;
  }, [openObsidianLink]);
  // Closing the Topic page (its button or Cmd-W) shows where to start; Back opens the topic again.
  const closeWikiTopic = useStableCallback(() =>
    setWikiHistory((current) => showInWiki(current, null))
  );
  // Where a click on the Topic page leads: another topic, or a source or note in the Library.
  const openWikiObject = useStableCallback((navigation: OpenableNavigation) => {
    if (navigation.type === "topic") openTopic(navigation.topicId);
    else {
      const target = libraryTargetForNavigation(navigation);
      if (target) openAskSource(target.sourceItemId, target.atomicNoteId);
    }
  });
  // After an interactive import the new source opens in the Library with the outcome as a toast.
  function openImportedSource(sourceItemId: string, status?: MessageKey) {
    openLibrarySource({ sourceItemId, origin: "import" });
    if (status)
      pushToast(t(status), status === "import.status.duplicateHandled" ? "info" : "success");
  }

  activeViewRef.current = activeView;

  useEffect(
    () =>
      subscribeWindowNavigation((direction) => {
        // The Wiki on screen steps through the topics it showed; the Library through its own history.
        const wikiStep = wikiNavigationStep(
          activeViewRef.current === "wiki",
          wikiHistoryRef.current,
          direction
        );
        if (wikiStep) {
          wikiHistoryRef.current = wikiStep;
          setWikiHistory(wikiStep);
          return true;
        }
        if (activeViewRef.current !== "library") return false;
        if (direction === "back") window.history.back();
        else window.history.forward();
      }),
    []
  );

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = scrollPositions.current[activeView] ?? 0;
  }, [activeView]);

  // Stable: the Library, which stays mounted while hidden, calls this on every navigation.
  const scrollActiveViewToTop = useCallback(() => {
    scrollPositions.current[activeViewRef.current] = 0;
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, []);

  async function loadAppData() {
    const [loadedAppSettings, loadedSettings, loadedSystemInfo] = await Promise.all([
      window.app.settings.getApp(),
      window.app.settings.get(),
      window.app.system.getInfo()
    ]);

    setAppSettings(loadedAppSettings);
    setSettings(loadedSettings);
    lastPersistedAppSettings.current = loadedAppSettings;
    lastPersistedSettings.current = loadedSettings;
    setSystemInfo(loadedSystemInfo);
    setHasLoadedAppData(true);
  }

  async function bootstrap() {
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

  function errorToastText(error: unknown): string {
    const key =
      error instanceof Error && error.message.startsWith("errors.")
        ? (error.message as MessageKey)
        : "shell.toasts.settingsError";
    return t(key);
  }

  async function flushAppSettings() {
    appSaveTimer.current = null;
    const update = pendingAppUpdate.current;
    pendingAppUpdate.current = {};
    if (Object.keys(update).length === 0) return;
    const revision = appSettingsRevision.current;
    appSaveQueue.current = appSaveQueue.current.then(async () => {
      try {
        const saved = await window.app.settings.updateApp(update);
        lastPersistedAppSettings.current = saved;
        if (revision === appSettingsRevision.current) {
          setAppSettings(saved);
          pushToast(t("shell.toasts.settingsSaved"), "success");
        }
      } catch (error) {
        if (revision === appSettingsRevision.current && lastPersistedAppSettings.current)
          setAppSettings(lastPersistedAppSettings.current);
        pushToast(errorToastText(error), "error");
      }
    });
    await appSaveQueue.current;
  }

  function updateAppSettings(update: AppSettingsUpdate) {
    appSettingsRevision.current++;
    setAppSettings((current) =>
      appSettingsSchema.parse({
        ...current,
        ...update,
        updatedAt: new Date().toISOString()
      })
    );
    pendingAppUpdate.current = { ...pendingAppUpdate.current, ...update };
    if (appSaveTimer.current) clearTimeout(appSaveTimer.current);
    appSaveTimer.current = setTimeout(() => void flushAppSettings(), 500);
  }

  async function flushStorageSettings() {
    storageSaveTimer.current = null;
    const next = pendingStorageSettings.current;
    pendingStorageSettings.current = null;
    if (!next) return;
    try {
      const saved = await window.app.settings.update({
        obsidianVaultPath: next.obsidianVaultPath,
        managedRoot: next.managedRoot,
        obsidianSyncEnabled: next.obsidianSyncEnabled,
        obsidianSyncPaused: next.obsidianSyncPaused,
        deletionPolicy: next.deletionPolicy,
        uploadCopiesEnabled: next.uploadCopiesEnabled,
        uploadCopiesFolderPath: next.uploadCopiesFolderPath
      });
      lastPersistedSettings.current = saved;
      setSettings(saved);
      pushToast(t("shell.toasts.settingsSaved"), "success");
    } catch (error) {
      if (lastPersistedSettings.current) setSettings(lastPersistedSettings.current);
      pushToast(errorToastText(error), "error");
    }
  }

  function updateStorageSettings(next: StorageSettings) {
    setSettings(next);
    pendingStorageSettings.current = next;
    if (storageSaveTimer.current) clearTimeout(storageSaveTimer.current);
    storageSaveTimer.current = setTimeout(() => void flushStorageSettings(), 800);
  }

  async function selectObsidianVault() {
    setIsSaving(true);
    try {
      const savedSettings = await window.app.settings.selectObsidianVault();
      if (savedSettings) {
        lastPersistedSettings.current = savedSettings;
        setSettings(savedSettings);
        pushToast(t("shell.toasts.settingsSaved"), "success");
      }
    } catch (error) {
      pushToast(errorToastText(error), "error");
    } finally {
      setIsSaving(false);
    }
  }

  function toggleThemeMode() {
    updateAppSettings({ themeMode: isDarkMode ? "light" : "dark" });
  }

  function selectSettingsScope(scope: SettingsScope) {
    scrollPositions.current.settings = 0;
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setActiveSettingsScope(scope);
  }

  async function setMonitoringCapture(capture: { debugMode: boolean; debugFullCapture: boolean }) {
    const previous = appSettings;
    setAppSettings((current) =>
      appSettingsSchema.parse({
        ...current,
        ...capture,
        updatedAt: new Date().toISOString()
      })
    );
    try {
      const saved = await window.app.settings.updateApp(capture);
      lastPersistedAppSettings.current = saved;
      setAppSettings(saved);
      pushToast(t("shell.toasts.settingsSaved"), "success");
    } catch (error) {
      setAppSettings(previous);
      throw error;
    }
  }

  // These stay below the functions they use: a closure that reaches a function declared later stops
  // the React Compiler lint from checking this component.
  // The navigation rail and the application menu open a view the same way.
  const goToView = useStableCallback((view: ViewId) => {
    if (view === "settings") selectSettingsScope("overview");
    setActiveView(view);
  });
  // What an Activity action leads to: a place in Settings.
  const openFromActivity = useStableCallback((target: ActivityNavigation) => {
    selectSettingsScope(target.scope);
    setActiveView(target.view);
  });

  // An Obsidian conflict of the Inbox is solved in Settings, under Connections.
  const openConnectionsSettings = useStableCallback(() => {
    selectSettingsScope("connections");
    setActiveView("settings");
  });

  const handleMenuCommand = useStableCallback((command: AppMenuCommand) =>
    applyMenuCommand(command, {
      closePanel: () => void dispatchClosePanel(),
      goTo: goToView,
      toggleNavigation: () =>
        updateAppSettings({ navigationCollapsed: !appSettings.navigationCollapsed }),
      toggleTheme: toggleThemeMode
    })
  );

  useEffect(() => window.app.menu.subscribeCommand(handleMenuCommand), [handleMenuCommand]);

  // Cmd-W: a dialog closes first. The Library and the panels inside views register their own
  // listeners. With nothing open, nothing happens.
  useEffect(
    () => subscribeClosePanel(() => closeTopDialog(openDialogs()), closePanelPriority.dialog),
    []
  );

  // The application menu follows the language the interface shows.
  useEffect(() => {
    void window.app.menu.setLanguage(appSettings.language).catch(() => undefined);
  }, [appSettings.language]);

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

  const pageTitle =
    activeView === "settings"
      ? "settings.title"
      : activeView === "review"
        ? "knowledge.review.title"
        : activeView === "debug"
          ? "debug.title"
          : activeView === "inbox"
            ? "inbox.title"
            : emptyViews[activeView].title;

  // F4 D31: the first-run view stands in for the shell while the library is empty and unrecorded.
  const firstRunScreen = useFirstRun({
    enabled: firstRun && databaseStatus.state === "ready" && hasLoadedAppData,
    language: appSettings.language,
    contentLanguage: appSettings.contentLanguage,
    dark: isDarkMode,
    metadataEnrichmentEnabled: appSettings.metadataEnrichmentEnabled,
    onSettings: (saved) => {
      lastPersistedAppSettings.current = saved;
      setAppSettings(saved);
    },
    onOpenSource: openImportedSource
  });

  if (databaseStatus.state !== "ready" || !hasLoadedAppData) {
    const isFailed = databaseStatus.state === "failed";
    const bootMessageKey =
      databaseStatus.state === "ready" ? "shell.states.loading" : databaseStatus.messageKey;

    return (
      <main
        className={cn(
          "grid min-h-screen place-items-center bg-background px-6 text-foreground",
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
              <RefreshCw className="h-6 w-6 animate-spin" aria-hidden="true" />
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

  if (firstRunScreen) return firstRunScreen;

  return (
    <div
      className={cn(
        "flex h-screen overflow-hidden bg-background text-foreground",
        isDarkMode && "dark"
      )}
    >
      <aside
        className={cn(
          "flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-surface",
          appSettings.navigationCollapsed ? "w-16" : "w-56"
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b border-border",
            appSettings.navigationCollapsed ? "justify-center px-2" : "px-4"
          )}
        >
          {!appSettings.navigationCollapsed && (
            <>
              <Database className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-sm font-medium tracking-normal">
                {t("app.title")}
              </span>
            </>
          )}
          <button
            type="button"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-soft focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={t(
              appSettings.navigationCollapsed
                ? "shell.actions.expandNavigation"
                : "shell.actions.collapseNavigation"
            )}
            title={t(
              appSettings.navigationCollapsed
                ? "shell.actions.expandNavigation"
                : "shell.actions.collapseNavigation"
            )}
            aria-expanded={!appSettings.navigationCollapsed}
            aria-controls="app-navigation"
            onClick={() =>
              updateAppSettings({ navigationCollapsed: !appSettings.navigationCollapsed })
            }
          >
            {appSettings.navigationCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
        <nav
          id="app-navigation"
          aria-label={t("shell.navigation.label")}
          className={cn(
            "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
            appSettings.navigationCollapsed ? "p-2" : "p-3"
          )}
        >
          <div className="grid gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              const waiting = item.id === "inbox" ? (inboxTotal ?? 0) : 0;
              const label =
                waiting > 0
                  ? `${t(item.label)}, ${t("inbox.badge", { values: { count: waiting } })}`
                  : t(item.label);

              return (
                <button
                  key={item.id}
                  type="button"
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                  title={appSettings.navigationCollapsed ? label : undefined}
                  className={cn(
                    "relative flex min-h-9 items-center rounded-lg py-2 text-left text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                    appSettings.navigationCollapsed ? "justify-center px-2" : "gap-2.5 px-3",
                    isActive
                      ? "bg-accent-soft text-accent"
                      : "text-muted-foreground hover:bg-soft hover:text-foreground"
                  )}
                  onClick={() => goToView(item.id)}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!appSettings.navigationCollapsed && (
                    <span className="min-w-0 flex-1">{t(item.label)}</span>
                  )}
                  {waiting > 0 ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-foreground",
                        appSettings.navigationCollapsed && "absolute right-0.5 top-0.5 min-w-4 px-1"
                      )}
                    >
                      {waiting > 99 ? "99+" : waiting}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {activeView === "settings" ? (
            <SettingsScopeMenu
              collapsed={appSettings.navigationCollapsed}
              activeScope={activeSettingsScope}
              t={t}
              onScopeChange={selectSettingsScope}
            />
          ) : null}
        </nav>
        <div
          className={cn(
            "flex shrink-0 border-t border-border p-3",
            appSettings.navigationCollapsed && "justify-center"
          )}
        >
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
      </aside>

      <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background px-5">
          <h1 className="shrink-0 text-base font-medium text-foreground">{t(pageTitle)}</h1>
          <div className="ml-auto flex min-w-0 justify-end">
            <ActivityHost t={t} onNavigate={openFromActivity} />
          </div>
        </header>
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-auto overscroll-contain p-5"
          onScroll={(event) => {
            scrollPositions.current[activeView] = event.currentTarget.scrollTop;
          }}
        >
          <div hidden={activeView !== "library"}>
            <LibraryView
              t={t}
              active={activeView === "library"}
              metadataEnrichmentEnabled={appSettings.metadataEnrichmentEnabled}
              externalTarget={libraryTarget}
              onNavigate={scrollActiveViewToTop}
              onTargetConsumed={consumeLibraryTarget}
              onOpenRecent={(target) => openLibrarySource({ ...target, origin: "recents" })}
              onExitToWiki={() => {
                setLibraryTarget(null);
                setActiveView("wiki");
              }}
              onExitToSearch={() => {
                setLibraryTarget(null);
                setActiveView("search");
              }}
              onExitToKnowledgeGraph={() => {
                setLibraryTarget(null);
                setActiveView("knowledgeGraph");
              }}
              onOpenTopic={openTopic}
            />
          </div>
          <div hidden={activeView !== "wiki"}>
            <WikiWorkspace
              t={t}
              active={activeView === "wiki"}
              noticeToken={wikiNotice?.token ?? null}
              noticeKind={wikiNotice?.kind}
              topicId={currentWikiTopic(wikiHistory)}
              onNavigate={openWikiObject}
              onCloseTopic={closeWikiTopic}
              onOpenLibrary={() => goToView("library")}
              onOpenSource={openAskSource}
            />
          </div>
          <div hidden={activeView !== "inbox"}>
            <InboxScreen
              t={t}
              active={activeView === "inbox"}
              onNavigate={openWikiObject}
              onOpenConnections={openConnectionsSettings}
            />
          </div>
          {activeView === "settings" ? (
            <SettingsView
              onReset={async () => {
                window.location.reload();
              }}
              activeScope={activeSettingsScope}
              appSettings={appSettings}
              settings={settings}
              isSaving={isSaving}
              t={t}
              onAppSettingsChange={updateAppSettings}
              onChange={updateStorageSettings}
              onSelectObsidianVault={selectObsidianVault}
              onScopeChange={selectSettingsScope}
              onToast={(message, tone) => pushToast(t(message), tone)}
            />
          ) : activeView === "import" ? (
            <ImportView
              t={t}
              metadataEnrichmentEnabled={appSettings.metadataEnrichmentEnabled}
              onSaved={openImportedSource}
            />
          ) : activeView === "wiki" ? null : activeView === "search" ? (
            <SearchView
              t={t}
              state={searchState}
              onStateChange={setSearchState}
              onOpenSource={(sourceItemId, passage) => {
                libraryTargetToken.current += 1;
                setLibraryTarget({
                  sourceItemId,
                  ...(passage ? { passage } : {}),
                  token: libraryTargetToken.current
                });
                setActiveView("library");
              }}
              onOpenNote={(sourceItemId, noteId) =>
                openLibrarySource({ sourceItemId, atomicNoteId: noteId })
              }
            />
          ) : activeView === "jobs" ? (
            <JobsView t={t} />
          ) : activeView === "review" ? (
            <ReviewQueueView t={t} />
          ) : activeView === "knowledgeGraph" ? (
            <Suspense
              fallback={
                <div
                  role="status"
                  className="grid h-[calc(100vh-7rem)] place-items-center text-sm text-slate-500"
                >
                  {t("shell.states.loading")}
                </div>
              }
            >
              <KnowledgeGraphDashboard
                t={t}
                mode={knowledgeGraphMode}
                wheelZoomSensitivity={appSettings.graphWheelZoomSensitivity}
                initialViewState={knowledgeGraphViewStates.current[knowledgeGraphMode]}
                onViewStateChange={preserveKnowledgeGraphViewState}
                onModeChange={setKnowledgeGraphMode}
                onOpenSource={openGraphSource}
                onOpenAtomicNote={openGraphNote}
              />
            </Suspense>
          ) : activeView === "debug" ? (
            <MonitoringDashboard
              enabled={appSettings.debugMode}
              t={t}
              fullCapture={appSettings.debugFullCapture}
              onCaptureChange={setMonitoringCapture}
              onOpenSource={(sourceItemId) => {
                libraryTargetToken.current += 1;
                setLibraryTarget({ sourceItemId, token: libraryTargetToken.current });
                setActiveView("library");
              }}
            />
          ) : null}
        </div>
      </main>
      <ToastViewport
        toasts={toasts}
        dismissLabel={t("shell.toasts.dismiss")}
        onDismiss={dismissToast}
      />
      <TopicNoticeHost t={t} />
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
