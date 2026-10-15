import { useEffect, useRef, useState } from "react";
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
import type { MessageKey, Translator } from "@app/i18n";
import type { ObjectKind, ViewHistoryEntry } from "../../shared/view-history";
import { cn } from "../lib/cn";
import { showsLoadError, type LoadOutcome } from "../lib/hidden-view";
import {
  recentKinds,
  recentOpenTarget,
  recentsListSize,
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

/** The last objects opened, pinned ones first. Presentation only: the container loads and acts. */
export function RecentObjectsView({
  t,
  state,
  confirmingClear,
  busy,
  failed,
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
  onOpen: (entry: ViewHistoryEntry) => void;
  onTogglePin: (entry: ViewHistoryEntry) => void;
  onAskClear: () => void;
  onConfirmClear: () => void;
  onCancelClear: () => void;
  onRetry: () => void;
}) {
  const entries = state.status === "ready" ? state.entries : [];
  return (
    <section
      aria-labelledby="library-recents-title"
      className="grid gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <header className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2
          id="library-recents-title"
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t("viewHistory.title")}
        </h2>
        {confirmingClear ? (
          <div className="flex flex-wrap items-center gap-2" role="group">
            <span className="text-xs text-muted-foreground">{t("viewHistory.clearQuestion")}</span>
            <Button type="button" disabled={busy} onClick={onConfirmClear}>
              {t("viewHistory.clearConfirm")}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancelClear}>
              {t("shell.actions.cancel")}
            </Button>
          </div>
        ) : entries.some((entry) => !entry.pinned) ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={onAskClear}>
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
        <ul className="grid gap-1 md:grid-cols-2">
          {entries.map((entry) => {
            const Icon = kindIcons[entry.kind];
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
                  title={entry.title}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-soft focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => onOpen(entry)}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  {entry.pinned ? (
                    <span className="flex shrink-0 items-center text-accent">
                      <Pin className="h-3 w-3 fill-current" aria-hidden="true" />
                      <span className="sr-only">{t("viewHistory.pinned")}</span>
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(kindLabel(entry.kind))}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={pinLabel}
                  title={pinLabel}
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
  onOpen
}: {
  t: Translator;
  active: boolean;
  onOpen: (target: RecentTarget) => void;
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

  useEffect(() => {
    if (!active) return;
    return window.app.viewHistory.subscribeChanged(() => setRefreshKey((value) => value + 1));
  }, [active]);

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
    } catch {
      setFailed(true);
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
      onOpen={(entry) => {
        const target = recentOpenTarget(entry);
        if (target) onOpen(target);
      }}
      onTogglePin={(entry) =>
        void change(
          () => window.app.viewHistory.setPinned(entry.address, !entry.pinned),
          (updated) => updated === null
        )
      }
      onAskClear={() => setConfirmingClear(true)}
      onConfirmClear={() => {
        setConfirmingClear(false);
        void change(
          () => window.app.viewHistory.clear(),
          (removed) => removed === 0
        );
      }}
      onCancelClear={() => setConfirmingClear(false)}
      onRetry={() => setRefreshKey((value) => value + 1)}
    />
  );
}
