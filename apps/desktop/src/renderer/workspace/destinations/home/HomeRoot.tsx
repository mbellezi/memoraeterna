import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChangeSetSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ErrorState } from "../../../components/ui/error-state";
import {
  LoadingState,
  Skeleton,
  SkeletonLines,
  SkeletonRows
} from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { useStableCallback } from "../../../lib/stable-callback";
import type { HomeInboxRow } from "../../../../shared/ipc-home";
import { layoutConfig } from "../../layout-config";
import type { PanelLoadState } from "../../PanelFrame";
import type { PanelProps } from "../../PanelStack";
import { formatView } from "../../route";
import { useViewportWidth } from "../../use-workspace";
import { useAddSource, useWorkspaceBridge, type WorkspaceBridge } from "../../workspace-bridge";
import { formatObjectAddress } from "@app/domain";
import {
  Briefing,
  Greeting,
  Reassurance,
  ResumeCard,
  homeAddresses,
  type BriefActions
} from "./HomeBrief";
import { ArrivedColumn, GardenerColumn, NeedColumn, QuestionsColumn } from "./HomeColumns";
import { HomeFirstRun } from "./HomeFirstRun";
import { ShapeStrip } from "./HomeShape";
import {
  arrivalRows,
  columnAreas,
  gardenerRows,
  homeMode,
  isResumeKey,
  needRows,
  questionRows,
  resumeActions,
  resumeTrail,
  type HomeArea,
  type HomeData
} from "./home-model";
import { HomeStore, type HomeSnapshot, type HomeStoreApi } from "./home-store";

/** What Home's controls do; a control whose action is absent is drawn but does nothing. */
export interface HomeActions {
  /** Opens a view of the workspace: the Library, the Inbox, the Map. */
  go?: (address: string) => void;
  /** Opens an object beside Home (a source that arrived, a question). */
  openObject?: (address: string) => void;
  /** "Retomar": Explore with the trail's objects open, the newest on top. */
  resume?: (addresses: readonly string[]) => void;
  undo?: (change: ChangeSetSummary) => void;
  retry?: () => void;
  /** The first source: the Add flow. */
  addSource?: () => void;
}

/** The frame state of a snapshot: first run is Home's empty state. */
export function homeState(snapshot: HomeSnapshot): PanelLoadState {
  const { read } = snapshot;
  if (read.status !== "ready") return read.status === "error" ? "error" : "loading";
  return homeMode(read.data) === "firstRun" ? "empty" : "success";
}

const contentWrap = (compact: boolean) =>
  cn("mx-auto grid w-full max-w-[1136px] content-start gap-8 py-8", compact ? "px-8" : "px-12");

/** The briefing's "9 mudanças": the Jardineiro's column scrolls into view and its heading takes focus. */
function focusGardenerColumn() {
  const heading = document.getElementById("home-gard");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.scrollIntoView({ block: "center" });
  heading.focus({ preventScroll: true });
}

/** Home as a pure function of a snapshot, its width and its actions. */
export function HomeView({
  t,
  snapshot,
  width,
  actions
}: {
  t: Translator;
  snapshot: HomeSnapshot;
  /** The window's width: below the compact tier Home draws two columns. */
  width: number;
  actions: HomeActions;
}) {
  const compact = width < layoutConfig.compactBelow;
  const state = homeState(snapshot);
  return (
    <div
      role="region"
      aria-label={t("home.label")}
      data-surface="destination-home"
      data-state={state}
      className="h-full min-h-0 min-w-0 overflow-y-auto bg-background text-foreground"
    >
      <div className={contentWrap(compact)}>
        {snapshot.read.status === "loading" ? (
          <HomeLoading t={t} compact={compact} />
        ) : snapshot.read.status === "error" ? (
          <ErrorState
            t={t}
            className="max-w-[40rem]"
            message={t("home.states.error")}
            kept={t("home.states.errorKept")}
            retryLabel={t("shell.actions.retry")}
            {...(actions.retry ? { onRetry: actions.retry } : {})}
            {...(snapshot.read.unavailable ? { details: t("home.errors.unavailable") } : {})}
          />
        ) : homeMode(snapshot.read.data) === "firstRun" ? (
          <HomeFirstRun t={t} onAdd={actions.addSource} />
        ) : (
          <HomeContent
            t={t}
            data={snapshot.read.data}
            undo={snapshot.undo}
            compact={compact}
            actions={actions}
          />
        )}
      </div>
    </div>
  );
}

