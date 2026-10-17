import { SourceReferenceBadge, SourceRelationReferenceText } from "./SourceRelationReferenceText";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { SourceRelationView } from "@app/domain";
import {
  atomicRelationIcon,
  atomicRelationColor,
  formatEdgeLabel
} from "./knowledge-relation-icons";
import {
  explanationAfter,
  explanationErrorKind,
  type ExplanationState
} from "./note-page/note-page-model";
import { SourceRelationExplanation } from "./SourceRelationExplanation";
import {
  asksForSourceExplanation,
  initialSourceRelationOpenState,
  sourceRelationExcerpt,
  sourceRelationExplanationView,
  sourceRelationOpenReducer,
  sourceRelationSupport,
  type WrittenSourceExplanation
} from "./source-relation-explanation-state";

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) return record as Record<string, T>;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Relations between sources: titles, type, origin and evidence excerpts. A relation decided without
 * prose gets its explanation when the owner opens its evidence and keeps it open for a moment;
 * closing it first cancels the request. Older relations show the prose they stored.
 */
export function SourceRelationsList({
  sourceItemId,
  targetSourceItemId = null,
  relationId,
  t,
  compact = false,
  onOpenNote,
  onReadyChange
}: {
  sourceItemId: string;
  targetSourceItemId?: string | null;
  relationId?: string;
  t: Translator;
  compact?: boolean;
  onOpenNote?: ((sourceItemId: string, noteId: string) => void) | undefined;
  onReadyChange?: (ready: boolean) => void;
}) {
  const [relations, setRelations] = useState<SourceRelationView[]>([]);
  const [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(0),
    [hasMore, setHasMore] = useState(false),
    [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, dispatchOpen] = useReducer(
    sourceRelationOpenReducer,
    initialSourceRelationOpenState
  );
  const [explanations, setExplanations] = useState<Record<string, ExplanationState>>({});
  const [written, setWritten] = useState<Record<string, WrittenSourceExplanation>>({});
  const [explainRetry, setExplainRetry] = useState(0);
  const relationsNow = useRef<SourceRelationView[]>([]);
  const explanationsNow = useRef<Readonly<Record<string, ExplanationState>>>({});
  const writtenNow = useRef<Readonly<Record<string, WrittenSourceExplanation>>>({});
  useLayoutEffect(() => {
    onReadyChange?.(!loading);
  }, [loading, onReadyChange]);
  useEffect(() => {
    relationsNow.current = relations;
  }, [relations]);
  useEffect(() => {
    explanationsNow.current = explanations;
  }, [explanations]);
  useEffect(() => {
    writtenNow.current = written;
  }, [written]);
  useEffect(() => {
    setOffset(0);
    setRelations([]);
    dispatchOpen({ type: "reset" });
  }, [sourceItemId, targetSourceItemId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    window.app.knowledge
      .listSourceRelations({
        sourceItemId,
        targetSourceItemId,
        offset,
        limit: compact ? 3 : 30,
        ...(relationId ? { relationId } : {})
      })
      .then((result) => {
        if (active) {
          setRelations(result.relations);
          setHasMore(result.hasMore);
          setTotal(result.total);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sourceItemId, targetSourceItemId, offset, retry, compact, relationId]);

  useEffect(() => {
    const dwell = opened.dwell;
    if (!dwell) return;
    const timer = setTimeout(() => dispatchOpen({ type: "dwell" }), dwell.delayMs);
    return () => clearTimeout(timer);
  }, [opened.dwell]);

  // A relation that stayed open asks for the explanation it lacks; closing it first cancels the
  // request. A relation found without one to write ends in a terminal state: it is not asked again.
  useEffect(() => {
    const id = opened.explain;
    if (id === null) return;
    const relation = relationsNow.current.find((item) => item.id === id);
    if (!asksForSourceExplanation(relation, writtenNow.current[id], explanationsNow.current[id]))
      return;
    let settled = false;
    let canceled = false;
    setExplanations((current) => ({ ...current, [id]: { status: "writing" } }));
    window.app.relations
      .explainSource({ relationId: id })
      .then((result) => {
        settled = true;
        if (result)
          setWritten((current) => ({
            ...current,
            [id]: { text: result.text, writtenBy: result.writtenBy }
          }));
        const after = explanationAfter(result);
        setExplanations((current) => (after ? { ...current, [id]: after } : without(current, id)));
      })
      .catch((error: unknown) => {
        settled = true;
        if (canceled) return;
        setExplanations((current) => ({
          ...current,
          [id]: { status: "failed", kind: explanationErrorKind(error) }
        }));
      });
    return () => {
      if (settled) return;
      canceled = true;
      void window.app.relations.cancelExplainSource({ relationId: id }).catch(() => undefined);
      setExplanations((current) => without(current, id));
    };
  }, [opened.explain, explainRetry]);

  async function review(
    relation: SourceRelationView,
    status: "accepted" | "rejected" | "pending_review"
  ) {
    setBusy(relation.id);
    setFailed(false);
    try {
      if (
        !(await window.app.knowledge.reviewSourceRelation({
          id: relation.id,
          status,
          expectedUpdatedAt: relation.updatedAt
        }))
      )
        throw new Error("stale");
      window.dispatchEvent(new Event("source-relations-updated"));
      setRetry((value) => value + 1);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid min-w-0 content-start gap-3 p-3 text-sm">
      <p className="text-xs opacity-70">{t("sourceRelations.provenanceHint")}</p>
      {loading ? (
        <p role="status" className="flex items-center gap-2">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {t("shell.states.loading")}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="flex items-center gap-2 text-rose-500">
          {t("sourceRelations.loadError")}
          {!compact ? (
            <button
              type="button"
              aria-label={t("shell.actions.retry")}
              onClick={() => setRetry((value) => value + 1)}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          ) : null}
        </p>
      ) : null}
      {!loading && !failed && !relations.length ? <p>{t("sourceRelations.empty")}</p> : null}
      {!loading &&
        relations.map((relation) => {
          const Icon = atomicRelationIcon(relation.relationType);
          const origins = new Set(
            relation.evidence.filter((item) => item.current).map((item) => item.origin)
          );
          const view = sourceRelationExplanationView(
            relation,
            written[relation.id],
            explanations[relation.id]
          );
          // A written or stored explanation reads in the row; otherwise the row reads its evidence.
          const shownInRow = view.kind === "stored" || view.kind === "written";
          const excerpt = shownInRow ? null : sourceRelationExcerpt(relation);
          // A promoted relation has no judge's score: its note connections stand in for one.
          const support = sourceRelationSupport(relation);
          return (
            <article
              key={relation.id}
              className="grid min-w-0 gap-2 rounded-xl border border-current/15 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Icon
                  className="h-4 w-4 shrink-0"
                  style={{ color: atomicRelationColor(relation.relationType) }}
                  aria-hidden="true"
                />
                <strong>{formatEdgeLabel(relation.relationType, t)}</strong>
                <span className="ml-auto text-[11px] opacity-70">
                  {t(`sourceRelations.${relation.status}`)}
                </span>
              </div>
              <p className="flex flex-wrap items-center gap-1 text-xs opacity-70">
                <span className="min-w-0 break-words">
                  <SourceReferenceBadge number={1} title={relation.sourceTitle} />
                  {relation.sourceTitle}
                </span>
                <ArrowRight
                  className="h-3 w-3 shrink-0"
                  aria-label={t("sourceRelations.direction")}
                />
                <span className="min-w-0 break-words">
                  <SourceReferenceBadge number={2} title={relation.targetTitle} />
                  {relation.targetTitle}
                </span>
              </p>
              {shownInRow ? (
                <SourceRelationExplanation t={t} relation={relation} view={view} />
              ) : excerpt ? (
                <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                  <SourceReferenceBadge number={1} title={relation.sourceTitle} />
                  {excerpt.source} <SourceReferenceBadge number={2} title={relation.targetTitle} />
                  {excerpt.target}
                </p>
              ) : null}
              <p className="text-[11px] opacity-70">
                {t(
                  origins.size === 2
                    ? "sourceRelations.both"
                    : origins.has("atomic_notes")
                      ? "sourceRelations.atomicNotes"
                      : "sourceRelations.sourceAnalysis"
                )}
                {support
                  ? ` · ${t("sourceRelations.linkedThrough", { values: { count: support.count } })}`
                  : null}
              </p>
              {!relation.current ? (
                <p className="text-xs text-amber-500">{t("sourceRelations.stale")}</p>
              ) : null}
              {!compact ? (
                <>
                  <details
                    className="min-w-0"
                    open={opened.open === relation.id}
                    onToggle={(event) =>
                      dispatchOpen({
                        type: event.currentTarget.open ? "open" : "close",
                        id: relation.id
                      })
                    }
                  >
                    <summary className="cursor-pointer text-xs font-medium">
                      {t("sourceRelations.evidence")}
                    </summary>
                    <div className="mt-2 grid gap-3">
                      {shownInRow ? null : (
                        <SourceRelationExplanation
                          t={t}
                          relation={relation}
                          view={view}
                          onRetry={() => {
                            dispatchOpen({ type: "explainNow", id: relation.id });
                            setExplainRetry((current) => current + 1);
                          }}
                        />
                      )}
                      {relation.sourceIdea && relation.targetIdea ? (
                        <p className="break-words text-xs">
                          <SourceRelationReferenceText
                            text={relation.sourceIdea}
                            relation={relation}
                          />{" "}
                          →{" "}
                          <SourceRelationReferenceText
                            text={relation.targetIdea}
                            relation={relation}
                          />
                        </p>
                      ) : null}
                      {relation.evidence.map((evidence) => (
                        <div key={evidence.id} className="grid gap-2 rounded-lg bg-current/5 p-3">
                          <p className="text-[11px] opacity-70">
                            {t(
                              evidence.origin === "atomic_notes"
                                ? "sourceRelations.atomicNotes"
                                : "sourceRelations.sourceAnalysis"
                            )}
                            {!evidence.current ? ` · ${t("sourceRelations.stale")}` : ""}
                          </p>
                          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold">
                                <SourceReferenceBadge number={1} title={relation.sourceTitle} />
                                {relation.sourceTitle}
                              </p>
                              <blockquote className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">
                                {evidence.sourceExcerpt}
                              </blockquote>
                              {onOpenNote && evidence.current && evidence.sourceNoteId ? (
                                <button
                                  type="button"
                                  className="mt-2 text-xs text-cyan-500 underline"
                                  onClick={() =>
                                    onOpenNote(relation.sourceItemId, evidence.sourceNoteId!)
                                  }
                                >
                                  {t("sourceRelations.openNote")}
                                </button>
                              ) : null}
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold">
                                <SourceReferenceBadge number={2} title={relation.targetTitle} />
                                {relation.targetTitle}
                              </p>
                              <blockquote className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">
                                {evidence.targetExcerpt}
                              </blockquote>
                              {onOpenNote && evidence.current && evidence.targetNoteId ? (
                                <button
                                  type="button"
                                  className="mt-2 text-xs text-cyan-500 underline"
                                  onClick={() =>
                                    onOpenNote(relation.targetSourceItemId, evidence.targetNoteId!)
                                  }
                                >
                                  {t("sourceRelations.openNote")}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {relation.status !== "accepted" ? (
                      <button
                        type="button"
                        disabled={busy === relation.id || !relation.current}
                        onClick={() => void review(relation, "accepted")}
                        className="inline-flex items-center gap-1 rounded border border-current/20 px-2 py-1 disabled:opacity-40"
                      >
                        <Check className="h-3 w-3" />
                        {t("sourceRelations.accept")}
                      </button>
                    ) : null}
                    {relation.status !== "rejected" ? (
                      <button
                        type="button"
                        disabled={busy === relation.id}
                        onClick={() => void review(relation, "rejected")}
                        className="inline-flex items-center gap-1 rounded border border-current/20 px-2 py-1"
                      >
                        <X className="h-3 w-3" />
                        {t("sourceRelations.reject")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === relation.id}
                        onClick={() => void review(relation, "pending_review")}
                      >
                        {t("sourceRelations.restore")}
                      </button>
                    )}
                  </div>
                </>
              ) : null}
            </article>
          );
        })}
      {!loading && compact && total > 0 ? (
        <p className="text-xs opacity-70">
          {relations.length} / {total}
        </p>
      ) : null}
      {!loading && !compact && total > 0 ? (
        <div className="flex items-center justify-between gap-3 text-xs">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 30))}
            className="disabled:opacity-30"
          >
            {t("sourceRelations.previous")}
          </button>
          <span>
            {offset + 1}–{offset + relations.length} / {total}
          </span>
          <button
            type="button"
            disabled={!hasMore}
            onClick={() => setOffset(offset + 30)}
            className="inline-flex items-center gap-1 disabled:opacity-30"
          >
            {t("sourceRelations.next")}
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
