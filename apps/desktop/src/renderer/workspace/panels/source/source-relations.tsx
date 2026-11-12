import type { MessageKey, Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { AtomicNoteRelationReferenceText } from "../../../components/AtomicNoteRelationReferenceText";
import { SourceReferenceBadge } from "../../../components/SourceRelationReferenceText";
import { relationPairArrow, relationTypeView } from "../../../lib/relation-stance";
import {
  CollapsibleSection,
  relationConfidenceLabel,
  relationTypeKey,
  StateCard
} from "./source-parts";

/** The note-to-note relations that touch this source, each with its band, type and reason. */
export function SourceRelationsTab({ detail, t }: { detail: SourceDetail; t: Translator }) {
  return (
    <CollapsibleSection
      title={t("library.sections.relations")}
      count={detail.relations.length}
      defaultOpen
    >
      {detail.relations.length === 0 ? (
        <StateCard>{t("knowledge.relations.empty")}</StateCard>
      ) : (
        <ol className="grid gap-2">
          {detail.relations.map((relation) => (
            <li
              key={relation.id}
              className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950"
            >
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm font-medium">
                  <SourceReferenceBadge number={1} title={relation.sourceTitle} />
                  {relation.sourceTitle} {relationPairArrow(relation.direction)}{" "}
                  <SourceReferenceBadge number={2} title={relation.targetTitle} />
                  {relation.targetTitle}
                </p>
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold tabular-nums dark:bg-slate-800">
                  {relationConfidenceLabel(relation, t)}
                </span>
              </div>
              <p className="text-sm">
                {relationTypeView(relation.relationType).directed &&
                relation.direction === "unknown"
                  ? t("knowledge.relations.linked", {
                      values: { type: t(relationTypeKey(relation.relationType)) }
                    })
                  : t(relationTypeKey(relation.relationType))}
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                <AtomicNoteRelationReferenceText
                  text={
                    relation.explanation.startsWith("knowledge.")
                      ? t(relation.explanation as MessageKey)
                      : relation.explanation
                  }
                  sourceId={relation.sourceAtomicNoteId}
                  targetId={relation.targetAtomicNoteId}
                  sourceTitle={relation.sourceTitle}
                  targetTitle={relation.targetTitle}
                />
              </p>
              {relation.sourceStatus === "pending_review" ||
              relation.targetStatus === "pending_review" ? (
                <span className="w-fit rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  {t("knowledge.relations.pendingInvolved")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </CollapsibleSection>
  );
}
