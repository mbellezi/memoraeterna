import { useMemo, useState } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { ErrorState } from "../../components/ui/error-state";
import { SolidCheck, SolidTriangle } from "../../components/ui/solid-glyphs";
import { LoadingState, Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { WhenCell } from "./WhenCell";
import { ConfirmDialog } from "./ConfirmDialog";
import { taskRowsOf, type RunOutcome } from "./task-history-model";
import type { TaskHistoryState } from "./use-call-log";

const headClass = "py-2 pr-3 text-left text-xs font-semibold text-secondary-foreground";
const cellClass = "py-2 pr-3 align-top text-sm text-foreground";

function OutcomeMark({ outcome }: { outcome: RunOutcome }) {
  if (outcome === "succeeded") return <SolidCheck className="text-success" />;
  return <SolidTriangle className={outcome === "failed" ? "text-danger" : "text-warning"} />;
}

type Clearing = { step: "closed" } | { step: "asking" } | { step: "working" } | { step: "failed" };

/**
 * The job history (design record §7.6, Advanced › Diagnostics): the imports and background jobs that
 * finished, failed or were canceled, newest first, with "Clear job history" (asked first). What is
 * running now is in Activity. Four states in place, as the call log has them.
 */
export function TaskHistoryView({ t, state }: { t: Translator; state: TaskHistoryState }) {
  const { read } = state;
  const [clearing, setClearing] = useState<Clearing>({ step: "closed" });
  const [cleared, setCleared] = useState<number | null>(null);
  const rows = useMemo(
    () => (read.status === "ready" ? taskRowsOf(read.value, t, new Date()) : []),
    [read, t]
  );

  if (read.status === "loading")
    return (
      <LoadingState t={t} className="max-w-[45rem]">
        <div className="grid gap-3 pt-1">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="grid grid-cols-[6.25rem_minmax(0,1fr)_9rem_5.5rem] gap-3">
              <Skeleton className="h-3.5" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5" />
              <Skeleton className="h-3.5" />
            </div>
          ))}
        </div>
      </LoadingState>
    );

  if (read.status === "error")
    return (
      <ErrorState
        t={t}
        message={t("diagnostics.taskHistory.errorTitle")}
        kept={t("diagnostics.taskHistory.errorKept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={state.retry}
      />
    );

  if (rows.length === 0)
    return (
      <EmptyState headline={t("diagnostics.taskHistory.emptyTitle")}>
        {t("diagnostics.taskHistory.emptyBody")}
      </EmptyState>
    );

  const clear = () => {
    setClearing({ step: "working" });
    window.app.jobs
      .clearCompletedOrFailed()
      .then((result) => {
        setCleared(result.deletedCount);
        setClearing({ step: "closed" });
        state.refresh();
      })
      .catch(() => setClearing({ step: "failed" }));
  };

  return (
    <div className="grid gap-3">
      <p className="m-0 text-xs text-secondary-foreground" aria-live="polite">
        {t(
          rows.length === 1
            ? "diagnostics.taskHistory.countOne"
            : "diagnostics.taskHistory.countMany",
          {
            values: { count: new Intl.NumberFormat(t.locale).format(rows.length) }
          }
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] table-fixed border-collapse">
          <caption className="sr-only">{t("diagnostics.taskHistory.caption")}</caption>
          <colgroup>
            <col className="w-[6.25rem]" />
            <col />
            <col className="w-48" />
            <col className="w-[5.5rem]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={headClass}>
                {t("diagnostics.taskHistory.columns.when")}
              </th>
              <th scope="col" className={headClass}>
                {t("diagnostics.taskHistory.columns.job")}
              </th>
              <th scope="col" className={headClass}>
                {t("diagnostics.taskHistory.columns.result")}
              </th>
              <th scope="col" className={cn(headClass, "pr-0 text-right")}>
                {t("diagnostics.taskHistory.columns.duration")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                <WhenCell className={cellClass} row={row} />
                <td className={cn(cellClass, "[overflow-wrap:anywhere]")}>
                  {row.title}
                  {row.detail ? (
                    <span className="block text-xs text-secondary-foreground">{row.detail}</span>
                  ) : null}
                </td>
                <td className={cellClass}>
                  <span className="flex items-start gap-1.5">
                    <span className="mt-0.5">
                      <OutcomeMark outcome={row.outcome} />
                    </span>
                    <span className="min-w-0">
                      {row.outcomeLabel}
                      {row.error ? (
                        <span className="block text-xs text-secondary-foreground [overflow-wrap:anywhere]">
                          {row.error}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </td>
                <td className={cn(cellClass, "whitespace-nowrap pr-0 text-right tabular-nums")}>
                  {row.duration ?? <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="ghost"
          className="-ml-[13px]"
          onClick={() => setClearing({ step: "asking" })}
        >
          {t("diagnostics.taskHistory.clear")}
        </Button>
        {cleared !== null ? (
          <p role="status" className="m-0 text-xs text-secondary-foreground">
            {t(
              cleared === 1
                ? "diagnostics.taskHistory.clearedOne"
                : "diagnostics.taskHistory.clearedMany",
              { values: { count: new Intl.NumberFormat(t.locale).format(cleared) } }
            )}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        t={t}
        open={clearing.step !== "closed"}
        onOpenChange={(open) => {
          if (!open && clearing.step !== "working") setClearing({ step: "closed" });
        }}
        title={t("diagnostics.taskHistory.clearTitle")}
        description={t("diagnostics.taskHistory.clearBody")}
        confirmLabel={t("diagnostics.taskHistory.clearConfirm")}
        onConfirm={clear}
        busy={clearing.step === "working"}
      >
        {clearing.step === "failed" ? (
          <p role="alert" className="m-0 text-sm text-secondary-foreground">
            {t("diagnostics.taskHistory.clearFailed")}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
