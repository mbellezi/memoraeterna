import {isDeepStrictEqual} from 'node:util';
import type { SectionAssessment, WikiPageContent } from '@app/domain';
import { createHash, randomUUID } from "node:crypto";
import { createWikiContextRepository } from "./wikiContextRepository.js";
import type { PgPool, PgClient } from "../client.js";
import { currentSourceRelationSql } from "./sourceRelationRepository.js";

interface Content {
  automatic?: WikiPageContent["automatic"];
  title: string; kind: string; parentId: string | null; position: number; archived: boolean;
  aliases: string[]; collectionIds: string[]; entityId: string | null; pinned: boolean; review: string;
  sections: Array<{ sectionRevisionId?:string|undefined; assessment?:SectionAssessment|undefined; id: string; title: string; kind: string; markdown: string; provenance: string; protected: boolean; evidenceReview: string; evidenceIds: string[] }>;
}
interface Query {
  text: string; sourceIds: string[]; includeDescendants: boolean; pageId: string | null;
  kind: string; reviewedOnly: boolean; currentOnly: boolean; limit: number; offset: number;
}
const currentNoteEvidence = `(n.supersession_status='current' and nd.id is not null and nd.metadata->>'supersededByDocumentId' is null
  and not exists(select 1 from atomic_note_source_links link left join chunks lc on lc.id=link.chunk_id left join documents ld on ld.id=lc.document_id
    where link.atomic_note_id=n.id and (ld.id is null or ld.metadata->>'supersededByDocumentId' is not null)))`;
const pageColumns = `p.id, p.current_revision_id as "revisionId", r.number as "revisionNumber", p.updated_at as "updatedAt", r.content`;
const evidenceSql = `select e.id,e.source_item_id as "sourceItemId",e.document_id as "documentId",e.chunk_id as "chunkId",e.source_span_id as "sourceSpanId",
  e.snapshot, coalesce(c.content_hash = e.snapshot->>'contentHash' and d.metadata->>'supersededByDocumentId' is null,false) as current
  from wiki_evidence e left join chunks c on c.id=e.chunk_id left join documents d on d.id=e.document_id where e.page_id=$1`;
const flatten = (row: Record<string, any>) => ({ ...row.content, id: row.id, revisionId: row.revisionId, revisionNumber: row.revisionNumber, updatedAt: new Date(row.updatedAt).toISOString() });

