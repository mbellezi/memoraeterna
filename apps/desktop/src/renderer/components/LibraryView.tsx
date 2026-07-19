import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileText,
  Film,
  Globe,
  GraduationCap,
  Layers,
  Newspaper,
  NotebookPen,
  Play,
  RefreshCw,
  ScrollText,
  StickyNote,
  Trash2,
  X
} from "lucide-react";
import { SourceItemTypes, type ProcessingPlanRequest, type SourceItemType } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { LibrarySource, SourceDetail } from "../../shared/ipc";
import { cn } from "../lib/cn";
import { coverAssetIdFromMetadata } from "../lib/cover-cache";
import { Button } from "./ui/button";
import { CoverImage } from "./ui/cover-image";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";

export interface LibraryExternalTarget {
  sourceItemId: string;
  token: number;
}

export type LibraryHistoryEntry =
  | { view: "library"; path: string[]; fromSearch: boolean }
  | { view: "search" };

const libraryHistoryKey = "memoraEternaLibrary";

export function createLibraryHistoryState(entry: LibraryHistoryEntry): Record<string, unknown> {
  return { [libraryHistoryKey]: { version: 1, ...entry } };
}

export function libraryHistoryEntryFromState(state: unknown): LibraryHistoryEntry | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[libraryHistoryKey];
  if (!candidate || typeof candidate !== "object") return null;
  const entry = candidate as Record<string, unknown>;
  if (entry.version !== 1) return null;
  if (entry.view === "search") return { view: "search" };
  if (entry.view !== "library" || !Array.isArray(entry.path)
    || !entry.path.every((id) => typeof id === "string")
    || typeof entry.fromSearch !== "boolean") return null;
  return { view: "library", path: entry.path, fromSearch: entry.fromSearch };
}

export function navigateLibraryHistoryFromMouseButton(
  button: number,
  history: Pick<History, "back" | "forward">
): boolean {
  if (button === 3) history.back();
  else if (button === 4) history.forward();
  else return false;
  return true;
}

const typeIcons: Record<SourceItemType, typeof FileText> = {
  PersonalNote: StickyNote,
  DailyNote: CalendarDays,
  WebArticle: Globe,
  Book: BookOpen,
  BookChapter: BookMarked,
  PeriodicalIssue: Newspaper,
  AcademicPaper: GraduationCap,
  DocumentSection: FileText,
  StandaloneArticle: ScrollText,
  Video: Film,
  GenericDocument: File
};

const typeBadgeStyles: Record<SourceItemType, string> = {
  PersonalNote: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  DailyNote: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  WebArticle: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  Book: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  BookChapter: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  PeriodicalIssue: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  AcademicPaper: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  DocumentSection: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  StandaloneArticle: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  Video: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  GenericDocument: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200"
};

export function SourceTypeBadge({ type, t }: { type: SourceItemType; t: Translator }) {
  const Icon = typeIcons[type];
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
      typeBadgeStyles[type]
    )}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {t(`import.sourceTypes.${type}` as MessageKey)}
    </span>
  );
}

