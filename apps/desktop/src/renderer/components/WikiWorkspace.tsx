import {KnowledgeInterpretations} from "./KnowledgeInterpretations";
import { WikiChildrenLinks } from './WikiChildrenLinks';
import { subscribeWindowNavigation } from '../lib/window-navigation';
import { WikiContextPane } from './WikiContextPane';
import { WikiNavigationPane } from "./WikiNavigationPane";
import { AutomaticWikiDialog } from './AutomaticWikiDialog';
import { WikiThemeTree } from './WikiThemeTree';
import { WikiTypedLink } from './WikiTypedLink';
import { createWikiPageRequests } from "./wiki-page-requests";
import type { ObsidianDeepLink } from "../../shared/obsidian-deep-link.js";
import { ConsultationDialog } from "./ConsultationDialog";
import { OrganizationDialog } from "./OrganizationView";
import { SourceTypeBadge } from "./LibraryView";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowDown, ArrowUp, BookOpen, Check, ChevronRight, Clock3, FileText, FolderTree, Library, Link2, LoaderCircle, Pencil, Pin, Plus, Quote, Save, Search, ShieldCheck, X } from "lucide-react";
import { resolveWikiReference,WikiPageContentSchema, type WikiPage, type WikiPageContent, type WikiEvidence, type WikiResult } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import { MarkdownEditor, MarkdownPreview } from "./MarkdownEditor";
import { SourceRelationsList } from "./SourceRelationsList";
type PageSummary = Omit<WikiPage, "sections" | "evidence" | "breadcrumbs">;
const control = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900";
const card = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const newContent = (): WikiPageContent => ({ title: "", kind: "topic", aliases: [], parentId: null, position: 0, collectionIds: [], entityId: null, pinned: false, archived: false, review: "draft", sections: [] });
export function WikiWorkspace({ t, onOpenSource, active = true, externalTarget, treeWidth, onTreeWidthChange, onPrompts }: {
  onPrompts?:()=>void;
  externalTarget?: (ObsidianDeepLink&{token:number})|null;
  active?: boolean;
  treeWidth?: number;
  onTreeWidthChange?: (width: number) => void;
  t: Translator;
  onOpenSource: (id: string, noteId?: string) => void;
}) {
  const pageRequests=useRef(createWikiPageRequests());
  const processedExternal=useRef<number|null>(null);
  const [historicalRevision,setHistoricalRevision]=useState<string|undefined>();
  const [automaticOpen,setAutomaticOpen]=useState(false);
  const [consultationOpen,setConsultationOpen]=useState(false);
  const [organizationOpen,setOrganizationOpen]=useState(false);
  const treeCursors=useRef(new Map<string,Awaited<ReturnType<typeof window.app.wiki.tree>>["next"]>());
  const [overview,setOverview]=useState<{recent:PageSummary[];pinned:PageSummary[]}>({recent:[],pinned:[]});
  const [treeMore,setTreeMore]=useState<Record<string,boolean>>({}),[treeBusy,setTreeBusy]=useState(false);
  const selectedPageRef=useRef<string|null>(null);
  const [moveTarget,setMoveTarget]=useState("");
  const readingRef=useRef<HTMLElement>(null);
  const readingScroll=useRef(new Map<string,number>());
  const [contextView,setContextView]=useState<"read"|"notes"|"sources"|"connections">("read");
  const [pages, setPages] = useState<PageSummary[]>([]), [page, setPage] = useState<WikiPage | null>(null);
  const [mode, setMode] = useState<"home" | "sources" | "page" | "search">("home");
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<WikiPageContent>(newContent);
  const [query, setQuery] = useState(""), [kind, setKind] = useState("all"), [scope, setScope] = useState<string | null>(null);
  const [searchRetry, setSearchRetry] = useState(0);
  const lastPageRequest = useRef<string | null>(null);
  const [sourceScope, setSourceScope] = useState<{ id: string; title: string } | null>(null);
  const [reviewed, setReviewed] = useState(false), [current, setCurrent] = useState(true);
  const [results, setResults] = useState<WikiResult[]>([]), [offset, setOffset] = useState(0), [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<MessageKey | null>(null);
  const [linkedInspector,setLinkedInspector]=useState<Awaited<ReturnType<typeof window.app.wiki.linkedTarget>>>(null);
  const [inspector, setInspector] = useState<WikiEvidence | WikiResult | null>(null);
  const [linkRefresh,setLinkRefresh]=useState(0);
  const refreshLinkedEvidence=useCallback((value:Awaited<ReturnType<typeof window.app.wiki.linkedTarget>>)=>{if(!value)return;setInspector(current=>{if(!current||!("chunkId" in current))return current;const next=value.evidence.find(e=>e.chunkId===current.chunkId);return next?{...current,current:next.current,sourceAvailable:next.sourceAvailable}:current;});setLinkedInspector(current=>current?.id===value.id&&current.kind===value.kind?value:current);},[]);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof window.app.wiki.history>> | null>(null);
  const [pickSection, setPickSection] = useState<string | null>(null), [chunks, setChunks] = useState<string[]>([]);
  const [historyStack, setHistoryStack] = useState<Array<{
    mode: typeof mode;
    pageId: string | null;
    revisionId?: string|undefined;
  }>>([]);
  const fail = (e: unknown) => { const message = String(e); setError(message.includes("wiki.errors.conflict") ? "wiki.errors.conflict" : message.includes("wiki.errors.cycle") ? "wiki.errors.cycle" : message.includes("wiki.errors.evidence") ? "wiki.errors.evidence" : "wiki.errors.generic"); };
  useEffect(()=>{if(!externalTarget||editing||organizationOpen||consultationOpen||history||processedExternal.current===externalTarget.token)return;const isCurrent=pageRequests.current.begin();let live=true;void window.app.wiki.get(externalTarget.id,externalTarget.revision).then(value=>{if(!live||!isCurrent())return;processedExternal.current=externalTarget.token;setHistoricalRevision(externalTarget.revision);setPage(value);setMode('page');setInspector(value?.evidence.find(e=>e.id===externalTarget.evidence)??null);}).catch(fail);return()=>{live=false;};},[externalTarget,editing,organizationOpen,consultationOpen,history]);

  selectedPageRef.current=page?.id??null;
  const loadTree=useCallback(async(parentId:string|null=null,append=false,pathTo?:string)=>{setTreeBusy(true);try{const key=parentId??'root',result=await window.app.wiki.tree({parentId,after:append?treeCursors.current.get(key)??null:null,...(pathTo?{pathTo}:{})});treeCursors.current.set(key,result.next);setTreeMore(current=>({...current,[key]:!!result.next}));setPages(current=>{const rows=append?current:current.filter(p=>p.parentId!==parentId);return [...new Map([...rows,...result.items,...result.path].map(p=>[p.id,p])).values()];});}finally{setTreeBusy(false);}},[]);
  const reload = useCallback(async () => {const [,recent,pinned]=await Promise.all([loadTree(null,false,selectedPageRef.current??undefined),window.app.wiki.tree({view:'recent',limit:12}),window.app.wiki.tree({view:'pinned',limit:12})]);setOverview({recent:recent.items,pinned:pinned.items});}, [loadTree]);
  useEffect(() => { if (!active) return; setLoading(true); reload().catch(fail).finally(() => setLoading(false)); }, [reload, active]);
  useEffect(() => {
    if (mode !== "sources" && mode !== "search" && !pickSection)
      return;
    let active = true;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => void window.app.wiki.search({ text: query, kind: pickSection ? "chunk" : mode === "sources" ? "source" : kind as "all", pageId: scope, sourceIds: sourceScope ? [sourceScope.id] : [], reviewedOnly: reviewed, currentOnly: current, offset, limit: 30 })
      .then((r) => {
        if (active) {
          setResults(r.items);
          setMore(r.hasMore);
        }
      }).catch((e) => {
        if (active)
          fail(e);
      }).finally(() => {
        if (active)
          setLoading(false);
      }), 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, kind, scope, reviewed, current, mode, offset, pickSection, sourceScope, searchRetry]);
  useEffect(()=>{
    if(!active||editing||mode!=="page"||!page)return;
    const isCurrent=pageRequests.current.capture();let live=true;const id=page.id;const refresh=()=>{if(document.hidden||!live||!isCurrent())return;void window.app.wiki.get(id,historicalRevision).then(next=>{if(next&&live&&isCurrent()){setPage(current=>current?.id===id?next:current);setInspector(current=>{if(!current||!("chunkId" in current))return current;const evidence=next.evidence.find(e=>e.chunkId===current.chunkId);return evidence?{...current,current:evidence.current,sourceAvailable:evidence.sourceAvailable}:current;});setLinkRefresh(n=>n+1);}}).catch(()=>undefined);};refresh();const timer=setInterval(refresh,3000);
    return()=>{live=false;clearInterval(timer);};
  },[active,editing,mode,page?.id,historicalRevision]);
  useEffect(()=>{if(page&&readingRef.current)readingRef.current.scrollTop=readingScroll.current.get(page.id)??0;},[page?.id]);
  const closeOrganization = useCallback(() => {
    setOrganizationOpen(false);
    void reload().catch(fail);
    const id = page?.id;
    if (id) {
      lastPageRequest.current = id;
      const isCurrent=pageRequests.current.capture();
      void window.app.wiki.get(id).then((result) => {
        if (isCurrent()&&lastPageRequest.current === id) setPage((current) => isCurrent()&&current?.id === id ? result : current);
      }).catch(fail);
    }
  }, [page?.id, reload]);
  const goBack = useCallback(async () => {
    if(automaticOpen){setAutomaticOpen(false);return;}
    if(consultationOpen){setConsultationOpen(false);return;}
    if (organizationOpen) { closeOrganization(); return; }
    if (inspector) {
      setInspector(null);
      return;
    }
    if(linkedInspector){setLinkedInspector(null);return;}
    const note=document.querySelector<HTMLButtonElement>('[data-wiki-note-expanded="true"]');if(note){note.click();return;}
    if(contextView!=='read'){setContextView('read');return;}
    if (pickSection) {
      setPickSection(null);
      return;
    }
    if (history) {
      setHistory(null);
      return;
    }
    if (editing)
      return;
    const target = historyStack.at(-1);
    if (target) {
      setHistoryStack((s) => s.slice(0, -1));
      setMode(target.mode);
      setScope(target.pageId);
      setHistoricalRevision(target.revisionId);
      const isCurrent=pageRequests.current.begin();
      const nextPage=target.pageId ? await window.app.wiki.get(target.pageId,target.revisionId) : null;
      if(isCurrent())setPage(nextPage);
    }
  }, [inspector, pickSection, history, editing, historyStack, organizationOpen, closeOrganization,automaticOpen,consultationOpen,contextView,linkedInspector]);
  useEffect(() => {
    if (!active)
      return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        void goBack();
    };
    window.addEventListener("keydown", key);
    const unsubscribe = subscribeWindowNavigation((direction) => {
      if (direction === "back")
        void goBack();
    });
    return () => { window.removeEventListener("keydown", key); unsubscribe(); };
  }, [goBack, active]);
  async function openPage(id: string, revisionId?:string) {
    lastPageRequest.current = id;
    if (editing)
      return;
    setLoading(true);
    setError(null);
    setHistoricalRevision(revisionId);
    const isCurrent=pageRequests.current.begin();
    try {
      const result = await window.app.wiki.get(id,revisionId);
      if(!isCurrent())return;
      if (!result)
        throw new Error();
      setHistoryStack((s) => [...s, { mode, pageId: page?.id ?? null, revisionId:historicalRevision }]);
      if(page)readingScroll.current.set(page.id,readingRef.current?.scrollTop??0);
      setPage(result);
      void window.app.wiki.tree({parentId:null,pathTo:id,limit:1}).then(result=>setPages(current=>[...new Map([...current,...result.path].map(item=>[item.id,item])).values()])).catch(fail);
      setContextView("read");
      setMode("page");
      setScope(id);
      setInspector(null);
      setHistory(null);
    }
    catch (e) {
      fail(e);
    }
    finally {
      setLoading(false);
    }
  }
  function navigate(next: "home" | "sources") {
    if (editing)
      return; pageRequests.current.invalidate();setHistoryStack((s) => [...s, { mode, pageId: page?.id ?? null }]); setMode(next); setScope(null); setSourceScope(null); setQuery(""); setOffset(0); setInspector(null);
  }
  function createPage() { pageRequests.current.invalidate();setHistoricalRevision(undefined);setDraft({...newContent(),parentId:mode==="page"?page?.id??null:null}); setPage(null); setMode("page"); setEditing(true); setChunks([]); setHistory(null); }
  function editPage() {
    if (!page)
      return; pageRequests.current.invalidate();setDraft(WikiPageContentSchema.strip().parse(page)); setEditing(true); setChunks([]); setHistory(null);
  }
  async function save(content = draft) {
    setBusy(true);
    setError(null);
    try {
      const result = await window.app.wiki.save({ version:2, ...(page ? { id: page.id } : {}), expectedRevisionId: page?.revisionId ?? null, content, evidenceChunkIds: chunks });
      setPage(result);
      setEditing(false);
      setPickSection(null);
      setHistory(null);
      setScope(result.id);
      await reload();
    }
    catch (e) {
      fail(e);
    }
    finally {
      setBusy(false);
    }
  }
  const patch = (field: Partial<WikiPageContent>) => setDraft((d) => ({ ...d, ...field }));
  function sectionPatch(id: string, field: Partial<WikiPageContent["sections"][number]>) { setDraft((d) => ({ ...d, sections: d.sections.map((s) => s.id === id ? { ...s, ...field } : s) })); }
  function moveSection(index: number, delta: number) {
    const next = [...draft.sections]; const item = next.splice(index, 1)[0]; if (item)
      next.splice(index + delta, 0, item); patch({ sections: next });
  }
  function chooseEvidence(result: WikiResult) {
    if (!pickSection)
      return; setChunks((c) => [...new Set([...c, result.id])]); setDraft((d) => ({ ...d, sections: d.sections.map((s) => s.id === pickSection ? { ...s, evidenceIds: [...new Set([...s.evidenceIds, result.id])], provenance: "attributed", evidenceReview: "verified" } : s) })); setPickSection(null); setQuery("");
  }
  const renderReference=(token:string,evidenceIds:string[])=>{if(!page)return undefined;const ref=resolveWikiReference(token,evidenceIds,[...(page.automatic?.links??[]),...(page.automatic?.memberships.map(m=>m.target)??[])]);if(ref?.kind==='evidence'){const e=page.evidence.find(e=>e.id===ref.id);return e?<button className="inline text-accent underline" aria-label={t('wiki.inspector')+' · '+e.sourceTitle} onClick={()=>setInspector(e)}>{token}</button>:undefined;}if(ref?.kind==='target')return <WikiTypedLink active={active} refreshKey={linkRefresh} onRefreshed={refreshLinkedEvidence} inline onInlineOpen={setLinkedInspector} label={ref.label} pageId={page.id} revisionId={page.revisionId} target={ref.target} t={t} onOpenPage={id=>void openPage(id)} onOpenSource={onOpenSource} onEvidence={setInspector}/>;return undefined;};
  const pageCards = (items: PageSummary[]) => <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
    {items.map((p) => <button key={p.id} disabled={editing} onClick={() => void openPage(p.id)} className={`${card} group p-5 text-left transition hover:border-cyan-400`}>
      <div className="mb-4 flex items-center justify-between">
        <span className="rounded-xl bg-cyan-500/10 p-2.5 text-cyan-600">
          <BookOpen className="h-5 w-5" />
        </span>
        {p.pinned ? <Pin className="h-4 w-4 text-amber-500" /> : null}
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {t(`wiki.kinds.${p.kind}`)}
      </p>
      <h3 className="mt-1 line-clamp-2 font-semibold">
        {p.title}
      </h3>
      <p className="mt-3 text-xs text-slate-500">
        {t(`wiki.${p.review}`)} ·
        {new Date(p.updatedAt).toLocaleDateString()}
      </p>
    </button>)}
  </div>;
  const resultCards = <div className="grid gap-3">
    {results.map((r) => <button key={`${r.kind}:${r.id}`} onClick={() => pickSection ? chooseEvidence(r) : r.kind === "page" ? void openPage(r.id) : setInspector(r)} className={`${card} p-4 text-left transition hover:border-cyan-400`}>
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <span className="rounded-md bg-slate-100 px-2 py-1 dark:bg-slate-800">
          {r.sourceType && r.kind === "source" ? <SourceTypeBadge type={r.sourceType} t={t} /> : t(`wiki.results.${r.kind}`)}
          {r.catalogOnly ? <span className="ml-2 text-slate-500">{t("wiki.catalogOnly")}</span> : null}
        </span>
        {r.exact ? <span className="text-cyan-600">
          {t("wiki.exact")}
        </span> : null}
        {r.review ? <span>
          {r.review === "draft" || r.review === "reviewed" ? t(`wiki.${r.review}`) : r.review === "approved" ? t("wiki.reviewed") : t(`sourceRelations.${r.review}` as MessageKey)}
        </span> : null}
        {!r.current ? <span className="text-amber-600">
          {t("wiki.stale")}
        </span> : null}
      </div>
      <h3 className="mt-2 font-semibold">
        {r.title || t("wiki.results.entity_relation")}
      </h3>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-slate-500">
        {r.excerpt.replace(/<source-ref id="[^"]+"\s*\/>/g, "")}
      </p>
      <p className="mt-3 truncate text-xs text-slate-400">
        {r.breadcrumb}
      </p>
    </button>)}
    {!loading && !results.length ? <div className={`${card} p-8 text-center text-sm text-slate-500`}>
      {t("wiki.noResults")}
    </div> : null}
    <div className="flex justify-between">
      <button className={control} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>
        {t("sourceRelations.previous")}
      </button>
      <button className={control} disabled={!more} onClick={() => setOffset(offset + 30)}>
        {t("sourceRelations.next")}
      </button>
    </div>
  </div>;
  return <div className="flex h-[calc(100vh-7.5rem)] min-h-80 flex-col overflow-hidden text-slate-900 dark:text-slate-100">

    {consultationOpen&&<ConsultationDialog initialSourceIds={sourceScope?[sourceScope.id]:[]} initialPageId={scope??(mode==="page"?page?.id??null:null)} initialReviewed={reviewed} active={active} t={t} page={mode==="page"?page:null} initialQuestion={query} onClose={()=>{setConsultationOpen(false);void reload().catch(fail);}} onOpenSource={onOpenSource}/>}
    {organizationOpen&&<OrganizationDialog t={t} page={mode==="page"?page:null} onClose={closeOrganization}/>}
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
      <button disabled={editing} className={control} onClick={()=>setConsultationOpen(true)}>{t("consultation.ask")}</button>
      <button disabled={editing||!!historicalRevision} className={control} onClick={()=>setOrganizationOpen(true)}>{t("organization.organize")}</button>
      <div className="mr-auto">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <BookOpen className="h-5 w-5 text-cyan-500" />
          {t("wiki.title")}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {t("wiki.subtitle")}
        </p>
      </div>
      <div className="relative min-w-56 flex-1 max-w-lg">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input aria-label={t("wiki.search")} className={`${control} w-full pl-9`} value={query} disabled={editing && !pickSection} placeholder={t("wiki.search")} onChange={(e) => {
          setQuery(e.target.value); setOffset(0); if (!pickSection)
            setMode("search");
        }} />
      </div>
      <button className={control} disabled={editing} onClick={()=>setAutomaticOpen(true)}>{t('automaticWiki.title')}</button>
      <button className={`${control} flex items-center gap-2`} disabled={editing} onClick={createPage}>
        <Plus className="h-4 w-4" />
        {t("wiki.create")}
      </button>
    </header>

    {error ? <div role="alert" className="my-3 flex items-center gap-3 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-600">
      {t(error)}
      <button className="ml-auto underline" onClick={() => { setError(null); if (!editing && mode === "page" && lastPageRequest.current) void openPage(lastPageRequest.current); else { setSearchRetry((n) => n + 1); void reload().catch(fail); } }}>
        {t("shell.actions.retry")}
      </button>
    </div> : null}

    <div className="relative flex min-h-0 flex-1 gap-5 pt-4">

      <div className="flex min-h-0 min-w-0 flex-1">
      <WikiNavigationPane width={treeWidth} onWidthChange={onTreeWidthChange} t={t}>
        <button disabled={editing} onClick={() => navigate("home")} className={`mb-1 flex w-full items-center gap-2 rounded-lg p-2 text-sm ${mode === "home" ? "bg-cyan-500/10 text-cyan-600" : ""}`}>
          <BookOpen className="h-4 w-4" />
          {t("wiki.home")}
        </button>
        <button disabled={editing} onClick={() => navigate("sources")} className={`flex w-full items-center gap-2 rounded-lg p-2 text-sm ${mode === "sources" ? "bg-cyan-500/10 text-cyan-600" : ""}`}>
          <Library className="h-4 w-4" />
          {t("wiki.sources")}
        </button>
        <p className="mb-2 mt-5 px-2 text-xs font-medium text-muted-foreground">
          {t("wiki.pages")}
        </p>
        <WikiThemeTree onExpand={id=>{if(!treeCursors.current.has(id))void loadTree(id).catch(fail);}} more={treeMore} onMore={id=>void loadTree(id,true).catch(fail)} pages={pages} selected={mode==='page'?page?.id??null:null} disabled={editing} onOpen={id=>void openPage(id)} t={t}/>
        {treeMore.root&&<button disabled={treeBusy} className="p-2 text-sm text-accent" onClick={()=>void loadTree(null,true).catch(fail)}>{t("wiki.loadMore")}</button>}
        {treeBusy&&<p role="status" className="p-2 text-xs">{t("shell.states.loading")}</p>}
      </WikiNavigationPane>

      <main ref={readingRef} onScroll={event=>{if(page)readingScroll.current.set(page.id,event.currentTarget.scrollTop);}} className="min-w-0 flex-1 overflow-y-auto overscroll-contain pr-2 pb-8">

        {loading ? <p role="status" className="mb-3 flex items-center gap-2 text-sm text-slate-500">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {t("shell.states.loading")}
        </p> : null}

        {pickSection ? <section>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold">
              {t("wiki.pickEvidence")}
            </h3>
            <button className={control} onClick={() => setPickSection(null)}>
              {t("wiki.cancel")}
            </button>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            {t("wiki.evidenceHint")}
          </p>
          {resultCards}
        </section> : mode === "home" ? <div className="grid gap-7">
          <div className="rounded-2xl border border-cyan-500/15 bg-gradient-to-br from-cyan-500/10 via-sky-500/5 to-transparent p-6">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-cyan-600">
              {t("wiki.local")}
            </p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight">
              {t("wiki.welcome")}
            </h3>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
              {t("wiki.welcomeBody")}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button className={`${control} flex items-center gap-2`} onClick={createPage}>
                <Plus className="h-4 w-4" />
                {t("wiki.create")}
              </button>
              <button className={control} onClick={() => navigate("sources")}>
                {t("wiki.sources")}
              </button>
            </div>
          </div>
          {overview.pinned.length>0 ? <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Pin className="h-4 w-4 text-amber-500" />
              {t("wiki.pinned")}
            </h3>
            {pageCards(overview.pinned)}
          </section> : null}
          <section>
            <h3 className="mb-3 text-sm font-semibold">
              {t("wiki.recent")}
            </h3>
            {overview.recent.length ? pageCards(overview.recent) : <p className={`${card} p-6 text-sm text-slate-500`}>
              {t("wiki.empty")}
            </p>}
          </section>
        </div> : mode === "search" || mode === "sources" ? <section>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-lg font-semibold">
              {t(mode === "sources" ? "wiki.sources" : "wiki.searchResults")}
            </h3>
            {sourceScope ? <button className={`${control} text-cyan-600`} onClick={() => { setSourceScope(null); setOffset(0); }}>{sourceScope.title} ×</button> : null}
            {scope ? <button className={`${control} flex items-center gap-1 text-cyan-600`} onClick={() => { setScope(null); setOffset(0); }}>
              {pages.find((p) => p.id === scope)?.title}
              <X className="h-3 w-3" />
            </button> : <span className="text-xs text-slate-500">
              {t("wiki.wholeLibrary")}
            </span>}
            {mode === "search" ? <><select aria-label={t("wiki.type")} value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }} className={control}>
              {["all", "page", "source", "chunk", "atomic_note", "source_relation", "entity", "entity_relation"].map((v) => <option key={v} value={v}>
                {t(`wiki.results.${v}` as MessageKey)}
              </option>)}
            </select><label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={reviewed} onChange={(e) => { setReviewed(e.target.checked); setOffset(0); }} />
                {t("wiki.reviewedOnly")}
              </label><label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={current} onChange={(e) => { setCurrent(e.target.checked); setOffset(0); }} />
                {t("wiki.currentOnly")}
              </label></> : null}
          </div>
          {resultCards}
        </section> : editing ? <section className="grid gap-4">
          {externalTarget&&processedExternal.current!==externalTarget.token&&<p role="status" className="text-sm text-amber-700 dark:text-amber-300">{t("obsidianWiki.finishDraft")}</p>}
          <div className="flex items-center gap-2">
            <h3 className="mr-auto font-semibold">
              {t(page ? "wiki.edit" : "wiki.create")}
            </h3>
            <button disabled={busy} className={control} onClick={() => {
              setEditing(false); setPickSection(null); if (!page)
                setMode("home");
            }}>
              {t("wiki.cancel")}
            </button>
            <button disabled={busy || !draft.title.trim()} className={`${control} flex items-center gap-2 bg-cyan-600 text-white dark:bg-cyan-600`} onClick={() => void save()}>
              <Save className="h-4 w-4" />
              {t("wiki.save")}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {t("wiki.protectionHint")}
          </p>
          <label className="grid gap-1 text-xs">
            {t("wiki.pageTitle")}
            <input className={control} value={draft.title} maxLength={300} onChange={(e) => patch({ title: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs">
              {t("wiki.type")}
              <select className={control} value={draft.kind} onChange={(e) => patch({ kind: e.target.value as WikiPageContent["kind"] })}>
                {["topic", "entity", "collection", "synthesis"].map((v) => <option key={v} value={v}>
                  {t(`wiki.kinds.${v}` as MessageKey)}
                </option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              {t("wiki.parent")}
              <select className={control} value={draft.parentId ?? ""} onChange={(e) => patch({ parentId: e.target.value || null })}>
                <option value="">
                  {t("wiki.root")}
                </option>
                {pages.filter((p) => p.id !== page?.id && !p.archived).map((p) => <option key={p.id} value={p.id}>
                  {p.title}
                </option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              {t("wiki.aliases")}
              <input className={control} defaultValue={draft.aliases.join(", ")} onBlur={(e) => patch({ aliases: e.target.value.split(",").map((a) => a.trim()).filter(Boolean) })} />
            </label>
            <label hidden className="grid gap-1 text-xs">
              {t("wiki.position")}
              <input type="number" min={0} max={1000000} className={control} value={draft.position} onChange={(e) => patch({ position: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
          </div>
          {pages.some((p) => p.kind === "collection" && p.id !== page?.id) ? <fieldset className="flex flex-wrap gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-xs">
              {t("wiki.collections")}
            </legend>
            {pages.filter((p) => p.kind === "collection" && p.id !== page?.id && !p.archived).map((p) => <label key={p.id} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={draft.collectionIds.includes(p.id)} onChange={(e) => patch({ collectionIds: e.target.checked ? [...draft.collectionIds, p.id] : draft.collectionIds.filter((id) => id !== p.id) })} />
              {p.title}
            </label>)}
          </fieldset> : null}
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={draft.pinned} onChange={(e) => patch({ pinned: e.target.checked })} />
              {t("wiki.pinned")}
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={draft.review === "reviewed"} onChange={(e) => patch({ review: e.target.checked ? "reviewed" : "draft" })} />
              {t("wiki.reviewed")}
            </label>
          </div>
          {draft.sections.map((s, index) => <article key={s.id} className={`${card} grid gap-3 p-4`}>
            <div className="flex items-center gap-2">
              <input aria-label={t("wiki.sectionTitle")} className={`${control} min-w-0 flex-1`} value={s.title} placeholder={t("wiki.sectionTitle")} onChange={(e) => sectionPatch(s.id, { title: e.target.value })} />
              <button aria-label={t("wiki.moveUp")} disabled={index === 0} className={control} onClick={() => moveSection(index, -1)}>
                <ArrowUp className="h-4 w-4" />
              </button>
              <button aria-label={t("wiki.moveDown")} disabled={index === draft.sections.length - 1} className={control} onClick={() => moveSection(index, 1)}>
                <ArrowDown className="h-4 w-4" />
              </button>
              <button aria-label={t("wiki.removeSection")} className={control} onClick={() => patch({ sections: draft.sections.filter((v) => v.id !== s.id) })}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <MarkdownEditor id={s.id} value={s.markdown} onChange={(markdown) => sectionPatch(s.id, { markdown })} t={t} label={t("wiki.sectionBody")} minHeightClass="min-h-48" />
            <div className="flex flex-wrap gap-2">
              <select aria-label={t("wiki.provenance")} className={control} value={s.provenance} onChange={(e) => sectionPatch(s.id, { provenance: e.target.value as typeof s.provenance })}>
                {["personal", "attributed"].map((v) => <option value={v} key={v}>
                  {t(`wiki.provenanceTypes.${v}` as MessageKey)}
                </option>)}
              </select>
              <button className={`${control} flex items-center gap-1`} onClick={() => { setPickSection(s.id); setScope(null); setSourceScope(null); setQuery(""); setOffset(0); }}>
                <Quote className="h-4 w-4" />
                {t("wiki.addEvidence")}
              </button>
              {s.evidenceReview === "needs_review" ? <button className={control} onClick={() => sectionPatch(s.id, { evidenceReview: "verified" })}>{t("wiki.verifyEvidence")}</button> : null}
              {s.evidenceIds.length ? <button className={`${control} text-amber-600`} onClick={() => sectionPatch(s.id, { evidenceIds: [] })}>
                {t("wiki.clearEvidence")} (
                {s.evidenceIds.length})
              </button> : null}
            </div>
          </article>)}
          <button className={`${control} flex items-center justify-center gap-2 border-dashed`} onClick={() => patch({ sections: [...draft.sections, { id: crypto.randomUUID(), title: "", kind: "prose", markdown: "", provenance: "personal", protected: true, evidenceReview: "verified", evidenceIds: [] }] })}>
            <Plus className="h-4 w-4" />
            {t("wiki.addSection")}
          </button>
        </section> : page ? <article className="mx-auto max-w-4xl">
          <div className="mb-4 flex flex-wrap items-center gap-1 text-xs text-slate-500">
            <button className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={t("wiki.back")} onClick={() => void goBack()}>
              <ArrowLeft className="h-4 w-4" />
            </button>
            {page.breadcrumbs.map((b) => <button key={b.id} onClick={() => void openPage(b.id)} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3" />
              {b.title}
            </button>)}
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-[1_1_18rem]">
              <p className="text-xs font-medium text-cyan-600">
                {t(`wiki.kinds.${page.kind}`)}
              </p>
              <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight">
                {page.title}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
            <button disabled={busy||!!historicalRevision} className={control} aria-label={t("wiki.pinned")} onClick={() => void save({ ...WikiPageContentSchema.strip().parse(page), pinned: !page.pinned })}>
              <Pin className={`h-4 w-4 ${page.pinned ? "fill-amber-400 text-amber-500" : ""}`} />
            </button>
            <button disabled={!!historicalRevision} className={`${control} flex items-center gap-1`} onClick={editPage}>
              <Pencil className="h-4 w-4" />
              {t("wiki.edit")}
            </button>
            </div>
          </div>
          {historicalRevision&&<p role="status" className="mt-3 text-sm text-amber-700 dark:text-amber-300">{t("obsidianWiki.historicalPage")} · {page.revisionNumber}</p>}
          <div className="mb-7 mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t(`wiki.${page.review}`)}
            </span>
            <span>
              {t("wiki.revision")}
              {page.revisionNumber}
            </span>
            <span>
              {new Date(page.updatedAt).toLocaleDateString()}
            </span>
            <button className="flex items-center gap-1 text-cyan-600" onClick={() => void window.app.wiki.history(page.id).then(setHistory).catch(fail)}>
              <Clock3 className="h-3.5 w-3.5" />
              {t("wiki.history")}
            </button>
          </div>
          {!historicalRevision&&<details className="mb-4 text-sm"><summary className="cursor-pointer text-muted-foreground">{t('wiki.parent')}</summary><div className="mt-2 flex flex-wrap gap-2"><select className={control} aria-label={t('wiki.parent')} value={moveTarget} onChange={e=>setMoveTarget(e.target.value)}><option value="">{t('wiki.parent')}</option>{pages.filter(p=>p.id!==page.id&&!p.archived).map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select>{(['before','after','into']as const).map(placement=><button key={placement} disabled={busy||!moveTarget} className={control} onClick={()=>{setBusy(true);void window.app.wiki.move({id:page.id,expectedRevisionId:page.revisionId,targetId:moveTarget,placement}).then(value=>{setPage(value);return reload();}).catch(fail).finally(()=>setBusy(false));}}>{t(placement==='before'?'wiki.moveBefore':placement==='after'?'wiki.moveAfter':'wiki.moveInto')}</button>)}</div></details>}
          <div role="tablist" aria-label={t('wiki.context')} className="mb-5 flex flex-wrap gap-3">{(['read','notes','sources','connections']as const).map(view=><button role="tab" aria-selected={contextView===view} className={contextView===view?'text-accent underline underline-offset-8':'text-muted-foreground'} key={view} onClick={()=>setContextView(view)}>{t(view==='read'?'wiki.read':view==='notes'?'wiki.notes':view==='sources'?'wiki.contextSources':'wiki.contextConnections')}</button>)}</div>
          {contextView!=='read'&&<WikiContextPane pageId={page.id} title={page.title} view={contextView} t={t} onOpenPage={id=>void openPage(id)} onOpenSource={onOpenSource} onEvidence={setInspector}/>}
          <div hidden={contextView!=='read'}>
          {history ? <div className={`${card} mb-6 p-4`}>
            <h3 className="mb-3 font-semibold">
              {t("wiki.history")}
            </h3>
            {history.map((r) => <details key={r.id} className="border-t border-slate-100 py-3 dark:border-slate-800">
              <summary className="cursor-pointer text-sm">
                {t("wiki.revision")}
                {r.number} ·
                {new Date(r.createdAt).toLocaleString(t.locale)} ·
                {r.content.title}
              </summary>
              <div className="my-3 text-sm">
                {r.content.sections.map((s) => <MarkdownPreview key={s.id} markdown={s.markdown} emptyLabel={t("wiki.emptySection")} />)}
              </div>
              <button className={control} disabled={busy} onClick={()=>void openPage(page.id,r.id)}>{t("knowledgeEvolution.openRevision")}</button>
              <button className={control} disabled={busy || !!historicalRevision || r.id === page.revisionId} onClick={() => void save(r.content)}>
                {t("wiki.restore")}
              </button>
            </details>)}
          </div> : null}
          {page.sections.length ? page.sections.map((s) => <section key={s.id} id={`wiki-section-${s.id}`} className="mb-8 scroll-mt-4">
            <div className="mb-3 flex items-center gap-2">
              {s.title ? <h2 className="text-xl font-semibold">
                {s.title}
              </h2> : null}
              <span className="ml-auto text-[10px] text-slate-400">
                {t(`wiki.provenanceTypes.${s.provenance}`)}
              </span>
            </div>
            {page.impacts?.some(i=>i.sectionId===s.id)&&<details className="mb-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"><summary className="cursor-pointer">{t("consultation.stale")}</summary>{page.impacts.filter(i=>i.sectionId===s.id).map(i=><p key={i.id} className="mt-2 text-xs">{i.kind} · {new Date(i.changedAt).toLocaleString()}</p>)}</details>}
            <KnowledgeInterpretations items={s.interpretations} t={t}/><MarkdownPreview markdown={s.markdown} emptyLabel={t("wiki.emptySection")} reference={token=>renderReference(token,s.evidenceIds)} />
            {s.evidenceReview === "needs_review" ? <p className="mt-3 text-xs text-amber-600">
              {t("wiki.needsEvidenceReview")}
            </p> : null}
            {s.evidenceIds.length ? <div className="mt-4 flex flex-wrap gap-2">
              {s.evidenceIds.map((id, i) => {
                const e = page.evidence.find((item) => item.id === id);
                return e ? <button key={id} className="flex max-w-full items-center gap-1 rounded-lg bg-cyan-500/10 px-2 py-1.5 text-xs text-cyan-700 dark:text-cyan-300" onClick={() => setInspector(e)}>
                  <Quote className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {i + 1}.
                    {e.sourceTitle}
                  </span>
                  {!e.current ? <span className="text-amber-600"> ·
                    {t("wiki.stale")}
                  </span> : null}
                </button> : null;
              })}
            </div> : null}
          </section>) : !page.automatic?.groups.length && !page.automatic?.links.length ? <p className={`${card} p-6 text-sm text-slate-500`}>
            {t("wiki.emptyPage")}
          </p> : null}
          <WikiChildrenLinks pageId={page.id} t={t} onOpen={id=>void openPage(id)}/>
          {page.automatic&&<section className="mt-5 grid gap-4"><p className="text-xs text-amber-700 dark:text-amber-300">{t(page.sections.every(s=>s.assessment?.support==='validated'&&s.assessment.sectionRevisionId===s.sectionRevisionId)&&!page.impacts.length&&page.evidence.every(e=>e.current)?page.sections.every(s=>s.assessment?.supportMethod==='model_checked')?'automaticWiki.modelAssessment':'automaticWiki.assessment':'wiki.needsEvidenceReview')}</p>{page.automatic.groups.map(group=><section key={group.id}><h3 className="font-semibold">{group.title}</h3>{group.explanation&&<MarkdownPreview markdown={group.explanation} emptyLabel="" reference={token=>renderReference(token,group.explanationEvidenceIds)}/>}<div className="mt-2 grid gap-1">{page.automatic!.memberships.filter(m=>m.groupId===group.id).toSorted((a,b)=>a.order-b.order).map(m=><WikiTypedLink active={active} refreshKey={linkRefresh} onRefreshed={refreshLinkedEvidence} key={m.id} pageId={page.id} revisionId={page.revisionId} target={m.target} t={t} onOpenPage={id=>void openPage(id)} onOpenSource={onOpenSource} onEvidence={setInspector}/>)}</div></section>)}<div className="flex flex-wrap gap-2">{page.automatic.links.map(target=><WikiTypedLink active={active} refreshKey={linkRefresh} onRefreshed={refreshLinkedEvidence} key={target.kind+target.id} pageId={page.id} revisionId={page.revisionId} target={target} t={t} onOpenPage={id=>void openPage(id)} onOpenSource={onOpenSource} onEvidence={setInspector}/>)}</div></section>}
          </div>
        </article> : null}

      </main>

      </div>
      {linkedInspector&&!inspector&&<aside aria-label={t('wiki.inspector')} className={card+' w-80 shrink-0 overflow-auto p-4 max-xl:absolute max-xl:inset-y-4 max-xl:right-0 max-xl:z-20'}><div className="mb-3 flex justify-between"><h3 className="font-semibold">{linkedInspector.title}</h3><button aria-label={t('wiki.close')} onClick={()=>setLinkedInspector(null)}><X size={18}/></button></div><MarkdownPreview markdown={linkedInspector.markdown} emptyLabel={t('wiki.noResults')}/><div className="mt-4 grid gap-2">{linkedInspector.evidence.map(e=><button className="text-left text-sm text-accent underline" key={e.id} onClick={()=>setInspector(e)}>{e.sourceTitle} · {e.locator??t('wiki.inspector')}</button>)}</div>{linkedInspector.sourceItemId&&<button className="mt-4 text-sm text-accent underline" onClick={()=>onOpenSource(linkedInspector.sourceItemId!,linkedInspector.kind==='atomic_note'?linkedInspector.id:undefined)}>{t('wiki.openSource')}</button>}</aside>}
      {inspector ? <aside aria-label={t("wiki.inspector")} className={`${card} w-80 shrink-0 overflow-y-auto overscroll-contain p-4 max-xl:absolute max-xl:right-0 max-xl:top-4 max-xl:bottom-0 max-xl:z-20 max-xl:shadow-xl`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Quote className="h-4 w-4 text-cyan-500" />
            {t("wiki.inspector")}
          </h3>
          <button aria-label={t("wiki.close")} onClick={() => setInspector(null)} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>
        {"chunkId" in inspector ? <><h4 className="font-semibold">
          {inspector.sourceTitle}
        </h4><p className="mt-2 text-xs text-slate-500">
            {new Date(inspector.documentCreatedAt).toLocaleString()}
            {inspector.locator ? ` · ${inspector.locator}` : ""}
          </p><p className="mt-2 break-all text-[10px] text-slate-400">
            {t("wiki.documentRevision")}:
            {inspector.documentId}
          </p>{!inspector.current ? <p className="mt-3 text-xs text-amber-600">
            {t("wiki.staleEvidence")}
          </p> : null}<blockquote className="my-5 whitespace-pre-wrap border-l-2 border-cyan-500/40 pl-3 text-sm leading-6">
            {inspector.excerpt}
          </blockquote><button disabled={inspector.sourceAvailable===false} className={`${control} w-full`} onClick={() => onOpenSource(inspector.sourceItemId)}>
            {t(inspector.sourceAvailable===false?"obsidianWiki.unavailable":"wiki.openSource")}
          </button></> : <><h4 className="font-semibold">
            {inspector.title}
          </h4>{inspector.kind === "source_relation" && inspector.sourceItemId ? <SourceRelationsList sourceItemId={inspector.sourceItemId} targetSourceItemId={inspector.targetSourceItemId} relationId={inspector.id} t={t} onOpenNote={onOpenSource} /> : <><p className="mt-2 text-xs text-slate-400">
            {inspector.breadcrumb}
          </p><blockquote className="my-5 whitespace-pre-wrap text-sm leading-6">
              {inspector.excerpt}
            </blockquote>{inspector.sourceItemId && inspector.kind === "source" ? <button className={`${control} mb-2 w-full`} onClick={() => { setSourceScope({ id: inspector.sourceItemId!, title: inspector.title }); setScope(null); setMode("search"); setKind("all"); setQuery(""); setOffset(0); setInspector(null); }}>{t("wiki.scopeSource")}</button> : null}
            {inspector.sourceItemId ? <button className={`${control} w-full`} onClick={() => onOpenSource(inspector.sourceItemId!, inspector.kind === "atomic_note" ? inspector.id : undefined)}>
              {t("wiki.openSource")}
            </button> : null}{inspector.kind === "source" && inspector.sourceItemId && !scope && !sourceScope ? <div className="mt-5">
              <h5 className="flex items-center gap-2 text-sm font-semibold">
                <Link2 className="h-4 w-4" />
                {t("wiki.connections")}
              </h5>
              <SourceRelationsList sourceItemId={inspector.sourceItemId} t={t} onOpenNote={onOpenSource} />
            </div> : null}</>}</>}
      </aside> : null}

    </div>

    {automaticOpen&&<AutomaticWikiDialog onPrompts={onPrompts} t={t} onClose={()=>{setAutomaticOpen(false);void reload().catch(fail);}} onChanged={()=>void reload().catch(fail)}/>}
  </div>;
}
