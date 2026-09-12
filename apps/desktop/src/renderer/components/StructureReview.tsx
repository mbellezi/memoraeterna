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

import type { DocumentStructureView, FileStructurePreview } from "../../shared/ipc";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { SourceMetadataPreview } from "./SourceMetadataPreview";
import { CreatorFields } from "./CreatorFields";
import { MarkdownPreview } from "./MarkdownEditor";

export function StructureReview({
  structure,
  t,
  busy,
  onSave,
  onConfirm,
  previewOnly = false,
  allowEmpty = false,
  initialDivisions,
  onDraftChange
}: {
  structure: FileStructurePreview;
  t: Translator;
  busy: boolean;
  onSave: (divisions: DocumentDivisionCandidate[]) => Promise<void>;
  onConfirm: (divisions: DocumentDivisionCandidate[]) => Promise<void>;
  previewOnly?: boolean;
  allowEmpty?: boolean;
  initialDivisions?: DocumentDivisionCandidate[];
  onDraftChange?: (divisions: DocumentDivisionCandidate[]) => void;
}) {
  const original = useMemo(() => structure.divisions.map(toCandidate), [structure]);
  const [history, setHistory] = useState<DocumentDivisionCandidate[][]>([initialDivisions ?? original]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(original[0]?.id ?? null);
  const [cutoffLevel, setCutoffLevel] = useState(() => Math.max(0, ...original.filter((division) => division.isProcessable).map((division) => division.level)));
  const [view, setView] = useState<"source" | "subitems">("subitems");
  const [filter, setFilter] = useState("");
  const [splitOffset, setSplitOffset] = useState<number | null>(null);
  const divisions = history[historyIndex] ?? original;
  const selectedIndex = divisions.findIndex((division) => division.id === selectedId);
  const selected = divisions[selectedIndex] ?? null;
  const selectedBoundaries = selected ? structure.boundaries.filter((boundary) =>
    selected.markdownStart !== undefined && selected.markdownEnd !== undefined
    && boundary.offset > selected.markdownStart && boundary.offset < selected.markdownEnd
  ) : [];
  const effectiveSplitOffset = selectedBoundaries.find((boundary) => boundary.offset === splitOffset)?.offset ?? selectedBoundaries[0]?.offset;
  const preview = selected && selected.markdownStart !== undefined && selected.markdownEnd !== undefined
    ? structure.rootMarkdown.slice(selected.markdownStart, selected.markdownEnd).trim()
    : "";
  const issues = validateDivisionTree(divisions);
  const blockingIssues = issues.filter((issue) => issue.code !== "empty_range");
  const selectedCount = divisions.filter((division) => division.reviewStatus !== "rejected" && division.isProcessable).length;

  function commit(next: DocumentDivisionCandidate[]) {
    const normalized = next.map((division, index) => ({ ...division, position: index }));
    setHistory((current) => [...current.slice(0, historyIndex + 1), normalized]);
    setHistoryIndex((current) => current + 1);
    onDraftChange?.(normalized);
  }

  function restoreHistory(index: number) {
    setHistoryIndex(index);
    onDraftChange?.(history[index] ?? original);
  }

  function selectItems(kind: "all" | "none" | "main") {
    commit(divisions.map((division) => {
      const included = kind === "all" || (kind === "main" && ["chapter", "article", "section"].includes(division.kind));
      return { ...division, isProcessable: included, reviewStatus: included ? "accepted" as const : "rejected" as const };
    }));
  }

  function updateDivision(id: string, patch: Partial<DocumentDivisionCandidate>) {
    commit(divisions.map((division) => division.id === id
      ? { ...division, ...patch, reviewStatus: patch.reviewStatus ?? "edited" }
      : division));
  }

  function updateSelected(patch: Partial<DocumentDivisionCandidate>) {
    if (selected) updateDivision(selected.id, patch);
  }

  function splitSelected() {
    if (!selected || selected.markdownStart === undefined || selected.markdownEnd === undefined) return;
    const boundary = effectiveSplitOffset;
    if (boundary === undefined || boundary <= selected.markdownStart || boundary >= selected.markdownEnd) return;
    const nextId = crypto.randomUUID();
    const first = { ...selected, markdownEnd: boundary, endSelector: { ...selected.endSelector, offset: boundary }, reviewStatus: "edited" as const };
    const second = {
      ...selected,
      id: nextId,
      parentId: selected.parentId,
      markdownStart: boundary,
      startSelector: { ...selected.startSelector, offset: boundary },
      evidence: [...selected.evidence, { kind: "manual-split", source: "user", score: 1, metadata: {} }],
      reviewStatus: "edited" as const
    };
    commit([...divisions.slice(0, selectedIndex), first, second, ...divisions.slice(selectedIndex + 1)]);
    setSelectedId(nextId);
    setSplitOffset(null);
  }

  function applyCutoff(level: number) {
    setCutoffLevel(level);
    commit(divisions.map((division) => ({
      ...division,
      isProcessable: division.level <= level,
      reviewStatus: division.level <= level ? (division.reviewStatus === "rejected" ? "accepted" : division.reviewStatus) : "rejected"
    })));
  }

  function snapSelected(edge: "start" | "end", offset: number) {
    if (!selected) return;
    if (edge === "start") {
      updateSelected({ markdownStart: offset, startSelector: { ...selected.startSelector, offset } });
    } else {
      updateSelected({ markdownEnd: offset, endSelector: { ...selected.endSelector, offset } });
    }
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

  return <section className="@container grid min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
      <div>
        <p hidden={previewOnly} className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">{t("structure.eyebrow")}</p>
        <h2 hidden={previewOnly} className="mt-1 text-lg font-semibold">{t("intake.subitemsTitle")}</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("intake.subitemsHint")}</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 disabled:opacity-40 dark:border-slate-800"
          disabled={busy || historyIndex === 0} aria-label={t("structure.actions.undo")} title={t("structure.actions.undo")} onClick={() => restoreHistory(Math.max(0, historyIndex - 1))}>
          <Undo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 disabled:opacity-40 dark:border-slate-800"
          disabled={busy || historyIndex >= history.length - 1} aria-label={t("structure.actions.redo")} title={t("structure.actions.redo")} onClick={() => restoreHistory(Math.min(history.length - 1, historyIndex + 1))}>
          <Redo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 dark:border-slate-800"
          disabled={busy} aria-label={t("structure.actions.restore")} title={t("structure.actions.restore")} onClick={() => { commit(original); setSelectedId(original[0]?.id ?? null); }}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>

    <fieldset disabled={busy} className="min-w-0">
    <div hidden={previewOnly} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3 dark:border-slate-800"><div role="group" aria-label={t("intake.viewLabel")} className="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-900">{(["source", "subitems"] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)} className={cn("rounded-md px-3 py-2 text-xs", view === item ? "bg-white font-medium text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200" : "text-slate-500")}>{t(item === "source" ? "intake.sourceView" : "intake.subitemsView")}</button>)}</div><span className="text-xs text-slate-500" role="status">{t("structure.selectedCount", { values: { count: selectedCount } })}</span></div>
    {view === "source" ? <div className="grid gap-3 p-4"><p className="text-xs text-slate-500">{t("intake.sourcePreviewHint")}</p><div className="max-h-[34rem] overflow-auto"><MarkdownPreview markdown={structure.rootMarkdown} emptyLabel={t("structure.previewUnavailable")} /></div></div> : <div className="grid min-h-0 @min-[760px]:grid-cols-[minmax(260px,.8fr)_minmax(0,1.2fr)]">

      <div className="min-h-0 border-r border-slate-200 dark:border-slate-800">
        <div className="grid gap-2 border-b border-slate-200 px-4 py-3 text-xs font-semibold dark:border-slate-800">
          <div className="flex items-center justify-between"><span>{t("structure.treeTitle")}</span><span className="text-slate-500">{t("structure.selectedCount", { values: { count: selectedCount } })}</span></div>
          <div className="flex flex-wrap gap-1"><Button type="button" onClick={() => selectItems("main")}>{t("intake.selectMain")}</Button><Button type="button" onClick={() => selectItems("all")}>{t("intake.selectAll")}</Button><Button type="button" onClick={() => selectItems("none")}>{t("intake.selectNone")}</Button></div><input aria-label={t("intake.filterSubitems")} placeholder={t("intake.filterSubitems")} value={filter} onChange={(event) => setFilter(event.target.value)} className="h-9 min-w-0 rounded-md border border-slate-300 bg-white px-2 text-sm font-normal dark:border-slate-700 dark:bg-slate-950" /><details><summary className="cursor-pointer font-normal">{t("intake.selectionOptions")}</summary><label className="mt-2 flex items-center justify-between gap-3 font-normal"><span>{t("structure.cutoffLevel")}</span><select value={cutoffLevel} onChange={(event) => applyCutoff(Number(event.target.value))} className="h-8 rounded border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-950">{[...new Set(divisions.map((division) => division.level))].sort((a, b) => a - b).map((level) => <option key={level} value={level}>{level + 1}</option>)}</select></label></details>
        </div>
        <ol role="tree" aria-label={t("structure.treeTitle")} className="max-h-[520px] overflow-auto p-2">
          {divisions.filter((division) => !filter.trim() || division.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).map((division) => {
            const active = division.id === selectedId;
            const rejected = division.reviewStatus === "rejected";
            return <li key={division.id} role="treeitem" aria-level={division.level + 1} aria-selected={active}>
              <div
                className={cn(
                  "grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2 py-2 text-left text-sm",
                  active ? "bg-cyan-50 ring-1 ring-cyan-300 dark:bg-cyan-950/50 dark:ring-cyan-800" : "hover:bg-slate-50 dark:hover:bg-slate-900",
                  rejected && "opacity-50"
                )}
                style={{ paddingLeft: `${8 + Math.min(division.level, 5) * 16}px` }}>
                <input
                  type="checkbox"
                  aria-label={t("structure.createSubelement")}
                  title={t("structure.createSubelement")}
                  className="h-4 w-4 cursor-pointer accent-accent disabled:cursor-not-allowed"
                  checked={!rejected && division.isProcessable}
                  onChange={(event) => {
                    setSelectedId(division.id);
                    updateDivision(division.id, { isProcessable: event.target.checked, reviewStatus: event.target.checked ? "accepted" : "rejected" });
                  }}
                />
                <button type="button" className="col-span-2 grid min-w-0 grid-cols-[1fr_auto] items-center gap-2 text-left"
                  onClick={() => setSelectedId(division.id)}>
                  <span className="min-w-0"><span className="block truncate font-medium">{division.title}</span><span className="text-[11px] text-slate-500">{t(`structure.kinds.${division.kind}` as MessageKey)}</span></span>
                  <ConfidenceBadge confidence={division.confidence} t={t} />
                </button>
              </div>
            </li>;
          })}
        </ol>
      </div>

      <div className="grid min-w-0 content-start gap-3 p-4">
        {selected ? <>
          <div role="group" aria-label={t("intake.subitemActions")} className="grid min-w-0 gap-2 rounded-xl border border-border bg-soft/40 p-3">
          {selectedBoundaries.length ? <div className="grid gap-2"><label htmlFor="split-boundary" className="text-xs font-semibold">{t("structure.splitBoundary")}</label><select id="split-boundary" value={effectiveSplitOffset} onChange={(event) => setSplitOffset(Number(event.target.value))} className="h-9 min-w-0 rounded-md border border-border bg-surface px-2 text-xs">{selectedBoundaries.map((boundary) => <option key={boundary.offset} value={boundary.offset}>{boundary.page ? t("structure.boundaryPage", { values: { page: boundary.page, label: boundary.label } }) : boundary.label}</option>)}</select></div> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={splitSelected} disabled={selectedBoundaries.length === 0}><Scissors className="h-4 w-4" />{t("structure.actions.split")}</Button>
            <Button type="button" onClick={mergePrevious} disabled={selectedIndex <= 0}><GitMerge className="h-4 w-4" />{t("structure.actions.mergePrevious")}</Button>
            <Button type="button" onClick={() => move(-1)} disabled={selectedIndex <= 0}><ChevronUp className="h-4 w-4" />{t("structure.actions.moveUp")}</Button>
            <Button type="button" onClick={() => move(1)} disabled={selectedIndex >= divisions.length - 1}><ChevronDown className="h-4 w-4" />{t("structure.actions.moveDown")}</Button>
          </div>
          </div>
          <SourceMetadataPreview key={selected.id} text={preview.slice(0, 20_000)} truncated={preview.length > 20_000} values={{ title: selected.title, creators: divisionCreatorLines(selected).join("\n"), abstract: typeof selected.metadata.abstract === "string" ? selected.metadata.abstract : "", doi: typeof selected.metadata.doi === "string" ? selected.metadata.doi : "" }} t={t} onApply={(field, value) => updateSelected(field === "title" ? { title: value } : { metadata: { ...selected.metadata, [field]: field === "creators" ? parseDivisionCreators(value) : value } })} />
          <details className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"><summary className="cursor-pointer text-sm font-medium">{t("intake.adjustSubitem")}</summary><div className="mt-3 grid gap-3">

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
              {selected.markdownStart !== undefined && selected.markdownEnd !== undefined ? <div className="grid grid-cols-2 gap-2"><select aria-label={t("structure.boundaryStart")} value={selected.markdownStart} onChange={(event) => snapSelected("start", Number(event.target.value))} className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950">{structure.boundaries.filter((boundary) => boundary.offset < selected.markdownEnd!).map((boundary) => <option key={boundary.offset} value={boundary.offset}>{boundary.label}</option>)}</select><select aria-label={t("structure.boundaryEnd")} value={selected.markdownEnd} onChange={(event) => snapSelected("end", Number(event.target.value))} className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950">{structure.boundaries.filter((boundary) => boundary.offset > selected.markdownStart!).map((boundary) => <option key={boundary.offset} value={boundary.offset}>{boundary.label}</option>)}</select></div> : <div className="flex h-10 items-center rounded-lg bg-slate-100 px-3 text-sm dark:bg-slate-900">{selected.startPage && selected.endPage ? t("structure.pageRange", { values: { start: selected.startPage, end: selected.endPage } }) : t("structure.previewUnavailable")}</div>}
            </div>
          </div>
          <div className="grid gap-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-600" checked={selected.isProcessable && selected.reviewStatus !== "rejected"}
                onChange={(event) => updateSelected({ isProcessable: event.target.checked, reviewStatus: event.target.checked ? "accepted" : "rejected" })} />
              <span><span className="block text-sm font-medium">{t("structure.createSubelement")}</span><span className="text-xs text-slate-500">{t("structure.createSubelementHint")}</span></span>
            </label>
            <CreatorFields value={divisionCreatorLines(selected).join("\n")} t={t} onChange={(value) => updateSelected({ metadata: { ...selected.metadata, creators: parseDivisionCreators(value) } })} />
          </div>

          <details className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
            <summary className="cursor-pointer font-semibold">{t("structure.evidenceTitle")}</summary>
            <ul className="mt-3 grid gap-2">{selected.evidence.map((evidence, index) => <li key={`${evidence.kind}-${index}`} className="rounded bg-slate-50 p-2 dark:bg-slate-900">
              {t("structure.evidence", { values: { source: evidence.source, score: Math.round(evidence.score * 100) } })}
            </li>)}</ul>
          </details>
          </div></details>
        </> : <p className="text-sm text-slate-500">{t("structure.noSelection")}</p>}
      </div>
    </div>}
    </fieldset>

    <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="text-sm">
        {blockingIssues.length > 0 ? <span className="inline-flex items-center gap-2 font-medium text-rose-700 dark:text-rose-300"><AlertTriangle className="h-4 w-4" />{t("structure.blockingIssues", { values: { count: blockingIssues.length } })}</span>
          : selectedCount === 0 ? <span className="inline-flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300"><AlertTriangle className="h-4 w-4" />{t(previewOnly || allowEmpty ? "intake.rootOnly" : "structure.selectAtLeastOne")}</span>
          : <span className="inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-300"><Check className="h-4 w-4" />{t("structure.ready")}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {!previewOnly ? <Button type="button" disabled={busy} onClick={() => void onSave(divisions)}><Save className="h-4 w-4" />{t("structure.actions.saveDraft")}</Button> : null}
        <Button variant="primary" type="button" disabled={busy || blockingIssues.length > 0 || (!previewOnly && !allowEmpty && selectedCount === 0)} onClick={() => void onConfirm(divisions)}>
          <Check className="h-4 w-4" />{t(previewOnly ? "intake.confirmSelection" : "structure.actions.confirmCount", { values: { count: selectedCount } })}
        </Button>
      </div>
    </footer>
  </section>;
}

function toCandidate(division: DocumentDivisionCandidate): DocumentDivisionCandidate {
  const { childSourceItemId: _childSourceItemId, childDocumentId: _childDocumentId, ...candidate } = division as DocumentStructureView["divisions"][number];
  return candidate;
}

function ConfidenceBadge({ confidence, t }: { confidence: number; t: Translator }) {
  const level = confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold",
    level === "high" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : level === "medium" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200")}>{t(`structure.confidence.${level}` as MessageKey)}</span>;
}

function divisionCreatorLines(division: DocumentDivisionCandidate): string[] {
  const creators = division.metadata.creators;
  return Array.isArray(creators) ? creators.flatMap((creator) =>
    typeof creator === "object" && creator !== null && "name" in creator && typeof creator.name === "string"
      ? [`${"role" in creator && typeof creator.role === "string" ? creator.role : "author"}: ${creator.name}${"affiliation" in creator && typeof creator.affiliation === "string" ? ` | ${creator.affiliation}` : ""}`]
      : []
  ) : [];
}

function parseDivisionCreators(value: string): Array<{ name: string; role: string; affiliation?: string }> {
  const roles = new Set(["author", "editor", "translator", "organizer", "channel", "host", "contributor"]);
  return value.split(/\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const match = trimmed.match(/^([a-z]+):\s*(.*)$/i);
    const role = match?.[1] && roles.has(match[1].toLowerCase()) ? match[1].toLowerCase() : "author";
    const body = match?.[1] && roles.has(match[1].toLowerCase()) ? match[2]! : trimmed;
    const [name, affiliation] = body.split("|", 2).map((part) => part.trim());
    return name ? [{ name, role, ...(affiliation ? { affiliation } : {}) }] : [];
  });
}
