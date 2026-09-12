import {useEffect,useRef,useState} from 'react';
import type {Translator} from '@app/i18n';
export function WikiChildrenLinks({pageId,t,onOpen}:{pageId:string;t:Translator;onOpen:(id:string)=>void}){
 const request=useRef(0),inFlight=useRef(false);
 const [moreLoading,setMoreLoading]=useState(false);
 const [data,setData]=useState<Awaited<ReturnType<typeof window.app.wiki.tree>>|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{const version=++request.current;inFlight.current=false;setMoreLoading(false);let live=true;setData(null);setError(false);void window.app.wiki.tree({parentId:pageId,limit:30}).then(value=>{if(live)setData(value);}).catch(()=>{if(live)setError(true);});return()=>{live=false;};},[pageId,retry]);
 if(error)return <p role="alert" className="my-3 text-sm">{t('wiki.contextLoadError')} <button onClick={()=>setRetry(n=>n+1)}>{t('shell.actions.retry')}</button></p>;
 if(!data)return <p role="status" className="text-xs text-muted-foreground">{t('shell.states.loading')}</p>;
 if(!data.items.length)return null;
 return <section className="my-6"><h2 className="mb-2 text-sm font-medium">{t('wiki.linkedPages')}</h2><ul className="grid gap-1">{data.items.map(page=><li key={page.id}><button className="text-left text-sm text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-current focus-visible:outline-2" onClick={()=>onOpen(page.id)}>{page.title}</button></li>)}</ul>{data.next&&<button disabled={moreLoading} className="mt-3 text-xs text-accent" onClick={()=>{if(inFlight.current)return;inFlight.current=true;setMoreLoading(true);const version=request.current;void window.app.wiki.tree({parentId:pageId,after:data.next,limit:30}).then(next=>{if(version===request.current)setData(current=>current?{...next,items:[...new Map([...current.items,...next.items].map(item=>[item.id,item])).values()]}:next);}).catch(()=>{if(version===request.current)setError(true);}).finally(()=>{if(version===request.current){inFlight.current=false;setMoreLoading(false);}});}}>{t('wiki.loadMore')}</button>}</section>;
}
