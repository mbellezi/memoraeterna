import { useMemo, useState } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { ErrorState } from "../../components/ui/error-state";
import { RunningRing, SolidCheck, SolidTriangle } from "../../components/ui/solid-glyphs";
import { LoadingState, Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import {
  callLogState,
  callRowsOf,
  nextCallLimit,
  type CallFilter,
  type CallResult
} from "./call-log-model";
import { PruneDialog } from "./PruneDialog";
import type { CallLogState } from "./use-call-log";

const headClass = "py-2 pr-3 text-left text-xs font-semibold text-secondary-foreground";
const cellClass = "py-2 pr-3 align-top text-sm text-foreground";

/** The glyph and colour of a call's result: a state is a solid shape plus a word (design record §4.1). */
function ResultMark({ result }: { result: CallResult }) {
  if (result === "succeeded") return <SolidCheck className="text-success" />;
  if (result === "running") return <RunningRing />;
  return <SolidTriangle className={result === "failed" ? "text-danger" : "text-warning"} />;
}

/**
 * The AI call log (design record §7.6, Advanced › Diagnostics): the latest calls to a model, local
 * or in the cloud, read-only, with the way to delete old records. Four states in place: loading
 * (rows shaped like the table), empty (what the log is and when it fills), error (one sentence, what
 * is kept, one retry) and the table itself.
 */
export function CallLogView({ t, state }: { t: Translator; state: CallLogState }) {
  const { read, filter } = state;
  const [pruning, setPruning] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);
  const rows = useMemo(
    () => (read.status === "ready" ? callRowsOf(read.value, t, new Date()) : []),
    [read, t]
  );

  const filters: ReadonlyArray<{ id: CallFilter; label: string }> = [
    { id: "all", label: t("diagnostics.callLog.filterAll") },
    { id: "failed", label: t("diagnostics.callLog.filterFailed") }
  ];
  const chips = (
    <div role="group" aria-label={t("diagnostics.callLog.filterLabel")} className="flex gap-1">
      {filters.map((option) => (
        <Button
          key={option.id}
          variant="chip"
          size="sm"
          aria-pressed={filter === option.id}
          onClick={() => state.setFilter(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
  const skeleton = (
    <LoadingState t={t} className="max-w-[45rem]">
      <div className="grid gap-3 pt-1">
        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className="grid grid-cols-[3rem_7rem_minmax(0,1fr)_3.5rem_3.5rem_5rem] gap-3"
          >
            {["w-full", "w-full", "w-4/5", "w-full", "w-full", "w-full"].map((width, cell) => (
              <Skeleton key={cell} className={cn("h-3.5", width)} />
            ))}
          </div>
        ))}
      </div>
    </LoadingState>
  );

  // A new filter is being read: the chips stay (the person is on one) and the rows come.
  if (read.status === "loading" && state.switching)
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">{chips}</div>
        {skeleton}
      </div>
    );

  if (read.status === "loading") return skeleton;

  if (read.status === "error")
    return (
      <ErrorState
        t={t}
        message={t("diagnostics.callLog.errorTitle")}
        kept={t("diagnostics.callLog.errorKept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={state.retry}
      />
    );

  const { totals } = read.value;
  const total = new Intl.NumberFormat(t.locale).format(totals.count);
  const next = nextCallLimit(state.limit, totals.count);

  if (callLogState(read, filter) === "empty")
    return (
      <EmptyState headline={t("diagnostics.callLog.emptyTitle")}>
        {t("diagnostics.callLog.emptyBody")}
      </EmptyState>
    );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {chips}
        <p className="m-0 text-xs text-secondary-foreground" aria-live="polite">
          {t(
            totals.count === 1 ? "diagnostics.callLog.countOne" : "diagnostics.callLog.countMany",
            {
              values: { count: total }
            }
          )}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState variant="compact" headline={t("diagnostics.callLog.noneFailed")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">{t("diagnostics.callLog.caption")}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={headClass}>
                  {t("diagnostics.callLog.columns.when")}
                </th>
                <th scope="col" className={headClass}>
                  {t("diagnostics.callLog.columns.job")}
                </th>
                <th scope="col" className={headClass}>
                  {t("diagnostics.callLog.columns.model")}
                </th>
                <th scope="col" className={cn(headClass, "text-right")}>
                  {t("diagnostics.callLog.columns.time")}
                </th>
                <th scope="col" className={cn(headClass, "text-right")}>
                  {t("diagnostics.callLog.columns.tokens")}
                </th>
                <th scope="col" className={cn(headClass, "pr-0")}>
                  {t("diagnostics.callLog.columns.result")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td
                    className={cn(cellClass, "whitespace-nowrap tabular-nums")}
                    title={row.whenFull}
                  >
                    {row.when}
                  </td>
                  <td className={cn(cellClass, "font-mono text-xs [overflow-wrap:anywhere]")}>
                    {row.job}
                  </td>
                  <td className={cn(cellClass, "[overflow-wrap:anywhere]")}>
                    {row.model ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn(cellClass, "whitespace-nowrap text-right tabular-nums")}>
                    {row.duration ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn(cellClass, "whitespace-nowrap text-right tabular-nums")}>
                    {row.tokens ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn(cellClass, "pr-0")}>
                    <span className="flex items-start gap-1.5">
                      <span className="mt-0.5">
                        <ResultMark result={row.result} />
                      </span>
                      <span className="min-w-0">
                        {row.resultLabel}
                        {row.error ? (
                          <span className="block text-xs text-secondary-foreground [overflow-wrap:anywhere]">
                            {row.error}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {next !== null ? (
          <Button onClick={() => state.showMore(next)}>{t("diagnostics.callLog.showMore")}</Button>
        ) : totals.count > rows.length ? (
          <p className="m-0 text-xs text-muted-foreground">
            {t("diagnostics.callLog.limitNote", {
              values: { count: new Intl.NumberFormat(t.locale).format(rows.length) }
            })}
          </p>
        ) : null}
        <Button variant="ghost" onClick={() => setPruning(true)}>
          {t("diagnostics.callLog.prune")}
        </Button>
        {deleted !== null ? (
          <p role="status" className="m-0 text-xs text-secondary-foreground">
            {t(deleted === 1 ? "diagnostics.prune.deletedOne" : "diagnostics.prune.deletedMany", {
              values: { count: new Intl.NumberFormat(t.locale).format(deleted) }
            })}
          </p>
        ) : null}
      </div>
      <PruneDialog
        t={t}
        open={pruning}
        onOpenChange={setPruning}
        onDeleted={(count) => {
          setDeleted(count);
          state.refresh();
        }}
      />
    </div>
  );
}