export function LibraryView({ t, externalTarget = null, onNavigate, onExitToSearch }: {
  t: Translator;
  externalTarget?: LibraryExternalTarget | null;
  onNavigate?: () => void;
  onExitToSearch?: () => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [stack, setStack] = useState<string[]>([]);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [fromSearch, setFromSearch] = useState(false);
  const [filter, setFilter] = useState<SourceItemType | "all">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [processingIds, setProcessingIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const consumedTargetToken = useRef<number | null>(null);
  const historyInitialized = useRef(false);
  const onNavigateRef = useRef(onNavigate);
  const onExitToSearchRef = useRef(onExitToSearch);

  onNavigateRef.current = onNavigate;
  onExitToSearchRef.current = onExitToSearch;

  const currentId = stack.at(-1) ?? null;

  async function load() {
    setLoading(true);
    setError(false);
    try {
      setSources(await window.app.knowledge.listLibrary([]));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!historyInitialized.current) {
      replaceLibraryHistory(externalTarget
        ? { view: "search" }
        : { view: "library", path: [], fromSearch: false });
      historyInitialized.current = true;
    }

    function handlePopState(event: PopStateEvent) {
      const entry = libraryHistoryEntryFromState(event.state);
      onNavigateRef.current?.();

      if (entry?.view === "search") {
        setStack([]);
        setFromSearch(false);
        onExitToSearchRef.current?.();
        return;
      }

      const path = entry?.view === "library" ? entry.path : [];
      const cameFromSearch = entry?.view === "library" ? entry.fromSearch : false;
      setStack(path);
      setFromSearch(cameFromSearch);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    function handleMouseHistory(event: MouseEvent) {
      if (!navigateLibraryHistoryFromMouseButton(event.button, window.history)) return;
      event.preventDefault();
    }

    window.addEventListener("mouseup", handleMouseHistory);
    return () => window.removeEventListener("mouseup", handleMouseHistory);
  }, []);

  useEffect(() => {
    if (!externalTarget || consumedTargetToken.current === externalTarget.token) return;
    consumedTargetToken.current = externalTarget.token;
    pushLibraryHistory({ view: "library", path: [externalTarget.sourceItemId], fromSearch: true });
    onNavigate?.();
    setFromSearch(true);
    setStack([externalTarget.sourceItemId]);
  }, [externalTarget, onNavigate]);

  useEffect(() => {
    if (!currentId) {
      setDetail(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(false);
    window.app.knowledge.getSourceDetail(currentId)
      .then((loaded) => {
        if (!active) return;
        setDetail(loaded);
        if (!loaded) setError(true);
      })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [currentId]);

  function openSource(id: string) {
    navigateToPath([...stack, id], fromSearch);
  }

  function goBack() {
    if (libraryHistoryEntryFromState(window.history.state)?.view === "library") {
      window.history.back();
      return;
    }

    const nextPath = stack.slice(0, -1);
    setStack(nextPath);
    if (nextPath.length === 0) setFromSearch(false);
    onNavigate?.();
  }

  function openPath(ids: string[]) {
    navigateToPath(ids, false);
  }

  function navigateToPath(path: string[], cameFromSearch: boolean) {
    pushLibraryHistory({ view: "library", path, fromSearch: cameFromSearch });
    setStack(path);
    setFromSearch(cameFromSearch);
    onNavigate?.();
  }

  function goToLibrary() {
    navigateToPath([], false);
  }

  function returnToLibraryAfterDeletion() {
    replaceLibraryHistory({ view: "library", path: [], fromSearch: false });
    setStack([]);
    setFromSearch(false);
    onNavigate?.();
    void load();
  }

  if (currentId) {
    return <>
      {detail && detail.id === currentId ? (
        <SourceDetailView
          key={detail.id}
          detail={detail}
          allSources={sources}
          backLabel={stack.length === 1 && fromSearch ? t("library.detail.backToSearch") : t("library.back")}
          t={t}
          onOpen={openSource}
          onOpenPath={openPath}
          onGoToLibrary={goToLibrary}
          onBack={goBack}
          onProcess={() => setProcessingIds([currentId])}
          onDeleted={returnToLibraryAfterDeletion}
        />
      ) : error ? (
        <div className="grid gap-4">
          <StateCard>{t("library.error")}</StateCard>
          <Button type="button" className="w-fit" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("library.back")}
          </Button>
        </div>
      ) : (
        <StateCard>{t("shell.states.loading")}</StateCard>
      )}
      {processingIds ? (
        <ProcessingDialog
          sourceIds={processingIds}
          sources={sources}
          t={t}
          onClose={() => setProcessingIds(null)}
          onQueued={() => { setProcessingIds(null); setSelectedIds(new Set()); void load(); }}
        />
      ) : null}
    </>;
  }

  const orderedSources = orderHierarchically(sources);
  const gridSources = filter === "all"
    ? orderedSources.filter(({ depth }) => depth === 0).map(({ source }) => source)
    : orderedSources.filter(({ source }) => source.type === filter).map(({ source }) => source);

  return <section className="grid gap-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <label className="grid gap-1 text-sm font-medium">
        {t("library.filterByType")}
        <select value={filter} onChange={(event) => setFilter(event.target.value as SourceItemType | "all")}
          className="h-9 min-w-52 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          <option value="all">{t("library.allTypes")}</option>
          {SourceItemTypes.map((type) => <option key={type} value={type}>{t(`import.sourceTypes.${type}` as MessageKey)}</option>)}
        </select>
      </label>
      <button type="button" className="grid h-9 w-9 place-items-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-900"
        title={t("library.refresh")} onClick={() => void load()}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    {selectedIds.size > 0 ? <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-200 bg-cyan-50/95 px-4 py-3 shadow-sm backdrop-blur dark:border-cyan-900 dark:bg-cyan-950/95">
      <span className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">{t("library.selectionCount", { values: { count: selectedIds.size } })}</span>
      <div className="flex gap-2"><Button type="button" onClick={() => setProcessingIds([...selectedIds])}><Play className="h-4 w-4" />{t("library.actions.processSelected")}</Button><button type="button" className="grid h-9 w-9 place-items-center rounded-lg" title={t("library.actions.clearSelection")} onClick={() => setSelectedIds(new Set())}><X className="h-4 w-4" /></button></div>
    </div> : null}
    {error ? <StateCard>{t("library.error")}</StateCard> : loading ? <StateCard>{t("shell.states.loading")}</StateCard>
      : sources.length === 0 ? <StateCard>{t("library.empty")}</StateCard>
        : <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {gridSources.map((source) => <li key={source.id} className="motion-fade-in-up">
            <SourceCard
              source={source}
              t={t}
              selected={selectedIds.has(source.id)}
              onToggleSelect={(checked) => setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(source.id); else next.delete(source.id);
                return next;
              })}
              onOpen={() => navigateToPath([source.id], false)}
              onProcess={() => setProcessingIds([source.id])}
            />
          </li>)}
        </ol>}
    {processingIds ? <ProcessingDialog sourceIds={processingIds} sources={sources} t={t} onClose={() => setProcessingIds(null)} onQueued={() => { setProcessingIds(null); setSelectedIds(new Set()); void load(); }} /> : null}
  </section>;
}

function SourceCard({ source, t, selected, onToggleSelect, onOpen, onProcess }: {
  source: LibrarySource;
  t: Translator;
  selected: boolean;
  onToggleSelect: (checked: boolean) => void;
  onOpen: () => void;
  onProcess: () => void;
}) {
  const Icon = typeIcons[source.type];
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={t("library.cards.openDetail", { values: { title: source.title } })}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-cyan-400 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-cyan-700"
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}
    >
      <div className="flex gap-4 p-4">
        <div className="grid h-28 w-20 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
          <CoverImage
            assetId={coverAssetIdFromMetadata(source.metadata)}
            alt={source.title}
            fallback={<Icon className="h-8 w-8 text-slate-400" aria-hidden="true" />}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-semibold leading-snug">{source.title}</h2>
          {source.subtitle ? <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{source.subtitle}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <SourceTypeBadge type={source.type} t={t} />
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium dark:bg-slate-800">
              {source.hasDocument ? t(processingKey(source.processingStatus)) : t("library.container")}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-center justify-between gap-2">
          <input
            type="checkbox"
            aria-label={t("library.actions.selectSource", { values: { title: source.title } })}
            checked={selected}
            className="h-4 w-4 accent-cyan-600"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onToggleSelect(event.target.checked)}
          />
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 opacity-0 transition group-hover:opacity-100 hover:bg-cyan-50 focus-visible:opacity-100 dark:border-slate-700 dark:hover:bg-cyan-950"
            title={t("library.actions.process")}
            onClick={(event) => { event.stopPropagation(); onProcess(); }}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {source.summary ? <p className="line-clamp-2 px-4 pb-3 text-sm text-slate-600 dark:text-slate-300">{source.summary}</p> : null}
      <footer className="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
        <span className="inline-flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          {t("library.childCount", { values: { count: source.childCount } })}
        </span>
        <span className="truncate">
          {source.hasDocument
            ? t("library.currentStage", { values: { stage: t(stageKey(source.currentStage)) } })
            : t("library.containerHint")}
        </span>
      </footer>
    </article>
  );
}

