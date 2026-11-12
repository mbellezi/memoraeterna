import { useId, useState } from "react";

import type { AppSettings } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input } from "../../../components/ui/input";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { settingsTouch } from "../../../lib/status-followers";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { useSectionRead } from "../general/use-section-read";

type Plan = NonNullable<AppSettings["processingPresets"]>[number];

const planNameMax = 100;

/**
 * The saved import plans: made while importing, renamed or deleted here. Each plan shows its name and
 * how many steps it runs; "Rename" turns the name into a field in the same place and "Delete" asks in
 * the line, naming the plan and saying the sources already imported keep what was made. The list is
 * one read of the app's preferences and follows `settings.changed`; a write answers with the new
 * preferences, so the list is right at once. A plan that fails to save stays as it was, in one line.
 */
export function PlansRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const { state, retry, set } = useSectionRead(
    () => window.app.settings.getApp(),
    [{ type: "settings.changed", when: settingsTouch("app") }]
  );
  const [failed, setFailed] = useState(false);

  const plans = state.status === "ready" ? (state.value.processingPresets ?? []) : [];
  const save = async (next: Plan[]): Promise<boolean> => {
    setFailed(false);
    try {
      set(await window.app.settings.updateApp({ processingPresets: next }));
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };

  const body =
    state.status === "loading" ? (
      <LoadingState t={t} className="w-full max-w-[27.5rem]">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-3 w-24" />
      </LoadingState>
    ) : state.status === "error" ? (
      <p role="status" className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-foreground">{t("settingsLibrary.plans.loadFailed")}</span>
        <span className="text-secondary-foreground">{t("settingsLibrary.plans.loadKept")}</span>
        <InlineAction onClick={retry}>{t("shell.actions.retry")}</InlineAction>
      </p>
    ) : plans.length === 0 ? (
      <EmptyState className="w-full max-w-[27.5rem]">{t("settingsLibrary.plans.empty")}</EmptyState>
    ) : (
      <ul className="m-0 grid w-full list-none p-0">
        {plans.map((plan) => (
          <PlanItem
            key={plan.id}
            plan={plan}
            onRename={(name) =>
              save(plans.map((item) => (item.id === plan.id ? { ...item, name } : item)))
            }
            onDelete={() => save(plans.filter((item) => item.id !== plan.id))}
          />
        ))}
      </ul>
    );

  return (
    <RegistryRow
      entry={entry}
      stack
      defaultLabel={t("settingsLibrary.plans.defaultNone")}
      note={
        failed ? (
          <span role="status" className="block text-foreground">
            {t("settingsLibrary.plans.saveFailed")}
          </span>
        ) : undefined
      }
      control={body}
    />
  );
}

function PlanItem({
  plan,
  onRename,
  onDelete
}: {
  plan: Plan;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const { t } = useSettings();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(plan.name);
  const [working, setWorking] = useState(false);
  const fieldId = useId();

  const run = async (action: () => Promise<boolean>) => {
    setWorking(true);
    const ok = await action();
    setWorking(false);
    if (ok) setMode("view");
  };
  const name = draft.trim();
  const submit = () => {
    if (name === "" || name.length > planNameMax) return;
    if (name === plan.name) setMode("view");
    else void run(() => onRename(name));
  };

  return (
    <li className="grid gap-2 border-b border-border py-3 first:pt-1 text-sm">
      {mode === "rename" ? (
        <div className="grid max-w-[27.5rem] gap-2">
          <label htmlFor={fieldId} className="text-xs font-medium text-foreground">
            {t("settingsLibrary.plans.renameLabel")}
          </label>
          <Input
            id={fieldId}
            value={draft}
            autoFocus
            maxLength={planNameMax}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setMode("view");
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={working || name === ""} onClick={submit}>
              {t("shell.actions.save")}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setMode("view")}>
              {t("shell.actions.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <b className="font-medium text-foreground">{plan.name}</b>
            <span className="text-secondary-foreground">
              {" · "}
              {t("processing.stageCount", { values: { count: plan.requestedStages.length } })}
            </span>
          </span>
          {mode === "view" ? (
            <span className="flex shrink-0 items-baseline gap-3">
              <InlineAction
                aria-label={`${t("settingsLibrary.plans.renameAction")}: ${plan.name}`}
                onClick={() => {
                  setDraft(plan.name);
                  setMode("rename");
                }}
              >
                {t("settingsLibrary.plans.renameAction")}
              </InlineAction>
              <InlineAction
                aria-label={`${t("settingsLibrary.plans.deleteAction")}: ${plan.name}`}
                onClick={() => setMode("delete")}
              >
                {t("settingsLibrary.plans.deleteAction")}
              </InlineAction>
            </span>
          ) : null}
        </div>
      )}
      {mode === "delete" ? (
        <div role="group" className="grid max-w-[27.5rem] gap-2">
          <p className="m-0 text-foreground">
            {t("settingsLibrary.plans.deleteAsk", { values: { name: plan.name } })}{" "}
            <span className="text-secondary-foreground">
              {t("settingsLibrary.plans.deleteKept")}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" disabled={working} onClick={() => void run(onDelete)}>
              {t("settingsLibrary.plans.deleteConfirm")}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setMode("view")}>
              {t("shell.actions.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
