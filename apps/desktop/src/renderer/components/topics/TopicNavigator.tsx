import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronsDownUp, FolderPlus, MessageCircle } from "lucide-react";
import { formatObjectAddress } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import { ChevronLeft } from "lucide-react";
import { WrappedLabel } from "../../workspace/destinations/explore/FittedLabel";
import { ObjectKindGlyph, objectKindTextClass } from "../glyphs";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";
import { LoadingState, Skeleton } from "../ui/skeleton";
import { FloatingMenu, type MenuAnchor } from "./ops/FloatingMenu";
import {
  actionsLabelKey,
  pinnedItemKeys,
  pinPlanOf,
  topicMenuItems,
  type ActionRow,
  type NavRowOps
} from "./ops/nav-ops";
import { opsErrorText } from "./ops/topic-ops";
import { TopicOpsOverlay, useTopicOps } from "./ops/use-topic-ops";
import { TopicNavTree } from "./TopicNavTree";
import {
  activateRow,
  noteHostAddress,
  owningSourceOf,
  toggleRow,
  type RowActionDeps
} from "./topic-actions";
import { TopicStatusLine } from "./TopicStatusLine";
import {
  followNavigatorEvents,
  TopicNavigatorStore,
  type NavigatorApi,
  type NavigatorSnapshot
} from "./topic-navigator-store";
import {
  placeRows,
  rootBranchKey,
  rootState,
  topicRows,
  unsortedRows,
  type NavRow
} from "./topic-navigation";
import { statusLines } from "./topic-status";

const ids = {
  pinned: "topic-nav-pinned",
  recents: "topic-nav-recents",
  topics: "topic-nav-topics"
};

/** What the navigator draws for the human operations (T26); absent, it is read-only. */
export interface NavigatorOps {
  rows: NavRowOps;
  /** The last refusal of an operation that has no dialog of its own. */
  error: MessageKey | null;
  /** The actions of a topic, open at a point. */
  menu: ReactNode;
  /** The open dialog (the notice that follows a change is the window's). */
  overlay: ReactNode;
  /** A new topic at the top level; null while the tree is not read. */
  onCreateTop: (() => void) | null;
}

export interface TopicNavigatorViewProps {
  t: Translator;
  snapshot: NavigatorSnapshot;
  /** The topic that is open in the reading surface. */
  selectedTopicId: string | null;
  /** A note or source the owner asked for could not be opened. */
  openFailed: boolean;
  onAsk?: (() => void) | undefined;
  onCollapseAll: () => void;
  onToggle: (row: NavRow) => void;
  onActivate: (row: NavRow) => void;
  onRetryRoot: () => void;
  onRetryPlaces: () => void;
  onAskReembed: () => void;
  onConfirmReembed: () => void;
  onCancelReembed: () => void;
  ops?: NavigatorOps | undefined;
  /** The tree shows only this branch ("Show only this branch"); the whole tree comes back with `onExit`. */
  hoist?: { id: string; onExit: () => void } | undefined;
  /** Compact windows (960-1179 px): a row's count shows on hover, focus and the open row only. */
  quietCounts?: boolean | undefined;
  /**
   * The reading surface beside the tree already offers "Try again" for the same failed read: the
   * navigator then says it in one quiet line and draws no second retry (one cause, one retry).
   */
  retryBeside?: boolean | undefined;
}

/** Eight rows at staggered widths, in the size of the real ones, so the column does not jump. */
const skeletonWidths = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3", "w-1/2", "w-3/5", "w-2/5"];

function TreeSkeleton({ t }: { t: Translator }) {
  return (
    <LoadingState t={t} className="gap-px">
      {skeletonWidths.map((width, index) => (
        <div key={index} className="flex h-7 items-center gap-2 px-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className={width} />
        </div>
      ))}
    </LoadingState>
  );
}

