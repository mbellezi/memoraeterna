import {useEffect,useState}from'react';
import type {z}from'zod';
import type {WikiLinkedTargetSchema,WikiEvidence}from'@app/domain';
import type {Translator}from'@app/i18n';
import {MarkdownPreview}from'./MarkdownEditor';
export function WikiTypedLink({pageId,target,t,onOpenPage,onOpenSource,onEvidence}:{pageId:string;target:{kind:'page'|'source'|'atomic_note'|'entity';id:string};t:Translator;onOpenPage:(id:string)=>void;onOpenSource:(id:string,noteId?:string)=>void;onEvidence:(e:WikiEvidence)=>void}){
 const [value,setValue]=useState<z.infer<typeof WikiLinkedTargetSchema>|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(false),[retry,setRetry]=useState(0),[open,setOpen]=useState(false);
 useEffect(()=>{let live=true;setLoading(true);setError(false);void window.app.wiki.linkedTarget({pageId,...target}).then(v=>{if(live)setValue(v);}).catch(()=>{if(live)setError(true);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[pageId,target.kind,target.id,retry]);
 if(error)return <button className="text-xs text-rose-600" onClick={()=>setRetry(n=>n+1)}>{t('wiki.errors.generic')} · {t('shell.actions.retry')}</button>;
 if(loading)return <span role="status" className="text-xs text-slate-500">{t('shell.states.loading')}</span>;
 if(!value)return <span className="text-xs text-slate-500">{t('wiki.noResults')}</span>;
 return <div className="min-w-0 rounded-lg border border-slate-200 p-3 dark:border-slate-700"><button aria-expanded={target.kind==='atomic_note'?open:undefined} className="text-left text-sm text-cyan-700 dark:text-cyan-300" onClick={()=>{if(target.kind==='page')onOpenPage(target.id);else if(target.kind==='source'&&value.sourceItemId)onOpenSource(value.sourceItemId);else setOpen(!open);}}>{t(`wiki.results.${target.kind}`)} · {value.title}</button>{open&&<div className="mt-3 grid gap-3"><MarkdownPreview markdown={value.markdown} emptyLabel={t('wiki.noResults')}/>{value.evidence.map(e=><button key={e.id} className="text-left text-xs text-cyan-700 dark:text-cyan-300" onClick={()=>onEvidence(e)}>{t('wiki.inspector')} · {e.sourceTitle}</button>)}{value.sourceItemId&&<button className="text-left text-xs underline" onClick={()=>onOpenSource(value.sourceItemId!,target.kind==='atomic_note'?target.id:undefined)}>{t('wiki.openSource')}</button>}</div>}</div>;
}
