import { useEffect, useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import type { ChangeSetSummary } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { changeSetTitle } from "../../components/activity/change-title";
import { useAppEvent } from "../../lib/app-events";
import { useStableCallback } from "../../lib/stable-callback";
import { cn } from "../../lib/cn";
import { whenText } from "../destinations/home/home-text";
import { countText } from "../context-model";
import { formatView } from "../route";
import {
  ContextEmpty,
  ContextError,
  ContextFrame,
  ContextHeading,
  ContextLink,
  ContextLoading,
  MetaLine,
  useReportedCount,
  useReportedState,
  type ContextTabProps
} from "./context-parts";
import { useContextRead, type Read } from "./context-reads";
import {
  historyRow,
  historyState,
  historyUndoFailure,
  historyUndoKey,
  historyUndoOutcome,
  historyWho,
  type HistoryNote,
  type HistoryUndo
} from "./history-model";

/**
 * The Histórico tab (design record §5.6, §5.7; D31 as amended by A5): what changed in this object,
 * newest first, as the thread of the Home digest and the Activity drawer, each row a sentence, who
 * and when, and Desfazer where the change-set model allows it. The global drawer is "Atividade";
 * this one is never called that. The rows come from `changes.forObject` and Desfazer is the F4
 * `changes.undo`, which names what blocks it: the tab shows the store's own reason, never a guess.
 */
export const tab = "history";
export const surface = "context-history";

const emptyKeys = {
  note: "contextPanel.history.empty.note",
  topic: "contextPanel.history.empty.topic",
  source: "contextPanel.history.empty.source",
  entity: "contextPanel.history.empty.entity",
  question: "contextPanel.history.empty.question"
} as const satisfies Record<ContextTabProps["kind"], MessageKey>;

const noteKeys = {
  waiting: "contextPanel.history.state.waiting",
  undone: "contextPanel.history.state.undone",
  dismissed: "contextPanel.history.state.dismissed",
  blocked: "activity.done.undoBlocked"
} as const satisfies Record<HistoryNote, MessageKey>;

const inboxAddress = formatView({ view: "inbox" });

/** The thread: one 1 px line behind the nodes, which are solid when the change stands. */
function HistoryRow({
  t,
  change,
  local,
  now,
  onUndo,
  onOpen
}: {
  t: Translator;
  change: ChangeSetSummary;
  local: HistoryUndo | undefined;
  now: number;
  onUndo: (change: ChangeSetSummary) => void;
  onOpen: ContextTabProps["onOpen"];
}) {
  const row = historyRow(change, local);
  const sentence = changeSetTitle(t, change);
  // Desfazer unmounts with the undo: the person's focus lands on the line that says it was done,
  // which a screen reader reads, unless focus already went somewhere else.
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const undone = local?.status === "undone";
  useEffect(() => {
    const note = noteRef.current;
    if (!undone || !note) return;
    const active = note.ownerDocument.activeElement;
    if (!active || active === note.ownerDocument.body) note.focus();
  }, [undone]);
  return (
    <li
      className={cn(
        "relative grid gap-0.5 pl-5",
        // The thread runs from this row's node to the next one, and stops at the last node.
        "not-last:after:absolute not-last:after:top-[0.9rem] not-last:after:-bottom-[1.4rem] not-last:after:left-[3.5px] not-last:after:w-px not-last:after:bg-[var(--thread)]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[0.4rem] left-0 size-2 rounded-full",
          row.node === "done" ? "bg-muted-foreground" : "border border-border-strong bg-background"
        )}
      />
      <p className="m-0 text-sm leading-5 text-foreground [overflow-wrap:anywhere] [text-wrap:pretty]">
        {sentence}
      </p>
      <MetaLine
        parts={[
          t(
            historyWho(change) === "you"
              ? "contextPanel.history.by.you"
              : "contextPanel.history.by.gardener"
          ),
          whenText(t, change.at, now)
        ]}
      />
      {row.note === "waiting" ? (
        // The decision is made in the Caixa de entrada: the line takes the person there.
        <div className="mt-0.5">
          <ContextLink onClick={() => onOpen(inboxAddress)}>{t(noteKeys.waiting)}</ContextLink>
        </div>
      ) : row.note ? (
        <p
          ref={noteRef}
          {...(undone ? { role: "status", tabIndex: -1 } : {})}
          className="m-0 text-xs leading-5 text-muted-foreground outline-none"
        >
          {t(noteKeys[row.note])}
        </p>
      ) : null}
      {row.undo ? (
        <span className="mt-0.5">
          <ContextLink
            disabled={row.undo === "running"}
            aria-label={t("contextPanel.history.undoLabel", { values: { title: sentence } })}
            onClick={() => onUndo(change)}
            className="inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Undo2 aria-hidden="true" className="size-3" />
            {row.undo === "running" ? t("activity.done.undoing") : t("activity.done.undo")}
          </ContextLink>
        </span>
      ) : null}
      {row.refusal ? (
        <p role="alert" className="m-0 text-xs leading-5 text-secondary-foreground">
          {t(row.refusal)}
        </p>
      ) : null}
    </li>
  );
}

export function HistoryView({
  t,
  kind,
  read,
  undo,
  now,
  onUndo,
  onOpen,
  onRetry
}: {
  t: Translator;
  kind: ContextTabProps["kind"];
  read: Read<{ items: readonly ChangeSetSummary[] }>;
  undo: Readonly<Record<string, HistoryUndo>>;
  now: number;
  onUndo: (change: ChangeSetSummary) => void;
  onOpen: ContextTabProps["onOpen"];
  onRetry: () => void;
}) {
  const items = read.status === "ready" ? read.value.items : [];
  const state = historyState(read.status === "ready" ? { status: "ready", items } : read);
  const full = items.length >= 20;
  const detail =
    state === "success"
      ? full
        ? t("contextPanel.history.latest", {
            values: { count: new Intl.NumberFormat(t.locale).format(items.length) }
          })
        : `${countText(t, "changes", items.length)}.`
      : undefined;
  return (
    <ContextFrame surface={surface} state={state}>
      <ContextHeading
        title={t("contextPanel.headings.history.title")}
        description={t("contextPanel.headings.history.description")}
        detail={detail}
      />
      {read.status === "loading" ? (
        <ContextLoading t={t} rows={3} />
      ) : read.status === "error" ? (
        <ContextError t={t} message="contextPanel.errors.history" kept={kind} onRetry={onRetry} />
      ) : state === "empty" ? (
        <ContextEmpty>{t(emptyKeys[kind])}</ContextEmpty>
      ) : (
        <ol
          aria-label={t("contextPanel.history.label")}
          className="relative m-0 grid list-none gap-4 p-0"
        >
          {items.map((change) => (
            <HistoryRow
              key={historyUndoKey(change)}
              t={t}
              change={change}
              local={undo[historyUndoKey(change)]}
              now={now}
              onUndo={onUndo}
              onOpen={onOpen}
            />
          ))}
        </ol>
      )}
    </ContextFrame>
  );
}

export function HistoryTab(props: ContextTabProps) {
  const { t, kind, id, address, active, onState, onCount, onOpen } = props;
  const { read, reread, retry } = useContextRead<{ items: ChangeSetSummary[] }>({
    key: `history:${address}`,
    active,
    follow: [address],
    load: (app) => app.changes.forObject({ kind, id })
  });
  // A change-set that changed status (undone, applied or dismissed after review) reads again.
  useAppEvent("changes.changed", reread, active);

  const [undo, setUndo] = useState<Readonly<Record<string, HistoryUndo>>>({});
  const [now] = useState(() => Date.now());
  const onUndo = useStableCallback(async (change: ChangeSetSummary) => {
    const key = historyUndoKey(change);
    if (undo[key]?.status === "pending") return;
    setUndo((current) => ({ ...current, [key]: { status: "pending" } }));
    let outcome: HistoryUndo;
    try {
      const api = typeof window === "undefined" ? undefined : window.app;
      if (!api) throw new Error("window.app is not available");
      outcome = historyUndoOutcome(await api.changes.undo({ kind: change.kind, id: change.id }));
    } catch (error) {
      outcome = historyUndoFailure(error);
    }
    setUndo((current) => ({ ...current, [key]: outcome }));
    // The object reads its change-sets again (the status is the store's, not this row's).
    if (outcome.status === "undone") reread();
  });

  const state = historyState(
    read.status === "ready" ? { status: "ready", items: read.value.items } : read
  );
  useReportedState(state, onState);
  useReportedCount(read.status === "ready" ? read.value.items.length : null, onCount);
  return (
    <HistoryView
      t={t}
      kind={kind}
      read={read}
      undo={undo}
      now={now}
      onUndo={onUndo}
      onOpen={onOpen}
      onRetry={retry}
    />
  );
}
export { HistoryTab as Component };