function ProcessingDialog({ sourceIds, sources, t, onClose, onQueued }: { sourceIds: string[]; sources: LibrarySource[]; t: Translator; onClose: () => void; onQueued: () => void }) {
  const [plan, setPlan] = useState<ProcessingPlanRequest>(() => ({
    ...defaultProcessingPlan("search_ready"), targetSourceItemIds: sourceIds,
    scope: sourceIds.length > 1 ? "selected_items" : sources.find((source) => source.id === sourceIds[0])?.hasDocument ? "source_only" : "children_only"
  }));
  const [busy, setBusy] = useState(false);
  const selected = sources.filter((source) => sourceIds.includes(source.id));
  async function queue() {
    setBusy(true);
    try {
      await window.app.ingestion.process({ plan: { ...plan, targetSourceItemIds: sourceIds }, runKind: plan.forceRegeneration ? "reingestion" : "missing_stages", trigger: "library_action" });
      onQueued();
    } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t("library.processingDialog.title")}>
    <div className="motion-scale-in max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-slate-800"><div><h2 className="text-lg font-semibold">{t("library.processingDialog.title")}</h2><p className="mt-1 text-sm text-slate-500">{t("library.processingDialog.description", { values: { count: sourceIds.length } })}</p></div><button type="button" className="grid h-9 w-9 place-items-center rounded-lg" onClick={onClose}><X className="h-4 w-4" /></button></header>
      <div className="grid gap-5 p-5">
        <div className="flex flex-wrap gap-2">{selected.map((source) => <span key={source.id} className="rounded-full bg-slate-100 px-3 py-1 text-xs dark:bg-slate-900">{source.title}</span>)}</div>
        {sourceIds.length === 1 ? <label className="grid gap-2 text-sm font-semibold">{t("library.processingDialog.scope")}<select value={plan.scope} onChange={(event) => setPlan({ ...plan, scope: event.target.value as ProcessingPlanRequest["scope"] })} className="h-10 rounded-lg border border-slate-300 bg-white px-3 font-normal dark:border-slate-700 dark:bg-slate-950"><option value="source_only">{t("library.scopes.source_only")}</option><option value="children_only">{t("library.scopes.children_only")}</option><option value="source_and_children">{t("library.scopes.source_and_children")}</option></select></label> : null}
        <ProcessingPlanPicker value={plan} onChange={(next) => setPlan({ ...next, targetSourceItemIds: sourceIds, scope: sourceIds.length > 1 ? "selected_items" : next.scope })} t={t} />
        <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-amber-600" checked={plan.forceRegeneration} onChange={(event) => setPlan({ ...plan, forceRegeneration: event.target.checked, previousArtifactPolicy: event.target.checked ? "preserve_reviewed_archive_pending" : "reuse_valid" })} /><span><span className="block font-semibold">{t("library.processingDialog.regenerate")}</span><span className="text-xs text-slate-600 dark:text-slate-400">{t("library.processingDialog.regenerateHint")}</span></span></label>
      </div>
      <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white/95 p-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"><Button type="button" onClick={onClose}>{t("shell.actions.cancel")}</Button><Button type="button" disabled={busy} onClick={() => void queue()}><Play className="h-4 w-4" />{t("library.actions.queueProcessing")}</Button></footer>
    </div>
  </div>;
}

