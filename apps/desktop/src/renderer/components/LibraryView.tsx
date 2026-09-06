import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Search, Pencil, Plus, List, LayoutGrid,
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
  Sparkles,
  StickyNote,
  Trash2,
  X
} from "lucide-react";
import { SourceItemTypes, type ProcessingPlanRequest, type SourceItemType } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { LibrarySource, SearchResult, SourceDetail } from "../../shared/ipc";
import { cn } from "../lib/cn";
import { coverAssetIdFromMetadata } from "../lib/cover-cache";
import { ImportView, childSourceType } from "./ImportView";
import { Tabs } from "./ui/tabs";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { CoverImage } from "./ui/cover-image";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";
import { MarkdownPreview } from "./MarkdownEditor";
import { SearchResultCard, searchResultId } from "./SearchView";

export interface LibraryExternalTarget {
  sourceItemId: string;
  atomicNoteId?: string;
  origin?: "search" | "knowledgeGraph";
  token: number;
}

export type LibraryHistoryEntry =
  | { view: "library"; path: string[]; fromSearch: boolean }
  | { view: "search" }
  | { view: "knowledgeGraph" };

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
  if (entry.view === "knowledgeGraph") return { view: "knowledgeGraph" };
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

export function expandedCardScrollBlock(
  card: { top: number; bottom: number; height: number },
  viewport: { top: number; bottom: number; height: number },
  margin = 8
): ScrollLogicalPosition | null {
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  if (card.top >= viewport.top + margin && card.bottom <= viewport.bottom - margin) return null;
  return card.height <= availableHeight ? "nearest" : "start";
}

