import { useId } from "react";
import { ListTree } from "lucide-react";
import type { TopicChangeSetSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { CompareRegion, CompareToggle } from "./ChangeCompare";
import type { ChangeAction, ChangeDetail } from "./shape-controller";
import { changeText, timeText } from "./shape-model";

export interface ShapeChangesProps {
  t: Translator;
  changes: readonly TopicChangeSetSummary[];
  actions: Readonly<Record<string, ChangeAction>>;
  details: Readonly<Record<string, ChangeDetail>>;
  onUndo: (changeSetId: string) => void;
  onToggleDetails: (changeSetId: string) => void;
  onRetryDetails: (changeSetId: string) => void;
}

/** What the engine changed today, newest first, each with its before and after and an Undo. */
export function ShapeChanges({
  t,
  changes,
  actions,
  details,
  onUndo,
  onToggleDetails,
  onRetryDetails
}: ShapeChangesProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 id={headingId} className="text-xs font-semibold text-secondary-foreground">
        {t("topics.shape.changed.title")}
      </h3>
      {changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("topics.shape.changed.none")}</p>
      ) : (
        <ul>
          {changes.map((change) => {
            const action = actions[change.id];
            const pending = action?.status === "pending";
            return (
              <li key={change.id} className="flex gap-2.5 border-t border-border py-2.5">
                <ListTree
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-sm text-foreground">
                    {changeText(t, change)}
                    <span className="text-muted-foreground">{` · ${timeText(t, change.at)}`}</span>
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <CompareToggle
                      t={t}
                      changeSetId={change.id}
                      open={details[change.id] !== undefined}
                      onToggle={() => onToggleDetails(change.id)}
                    />
                    {change.undo === "available" ? (
                      <Button
                        type="button"
                        variant="link"
                        disabled={pending}
                        onClick={() => onUndo(change.id)}
                      >
                        {pending
                          ? t("topics.shape.changed.undoing")
                          : t("topics.shape.changed.undo")}
                      </Button>
                    ) : null}
                  </div>
                  {action?.status === "failed" ? (
                    <p role="alert" className="text-xs text-danger">
                      {t(action.messageKey)}
                    </p>
                  ) : null}
                  {action?.status === "blocked" ||
                  (change.undo === "blocked" && action === undefined) ? (
                    <p className="text-xs text-muted-foreground">
                      {t("topics.shape.changed.blocked")}
                    </p>
                  ) : null}
                  <CompareRegion
                    t={t}
                    changeSetId={change.id}
                    detail={details[change.id]}
                    onRetry={() => onRetryDetails(change.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
