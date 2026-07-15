import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  GitMerge,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Undo2
} from "lucide-react";
import {
  DocumentDivisionKinds,
  validateDivisionTree,
  type DocumentDivisionCandidate,
  type DocumentDivisionKind
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { DocumentStructureView } from "../../shared/ipc";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

export function StructureReview({
  structure,
  t,
  busy,
  onSave,
  onConfirm
}: {
  structure: DocumentStructureView;
  t: Translator;
  busy: boolean;
  onSave: (divisions: DocumentDivisionCandidate[]) => Promise<void>;
  onConfirm: (divisions: DocumentDivisionCandidate[]) => Promise<void>;
}) {
  const original = useMemo(() => structure.divisions.map(toCandidate), [structure]);
  const [history, setHistory] = useState<DocumentDivisionCandidate[][]>([original]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(original[0]?.id ?? null);
  const divisions = history[historyIndex] ?? original;
  const selectedIndex = divisions.findIndex((division) => division.id === selectedId);
  const selected = divisions[selectedIndex] ?? null;
  const issues = validateDivisionTree(divisions);
  const blockingIssues = issues.filter((issue) => issue.code !== "empty_range");
  const selectedCount = divisions.filter((division) => division.reviewStatus !== "rejected" && division.isProcessable).length;

  function commit(next: DocumentDivisionCandidate[]) {
    const normalized = next.map((division, index) => ({ ...division, position: index }));
    setHistory((current) => [...current.slice(0, historyIndex + 1), normalized]);
    setHistoryIndex((current) => current + 1);
  }

  function updateSelected(patch: Partial<DocumentDivisionCandidate>) {
    if (!selected) return;
    commit(divisions.map((division) => division.id === selected.id
      ? { ...division, ...patch, reviewStatus: patch.reviewStatus ?? "edited" }
      : division));
  }

  function splitSelected() {
    if (!selected || selected.markdownStart === undefined || selected.markdownEnd === undefined) return;
    const midpoint = Math.floor((selected.markdownStart + selected.markdownEnd) / 2);
    if (midpoint <= selected.markdownStart || midpoint >= selected.markdownEnd) return;
    const nextId = crypto.randomUUID();
    const first = { ...selected, markdownEnd: midpoint, endSelector: { ...selected.endSelector, offset: midpoint }, reviewStatus: "edited" as const };
    const second = {
      ...selected,
      id: nextId,
      parentId: selected.parentId,
      markdownStart: midpoint,
      startSelector: { ...selected.startSelector, offset: midpoint },
      evidence: [...selected.evidence, { kind: "manual-split", source: "user", score: 1, metadata: {} }],
      reviewStatus: "edited" as const
    };
    commit([...divisions.slice(0, selectedIndex), first, second, ...divisions.slice(selectedIndex + 1)]);
    setSelectedId(nextId);
  }

  function mergePrevious() {
    if (!selected || selectedIndex <= 0) return;
    const previous = divisions[selectedIndex - 1];
    if (!previous) return;
    const merged = {
      ...previous,
      endSelector: selected.endSelector,
      ...(selected.endPage === undefined ? {} : { endPage: selected.endPage }),
      ...(selected.markdownEnd === undefined ? {} : { markdownEnd: selected.markdownEnd }),
      evidence: [...previous.evidence, { kind: "manual-merge", source: "user", score: 1, metadata: { mergedDivisionId: selected.id } }],
      reviewStatus: "edited" as const
    };
    commit([...divisions.slice(0, selectedIndex - 1), merged, ...divisions.slice(selectedIndex + 1)]);
    setSelectedId(previous.id);
  }

  function move(offset: -1 | 1) {
    if (!selected) return;
    const destination = selectedIndex + offset;
    if (destination < 0 || destination >= divisions.length) return;
    const next = [...divisions];
    [next[selectedIndex], next[destination]] = [next[destination]!, next[selectedIndex]!];
    commit(next);
  }

  return <section className="grid min-h-[620px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-slate-800">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">{t("structure.eyebrow")}</p>
        <h2 className="mt-1 text-xl font-semibold">{t("structure.title")}</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("structure.description")}</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 disabled:opacity-40 dark:border-slate-800"
          disabled={historyIndex === 0} title={t("structure.actions.undo")} onClick={() => setHistoryIndex((current) => Math.max(0, current - 1))}>
          <Undo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 disabled:opacity-40 dark:border-slate-800"
          disabled={historyIndex >= history.length - 1} title={t("structure.actions.redo")} onClick={() => setHistoryIndex((current) => Math.min(history.length - 1, current + 1))}>
          <Redo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 dark:border-slate-800"
          title={t("structure.actions.restore")} onClick={() => { commit(original); setSelectedId(original[0]?.id ?? null); }}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div className="grid min-h-0 lg:grid-cols-[minmax(300px,0.9fr)_minmax(360px,1.1fr)]">
      <div className="min-h-0 border-r border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-xs font-semibold dark:border-slate-800">
          <span>{t("structure.treeTitle")}</span>
          <span className="text-slate-500">{t("structure.selectedCount", { values: { count: selectedCount } })}</span>
        </div>
        <ol role="tree" aria-label={t("structure.treeTitle")} className="max-h-[520px] overflow-auto p-2">
          {divisions.map((division, index) => {
            const active = division.id === selectedId;
            const rejected = division.reviewStatus === "rejected";
            return <li key={division.id} role="treeitem" aria-level={division.level + 1} aria-selected={active}>
              <button type="button" onClick={() => setSelectedId(division.id)}
                className={cn(
                  "grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2 py-2 text-left text-sm",
                  active ? "bg-cyan-50 ring-1 ring-cyan-300 dark:bg-cyan-950/50 dark:ring-cyan-800" : "hover:bg-slate-50 dark:hover:bg-slate-900",
                  rejected && "opacity-50"
                )}
                style={{ paddingLeft: `${8 + Math.min(division.level, 5) * 16}px` }}>
                <span className={cn("grid h-5 w-5 place-items-center rounded border", !rejected && division.isProcessable
                  ? "border-cyan-600 bg-cyan-600 text-white" : "border-slate-300 dark:border-slate-700")}>
                  {!rejected && division.isProcessable ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                </span>
                <span className="min-w-0"><span className="block truncate font-medium">{division.title}</span><span className="text-[11px] text-slate-500">{t(`structure.kinds.${division.kind}` as MessageKey)}</span></span>
                <ConfidenceBadge confidence={division.confidence} t={t} />
              </button>
            </li>;
          })}
        </ol>
      </div>

      <div className="grid content-start gap-5 overflow-auto p-5">
        {selected ? <>
          <div className="grid gap-2">
            <label htmlFor="division-title" className="text-xs font-semibold">{t("structure.fields.title")}</label>
            <input id="division-title" value={selected.title} onChange={(event) => updateSelected({ title: event.target.value })}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><label htmlFor="division-kind" className="text-xs font-semibold">{t("structure.fields.kind")}</label>
              <select id="division-kind" value={selected.kind} onChange={(event) => updateSelected({ kind: event.target.value as DocumentDivisionKind })}
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
                {DocumentDivisionKinds.map((kind) => <option key={kind} value={kind}>{t(`structure.kinds.${kind}` as MessageKey)}</option>)}
              </select>
            </div>
            <div className="grid gap-2"><span className="text-xs font-semibold">{t("structure.fields.range")}</span>
              <div className="flex h-10 items-center rounded-lg bg-slate-100 px-3 text-sm dark:bg-slate-900">
                {selected.startPage && selected.endPage
                  ? t("structure.pageRange", { values: { start: selected.startPage, end: selected.endPage } })
                  : t("structure.offsetRange", { values: { start: selected.markdownStart ?? 0, end: selected.markdownEnd ?? 0 } })}
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <span className="text-xs font-semibold">{t("structure.fields.behavior")}</span>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-600"
                checked={selected.reviewStatus !== "rejected"}
                onChange={(event) => updateSelected({ reviewStatus: event.target.checked ? "accepted" : "rejected" })} />
              <span><span className="block text-sm font-medium">{t("structure.includeNavigation")}</span><span className="text-xs text-slate-500">{t("structure.includeNavigationHint")}</span></span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-600" checked={selected.isProcessable}
                disabled={selected.reviewStatus === "rejected"} onChange={(event) => updateSelected({ isProcessable: event.target.checked })} />
              <span><span className="block text-sm font-medium">{t("structure.processable")}</span><span className="text-xs text-slate-500">{t("structure.processableHint")}</span></span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={splitSelected} disabled={selected.markdownStart === undefined || selected.markdownEnd === undefined}><Scissors className="h-4 w-4" />{t("structure.actions.split")}</Button>
            <Button type="button" onClick={mergePrevious} disabled={selectedIndex <= 0}><GitMerge className="h-4 w-4" />{t("structure.actions.mergePrevious")}</Button>
            <Button type="button" onClick={() => move(-1)} disabled={selectedIndex <= 0}><ChevronUp className="h-4 w-4" />{t("structure.actions.moveUp")}</Button>
            <Button type="button" onClick={() => move(1)} disabled={selectedIndex >= divisions.length - 1}><ChevronDown className="h-4 w-4" />{t("structure.actions.moveDown")}</Button>
          </div>
          <details className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
            <summary className="cursor-pointer font-semibold">{t("structure.evidenceTitle")}</summary>
            <ul className="mt-3 grid gap-2">{selected.evidence.map((evidence, index) => <li key={`${evidence.kind}-${index}`} className="rounded bg-slate-50 p-2 dark:bg-slate-900">
              {t("structure.evidence", { values: { source: evidence.source, score: Math.round(evidence.score * 100) } })}
            </li>)}</ul>
          </details>
        </> : <p className="text-sm text-slate-500">{t("structure.noSelection")}</p>}
      </div>
    </div>

    <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="text-sm">
        {blockingIssues.length > 0 ? <span className="inline-flex items-center gap-2 font-medium text-rose-700 dark:text-rose-300"><AlertTriangle className="h-4 w-4" />{t("structure.blockingIssues", { values: { count: blockingIssues.length } })}</span>
          : <span className="inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-300"><Check className="h-4 w-4" />{t("structure.ready")}</span>}
      </div>
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={() => void onSave(divisions)}><Save className="h-4 w-4" />{t("structure.actions.saveDraft")}</Button>
        <Button type="button" disabled={busy || blockingIssues.length > 0 || selectedCount === 0} onClick={() => void onConfirm(divisions)}>
          <Check className="h-4 w-4" />{t("structure.actions.confirm")}
        </Button>
      </div>
    </footer>
  </section>;
}

function toCandidate(division: DocumentStructureView["divisions"][number]): DocumentDivisionCandidate {
  const { childSourceItemId: _childSourceItemId, childDocumentId: _childDocumentId, ...candidate } = division;
  return candidate;
}

function ConfidenceBadge({ confidence, t }: { confidence: number; t: Translator }) {
  const level = confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold",
    level === "high" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : level === "medium" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200")}>{t(`structure.confidence.${level}` as MessageKey)}</span>;
}