function useExpandedCardViewport(expanded: boolean) {
  const cardRef = useRef<HTMLElement | null>(null);
  const wasExpanded = useRef(expanded);

  useEffect(() => {
    const hasJustExpanded = expanded && !wasExpanded.current;
    wasExpanded.current = expanded;
    if (!hasJustExpanded) return;
    const timer = window.setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      const cardRect = card.getBoundingClientRect();
      const scrollViewport = closestVerticalScrollViewport(card);
      const viewportRect = scrollViewport?.getBoundingClientRect() ?? {
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight
      };
      const block = expandedCardScrollBlock(cardRect, viewportRect);
      if (block) card.scrollIntoView({ behavior: "smooth", block, inline: "nearest" });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  return cardRef;
}

function closestVerticalScrollViewport(element: HTMLElement): HTMLElement | null {
  let candidate = element.parentElement;
  while (candidate) {
    const overflowY = window.getComputedStyle(candidate).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll")
        && candidate.scrollHeight > candidate.clientHeight) return candidate;
    candidate = candidate.parentElement;
  }
  return null;
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

export function LibraryView({ t, metadataEnrichmentEnabled = true, externalTarget = null, onNavigate, onExitToSearch, onExitToKnowledgeGraph }: {
  t: Translator;
  metadataEnrichmentEnabled?: boolean;
  externalTarget?: LibraryExternalTarget | null;
  onNavigate?: () => void;
  onExitToSearch?: () => void;
  onExitToKnowledgeGraph?: () => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [graphResults, setGraphResults] = useState<SearchResult[]>([]);
  const [stack, setStack] = useState<string[]>([]);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [fromSearch, setFromSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [layout, setLayout] = useState<"grid" | "list">("list");
  const loadGeneration = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState<SourceItemType | "all">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [processingIds, setProcessingIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const consumedTargetToken = useRef<number | null>(null);
  const historyInitialized = useRef(false);
  const onNavigateRef = useRef(onNavigate);
  const onExitToSearchRef = useRef(onExitToSearch);
  const onExitToKnowledgeGraphRef = useRef(onExitToKnowledgeGraph);

  onNavigateRef.current = onNavigate;
  onExitToSearchRef.current = onExitToSearch;
  onExitToKnowledgeGraphRef.current = onExitToKnowledgeGraph;

  const currentId = stack.at(-1) ?? null;

  async function load() {
    const generation = ++loadGeneration.current;
    setLoading(true); setError(false);
    try {
      const sourceTypes = currentId || filter === "all" ? [] : [filter];
      const [result, graphResult] = await Promise.all([
        window.app.knowledge.browseLibrary({ offset, limit: 48,
          sourceTypes, query: currentId ? "" : query,
          ...(currentId ? { parentId: currentId } : !query.trim() && filter === "all" ? { parentId: null } : {}) }),
        query.trim() && !currentId
          ? window.app.search.query({ text: query, sourceTypes, mode: "text", limit: 24 })
              .then((items) => items.filter((item) => item.kind === "entity" || item.kind === "relation"))
              .catch(() => [] as SearchResult[])
          : Promise.resolve([] as SearchResult[])
      ]);
      if (generation === loadGeneration.current) {
        setSources(result);
        setGraphResults(graphResult);
      }
    } catch { if (generation === loadGeneration.current) setError(true); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => { window.clearTimeout(timer); loadGeneration.current++; };
  }, [query, filter, offset, currentId, refreshKey]);

  useEffect(() => {
    if (!historyInitialized.current) {
      replaceLibraryHistory(externalTarget
        ? { view: externalTarget.origin ?? "search" }
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
      if (entry?.view === "knowledgeGraph") {
        setStack([]);
        setFromSearch(false);
        onExitToKnowledgeGraphRef.current?.();
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
    const cameFromSearch = externalTarget.origin !== "knowledgeGraph";
    pushLibraryHistory({ view: "library", path: [externalTarget.sourceItemId], fromSearch: cameFromSearch });
    onNavigate?.();
    setFromSearch(cameFromSearch);
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
  }, [currentId, refreshKey]);

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
    setOffset(0);
    setSelectedIds(new Set());
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
          key={`${detail.id}:${externalTarget?.token ?? 0}`}
          detail={detail}
          focusedAtomicNoteId={externalTarget?.sourceItemId === detail.id ? externalTarget.atomicNoteId ?? null : null}
          metadataEnrichmentEnabled={metadataEnrichmentEnabled}
          allSources={sources}
          backLabel={stack.length === 1 && externalTarget?.origin === "knowledgeGraph"
            ? t("knowledgeGraph.backToGraph")
            : stack.length === 1 && fromSearch ? t("library.detail.backToSearch") : t("library.back")}
          t={t}
          onOpen={openSource}
          onOpenPath={openPath}
          onGoToLibrary={goToLibrary}
          onBack={goBack}
          onProcess={(ids) => setProcessingIds(ids ?? [currentId])}
          onRefresh={() => setRefreshKey((key) => key + 1)}
          onPage={(next) => setOffset(next)} offset={offset} loading={loading} loadError={error}
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
          sources={detail ? [...sources, detailAsLibrarySource(detail)] : sources}
          t={t}
          onClose={() => setProcessingIds(null)}
          onQueued={() => { setProcessingIds(null); setSelectedIds(new Set()); void load(); }}
        />
      ) : null}
    </>;
  }

  const gridSources = sources;

  return <section className="grid gap-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <label className="grid min-w-64 flex-1 gap-1 text-sm font-medium">{t("sourceWorkspace.search")}<div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden="true" /><Input className="pl-9" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); setSelectedIds(new Set()); }} placeholder={t("sourceWorkspace.searchHint")} /></div></label>
      <label className="grid gap-1 text-sm font-medium">
        {t("library.filterByType")}
        <select value={filter} onChange={(event) => { setFilter(event.target.value as SourceItemType | "all"); setOffset(0); setSelectedIds(new Set()); }}
          className="h-9 min-w-52 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          <option value="all">{t("library.allTypes")}</option>
          {SourceItemTypes.map((type) => <option key={type} value={type}>{t(`import.sourceTypes.${type}` as MessageKey)}</option>)}
        </select>
      </label>
      <Button type="button" aria-label={t(layout === "grid" ? "sourceWorkspace.list" : "sourceWorkspace.grid")} onClick={() => setLayout(layout === "grid" ? "list" : "grid")}>{layout === "grid" ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}</Button>
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
      : sources.length === 0 && graphResults.length === 0 ? <StateCard>{t("library.empty")}</StateCard>
        : sources.length > 0 ? <ol className={cn("grid gap-3", layout === "grid" && "sm:grid-cols-2 xl:grid-cols-3")}>
          {gridSources.map((source) => <li key={source.id} className="motion-fade-in-up">
            <SourceCard
              source={source}
              compact={layout === "list"}
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
        </ol> : null}
    {!loading && graphResults.length > 0 ? <section className="grid gap-2">
      <h2 className="text-sm font-semibold">{t("search.graphResults")}</h2>
      <ol className="grid gap-3">
        {graphResults.map((result) => <li key={searchResultId(result)} className="motion-fade-in-up">
          <SearchResultCard result={result} t={t} onOpen={() => navigateToPath([result.sourceItemId], false)} />
        </li>)}
      </ol>
    </section> : null}
    <PageControls offset={offset} count={sources.length} busy={loading} t={t} onPage={setOffset} />
    {processingIds ? <ProcessingDialog sourceIds={processingIds} sources={sources} t={t} onClose={() => setProcessingIds(null)} onQueued={() => { setProcessingIds(null); setSelectedIds(new Set()); void load(); }} /> : null}
  </section>;
}

function SourceCard({ source, t, compact = false, selected, onToggleSelect, onOpen, onProcess }: {
  source: LibrarySource;
  compact?: boolean;
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
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-slate-900",
        source.matchKind === "embedding"
          ? "border-violet-400 ring-2 ring-violet-200/60 hover:border-violet-500 dark:border-violet-700 dark:ring-violet-950"
          : "border-slate-200 hover:border-cyan-400 dark:border-slate-800 dark:hover:border-cyan-700"
      )}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}
    >
      <div className={cn("flex gap-4", compact ? "p-3" : "p-4")}>
        <div className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950", compact ? "h-12 w-9" : "h-28 w-20")}>
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
            {source.matchKind ? <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold",
              source.matchKind === "embedding"
                ? "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200"
                : source.matchKind === "combined"
                  ? "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200"
                  : "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200"
            )}><Sparkles className="h-3 w-3" aria-hidden="true" />{t(`library.searchMatches.${source.matchKind}` as MessageKey)} · {Math.round(Math.max(source.textScore ?? 0, source.embeddingScore ?? 0) * 100)}%</span> : null}
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium dark:bg-slate-800">
              {source.metadata.summaryStale === true ? t("sourceWorkspace.outdated") : source.hasDocument ? t(processingKey(source.processingStatus)) : t("library.container")}
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
      {source.parentSourceItemId ? <p className="px-4 pb-2 text-xs text-slate-500">{source.parentTitle
        ? t("library.parentSource", { values: { title: source.parentTitle } })
        : t("sourceWorkspace.subsource")}</p> : null}
      {!compact && source.summary ? <p className="line-clamp-2 px-4 pb-3 text-sm text-slate-600 dark:text-slate-300">{source.summary}</p> : null}
      <footer className={cn("mt-auto flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800", compact && "hidden")}>
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
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const selected = sources.filter((source) => sourceIds.includes(source.id));
  async function queue() {
    setBusy(true);
    try {
      await window.app.ingestion.process({ plan: { ...plan, targetSourceItemIds: sourceIds }, runKind: plan.forceRegeneration ? "reingestion" : "missing_stages", trigger: "library_action" });
      onQueued();
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} className="fixed inset-0 z-50 m-0 grid h-screen max-h-none w-screen max-w-none place-items-center bg-slate-950/55 p-4 text-slate-950 backdrop-blur-sm dark:text-white" aria-modal="true" aria-label={t("library.processingDialog.title")}>
    <div className="motion-scale-in max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-slate-800"><div><h2 className="text-lg font-semibold">{t("library.processingDialog.title")}</h2><p className="mt-1 text-sm text-slate-500">{t("library.processingDialog.description", { values: { count: sourceIds.length } })}</p></div><button type="button" className="grid h-9 w-9 place-items-center rounded-lg" aria-label={t("shell.actions.close")} disabled={busy} onClick={onClose}><X className="h-4 w-4" /></button></header>
      <div className="grid gap-5 p-5">
        {failed ? <p role="alert">{t("library.error")}</p> : null}
        <div className="flex flex-wrap gap-2">{selected.map((source) => <span key={source.id} className="rounded-full bg-slate-100 px-3 py-1 text-xs dark:bg-slate-900">{source.title}</span>)}</div>
        {sourceIds.length === 1 ? <label className="grid gap-2 text-sm font-semibold">{t("library.processingDialog.scope")}<select value={plan.scope} onChange={(event) => setPlan({ ...plan, scope: event.target.value as ProcessingPlanRequest["scope"] })} className="h-10 rounded-lg border border-slate-300 bg-white px-3 font-normal dark:border-slate-700 dark:bg-slate-950"><option value="source_only">{t("library.scopes.source_only")}</option><option value="children_only">{t("library.scopes.children_only")}</option><option value="source_and_children">{t("library.scopes.source_and_children")}</option></select></label> : null}
        <ProcessingPlanPicker value={plan} onChange={(next) => setPlan({ ...next, targetSourceItemIds: sourceIds, scope: sourceIds.length > 1 ? "selected_items" : plan.scope })} t={t} />
        <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-amber-600" checked={plan.forceRegeneration} onChange={(event) => setPlan({ ...plan, forceRegeneration: event.target.checked, previousArtifactPolicy: event.target.checked ? "preserve_reviewed_archive_pending" : "reuse_valid" })} /><span><span className="block font-semibold">{t("library.processingDialog.regenerate")}</span><span className="text-xs text-slate-600 dark:text-slate-400">{t("library.processingDialog.regenerateHint")}</span></span></label>
      </div>
      <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white/95 p-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"><Button type="button" disabled={busy} onClick={onClose}>{t("shell.actions.cancel")}</Button><Button type="button" disabled={busy} onClick={() => void queue()}><Play className="h-4 w-4" />{t("library.actions.queueProcessing")}</Button></footer>
    </div>
  </dialog>;
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

function SourceDetailView({ detail, focusedAtomicNoteId, allSources, backLabel, t, onOpen, onOpenPath, onGoToLibrary, onBack, onProcess, onDeleted, onRefresh, onPage, offset, loading, loadError, metadataEnrichmentEnabled }: {
  detail: SourceDetail;
  focusedAtomicNoteId: string | null;
  metadataEnrichmentEnabled: boolean;
  allSources: LibrarySource[];
  backLabel: string;
  t: Translator;
  onOpen: (id: string) => void;
  onOpenPath: (ids: string[]) => void;
  onGoToLibrary: () => void;
  onBack: () => void;
  onProcess: (ids?: string[]) => void;
  onRefresh: () => void; onPage: (offset: number) => void; offset: number; loading: boolean; loadError: boolean;
  onDeleted: () => void;
}) {
  const [historical, setHistorical] = useState<{ title: string; markdown: string } | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tab, setTab] = useState(focusedAtomicNoteId ? "notes" : "overview");
  const [editor, setEditor] = useState<"edit" | "child" | null>(null);
  const [selectedChildren, setSelectedChildren] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const chain = detail.breadcrumbs.length ? detail.breadcrumbs : breadcrumbChain(allSources, detail.id);
  const subitems = childrenOf(allSources, detail.id);
  const chunkCount = detail.documents.reduce((total, document) => total + document.chunks.length, 0);
  const graphRelations = groupGraphRelations(detail.graph.relations);
  const graphEntities = groupGraphEntities(detail.graph.entities);
  const relatedSourceGroups = groupRelatedSources(detail.graph.sourceConnections);
  const coverAssetId = coverAssetIdFromMetadata(detail.metadata)
    ?? detail.assets.find((asset) => asset.role === "cover")?.id ?? null;
  const Icon = typeIcons[detail.type];

  useEffect(() => {
    if (!focusedAtomicNoteId) return;
    setTab("notes");
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(`atomic-note-${focusedAtomicNoteId}`);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedAtomicNoteId]);

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

  if (editor) return <ImportView t={t} metadataEnrichmentEnabled={metadataEnrichmentEnabled} {...(editor === "edit" ? { editing: detail } : { parent: detail })} onCancel={() => setEditor(null)} onSaved={() => { setEditor(null); onRefresh(); }} />;

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

    <header className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
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
      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button type="button" disabled={deleting} onClick={() => setEditor("edit")}><Pencil className="h-4 w-4" />{t("sourceWorkspace.edit")}</Button>
        {childSourceType(detail.type) ? <Button type="button" onClick={() => setEditor("child")}><Plus className="h-4 w-4" />{t("sourceWorkspace.addChild")}</Button> : null}
        <Button type="button" disabled={deleting} onClick={() => onProcess()}>
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

    <Tabs label={detail.title} value={tab} onChange={setTab} items={[
      { id: "overview", label: t("sourceWorkspace.overview") },
      { id: "content", label: t("sourceWorkspace.content") },
      { id: "children", label: t("library.detail.subitems") },
      { id: "notes", label: t("library.sections.atomicNotes"), count: detail.atomicNotes.length },
      { id: "graph", label: t("library.sections.knowledgeGraph"), count: graphEntities.length + graphRelations.length },
      { id: "relations", label: t("library.sections.relations"), count: detail.relations.length },
      { id: "metadata", label: t("import.steps.metadata") },
      { id: "history", label: t("sourceWorkspace.history") }
    ]}>
    {tab === "history" ? <div className="grid gap-3">
      <p className="text-sm text-slate-500">{t("sourceWorkspace.historyHint")}</p>
      <ol className="grid gap-2">{detail.history.map((item) => <li key={item.id}><Button disabled={historyLoading} onClick={() => {
        setHistoryLoading(true); setHistoryError(false);
        window.app.knowledge.getSourceDocument({ sourceItemId: detail.id, documentId: item.id }).then(setHistorical)
          .catch(() => setHistoryError(true)).finally(() => setHistoryLoading(false));
      }}>{item.title} · {new Date(item.createdAt).toLocaleString()}{item.isCurrent ? ` · ${t("sourceWorkspace.current")}` : ""}</Button></li>)}</ol>
      {historyLoading ? <p>{t("shell.states.loading")}</p> : null}
      {historyError ? <p role="alert">{t("library.error")}</p> : null}
      {historical ? <div className="max-h-[60vh] overflow-auto rounded-xl border border-slate-200 p-5 dark:border-slate-800"><MarkdownPreview markdown={historical.markdown} emptyLabel={t("markdown.emptyPreview")} /></div> : null}
      {detail.summaries.map((summary) => <details key={summary.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><summary className="cursor-pointer text-sm">{t("library.sections.summary")} · {new Date(summary.generatedAt).toLocaleString()} · {summary.model}</summary><p className="mt-3 whitespace-pre-wrap text-sm">{summary.summary}</p></details>)}
    </div> : null}
    {tab === "overview" ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile icon={FileText} label={t("library.detail.stats.documents")} value={detail.documents.length} tone="cyan" />
      <StatTile icon={Layers} label={t("library.detail.stats.chunks")} value={chunkCount} tone="emerald" />
      <StatTile icon={NotebookPen} label={t("library.detail.stats.notes")} value={detail.atomicNotes.length} tone="violet" />
      <StatTile icon={Globe} label={t("library.detail.stats.relations")} value={detail.relations.length} tone="amber" />
    </div> : null}

    {tab === "children" ? <div className="grid gap-3">
      {childSourceType(detail.type) ? <Button className="w-fit" onClick={() => setEditor("child")}><Plus className="h-4 w-4" />{t("sourceWorkspace.addChild")}</Button> : null}
      {selectedChildren.length ? <Button className="w-fit" onClick={() => onProcess(selectedChildren)}>{t("library.actions.processSelected")} ({selectedChildren.length})</Button> : null}
      {loading ? <StateCard>{t("shell.states.loading")}</StateCard> : loadError ? <StateCard>{t("library.error")}</StateCard> : !subitems.length ? <StateCard>{t("sourceWorkspace.noChildren")}</StateCard> : null}
      <PageControls offset={offset} count={subitems.length} busy={loading} t={t} onPage={(page) => { setSelectedChildren([]); onPage(page); }} />
    </div> : null}
    {tab === "children" && subitems.length > 0 ? <CollapsibleSection title={t("library.detail.subitems")} count={subitems.length} defaultOpen>
      <ol className="grid gap-2 sm:grid-cols-2">
        {subitems.map((subitem) => {
          const SubIcon = typeIcons[subitem.type];
          return <li key={subitem.id} className="flex items-center gap-2">
            <input type="checkbox" aria-label={t("library.actions.selectSource", { values: { title: subitem.title } })} checked={selectedChildren.includes(subitem.id)} onChange={(event) => setSelectedChildren((ids) => event.target.checked ? [...ids, subitem.id] : ids.filter((id) => id !== subitem.id))} />
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

    {tab === "overview" ? <CollapsibleSection title={t("library.sections.summary")} defaultOpen>
      <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{detail.summary ?? t("library.noSummary")}</p>
      {detail.metadata.summaryStale === true ? <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">{t("sourceWorkspace.stale")}</p> : null}
    </CollapsibleSection> : null}

    {tab === "content" && detail.documents.length === 0 ? <StateCard>{t("library.containerHint")}</StateCard> : null}

    {tab === "content" ? <Button className="w-fit" type="button" onClick={() => setEditor("edit")}><Pencil className="h-4 w-4" />{t("sourceWorkspace.editContent")}</Button> : null}

    {tab === "content" && detail.assets.filter((asset) => asset.role !== "cover").map((asset) => <Button className="w-fit" key={asset.id} onClick={() => void window.app.knowledge.openAsset(asset.id)}>{asset.originalFileName}</Button>)}
    {tab === "content" && detail.documents.map((document) => <div key={document.id} className="grid gap-3">
      <CollapsibleSection title={t("library.sections.document")} defaultOpen>
        <div className="max-h-[32rem] overflow-auto rounded-xl bg-slate-50 p-5 dark:bg-slate-950"><MarkdownPreview markdown={document.canonicalMarkdown} emptyLabel={t("markdown.emptyPreview")} /></div>
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

    {tab === "notes" ? <CollapsibleSection title={t("library.sections.atomicNotes")} count={detail.atomicNotes.length} defaultOpen>
      {detail.atomicNotes.length === 0 ? <StateCard>{t("knowledge.notes.emptyForSource")}</StateCard>
        : <ol className="grid gap-2">{detail.atomicNotes.map((note) => <li key={note.id}><AtomicNoteCard note={note} focused={note.id === focusedAtomicNoteId} t={t} /></li>)}</ol>}
    </CollapsibleSection> : null}

    {tab === "graph" ? <div className="grid gap-4">
      <CollapsibleSection title={t("knowledge.graph.entities")} count={graphEntities.length} defaultOpen>
        {graphEntities.length === 0 ? <StateCard>{t("knowledge.graph.empty")}</StateCard>
          : <ol className="grid gap-2 sm:grid-cols-2">{graphEntities.map((entity) => <li key={entity.id}>
            <GraphEntityCard entity={entity} relations={graphRelations.filter((relation) => relation.subject === entity.name || relation.object === entity.name)} t={t} />
          </li>)}</ol>}
      </CollapsibleSection>
      <CollapsibleSection title={t("knowledge.graph.relatedSources")} count={relatedSourceGroups.length} defaultOpen>
        {relatedSourceGroups.length === 0 ? <StateCard>{t("knowledge.graph.noRelatedSources")}</StateCard>
          : <ol className="grid gap-2">{relatedSourceGroups.map((source) => <li key={source.sourceItemId}>
            <RelatedSourceCard source={source} t={t} onOpen={() => onOpenPath([source.sourceItemId])} />
          </li>)}</ol>}
      </CollapsibleSection>
    </div> : null}

    {tab === "relations" ? <CollapsibleSection title={t("library.sections.relations")} count={detail.relations.length} defaultOpen>
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
    </CollapsibleSection> : null}

    {tab === "metadata" ? <div className="grid gap-4">
      <dl className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-2">
        {metadataEntries(detail.metadata).map(([key, value]) => <div key={key}><dt className="text-xs text-slate-500">{t(`import.metadataFields.${key}` as MessageKey)}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{value}</dd></div>)}
      </dl>
      <CollapsibleSection title={t("library.detail.rawMetadata")}>
      <pre className="overflow-auto whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">{JSON.stringify(detail.metadata, null, 2)}</pre>
      {detail.assets.filter((asset) => asset.role === "cover").map((asset) => <button key={asset.id} type="button" className="mt-2 inline-flex w-fit items-center gap-2 text-sm text-cyan-700 hover:underline dark:text-cyan-300" onClick={() => void window.app.knowledge.openAsset(asset.id)}>
        <FileText className="h-4 w-4" aria-hidden="true" />{asset.originalFileName}
      </button>)}
    </CollapsibleSection></div> : null}
    </Tabs>
  </section>;
}

type SourceGraphEntity = SourceDetail["graph"]["entities"][number];
type SourceGraphRelation = SourceDetail["graph"]["relations"][number];
type SourceGraphConnection = SourceDetail["graph"]["sourceConnections"][number];

interface RelatedSourceGroup {
  sourceItemId: string;
  sourceTitle: string;
  confidence: number;
  connections: SourceGraphConnection[];
}

function GraphEntityCard({ entity, relations, t }: {
  entity: SourceGraphEntity;
  relations: SourceGraphRelation[];
  t: Translator;
}) {
  const [expanded, setExpanded] = useState(false);
  const cardRef = useExpandedCardViewport(expanded);
  return <article ref={cardRef} className="scroll-my-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
    <button type="button" className="flex w-full items-start justify-between gap-3 p-3 text-left" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <strong className="min-w-0 truncate text-sm">{entity.name}</strong>
      <span className="flex shrink-0 items-center gap-2">
        <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{Math.round(entity.confidence * 100)}%</span>
        <ChevronDown className={cn("h-4 w-4 text-slate-400 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </span>
    </button>
    <div className={cn("section-collapse", expanded && "section-collapse-open")}><div><div className="grid gap-2 px-3 pb-3 text-xs text-slate-500 dark:text-slate-400">
      <p>{t(`knowledge.graph.entityTypes.${entity.type}` as MessageKey)}</p>
      {relations.length > 0 ? <ul className="grid gap-1 border-t border-slate-200 pt-2 dark:border-slate-800">{relations.map((relation) => <li key={relation.id}>
        {relation.subject} — {graphPredicateLabel(relation.predicate)} → {relation.object} · {Math.round(relation.confidence * 100)}%
      </li>)}</ul> : <p>{t("knowledge.graph.noEntityRelations")}</p>}
    </div></div></div>
  </article>;
}

function RelatedSourceCard({ source, t, onOpen }: {
  source: RelatedSourceGroup;
  t: Translator;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cardRef = useExpandedCardViewport(expanded);
  return <article ref={cardRef} className="scroll-my-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
    <div className="flex items-center justify-between gap-3 p-3">
      <button type="button" className="min-w-0 truncate text-left text-sm font-semibold hover:text-cyan-700 hover:underline dark:hover:text-cyan-300" title={t("knowledge.graph.openRelatedSource")} onClick={onOpen}>{source.sourceTitle}</button>
      <span className="flex shrink-0 items-center gap-2">
        <span className="rounded-full bg-cyan-100 px-2 py-1 text-xs font-semibold text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200">{Math.round(source.confidence * 100)}%</span>
        <button type="button" className="grid h-7 w-7 place-items-center rounded-md hover:bg-slate-200 dark:hover:bg-slate-800" aria-expanded={expanded} aria-label={t(expanded ? "knowledge.graph.collapseDetails" : "knowledge.graph.expandDetails")} onClick={() => setExpanded((current) => !current)}>
          <ChevronDown className={cn("h-4 w-4 text-slate-400 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      </span>
    </div>
    <div className={cn("section-collapse", expanded && "section-collapse-open")}><div><ul className="grid gap-1 border-t border-slate-200 px-3 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {source.connections.map((connection, index) => <li key={`${connection.entityName}:${connection.predicate}:${connection.relatedEntityName}:${index}`}>
        {connection.predicate === "shared_entity"
          ? t("knowledge.graph.sharedEntity", { values: { entity: connection.entityName } })
          : `${connection.entityName} — ${graphPredicateLabel(connection.predicate)} → ${connection.relatedEntityName}`} · {Math.round(connection.confidence * 100)}%
      </li>)}
    </ul></div></div>
  </article>;
}

export function groupGraphEntities(entities: SourceGraphEntity[]): SourceGraphEntity[] {
  const grouped = new Map<string, SourceGraphEntity>();
  for (const entity of entities) {
    const key = `${entity.type}\0${entity.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()}`;
    const current = grouped.get(key);
    if (!current || entity.confidence > current.confidence) grouped.set(key, entity);
  }
  return [...grouped.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export function groupGraphRelations(relations: SourceGraphRelation[]): SourceGraphRelation[] {
  const grouped = new Map<string, SourceGraphRelation>();
  for (const relation of relations) {
    const key = `${relation.subject}\0${relation.predicate}\0${relation.object}`.toLocaleLowerCase();
    const current = grouped.get(key);
    if (!current || relation.confidence > current.confidence) grouped.set(key, relation);
  }
  return [...grouped.values()].toSorted((left, right) => left.subject.localeCompare(right.subject)
    || left.predicate.localeCompare(right.predicate) || left.object.localeCompare(right.object));
}

export function groupRelatedSources(connections: SourceGraphConnection[]): RelatedSourceGroup[] {
  const grouped = new Map<string, RelatedSourceGroup>();
  for (const connection of connections) {
    const current = grouped.get(connection.sourceItemId) ?? {
      sourceItemId: connection.sourceItemId,
      sourceTitle: connection.sourceTitle,
      confidence: 0,
      connections: []
    };
    const key = `${connection.entityName}\0${connection.predicate}\0${connection.relatedEntityName}`.toLocaleLowerCase();
    const existingIndex = current.connections.findIndex((candidate) =>
      `${candidate.entityName}\0${candidate.predicate}\0${candidate.relatedEntityName}`.toLocaleLowerCase() === key
    );
    if (existingIndex < 0) current.connections.push(connection);
    else if (connection.confidence > (current.connections[existingIndex]?.confidence ?? 0)) current.connections[existingIndex] = connection;
    current.confidence = Math.max(current.confidence, connection.confidence);
    grouped.set(connection.sourceItemId, current);
  }
  return [...grouped.values()].map((source) => ({
    ...source,
    connections: source.connections.toSorted((left, right) => left.entityName.localeCompare(right.entityName)
      || left.predicate.localeCompare(right.predicate) || left.relatedEntityName.localeCompare(right.relatedEntityName))
  })).toSorted((left, right) => left.sourceTitle.localeCompare(right.sourceTitle));
}

function AtomicNoteCard({ note, focused = false, t }: { note: SourceDetail["atomicNotes"][number]; focused?: boolean; t: Translator }) {
  const [expanded, setExpanded] = useState(focused);
  const cardRef = useExpandedCardViewport(expanded);
  return (
    <article ref={cardRef} id={`atomic-note-${note.id}`} tabIndex={-1} className={cn(
      "scroll-my-4",
      "rounded-xl border bg-slate-50 outline-none transition dark:bg-slate-950",
      focused ? "border-violet-400 ring-2 ring-violet-300/50 dark:border-violet-500 dark:ring-violet-800/60" : "border-slate-200 dark:border-slate-800"
    )}>
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
  const sectionRef = useExpandedCardViewport(open);
  return (
    <section ref={sectionRef} className="scroll-my-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
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

function graphPredicateLabel(predicate: string): string {
  return predicate.replaceAll("_", " ");
}

function PageControls({ offset, count, busy, t, onPage }: { offset: number; count: number; busy: boolean; t: Translator; onPage: (offset: number) => void }) {
  return <nav aria-label={t("sourceWorkspace.pages")} className="flex items-center justify-end gap-3 text-sm">
    <span className="tabular-nums text-slate-500">{offset + (count ? 1 : 0)}–{offset + count}</span>
    <Button disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - 48))}>{t("sourceWorkspace.previous")}</Button>
    <Button disabled={busy || count < 48} onClick={() => onPage(offset + 48)}>{t("sourceWorkspace.next")}</Button>
  </nav>;
}

function detailAsLibrarySource(detail: SourceDetail): LibrarySource {
  return { ...detail, parentTitle: null, structurePosition: null, childCount: 0, hasDocument: detail.documents.length > 0,
    processingStatus: "pending", currentStage: "queued", textScore: null, embeddingScore: null,
    rankingScore: null, matchKind: null };
}

function metadataEntries(metadata: Record<string, unknown>): Array<[string, string]> {
  const descriptor = metadata.descriptor;
  if (!descriptor || typeof descriptor !== "object") return [];
  const values = descriptor as Record<string, unknown>;
  return ["title", "subtitle", "creators", "language", "publicationDate", "publisher", "edition", "isbn10", "isbn13", "doi", "issn", "venue", "year", "series", "volume", "issue", "chapterNumber", "sectionNumber", "pageCount", "url", "siteName", "platform", "channel", "durationSeconds", "tags", "subjects", "keywords", "abstract", "description"].flatMap((key): Array<[string, string]> => {
    const value = values[key];
    if (value === undefined || value === null || value === "") return [];
    const formatted = Array.isArray(value) ? value.map((item) => typeof item === "object" && item && "name" in item ? String(item.name) : String(item)).join(", ") : String(value);
    return formatted ? [[key, formatted]] : [];
  });
}
