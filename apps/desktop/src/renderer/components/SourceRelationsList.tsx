import { SourceReferenceBadge, SourceRelationReferenceText } from "./SourceRelationReferenceText";
import { useEffect, useState } from "react";
import { ArrowRight, Check, ChevronDown, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { SourceRelationView } from "@app/domain";
import { atomicRelationIcon, atomicRelationColor, formatEdgeLabel } from "./knowledge-relation-icons";

export function SourceRelationsList({ sourceItemId, targetSourceItemId = null, t, compact = false, onOpenNote }: {
  sourceItemId: string; targetSourceItemId?: string | null; t: Translator; compact?: boolean;
  onOpenNote?: ((sourceItemId:string,noteId:string) => void) | undefined;
}) {
  const [relations,setRelations] = useState<SourceRelationView[]>([]);
  const [loading,setLoading] = useState(true),[failed,setFailed] = useState(false),[retry,setRetry] = useState(0);
  const [offset,setOffset] = useState(0),[hasMore,setHasMore] = useState(false),[total,setTotal] = useState(0);
  const [busy,setBusy] = useState<string | null>(null);
  useEffect(() => { setOffset(0);setRelations([]); },[sourceItemId,targetSourceItemId]);
  useEffect(() => {
    let active = true;setLoading(true);setFailed(false);
    window.app.knowledge.listSourceRelations({sourceItemId,targetSourceItemId,offset,limit:compact ? 3 : 30})
      .then((result) => { if (active) { setRelations(result.relations);setHasMore(result.hasMore);setTotal(result.total); } })
      .catch(() => {if (active) setFailed(true);}).finally(() => {if (active) setLoading(false);});
    return () => { active = false; };
  },[sourceItemId,targetSourceItemId,offset,retry,compact]);
  async function review(relation: SourceRelationView, status: "accepted" | "rejected" | "pending_review") {
    setBusy(relation.id);setFailed(false);
    try {
      if (!await window.app.knowledge.reviewSourceRelation({id:relation.id,status,expectedUpdatedAt:relation.updatedAt})) throw new Error("stale");
      window.dispatchEvent(new Event("source-relations-updated"));
      setRetry((value) => value + 1);
    } catch { setFailed(true); } finally { setBusy(null); }
  }
  return <div className="grid min-w-0 content-start gap-3 p-3 text-sm">
    <p className="text-xs opacity-70">{t("sourceRelations.provenanceHint")}</p>
    {loading ? <p role="status" className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />{t("shell.states.loading")}</p> : null}
    {failed ? <p role="alert" className="flex items-center gap-2 text-rose-500">{t("sourceRelations.loadError")}
      {!compact ? <button type="button" aria-label={t("shell.actions.retry")} onClick={() => setRetry((value) => value + 1)}><RefreshCw className="h-4 w-4" /></button> : null}</p> : null}
    {!loading && !failed && !relations.length ? <p>{t("sourceRelations.empty")}</p> : null}
    {!loading && relations.map((relation) => {
      const Icon = atomicRelationIcon(relation.relationType);
      const origins = new Set(relation.evidence.filter((item) => item.current).map((item) => item.origin));
      return <article key={relation.id} className="grid min-w-0 gap-2 rounded-xl border border-current/15 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 shrink-0" style={{color:atomicRelationColor(relation.relationType)}} aria-hidden="true" />
          <strong>{formatEdgeLabel(relation.relationType,t)}</strong>
          <span className="ml-auto text-[11px] opacity-70">{t(`sourceRelations.${relation.status}`)}</span>
        </div>
        <p className="flex flex-wrap items-center gap-1 text-xs opacity-70"><span className="min-w-0 break-words"><SourceReferenceBadge number={1} title={relation.sourceTitle} />{relation.sourceTitle}</span><ArrowRight className="h-3 w-3 shrink-0" aria-label={t("sourceRelations.direction")} /><span className="min-w-0 break-words"><SourceReferenceBadge number={2} title={relation.targetTitle} />{relation.targetTitle}</span></p>
        <p className="whitespace-pre-wrap break-words font-medium"><SourceRelationReferenceText text={relation.explanation} relation={relation} /></p>
        <p className="text-[11px] opacity-70">{t(origins.size === 2 ? "sourceRelations.both" : origins.has("atomic_notes") ? "sourceRelations.atomicNotes" : "sourceRelations.sourceAnalysis")}</p>
        {!relation.current ? <p className="text-xs text-amber-500">{t("sourceRelations.stale")}</p> : null}
        {!compact ? <>
          <details className="min-w-0"><summary className="cursor-pointer text-xs font-medium">{t("sourceRelations.evidence")}</summary>
            <div className="mt-2 grid gap-3">
              <p className="break-words text-xs"><SourceRelationReferenceText text={relation.sourceIdea} relation={relation} /> → <SourceRelationReferenceText text={relation.targetIdea} relation={relation} /></p>
              {relation.evidence.map((evidence) => <div key={evidence.id} className="grid gap-2 rounded-lg bg-current/5 p-3">
                <p className="text-[11px] opacity-70">{t(evidence.origin === "atomic_notes" ? "sourceRelations.atomicNotes" : "sourceRelations.sourceAnalysis")}
                  {!evidence.current ? ` · ${t("sourceRelations.stale")}` : ""}</p>
                <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                  <div className="min-w-0"><p className="text-xs font-semibold"><SourceReferenceBadge number={1} title={relation.sourceTitle} />{relation.sourceTitle}</p><blockquote className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">{evidence.sourceExcerpt}</blockquote>
                    {onOpenNote && evidence.current && evidence.sourceNoteId ? <button type="button" className="mt-2 text-xs text-cyan-500 underline" onClick={() => onOpenNote(relation.sourceItemId,evidence.sourceNoteId!)}>{t("sourceRelations.openNote")}</button> : null}</div>
                  <div className="min-w-0"><p className="text-xs font-semibold"><SourceReferenceBadge number={2} title={relation.targetTitle} />{relation.targetTitle}</p><blockquote className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">{evidence.targetExcerpt}</blockquote>
                    {onOpenNote && evidence.current && evidence.targetNoteId ? <button type="button" className="mt-2 text-xs text-cyan-500 underline" onClick={() => onOpenNote(relation.targetSourceItemId,evidence.targetNoteId!)}>{t("sourceRelations.openNote")}</button> : null}</div>
                </div>
              </div>)}
            </div>
          </details>
          <div className="flex flex-wrap gap-2 text-xs">
            {relation.status !== "accepted" ? <button type="button" disabled={busy === relation.id || !relation.current} onClick={() => void review(relation,"accepted")} className="inline-flex items-center gap-1 rounded border border-current/20 px-2 py-1 disabled:opacity-40"><Check className="h-3 w-3" />{t("sourceRelations.accept")}</button> : null}
            {relation.status !== "rejected" ? <button type="button" disabled={busy === relation.id} onClick={() => void review(relation,"rejected")} className="inline-flex items-center gap-1 rounded border border-current/20 px-2 py-1"><X className="h-3 w-3" />{t("sourceRelations.reject")}</button> : <button type="button" disabled={busy === relation.id} onClick={() => void review(relation,"pending_review")}>{t("sourceRelations.restore")}</button>}
          </div>
        </> : null}
      </article>;
    })}
    {!loading && compact && total > 0 ? <p className="text-xs opacity-70">{relations.length} / {total}</p> : null}
    {!loading && !compact && total > 0 ? <div className="flex items-center justify-between gap-3 text-xs">
      <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset - 30))} className="disabled:opacity-30">{t("sourceRelations.previous")}</button>
      <span>{offset + 1}–{offset + relations.length} / {total}</span>
      <button type="button" disabled={!hasMore} onClick={() => setOffset(offset + 30)} className="inline-flex items-center gap-1 disabled:opacity-30">{t("sourceRelations.next")}<ChevronDown className="h-3 w-3" /></button>
    </div> : null}
  </div>;
}
