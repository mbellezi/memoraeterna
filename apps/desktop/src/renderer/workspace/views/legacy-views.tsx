import {
  createContext,
  useCallback,
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode
} from "react";
import type { MessageKey, Translator } from "@app/i18n";

import type { LegacyViewId } from "../../../shared/app-menu";
import type {
  AppSettings,
  AppSettingsUpdate,
  KnowledgeGraphDashboardMode,
  StorageSettings
} from "../../../shared/ipc";
import { ImportView } from "../../components/ImportView";
import { InboxScreen } from "../../components/inbox/InboxScreen";
import { JobsView } from "../../components/JobsView";
import type { KnowledgeGraphViewState } from "../../components/KnowledgeGraphDashboard";
import { LibraryView, type LibraryExternalTarget } from "../../components/LibraryView";
import { MonitoringDashboard } from "../../components/MonitoringDashboard";
import { ReviewQueueView } from "../../components/ReviewQueueView";
import { SearchView, type SearchViewState } from "../../components/SearchView";
import { SettingsScopeMenu, SettingsView, type SettingsScope } from "../../components/SettingsView";
import type { WikiNoticeKind } from "../../components/topics/WikiPlaceholder";
import { WikiWorkspace } from "../../components/WikiWorkspace";
import type { OpenableNavigation } from "../../components/WhereIsThis";
import type { PassageAnchor } from "../../lib/object-navigation";
import type { ToastTone } from "../../components/ui/toast";
import type { LegacyHost } from "../shell-model";

/**
 * Every old view the workspace still shows (D6), in one module, so the cards that retire them
 * (T157, T156, T158, T166) edit this file and not `App.tsx`. The views a destination hosts as its
 * root until its replacement lands (the Wiki in Explore, the Library in Home and the Library, the
 * Inbox screen, the knowledge graph in the Map) render through `HostedLegacyView`, which the
 * legacy panel (`legacy.panel.tsx`) places in the stack; Settings and the "Old screens" render
 * through `LegacyScreen` in place of the stack. Their state stays with the app, which passes it
 * down once through `LegacyViewsContext`.
 */

/** What the old views need from the app: their state and what their links do. */
export interface LegacyViewsValue {
  t: Translator;
  appSettings: AppSettings;
  settings: StorageSettings;
  isSaving: boolean;
  /** Goes to an old view (or the place that hosts it). */
  setActiveView: (view: LegacyHostedView | "settings" | LegacyViewId) => void;
  // The Library.
  libraryTarget: LibraryExternalTarget | null;
  consumeLibraryTarget: (token: number) => void;
  openLibrarySource: (target: Omit<LibraryExternalTarget, "token">) => void;
  clearLibraryTarget: () => void;
  openTopic: (topicId: string) => void;
  // The Wiki.
  wikiNotice: { token: number; kind: WikiNoticeKind } | null;
  wikiTopicId: string | null;
  openWikiObject: (navigation: OpenableNavigation) => void;
  closeWikiTopic: () => void;
  openAskSource: (sourceItemId: string, atomicNoteId?: string, passage?: PassageAnchor) => void;
  // The Inbox.
  openConnectionsSettings: () => void;
  // The knowledge graph.
  /** The graph's wheel zoom (a preference the app reads and passes down). */
  graphWheelZoomSensitivity: number;
  knowledgeGraphMode: KnowledgeGraphDashboardMode;
  setKnowledgeGraphMode: (mode: KnowledgeGraphDashboardMode) => void;
  knowledgeGraphViewState: (
    mode: KnowledgeGraphDashboardMode
  ) => KnowledgeGraphViewState | undefined;
  preserveKnowledgeGraphViewState: (
    mode: KnowledgeGraphDashboardMode,
    state: KnowledgeGraphViewState
  ) => void;
  openGraphSource: (sourceItemId: string) => void;
  openGraphNote: (sourceItemId: string, atomicNoteId: string) => void;
  // Settings.
  activeSettingsScope: SettingsScope;
  selectSettingsScope: (scope: SettingsScope) => void;
  updateAppSettings: (update: AppSettingsUpdate) => void;
  updateStorageSettings: (next: StorageSettings) => void;
  selectObsidianVault: () => Promise<void>;
  setMonitoringCapture: (capture: {
    debugMode: boolean;
    debugFullCapture: boolean;
  }) => Promise<void>;
  pushToast: (message: MessageKey, tone: ToastTone) => void;
  // Import and search.
  openImportedSource: (sourceItemId: string, status?: MessageKey) => void;
  searchState: SearchViewState;
  setSearchState: (state: SearchViewState) => void;
}

