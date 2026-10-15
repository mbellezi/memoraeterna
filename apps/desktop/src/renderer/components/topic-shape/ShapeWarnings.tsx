import { useId } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { CompareRegion, CompareToggle } from "./ChangeCompare";
import { toneClass, toneIcon } from "./health-marks";
import type { ChangeAction, ChangeDetail } from "./shape-controller";
import type { WarningView } from "./shape-model";

export interface ShapeWarningsProps {
  t: Translator;
  warnings: readonly WarningView[];
  actions: Readonly<Record<string, ChangeAction>>;
  details: Readonly<Record<string, ChangeDetail>>;
  /** A topic named in a warning was chosen: the chart selects its block. */
  onSelect: (cellKey: string) => void;
  onReview: (changeSetId: string, decision: "apply" | "dismiss") => void;
  onToggleDetails: (changeSetId: string) => void;
  onRetryDetails: (changeSetId: string) => void;
}

/**
 * The warnings of the tree: structure problems the engine found and proposals that wait for the
 * person (a protected topic, a regrouping of the areas, a high-impact rebuild). A proposal can be
 * applied or dismissed here (docs D29) and its before and after read first.
 */
export function ShapeWarnings({
  t,
  warnings,
  actions,
  details,
  onSelect,
  onReview,
  onToggleDetails,
  onRetryDetails
}: ShapeWarningsProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 id={headingId} className="text-xs font-semibold text-secondary-foreground">
        {t("topics.shape.warnings.title", {
          values: { count: new Intl.NumberFormat(t.locale).format(warnings.length) }
        })}
      </h3>
      {warnings.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("topics.shape.warnings.none")}</p>
      ) : (
        <ul>
          {warnings.map((warning) => (
            <WarningItem
              key={warning.id}
              t={t}
              warning={warning}
              action={warning.proposal ? actions[warning.proposal.changeSetId] : undefined}
              detail={warning.proposal ? details[warning.proposal.changeSetId] : undefined}
              onSelect={onSelect}
              onReview={onReview}
              onToggleDetails={onToggleDetails}
              onRetryDetails={onRetryDetails}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function WarningItem({
  t,
  warning,
  action,
  detail,
  onSelect,
  onReview,
  onToggleDetails,
  onRetryDetails
}: {
  t: Translator;
  warning: WarningView;
  action: ChangeAction | undefined;
  detail: ChangeDetail | undefined;
  onSelect: (cellKey: string) => void;
  onReview: (changeSetId: string, decision: "apply" | "dismiss") => void;
  onToggleDetails: (changeSetId: string) => void;
  onRetryDetails: (changeSetId: string) => void;
}) {
  const textId = useId();
  const Icon = toneIcon[warning.tone];
  const proposal = warning.proposal;
  const pending = action?.status === "pending";
  return (
    <li className="flex gap-2.5 border-t border-border py-2.5">
      <Icon className={`mt-0.5 size-4 shrink-0 ${toneClass[warning.tone]}`} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {warning.subject ? (
          warning.subject.cellKey !== null ? (
            <button
              type="button"
              onClick={() => onSelect(warning.subject!.cellKey!)}
              className="self-start rounded-sm text-left text-sm font-semibold text-foreground [overflow-wrap:anywhere] hover:underline"
            >
              {warning.subject.name}
            </button>
          ) : (
            <span className="text-sm font-semibold text-foreground">{warning.subject.name}</span>
          )
        ) : null}
        <p id={textId} className="text-xs text-secondary-foreground">
          {warning.text}
        </p>
        {warning.awaiting ? (
          <p className="text-xs text-muted-foreground">{t("topics.shape.warnings.awaiting")}</p>
        ) : null}
        {proposal ? (
          <>
            {proposal.riskLabel ? (
              <p className="text-xs font-medium text-secondary-foreground">{proposal.riskLabel}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                type="button"
                variant="primary"
                disabled={pending}
                aria-describedby={textId}
                onClick={() => onReview(proposal.changeSetId, "apply")}
              >
                {pending && action.kind === "apply"
                  ? t("topics.shape.warnings.working")
                  : t("topics.shape.warnings.apply")}
              </Button>
              <Button
                type="button"
                disabled={pending}
                aria-describedby={textId}
                onClick={() => onReview(proposal.changeSetId, "dismiss")}
              >
                {pending && action.kind === "dismiss"
                  ? t("topics.shape.warnings.working")
                  : t("topics.shape.warnings.dismiss")}
              </Button>
              <CompareToggle
                t={t}
                changeSetId={proposal.changeSetId}
                open={detail !== undefined}
                onToggle={() => onToggleDetails(proposal.changeSetId)}
              />
            </div>
            {action && action.status === "failed" ? (
              <p role="alert" className="text-xs text-danger">
                {t(action.messageKey)}
              </p>
            ) : null}
            <CompareRegion
              t={t}
              changeSetId={proposal.changeSetId}
              detail={detail}
              onRetry={() => onRetryDetails(proposal.changeSetId)}
            />
          </>
        ) : null}
      </div>
    </li>
  );
}
