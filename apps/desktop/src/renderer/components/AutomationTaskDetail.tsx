import { AutomaticWikiDialog } from './AutomaticWikiDialog';
import { RunCard } from "./OrganizationView";
import { OrganizationRunSchema } from "@app/domain";
import {useEffect,useRef,useState} from 'react';
import {AutomaticMaintenanceRunSchema,WikiBootstrapSchema,AutomationDeliveriesSchema,type AutomationTask} from '@app/domain';
import type {z} from 'zod';
import type {Translator,MessageKey} from '@app/i18n';
import {AutomaticMaintenanceResult} from './AutomaticMaintenancePanel';
import {RunDetail} from './MaintenanceView';
import {Button} from './ui/button';
export function AutomationTaskDetail({task,t,onClose,onChanged}:{task:AutomationTask;t:Translator;onClose:()=>void;onChanged:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),[routine,setRoutine]=useState<z.infer<typeof AutomaticMaintenanceRunSchema>|null>(null),[bootstrap,setBootstrap]=useState<z.infer<typeof WikiBootstrapSchema>|null>(null),[error,setError]=useState<MessageKey|null>(null),[busy,setBusy]=useState(false);
  const legacy=task.kind==='maintenance'&&task.version!=='automatic-maintenance-v1';
  useEffect(()=>{if(legacy)return;const before=document.activeElement as HTMLElement|null;dialog.current?.showModal();let live=true;const load=async()=>{
    try{if(task.kind==='maintenance'){const run=AutomaticMaintenanceRunSchema.parse(await window.app.maintenance.command({command:'automaticGet',runId:task.id}));if(live)setRoutine(run);}
      if(task.version==='wiki-bootstrap-v1'){const run=WikiBootstrapSchema.parse(await window.app.wiki.collection({command:'bootstrapGet',id:task.id}));if(live)setBootstrap(run);}}
    catch(error){if(live)setError((String(error).match(/(?:organization|maintenance)\.errors\.[A-Za-z]+/)?.[0]??'errors.common.unknown')as MessageKey);}
  };void load();const timer=setInterval(()=>void load(),3000);return()=>{live=false;clearInterval(timer);dialog.current?.close();before?.focus();};},[task.id,legacy]);
  if(legacy)return <RunDetail id={task.id} t={t} onClose={onClose} onChanged={onChanged}/>;
  async function cancel(){setBusy(true);try{await window.app.maintenance.command({command:'automaticCancel',runId:task.id});onChanged();onClose();}catch{setError('maintenance.errors.failed');}finally{setBusy(false);}}
  return <dialog ref={dialog} onCancel={e=>{e.preventDefault();onClose();}} aria-labelledby="automation-task-title" className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl overflow-auto rounded-2xl border border-border bg-surface p-5 text-foreground backdrop:bg-slate-950/60"><header className="mb-4 flex items-center justify-between gap-3"><h2 id="automation-task-title" className="text-lg font-semibold">{t(`automation.kinds.${task.kind}`)}</h2><Button onClick={onClose}>{t('organization.close')}</Button></header>{error&&<p role="alert" className="mb-3 text-sm text-rose-600">{t(error)}</p>}{routine?<AutomaticMaintenanceResult run={routine} t={t} busy={busy} cancel={()=>void cancel()}/>:bootstrap?<div className="grid gap-3 text-sm"><p>{t('automation.journey')}</p><p>{t('automaticMaintenance.coverage',{values:{sources:bootstrap.checkpoint.completedSources,groups:bootstrap.checkpoint.completedGroups,catalog:bootstrap.checkpoint.catalogedSources}})}</p>{bootstrap.checkpoint.error&&<p className="text-amber-700 dark:text-amber-300">{t(bootstrap.checkpoint.error as MessageKey)}</p>}<p className="text-muted-foreground">{new Date(bootstrap.createdAt).toLocaleString(t.locale)}</p></div>:task.kind==='delivery'?<DeliveryHistory task={task} t={t}/>:task.version==='wiki-three-tools-v1'?<LegacyOrganizationRun id={task.id} t={t}/>:!['maintenance'].includes(task.kind)&&task.version!=='wiki-bootstrap-v1'?<div className="grid gap-3 text-sm"><p>{t('automation.pending')}</p>{task.reason&&<p>{t(task.reason as MessageKey)}</p>}<p className="text-muted-foreground">{new Date(task.updatedAt).toLocaleString(t.locale)}</p></div>:<p role="status">{t('shell.states.loading')}</p>}</dialog>;
}

function DeliveryHistory({task,t}:{task:AutomationTask;t:Translator}){
 const [childId,setChildId]=useState<string|null>(null);
 const [data,setData]=useState<z.infer<typeof AutomationDeliveriesSchema>|null>(null),[offset,setOffset]=useState(0),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true;void window.app.curator.command({command:'automationDeliveries',policyId:task.policyId!,revisionId:task.policyRevisionId,sourceIds:task.sourceIds,offset}).then(value=>{if(live)setData(AutomationDeliveriesSchema.parse(value));}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[offset,task.policyId]);
 return <section className="grid gap-3 text-sm">{childId&&<AutomaticWikiDialog t={t} runId={childId} onChanged={()=>{}} onClose={()=>setChildId(null)}/>}<p>{task.title}</p>{failed&&<p role="alert">{t('errors.common.unknown')}</p>}{!data?<p role="status">{t('shell.states.loading')}</p>:<>{data.items.map(row=><div key={row.id} className="rounded-lg border border-border p-3"><p>{new Date(row.updatedAt).toLocaleString(t.locale)} · {t(row.status==='acknowledged'?'automation.complete':'automation.pending')}</p>{row.reason&&<p className="mt-1 text-amber-700 dark:text-amber-300">{t((/^(organization|maintenance)\.errors\./.test(row.reason)?row.reason:'automation.conflict')as MessageKey)}</p>}{row.relatedRunId&&row.relatedRunVersion==='wiki-curator-v2'&&<Button onClick={()=>setChildId(row.relatedRunId!)}>{t('automation.openBlockingRun')}</Button>}</div>)}<div className="flex justify-between"><Button disabled={!offset} onClick={()=>{setOffset(Math.max(0,offset-50));setData(null);}}>{t('import.actions.back')}</Button><Button disabled={data.next===null} onClick={()=>{setOffset(data.next!);setData(null);}}>{t('wiki.loadMore')}</Button></div></>}</section>;
}

function LegacyOrganizationRun({id,t}:{id:string;t:Translator}){
 const [run,setRun]=useState<z.infer<typeof OrganizationRunSchema>|null>(null),[error,setError]=useState(false);
 const load=async()=>{try{setRun(OrganizationRunSchema.parse(await window.app.organization.command({command:'get',id})));setError(false);}catch{setError(true);}};
 useEffect(()=>{void load();},[id]);
 if(error)return <p role="alert">{t('errors.common.unknown')}</p>;
 return run?<RunCard initialOpen t={t} refresh={load} summary={{id,status:run.status,title:run.snapshot.baseContent.title,sample:run.snapshot.sample,receiptRevisionId:run.receiptRevisionId,modelState:run.checkpoint.waitingForModel?'waiting':run.checkpoint.callPending?'active':'none',createdAt:run.createdAt,updatedAt:run.updatedAt}}/>:<p role="status">{t('shell.states.loading')}</p>;
}