/** The ids of the old views a destination hosts as its root. */
export type LegacyHostedView = "wiki" | "library" | "inbox" | "knowledgeGraph";

export const LegacyViewsContext = createContext<LegacyViewsValue | null>(null);

function useLegacyViews(): LegacyViewsValue {
  const value = useContext(LegacyViewsContext);
  if (!value) throw new Error("An old view renders inside LegacyViewsContext");
  return value;
}

const KnowledgeGraphDashboard = lazy(async () => {
  const module = await import("../../components/KnowledgeGraphDashboard");
  return { default: module.KnowledgeGraphDashboard };
});

/** The old view each kind of legacy root shows. */
export const hostedLegacyView: Readonly<Record<LegacyHost, LegacyHostedView>> = {
  wiki: "wiki",
  library: "library",
  inbox: "inbox",
  graph: "knowledgeGraph"
};

/**
 * A scroll area of its own, which keeps its offset while the view is hidden (a hidden element
 * reads 0) and puts it back when the view shows again.
 */
function ScrollArea({
  active,
  children,
  scrollRef
}: {
  active: boolean;
  children: ReactNode;
  scrollRef?: (node: HTMLDivElement | null) => void;
}) {
  const node = useRef<HTMLDivElement | null>(null);
  const offset = useRef(0);
  useLayoutEffect(() => {
    if (active && node.current) node.current.scrollTop = offset.current;
  }, [active]);
  return (
    <div
      ref={(element) => {
        node.current = element;
        scrollRef?.(element);
      }}
      className="h-full min-h-0 w-full overflow-auto overscroll-contain p-5"
      onScroll={(event) => {
        if (active) offset.current = event.currentTarget.scrollTop;
      }}
    >
      {children}
    </div>
  );
}

/** One old view that a destination hosts as its root, shown or kept mounted while hidden. */
export function HostedLegacyView({ view, active }: { view: LegacyHostedView; active: boolean }) {
  const legacy = useLegacyViews();
  const { t } = legacy;
  const scroller = useRef<HTMLDivElement | null>(null);
  // The Library jumps to its top on each of its own navigations.
  const scrollToTop = useCallback(() => scroller.current?.scrollTo({ top: 0 }), []);

  if (view === "library")
    return (
      <ScrollArea active={active} scrollRef={(node) => (scroller.current = node)}>
        <LibraryView
          t={t}
          active={active}
          metadataEnrichmentEnabled={legacy.appSettings.metadataEnrichmentEnabled}
          externalTarget={legacy.libraryTarget}
          onNavigate={scrollToTop}
          onTargetConsumed={legacy.consumeLibraryTarget}
          onOpenRecent={(target) => legacy.openLibrarySource({ ...target, origin: "recents" })}
          onExitToWiki={() => {
            legacy.clearLibraryTarget();
            legacy.setActiveView("wiki");
          }}
          onExitToSearch={() => {
            legacy.clearLibraryTarget();
            legacy.setActiveView("search");
          }}
          onExitToKnowledgeGraph={() => {
            legacy.clearLibraryTarget();
            legacy.setActiveView("knowledgeGraph");
          }}
          onOpenTopic={legacy.openTopic}
        />
      </ScrollArea>
    );
  if (view === "wiki")
    return (
      <ScrollArea active={active}>
        <WikiWorkspace
          t={t}
          active={active}
          noticeToken={legacy.wikiNotice?.token ?? null}
          noticeKind={legacy.wikiNotice?.kind}
          topicId={legacy.wikiTopicId}
          onNavigate={legacy.openWikiObject}
          onCloseTopic={legacy.closeWikiTopic}
          onOpenLibrary={() => legacy.setActiveView("library")}
          onOpenSource={legacy.openAskSource}
        />
      </ScrollArea>
    );
  if (view === "inbox")
    return (
      <ScrollArea active={active}>
        <InboxScreen
          t={t}
          active={active}
          onNavigate={legacy.openWikiObject}
          onOpenConnections={legacy.openConnectionsSettings}
        />
      </ScrollArea>
    );
  // The graph renderer is expensive: it is built only while shown, from its saved view state.
  if (!active) return null;
  return (
    <ScrollArea active={active}>
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
          mode={legacy.knowledgeGraphMode}
          wheelZoomSensitivity={legacy.graphWheelZoomSensitivity}
          initialViewState={legacy.knowledgeGraphViewState(legacy.knowledgeGraphMode)}
          onViewStateChange={legacy.preserveKnowledgeGraphViewState}
          onModeChange={legacy.setKnowledgeGraphMode}
          onOpenSource={legacy.openGraphSource}
          onOpenAtomicNote={legacy.openGraphNote}
        />
      </Suspense>
    </ScrollArea>
  );
}

