import { AutomationTaskList } from './AutomationTaskList';
import { TaskHistoryCleanup } from './TaskHistoryCleanup';
import { KnowledgeBudgetSettings } from './KnowledgeBudgetSettings';
import { PromptsSettingsView } from "./PromptsSettingsView";
import { useCallback, useEffect, useState } from 'react';
import { Gauge, Activity, ArrowRight, CalendarClock, CheckCircle2, CirclePause, Settings2, ShieldQuestion } from 'lucide-react';
import { AutomationDashboardSchema, SourceJourneySchema, AutomaticWikiPolicySchema, CuratorPreviewSchema, initialCuratorLimits, type AutomationTask, type AutomaticWikiPolicy } from '@app/domain';
import { z } from 'zod';
import type { MessageKey, Translator } from '@app/i18n';
import type { AiProfile } from '../../shared/ipc';
import { Button } from './ui/button';
import { AutomaticMaintenancePanel } from './AutomaticMaintenancePanel';
import { AutomaticWikiDialog } from './AutomaticWikiDialog';
import { AutomationTaskDetail } from './AutomationTaskDetail';
import { ObsidianEditorialCard } from './ObsidianEditorialCard';
import { EvidenceScopePicker, OrganizationSettingsView, ProfilePicker, OrganizationRuns } from './OrganizationView';

type Dashboard = z.infer<typeof AutomationDashboardSchema>;
type Tab = 'overview' | 'tasks' | 'sources' | 'schedules' | 'decisions' | 'settings' | 'prompts' | 'budget';
const tabs = [ ['overview', Activity], ['tasks', Activity], ['sources', ArrowRight], ['schedules', CalendarClock], ['budget', Gauge], ['decisions', ShieldQuestion], ['settings', Settings2], ['prompts', Settings2] ] as const;
const card = 'rounded-xl border border-border bg-surface p-4';
const errorKey = (error: unknown) => (String(error).match(/(?:organization|maintenance|wiki)\.errors\.[A-Za-z]+/)?.[0] ?? 'errors.common.unknown') as MessageKey;

