import type { PgPool, PgClient } from "../client.js";

export interface WikiContextRecord {
  id: string; kind: "summary" | "atomic_note" | "entity_mention";
  sourceItemId: string; text: string; review: string | null; fingerprint: string;
  chunkIds: string[]; dependencies: Array<{kind:string;id:string;fingerprint:string}>;
}
export const noteFingerprint = (alias:string) => `md5((md5((to_jsonb(${alias})-'updated_at'-'created_at')::text))||coalesce((select string_agg((to_jsonb(l)-'created_at')::text,'|' order by l.id) from atomic_note_source_links l where l.atomic_note_id=${alias}.id),''))`;
export const rowFingerprint = (alias:string) => `md5((to_jsonb(${alias})-'updated_at'-'created_at')::text)`;
const inputTables:Record<string,string>={source:'source_items',document:'documents',chunk:'chunks',atomic_note:'atomic_notes',summary:'source_summaries',entity:'entities',entity_mention:'entity_mentions',source_relation:'source_relations',relation_evidence:'source_relation_evidence',note_relation:'atomic_note_relations'};
export async function validateWikiDependencies(db:Pick<PgClient,'query'>,dependencies:Array<{kind:string;id:string;fingerprint:string}>,lock=false){
  for(const dep of dependencies.toSorted((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id))){
    if(dep.kind==='wiki_page'){const row=(await db.query('select current_revision_id from wiki_pages where id=$1'+(lock?' for share':''),[dep.id])).rows[0];if(row?.current_revision_id!==dep.fingerprint)throw new Error('organization.errors.evidence');continue;}
    if(dep.kind==='wiki_section'){
      if(lock)await db.query("select p.id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->>'id'=$1) for share of p",[dep.id]);
      const current=(await db.query("select md5(sec::text) as fingerprint from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(r.content->'sections') sec where sec->>'id'=$1",[dep.id])).rows;
      if(current.length!==1||current[0]?.fingerprint!==dep.fingerprint)throw new Error('organization.errors.evidence');continue;
    }
    const table=inputTables[dep.kind];if(!table)throw new Error('organization.errors.evidence');
    if(lock&&dep.kind==='atomic_note'){
      // UPDATE blocks FK KEY SHARE for new links; row SHARE locks protect existing
      // links from update/delete. Compute the manifest in a fresh statement only
      // after both locks are held, so concurrent committed changes cannot escape.
      await db.query('select id from atomic_notes where id=$1 for update',[dep.id]);
      await db.query('select id from atomic_note_source_links where atomic_note_id=$1 order by id for share',[dep.id]);
    }
    const row=(await db.query(`select ${dep.kind==='atomic_note'?noteFingerprint('r'):rowFingerprint('r')} as fingerprint from ${table} r where id=$1 ${lock?'for share':''}`,[dep.id])).rows[0];
    if(!row||row.fingerprint!==dep.fingerprint)throw new Error('organization.errors.evidence');
  }
}
export async function addWikiDependency(db:Pick<PgClient,'query'>,revisionId:string,sectionId:string,dep:{kind:string;id:string;fingerprint:string},snapshot:unknown){
  await db.query(`insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot) values($1,$2,$3,$4,$5,$6) on conflict do nothing`,[revisionId,sectionId,dep.kind,dep.id,dep.fingerprint,snapshot]);
}
export function createWikiContextRepository(pool:PgPool){return {
  async contexts(sourceIds:string[],chunkIds:string[],reviewedOnly:boolean):Promise<WikiContextRecord[]>{
    // Optional text is admitted only with complete original provenance in this bounded scope.
    const notes=(await pool.query(`select n.id,'atomic_note' as kind,n.created_from_source_item_id as "sourceItemId",n.idea_statement||E'\\n'||n.body_markdown as text,n.status as review,${noteFingerprint('n')} as fingerprint,
      array(select distinct id from (select n.evidence_chunk_id as id union select l.chunk_id from atomic_note_source_links l where l.atomic_note_id=n.id) refs order by id) as "chunkIds"
      from atomic_notes n join chunks c on c.id=n.evidence_chunk_id join documents d on d.id=c.document_id
      where n.created_from_source_item_id=any($1::uuid[]) and c.source_item_id=n.created_from_source_item_id and n.evidence_chunk_id=any($2::uuid[]) and n.status not in('rejected','archived') and n.supersession_status='current'
      and (not $3 or n.status='approved') and d.metadata->>'supersededByDocumentId' is null
      and not exists(select 1 from atomic_note_source_links l left join chunks lc on lc.id=l.chunk_id left join documents ld on ld.id=lc.document_id where l.atomic_note_id=n.id and (l.source_item_id<>lc.source_item_id or l.source_item_id<>all($1::uuid[]) or l.chunk_id<>all($2::uuid[]) or ld.id is null or ld.metadata->>'supersededByDocumentId' is not null))
      order by n.id limit 20`,[sourceIds,chunkIds,reviewedOnly])).rows;
    const summaries=reviewedOnly?[]:(await pool.query(`select s.id,'summary' as kind,s.source_item_id as "sourceItemId",s.metadata->'concepts' as concepts,${rowFingerprint('s')} as fingerprint
      from source_summaries s join source_items src on src.id=s.source_item_id where s.source_item_id=any($1::uuid[]) and s.is_current and src.metadata->>'summaryStale' is distinct from 'true' and jsonb_typeof(s.metadata->'concepts')='array' order by s.id limit 20`,[sourceIds])).rows;
    const concepts=summaries.flatMap(s=>{
      // summary-v3 concepts carry original chunk IDs; ungrounded legacy strings are navigation only.
      const eligible=(s.concepts as Array<Record<string,unknown>>).filter(c=>Array.isArray(c.evidenceChunkIds)&&c.evidenceChunkIds.length>0&&(c.evidenceChunkIds as string[]).every(id=>chunkIds.includes(id)));
      if(!eligible.length)return [];
      return [{...s,text:JSON.stringify(eligible),review:null,chunkIds:[...new Set(eligible.flatMap(c=>c.evidenceChunkIds as string[]))]}];
    });
    const entities=reviewedOnly?[]:(await pool.query(`select m.id,'entity_mention' as kind,m.source_item_id as "sourceItemId",e.canonical_name as text,null::text as review,${rowFingerprint('m')} as fingerprint,array[m.chunk_id] as "chunkIds",e.id as "entityId",${rowFingerprint('e')} as "entityFingerprint"
      from entity_mentions m join entities e on e.id=m.entity_id join chunks c on c.id=m.chunk_id
      where m.source_item_id=any($1::uuid[]) and m.source_item_id=c.source_item_id and m.chunk_id=any($2::uuid[]) order by m.id limit 20`,[sourceIds,chunkIds])).rows;
    return [...notes,...concepts,...entities].filter(c=>c.text.length<=6000).map(c=>({id:c.id,kind:c.kind,sourceItemId:c.sourceItemId,text:c.text,review:c.review,fingerprint:c.fingerprint,chunkIds:c.chunkIds,dependencies:[{kind:c.kind,id:c.id,fingerprint:c.fingerprint},...(c.entityId?[{kind:'entity',id:c.entityId,fingerprint:c.entityFingerprint}]:[])]}));
  },
  async relationDependencies(evidenceId:string){
    const row=(await pool.query(`select e.*,${rowFingerprint('e')} as fingerprint,${rowFingerprint('r')} as "relationFingerprint" from source_relation_evidence e join source_relations r on r.id=e.relation_id where e.id=$1`,[evidenceId])).rows[0];
    if(!row)throw new Error('organization.errors.evidence');
    const deps=[{kind:'relation_evidence',id:row.id,fingerprint:row.fingerprint},{kind:'source_relation',id:row.relation_id,fingerprint:row.relationFingerprint}];
    for(const [kind,id] of [['atomic_note',row.source_note_id],['atomic_note',row.target_note_id],['note_relation',row.note_relation_id]] as const)if(id){
      const current=(await pool.query(`select ${kind==='atomic_note'?noteFingerprint('r'):rowFingerprint('r')} as fingerprint from ${inputTables[kind]} r where id=$1`,[id])).rows[0];
      if(!current)throw new Error('organization.errors.evidence');deps.push({kind,id,fingerprint:current.fingerprint});
    }
    return deps;
  },
  async validate(deps:Array<{kind:string;id:string;fingerprint:string}>){await validateWikiDependencies(pool,deps);},
  async impacts(pageId:string){return (await pool.query(`select d.id,d.section_id as "sectionId",d.kind,d.input_id as "inputId",d.stale_reason as reason,d.changed_at as "changedAt" from wiki_dependencies d join wiki_pages p on p.current_revision_id=d.revision_id where p.id=$1 and d.stale_reason is not null order by d.section_id,d.kind,d.input_id limit 200`,[pageId])).rows.map(r=>({...r,changedAt:new Date(r.changedAt).toISOString()}));}
};}
