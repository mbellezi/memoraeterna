import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronsDownUp, FolderPlus, LoaderCircle, MessageCircle, RefreshCw } from "lucide-react";
import { formatObjectAddress } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import { subscribe as subscribeAppEvent } from "../../lib/app-events";
import { Button } from "../ui/button";
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
  onAsk: () => void;
  onCollapseAll: () => void;
  onToggle: (row: NavRow) => void;
  onActivate: (row: NavRow) => void;
  onRetryRoot: () => void;
  onRetryPlaces: () => void;
  onAskReembed: () => void;
  onConfirmReembed: () => void;
  onCancelReembed: () => void;
  ops?: NavigatorOps | undefined;
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
      <div className="flex items-center gap-1">
        <h3
          id={id}
          className="flex min-w-0 flex-1 justify-between px-2 pb-1 text-xs font-semibold text-muted-foreground"
        >
          <span>{title}</span>
          {count === undefined ? null : <span className="font-normal tabular-nums">{count}</span>}
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
  ops
}: TopicNavigatorViewProps) {
  const { branches, expanded, places } = snapshot;
  const topics = useMemo(() => topicRows(branches, expanded), [branches, expanded]);
  const unsorted = useMemo(() => unsortedRows(branches, expanded), [branches, expanded]);
  const pinned = useMemo(() => placeRows(places.pinned, "pinned"), [places.pinned]);
  const recents = useMemo(() => placeRows(places.recents, "recents"), [places.recents]);
  const lines = useMemo(() => statusLines(snapshot.status), [snapshot.status]);
  const root = branches.get(rootBranchKey);
  const state = rootState(root);
  const total = root?.data?.parent.items;
  const format = (value: number) => new Intl.NumberFormat(t.locale).format(value);
  const place = { t, selectedTopicId, onToggle, onActivate, ops: ops?.rows };
  return (
    <div className="flex min-h-full flex-col px-1 pb-4">
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
      {places.phase === "error" ? (
        <div className="mt-3 flex items-center gap-2 px-2">
          <p role="alert" className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
            {t("topics.navigator.placesError")}
          </p>
          <Button type="button" variant="ghost" onClick={onRetryPlaces}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {pinned.length > 0 ? (
        <Section id={ids.pinned} title={t("topics.navigator.pinned")}>
          <TopicNavTree {...place} rows={pinned} labelledBy={ids.pinned} />
        </Section>
      ) : null}
      {recents.length > 0 ? (
        <Section id={ids.recents} title={t("topics.navigator.recents")}>
          <TopicNavTree {...place} rows={recents} labelledBy={ids.recents} />
        </Section>
      ) : null}
      <Section
        id={ids.topics}
        title={t("topics.navigator.topics")}
        count={total === undefined ? undefined : format(total)}
        action={
          ops?.onCreateTop ? (
            <Button
              variant="ghost"
              className="size-6 min-h-0 px-0"
              aria-label={t("topics.ops.actions.createTop")}
              title={t("topics.ops.actions.createTop")}
              aria-haspopup="dialog"
              onClick={ops.onCreateTop}
            >
              <FolderPlus aria-hidden="true" />
            </Button>
          ) : undefined
        }
      >
        {state === "loading" ? (
          <p
            role="status"
            className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
          >
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            {t("topics.navigator.loading")}
          </p>
        ) : state === "error" ? (
          <div className="grid justify-items-start gap-2 px-2 py-2">
            <p role="alert" className="text-sm text-muted-foreground">
              {t("topics.navigator.error")}
            </p>
            <Button type="button" onClick={onRetryRoot}>
              <RefreshCw aria-hidden="true" />
              {t("shell.actions.retry")}
            </Button>
          </div>
        ) : state === "preparing" ? (
          <p role="status" className="px-2 py-2 text-sm leading-5 text-muted-foreground">
            {t("topics.navigator.preparing")}
          </p>
        ) : state === "empty" ? (
          <p className="px-2 py-2 text-sm leading-5 text-muted-foreground">
            {t("topics.navigator.empty")}
          </p>
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
  onAsk: () => void;
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
  onAsk
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
    const offTopics = subscribeAppEvent("tree.changed", (event) => store.handleChanged(event));
    const offHistory = subscribeAppEvent("view.changed", () => store.handleHistoryChanged());
    return () => {
      offTopics();
      offHistory();
    };
  }, [store]);

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
