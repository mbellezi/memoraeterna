import type { Translator } from "@app/i18n";

import { ErrorState } from "../../components/ui/error-state";
import { callLogState } from "./call-log-model";
import { CallLogView } from "./CallLogView";
import { diagnosticsState, taskHistoryState } from "./task-history-model";
import { TaskHistoryView } from "./TaskHistoryView";
import { useCallLog, useTaskHistory } from "./use-call-log";

/**
 * Both Diagnostics pages open at once under one frame: the surface the screens tool and the live
 * capture read the four states of, with the same views the Advanced section opens in place. Its
 * frame says loading while either page reads, error when either failed, empty when neither has
 * anything and success otherwise. The app reaches the pages through
 * `memora://settings/advanced#advanced.callLog` and `#advanced.taskHistory`.
 */
export function DiagnosticsSurface({
  t,
  surface = "settings-diagnostics"
}: {
  t: Translator;
  surface?: string;
}) {
  const calls = useCallLog(true);
  const tasks = useTaskHistory(true);
  const now = new Date();
  const state = diagnosticsState([
    callLogState(calls.read, calls.filter),
    taskHistoryState(tasks.read, t, now)
  ]);
  // One cause, one failure: when neither page could be read, the page says so once, with one retry.
  const failedTogether = calls.read.status === "error" && tasks.read.status === "error";
  return (
    <div
      data-surface={surface}
      data-state={state}
      className="min-h-full bg-surface px-10 pb-12 pt-6 text-foreground"
    >
      <div className="max-w-[45rem]">
        <h2 className="m-0 font-reading text-2xl font-semibold text-foreground">
          {t("diagnostics.title")}
        </h2>
        <p className="m-0 mt-1 text-sm text-secondary-foreground [text-wrap:pretty]">
          {t("diagnostics.intro")}
        </p>
        {failedTogether ? (
          <ErrorState
            t={t}
            className="mt-8"
            message={t("diagnostics.errorTitle")}
            kept={t("diagnostics.errorKept")}
            retryLabel={t("shell.actions.retry")}
            onRetry={() => {
              calls.retry();
              tasks.retry();
            }}
          />
        ) : (
          <>
            <h3 className="m-0 mt-8 border-b border-border pb-2 text-sm font-semibold text-foreground">
              {t("diagnostics.callLog.title")}
            </h3>
            <div className="mt-3">
              <CallLogView t={t} state={calls} />
            </div>
            <h3 className="m-0 mt-10 border-b border-border pb-2 text-sm font-semibold text-foreground">
              {t("diagnostics.taskHistory.title")}
            </h3>
            <div className="mt-3">
              <TaskHistoryView t={t} state={tasks} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
