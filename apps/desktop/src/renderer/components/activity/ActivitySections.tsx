import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, PauseCircle } from "lucide-react";
import {
  formatStatusTime,
  statusSentence,
  type BudgetSnapshot,
  type ChangeSetSummary,
  type GardenerStatusAction,
  type GardenerStatusSnapshot
} from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { LoadingState, SkeletonLines } from "../ui/skeleton";
import {
  budgetView,
  percentText,
  undoKey,
  type ActionButton,
  type ActivitySnapshot,
  type JobFacts,
  type NeedsYouEntry
} from "./activity-model";
import { changeSetTitle } from "./change-title";

/** A section whose read is loading: a busy status region and, after 150 ms, bars in the shape of its text (§5.12). */
export function LoadingLine({ t, lines = 2 }: { t: Translator; lines?: number }) {
  return (
    <LoadingState t={t}>
      <SkeletonLines lines={lines} />
    </LoadingState>
  );
}

/** A read that failed stays visible and retryable. */
export function FailedLine({
  t,
  message,
  onRetry
}: {
  t: Translator;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid justify-items-start gap-1">
      <p role="alert" className="text-sm text-foreground">
        {message}
      </p>
      {/* The link's own padding is pulled back, so its words start where the sentence does. */}
      <Button variant="link" className="-ml-[13px]" onClick={onRetry}>
        {t("shell.actions.retry")}
      </Button>
    </div>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * The jobs that wait their turn, with the reason, for the Waiting section while the status itself
 * holds nothing: the pill counts them, so the section must not say that nothing waits.
 */
export function WaitingJobsLine({ t, count }: { t: Translator; count: number }) {
  const key =
    new Intl.PluralRules(t.locale).select(count) === "one"
      ? "activity.waiting.jobsOne"
      : "activity.waiting.jobsMany";
  return (
    <p className="text-sm text-secondary-foreground">
      {t(key, { values: { count: new Intl.NumberFormat(t.locale).format(count) } })}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Status sentences (Now, Waiting)

/** The status action being run, and the one that failed last; either may be null. */
export interface ActionState {
  pending: GardenerStatusAction | null;
  failed: GardenerStatusAction | null;
}

export const actionStateOf = (snapshot: ActivitySnapshot): ActionState => ({
  pending: snapshot.statusAction?.status === "pending" ? snapshot.statusAction.action : null,
  failed: snapshot.statusAction?.status === "failed" ? snapshot.statusAction.action : null
});

function ActionButtons({
  actions,
  state,
  t,
  onAction
}: {
  actions: readonly ActionButton[];
  state: ActionState;
  t: Translator;
  onAction: (action: GardenerStatusAction) => void;
}) {
  if (actions.length === 0) return null;
  const failed = actions.some((action) => action.id === state.failed);
  return (
    <div className="grid justify-items-start gap-1">
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => (
          <Button
            key={action.id}
            variant={index === 0 ? "primary" : "secondary"}
            disabled={state.pending !== null}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {failed ? (
        <p role="alert" className="text-xs text-danger">
          {t("activity.actions.failed")}
        </p>
      ) : null}
    </div>
  );
}

/** One status sentence: the message, the amounts, the time left, and what the person can do. */
export function SentenceBlock({
  t,
  status,
  now,
  actions,
  state,
  onAction
}: {
  t: Translator;
  status: GardenerStatusSnapshot;
  now: number;
  actions: readonly ActionButton[];
  state: ActionState;
  onAction: (action: GardenerStatusAction) => void;
}) {
  const sentence = statusSentence(status, t.locale, { now });
  return (
    <div className="grid gap-1.5">
      <p className="text-sm text-foreground">{sentence.headline}</p>
      {sentence.detail ? (
        <p className="text-xs text-secondary-foreground">{sentence.detail}</p>
      ) : null}
      {sentence.eta ? <p className="text-xs text-secondary-foreground">{sentence.eta}</p> : null}
      <ActionButtons t={t} actions={actions} state={state} onAction={onAction} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Now

function Bar({ share }: { share: number }) {
  return (
    <div
      aria-hidden="true"
      className="h-2.5 overflow-hidden rounded-full border border-border-strong bg-soft"
    >
      <div className="h-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
  );
}

const coverageLabels = {
  placed: "activity.now.coverage.placed",
  matched: "activity.now.coverage.matched",
  overviewsFresh: "activity.now.coverage.overviewsFresh"
} as const;

export function CoverageList({
  t,
  coverage
}: {
  t: Translator;
  coverage: GardenerStatusSnapshot["coverage"];
}) {
  return (
    <ul className="grid gap-2">
      {(Object.keys(coverageLabels) as Array<keyof typeof coverageLabels>).map((name) => (
        <li key={name} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-secondary-foreground">{t(coverageLabels[name])}</span>
            <span className="tabular-nums text-foreground">
              {percentText(t.locale, coverage[name])}
            </span>
          </div>
          <Bar share={coverage[name]} />
        </li>
      ))}
    </ul>
  );
}

export function JobFactsLine({ t, jobs }: { t: Translator; jobs: JobFacts }) {
  const number = new Intl.NumberFormat(t.locale);
  const facts = [
    ["activity.now.running", jobs.running],
    ["activity.now.waiting", jobs.waiting],
    ["activity.now.onHold", jobs.onHold]
  ] as const;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-foreground">
      {facts.map(([key, value]) => (
        <div key={key} className="flex gap-1">
          <dt>{t(key)}</dt>
          <dd className="tabular-nums text-foreground">{number.format(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Needs you

/** Whether the Needs you section has anything to say: it is left out of the drawer when it has not. */
export function needsYouIsEmpty(entries: readonly NeedsYouEntry[], inboxTotal: number): boolean {
  return entries.length === 0 && inboxTotal === 0;
}

export function NeedsYouList({
  t,
  entries,
  inboxTotal,
  state,
  onAction,
  onOpenInbox
}: {
  t: Translator;
  entries: readonly NeedsYouEntry[];
  inboxTotal: number;
  state: ActionState;
  onAction: (action: GardenerStatusAction) => void;
  onOpenInbox?: () => void;
}) {
  if (needsYouIsEmpty(entries, inboxTotal))
    return <EmptyLine>{t("activity.needsYou.empty")}</EmptyLine>;
  return (
    <ul className="grid gap-3">
      {entries.map((entry) => (
        <li key={entry.key} className="grid gap-1.5">
          <p className="text-sm text-foreground">{entry.sentence.headline}</p>
          {entry.sentence.detail ? (
            <p className="text-xs text-secondary-foreground">{entry.sentence.detail}</p>
          ) : null}
          {entry.sentence.eta ? (
            <p className="text-xs text-secondary-foreground">{entry.sentence.eta}</p>
          ) : null}
          <ActionButtons t={t} actions={entry.actions} state={state} onAction={onAction} />
        </li>
      ))}
      {inboxTotal > 0 ? (
        <li className="grid justify-items-start gap-1.5">
          <p className="text-sm text-foreground">
            {t("activity.needsYou.inbox", {
              values: { count: new Intl.NumberFormat(t.locale).format(inboxTotal) }
            })}
          </p>
          {onOpenInbox ? (
            <Button variant="secondary" onClick={onOpenInbox}>
              {t("activity.needsYou.openInbox")}
            </Button>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Done

export function DoneList({
  t,
  changes,
  now,
  snapshot,
  onUndo
}: {
  t: Translator;
  changes: readonly ChangeSetSummary[];
  now: number;
  snapshot: ActivitySnapshot;
  onUndo: (change: ChangeSetSummary) => void;
}) {
  if (changes.length === 0) return <EmptyLine>{t("activity.done.empty")}</EmptyLine>;
  return (
    <ul className="grid">
      {changes.map((change) => {
        const row = snapshot.undo[undoKey(change)];
        const pending = row?.status === "pending";
        return (
          <li
            key={undoKey(change)}
            className="grid gap-1 border-t border-border py-2 first:border-t-0"
          >
            <p className="text-sm text-foreground">
              {changeSetTitle(t, change)}
              <span className="text-muted-foreground">
                {` · ${formatStatusTime(t.locale, new Date(change.at), new Date(now))}`}
              </span>
            </p>
            {change.undo === "available" ? (
              <Button
                variant="link"
                className="-ml-[13px] justify-self-start"
                disabled={pending}
                onClick={() => onUndo(change)}
              >
                {pending ? t("activity.done.undoing") : t("activity.done.undo")}
              </Button>
            ) : change.undo === "blocked" && row === undefined ? (
              <p className="text-xs text-muted-foreground">{t("activity.done.undoBlocked")}</p>
            ) : null}
            {row && row.status !== "pending" ? (
              <p role="alert" className="text-xs text-secondary-foreground">
                {t(row.messageKey)}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Budget

const moneyStates = {
  open: { icon: CheckCircle2, tone: "text-success", label: "activity.budget.state.open" },
  paused: { icon: PauseCircle, tone: "text-warning", label: "activity.budget.state.paused" },
  exhausted: { icon: CircleAlert, tone: "text-danger", label: "activity.budget.state.exhausted" }
} as const;

export function BudgetMeters({ t, budget }: { t: Translator; budget: BudgetSnapshot }) {
  const view = budgetView(t.locale, budget);
  const state = moneyStates[view.money.state];
  const Icon = state.icon;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <p className="text-sm text-foreground">
          {t("gardener.status.detail.budget", {
            values: { spent: view.money.spent, cap: view.money.cap }
          })}
        </p>
        <Bar share={view.money.share} />
        <p className={cn("flex items-center gap-1.5 text-xs", state.tone)}>
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
          {t(state.label)}
        </p>
      </div>
      {view.subscription ? (
        <div className="grid gap-1.5">
          <p className="text-sm text-foreground">{t("activity.budget.subscription")}</p>
          <p className="text-xs text-secondary-foreground">
            {t("activity.budget.allowance", {
              values: { share: percentText(t.locale, view.subscription.share) }
            })}
          </p>
          <Bar share={view.subscription.share} />
        </div>
      ) : null}
    </div>
  );
}