function HomeContent({
  t,
  data,
  undo,
  compact,
  actions
}: {
  t: Translator;
  data: HomeData;
  undo: HomeSnapshot["undo"];
  compact: boolean;
  actions: HomeActions;
}) {
  const { digest } = data;
  const calm = homeMode(data) === "calm";
  const trail = resumeTrail(digest);
  const go = actions.go;
  const needs = needRows(digest.inbox.top);
  const gardener = gardenerRows(digest.gardener.top);
  const arrivals = arrivalRows(data);
  const questions = questionRows(digest.questions);

  const visible: HomeArea[] = [];
  if (needs.length > 0) visible.push("need");
  if (gardener.length > 0) visible.push("gard");
  if (arrivals.length > 0) visible.push("arr");
  if (questions.length > 0) visible.push("back");
  const areas = columnAreas(visible, compact);
  const columns = areas[0]?.length ?? 1;

  const briefActions: BriefActions = {
    ...(go ? { openLibrary: () => go(homeAddresses.library) } : {}),
    ...(go ? { openInbox: () => go(homeAddresses.inbox) } : {}),
    ...(gardener.length > 0 ? { openChanges: focusGardenerColumn } : {}),
    ...(actions.resume && trail.length > 0
      ? { resume: () => actions.resume?.(trail.map((entry) => entry.address)) }
      : {})
  };

  return (
    <>
      <section
        className={cn(
          "grid min-w-0 items-start gap-12",
          trail.length > 0 ? "[grid-template-columns:minmax(0,7fr)_minmax(0,5fr)]" : "grid-cols-1"
        )}
      >
        <div className="grid min-w-0 content-start gap-3">
          <Greeting t={t} data={data} />
          {calm ? (
            <p className="m-0 max-w-[40rem] font-reading text-lg text-foreground [text-wrap:pretty]">
              {t("home.calm.body")}
            </p>
          ) : (
            <Briefing t={t} data={data} actions={briefActions} />
          )}
          {calm ? null : <Reassurance t={t} />}
        </div>
        {trail.length > 0 ? (
          <ResumeCard t={t} trail={trail} readAt={data.readAt} onResume={briefActions.resume} />
        ) : null}
      </section>
      {digest.shape.hasTree && digest.shape.roots.length > 0 ? (
        <div className="border-t border-border pt-6">
          <ShapeStrip
            t={t}
            shape={digest.shape}
            {...(go ? { onOpenMap: () => go(homeAddresses.map) } : {})}
            {...(go
              ? {
                  onOpenRoot: (id: string) =>
                    go(
                      formatView({
                        view: "map",
                        lens: "shape",
                        scope: { kind: "topic", id }
                      })
                    )
                }
              : {})}
          />
        </div>
      ) : null}
      {visible.length > 0 ? (
        <div
          className="grid min-w-0 gap-x-10 gap-y-8 border-t border-border pt-6"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateAreas: areas.map((row) => `"${row.join(" ")}"`).join(" ")
          }}
        >
          {needs.length > 0 ? (
            <NeedColumn
              t={t}
              rows={needs}
              total={digest.inbox.total}
              {...(go
                ? {
                    onOpen: (row: HomeInboxRow) =>
                      go(formatView({ view: "inbox", kind: row.kind })),
                    onInbox: () => go(homeAddresses.inbox)
                  }
                : {})}
            />
          ) : null}
          {gardener.length > 0 ? (
            <GardenerColumn
              t={t}
              count={digest.gardener.count}
              since={data.lastVisit === null ? "week" : "visit"}
              changes={gardener}
              undo={undo}
              readAt={data.readAt}
              onUndo={actions.undo}
            />
          ) : null}
          {arrivals.length > 0 ? (
            <ArrivedColumn
              t={t}
              sources={digest.new.sources.total}
              notes={digest.new.notes.total}
              rows={arrivals}
              readAt={data.readAt}
              onOpen={actions.openObject}
              {...(go ? { onLibrary: () => go(homeAddresses.library) } : {})}
            />
          ) : null}
          {questions.length > 0 ? (
            <QuestionsColumn
              t={t}
              questions={questions}
              readAt={data.readAt}
              {...(actions.openObject
                ? {
                    onOpen: (id: string) =>
                      actions.openObject?.(formatObjectAddress({ kind: "question", id }))
                  }
                : {})}
              {...(go
                ? { onAll: () => go(formatView({ view: "library", tab: "questions" })) }
                : {})}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * The skeleton in the shape of Home: the brief with its card, the strip and the columns (three, or
 * two in two rows below the compact tier, as the content will be drawn).
 */
function HomeLoading({ t, compact }: { t: Translator; compact: boolean }) {
  return (
    <LoadingState t={t} className="gap-8">
      <div className="grid min-w-0 items-start gap-12 [grid-template-columns:minmax(0,7fr)_minmax(0,5fr)]">
        <div className="grid min-w-0 gap-3">
          <Skeleton className="w-64" />
          <Skeleton className="h-7 w-full max-w-[28rem]" />
          <SkeletonLines lines={3} className="max-w-[36rem]" />
        </div>
        <div className="grid gap-4 rounded-xl border border-border bg-surface p-5">
          <Skeleton className="w-48" />
          <SkeletonLines lines={3} />
        </div>
      </div>
      <div className="grid gap-3 border-t border-border pt-6">
        <Skeleton className="w-72" />
        <Skeleton className="h-11 w-full rounded-md" />
      </div>
      <div
        className={cn(
          "grid gap-x-10 gap-y-8 border-t border-border pt-6",
          compact ? "grid-cols-2" : "grid-cols-3"
        )}
      >
        {(compact ? [0, 1, 2, 3] : [0, 1, 2]).map((column) => (
          <div key={column} className="grid content-start gap-3">
            <Skeleton className="w-40" />
            <SkeletonRows rows={3} />
          </div>
        ))}
      </div>
    </LoadingState>
  );
}

/**
 * Home's own data: the store reads the digest when Home comes on screen (the `since` it takes is the
 * workspace's `lastHomeOpenAt` of that moment), follows the bus while it stays, and tells the
 * workspace that Home was opened after the first answer. A hidden Home listens to nothing.
 */
export function useHomeStore(active: boolean): HomeStore {
  const bridge = useWorkspaceBridge();
  const since = useStableCallback(() => bridge?.workspace.lastHomeOpenAt ?? null);
  const opened = useStableCallback(() =>
    bridge?.dispatch({ type: "homeOpened", at: new Date().toISOString() })
  );
  const [store] = useState(
    () =>
      new HomeStore({
        api: () => window.app as unknown as HomeStoreApi,
        since,
        onFirstRead: opened
      })
  );
  useEffect(() => {
    if (!active) return undefined;
    store.start();
    return () => store.stop();
  }, [store, active]);
  return store;
}

/**
 * What Home's controls do, from the workspace it is hosted in. The first run's Add is the app's own
 * Add command (the one Cmd-N runs), never a view of Home's stack: the person lands where the app
 * puts a new source, and the button and the shortcut cannot disagree.
 */
export function homeActions({
  bridge,
  addSource,
  onOpen,
  store
}: {
  bridge: WorkspaceBridge | null;
  addSource: (() => void) | null;
  onOpen: (address: string) => void;
  store: Pick<HomeStore, "undo" | "retry">;
}): HomeActions {
  const dispatch = bridge?.dispatch;
  const workspace = bridge?.workspace;
  return {
    ...(dispatch
      ? { go: (address: string) => dispatch({ type: "open", address, from: -1, mode: "push" }) }
      : {}),
    openObject: (address: string) => onOpen(address),
    ...(dispatch && workspace
      ? {
          resume: (addresses: readonly string[]) => {
            for (const action of resumeActions(workspace, addresses)) dispatch(action);
          }
        }
      : {}),
    undo: (change) => void store.undo({ kind: change.kind, id: change.id }),
    retry: () => store.retry(),
    ...(addSource ? { addSource } : {})
  };
}

/** The root of the Home destination, in the panel stack (`home.panel.tsx` registers it). */
export function HomeRoot({ t, active, onState, onOpen }: PanelProps) {
  const bridge = useWorkspaceBridge();
  const addSource = useAddSource();
  const store = useHomeStore(active);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const width = useViewportWidth();
  const state = homeState(snapshot);
  useEffect(() => {
    onState(state);
  }, [state, onState]);

  const actions = homeActions({ bridge, addSource, onOpen, store });

  // Enter resumes where the person left off, from Home itself.
  const trail = snapshot.read.status === "ready" ? resumeTrail(snapshot.read.data.digest) : [];
  const resume = actions.resume;
  const resumable = active && state === "success" && resume !== undefined && trail.length > 0;
  const addresses = trail.map((entry) => entry.address).join("\n");
  useEffect(() => {
    if (!resumable) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !isResumeKey({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          target: event.target instanceof HTMLElement ? event.target : null
        })
      )
        return;
      // A dialog or a menu on screen owns Enter.
      if (document.querySelector("[role='dialog'], [role='menu']")) return;
      event.preventDefault();
      resume(addresses.split("\n"));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [resumable, addresses, resume]);

  return <HomeView t={t} snapshot={snapshot} width={width} actions={actions} />;
}
