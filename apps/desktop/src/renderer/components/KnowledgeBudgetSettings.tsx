import { useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { AutomaticAllowanceSchema, AutomaticMaintenanceDashboardSchema, AutomaticWikiPolicySchema, CuratorLimitsSchema, CuratorPreviewSchema, type AutomaticWikiPolicy } from '@app/domain';
import type { MessageKey, Translator } from '@app/i18n';
import { Button } from './ui/button';

const card = 'grid gap-4 rounded-xl border border-border bg-surface p-4';
const control = 'min-h-9 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-50';
const errorKey = (error: unknown) => (String(error).match(/(?:organization|maintenance)\.errors\.[A-Za-z]+/)?.[0] ?? 'errors.common.unknown') as MessageKey;
type Dashboard = z.infer<typeof AutomaticMaintenanceDashboardSchema>;
type Limits = z.infer<typeof CuratorLimitsSchema>;
export const curatorBudgetFields = ['modelCalls', 'repairs', 'deadlineMs', 'targets', 'sectionPatchesPerPage', 'originalPassages', 'tools'] as const;
export function parseCuratorBudget(values: Record<keyof Limits, string>) {
  const result = CuratorLimitsSchema.safeParse(Object.fromEntries(curatorBudgetFields.map(key => [key, values[key].trim() ? Number(values[key]) * (key === 'deadlineMs' ? 1000 : 1) : NaN])));
  return result.success && Number.isInteger(Number(values.deadlineMs)) && result.data.deadlineMs >= 1000 && result.data.modelCalls >= (result.data.repairs ? 4 : 2) ? result.data : null;
}
function drafts(limits: Limits): Record<keyof Limits, string> {
  return Object.fromEntries(curatorBudgetFields.map(key => [key, String(limits[key] / (key === 'deadlineMs' ? 1000 : 1))])) as Record<keyof Limits, string>;
}
function NumberField({ name, value, min, max, step = 1, label, hint, onChange }: { name: string; value: string; min: number; max: number; step?: number; label: string; hint: string; onChange: (value: string) => void }) {
  const id = useId();
  return <div className="grid content-start gap-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label><input id={id} name={name} type="number" inputMode="numeric" required min={min} max={max} step={step} value={value} aria-describedby={`${id}-hint`} className={control} onChange={event => onChange(event.target.value)}/><p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p></div>;
}
export function KnowledgeBudgetSettings({ policyId, t, onSaved, onSchedules }: { policyId: string; t: Translator; onSaved: () => Promise<void>; onSchedules: () => void }) {
  return <div className="grid gap-5"><header className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{t('budget.title')}</h3><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('budget.description')}</p></div><Button onClick={onSchedules}>{t('budget.routines')}</Button></header><MonthlyBudgetSettings key={`month-${policyId}`} policyId={policyId} t={t}/><CuratorBudgetSettings key={`curator-${policyId}`} policyId={policyId} t={t} onSaved={onSaved}/></div>;
}
function MonthlyBudgetSettings({ policyId, t }: { policyId: string; t: Translator }) {
  const [data, setData] = useState<Dashboard | null>(null), [values, setValues] = useState({calls:'',tokens:''});
  const [error, setError] = useState<MessageKey | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void window.app.maintenance.command({command:'automaticDashboard',policyId}).then(raw => {
      if (!live) return;
      const next = AutomaticMaintenanceDashboardSchema.parse(raw); setData(next); setError(null);
      const ceiling = next.schedules[0]?.policy.monthAllowance;
      if (ceiling) setValues({calls:String(ceiling.calls),tokens:String(ceiling.tokens)});
    }).catch(error => { if (live) setError(errorKey(error)); });
    return () => { live = false; };
  }, [policyId, reload]);
  const parsed = AutomaticAllowanceSchema.pick({calls:true,tokens:true}).safeParse({calls:values.calls.trim()?Number(values.calls):NaN,tokens:values.tokens.trim()?Number(values.tokens):NaN});
  const ceiling = data?.schedules[0]?.policy.monthAllowance;
  const dirty = !!ceiling && (Number(values.calls)!==ceiling.calls || Number(values.tokens)!==ceiling.tokens || !parsed.success);
  async function save() {
    if (!data || !parsed.success) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await window.app.maintenance.command({command:'automaticBudgetSave',policyId,expectedSchedules:data.schedules.map(({id,revision})=>({id,revision})),allowance:parsed.data});
      setSaved(true);
      const next=AutomaticMaintenanceDashboardSchema.parse(await window.app.maintenance.command({command:'automaticDashboard',policyId}));setData(next);const current=next.schedules[0]?.policy.monthAllowance;if(current)setValues({calls:String(current.calls),tokens:String(current.tokens)});
    } catch (error) { setError(errorKey(error)); } finally { setBusy(false); }
  }
  return <section className={card}><div><h4 className="font-semibold">{t('budget.monthly')}</h4><p className="mt-1 text-sm text-muted-foreground">{t('budget.monthlyHint')}</p></div>{error && <div role="alert" className="text-sm text-rose-600">{t(error)} <Button disabled={busy} onClick={()=>{setSaved(false);setReload(n=>n+1);}}>{t('budget.reload')}</Button></div>}{!data ? !error && <p role="status">{t('shell.states.loading')}</p> : !ceiling ? <p className="text-sm text-muted-foreground">{t('automaticMaintenance.notInstalled')}</p> : <>
    <div className="grid gap-3 sm:grid-cols-2">{(['calls','tokens'] as const).map(key => <div key={key} className="rounded-lg bg-soft p-3"><p className="text-xs font-medium text-muted-foreground">{t(key==='calls'?'budget.monthCalls':'budget.monthTokens')} · {data.month} UTC</p><p className="mt-1 text-sm font-medium">{t('budget.used',{values:{used:data.reserved[key].toLocaleString(t.locale),limit:ceiling[key].toLocaleString(t.locale)}})}</p><div role="progressbar" className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" aria-label={t(key==='calls'?'budget.monthCalls':'budget.monthTokens')} aria-valuemin={0} aria-valuemax={Math.max(1,ceiling[key])} aria-valuenow={Math.min(data.reserved[key],Math.max(1,ceiling[key]))}><div className="h-full rounded-full bg-accent" style={{width:`${ceiling[key]===0?100:Math.min(100,data.reserved[key]/ceiling[key]*100)}%`}}/></div><p className="mt-1 text-xs text-muted-foreground">{t('budget.remaining',{values:{count:Math.max(0,ceiling[key]-data.reserved[key]).toLocaleString(t.locale)}})}</p></div>)}</div>
    <form onSubmit={event=>{event.preventDefault();void save();}} className="grid gap-3"><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">{(['calls','tokens'] as const).map(key=><NumberField key={key} name={key} value={values[key]} min={0} max={key==='calls'?1000:10000000} label={t(key==='calls'?'budget.monthCalls':'budget.monthTokens')} hint={t('budget.range',{values:{min:'0',max:(key==='calls'?1000:10000000).toLocaleString(t.locale)}})} onChange={value=>{setValues({...values,[key]:value});setSaved(false);}}/>)}</fieldset>
    {dirty && !parsed.success && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t('budget.invalid')}</p>}
    {parsed.success && (parsed.data.calls<=data.reserved.calls || parsed.data.tokens<=data.reserved.tokens) && <p className="text-sm text-amber-700 dark:text-amber-300">{t('budget.exhausted')}</p>}
    <p className="text-xs text-muted-foreground">{t('budget.monthlyEffect')}</p><div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy||saved||!dirty||!parsed.success}>{t(busy?'budget.saving':'budget.saveMonth')}</Button><Button type="button" disabled={busy||dirty} onClick={()=>{setSaved(false);setReload(n=>n+1);}}>{t('organization.refresh')}</Button>{saved&&<p role="status" className="text-sm text-emerald-600">{t('budget.saved')}</p>}</div></form>
  </>}</section>;
}
function CuratorBudgetSettings({ policyId, t, onSaved }: { policyId: string; t: Translator; onSaved: () => Promise<void> }) {
  const [policy,setPolicy]=useState<AutomaticWikiPolicy|null>(null),[values,setValues]=useState<Record<keyof Limits,string>|null>(null);
  const [error,setError]=useState<MessageKey|null>(null),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[reload,setReload]=useState(0);
  useEffect(()=>{let live=true;void window.app.curator.command({command:'policies'}).then(raw=>{if(!live)return;const current=z.array(AutomaticWikiPolicySchema).parse(raw).find(p=>p.id===policyId);if(!current)throw new Error('organization.errors.policy');setPolicy(current);setValues(drafts(current.limits));setError(null);}).catch(error=>{if(live)setError(errorKey(error));});return()=>{live=false;};},[policyId,reload]);
  const parsed=values?parseCuratorBudget(values):null;
  const dirty=!!policy&&!!values&&curatorBudgetFields.some(key=>values[key]!==drafts(policy.limits)[key]);
  async function save(){
    if(!policy||!parsed)return;setBusy(true);setError(null);setSaved(false);
    try{
      const latest=z.array(AutomaticWikiPolicySchema).parse(await window.app.curator.command({command:'policies'})).find(p=>p.id===policyId);
      if(latest?.revisionId!==policy.revisionId||latest.state!==policy.state)throw new Error('organization.errors.conflict');
      const preview=CuratorPreviewSchema.parse(await window.app.curator.command({command:'preview',input:{policyId,wholeLibrary:policy.scope.wholeLibrary,sourceIds:policy.scope.sourceIds,includeDescendants:policy.scope.includeDescendants,excludedSourceIds:policy.scope.excludedSourceIds,profileOverrideId:policy.profileOverrideId,limits:parsed,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,interpretMemory:policy.operations.includes('interpret_memory'),evolveNotes:policy.operations.includes('evolve_notes')}}));
      const next=AutomaticWikiPolicySchema.parse(await window.app.curator.command({command:'activate',state:policy.state==='paused'?'paused':'enabled',policyId,revisionId:preview.policy.revisionId,previewHash:preview.previewHash}));
      setPolicy(next);setValues(drafts(next.limits));setSaved(true);await onSaved();
    }catch(error){setError(errorKey(error));}finally{setBusy(false);}
  }
  return <section className={card}><div><h4 className="font-semibold">{t('budget.curator')}</h4><p className="mt-1 text-sm text-muted-foreground">{t('budget.curatorHint')}</p></div>{error&&<div role="alert" className="text-sm text-rose-600">{t(error)} <Button disabled={busy} onClick={()=>{setSaved(false);setReload(n=>n+1);}}>{t('budget.reload')}</Button></div>}{!values? !error&&<p role="status">{t('shell.states.loading')}</p>:<form className="grid gap-4" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{curatorBudgetFields.map(key=>{
    const schema=CuratorLimitsSchema.shape[key],scale=key==='deadlineMs'?1000:1,min=key==='deadlineMs'?1:key==='modelCalls'?(Number(values.repairs)?4:2):schema.minValue!/scale;
    return <NumberField key={key} name={key} value={values[key]} min={min} max={schema.maxValue!/scale} label={t(`budget.fields.${key}`)} hint={`${t(`budget.hints.${key}`)} ${t('budget.range',{values:{min:min.toLocaleString(t.locale),max:(schema.maxValue!/scale).toLocaleString(t.locale)}})}`} onChange={value=>{setValues({...values,[key]:value});setSaved(false);}}/>;
  })}</fieldset>{!parsed&&<p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t('budget.curatorInvalid')}</p>}<p className="text-xs text-muted-foreground">{t('budget.curatorEffect')}</p><div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy||!dirty||!parsed}>{t(busy?'budget.saving':'budget.saveCurator')}</Button>{saved&&<p role="status" className="text-sm text-emerald-600">{t('budget.saved')}</p>}</div></form>}</section>;
}
