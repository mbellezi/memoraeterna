import { useId, type KeyboardEventHandler, type ReactNode, type Ref } from "react";
import { X } from "lucide-react";
import type { ChangeSetSummary, GardenerStatusAction } from "@app/domain";
import type { Translator } from "@app/i18n";

import {
  actionButtons,
  effectiveStatus,
  needsYouEntries,
  statusSection,
  type ActivitySnapshot
} from "./activity-model";
import {
  actionStateOf,
  BudgetMeters,
  CoverageList,
  DoneList,
  EmptyLine,
  FailedLine,
  JobFactsLine,
  LoadingLine,
  needsYouIsEmpty,
  NeedsYouList,
  SentenceBlock,
  WaitingJobsLine
} from "./ActivitySections";

export interface ActivityDrawerProps {
  t: Translator;
  snapshot: ActivitySnapshot;
  /** The clock the sentences and times are read against. */
  now: number;
  id: string;
  ref?: Ref<HTMLElement>;
  onClose: () => void;
  onRetry: () => void;
  onAction: (action: GardenerStatusAction) => void;
  onUndo: (change: ChangeSetSummary) => void;
  /** Opens the Inbox; the list shows the count without a button while there is none. */
  onOpenInbox?: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-2 border-t border-border px-4 py-3">
      <h3 id={headingId} className="text-xs font-semibold text-secondary-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Everything the Gardener is doing and what it asks of the person, beside whatever they are
 * reading: now, waiting (with the reason), needs you, done (with Undo), budget. It is not a dialog:
 * it never traps focus, the page behind stays usable, Escape and the close button end it.
 */
export function ActivityDrawer({
  t,
  snapshot,
  now,
  id,
  ref,
  onClose,
  onRetry,
  onAction,
  onUndo,
  onOpenInbox,
  onKeyDown
}: ActivityDrawerProps) {
  const titleId = useId();
  const status = effectiveStatus(snapshot);
  const section = status ? statusSection(status) : null;
  const budget = snapshot.budget.status === "ready" ? snapshot.budget.value : null;
  const state = actionStateOf(snapshot);
  const statusLoading = snapshot.status.status === "loading";
  const statusFailed = snapshot.status.status === "error";
  const inbox = snapshot.inboxTotal ?? 0;
  // The pill's "waiting" clause counts these; the Waiting section lists the same ones.
  const waitingJobs = snapshot.jobs ? snapshot.jobs.waiting + snapshot.jobs.onHold : 0;
  const entries = status ? needsYouEntries({ t, status, budget, now }) : [];
  return (
    <aside
      id={id}
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="fixed bottom-0 right-0 top-(--top-h,3.5rem) z-40 flex w-100 max-w-full flex-col border-l border-border bg-surface shadow-[var(--shadow-pop)] focus-visible:outline-none"
      onKeyDown={onKeyDown}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
        <h2 id={titleId} className="min-w-0 text-sm font-semibold text-foreground">
          {t("activity.title")}
          <span className="font-normal text-muted-foreground">
            {` · ${t("activity.drawer.explainer")}`}
          </span>
        </h2>
        <button
          type="button"
          className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-soft hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={t("activity.drawer.close")}
          title={t("activity.drawer.close")}
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]">
        <Section title={t("activity.sections.now")}>
          {statusLoading ? <LoadingLine t={t} /> : null}
          {statusFailed ? (
            <FailedLine t={t} message={t("activity.drawer.loadFailed")} onRetry={onRetry} />
          ) : null}
          {status && section === "now" ? (
            <SentenceBlock
              t={t}
              status={status}
              now={now}
              actions={actionButtons(t, status)}
              state={state}
              onAction={onAction}
            />
          ) : null}
          {status && section !== "now" ? <EmptyLine>{t("activity.now.nothing")}</EmptyLine> : null}
          {status ? <CoverageList t={t} coverage={status.coverage} /> : null}
          {snapshot.jobs ? <JobFactsLine t={t} jobs={snapshot.jobs} /> : null}
        </Section>
        {/* Waiting and Needs you appear only when they have something to say (§5.8). */}
        {statusLoading ? (
          <Section title={t("activity.sections.waiting")}>
            <LoadingLine t={t} lines={1} />
          </Section>
        ) : null}
        {status && (section === "waiting" || waitingJobs > 0) ? (
          <Section title={t("activity.sections.waiting")}>
            {section === "waiting" ? (
              <SentenceBlock
                t={t}
                status={status}
                now={now}
                actions={actionButtons(t, status)}
                state={state}
                onAction={onAction}
              />
            ) : (
              <WaitingJobsLine t={t} count={waitingJobs} />
            )}
          </Section>
        ) : null}
        {statusLoading ? (
          <Section title={t("activity.sections.needsYou")}>
            <LoadingLine t={t} lines={1} />
          </Section>
        ) : null}
        {status && !needsYouIsEmpty(entries, inbox) ? (
          <Section title={t("activity.sections.needsYou")}>
            <NeedsYouList
              t={t}
              entries={entries}
              inboxTotal={inbox}
              state={state}
              onAction={onAction}
              {...(onOpenInbox ? { onOpenInbox } : {})}
            />
          </Section>
        ) : null}
        {/* A failed activity read says so once, at the top; the sections below do not repeat it. */}
        {!(statusFailed && snapshot.done.status === "error") ? (
          <Section title={t("activity.sections.done")}>
            {snapshot.done.status === "loading" ? <LoadingLine t={t} /> : null}
            {snapshot.done.status === "error" ? (
              <FailedLine t={t} message={t("activity.done.loadFailed")} onRetry={onRetry} />
            ) : null}
            {snapshot.done.status === "ready" ? (
              <DoneList
                t={t}
                changes={snapshot.done.value}
                now={now}
                snapshot={snapshot}
                onUndo={onUndo}
              />
            ) : null}
          </Section>
        ) : null}
        {!(statusFailed && snapshot.budget.status === "error") ? (
          <Section title={t("activity.sections.budget")}>
            {snapshot.budget.status === "loading" ? <LoadingLine t={t} /> : null}
            {snapshot.budget.status === "error" ? (
              <FailedLine t={t} message={t("activity.budget.loadFailed")} onRetry={onRetry} />
            ) : null}
            {budget ? <BudgetMeters t={t} budget={budget} /> : null}
          </Section>
        ) : null}
      </div>
    </aside>
  );
}