export function KnowledgeAutomationView({ t, contentLanguage, onSettings, compact = false }: {
  t: Translator; contentLanguage: string; onSettings?: (scope: 'models' | 'intelligence' | 'prompts' | 'connections') => void; compact?: boolean;
}) {
  const [promptTarget,setPromptTarget]=useState({id:"organization.curator",domainId:null as string|null});
  const [tab, setTab] = useState<Tab>(compact ? 'tasks' : 'overview');
  const [data, setData] = useState<Dashboard | null>(null), [error, setError] = useState<MessageKey | null>(null);
  const [schedulePolicy,setSchedulePolicy]=useState<string|null>(null);
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<AutomationTask | null>(null);
  const refresh = useCallback(async (nextOffset = offset) => {
    try { setData(AutomationDashboardSchema.parse(await window.app.curator.command({ command: 'automationDashboard', offset:nextOffset, filter: tab === 'decisions' ? 'attention' : 'all' }))); setError(null); }
    catch (error) { setError(errorKey(error)); }
  }, [offset, tab]);
  useEffect(() => { let live = true; const load = async () => {
    try { const result = AutomationDashboardSchema.parse(await window.app.curator.command({ command: 'automationDashboard', offset, filter: tab === 'decisions' ? 'attention' : 'all' })); if (live) { setData(result); setError(null); } }
    catch (error) { if (live) setError(errorKey(error)); }
  }; void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000); return () => { live = false; clearInterval(timer); }; }, [offset, tab]);
  function inspect(task: AutomationTask) {
    if (task.kind === 'sync') { setTab('decisions'); setOffset(0); }
    else if (task.kind === 'schedule') { setSchedulePolicy(task.policyId); setTab('schedules'); setOffset(0); }
    else setSelected(task);
  }
  return <section className="grid min-w-0 gap-5">
    {!compact && <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t('automation.title')}</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('automation.description')}</p></div><div className="flex flex-wrap items-start gap-2"><TaskHistoryCleanup t={t} onCleared={async()=>{setOffset(0);await refresh(0);}}/><Button onClick={() => void refresh()}>{t('organization.refresh')}</Button></div></header>}
    {!compact && <nav aria-label={t('automation.title')} className="flex flex-wrap gap-1 rounded-xl bg-soft p-1">{tabs.map(([id, Icon]) => <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setOffset(0); setData(null); }} className={`flex min-h-9 items-center gap-2 rounded-lg px-3 py-2 text-sm ${tab === id ? 'bg-surface font-medium text-accent shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}><Icon size={15}/>{t(`automation.tabs.${id}`)}</button>)}</nav>}
    {error && <div role="alert" className={`${card} text-sm text-rose-600`}>{t(error)} <Button onClick={() => void refresh()}>{t('shell.actions.retry')}</Button></div>}
    {!data ? <p role="status" className="p-4 text-sm text-muted-foreground">{t('shell.states.loading')}</p> : <>
      {(!compact || !data.ready) && <div className={`${card} flex flex-wrap items-center justify-between gap-3`}><div className="flex items-start gap-3">{data.ready ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={20}/> : <CirclePause className="mt-0.5 shrink-0 text-amber-600" size={20}/>}<div><p className="text-sm font-medium">{t(data.ready ? 'automation.ready' : 'automation.waitingModel')}</p><p className="mt-1 text-xs text-muted-foreground">{data.model ?? t('automation.modelHint')}</p></div></div>{!data.ready && onSettings && <div className="flex flex-wrap gap-2"><Button onClick={() => onSettings('models')}>{t('automation.models')}</Button><Button onClick={() => onSettings('intelligence')}>{t('automation.routing')}</Button></div>}</div>}
      {tab === 'overview' && <div className="grid gap-3 sm:grid-cols-3">{(['total','integrated','pending'] as const).map(key => <div className={card} key={key}><p className="text-xs text-muted-foreground">{t(`automation.coverage.${key}`)}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{data.sources[key]}</p></div>)}</div>}
      {['overview','tasks','decisions'].includes(tab) && <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{t(compact ? 'automation.title' : tab === 'decisions' ? 'automation.tabs.decisions' : 'automation.tabs.tasks')}</h3><div className="flex items-start gap-3">{compact&&<TaskHistoryCleanup t={t} onCleared={async()=>{setOffset(0);await refresh(0);}}/>}</div></div>
        <AutomationTaskList tasks={tab==='overview'?data.tasks.slice(0,6):data.tasks} policyId={data.policyId} revisionId={data.policyRevisionId} t={t} inspect={inspect}/>
        <div className="flex justify-between gap-2">{tab==='overview'&&<Button onClick={()=>setTab("tasks")}>{t("automation.allTasks")}</Button>}{tab!=='overview'&&<><Button disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); setData(null); }}>{t('import.actions.back')}</Button><Button disabled={data.next === null} onClick={() => { if (data.next !== null) { setOffset(data.next); setData(null); } }}>{t('wiki.loadMore')}</Button></>}</div>
      </div>}
      {(tab === 'schedules' || tab === 'budget') && <KnowledgeSchedules budget={tab==='budget'} onSaved={refresh} onSchedules={()=>setTab('schedules')} onBudget={()=>setTab('budget')} policyId={schedulePolicy??data.policyId} onSelect={setSchedulePolicy} ready={data.ready} t={t}/>}
      {tab === 'sources' && <SourceJourney t={t}/>}{tab==='prompts'&&<PromptsSettingsView t={t} language={t.locale} initialId={promptTarget.id} initialDomainId={promptTarget.domainId}/>}
      {tab === 'settings' && <><AutomaticKnowledgeSettings policyId={data.policyId} t={t} onSaved={refresh}/><OrganizationSettingsView t={t} contentLanguage={contentLanguage} onPrompts={(id='organization.curator',domainId=null) => {setPromptTarget({id,domainId});setTab('prompts');}}/></>}
      {tab === 'decisions' && <><ObsidianEditorialCard t={t}/><OrganizationRuns t={t}/></>}
    </>}
    {selected && (selected.version === 'wiki-curator-v2' ? <AutomaticWikiDialog t={t} reviewOnly runId={selected.id} onClose={() => setSelected(null)} onChanged={() => void refresh()}/> : <AutomationTaskDetail task={selected} t={t} onClose={()=>setSelected(null)} onChanged={()=>void refresh()}/>)}
  </section>;
}
function SourceJourney({t}:{t:Translator}){
  const [offset,setOffset]=useState(0),[data,setData]=useState<z.infer<typeof SourceJourneySchema>|null>(null),[failed,setFailed]=useState(false),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let live=true,inFlight=false;
    const load=async()=>{if(inFlight)return;inFlight=true;try{const value=SourceJourneySchema.parse(await window.app.curator.command({command:'automationSources',offset}));if(live){setData(value);setFailed(false);}}catch{if(live)setFailed(true);}finally{inFlight=false;if(live)setLoading(false);}};
    setLoading(true);void load();const timer=setInterval(()=>void load(),5000);
    return()=>{live=false;clearInterval(timer);};
  },[offset,attempt]);
  return <SourceJourneyContent t={t} data={data} failed={failed} loading={loading} offset={offset} onRetry={()=>setAttempt(value=>value+1)} onPage={next=>{setData(null);setFailed(false);setLoading(true);setOffset(next);}}/>;
}
export function SourceJourneyContent({t,data,failed,loading,offset,onRetry,onPage}:{t:Translator;data:z.infer<typeof SourceJourneySchema>|null;failed:boolean;loading:boolean;offset:number;onRetry:()=>void;onPage:(offset:number)=>void}){
  const label=(status:string)=>{const keys:Record<string,MessageKey>={disabled:'maintenance.paused',unconfigured:'automation.pending',paused:'maintenance.paused',succeeded:'automation.complete',imported:'automation.imported',integrated:'automation.complete',synced:'automation.complete',cataloged:'wiki.catalogOnly',stale:'automation.stale',attention:'automation.conflict',failed:'organization.failed',canceled:'organization.canceled',analyzing:'organization.analyzing',running:'organization.analyzing',partial:'consultation.partial',conflict:'automation.conflict',local_modified:'automation.conflict'};return t(keys[status]??'automation.pending');};
  return <section className="grid gap-3"><h3 className="font-semibold">{t('automation.journey')}</h3>{failed&&<div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-surface p-4"><p className="text-sm text-rose-700 dark:text-rose-300">{t('automation.journeyError')}</p><Button disabled={loading} onClick={onRetry}>{t('shell.actions.retry')}</Button></div>}{loading&&!data?<p role="status">{t('shell.states.loading')}</p>:data?<><div className="overflow-x-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-soft"><tr>{(['source','processing','wiki','obsidian']as const).map(key=><th className="p-3 font-medium" key={key}>{t(`automation.journeyColumns.${key}`)}</th>)}</tr></thead><tbody>{data.items.map(row=><tr className="border-t border-border" key={row.id}><th className="max-w-sm p-3 font-medium">{row.title}</th><td className="p-3">{label(row.processing)}</td><td className="p-3">{label(row.wiki)}</td><td className="p-3">{label(row.obsidian)}</td></tr>)}</tbody></table>{data.items.length===0&&<p className="p-4 text-sm text-muted-foreground">{t('automation.empty')}</p>}</div><div className="flex justify-between"><Button disabled={loading||!offset} onClick={()=>onPage(Math.max(0,offset-50))}>{t('import.actions.back')}</Button><Button disabled={loading||data.next===null} onClick={()=>onPage(data.next!)}>{t('wiki.loadMore')}</Button></div></>:null}</section>;
}
function AutomaticKnowledgeSettings({ policyId, t, onSaved }: { policyId: string; t: Translator; onSaved: () => Promise<void> }) {
  const [policy, setPolicy] = useState<AutomaticWikiPolicy | null>(null), [profiles, setProfiles] = useState<AiProfile[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<MessageKey | null>(null), [saved, setSaved] = useState(false);
  useEffect(() => { let live = true; void Promise.all([window.app.curator.command({command:'policies'}), window.app.ai.listProfiles()]).then(([values, profiles]) => { if (live) { setPolicy(z.array(AutomaticWikiPolicySchema).parse(values).find(p => p.id === policyId) ?? null); setProfiles(profiles); } }).catch(error => { if (live) setError(errorKey(error)); }); return () => { live = false; }; }, [policyId]);
  const change = (next: AutomaticWikiPolicy) => { setPolicy(next); setSaved(false); };
  async function save() {
    if (!policy) return; setBusy(true); setError(null); setSaved(false);
    try { const preview = CuratorPreviewSchema.parse(await window.app.curator.command({ command:'preview', input:{ policyId, wholeLibrary:policy.scope.wholeLibrary, sourceIds:policy.scope.sourceIds, includeDescendants:policy.scope.includeDescendants, excludedSourceIds:policy.scope.excludedSourceIds, profileOverrideId:policy.profileOverrideId, limits:policy.limits ?? initialCuratorLimits, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, interpretMemory:policy.operations.includes('interpret_memory'), evolveNotes:policy.operations.includes('evolve_notes') } }));
      const next = AutomaticWikiPolicySchema.parse(await window.app.curator.command({command:'activate',state:policy.state==='paused'?'paused':'enabled',policyId,revisionId:preview.policy.revisionId,previewHash:preview.previewHash}));
      setPolicy(next); setSaved(true); await onSaved();
    } catch (error) { setError(errorKey(error)); } finally { setBusy(false); }
  }
  return <section className={`${card} grid gap-4`}><h3 className="font-semibold">{t('automation.settings')}</h3>{error && <p role="alert" className="text-sm text-rose-600">{t(error)}</p>}{!policy ? <p role="status">{t('shell.states.loading')}</p> : <><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">{t(policy.state==='paused'?'maintenance.paused':'maintenance.enabled')}</p><Button disabled={busy} onClick={()=>{setBusy(true);void window.app.curator.command({command:policy.state==='paused'?'resume':'pause',policyId}).then(next=>{setPolicy(AutomaticWikiPolicySchema.parse(next));return onSaved();}).catch(error=>setError(errorKey(error))).finally(()=>setBusy(false));}}>{t(policy.state==='paused'?'automaticWiki.resume':'maintenance.pause')}</Button></div><fieldset disabled={busy} className="grid gap-4"><label className="flex gap-2 text-sm"><input type="checkbox" checked={policy.scope.wholeLibrary} onChange={e => change({...policy,scope:{...policy.scope,wholeLibrary:e.target.checked}})}/>{t('automaticWiki.wholeLibrary')}</label>{!policy.scope.wholeLibrary && <EvidenceScopePicker selected={policy.scope.sourceIds} onChange={sourceIds => change({...policy,scope:{...policy.scope,sourceIds}})} t={t}/>}<details><summary className="cursor-pointer text-sm">{t('automaticWiki.excludedSources')}</summary><EvidenceScopePicker selected={policy.scope.excludedSourceIds} onChange={excludedSourceIds => change({...policy,scope:{...policy.scope,excludedSourceIds}})} t={t}/></details><ProfilePicker profiles={profiles} value={policy.profileOverrideId ?? ''} onChange={id => change({...policy,profileOverrideId:id || null})} t={t}/>{(['interpret_memory','evolve_notes'] as const).map(operation => <label key={operation} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={policy.operations.includes(operation)} onChange={e => change({...policy,operations:e.target.checked ? [...policy.operations,operation] : policy.operations.filter(o => o !== operation)})}/>{t(operation === 'interpret_memory' ? 'knowledgeEvolution.enableMemory' : 'knowledgeEvolution.enableNotes')}</label>)}<p className="text-xs text-muted-foreground">{t('automaticWiki.permission')}</p></fieldset><div className="flex flex-wrap items-center gap-3"><Button disabled={busy || !policy.scope.wholeLibrary && !policy.scope.sourceIds.length} onClick={() => void save()}>{t('shell.actions.save')}</Button>{saved && <p role="status" className="text-sm text-emerald-600">{t('automation.saved')}</p>}</div></>}</section>;
}

function KnowledgeSchedules({policyId,onSelect,ready,t,onBudget,budget,onSaved,onSchedules}:{budget:boolean;onSaved:()=>Promise<void>;onSchedules:()=>void;onBudget:()=>void;policyId:string;onSelect:(id:string)=>void;ready:boolean;t:Translator}){
 const [policies,setPolicies]=useState<AutomaticWikiPolicy[]>([]),[error,setError]=useState(false);
 useEffect(()=>{let live=true;void window.app.curator.command({command:'policies'}).then(value=>{if(live)setPolicies(z.array(AutomaticWikiPolicySchema).parse(value));}).catch(()=>{if(live)setError(true);});return()=>{live=false;};},[]);
 return <div className="grid gap-4">{error&&<p role="alert">{t('errors.common.unknown')}</p>}{policies.length>1&&<label className="grid gap-1 text-sm">{t('automaticWiki.policy')}<select className="rounded-lg border border-border bg-surface p-2" value={policyId} onChange={e=>onSelect(e.target.value)}>{policies.map((p,i)=><option key={p.id} value={p.id}>{i+1} · {p.scope.wholeLibrary?t('wiki.wholeLibrary'):t('organization.sourceScope')+' · '+p.scope.sourceIds.length} · {t(p.state==='paused'?'maintenance.paused':'maintenance.enabled')}</option>)}</select></label>}<>{budget?<KnowledgeBudgetSettings policyId={policyId} t={t} onSaved={onSaved} onSchedules={onSchedules}/>:<><div className="flex justify-end"><Button onClick={onBudget}>{t('budget.title')}</Button></div><AutomaticMaintenancePanel policyId={policyId} ready={ready} t={t}/></>}</></div>;
}