/** Settings or an old screen of the rail's "Old screens" menu, in place of the stack. */
export function LegacyScreen({ view }: { view: "settings" | LegacyViewId }) {
  const legacy = useLegacyViews();
  const { t } = legacy;
  return (
    <ScrollArea active>
      {view === "settings" ? (
        // The old Settings keeps its section menu until Settings v2 (T161) brings its own column.
        <div className="flex min-h-full gap-5">
          <nav
            aria-label={t("settings.dashboard.navigation.label")}
            className="sticky top-0 w-60 shrink-0 self-start"
          >
            <SettingsScopeMenu
              activeScope={legacy.activeSettingsScope}
              t={t}
              onScopeChange={legacy.selectSettingsScope}
            />
          </nav>
          <div className="min-w-0 flex-1">
            <SettingsView
              onReset={async () => {
                window.location.reload();
              }}
              activeScope={legacy.activeSettingsScope}
              appSettings={legacy.appSettings}
              settings={legacy.settings}
              isSaving={legacy.isSaving}
              t={t}
              onAppSettingsChange={legacy.updateAppSettings}
              onChange={legacy.updateStorageSettings}
              onSelectObsidianVault={legacy.selectObsidianVault}
              onScopeChange={legacy.selectSettingsScope}
              onToast={(message, tone) => legacy.pushToast(message, tone)}
            />
          </div>
        </div>
      ) : view === "import" ? (
        <ImportView
          t={t}
          metadataEnrichmentEnabled={legacy.appSettings.metadataEnrichmentEnabled}
          onSaved={legacy.openImportedSource}
        />
      ) : view === "search" ? (
        <SearchView
          t={t}
          state={legacy.searchState}
          onStateChange={legacy.setSearchState}
          onOpenSource={(sourceItemId, passage) =>
            legacy.openLibrarySource({ sourceItemId, ...(passage ? { passage } : {}) })
          }
          onOpenNote={(sourceItemId, noteId) =>
            legacy.openLibrarySource({ sourceItemId, atomicNoteId: noteId })
          }
        />
      ) : view === "jobs" ? (
        <JobsView t={t} />
      ) : view === "review" ? (
        <ReviewQueueView t={t} />
      ) : view === "debug" ? (
        <MonitoringDashboard
          enabled={legacy.appSettings.debugMode}
          t={t}
          fullCapture={legacy.appSettings.debugFullCapture}
          onCaptureChange={legacy.setMonitoringCapture}
          onOpenSource={(sourceItemId) => legacy.openLibrarySource({ sourceItemId })}
        />
      ) : null}
    </ScrollArea>
  );
}
