import { RefreshCw, Sparkles } from "lucide-react";
import type { SourceRelationView } from "@app/domain";
import type { Translator } from "@app/i18n";

import { SourceRelationReferenceText } from "./SourceRelationReferenceText";
import type { SourceRelationExplanationView } from "./source-relation-explanation-state";
import { Button } from "./ui/button";

/**
 * A source relation's explanation: the prose an older relation stored, the one written when the
 * owner opened it, or the state of writing it (writing, no longer available, failed with Retry).
 * Model text is rendered as safe nodes; source references become numbered badges.
 */
export function SourceRelationExplanation({
  t,
  relation,
  view,
  onRetry
}: {
  t: Translator;
  relation: Pick<
    SourceRelationView,
    "sourceItemId" | "targetSourceItemId" | "sourceTitle" | "targetTitle"
  >;
  view: SourceRelationExplanationView;
  onRetry?: () => void;
}) {
  switch (view.kind) {
    case "stored":
      return (
        <p className="whitespace-pre-wrap break-words font-medium">
          <SourceRelationReferenceText text={view.text} relation={relation} />
        </p>
      );
    case "written":
      return (
        <div className="flex flex-col gap-1">
          <p className="break-words font-reading text-base text-secondary-foreground">
            <SourceRelationReferenceText text={view.text} relation={relation} />
          </p>
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="size-3" aria-hidden="true" />
            <span>{t("sourceRelations.explainedBy", { values: { model: view.writtenBy } })}</span>
          </p>
        </div>
      );
    case "writing":
      return (
        <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
          {t("sourceRelations.writing")}
        </p>
      );
    case "unavailable":
      return (
        <p className="text-sm text-muted-foreground">{t("sourceRelations.explainUnavailable")}</p>
      );
    case "failed":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">
            {t(view.noModel ? "sourceRelations.explainNoModel" : "sourceRelations.explainFailed")}
          </p>
          {onRetry ? (
            <Button type="button" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              {t("shell.actions.retry")}
            </Button>
          ) : null}
        </div>
      );
    case "none":
      return null;
  }
}
