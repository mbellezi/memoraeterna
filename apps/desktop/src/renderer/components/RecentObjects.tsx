import { useEffect, useRef, useState, type Ref, type RefObject } from "react";
import {
  CircleHelp,
  FileText,
  History,
  Layers,
  Pin,
  PinOff,
  RefreshCw,
  StickyNote,
  Tag
} from "lucide-react";
import type { ObjectKind } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import {
  viewHistoryBounds,
  viewHistoryPinLimitMessage,
  type ViewHistoryEntry
} from "../../shared/view-history";
import { useAppEvent } from "../lib/app-events";
import { cn } from "../lib/cn";
import { showsLoadError, type LoadOutcome } from "../lib/hidden-view";
import { useStableCallback } from "../lib/stable-callback";
import {
  applyRecentsFocus,
  groupRecents,
  recentKinds,
  recentOpenTarget,
  recentsListSize,
  type RecentsFocus,
  type RecentTarget
} from "../lib/view-history";
import { Button } from "./ui/button";

export type RecentsState =
  { status: "loading" } | { status: "error" } | { status: "ready"; entries: ViewHistoryEntry[] };

const kindIcons: Record<ObjectKind, typeof FileText> = {
  source: FileText,
  note: StickyNote,
  topic: Layers,
  question: CircleHelp,
  entity: Tag
};

const outcomeKey = "recents";

// What the last load found: a list shown again starts from it instead of a loading state.
let remembered: ViewHistoryEntry[] | null = null;

const kindLabel = (kind: ObjectKind) => `viewHistory.kind.${kind}` as MessageKey;

/** The control a focus request names, found in the rendered list (`data-recents-*` markers). */
export function findRecentsControl(root: HTMLElement, request: RecentsFocus): HTMLElement | null {
  if (request.target === "pin")
    return (
      Array.from(root.querySelectorAll<HTMLElement>("[data-recents-pin]")).find(
        (element) => element.dataset.recentsPin === request.address
      ) ?? null
    );
  return root.querySelector<HTMLElement>(`[data-recents-focus="${request.target}"]`);
}

