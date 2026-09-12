import {renderInterpretationHistory} from "./interpretation-projection.js";
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { createDocumentRepository, createObsidianSyncRepository, createObsidianWikiRepository, createWikiRepository, createObsidianEditorialRepository, type PgPool } from '@app/db';
import { WikiPageSchema, type WikiPage } from '@app/domain';
import { translate, type MessageKey } from '@app/i18n';
import { outsideCodeFences, markdownHeading, wikiLink, safeWikiLabel, sectionStart, sectionEnd, sourceOriginalStart, sourceOriginalEnd, type ObsidianLayoutConfig, type ObsidianManagedFrontmatter } from '@app/integration-contracts';
import { layoutLabels, pathIdentity, portableName, sourceLayoutPath } from './obsidian-layout-paths.js';
import type { ObsidianWikiScope } from './obsidian-wiki-projection.js';

export interface MirrorTarget { id: string; type: ObsidianManagedFrontmatter['memoraType']; revision: string; title: string; path: string; editorial: string; generated: string; sourceId?: string; documentId?: string; layout?: ObsidianLayoutConfig; linkMap?:Array<{rendered:string;canonical:string}>; rootSourceId?:string; divisionId?:string; documentRevisionId?:string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const stableId = (key: string) => { const h=digest('memora-layout-v2:'+key); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const INDEX='7cfe90b4-11fb-447d-9673-849b6a3dc000', CATALOG='7cfe90b4-11fb-447d-9673-849b6a3dc001', RELATIONS='7cfe90b4-11fb-447d-9673-849b6a3dc002';
export interface MirrorAsset { id: string; sourceId: string | null; documentId: string | null; originalFileName: string; sha256: string; sizeBytes: number; storageBase: string; relativePath: string; path: string; available: boolean }
/** Both renderers consume the immutable canonical page memberships. Paths have no editorial authority. */
export async function buildObsidianMirror(pool: PgPool, root: string, scope: ObsidianWikiScope, config: ObsidianLayoutConfig, options: { migrate?: boolean; excluded?: Set<string>; assets?: MirrorAsset[] } = {}): Promise<MirrorTarget[]> {
  const repo=createObsidianWikiRepository(pool), registry=await createObsidianSyncRepository(pool).list(), sources=await repo.sources(scope.sourceIds,scope.includeDescendants), notes=await repo.notes(sources.map(s=>s.id),!scope.sourceIds.length);
  if (sources.length>1000 || notes.length>2000) throw new Error('obsidianWiki.errors.limit');
  const allowed=new Set(sources.map(s=>String(s.id))), pages:WikiPage[]=[];
  for (const id of await repo.pages(scope.pageIds)) {
    if (await repo.pageBytes(id)>2_000_000) throw new Error('obsidianWiki.errors.limit');
    const page=WikiPageSchema.parse(await createWikiRepository(pool).get(id));
    if ((!scope.sourceIds.length||page.evidence.every(e=>allowed.has(e.sourceItemId))) && (!page.archived || registry.some(f=>f.memoraId===id))) pages.push(page);
  }
  if(pages.length>1000)throw new Error('obsidianWiki.errors.limit');
  const relations=await repo.relations([...allowed]);
  if(relations.length>1000||relations.some(r=>r.evidence.length>100))throw new Error('obsidianWiki.errors.limit');
  const l=layoutLabels(config.language), t=(key:MessageKey)=>translate(config.language,key), paths=new Map<string,string>(), used=new Map<string,string>(), targets:MirrorTarget[]=[];
  for (const row of registry) if(!options.migrate || options.excluded?.has(row.memoraId)) used.set(pathIdentity(row.relativePath),row.memoraId);
  function reserve(id:string,path:string) {
    const old=registry.find(f=>f.memoraId===id);
    if(old&&!old.relativePath.startsWith(root+'/'))throw new Error('obsidianWiki.errors.binding');
    if(old && (!options.migrate || options.excluded?.has(id))) path=old.relativePath;
    const occupied=used.get(pathIdentity(path));
    if(occupied && occupied!==id) path=path.replace(/\.md$/,` — ${id.slice(0,8)}.md`);
    if(used.has(pathIdentity(path))&&used.get(pathIdentity(path))!==id)path=path.replace(/\.md$/,` — ${id}.md`);if(used.has(pathIdentity(path))&&used.get(pathIdentity(path))!==id)throw new Error('obsidianWiki.errors.conflict');
    if(Buffer.byteLength(path)>900)throw new Error('obsidianWiki.errors.limit');
    used.set(pathIdentity(path),id);paths.set(id,path);return path;
  }
  const sourceDirectories=new Map<string,string>();
  const placeSource=(source:typeof sources[number],seen=new Set<string>()):string=>{if(paths.has(source.id))return paths.get(source.id)!;if(seen.has(source.id))throw new Error('wiki.errors.cycle');seen.add(source.id);let path=sourceLayoutPath(root,{...source,metadata:{...source.fullMetadata,...source.metadata}},sources,config.language);const parent=sources.find(p=>p.id===source.parentId);if(parent){const parentPath=placeSource(parent,seen);path=posix.join(posix.dirname(parentPath),parent.type==='Book'?l.chapters:parent.type==='PeriodicalIssue'?l.articles:l.sections,posix.basename(path));}
    if(['Book','AcademicPaper','PeriodicalIssue'].includes(source.type)||sources.some(p=>p.parentId===source.id)){let directory=posix.dirname(path);if(!['Book','AcademicPaper','PeriodicalIssue'].includes(source.type))directory=posix.join(directory,portableName(source.title));const owner=sourceDirectories.get(pathIdentity(directory));if(owner&&owner!==source.id)directory+=' — '+source.id.slice(0,8);sourceDirectories.set(pathIdentity(directory),source.id);path=posix.join(directory,posix.basename(path));}return reserve(source.id,path);};
  for(const source of sources)placeSource(source);
  for(const note of notes) reserve(note.id,posix.join(root,l.notes,portableName(note.title)+'.md'));
  const pagePath=(page:WikiPage,seen=new Set<string>()):string=>{
    if(paths.has(page.id))return paths.get(page.id)!;
    if(seen.has(page.id))throw new Error('wiki.errors.cycle');seen.add(page.id);
    const parent=pages.find(p=>p.id===page.parentId),role=page.automatic?.role;
    if(role?.kind==='collection' && role.role==='source_toc' && role.owner?.kind==='source' && paths.has(role.owner.id))return reserve(page.id,posix.join(posix.dirname(paths.get(role.owner.id)!),l.sourceNotes+'.md'));
    if(role?.kind==='collection'&&role.role==='topic_toc'&&role.owner?.kind==='page'){const owner=pages.find(p=>p.id===role.owner!.id);if(owner)return reserve(page.id,posix.join(posix.dirname(pagePath(owner,seen)),l.index+'.md'));}
    const area=role?.kind==='synthesis'&&role.role==='investigation'?l.investigations:role?.kind==='collection'&&role.role==='map'?l.maps:page.kind==='topic'?l.topics:page.kind==='entity'?l.entities:page.kind==='synthesis'?l.syntheses:l.maps;
    let directory=posix.join(root,'Wiki',area);
    if(parent){const path=pagePath(parent,seen);directory=parent.kind==='topic'||posix.basename(path)===l.index+'.md'?posix.dirname(path):path.replace(/\.md$/,'');}
    const index=page.kind==='topic'||pages.some(p=>p.parentId===page.id);
    const hasToc=pages.some(p=>p.automatic?.role.kind==='collection'&&p.automatic.role.role==='topic_toc'&&p.automatic.role.owner?.id===page.id);
    return reserve(page.id,index?posix.join(directory,portableName(page.title),(hasToc?portableName(page.title):l.index)+'.md'):posix.join(directory,portableName(page.title)+'.md'));
  };
  for(const page of pages)pagePath(page);
  reserve(INDEX,posix.join(root,'Wiki',l.index+'.md'));reserve(CATALOG,posix.join(root,l.sources,l.index+'.md'));
  reserve(RELATIONS,posix.join(root,'Wiki',t('obsidianWiki.connections'),l.index+'.md'));
  for(const r of relations)reserve(r.id,posix.join(root,'Wiki',t('obsidianWiki.connections'),portableName(r.sourceTitle+' — '+r.targetTitle)+'.md'));
  for(const [key,area] of [['notes',l.notes],['assets',l.assets],['home','']] as const)reserve(stableId(key),posix.join(root,area,(key==='home'?l.home:l.index)+'.md'));
  const missing=new Set(registry.filter(f=>f.status==='deleted'||f.metadata.editorialTombstone).map(f=>f.memoraId));
  const link=(id:string,title:string,kind='source')=>wikiLink(missing.has(id)?undefined:paths.get(id),title,id,kind);
  const list=(items:Array<{id:string;title:string}>,kind='wiki')=>items.map(item=>'- '+link(item.id,item.title,kind)).join('\n');
  const quote=(text:string)=>text.split('\n').map(line=>'> '+line.replace(/<!--\s*memora:/g,'&lt;!-- memora:')).join('\n');
  const references=(text:string)=>text.replace(/<source-ref\b[^>]*\bid=["']([^"']+)["'][^>]*\/?>(?:<\/source-ref>)?/g,(_match,id:string)=>{const source=sources.find(s=>s.id===id);return source?link(id,source.title):t('obsidianWiki.unavailable');}).replace(/<\/?source-ref[^>]*>/g,t('obsidianWiki.unavailable'));
  const typed=(target:{kind:string;id:string})=>{
    const entity=target.kind==='source'?sources.find(s=>s.id===target.id):target.kind==='atomic_note'?notes.find(n=>n.id===target.id):pages.find(p=>p.id===target.id||p.entityId===target.id);
    return entity?link(entity.id,entity.title,target.kind==='source'?'source':'wiki'):t('obsidianWiki.unavailable');
  };
  const add=(target:Omit<MirrorTarget,'path'|'layout'>)=>targets.push({...target,path:paths.get(target.id)!,layout:config});
  for(const source of sources){
    const children=sources.filter(s=>s.parentId===source.id).sort((a,b)=>(a.position??0)-(b.position??0)||a.id.localeCompare(b.id));
    const document=(await createDocumentRepository(pool).listBySourceItem(source.id)).find(d=>d.metadata.processingMode!=='catalog_metadata'&&!d.metadata.supersededByDocumentId);
    let materialized=false;for(const child of children){const doc=(await createDocumentRepository(pool).listBySourceItem(child.id))[0];if(document&&doc?.metadata.derivedFromDocumentId===document.id)materialized=true;}
    const original=document&&!materialized?document.canonicalMarkdown:'';
    let rootSource=source;const seen=new Set<string>();while(rootSource.parentId&&!seen.has(rootSource.id)){seen.add(rootSource.id);const parent=sources.find(s=>s.id===rootSource.parentId);if(!parent)break;rootSource=parent;}
    const documentRevisionId=document?await createObsidianEditorialRepository(pool).documentRevision(pool,document.id):undefined;
    const ownedToc=pages.find(p=>p.automatic?.role.kind==='collection'&&p.automatic.role.role==='source_toc'&&p.automatic.role.owner?.id===source.id);
    const usedBy=pages.filter(p=>p.evidence.some(e=>e.sourceItemId===source.id)||p.automatic?.memberships.some(m=>m.target.kind==='source'&&m.target.id===source.id));
    const bibliography=[source.metadata,...source.bibliography??[]].map(data=>Object.entries(data).filter(([,v])=>v!==null&&v!==undefined).map(([key,value])=>`${safeWikiLabel(key)}: ${safeWikiLabel(typeof value==='string'?value:JSON.stringify(value))}`).join('\n\n')).filter(Boolean).join('\n\n');
    const assets=(options.assets??[]).filter(a=>a.sourceId===source.id||a.sourceId===rootSource.id||a.documentId===document?.id);
    const assetLinks=assets.map(a=>a.available?`- [${safeWikiLabel(a.originalFileName)}](<${posix.relative(posix.dirname(paths.get(source.id)!),a.path)}>)`:`- ${safeWikiLabel(a.originalFileName)} · ${t(config.attachments==='omit'?'obsidianLayout.assetOmitted':'obsidianLayout.assetUnavailable')}`).join('\n');
    const generated=[source.parentId?link(source.parentId,sources.find(p=>p.id===source.parentId)?.title??t('obsidianWiki.unavailable')):'',`## ${t('obsidianLayout.bibliography')}`,bibliography,source.sourceUri?safeWikiLabel(source.sourceUri):'',document?materialized?t('obsidianLayout.materialized'):document.id:t('obsidianWiki.catalogOnly'),source.summary?`## ${t('obsidianLayout.summary')}\n\n${quote(source.summary.text)}\n\n${safeWikiLabel(source.summary.provider)} · ${safeWikiLabel(source.summary.model)} · ${safeWikiLabel(source.summary.runtime)} · ${source.summary.generatedAt} · ${source.summary.stale?t('wiki.needsEvidenceReview'):t('obsidianWiki.current')} · ${source.summary.id}`:'',`## ${t('obsidianLayout.interpretation')}`,ownedToc?.sections.some(s=>s.provenance==='personal')?ownedToc.sections.filter(s=>s.provenance==='personal').map(s=>'[['+paths.get(ownedToc.id)!.replace(/\.md$/,'')+'#^memora-section-'+s.id+'|'+safeWikiLabel(s.title)+']]').join('\n'):t('obsidianLayout.noInterpretation'),list(children,'source'),`## ${l.sourceNotes}`,[ownedToc?link(ownedToc.id,ownedToc.title,'wiki'):'',list(notes.filter(n=>n.sourceId===source.id||n.sourceIds?.includes(source.id)),'note')].filter(Boolean).join('\n\n'),`## ${t('obsidianLayout.usedBy')}`,list(usedBy),`## ${l.assets}`,assetLinks||t('obsidianLayout.assetUnavailable')].filter(Boolean).join('\n\n');
    add({id:source.id,type:document?'source_item':'source_reference',revision:source.updatedAt.toISOString(),title:source.title,sourceId:source.id,rootSourceId:source.rootId??rootSource.id,...(typeof source.fullMetadata?.divisionId==='string'?{divisionId:source.fullMetadata.divisionId}:{}),...(documentRevisionId?{documentRevisionId}:{}),...(document?{documentId:document.id}:{}),editorial:`# ${markdownHeading(source.title)}\n\n${sourceOriginalStart}\n${original}\n${sourceOriginalEnd}\n\n`,generated});
  }
  for(const note of notes){
    const originals=await repo.noteEvidence(note.id,note.evidenceChunkId),evidence=originals.find(e=>e.id===note.evidenceChunkId),source=sources.find(s=>s.id===note.sourceId);
    if(originals.length>100)throw new Error('obsidianWiki.errors.limit');
    if(scope.sourceIds.length&&originals.some(e=>!allowed.has(e.sourceId)))throw new Error('obsidianWiki.errors.binding');
    const memberships=pages.filter(p=>p.automatic?.memberships.some(m=>m.target.kind==='atomic_note'&&m.target.id===note.id));
    const noteState=[t(('knowledge.notes.status.'+note.status) as MessageKey),t(note.current?'obsidianWiki.current':'obsidianWiki.historical'),note.metadata?.humanProtected===true?t('obsidianWiki.protected'):''].filter(Boolean).join(' · ');
    const originalReferences=originals.map((e,i)=>`[${i+1}] ${link(e.sourceId,e.sourceTitle)} · ${e.documentId} · ${e.id} · ${e.sourceSpanId??''} · ${safeWikiLabel(e.locator??'')} · ${t(e.current?'obsidianWiki.current':'obsidianWiki.historical')}\n\n${quote(e.content)}`).join('\n\n');
    add({id:note.id,type:'atomic_note',revision:note.updatedAt.toISOString(),title:note.title,...(note.ownership==='knowledge'?{}:{sourceId:note.sourceId,...(evidence?{documentId:evidence.documentId}:{})}),editorial:`# ${markdownHeading(note.title)}\n\n${note.bodyMarkdown}\n\n`,generated:[noteState,source?link(source.id,source.title):'',originalReferences||t('obsidianWiki.unavailable'),note.successorIds?.map((id:string)=>link(id,notes.find(n=>n.id===id)?.title??id,'note')).join('\n'),list(memberships)].filter(Boolean).join('\n\n')});
  }
  for(const page of pages){
    const linkMap:Array<{rendered:string;canonical:string}>=[];
    const prose=(text:string)=>{const value=references(text),mask=outsideCodeFences(value);return value.replace(/\[([^\]]+)\]\(memora:(page|source|atomic_note|entity)\/([0-9a-f-]{36})\)/g,(canonical,label:string,kind:string,id:string,offset:number)=>{if(!mask.slice(offset,offset+canonical.length).trim())return canonical;const entity=kind==='source'?sources.find(s=>s.id===id):kind==='atomic_note'?notes.find(n=>n.id===id):pages.find(p=>p.id===id||p.entityId===id);if(!entity)return canonical;const rendered=link(entity.id,label,kind==='source'?'source':'wiki');if(!linkMap.some(m=>m.rendered===rendered&&m.canonical===canonical))linkMap.push({rendered,canonical});return rendered;});};
    const renderedSections=page.sections.map(s=>({...s,markdown:prose(s.markdown)}));
    const sectionReferences=page.sections.map(section=>{const assessment=section.assessment,review=assessment?.humanReview==='verified'||(!assessment&&section.provenance==='personal'&&section.evidenceReview==='verified')?t('wiki.reviewed'):t('wiki.needsEvidenceReview');const support=assessment?.support==='validated'&&assessment.sectionRevisionId===section.sectionRevisionId&&assessment.freshness==='current'?assessment.supportMethod==='model_checked'?t('automaticWiki.modelAssessment'):assessment.humanReview==='verified'?t('wiki.reviewed'):t('automaticWiki.assessment'):t('wiki.needsEvidenceReview');return '### '+('[[#^memora-section-'+section.id+'|'+safeWikiLabel(section.title)+']]')+'\n\n'+[t(('wiki.provenanceTypes.'+section.provenance) as MessageKey),section.protected?t('obsidianWiki.protected'):'',review,support].filter(Boolean).join(' · ')+'\n\n'+section.evidenceIds.map((id,i)=>'- ['+(i+1)+'] [[#^memora-evidence-'+id+'|'+safeWikiLabel(page.evidence.find(e=>e.id===id)?.sourceTitle??t('obsidianWiki.unavailable'))+']]').join('\n');}).join('\n\n');
    const groups=page.automatic?.groups??[], memberships=page.automatic?.memberships??[];
    const navigation=groups.map(group=>`## ${markdownHeading(group.title)}\n\n${group.explanation??''}\n\n`+memberships.filter(m=>m.groupId===group.id).sort((a,b)=>a.order-b.order).map(m=>`- ${typed(m.target)}`).join('\n')).join('\n\n');
    const citations=page.evidence.map(e=>`### ${e.id}\n\n${link(e.sourceItemId,e.sourceTitle)} · ${e.documentId} · ${e.chunkId} · ${e.sourceSpanId??''} · ${safeWikiLabel(e.locator??'')} · ${e.current?t('obsidianWiki.current'):t('obsidianWiki.historical')}\n\n${quote(e.excerpt)}\n\n^memora-evidence-${e.id}\n\n[${t('obsidianWiki.openApp')}](memora://open/wiki/${page.id}?revision=${page.revisionId}&evidence=${e.id})`).join('\n\n');
    add({id:page.id,type:'wiki_page',revision:page.revisionId,title:page.title,linkMap,editorial:`# ${markdownHeading(page.title)}\n\n`+renderedSections.map(s=>`${sectionStart(s.id)}\n## ${markdownHeading(s.title)}\n\n${references(s.markdown)}\n${sectionEnd(s.id)}\n\n^memora-section-${s.id}\n`).join('\n')+'\n',generated:[page.archived?t('maintenance.archivedRecoverable'):t(('wiki.'+page.review) as MessageKey),navigation,list(pages.filter(p=>!p.archived&&(p.parentId===page.id||p.automatic?.role.kind==='collection'&&p.automatic.role.owner?.id===page.id))),...(page.automatic?.links??[]).map(typed),sectionReferences,renderInterpretationHistory(page.sections.flatMap(s=>s.interpretations??[]),t),citations,link(INDEX,t('wiki.title'),'wiki')].filter(Boolean).join('\n\n')});
  }
  for(const r of relations)add({id:r.id,type:'source_relation',revision:digest(JSON.stringify(r)),title:r.sourceTitle+' → '+r.targetTitle,editorial:`# ${markdownHeading(r.sourceTitle+' → '+r.targetTitle)}\n\n`,generated:[t('obsidianWiki.readOnly'),t(('sourceRelations.'+r.status) as MessageKey),link(r.source_item_id,r.sourceTitle)+' → '+link(r.target_source_item_id,r.targetTitle),references(r.source_idea),references(r.target_idea),references(r.explanation),...r.evidence.map((e:Record<string,any>)=>`${e.id} · ${e.sourceDocumentId??''} · ${e.targetDocumentId??''} · ${e.current?t('obsidianWiki.current'):t('obsidianWiki.historical')}\n\n${quote(e.snapshot.sourceExcerpt??'')}\n\n${quote(e.snapshot.targetExcerpt??'')}`)].join('\n\n')});
  add({id:RELATIONS,type:'wiki_index',revision:digest(JSON.stringify(relations)),title:t('obsidianWiki.connections'),editorial:`# ${t('obsidianWiki.connections')}\n\n`,generated:list(relations.map(r=>({id:r.id,title:r.sourceTitle+' → '+r.targetTitle}))) });
  const indexes:[string,string,string][]=[[INDEX,t('wiki.title'),list(pages.filter(p=>!p.archived&&!pages.some(parent=>parent.id===p.parentId)))],[CATALOG,l.sources,list(sources,'source')],[stableId('notes'),l.notes,list(notes,'note')],[stableId('assets'),l.assets,(options.assets??[]).map(a=>`${a.originalFileName} · ${a.available?a.path:t('obsidianLayout.assetOmitted')}`).join('\n')],[stableId('home'),l.home,[link(INDEX,t('wiki.title'),'wiki'),link(CATALOG,l.sources,'wiki'),link(stableId('notes'),l.notes,'wiki'),link(stableId('assets'),l.assets,'wiki')].join('\n\n')]];
  for(const [id,title,generated] of indexes)add({id,type:'wiki_index',revision:digest(generated),title,editorial:`# ${markdownHeading(title)}\n\n`,generated});
  if(targets.reduce((sum,t)=>sum+Buffer.byteLength(t.editorial+t.generated),0)>20_000_000)throw new Error('obsidianWiki.errors.limit');
  return targets;
}
