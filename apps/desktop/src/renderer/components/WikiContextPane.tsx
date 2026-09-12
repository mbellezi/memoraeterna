import {useEffect,useState} from 'react';
import type {WikiEvidence} from '@app/domain';
import type {Translator} from '@app/i18n';
import {WikiTypedLink} from './WikiTypedLink';
type Result=Awaited<ReturnType<typeof window.app.wiki.context>>;
export function WikiContextPane({pageId,title,view,t,onOpenPage,onOpenSource,onEvidence}:{pageId:string;title:string;view:'notes'|'sources'|'connections';t:Translator;onOpenPage:(id:string)=>void;onOpenSource:(id:string,noteId?:string)=>void;onEvidence:(e:WikiEvidence)=>void}){
 const [data,setData]=useState<Result>({items:[],next:null}),[loading,setLoading]=useState(true),[error,setError]=useState(false),[after,setAfter]=useState<string|null>(null),[retry,setRetry]=useState(0),[map,setMap]=useState(false);
 useEffect(()=>{setAfter(null);},[pageId,view]);
 useEffect(()=>{let live=true;setLoading(true);setError(false);void window.app.wiki.context({pageId,view,after}).then(value=>{if(live)setData(value);}).catch(()=>{if(live)setError(true);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[pageId,view,after,retry]);
 const reason=(value:string)=>['source','reading','parent','child','link','evidence','subtopic','related'].includes(value)?t(('wiki.reason.'+value) as import('@app/i18n').MessageKey):value;
 const open=(item:Result['items'][number])=>item.kind==='page'?onOpenPage(item.id):item.kind==='source'?onOpenSource(item.id):undefined;
 return <section className="mb-8 grid gap-3">
 {loading&&<p role="status">{t('shell.states.loading')}</p>}{error&&<p role="alert">{t('wiki.contextLoadError')} <button onClick={()=>setRetry(n=>n+1)}>{t('shell.actions.retry')}</button></p>}
 {view==='connections'&&<button className="w-fit text-sm text-accent underline" onClick={()=>setMap(!map)}>{t(map?'wiki.connectionList':'wiki.localMap')}</button>}
 {map&&<figure><svg role="img" aria-label={t('wiki.localMap')} viewBox="0 0 640 400" className="max-h-96 w-full rounded-lg bg-surface"><text x="16" y="25" fill="currentColor" fontSize="13">{title.slice(0,60)}</text>{data.items.slice(0,12).map((item,i)=>{const y=55+i*28;return <g key={item.key}><path d={`M20 35 L20 ${y} L180 ${y}`} fill="none" stroke={item.edge==='structural'?'#64748b':item.edge==='evidential'?'#0891b2':'#8b5cf6'} strokeDasharray={item.edge==='semantic'?'4 3':undefined}/><text x="190" y={y+4} fill="currentColor" fontSize="12">{item.title.slice(0,58)}</text></g>;})}</svg><figcaption className="text-xs text-muted-foreground">{t('wiki.mapBounded')}</figcaption></figure>}
 {!loading&&!error&&!data.items.length&&<p className="text-sm text-muted-foreground">{t('wiki.noResults')}</p>}
 <ul className="grid gap-2">{data.items.map(item=><li key={item.key} className="text-sm">{item.kind==='atomic_note'||item.kind==='entity'?<WikiTypedLink pageId={item.viaPageId} target={{kind:item.kind,id:item.id}} t={t} onOpenPage={onOpenPage} onOpenSource={onOpenSource} onEvidence={onEvidence}/>:<button className="text-left text-accent underline underline-offset-4 focus-visible:outline-2" onClick={()=>open(item)}>{item.title}</button>}<span className="ml-2 text-xs text-muted-foreground">{t(`wiki.edge.${item.edge}`)} · {t(`wiki.direction.${item.direction}`)}{view==='connections'&&<> · {reason(item.reason)}{item.viaTitle?' · '+item.viaTitle:''}</>}</span></li>)}</ul>
 <div className="flex gap-3">{after&&<button className="text-sm text-accent" onClick={()=>setAfter(null)}>{t('wiki.back')}</button>}{data.next&&<button className="text-sm text-accent" onClick={()=>setAfter(data.next)}>{t('wiki.loadMore')}</button>}</div>
 </section>;
}
