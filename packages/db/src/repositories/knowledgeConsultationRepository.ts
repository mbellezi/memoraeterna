import {canConsultSection, OrganizationEvidenceSchema, type OrganizationContextSchema} from '@app/domain';
import type {z} from 'zod';
import type {PgPool} from '../client.js';
import {validateWikiDependencies,rowFingerprint} from './wikiContextRepository.js';
type Dependency={kind:string;id:string;fingerprint:string};
export interface CompiledKnowledge {context:z.infer<typeof OrganizationContextSchema>; originals:z.infer<typeof OrganizationEvidenceSchema>[]}
/** Successor retrieval. Legacy Library and original-chunk ranking remain untouched. */
export function createKnowledgeConsultationRepository(pool:PgPool){
 const api={
  async scope(input:{sourceIds:string[];includeDescendants:boolean;pageId:string|null}){
   const allowed=(await pool.query(`with recursive allowed as(select id from source_items where cardinality($1::uuid[])=0 or id=any($1::uuid[]) union select s.id from source_items s join allowed a on s.parent_source_item_id=a.id where $2) select id from allowed order by id`,[input.sourceIds,input.includeDescendants])).rows.map(r=>r.id as string);
   if(!input.pageId)return allowed;
   // Current canonical memberships, owned indexes and section/group evidence define page scope.
   const rows=(await pool.query(`with recursive pages(id) as(select id from wiki_pages where id=$1 and not archived union select p.id from pages parent join wiki_pages p on not p.archived and (p.toc_owner_id=parent.id and p.toc_owner_kind='page' or p.id=(select toc_owner_id from wiki_pages where id=parent.id and toc_owner_kind='page') or p.id in(select target_id from wiki_memberships where page_id=parent.id and target_kind='page'))), refs as(
    select e.source_item_id id from pages p join wiki_pages wp on wp.id=p.id join wiki_page_revisions r on r.id=wp.current_revision_id join wiki_evidence e on e.page_id=p.id where exists(select 1 from jsonb_array_elements(r.content->'sections') s where s->'evidenceIds' ? e.id::text) or exists(select 1 from wiki_toc_groups g where g.page_id=p.id and g.snapshot->'explanationEvidenceIds' ? e.id::text)
    union select wp.toc_owner_id from pages p join wiki_pages wp on wp.id=p.id where wp.toc_owner_kind='source'
    union select m.target_id from wiki_memberships m join pages p on p.id=m.page_id where m.target_kind='source'
    union select c.source_item_id from wiki_memberships m join pages p on p.id=m.page_id join atomic_notes n on m.target_kind='atomic_note' and n.id=m.target_id join chunks c on c.id=n.evidence_chunk_id
    union select l.source_item_id from wiki_memberships m join pages p on p.id=m.page_id join atomic_note_source_links l on m.target_kind='atomic_note' and l.atomic_note_id=m.target_id)
    select distinct id from refs where id=any($2::uuid[]) order by id`,[input.pageId,allowed])).rows;
   return rows.map(r=>r.id as string);
  },
  async originals(ids:string[],allowed:string[]){
   if(!ids.length)return [];
   const rows=(await pool.query(`select c.id as "chunkId",c.source_item_id as "sourceItemId",c.document_id as "documentId",c.source_span_id as "sourceSpanId",c.content_hash as "contentHash",c.content excerpt,s.title as "sourceTitle",d.created_at as "documentCreatedAt",coalesce(sp.label,sp.selector,sp.page::text) locator from chunks c join source_items s on s.id=c.source_item_id join documents d on d.id=c.document_id left join source_spans sp on sp.id=c.source_span_id where c.id=any($1::uuid[]) and c.source_item_id=any($2::uuid[]) and d.metadata->>'supersededByDocumentId' is null and c.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and c.chunking_version<>'catalog-metadata-v1' order by c.id`,[ids,allowed])).rows;
   return rows.filter(r=>r.excerpt.length<=12000).map(r=>OrganizationEvidenceSchema.parse({...r,handle:'',documentCreatedAt:new Date(r.documentCreatedAt).toISOString()}));
  },
  async dependencies(revisionId:string,consumerId:string,allowed:string[],visited=new Set<string>(),reviewedOnly=false):Promise<Dependency[]>{
   const key=revisionId+':'+consumerId;if(visited.has(key)||visited.size>=60)throw new Error('organization.errors.evidence');visited.add(key);
   const rows=(await pool.query('select kind,input_id id,fingerprint,snapshot,stale_reason from wiki_dependencies where revision_id=$1 and section_id=$2 order by kind,input_id',[revisionId,consumerId])).rows;
   if(rows.some(r=>r.stale_reason))throw new Error('organization.errors.evidence');
   const own=(await pool.query("select s,r.content->>'review' review from wiki_page_revisions r cross join lateral jsonb_array_elements(r.content->'sections') s where r.id=$1 and s->>'id'=$2",[revisionId,consumerId])).rows[0];
   if(own){if(own.s.assessment?!canConsultSection(own.s.assessment,own.s.sectionRevisionId,reviewedOnly):own.s.evidenceReview!=='verified'||reviewedOnly&&own.review!=='reviewed')throw new Error('organization.errors.evidence');
    const evidence=(await pool.query("select e.source_item_id,e.chunk_id,e.snapshot from wiki_evidence e join wiki_page_revisions r on r.page_id=e.page_id where r.id=$1 and e.id::text in(select jsonb_array_elements_text($2::jsonb))",[revisionId,JSON.stringify(own.s.evidenceIds)])).rows;
    if(evidence.length!==own.s.evidenceIds.length||evidence.some(e=>!allowed.includes(e.source_item_id)))throw new Error('organization.errors.scope');
    const originals=await api.originals(evidence.map(e=>e.chunk_id),allowed);if(originals.length!==evidence.length||evidence.some(e=>originals.find(o=>o.chunkId===e.chunk_id)?.contentHash!==e.snapshot.contentHash))throw new Error('organization.errors.evidence');
   }
   const result:Dependency[]=[];
   for(const row of rows){const dep={kind:row.kind as string,id:row.id as string,fingerprint:row.fingerprint as string};if(['source','document','chunk'].includes(dep.kind)){
     const table={source:'source_items',document:'documents',chunk:'chunks'}[dep.kind]!;
     const current=(await pool.query(`select r.*,${rowFingerprint('r')} as current_fingerprint from ${table} r where id=$1`,[dep.id])).rows[0];
     if(!current||dep.kind==='document'&&current.metadata?.supersededByDocumentId||dep.kind==='chunk'&&row.snapshot?.contentHash&&current.content_hash!==row.snapshot.contentHash)throw new Error('organization.errors.evidence');dep.fingerprint=current.current_fingerprint;
    }result.push(dep);
    if(dep.kind==='wiki_section'||dep.kind==='wiki_page'){
     const children=(await pool.query(`select r.id revision_id,s->>'id' id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(r.content->'sections') s where not p.archived and ($1='wiki_page' and p.id=$2 or $1='wiki_section' and s->>'id'=$2::text)`,[dep.kind,dep.id])).rows;
     if(!children.length)throw new Error('organization.errors.evidence');
     for(const child of children)result.push(...await api.dependencies(child.revision_id,child.id,allowed,new Set(visited),reviewedOnly));
    }
    const owners=(await pool.query(`select id from source_items where $1='source' and id=$2 union select source_item_id from documents where $1='document' and id=$2 union select source_item_id from chunks where $1='chunk' and id=$2 union select created_from_source_item_id from atomic_notes where $1='atomic_note' and id=$2 union select source_item_id from atomic_note_source_links where $1='atomic_note' and atomic_note_id=$2 union select source_item_id from source_summaries where $1='summary' and id=$2 union select source_item_id from entity_mentions where $1='entity_mention' and id=$2 union select source_item_id from source_relations where $1='source_relation' and id=$2 union select target_source_item_id from source_relations where $1='source_relation' and id=$2
     union select c.source_item_id from source_relation_evidence e join chunks c on c.id=e.source_chunk_id or c.id=e.target_chunk_id where $1='relation_evidence' and e.id=$2
     union select n.created_from_source_item_id from atomic_note_relations r join atomic_notes n on n.id=r.source_atomic_note_id or n.id=r.target_atomic_note_id where $1='note_relation' and r.id=$2
     union select l.source_item_id from atomic_note_relations r join atomic_note_source_links l on l.atomic_note_id=r.source_atomic_note_id or l.atomic_note_id=r.target_atomic_note_id where $1='note_relation' and r.id=$2
     union select m.source_item_id from entity_mentions m where $1='entity' and m.entity_id=$2`,[dep.kind,dep.id])).rows;
    if(!['wiki_page','wiki_section'].includes(dep.kind)&&!owners.length||owners.some(r=>!allowed.includes(r.id)))throw new Error('organization.errors.scope');
    if(['atomic_note','note_relation','relation_evidence'].includes(dep.kind)){
     const invalid=(await pool.query(`select 1 from atomic_notes n where ( $1='atomic_note' and n.id=$2 or $1='note_relation' and n.id in(select source_atomic_note_id from atomic_note_relations where id=$2 union select target_atomic_note_id from atomic_note_relations where id=$2) or $1='relation_evidence' and n.id in(select source_note_id from source_relation_evidence where id=$2 union select target_note_id from source_relation_evidence where id=$2)) and (n.status in('rejected','archived') or n.supersession_status<>'current' or $3 and n.status<>'approved' or not exists(select 1 from chunks c where c.id=n.evidence_chunk_id and c.source_item_id=n.created_from_source_item_id) or exists(select 1 from atomic_note_source_links l left join chunks c on c.id=l.chunk_id where l.atomic_note_id=n.id and (c.id is null or c.source_item_id<>l.source_item_id))) limit 1`,[dep.kind,dep.id,reviewedOnly])).rows;if(invalid.length)throw new Error('organization.errors.evidence');
    }
    const lineage=(await pool.query(`with notes as(select id,evidence_chunk_id from atomic_notes where $1='atomic_note' and id=$2 or $1='note_relation' and id in(select source_atomic_note_id from atomic_note_relations where id=$2 union select target_atomic_note_id from atomic_note_relations where id=$2) or $1='relation_evidence' and id in(select source_note_id from source_relation_evidence where id=$2 union select target_note_id from source_relation_evidence where id=$2)), ids as(select evidence_chunk_id id from notes union select l.chunk_id from notes n join atomic_note_source_links l on l.atomic_note_id=n.id union select source_chunk_id from source_relation_evidence where $1='relation_evidence' and id=$2 union select target_chunk_id from source_relation_evidence where $1='relation_evidence' and id=$2 union select chunk_id from entity_mentions where $1='entity' and entity_id=$2 or $1='entity_mention' and id=$2) select id from ids where id is not null`,[dep.kind,dep.id])).rows.map(r=>r.id as string);
    if(lineage.length){const originals=await api.originals(lineage,allowed);if(originals.length!==lineage.length)throw new Error('organization.errors.evidence');for(const original of originals)for(const [kind,id]of [['source',original.sourceItemId],['document',original.documentId],['chunk',original.chunkId]]){const table={source:'source_items',document:'documents',chunk:'chunks'}[kind!]!;const row=(await pool.query(`select ${rowFingerprint('r')} fingerprint from ${table} r where id=$1`,[id])).rows[0];result.push({kind:kind!,id:id!,fingerprint:row.fingerprint});}}

   }
   await validateWikiDependencies(pool,result);return result;
  },
  async compiled(allowed:string[],question:string,pageId:string|null,reviewedOnly:boolean):Promise<CompiledKnowledge[]>{
   // Rank metadata before originals. Scope checks below run before any prose leaves this repository.
   const rows=(await pool.query(`with recursive page_context(id) as(select id from wiki_pages where id=$3 and not archived union select p.id from page_context c join wiki_pages p on not p.archived and (p.toc_owner_kind='page' and p.toc_owner_id=c.id or p.id=(select toc_owner_id from wiki_pages where id=c.id and toc_owner_kind='page') or p.id in(select target_id from wiki_memberships where page_id=c.id and target_kind='page'))), terms as(select to_tsquery('simple',coalesce(nullif(string_agg(quote_literal(term),' | '),''),'''__empty__''')) q from unnest(tsvector_to_array(to_tsvector('simple',unaccent($2)))) term)
    select p.id page_id,r.id revision_id,s->>'id' id,md5(s::text) fingerprint,s, p.title,
    array(select e.chunk_id from wiki_evidence e where e.page_id=p.id and s->'evidenceIds' ? e.id::text) chunk_ids,
    array(select e.source_item_id from wiki_evidence e where e.page_id=p.id and s->'evidenceIds' ? e.id::text) source_ids
    from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(r.content->'sections') s cross join terms
    where not p.archived and p.role is distinct from 'investigation' and jsonb_array_length(s->'evidenceIds')>0
    and not exists(select 1 from wiki_evidence e where e.page_id=p.id and s->'evidenceIds' ? e.id::text and e.source_item_id<>all($1::uuid[]))
    and not exists(select 1 from wiki_dependencies d where d.revision_id=r.id and d.section_id=(s->>'id')::uuid and d.kind='source' and d.input_id<>all($1::uuid[]))
    and (p.id in(select id from page_context) or ts_rank_cd(to_tsvector('simple',unaccent(p.title||' '||coalesce(r.content->>'aliases','')||' '||coalesce(s->>'title','')||' '||coalesce(s->>'markdown',''))),terms.q)>0)
    order by (p.id in(select id from page_context)) desc,ts_rank_cd(to_tsvector('simple',unaccent(p.title||' '||coalesce(s->>'markdown',''))),terms.q) desc,p.id,s->>'id' limit 60`,[allowed,question,pageId])).rows;
   const result:CompiledKnowledge[]=[];
   for(const row of rows){if(result.length>=6)break;const sec=row.s;
    if(!row.source_ids.length||row.source_ids.some((id:string)=>!allowed.includes(id)))continue;
    if(sec.assessment? !canConsultSection(sec.assessment,sec.sectionRevisionId,reviewedOnly):sec.evidenceReview!=='verified')continue;
    if(reviewedOnly&&!sec.assessment&&(await pool.query("select content->>'review' review from wiki_page_revisions where id=$1",[row.revision_id])).rows[0]?.review!=='reviewed')continue;
    try{const dependencies=await api.dependencies(row.revision_id,row.id,allowed,new Set(),reviewedOnly);const ids=[...new Set<string>([...row.chunk_ids,...dependencies.filter(d=>d.kind==='chunk').map(d=>d.id)])],originals=await api.originals(ids,allowed);if(originals.length!==ids.length||!originals.length)continue;
     const exact=(await pool.query("select chunk_id,snapshot from wiki_evidence where page_id=$1 and id::text in(select jsonb_array_elements_text($2::jsonb))",[row.page_id,JSON.stringify(sec.evidenceIds)])).rows;
     if(exact.length!==sec.evidenceIds.length||exact.some(e=>originals.find(o=>o.chunkId===e.chunk_id)?.contentHash!==e.snapshot.contentHash))continue;
     const text=JSON.stringify({title:sec.title,markdown:sec.markdown,provenance:sec.provenance,review:sec.assessment?.humanReview??sec.evidenceReview});if(text.length>6000)continue;
     result.push({originals,context:{id:row.id,kind:'wiki_section',pageId:row.page_id,revisionId:row.revision_id,sourceItemId:originals[0]!.sourceItemId,text,review:sec.assessment?.humanReview??sec.evidenceReview,fingerprint:row.fingerprint,handles:[],dependencies:[{kind:'wiki_page',id:row.page_id,fingerprint:row.revision_id},{kind:'wiki_section',id:row.id,fingerprint:row.fingerprint},...dependencies]}});
    }catch{/* Ineligible context is never sent; raw authorized originals remain usable. */}
   }
   const groups=(await pool.query(`select g.id,g.page_id,g.revision_id,g.snapshot,md5(g.snapshot::text) fingerprint,r.content->>'review' review,
    array(select e.chunk_id from wiki_evidence e where e.page_id=g.page_id and g.snapshot->'explanationEvidenceIds' ? e.id::text) chunk_ids
    from wiki_toc_groups g join wiki_pages p on p.id=g.page_id and p.current_revision_id=g.revision_id join wiki_page_revisions r on r.id=g.revision_id
    where not p.archived and (not $4 or r.content->>'review'='reviewed')
    and not exists(select 1 from wiki_dependencies d where d.revision_id=g.revision_id and d.section_id=g.id and d.kind='source' and d.input_id<>all($1::uuid[]))
    and not exists(select 1 from wiki_evidence e where e.page_id=g.page_id and g.snapshot->'explanationEvidenceIds' ? e.id::text and e.source_item_id<>all($1::uuid[]))
    and (p.id=$3 or p.toc_owner_id=$3 or to_tsvector('simple',unaccent(p.title||' '||coalesce(g.snapshot->>'title',''))) @@ plainto_tsquery('simple',unaccent($2)))
    and (r.content->>'review'='reviewed' or exists(select 1 from wiki_group_receipts receipt cross join lateral jsonb_array_elements(receipt.targets) target join wiki_page_revisions old on old.id=(target->>'revisionId')::uuid where target->>'pageId'=g.page_id::text and exists(select 1 from jsonb_array_elements(old.content->'automatic'->'groups') original where original=g.snapshot)))
    order by (p.id=$3) desc,g.page_id,g.id limit 12`,[allowed,question,pageId,reviewedOnly])).rows;
   for(const row of groups){if(result.length>=6)break;try{const dependencies=await api.dependencies(row.revision_id,row.id,allowed,new Set(),reviewedOnly),ids=[...new Set<string>([...row.chunk_ids,...dependencies.filter(d=>d.kind==='chunk').map(d=>d.id)])],originals=await api.originals(ids,allowed);if(!originals.length||originals.length!==ids.length)continue;
    const evidence=(await pool.query("select chunk_id,snapshot from wiki_evidence where page_id=$1 and id::text in(select jsonb_array_elements_text($2::jsonb))",[row.page_id,JSON.stringify(row.snapshot.explanationEvidenceIds)])).rows;
    if(evidence.some(e=>originals.find(o=>o.chunkId===e.chunk_id)?.contentHash!==e.snapshot.contentHash))continue;
    const text=JSON.stringify({kind:'toc_navigation',title:row.snapshot.title,explanation:row.snapshot.explanation,provenance:row.snapshot.origin});if(text.length>6000)continue;
    result.push({originals,context:{id:row.id,kind:'wiki_section',pageId:row.page_id,revisionId:row.revision_id,sourceItemId:originals[0]!.sourceItemId,text,review:row.review==='reviewed'?'verified':'unreviewed',fingerprint:row.fingerprint,handles:[],dependencies:[{kind:'wiki_page',id:row.page_id,fingerprint:row.revision_id},...dependencies]}});
   }catch{}}
   return result;
  }
 };return api;
}