function structurePositionComparator(sources: LibrarySource[]) {
  const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
  return (left: LibrarySource, right: LibrarySource) => {
    if (left.structurePosition !== null && right.structurePosition !== null) {
      const positionDifference = left.structurePosition - right.structurePosition;
      if (positionDifference !== 0) return positionDifference;
    } else if (left.structurePosition !== null) return -1;
    else if (right.structurePosition !== null) return 1;
    return (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0);
  };
}

export function childrenOf(sources: LibrarySource[], parentId: string): LibrarySource[] {
  return sources
    .filter((source) => source.parentSourceItemId === parentId)
    .toSorted(structurePositionComparator(sources));
}

export function breadcrumbChain(sources: LibrarySource[], id: string): LibrarySource[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const chain: LibrarySource[] = [];
  let current = byId.get(id) ?? null;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    current = current.parentSourceItemId ? byId.get(current.parentSourceItemId) ?? null : null;
  }
  return chain;
}

export function orderHierarchically(sources: LibrarySource[]): Array<{ source: LibrarySource; depth: number }> {
  const ids = new Set(sources.map((source) => source.id));
  const byParent = new Map<string | null, LibrarySource[]>();
  for (const source of sources) {
    const parent = source.parentSourceItemId && ids.has(source.parentSourceItemId) ? source.parentSourceItemId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), source]);
  }
  const compareStructurePosition = structurePositionComparator(sources);
  for (const [parentId, siblings] of byParent) {
    if (parentId === null) continue;
    siblings.sort(compareStructurePosition);
  }
  const result: Array<{ source: LibrarySource; depth: number }> = [];
  const seen = new Set<string>();
  function visit(source: LibrarySource, depth: number) {
    if (seen.has(source.id)) return;
    seen.add(source.id); result.push({ source, depth });
    for (const child of byParent.get(source.id) ?? []) visit(child, depth + 1);
  }
  const roots = byParent.get(null) ?? [];
  const visitedDetachedParents = new Set<string>();
  for (const root of roots) {
    const detachedParentId = root.parentSourceItemId && !ids.has(root.parentSourceItemId)
      ? root.parentSourceItemId
      : null;
    if (!detachedParentId) visit(root, 0);
    else if (!visitedDetachedParents.has(detachedParentId)) {
      visitedDetachedParents.add(detachedParentId);
      for (const sibling of roots.filter((candidate) => candidate.parentSourceItemId === detachedParentId)
        .toSorted(compareStructurePosition)) visit(sibling, 0);
    }
  }
  for (const source of sources) visit(source, 0);
  return result;
}