/** One group of entries. Pinned entries are marked with a glyph as well as by their group. */
function RecentEntries({
  t,
  entries,
  labelledBy,
  busy,
  pinsFull,
  focusAddress,
  focusRef,
  onOpen,
  onTogglePin
}: {
  t: Translator;
  entries: readonly ViewHistoryEntry[];
  labelledBy?: string | undefined;
  busy: boolean;
  /** Every pin slot is taken: an entry that is not pinned cannot be pinned until one is freed. */
  pinsFull: boolean;
  focusAddress: string | null;
  focusRef: RefObject<HTMLButtonElement | null> | undefined;
  onOpen: (entry: ViewHistoryEntry) => void;
  onTogglePin: (entry: ViewHistoryEntry) => void;
}) {
  return (
    <ul aria-labelledby={labelledBy} className="grid gap-1 md:grid-cols-2">
      {entries.map((entry) => {
        const Icon = kindIcons[entry.kind];
        const blocked = pinsFull && !entry.pinned;
        const pinLabel = t(entry.pinned ? "viewHistory.unpin" : "viewHistory.pin", {
          values: { title: entry.title }
        });
        return (
          <li
            key={entry.address}
            className="flex min-w-0 items-center rounded-md border border-border bg-background"
          >
            <button
              type="button"
              ref={entry.address === focusAddress ? focusRef : undefined}
              title={entry.title}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-soft focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => onOpen(entry)}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              {entry.pinned ? (
                <Pin className="h-3 w-3 shrink-0 fill-current text-accent" aria-hidden="true" />
              ) : null}
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(kindLabel(entry.kind))}
              </span>
            </button>
            <button
              type="button"
              data-recents-pin={entry.address}
              disabled={busy || blocked}
              aria-label={pinLabel}
              title={
                blocked
                  ? t("viewHistory.pinLimit", { values: { count: viewHistoryBounds.pinMax } })
                  : pinLabel
              }
              className={cn(
                "mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md",
                "text-muted-foreground hover:bg-soft hover:text-foreground",
                "focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45"
              )}
              onClick={() => onTogglePin(entry)}
            >
              {entry.pinned ? (
                <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Pin className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The last objects opened: pinned ones in a group of their own, then the recent ones. Presentation
 * only: the container loads and acts.
 */
export function RecentObjectsView({
  t,
  state,
  confirmingClear,
  busy,
  failed,
  rootRef,
  focusAddress = null,
  focusRef,
  onOpen,
  onTogglePin,
  onAskClear,
  onConfirmClear,
  onCancelClear,
  onRetry
}: {
  t: Translator;
  state: RecentsState;
  confirmingClear: boolean;
  /** A pin or clear request is in flight. */
  busy: boolean;
  /** The last pin or clear request failed. */
  failed: boolean;
  /** The list element, so the container can move focus inside it. */
  rootRef?: Ref<HTMLElement>;
  /** The entry to focus (the one opened before coming back) and the ref that reaches it. */
  focusAddress?: string | null;
  focusRef?: RefObject<HTMLButtonElement | null>;
  onOpen: (entry: ViewHistoryEntry) => void;
  onTogglePin: (entry: ViewHistoryEntry) => void;
  onAskClear: () => void;
  onConfirmClear: () => void;
  onCancelClear: () => void;
  onRetry: () => void;
}) {
  const entries = state.status === "ready" ? state.entries : [];
  const { pinned, recent, pinsFull } = groupRecents(entries);
  return (
    <section
      ref={rootRef}
      aria-labelledby="library-recents-title"
      className="grid gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <header className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2
          id="library-recents-title"
          tabIndex={-1}
          data-recents-focus="title"
          className="flex items-center gap-2 text-sm font-semibold text-foreground outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t("viewHistory.title")}
        </h2>
        {confirmingClear ? (
          <div
            role="group"
            tabIndex={-1}
            data-recents-focus="clear-confirmation"
            aria-labelledby="library-recents-clear-question"
            className="flex flex-wrap items-center gap-2 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-accent"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              onCancelClear();
            }}
          >
            <span id="library-recents-clear-question" className="text-xs text-muted-foreground">
              {t("viewHistory.clearQuestion")}
            </span>
            <Button type="button" disabled={busy} onClick={onConfirmClear}>
              {t("viewHistory.clearConfirm")}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancelClear}>
              {t("shell.actions.cancel")}
            </Button>
          </div>
        ) : entries.some((entry) => !entry.pinned) ? (
          <Button
            type="button"
            variant="ghost"
            data-recents-focus="clear-button"
            disabled={busy}
            onClick={onAskClear}
          >
            {t("viewHistory.clear")}
          </Button>
        ) : null}
      </header>
      {failed ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t("viewHistory.changeFailed")}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("viewHistory.loading")}
        </p>
      ) : state.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-muted-foreground">
            {t("viewHistory.error")}
          </p>
          <Button type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("viewHistory.empty")}</p>
      ) : (
        <>
          {pinned.length > 0 ? (
            <div className="grid gap-1">
              <h3
                id="library-recents-pinned"
                className="text-xs font-semibold text-muted-foreground"
              >
                {t("viewHistory.pinned")}
              </h3>
              <RecentEntries
                t={t}
                entries={pinned}
                labelledBy="library-recents-pinned"
                busy={busy}
                pinsFull={pinsFull}
                focusAddress={focusAddress}
                focusRef={focusRef}
                onOpen={onOpen}
                onTogglePin={onTogglePin}
              />
              {pinsFull ? (
                <p className="text-xs text-muted-foreground">
                  {t("viewHistory.pinLimit", { values: { count: viewHistoryBounds.pinMax } })}
                </p>
              ) : null}
            </div>
          ) : null}
          {recent.length > 0 ? (
            <div className="grid gap-1">
              {pinned.length > 0 ? (
                <h3
                  id="library-recents-recent"
                  className="text-xs font-semibold text-muted-foreground"
                >
                  {t("viewHistory.recentSection")}
                </h3>
              ) : null}
              <RecentEntries
                t={t}
                entries={recent}
                labelledBy={pinned.length > 0 ? "library-recents-recent" : undefined}
                busy={busy}
                pinsFull={pinsFull}
                focusAddress={focusAddress}
                focusRef={focusRef}
                onOpen={onOpen}
                onTogglePin={onTogglePin}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Loads the recents while the Library is shown and reloads in place when the history changes. A
 * hidden Library loads nothing; shown again it refreshes without a loading state when the last
 * load worked, otherwise the failure stays visible and can be retried.
 */
export function RecentObjects({
  t,
  active,
  focusAddress = null,
  onFocusHandled,
  onOpen
}: {
  t: Translator;
  active: boolean;
  /** An entry to focus once the list shows (the one opened before coming back). */
  focusAddress?: string | null;
  /** Whether the entry to focus was found; the owner focuses something else otherwise. */
  onFocusHandled?: (found: boolean) => void;
  onOpen: (target: RecentTarget, address: string) => void;
}) {
  const [state, setState] = useState<RecentsState>(() =>
    remembered ? { status: "ready", entries: remembered } : { status: "loading" }
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const outcome = useRef<LoadOutcome | null>(
    remembered ? { key: outcomeKey, ok: true, hasData: remembered.length > 0 } : null
  );
  const root = useRef<HTMLElement | null>(null);
  // Where focus goes once the control that had it is replaced: the confirmation group, the Clear
  // button or the title for the Clear flow, the pin button for a pin that moved between groups.
  const pendingFocus = useRef<RecentsFocus | null>(null);

  useEffect(() => {
    // A hidden Library loads nothing; shown again, it reloads below.
    if (!active) return;
    const key = outcomeKey;
    // A list that loaded well is refreshed in place, after being hidden and for a pushed change.
    const silent = outcome.current?.ok === true;
    let live = true;
    if (!silent) setState({ status: "loading" });
    window.app.viewHistory
      .list({ limit: recentsListSize, kinds: [...recentKinds] })
      .then((entries) => {
        if (!live) return;
        outcome.current = { key, ok: true, hasData: entries.length > 0 };
        remembered = entries;
        setState({ status: "ready", entries });
      })
      .catch(() => {
        if (!live) return;
        const previous = outcome.current;
        outcome.current = { key, ok: false, hasData: false };
        if (showsLoadError({ silent, previous, key })) setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [active, refreshKey]);

  // The history changed (an open, a pin, a clear): read it again while the list is shown.
  useAppEvent("view.changed", () => setRefreshKey((value) => value + 1), active);

  // Asking, cancelling and confirming replace the control that had focus: follow it.
  useEffect(() => {
    const request = pendingFocus.current;
    const container = root.current;
    if (!request || request.target === "pin" || !container) return;
    pendingFocus.current = null;
    applyRecentsFocus(request, (target) => findRecentsControl(container, target));
  }, [confirmingClear]);

  // A pin that moved from one group to the other is a new element: focus it once the list changed.
  useEffect(() => {
    const request = pendingFocus.current;
    const container = root.current;
    if (request?.target !== "pin" || !container || state.status !== "ready") return;
    pendingFocus.current = null;
    applyRecentsFocus(request, (target) => findRecentsControl(container, target));
  }, [state]);

  // Coming back to the list focuses the entry that was opened, once the entries are on screen;
  // the owner is told whether it was there.
  const focusTarget = useRef<HTMLButtonElement>(null);
  const focusHandled = useStableCallback((found: boolean) => onFocusHandled?.(found));
  useEffect(() => {
    if (!active || !focusAddress || state.status === "loading") return;
    const entry = focusTarget.current;
    entry?.focus();
    focusHandled(entry !== null);
  }, [active, focusAddress, state, focusHandled]);

  async function change<Result>(
    request: () => Promise<Result>,
    unchanged: (result: Result) => boolean
  ) {
    setBusy(true);
    setFailed(false);
    // A change is pushed and reloads the list; when nothing changed (the entry was already gone)
    // nothing is pushed, so reload here to show the truth.
    let reload = false;
    try {
      reload = unchanged(await request());
    } catch (error) {
      pendingFocus.current = null;
      // A pin refused at the cap means the list was stale: reload it, which also shows the limit.
      if (error instanceof Error && error.message.includes(viewHistoryPinLimitMessage))
        reload = true;
      else setFailed(true);
    }
    setBusy(false);
    if (reload) setRefreshKey((value) => value + 1);
  }

  return (
    <RecentObjectsView
      t={t}
      state={state}
      confirmingClear={confirmingClear}
      busy={busy}
      failed={failed}
      rootRef={root}
      focusAddress={focusAddress}
      focusRef={focusTarget}
      onOpen={(entry) => {
        const target = recentOpenTarget(entry);
        if (target) onOpen(target, entry.address);
      }}
      onTogglePin={(entry) => {
        pendingFocus.current = { target: "pin", address: entry.address };
        void change(
          () => window.app.viewHistory.setPinned(entry.address, !entry.pinned),
          (updated) => updated === null
        );
      }}
      onAskClear={() => {
        pendingFocus.current = { target: "clear-confirmation" };
        setConfirmingClear(true);
      }}
      onConfirmClear={() => {
        // The Clear button may be gone once the unpinned entries are: the title is the stable place.
        pendingFocus.current = { target: "title" };
        setConfirmingClear(false);
        void change(
          () => window.app.viewHistory.clear(),
          (removed) => removed === 0
        );
      }}
      onCancelClear={() => {
        pendingFocus.current = { target: "clear-button" };
        setConfirmingClear(false);
      }}
      onRetry={() => setRefreshKey((value) => value + 1)}
    />
  );
}