export function createWikiRepository(pool: PgPool) {
  return {
    async linkedTarget(input:{pageId:string;kind:string;id:string}) {
      const content=(await pool.query('select r.content from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where p.id=$1',[input.pageId])).rows[0]?.content;
      if(!content?.automatic||![...content.automatic.links,...content.automatic.memberships.map((m:any)=>m.target)].some((r:any)=>r.kind===input.kind&&r.id===input.id))throw new Error('wiki.errors.invalid');
      const row=input.kind==='source'?(await pool.query("select id,title,id as source_id,'' as markdown from source_items where id=$1",[input.id])).rows[0]:input.kind==='page'?(await pool.query("select id,title,null::uuid as source_id,'' as markdown from wiki_pages where id=$1",[input.id])).rows[0]:input.kind==='entity'?(await pool.query("select id,canonical_name as title,null::uuid as source_id,'' as markdown from entities where id=$1",[input.id])).rows[0]:(await pool.query("select id,coalesce(nullif(title,''),idea_statement) as title,body_markdown as markdown,created_from_source_item_id as source_id,evidence_chunk_id from atomic_notes where id=$1 and status not in('rejected','archived')",[input.id])).rows[0];
      if(!row)return null;
      const evidence=input.kind==='atomic_note'?(await pool.query(`select distinct c.id,c.source_item_id as "sourceItemId",c.document_id as "documentId",c.id as "chunkId",c.source_span_id as "sourceSpanId",c.content_hash as "contentHash",c.content as excerpt,s.title as "sourceTitle",d.created_at as "documentCreatedAt",coalesce(sp.label,sp.selector,sp.page::text) as locator,d.metadata->>'supersededByDocumentId' is null as current from chunks c join source_items s on s.id=c.source_item_id join documents d on d.id=c.document_id left join source_spans sp on sp.id=c.source_span_id where c.id=$1 or c.id in(select chunk_id from atomic_note_source_links where atomic_note_id=$2) order by c.id limit 100`,[row.evidence_chunk_id,input.id])).rows.map(e=>({...e,documentCreatedAt:new Date(e.documentCreatedAt).toISOString()})):[];
      return {kind:input.kind,id:row.id,title:row.title,markdown:row.markdown,sourceItemId:row.source_id,evidence};
    },
    async tree(input:{view?:'children'|'recent'|'pinned';parentId:string|null;after:{position:number;title:string;id:string}|null;limit:number;pathTo?:string|undefined}) {
      // Only metadata is traversed. Every legacy cycle has one deterministic visible root.
      const forest=`with recursive live as(select p.id,p.parent_id,p.position,p.title from wiki_pages p where not p.archived and p.current_revision_id is not null), walk as(select id as start,id,parent_id,array[id] as path from live union all select w.start,p.id,p.parent_id,w.path||p.id from walk w join live p on p.id=w.parent_id where not p.id=any(w.path)), cycle_roots as(select distinct (select min(x::text)::uuid from unnest(path[array_position(path,parent_id):]) x) id from walk where parent_id=any(path)), forest as(select l.id,case when c.id is not null or parent.id is null then null else l.parent_id end parent_id from live l left join live parent on parent.id=l.parent_id left join cycle_roots c on c.id=l.id)`;
      const select=`select ${pageColumns.replace('r.content',"r.content - 'sections' - 'automatic' as content")},f.parent_id as "treeParent",exists(select 1 from forest child where child.parent_id=p.id) as "hasChildren" from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id join forest f on f.id=p.id`;
      const map=(row:Record<string,any>)=>{const {sections:_sections,automatic:_automatic,...item}=flatten(row);return{...item,parentId:row.treeParent,hasChildren:row.hasChildren};};
      if(input.view==='recent'||input.view==='pinned'){const rows=(await pool.query(`${forest} ${select} where ($1='recent' or (r.content->>'pinned')::boolean) order by p.updated_at desc,p.id limit $2`,[input.view,input.limit])).rows;return{items:rows.map(map),next:null,path:[]};}
      const rows=(await pool.query(`${forest} ${select} where f.parent_id is not distinct from $1::uuid and ($2::uuid is null or (p.position,p.title,p.id)>($3,$4,$2::uuid)) order by p.position,p.title,p.id limit $5`,[input.parentId,input.after?.id??null,input.after?.position??0,input.after?.title??'',input.limit+1])).rows;
      const items=rows.slice(0,input.limit).map(map),last=items.at(-1);
      const path=input.pathTo?(await pool.query(`${forest}, ancestors as(select id,parent_id from forest where id=$1 union all select p.id,p.parent_id from forest p join ancestors a on p.id=a.parent_id) ${select} where p.id in(select id from ancestors)`,[input.pathTo])).rows.map(map):[];
      return{items,next:rows.length>input.limit&&last?{position:last.position,title:last.title,id:last.id}:null,path};
    },
    async context(input:{pageId:string;view:string;after:string|null;limit:number}) {
      // Topic TOCs extend their owner context. Historical/cross-source artifacts do not.
      const rows=(await pool.query(`with owners as(select $1::uuid id union select id from wiki_pages where toc_owner_kind='page' and toc_owner_id=$1 and not archived), edges as(
        select m.target_kind kind,m.target_id id,'semantic' edge,'outgoing' direction,(m.snapshot->>'purpose') reason,m.page_id via from wiki_memberships m join owners o on o.id=m.page_id
        union select 'page',m.page_id,'semantic','incoming',(m.snapshot->>'purpose'),m.page_id from wiki_memberships m where m.target_kind='page' and m.target_id=$1
        union select 'page',p.id,'structural','outgoing','child',p.id from wiki_pages p where p.parent_id=$1 and not p.archived
        union select 'page',p.parent_id,'structural','incoming','parent',p.id from wiki_pages p where p.id=$1 and p.parent_id is not null
        union select 'page',p.id,'semantic','incoming','link',p.id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where not p.archived and (r.content->'automatic'->'links' @> jsonb_build_array(jsonb_build_object('kind','page','id',$1::text)) or r.content->'collectionIds' ? $1::text)
        union select link->>'kind',(link->>'id')::uuid,'semantic','outgoing','link',p.id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id join owners o on o.id=p.id cross join lateral jsonb_array_elements(coalesce(r.content->'automatic'->'links','[]')) link
        union select 'source',e.source_item_id,'evidential','outgoing','evidence',o.id from owners o join wiki_pages p on p.id=o.id join wiki_dependencies d on d.revision_id=p.current_revision_id and d.kind='source' join wiki_evidence e on e.page_id=o.id and e.source_item_id=d.input_id
      ), named as(select distinct e.kind,e.id,e.edge,e.direction,e.reason,e.via as "viaPageId",coalesce(p.title,s.title,n.title,n.idea_statement,en.canonical_name,'') title,concat(e.kind,':',e.id,':',e.edge,':',e.direction,':',e.via,':',e.reason) key from edges e left join wiki_pages p on e.kind='page' and p.id=e.id and not p.archived left join source_items s on e.kind='source' and s.id=e.id left join atomic_notes n on e.kind='atomic_note' and n.id=e.id and n.status not in('rejected','archived') left join entities en on e.kind='entity' and en.id=e.id where coalesce(p.id,s.id,n.id,en.id) is not null)
      , contextual as(
       select key,kind,id,title,edge,direction,reason,"viaPageId",jsonb_build_array(jsonb_build_object('viaPageId',"viaPageId",'reason',reason,'edge',edge,'direction',direction)) associations from named where $2='connections'
       union all select kind||':'||id::text,kind,id,max(title),case when bool_or(edge='evidential') then 'evidential' else 'semantic' end,'outgoing',string_agg(distinct reason,', ' order by reason),min("viaPageId"::text)::uuid,jsonb_agg(distinct jsonb_build_object('viaPageId',"viaPageId",'reason',reason,'edge',edge,'direction',direction)) from named where ($2='notes' and kind='atomic_note' or $2='sources' and kind='source') group by kind,id
      ) select c.*,coalesce(p.title,'') as "viaTitle" from contextual c left join wiki_pages p on p.id=c."viaPageId" where ($3::text is null or key>$3) order by key limit $4`,[input.pageId,input.view,input.after,input.limit+1])).rows;
      const items=rows.slice(0,input.limit);return{items,next:rows.length>input.limit?items.at(-1)!.key:null};
    },
    async move(input:{id:string;expectedRevisionId:string;targetId:string;placement:'before'|'after'|'into'}) {
      const db=await pool.connect();try{await db.query('begin');await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        const page=await createWikiRepository(pool).get(input.id),target=await createWikiRepository(pool).get(input.targetId);
        if(!page||!target||page.id===target.id||target.archived||page.revisionId!==input.expectedRevisionId)throw new Error('wiki.errors.conflict');
        const parentId=input.placement==='into'?target.id:target.parentId;
        const siblings=(await db.query('select id from wiki_pages where parent_id is not distinct from $1::uuid and id<>$2 and not archived order by position,title,id',[parentId,page.id])).rows.map(r=>r.id as string);
        const index=input.placement==='into'?siblings.length:siblings.indexOf(target.id)+(input.placement==='after'?1:0);siblings.splice(index,0,page.id);
        // Fractional/numeric positions are an implementation detail; each moved neighbor keeps provenance.
        for(const [position,id]of siblings.entries()){const current=id===page.id?page:await createWikiRepository(pool).get(id);if(!current||id!==page.id&&current.position===position)continue;const {id:_id,revisionId:_revision,revisionNumber:_number,updatedAt:_updated,evidence:_evidence,breadcrumbs:_breadcrumbs,impacts:_impacts,...content}=current;
          await createWikiRepository(pool).save({version:2,id,expectedRevisionId:current.revisionId,content:{...content,parentId,position},evidenceChunkIds:[]},{transaction:db,origin:'human',allocatedTarget:false,humanApproved:true});}
        await db.query('commit');return createWikiRepository(pool).get(page.id);
      }catch(error){await db.query('rollback');throw error;}finally{db.release();}
    },
    async list() {
      const result = await pool.query(`select ${pageColumns} from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id order by p.position, p.title, p.id limit 1000`);
      return result.rows.map((row) => { const { sections: _sections, ...item } = flatten(row); return item; });
    },
    async get(id: string, revisionId?: string) {
      const row = (await pool.query(`select ${pageColumns.replace('p.current_revision_id as "revisionId"', 'r.id as "revisionId"')} from wiki_pages p join wiki_page_revisions r on r.page_id=p.id
        where p.id=$1 and r.id=coalesce($2::uuid,p.current_revision_id)`, [id, revisionId ?? null])).rows[0];
      if (!row) return null;
      const evidence = (await pool.query(evidenceSql, [id])).rows.map(({ snapshot, ...item }) => ({ ...snapshot, ...item }));
      const ids = new Set([...(row.content as Content).sections.flatMap((s) => s.evidenceIds),...((row.content as Content).automatic?.groups.flatMap(g=>g.explanationEvidenceIds)??[])]);
      const breadcrumbs = (await pool.query(`with recursive ancestors as (
        select id,parent_id,title,0 as depth,array[id] as path from wiki_pages where id=$1 union all
        select p.id,p.parent_id,p.title,a.depth+1,a.path||p.id from wiki_pages p join ancestors a on p.id=a.parent_id where not p.id=any(a.path)
        ) select id,title from ancestors order by depth desc`, [id])).rows;
      return { ...flatten(row), evidence: evidence.filter((e) => ids.has(e.id)), breadcrumbs, impacts: await createWikiContextRepository(pool).impacts(id) };
    },
    async history(id: string) {
      return (await pool.query(`select id,number,created_at as "createdAt",origin,content from wiki_page_revisions where page_id=$1 order by number desc limit 100`, [id])).rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
    },
    async save(input: { version?: 2|undefined; id?: string | undefined; expectedRevisionId: string | null; content: Content; evidenceChunkIds: string[] }, authority?: { transaction: PgClient; origin: "organization" | "human"; allocatedTarget: boolean; humanApproved: boolean; revisionId?:string }) {
      const db = authority?.transaction ?? await pool.connect();
      try {
        if (!authority) await db.query("begin");
        // Serializes all placement mutations, including concurrent reciprocal moves.
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        const id = input.id ?? randomUUID();
        const current = (await db.query("select p.*,r.content,r.number from wiki_pages p left join wiki_page_revisions r on r.id=p.current_revision_id where p.id=$1 for update of p", [id])).rows[0];
        if ((input.id && !current && !authority?.allocatedTarget) || (current?.current_revision_id ?? null) !== input.expectedRevisionId) throw new Error("wiki.errors.conflict");
        const content = structuredClone(input.content);
        if(!authority||authority.origin==="human")content.automatic=(current?.content as Content|undefined)?.automatic;
        if(input.version===2&&current){
          const old=current.content as Content; content.automatic=old.automatic;
          for(const previous of old.sections)if(!content.sections.some(s=>s.id===previous.id))content.sections.push(structuredClone(previous));
        }
        if (content.parentId) {
          const ancestors = (await db.query(`with recursive a as (select id,parent_id,array[id] as path,false as cycle from wiki_pages where id=$1 union all
            select p.id,p.parent_id,a.path||p.id,p.id=any(a.path) from wiki_pages p join a on a.parent_id=p.id where not a.cycle) select id,cycle from a`, [content.parentId])).rows;
          if (!ancestors.length || ancestors.some((a) => a.id === id||a.cycle)) throw new Error("wiki.errors.cycle");
        }
        if (content.collectionIds.includes(id)) throw new Error("wiki.errors.cycle");
        if (content.collectionIds.length) {
          const collections = await db.query("select id from wiki_pages where id=any($1::uuid[]) and kind='collection' and not archived", [content.collectionIds]);
          if (collections.rows.length !== new Set(content.collectionIds).size) throw new Error("wiki.errors.invalid");
        }
        if (content.entityId && !(await db.query("select id from entities where id=$1", [content.entityId])).rows.length) throw new Error("wiki.errors.invalid");
        // Every desktop edit is human protected, independently of review state.
        for (const section of content.sections) {
          if (!authority || authority.origin === "human") {
            const old=(current?.content as Content|undefined)?.sections.find(s=>s.id===section.id);
            const same=old&&["title","kind","markdown","evidenceIds"].every(k=>JSON.stringify(old[k as keyof typeof old])===JSON.stringify(section[k as keyof typeof section]));
            if(input.version===2&&same){const verify=section.evidenceReview==='verified'&&old.evidenceReview!=='verified';Object.assign(section,structuredClone(old));if(verify){section.protected=true;section.sectionRevisionId=randomUUID();section.evidenceReview='verified';section.assessment={version:'automatic-wiki-v1',sectionId:section.id,sectionRevisionId:section.sectionRevisionId,humanReview:'verified',support:'validated',reason:'human_verified',inputFingerprint:old.assessment?.inputFingerprint??createHash('sha256').update(JSON.stringify(section.evidenceIds)).digest('hex'),freshness:'current'};}}
            else { section.protected=true;if(input.version===2||old?.sectionRevisionId){section.provenance="personal";section.sectionRevisionId=randomUUID();section.assessment={version:"automatic-wiki-v1",sectionId:section.id,sectionRevisionId:section.sectionRevisionId,humanReview:"unreviewed",support:"unassessed",reason:"prose_changed",inputFingerprint:createHash("sha256").update(JSON.stringify(section)).digest("hex"),freshness:"current"};}}
          }
          else if (!authority.humanApproved && (current?.content as Content | undefined)?.sections.some(s => s.id === section.id && s.protected && !isDeepStrictEqual(s, section))) throw new Error("organization.errors.protected");
          const previous = (current?.content as Content | undefined)?.sections.find((s) => s.id === section.id);
          if (previous && (previous.markdown !== section.markdown || previous.title !== section.title) && section.evidenceIds.length) section.evidenceReview = "needs_review";
        }
        // Retain previous titles as lookup aliases without rewriting prior revisions.
        content.aliases = [...new Set([...content.aliases, ...(current && current.title !== content.title ? [current.title] : [])])].slice(0, 50);
        if (!current) await db.query("insert into wiki_pages(id,title,kind) values($1,$2,$3)", [id, content.title, content.kind]);
        for (const chunkId of new Set(input.evidenceChunkIds)) {
          const chunk = (await db.query(`select c.*,s.title,d.created_at,coalesce(sp.label,sp.selector,sp.page::text) as locator
            from chunks c join source_items s on s.id=c.source_item_id join documents d on d.id=c.document_id left join source_spans sp on sp.id=c.source_span_id where c.id=$1 and c.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and c.chunking_version<>'catalog-metadata-v1'`, [chunkId])).rows[0];
          if (!chunk) throw new Error("wiki.errors.evidence");
          await db.query(`insert into wiki_evidence(page_id,source_item_id,document_id,chunk_id,source_span_id,snapshot)
            values($1,$2,$3,$4,$5,$6) on conflict(page_id,chunk_id) do nothing`, [id, chunk.source_item_id, chunk.document_id, chunkId, chunk.source_span_id,
            { contentHash: chunk.content_hash, excerpt: chunk.content, sourceTitle: chunk.title, documentCreatedAt: new Date(chunk.created_at).toISOString(), locator: chunk.locator }]);
        }
        const evidence = (await db.query(evidenceSql, [id])).rows;
        // New citations may use the selected chunk ID as a transport handle only.
        for (const section of content.sections) section.evidenceIds = [...new Set(section.evidenceIds.map((handle) => {
          const item = evidence.find((e) => e.id === handle || e.chunkId === handle);
          if (!item) throw new Error("wiki.errors.evidence");
          return item.id as string;
        }))];
        if(content.automatic)for(const group of content.automatic.groups)group.explanationEvidenceIds=group.explanationEvidenceIds.map(handle=>{const item=evidence.find(e=>e.id===handle||e.chunkId===handle);if(!item)throw new Error("wiki.errors.evidence");return item.id;});
        for(const section of content.sections)if(section.assessment?.reason==='human_verified'&&section.evidenceIds.some(id=>!evidence.find(e=>e.id===id)?.current))throw new Error('wiki.errors.evidence');
        const revisionId = authority?.revisionId??randomUUID();
        if(content.automatic){content.automatic=structuredClone(content.automatic);for(const member of content.automatic.memberships)member.expectedPageRevisionId=revisionId;}
        await db.query(`insert into wiki_page_revisions(id,page_id,parent_revision_id,number,origin,content,content_hash) values($1,$2,$3,$4,$7,$5,$6)`,
          [revisionId, id, input.expectedRevisionId, (current?.number ?? 0) + 1, content, createHash("sha256").update(JSON.stringify(content)).digest("hex"), authority?.origin ?? "human"]);
        await db.query(`update wiki_pages set current_revision_id=$2,title=$3,kind=$4,parent_id=$5,position=$6,archived=$7,updated_at=now() where id=$1`,
          [id, revisionId, content.title, content.kind, content.parentId, content.position, content.archived]);
        for (const section of content.sections) {
          const previous=(current?.content as Content|undefined)?.sections.find(s=>s.id===section.id);
          if(previous&&previous.markdown===section.markdown&&JSON.stringify(previous.evidenceIds)===JSON.stringify(section.evidenceIds))await db.query(`insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at) select $1,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at from wiki_dependencies where revision_id=$2 and section_id=$3 on conflict do nothing`,[revisionId,input.expectedRevisionId,section.id]);
          for (const evidenceId of section.evidenceIds) {
            const item = evidence.find(e=>e.id===evidenceId)!;
            for (const [kind,inputId] of [['source',item.sourceItemId],['document',item.documentId],['chunk',item.chunkId]]) {
              await db.query('insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing',
                [revisionId,section.id,kind,inputId,item.snapshot.contentHash,item.snapshot,item.current?null:'evidence_unavailable',item.current?null:new Date()]);
            }
          }
          if(previous&&previous.markdown===section.markdown) await db.query(`insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at)
            select $1,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at from wiki_dependencies where revision_id=$2 and section_id=$3 and kind not in('source','document','chunk') on conflict do nothing`,[revisionId,input.expectedRevisionId,section.id]);
        }
        if(content.automatic) {
          for(const group of content.automatic.groups){
            if(input.expectedRevisionId)await db.query('insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at) select $1,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at from wiki_dependencies where revision_id=$2 and section_id=$3 on conflict do nothing',[revisionId,input.expectedRevisionId,group.id]);
            for(const evidenceId of group.explanationEvidenceIds){const item=evidence.find(e=>e.id===evidenceId)!;for(const [kind,inputId]of [['source',item.sourceItemId],['document',item.documentId],['chunk',item.chunkId]])await db.query('insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot) values($1,$2,$3,$4,$5,$6) on conflict do nothing',[revisionId,group.id,kind,inputId,item.snapshot.contentHash,item.snapshot]);}
          }
        }
        if(content.automatic)for(const group of content.automatic.groups){
          await db.query('insert into wiki_toc_groups(id,page_id,revision_id,snapshot) values($1,$2,$3,$4) on conflict(id) do update set revision_id=excluded.revision_id,snapshot=excluded.snapshot',[group.id,id,revisionId,group]);
          await db.query('delete from wiki_memberships where group_id=$1',[group.id]);
          for(const member of content.automatic.memberships.filter(m=>m.groupId===group.id))await db.query('insert into wiki_memberships(id,page_id,group_id,target_kind,target_id,position,snapshot) values($1,$2,$3,$4,$5,$6,$7)',[member.id,id,group.id,member.target.kind,member.target.id,member.order,member]);
        }
        for(const section of content.sections)if(section.assessment)await db.query('insert into wiki_section_assessments(section_revision_id,section_id,page_id,assessment) values($1,$2,$3,$4) on conflict do nothing',[section.sectionRevisionId,section.id,id,section.assessment]);
        if (!authority) await db.query("commit"); return id;
      } catch (error) { if (!authority) await db.query("rollback"); throw error; } finally { if (!authority) db.release(); }
    },
    async search(query: Query) {
      const scope = `with recursive allowed as (
        select id from source_items where cardinality($2::uuid[])=0 or id=any($2::uuid[])
        union select c.id from source_items c join allowed p on c.parent_source_item_id=p.id where $3
      ), scoped as (select id from allowed where $4::uuid is null or id in(
        select e.source_item_id from wiki_evidence e join wiki_pages p on p.id=e.page_id join wiki_page_revisions rev on rev.id=p.current_revision_id
        where e.page_id=$4 and exists(select 1 from jsonb_array_elements(rev.content->'sections') sec where sec->'evidenceIds' ? e.id::text)
      )), source_tree as (select id,title::text as path from source_items where parent_source_item_id is null union all
        select c.id,t.path || ' / ' || c.title from source_items c join source_tree t on c.parent_source_item_id=t.id), results as (`;
      const textMatch = (value: string) => `($1='' or unaccent(lower(${value})) like '%' || unaccent(lower($1)) || '%')`;
      const rows = await pool.query(`${scope}
        select p.id,'page' as kind,p.title,coalesce((select sec->>'markdown' from jsonb_array_elements(r.content->'sections') sec where $1='' or unaccent(lower(sec->>'markdown')) like '%'||unaccent(lower($1))||'%' limit 1),'') as excerpt,null::uuid as "sourceItemId",null::uuid as "targetSourceItemId",
          r.content->>'review' as review,not exists(select 1 from wiki_dependencies dep where dep.revision_id=r.id and dep.stale_reason is not null) and not exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->>'evidenceReview'='needs_review' and not(coalesce(sec->'assessment'->>'support','')='validated' and sec->'assessment'->>'sectionRevisionId'=sec->>'sectionRevisionId' and sec->'assessment'->>'freshness'='current' and (sec->'assessment'->>'humanReview'='verified' or sec->'assessment'->>'supportMethod'='model_checked' and sec->'assessment'->>'supportAuditId' is not null))) and not exists(select 1 from wiki_evidence e left join chunks c on c.id=e.chunk_id left join documents d on d.id=e.document_id where e.page_id=p.id and (c.id is null or c.content_hash<>e.snapshot->>'contentHash' or d.metadata->>'supersededByDocumentId' is not null) and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text)) as current,p.title as breadcrumb,unaccent(lower(p.title))=unaccent(lower($1)) or exists(select 1 from jsonb_array_elements_text(r.content->'aliases') alias where unaccent(lower(alias))=unaccent(lower($1))) as exact
        from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where not p.archived
          and (not $5 or r.content->>'review'='reviewed') and ${textMatch("p.title || ' ' || r.content::text")}
          and (($4::uuid is null and cardinality($2::uuid[])=0) or p.id=$4 or exists(select 1 from wiki_evidence e where e.page_id=p.id and e.source_item_id in(select id from scoped)))
          and (($4::uuid is null and cardinality($2::uuid[])=0) or not exists(select 1 from wiki_evidence e where e.page_id=p.id and e.source_item_id not in(select id from scoped)
            and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text)))
        union all select s.id,'source',s.title,coalesce(s.subtitle,s.source_uri,''),s.id,null::uuid,null,true,t.path,unaccent(lower(s.title))=unaccent(lower($1))
          from source_items s join source_tree t on t.id=s.id where s.id in(select id from scoped) and ${textMatch("s.title || ' ' || coalesce(s.subtitle,'') || ' ' || coalesce(s.source_uri,'') || ' ' || s.metadata::text")}
        union all select c.id,'chunk',s.title,c.content,s.id,null::uuid,null,d.metadata->>'supersededByDocumentId' is null,t.path,false
          from chunks c join source_items s on s.id=c.source_item_id join source_tree t on t.id=s.id join documents d on d.id=c.document_id
          where s.id in(select id from scoped) and c.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and c.chunking_version<>'catalog-metadata-v1' and (not $6 or d.metadata->>'supersededByDocumentId' is null) and ${textMatch("c.content")}
        union all select n.id,'atomic_note',n.idea_statement,n.body_markdown,n.created_from_source_item_id,null::uuid,n.status::text,${currentNoteEvidence},t.path,false
          from atomic_notes n join source_tree t on t.id=n.created_from_source_item_id left join chunks nc on nc.id=n.evidence_chunk_id left join documents nd on nd.id=nc.document_id where n.created_from_source_item_id in(select id from scoped)
          and not exists(select 1 from atomic_note_source_links l where l.atomic_note_id=n.id and l.source_item_id not in(select id from scoped)) and n.status not in('rejected','archived') and (not $5 or n.status='approved') and (not $6 or ${currentNoteEvidence}) and ${textMatch("n.idea_statement || ' ' || n.body_markdown")}
        union all select r.id,'source_relation',a.title || ' → ' || b.title,r.explanation,r.source_item_id,r.target_source_item_id,r.status::text,${currentSourceRelationSql},a.title || ' / ' || b.title,false
          from source_relations r join source_items a on a.id=r.source_item_id join source_items b on b.id=r.target_source_item_id
          where r.source_item_id in(select id from scoped) and r.target_source_item_id in(select id from scoped)
          and (not $5 or r.status='accepted') and (not $6 or (${currentSourceRelationSql} and r.status<>'rejected')) and ${textMatch("r.source_idea || ' ' || r.target_idea || ' ' || r.explanation || ' ' || a.title || ' ' || b.title")}
        union all select e.id,'entity',e.canonical_name,''::text,min(m.source_item_id::text)::uuid,null::uuid,null,true,min(t.path),unaccent(lower(e.canonical_name))=unaccent(lower($1))
          from entities e join entity_mentions m on m.entity_id=e.id join source_tree t on t.id=m.source_item_id join chunks c on c.id=m.chunk_id join documents d on d.id=c.document_id
          where m.source_item_id in(select id from scoped) and (not $6 or d.metadata->>'supersededByDocumentId' is null) and not $5
          and ${textMatch("e.canonical_name || ' ' || e.aliases::text")} group by e.id
        union all select rel.id,'entity_relation',coalesce(rel.metadata->>'displayLabel',''),c.content,rel.source_item_id,null::uuid,null,d.metadata->>'supersededByDocumentId' is null,t.path,false
          from entity_relations rel join chunks c on c.id=rel.evidence_chunk_id join documents d on d.id=c.document_id join source_tree t on t.id=rel.source_item_id
          where rel.source_item_id in(select id from scoped) and not $5 and (not $6 or d.metadata->>'supersededByDocumentId' is null)
          and ${textMatch("coalesce(rel.metadata->>'displayLabel','') || ' ' || c.content")}
      ) select results.*,s.type as "sourceType",case when kind='source' then not exists(select 1 from documents d where d.source_item_id=results.id and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'supersededByDocumentId' is null) else false end as "catalogOnly"
        from results left join source_items s on s.id=results."sourceItemId" where ($7='all' or kind=$7) and (not $6 or current) order by exact desc,case kind when 'page' then 0 when 'source' then 1 else 2 end,results.title,results.id limit $8 offset $9`,
        [query.text, query.sourceIds, query.includeDescendants, query.pageId, query.reviewedOnly, query.currentOnly, query.kind, query.limit + 1, query.offset]);
      return { items: rows.rows.slice(0, query.limit), hasMore: rows.rows.length > query.limit };
    }
  };
}