function Section({
  id,
  title,
  count,
  action,
  children
}: {
  id: string;
  title: string;
  count?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-3 grid gap-0.5">
      <div className="group/section flex items-center gap-1">
        <h3
          id={id}
          className="flex min-w-0 flex-1 items-baseline justify-between gap-2 px-2 pb-1 text-xs font-semibold text-muted-foreground"
        >
          <span className="min-w-0 truncate">{title}</span>
          {count === undefined ? null : (
            <span className="shrink-0 font-normal tabular-nums">{count}</span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The navigator of the Wiki screen: Pinned and Recents, then the topic tree (topics with their item
 * counts and health, notes and sources as leaves), then what waits for a place. Drawn from a
 * snapshot, so every state (loading, failed, empty, partial, ready) is the same function of its
 * data; {@link TopicNavigator} supplies the snapshot and the actions.
 */
export function TopicNavigatorView({
  t,
  snapshot,
  selectedTopicId,
  openFailed,
  onAsk,
  onCollapseAll,
  onToggle,
  onActivate,
  onRetryRoot,
  onRetryPlaces,
  onAskReembed,
  onConfirmReembed,
  onCancelReembed,
  ops,
  hoist,
  quietCounts = false,
  retryBeside = false
}: TopicNavigatorViewProps) {
  const { branches, expanded, places } = snapshot;
  const hoistId = hoist?.id ?? null;
  const topics = useMemo(
    () => topicRows(branches, expanded, hoistId),
    [branches, expanded, hoistId]
  );
  const unsorted = useMemo(
    () => (hoistId === null ? unsortedRows(branches, expanded) : []),
    [branches, expanded, hoistId]
  );
  const pinned = useMemo(() => placeRows(places.pinned, "pinned"), [places.pinned]);
  const recents = useMemo(() => placeRows(places.recents, "recents"), [places.recents]);
  const lines = useMemo(() => statusLines(snapshot.status), [snapshot.status]);
  const root = branches.get(hoistId === null ? rootBranchKey : hoistId);
  // A library that holds nothing and builds nothing has no tree to prepare: it is empty.
  const emptyLibrary =
    snapshot.status !== null &&
    snapshot.status.phase !== "building" &&
    snapshot.status.counts.items === 0;
  const state =
    hoistId === null ? rootState(root, emptyLibrary) : root?.data ? "tree" : rootState(root);
  const total = root?.data?.parent.items;
  const format = (value: number) => new Intl.NumberFormat(t.locale).format(value);
  // Pinned and Recents are short lists that are not windowed: their rows show the whole name on up
  // to two lines, so "…ferment" never stands for a note.
  const place = { t, selectedTopicId, onToggle, onActivate, ops: ops?.rows, quietCounts };
  const places2 = { ...place, wrapPlaces: true };
  // The tree failed and Pinned and Recents are still here: one failure is said once.
  const treeFailed = state === "error";
  const collapse =
    expanded.size > 0 ? (
      <Button
        variant="ghost"
        className="size-6 min-h-0 px-0"
        aria-label={t("topics.navigator.collapseAll")}
        title={t("topics.navigator.collapseAll")}
        onClick={onCollapseAll}
      >
        <ChevronsDownUp aria-hidden="true" />
      </Button>
    ) : null;
  return (
    <div className="flex min-h-full flex-col px-1 pb-4">
      {onAsk ? (
        <header className="flex h-9 items-center gap-1 pl-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            {t("topics.navigator.title")}
          </h2>
          <Button variant="ghost" aria-haspopup="dialog" className="min-h-8 px-2" onClick={onAsk}>
            <MessageCircle aria-hidden="true" />
            {t("consultation.ask")}
          </Button>
          <Button
            variant="ghost"
            className="size-8 min-h-0 px-0"
            aria-label={t("topics.navigator.collapseAll")}
            title={t("topics.navigator.collapseAll")}
            disabled={expanded.size === 0}
            onClick={onCollapseAll}
          >
            <ChevronsDownUp aria-hidden="true" />
          </Button>
        </header>
      ) : null}
      <TopicStatusLine
        t={t}
        lines={lines}
        reembed={snapshot.reembed}
        onAskReembed={onAskReembed}
        onConfirmReembed={onConfirmReembed}
        onCancelReembed={onCancelReembed}
      />
      {openFailed ? (
        <p role="alert" className="mt-2 px-2 text-xs leading-5 text-danger">
          {t("topics.navigator.openFailed")}
        </p>
      ) : null}
      {ops?.error ? (
        <p role="alert" className="mt-2 px-2 text-xs leading-5 text-danger">
          {opsErrorText(t, ops.error)}
        </p>
      ) : null}
      {places.phase === "error" && !treeFailed ? (
        <div className="mt-3 grid justify-items-start gap-0.5 px-2">
          <p role="alert" className="m-0 text-xs leading-5 text-muted-foreground">
            {t("topics.navigator.placesError")}
          </p>
          <Button type="button" variant="link" className="-ml-3 min-h-7" onClick={onRetryPlaces}>
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {pinned.length > 0 ? (
        <Section id={ids.pinned} title={t("topics.navigator.pinned")}>
          <TopicNavTree {...places2} rows={pinned} labelledBy={ids.pinned} />
        </Section>
      ) : state === "empty" && hoistId === null && onAsk === undefined ? (
        <Section id={ids.pinned} title={t("topics.navigator.pinned")}>
          <p className="m-0 px-2 text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
            {t("explore.navigator.pinHint")}
          </p>
        </Section>
      ) : null}
      {recents.length > 0 ? (
        <Section id={ids.recents} title={t("topics.navigator.recents")}>
          <TopicNavTree {...places2} rows={recents} labelledBy={ids.recents} />
        </Section>
      ) : null}
      {hoist ? (
        <nav
          aria-label={t("explore.navigator.branchLabel")}
          className="sticky top-0 z-[1] -mx-1 mt-2 flex items-center gap-1 bg-background px-1 pb-1"
        >
          <Button
            variant="ghost"
            className="min-h-7 max-w-full gap-1 px-2 text-xs"
            onClick={hoist.onExit}
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
            {t("explore.navigator.wholeTree")}
          </Button>
          <span
            title={root?.data?.parent.title ?? t("topics.navigator.unnamed")}
            className="flex min-w-0 flex-1 text-xs font-semibold text-foreground"
          >
            <WrappedLabel text={root?.data?.parent.title ?? t("topics.navigator.unnamed")} />
          </span>
        </nav>
      ) : null}
      <Section
        id={ids.topics}
        title={hoist ? t("explore.navigator.branch") : t("workspace.navigator.title")}
        count={
          total === undefined
            ? undefined
            : t("workspace.navigator.total", { values: { count: format(total) } })
        }
        action={
          <>
            {collapse}
            {ops?.onCreateTop ? (
              // A new top-level topic is rare (topics are born on their own), so its button shows
              // when the title is hovered or focused.
              <Button
                variant="ghost"
                className="size-6 min-h-0 px-0 opacity-0 group-focus-within/section:opacity-100 group-hover/section:opacity-100 focus-visible:opacity-100"
                aria-label={t("topics.ops.actions.createTop")}
                title={t("topics.ops.actions.createTop")}
                aria-haspopup="dialog"
                onClick={ops.onCreateTop}
              >
                <FolderPlus aria-hidden="true" />
              </Button>
            ) : null}
          </>
        }
      >
        {state === "loading" ? (
          <TreeSkeleton t={t} />
        ) : state === "error" ? (
          retryBeside ? (
            <p role="status" className="m-0 px-2 py-1 text-xs leading-5 text-muted-foreground">
              {t("workspace.navigator.error")} {t("explore.navigator.errorKept")}
            </p>
          ) : (
            <ErrorState
              t={t}
              className="px-2 py-1"
              message={t("workspace.navigator.error")}
              kept={t("explore.navigator.errorKept")}
              retryLabel={t("shell.actions.retry")}
              onRetry={onRetryRoot}
            />
          )
        ) : state === "preparing" ? (
          <p role="status" className="px-2 py-2 text-sm leading-5 text-muted-foreground">
            {t("topics.navigator.preparing")}
          </p>
        ) : state === "empty" ? (
          <EmptyState
            variant="compact"
            className="mx-2"
            icon={<ObjectKindGlyph kind="topic" size={16} className={objectKindTextClass.topic} />}
            headline={t("workspace.navigator.emptyHeadline")}
          >
            {t("workspace.navigator.emptyBody")}
          </EmptyState>
        ) : (
          <TopicNavTree
            {...place}
            rows={topics}
            labelledBy={ids.topics}
            windowed
            scrollTo={snapshot.reveal}
          />
        )}
      </Section>
      {unsorted.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2">
          <h3 id="topic-nav-unsorted" className="sr-only">
            {t("topics.navigator.unsorted")}
          </h3>
          <TopicNavTree {...place} rows={unsorted} labelledBy="topic-nav-unsorted" />
        </div>
      ) : null}
      {ops?.menu}
      {ops?.overlay}
    </div>
  );
}

export interface TopicNavigatorProps {
  t: Translator;
  /** Whether the Wiki is the view on screen. A hidden navigator reads nothing. */
  active: boolean;
  selectedTopicId: string | null;
  onOpenTopic: (id: string) => void;
  /** Opens a source in the Library; with a note ID, on that note. */
  onOpenSource: (sourceItemId: string, atomicNoteId?: string) => void;
  /** Ask from the navigator's header; absent (Explore), the button is not drawn: Ask is Cmd-K. */
  onAsk?: (() => void) | undefined;
  /** The tree starts at this topic ("Show only this branch"), and `onExitHoist` shows it all again. */
  hoistId?: string | null | undefined;
  onExitHoist?: (() => void) | undefined;
  /** Compact windows: a row's count shows on hover, focus and the open row only. */
  quietCounts?: boolean | undefined;
  /** The reading surface beside the tree offers the retry of a failed tree read (see the view). */
  retryBeside?: boolean | undefined;
}

/** The reads and actions of the navigator, bound to the preload API when they run. */
function desktopApi(): NavigatorApi {
  return {
    tree: (input) => window.app.topics.tree(input),
    notes: (input) => window.app.topics.notes(input),
    path: (input) => window.app.topics.path(input),
    status: () => window.app.topics.status(),
    reembed: (input) => window.app.topics.reembed(input),
    history: (input) => window.app.viewHistory.list(input)
  };
}

/** Marks the start of an expansion, for the measurement of the interaction up to the next paint. */
const expandStart = "topics.navigator.expand.start";
const expandMeasure = "topics.navigator.expand";
const maxMeasures = 500;

/**
 * Loads and drives the navigator. It reads while the Wiki is shown, refreshes in place when the
 * tree pushes a change that touches rows on screen, and opens notes and sources in the Library.
 */
export function TopicNavigator({
  t,
  active,
  selectedTopicId,
  onOpenTopic,
  onOpenSource,
  onAsk,
  hoistId = null,
  onExitHoist,
  quietCounts = false,
  retryBeside = false
}: TopicNavigatorProps) {
  const [store] = useState(() => new TopicNavigatorStore(desktopApi()));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [openFailed, setOpenFailed] = useState(false);
  const expanding = useRef<string | null>(null);
  const topicOps = useTopicOps(active);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: ActionRow; anchor: MenuAnchor } | null>(null);

  useEffect(() => {
    store.setActive(active);
  }, [store, active]);

  // A hidden navigator keeps no editor and no menu open (adjusted while rendering, not in an effect).
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) {
      setRenaming(null);
      setMenu(null);
    }
  }

  // Pushed events are kept while the Wiki is hidden and applied when it is shown again.
  useEffect(() => {
    return followNavigatorEvents(() => window.app, store);
  }, [store]);

  // A hoisted branch is read like an open one: its rows are the top level.
  useEffect(() => {
    if (active && hoistId) store.expand(hoistId);
  }, [store, active, hoistId]);

  // An open topic (a link, a pin, a recent entry) is made visible in the tree.
  useEffect(() => {
    if (active && selectedTopicId) void store.reveal(selectedTopicId);
  }, [store, active, selectedTopicId]);

  // The interaction ends at the first paint that shows the rows the expansion made.
  useEffect(() => {
    const id = expanding.current;
    if (id === null || snapshot.branches.get(id)?.phase !== "ready") return;
    expanding.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          performance.measure(expandMeasure, expandStart);
          performance.clearMarks(expandStart);
          // Keep the timeline small in a long session; a proof reads the entries it just made.
          if (performance.getEntriesByName(expandMeasure).length > maxMeasures) {
            performance.clearMeasures(expandMeasure);
          }
        } catch {
          /* Measuring is a convenience; the navigator works without it. */
        }
      })
    );
  });

  const openNote = async (noteId: string) => {
    try {
      const located = await window.app.objects.locate({
        address: formatObjectAddress({ kind: "note", id: noteId })
      });
      const sourceItemId = owningSourceOf(located);
      if (sourceItemId) onOpenSource(sourceItemId, noteId);
      else setOpenFailed(true);
    } catch {
      setOpenFailed(true);
    }
  };

  // The interaction is measured from here to the paint that shows its rows (docs T20 proof).
  const deps: RowActionDeps = {
    store,
    expanded: snapshot.expanded,
    onOpenTopic,
    onOpenSource,
    openNote: (noteId) => void openNote(noteId),
    startExpand: (topicId) => {
      try {
        performance.mark(expandStart);
        expanding.current = topicId;
      } catch {
        /* Measuring is a convenience; the navigator works without it. */
      }
    },
    clearOpenFailure: () => setOpenFailed(false)
  };

  const { controller } = topicOps;
  /** Focus goes back to the row once its editor or menu is gone. */
  const focusRow = (key: string) =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(key)}"]`)?.focus()
    );
  const stopRename = (key: string) => {
    controller.clearError();
    setRenaming(null);
    focusRow(key);
  };
  const pinnedItems = useMemo(
    () => pinnedItemKeys(snapshot.places.pinned),
    [snapshot.places.pinned]
  );
  const rowOps: NavRowOps = {
    renamingKey: renaming,
    invalid: renaming !== null && topicOps.snapshot.error !== null,
    busy: topicOps.snapshot.busy,
    pinnedItems,
    onStartRename: (row) => {
      controller.clearError();
      setMenu(null);
      setRenaming(row.key);
    },
    onCommitRename: (row, title) =>
      void controller.rename(row.node, title).then((done) => {
        if (done) stopRename(row.key);
      }),
    onCancelRename: () => {
      if (renaming !== null) stopRename(renaming);
    },
    onOpenMenu: (row, anchor) => setMenu({ row, anchor })
  };
  const menuNode = menu ? (
    <FloatingMenu
      label={t(actionsLabelKey(menu.row))}
      anchor={menu.anchor}
      onClose={() => setMenu(null)}
      items={topicMenuItems(
        t,
        menu.row,
        {
          rename: () => menu.row.type === "topic" && rowOps.onStartRename(menu.row),
          create: () =>
            menu.row.type === "topic" &&
            topicOps.openDialog({
              kind: "create",
              parent: { id: menu.row.node.id, title: menu.row.node.title },
              top: false
            }),
          move: () =>
            menu.row.type === "topic" &&
            topicOps.openDialog({ kind: "move", topic: menu.row.node }),
          togglePin: () => {
            const plan = pinPlanOf(menu.row, pinnedItems, t("topics.navigator.untitled"));
            if (plan.via === "topic") void controller.pin(plan.topic, plan.pinned);
            else {
              void controller.pinHistory(
                {
                  kind: plan.kind,
                  id: plan.id,
                  title: plan.title,
                  // A note never opened has no entry yet: it is recorded with the source it opens in.
                  host:
                    plan.kind === "note"
                      ? () => noteHostAddress(window.app.objects.locate, plan.id)
                      : undefined
                },
                plan.pinned
              );
            }
          }
        },
        topicOps.snapshot.busy,
        pinnedItems
      )}
    />
  ) : null;
  const rootId = snapshot.branches.get(rootBranchKey)?.data?.parent.id ?? null;

  return (
    <TopicNavigatorView
      t={t}
      snapshot={snapshot}
      selectedTopicId={selectedTopicId}
      openFailed={openFailed}
      ops={{
        rows: rowOps,
        error: renaming === null ? topicOps.snapshot.error : null,
        menu: menuNode,
        overlay: <TopicOpsOverlay t={t} ops={topicOps} />,
        onCreateTop:
          rootId === null
            ? null
            : () =>
                topicOps.openDialog({
                  kind: "create",
                  parent: { id: rootId, title: null },
                  top: true
                })
      }}
      onAsk={onAsk}
      quietCounts={quietCounts}
      retryBeside={retryBeside}
      hoist={hoistId ? { id: hoistId, onExit: () => onExitHoist?.() } : undefined}
      onCollapseAll={() => store.collapseAll()}
      onToggle={(row) => toggleRow(row, deps)}
      onActivate={(row) => activateRow(row, deps)}
      onRetryRoot={() => store.retryBranch(null)}
      onRetryPlaces={() => store.retryPlaces()}
      onAskReembed={() => store.askReembed()}
      onConfirmReembed={() => void store.confirmReembed()}
      onCancelReembed={() => store.cancelReembed()}
    />
  );
}