function SourceDetailView({ detail, allSources, backLabel, t, onOpen, onOpenPath, onGoToLibrary, onBack, onProcess, onDeleted }: {
  detail: SourceDetail;
  allSources: LibrarySource[];
  backLabel: string;
  t: Translator;
  onOpen: (id: string) => void;
  onOpenPath: (ids: string[]) => void;
  onGoToLibrary: () => void;
  onBack: () => void;
  onProcess: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const chain = breadcrumbChain(allSources, detail.id);
  const subitems = childrenOf(allSources, detail.id);
  const chunkCount = detail.documents.reduce((total, document) => total + document.chunks.length, 0);
  const coverAssetId = detail.assets.find((asset) => asset.role === "cover")?.id
    ?? coverAssetIdFromMetadata(detail.metadata);
  const Icon = typeIcons[detail.type];

  async function deleteSource() {
    if (!window.confirm(t("library.delete.confirmation", { values: { title: detail.title } }))) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      const result = await window.app.knowledge.deleteSource(detail.id);
      if (result.failedFiles > 0 || result.graphCleanupFailed) {
        window.alert(t("library.delete.completedWithWarnings"));
      }
      onDeleted();
    } catch {
      setDeleteFailed(true);
      setDeleting(false);
    }
  }

  return <section className="motion-fade-in-up grid gap-4">
    <nav className="flex flex-wrap items-center gap-1 text-sm text-slate-500" aria-label={t("shell.navigation.library")}>
      <button type="button" className="rounded-md px-1.5 py-0.5 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-900 dark:hover:text-slate-100" onClick={onGoToLibrary}>
        {t("shell.navigation.library")}
      </button>
      {chain.map((ancestor, index) => <span key={ancestor.id} className="inline-flex items-center gap-1">
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        {index === chain.length - 1
          ? <span className="max-w-64 truncate font-medium text-slate-900 dark:text-slate-100">{ancestor.title}</span>
          : <button type="button" className="max-w-56 truncate rounded-md px-1.5 py-0.5 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-900 dark:hover:text-slate-100"
              onClick={() => onOpenPath(chain.slice(0, index + 1).map((item) => item.id))}>
              {ancestor.title}
            </button>}
      </span>)}
    </nav>

    <header className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <div className="grid h-36 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
          <CoverImage
            assetId={coverAssetId}
            alt={detail.title}
            fallback={<Icon className="h-10 w-10 text-slate-400" aria-hidden="true" />}
          />
        </div>
        <div className="min-w-0">
          <h2 className="text-xl font-semibold leading-tight">{detail.title}</h2>
          {detail.subtitle ? <p className="mt-1 text-sm text-slate-500">{detail.subtitle}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SourceTypeBadge type={detail.type} t={t} />
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide dark:bg-slate-800">{detail.language}</span>
            {detail.sourceUri ? <a href={detail.sourceUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-cyan-700 hover:underline dark:text-cyan-300">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{t("library.openOriginal")}
            </a> : null}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" disabled={deleting} onClick={onProcess}>
          <Play className="h-4 w-4" aria-hidden="true" />{t("library.actions.process")}
        </Button>
        <Button type="button" disabled={deleting} className="border-rose-700 bg-rose-700 hover:bg-rose-600 dark:border-rose-800 dark:bg-rose-800 dark:hover:bg-rose-700" onClick={() => void deleteSource()}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />{deleting ? t("library.delete.deleting") : t("library.delete.action")}
        </Button>
        <Button type="button" disabled={deleting} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />{backLabel}
        </Button>
      </div>
    </header>

    {deleteFailed ? <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">{t("library.delete.failed")}</p> : null}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile icon={FileText} label={t("library.detail.stats.documents")} value={detail.documents.length} tone="cyan" />
      <StatTile icon={Layers} label={t("library.detail.stats.chunks")} value={chunkCount} tone="emerald" />
      <StatTile icon={NotebookPen} label={t("library.detail.stats.notes")} value={detail.atomicNotes.length} tone="violet" />
      <StatTile icon={Globe} label={t("library.detail.stats.relations")} value={detail.relations.length} tone="amber" />
    </div>

    {subitems.length > 0 ? <CollapsibleSection title={t("library.detail.subitems")} count={subitems.length} defaultOpen>
      <ol className="grid gap-2 sm:grid-cols-2">
        {subitems.map((subitem) => {
          const SubIcon = typeIcons[subitem.type];
          return <li key={subitem.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-cyan-400 hover:bg-white dark:border-slate-800 dark:bg-slate-950 dark:hover:border-cyan-700 dark:hover:bg-slate-900"
              onClick={() => onOpen(subitem.id)}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-900">
                <SubIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{subitem.title}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {t(`import.sourceTypes.${subitem.type}` as MessageKey)}
                  {subitem.childCount > 0 ? ` · ${t("library.childCount", { values: { count: subitem.childCount } })}` : ""}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          </li>;
        })}
      </ol>
    </CollapsibleSection> : null}

    <CollapsibleSection title={t("library.sections.summary")} defaultOpen>
      <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{detail.summary ?? t("library.noSummary")}</p>
    </CollapsibleSection>

    {detail.documents.length === 0 && subitems.length === 0 ? <StateCard>{t("library.containerHint")}</StateCard> : null}

    {detail.documents.map((document) => <div key={document.id} className="grid gap-3">
      <CollapsibleSection title={t("library.sections.document")}>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">{document.canonicalMarkdown}</pre>
        {document.assets.length > 0 ? <div className="mt-3 grid gap-2">
          <h4 className="text-sm font-semibold">{t("library.sections.originals")}</h4>
          <ul className="grid gap-1 text-sm">{document.assets.map((asset) => <li key={asset.id}>
            <button type="button" className="inline-flex items-center gap-2 text-cyan-700 hover:underline dark:text-cyan-300" onClick={() => void window.app.knowledge.openAsset(asset.id)}>
              <FileText className="h-4 w-4" aria-hidden="true" />{asset.originalFileName}
              <span className="sr-only">{t("library.openFile")}</span>
            </button>
          </li>)}</ul>
        </div> : null}
      </CollapsibleSection>
      <CollapsibleSection title={t("library.sections.chunks")} count={document.chunks.length}>
        <ol className="grid gap-2">{document.chunks.map((chunk) => <li key={chunk.id} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
          <p className="mb-1 text-xs text-slate-500">{t("library.chunk", { values: { index: chunk.chunkIndex + 1 } })}</p>
          <p className="whitespace-pre-wrap">{chunk.content}</p>
        </li>)}</ol>
      </CollapsibleSection>
    </div>)}

    <CollapsibleSection title={t("library.sections.atomicNotes")} count={detail.atomicNotes.length} defaultOpen>
      {detail.atomicNotes.length === 0 ? <StateCard>{t("knowledge.notes.emptyForSource")}</StateCard>
        : <ol className="grid gap-2">{detail.atomicNotes.map((note) => <li key={note.id}><AtomicNoteCard note={note} t={t} /></li>)}</ol>}
    </CollapsibleSection>

    <CollapsibleSection title={t("library.sections.relations")} count={detail.relations.length} defaultOpen>
      {detail.relations.length === 0 ? <StateCard>{t("knowledge.relations.empty")}</StateCard>
        : <ol className="grid gap-2">{detail.relations.map((relation) => <li key={relation.id} className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm font-medium">{relation.sourceTitle} ↔ {relation.targetTitle}</p>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold tabular-nums dark:bg-slate-800">{Math.round(relation.finalScore * 100)}%</span>
          </div>
          <p className="text-sm">{t(relationTypeKey(relation.relationType))}</p>
          <p className="text-sm text-slate-600 dark:text-slate-300">{relation.explanation.startsWith("knowledge.") ? t(relation.explanation as MessageKey) : relation.explanation}</p>
          {relation.sourceStatus === "pending_review" || relation.targetStatus === "pending_review" ? <span className="w-fit rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">{t("knowledge.relations.pendingInvolved")}</span> : null}
        </li>)}</ol>}
    </CollapsibleSection>

    <CollapsibleSection title={t("library.detail.rawMetadata")}>
      <pre className="overflow-auto whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">{JSON.stringify(detail.metadata, null, 2)}</pre>
      {detail.assets.filter((asset) => asset.role === "cover").map((asset) => <button key={asset.id} type="button" className="mt-2 inline-flex w-fit items-center gap-2 text-sm text-cyan-700 hover:underline dark:text-cyan-300" onClick={() => void window.app.knowledge.openAsset(asset.id)}>
        <FileText className="h-4 w-4" aria-hidden="true" />{asset.originalFileName}
      </button>)}
    </CollapsibleSection>
  </section>;
}

function AtomicNoteCard({ note, t }: { note: SourceDetail["atomicNotes"][number]; t: Translator }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="min-w-0">
          <span className="block font-semibold">{note.title}</span>
          <span className="mt-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{note.ideaStatement}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-slate-200 px-2 py-1 text-xs dark:bg-slate-800">{t(noteStatusKey(note.status))}</span>
          <ChevronDown className={cn("h-4 w-4 text-slate-400 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </span>
      </button>
      <div className={cn("section-collapse", expanded && "section-collapse-open")}>
        <div>
          <p className="whitespace-pre-wrap px-4 pb-4 text-sm text-slate-600 dark:text-slate-300">{note.bodyMarkdown}</p>
        </div>
      </div>
    </article>
  );
}

function CollapsibleSection({ title, count, defaultOpen = false, children }: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-950/40"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-2 font-semibold">
          {title}
          {count !== undefined ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">{count}</span> : null}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      <div className={cn("section-collapse", open && "section-collapse-open")}>
        <div>
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

function StatTile({ icon: Icon, label, value, tone }: {
  icon: typeof FileText;
  label: string;
  value: number;
  tone: "cyan" | "emerald" | "violet" | "amber";
}) {
  const tones = {
    cyan: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    violet: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg", tones[tone])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-slate-500">{label}</span>
        <span className="mt-0.5 block text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</span>
      </span>
    </div>
  );
}

function StateCard({ children }: { children: string }) {
  return <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{children}</p>;
}

function currentHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === "object" ? state as Record<string, unknown> : {};
}

function pushLibraryHistory(entry: LibraryHistoryEntry) {
  window.history.pushState({ ...currentHistoryState(), ...createLibraryHistoryState(entry) }, "");
}

function replaceLibraryHistory(entry: LibraryHistoryEntry) {
  window.history.replaceState({ ...currentHistoryState(), ...createLibraryHistoryState(entry) }, "");
}

function processingKey(status: string): MessageKey {
  return (`library.processing.${status}` as MessageKey);
}

function stageKey(stage: string): MessageKey {
  const normalized = ({
    atomicNotes: "atomicNotes",
    knowledgeGraph: "knowledgeGraph",
    atomicNoteMatching: "atomicNoteMatching"
  } as Record<string, string>)[stage] ?? stage;
  return (`jobs.stages.${normalized}` as MessageKey);
}

function noteStatusKey(status: string): MessageKey {
  return (`knowledge.notes.status.${status}` as MessageKey);
}

function relationTypeKey(type: string): MessageKey {
  return (`knowledge.relations.types.${type}` as MessageKey);
}
