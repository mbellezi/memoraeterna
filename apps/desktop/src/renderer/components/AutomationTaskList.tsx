import type { AutomationTask } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import { ArrowRight } from "lucide-react";
import { Button } from "./ui/button";

export function automationTaskTitle(task: AutomationTask, t: Translator) {
  if (task.sourceIds.length > 1 && ["delivery", "inspection"].includes(task.kind))
    return t("automation.sourceScopeCount", { values: { count: task.sourceIds.length } });
  if (task.kind === "schedule" || task.kind === "maintenance")
    return ["incremental", "daily", "weekly", "monthly"].includes(task.title)
      ? t(`automaticMaintenance.${task.title}` as MessageKey)
      : task.title;
  return task.title.startsWith("wiki-") || task.title === "delivery"
    ? t(`automation.kinds.${task.kind}`)
    : task.title;
}
export function automationTaskStatus(task: AutomationTask, t: Translator) {
  if (task.status === "superseded")
    return t(task.version === "wiki-curator-v2" ? "hierarchy.historical" : "automation.retired");
  if (task.kind === "schedule" && task.reason === "maintenance.errors.retainedDecision")
    return t("automation.waitingInput");
  if (/^maintenance.errors.(wait|idle|busy|sync)$/.test(task.reason ?? ""))
    return t("automation.deferred");
  if (/maintenance.errors.(budget|period)|organization.errors.budget/.test(task.reason ?? ""))
    return t("automation.budgetBlocked");
  const map: Record<string, MessageKey> = {
    reconciling: "automation.reconciling",
    blocked: "maintenance.status.blocked",
    superseded: "automation.retired",
    retired: "automation.retired",
    scheduled: "automation.scheduled",
    pending: task.kind === "delivery" ? "automation.impactPending" : "automation.pending",
    deferred: "automation.deferred",
    leased: "organization.analyzing",
    paused: "maintenance.paused",
    queued: "organization.queued",
    analyzing: "organization.analyzing",
    inspecting: "maintenance.status.inspecting",
    applied: "organization.applied",
    no_change: "maintenance.status.no_change",
    awaiting_review: "organization.awaiting_review",
    failed: "organization.failed",
    canceled: "organization.canceled",
    rejected: "organization.rejected",
    conflict: "automation.conflict",
    local_modified: "automation.conflict",
    acknowledged: "automation.impactChecked"
  };
  return t(map[task.status] ?? "automation.pending");
}
export function AutomationTaskList({
  tasks,
  policyId,
  revisionId,
  t,
  inspect
}: {
  tasks: AutomationTask[];
  policyId: string;
  revisionId: string | null;
  t: Translator;
  inspect: (task: AutomationTask) => void;
}) {
  const impacts = tasks.filter((task) => task.kind === "delivery"),
    inspections = tasks.filter((task) => task.kind === "inspection"),
    executions = tasks.filter((task) => !["delivery", "inspection"].includes(task.kind));
  const taskCard = (task: AutomationTask) => (
    <article
      key={task.kind + task.id}
      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">
          {t(`automation.kinds.${task.kind}`)}
        </p>
        <h4 className="mt-1 break-words text-sm font-medium">{automationTaskTitle(task, t)}</h4>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-md px-2 py-1 ${task.reason || ["failed", "awaiting_review", "conflict"].includes(task.status) ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-soft text-muted-foreground"}`}
          >
            {automationTaskStatus(task, t)}
          </span>
          {task.policyId === policyId &&
            task.policyRevisionId &&
            task.policyRevisionId !== revisionId && (
              <span className="text-muted-foreground">{t("maintenance.history")}</span>
            )}
          <time className="text-muted-foreground">
            {t(task.kind === "schedule" ? "automation.nextExecution" : "automation.updatedAt", {
              values: { time: new Date(task.updatedAt).toLocaleString(t.locale) }
            })}
          </time>
        </div>
        {task.kind === "delivery" && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("automation.changes", { values: { count: task.detailCount } })}
          </p>
        )}
        {task.reason && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            {t(
              (/^(organization|maintenance|wiki)\.errors\.[A-Za-z]+$/.test(task.reason)
                ? task.reason
                : "errors.common.unknown") as MessageKey
            )}
          </p>
        )}
        {task.kind === "inspection" && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("automation.inspectionCount", { values: { count: task.detailCount } })}
          </p>
        )}
      </div>
      {(task.kind !== "schedule" || task.status !== "retired") && (
        <Button
          onClick={() => inspect(task)}
          aria-label={`${t(["delivery", "inspection"].includes(task.kind) ? "automation.diagnostics" : "automation.inspect")}: ${automationTaskTitle(task, t)}`}
        >
          {t(
            ["delivery", "inspection"].includes(task.kind)
              ? "automation.diagnostics"
              : "automation.inspect"
          )}
          <ArrowRight size={14} />
        </Button>
      )}
    </article>
  );
  return (
    <>
      {executions.length ? (
        executions.map(taskCard)
      ) : (
        <p className="text-sm text-muted-foreground">{t("automation.empty")}</p>
      )}
      {inspections.length > 0 && (
        <details className="rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            {t("automation.inspectionCount", {
              values: { count: inspections.reduce((n, task) => n + task.detailCount, 0) }
            })}
          </summary>
          <p className="my-3 text-sm text-muted-foreground">{t("automation.inspectionHint")}</p>
          <div className="grid gap-3">{inspections.map(taskCard)}</div>
        </details>
      )}
      {impacts.length > 0 && (
        <details className="rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            {t("automation.pendingImpactCount", {
              values: { count: impacts.reduce((n, task) => n + task.detailCount, 0) }
            })}
            {impacts.some((task) => task.status === "blocked") && (
              <span className="ml-2 text-amber-700 dark:text-amber-300">
                · {t("maintenance.status.blocked")}
              </span>
            )}
          </summary>
          <p className="my-3 text-sm text-muted-foreground">{t("automation.impactHint")}</p>
          <div className="grid gap-3">{impacts.map(taskCard)}</div>
        </details>
      )}
    </>
  );
}
