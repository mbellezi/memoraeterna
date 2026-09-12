import type { PgPool } from "../client.js";
import { createJobRepository } from "./jobRepository.js";
import { currentSourceRelationSql, currentSourceRelationEvidenceSql, sourceRelationEvidenceJoins } from "./sourceRelationRepository.js";
export interface ProjectionDelivery {
    id: string;
    memora_id: string;
    revision_id: string;
    binding_hash: string;
    relative_path: string;
    content: string;
    editable_hash: string;
    generated_hash: string;
    rendered_hash: string;
    base_hash: string | null;
    before_content: string | null;
    status: string;
    error: string | null;
}
export function createObsidianWikiRepository(pool: PgPool) {
    return {
        async withTargetLock<T>(id: string, work: () => Promise<T>): Promise<T> { const db = await pool.connect(); try {
            await db.query("select pg_advisory_lock(hashtextextended($1,0))", ["obsidian:" + id]);
            return await work();
        }
        finally {
            await db.query("select pg_advisory_unlock(hashtextextended($1,0))", ["obsidian:" + id]);
            db.release();
        } },
        async enqueue(binding: string, force = false) {
            const db = await pool.connect();
            try {
                await db.query("begin");
                await db.query("insert into obsidian_projection_clock(id,generation) values(1,0) on conflict(id) do nothing");
                const generation = String((await db.query("select generation from obsidian_projection_clock where id=1 for update")).rows[0].generation);
                const jobs = createJobRepository(db), latest = await jobs.latestByType("obsidian-wiki");
                if (latest && (["queued", "running"].includes(latest.status) || (!force && latest.payload.generation === generation && latest.payload.binding === binding))) {
                    await db.query("commit");
                    return latest.id;
                }
                const job = await jobs.create({ type: "obsidian-wiki", payload: { binding, generation }, maxAttempts: 3 });
                await db.query("commit");
                return job.id;
            }
            catch (error) {
                await db.query("rollback");
                throw error;
            }
            finally {
                db.release();
            }
        },
        async sources(sourceIds: string[], includeDescendants: boolean) {
            return (await pool.query(`with recursive scope as(select id from source_items where cardinality($1::uuid[])=0 or id=any($1::uuid[])
        union select s.id from source_items s join scope p on s.parent_source_item_id=p.id where $2)
        select s.id,s.title,s.type,(with recursive ancestry as(select s.id,s.parent_source_item_id,0 depth,array[s.id] visited union all select p.id,p.parent_source_item_id,a.depth+1,a.visited||p.id from source_items p join ancestry a on p.id=a.parent_source_item_id where a.depth<100 and not p.id=any(a.visited)) select id from ancestry order by depth desc limit 1) as "rootId",s.parent_source_item_id as "parentId",s.subtitle,s.source_uri as "sourceUri",s.updated_at as "updatedAt", s.summary as "legacySummary", s.metadata as "fullMetadata",
          (select jsonb_build_object('id',ss.id,'text',ss.summary,'provider',ss.provider,'model',ss.model,'runtime',ss.runtime,'generatedAt',ss.generated_at,'promptVersion',ss.prompt_version,'inputHash',ss.input_hash,'generationId',ss.generation_id,'stale',coalesce(s.metadata->>'summaryStale'='true',false)) from source_summaries ss where ss.source_item_id=s.id and ss.is_current order by ss.generated_at desc,ss.id desc limit 1) as summary,
          (select dv.position from document_divisions dv join document_structures st on st.id=dv.structure_id where dv.child_source_item_id=s.id and st.status in ('confirmed','materialized') order by st.revision desc,dv.position limit 1) as position,
          jsonb_build_object('creators',s.metadata->'creators','publicationDate',s.metadata->'publicationDate','publisher',s.metadata->'publisher') as metadata,
          (select coalesce(jsonb_agg(item),'[]') from (select w.creators,w.identifiers,i.publication_date as "publicationDate",i.publisher,i.edition,i.isbn,i.doi,i.issn from source_item_bibliographic_links l join bibliographic_works w on w.id=l.work_id left join bibliographic_instances i on i.id=l.instance_id where l.source_item_id=s.id order by l.id limit 21) item) as bibliography,
          not exists(select 1 from documents d where d.source_item_id=s.id and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'supersededByDocumentId' is null) as "catalogOnly"
        from source_items s where s.id in(select id from scope) order by s.id limit 1001`, [sourceIds, includeDescendants])).rows;
        },
        async pages(ids:string[]=[]) { return (await pool.query('select id from wiki_pages where cardinality($1::uuid[])=0 or id=any($1::uuid[]) order by id limit 1001',[ids])).rows.map(r => String(r.id)); },
        async pageBytes(id:string){return Number((await pool.query("select octet_length(r.content::text) + coalesce((select sum(octet_length(e.snapshot::text)) from wiki_evidence e where e.page_id=p.id and exists(select 1 from jsonb_array_elements(r.content->'sections') s where s->'evidenceIds' ? e.id::text)),0) as bytes from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where p.id=$1",[id])).rows[0]?.bytes??0);},
        async exportEligible(sourceId:string|null,noteIds:string[],sourceIds:string[],includeDescendants:boolean):Promise<boolean>{
            const row=(await pool.query(`with recursive scope as (
              select id from source_items where cardinality($1::uuid[])=0 or id=any($1::uuid[])
              union select child.id from source_items child join scope parent on child.parent_source_item_id=parent.id where $2
            ) select (exists(select 1 from scope where id=$3) or cardinality($4::uuid[])>0) and not exists(
              select wanted.id from unnest($4::uuid[]) wanted(id) left join atomic_notes n on n.id=wanted.id
              where n.id is null or n.status in('rejected','archived') or (cardinality($1::uuid[])>0 and n.created_from_source_item_id not in(select id from scope))
                or exists(select 1 from atomic_note_evidence e where e.note_id=n.id and cardinality($1::uuid[])>0 and e.source_id not in(select id from scope))
                or exists(select 1 from atomic_note_source_links l where l.atomic_note_id=n.id and l.source_item_id not in(select id from scope))
            ) as allowed`,[sourceIds,includeDescendants,sourceId,noteIds])).rows[0];
            return row?.allowed===true;
        },
        async notes(sourceIds: string[],wholeLibrary=false) {
            return (await pool.query(`select n.id,n.title,n.body_markdown as "bodyMarkdown",n.updated_at as "updatedAt",n.evidence_chunk_id as "evidenceChunkId",n.created_from_source_item_id as "sourceId",n.status,n.metadata,n.ownership, array(select source_id from atomic_note_evidence where note_id=n.id) as "sourceIds",array(select next_id from atomic_note_evolution where previous_id=n.id) as "successorIds",
        (n.supersession_status='current' and not exists(select 1 from atomic_note_evidence e left join chunks c on c.id=e.chunk_id left join documents d on d.id=c.document_id where e.note_id=n.id and (c.id is null or c.content_hash<>e.snapshot->>'contentHash' or d.metadata->>'supersededByDocumentId' is not null)) and nd.id is not null and nd.metadata->>'supersededByDocumentId' is null
          and not exists(select 1 from atomic_note_source_links l left join chunks lc on lc.id=l.chunk_id left join documents ld on ld.id=lc.document_id
            where l.atomic_note_id=n.id and (ld.id is null or ld.metadata->>'supersededByDocumentId' is not null))) as current
        from atomic_notes n left join chunks nc on nc.id=n.evidence_chunk_id left join documents nd on nd.id=nc.document_id
        where ($2 or n.created_from_source_item_id=any($1::uuid[])) and not exists(select 1 from atomic_note_evidence e where e.note_id=n.id and not $2 and not(e.source_id=any($1::uuid[]))) and n.status not in('rejected','archived')
        and not exists(select 1 from atomic_note_source_links l where l.atomic_note_id=n.id and not(l.source_item_id=any($1::uuid[]))) order by n.id limit 2001`, [sourceIds,wholeLibrary])).rows;
        },
        async noteEvidence(noteId:string,primaryChunkId:string) {
            return (await pool.query(`select c.id,c.source_item_id as "sourceId",c.document_id as "documentId",c.source_span_id as "sourceSpanId",c.content,s.title as "sourceTitle",
          coalesce(sp.label,sp.selector,sp.page::text) as locator,d.metadata->>'supersededByDocumentId' is null as current
          from chunks c join documents d on d.id=c.document_id join source_items s on s.id=c.source_item_id left join source_spans sp on sp.id=c.source_span_id
          where (c.id=$1 or c.id in(select chunk_id from atomic_note_source_links where atomic_note_id=$2)) and not exists(select 1 from atomic_note_evidence e where e.note_id=$2 and e.chunk_id=c.id)
          union all select e.chunk_id,e.source_id,(e.snapshot->>'documentId')::uuid,(e.snapshot->>'sourceSpanId')::uuid,e.snapshot->>'excerpt',e.snapshot->>'sourceTitle',e.snapshot->>'locator',coalesce(c.content_hash=e.snapshot->>'contentHash' and d.metadata->>'supersededByDocumentId' is null,false) from atomic_note_evidence e left join chunks c on c.id=e.chunk_id left join documents d on d.id=c.document_id where e.note_id=$2 order by 1 limit 101`,[primaryChunkId,noteId])).rows;
        },
        async relations(sourceIds: string[]) {
            const rows = (await pool.query(`select r.*,a.title as "sourceTitle",b.title as "targetTitle",${currentSourceRelationSql} as current
        from source_relations r join source_items a on a.id=r.source_item_id join source_items b on b.id=r.target_source_item_id
        where r.source_item_id=any($1::uuid[]) and r.target_source_item_id=any($1::uuid[]) order by r.id limit 1001`, [sourceIds])).rows;
            if(rows.length>1000)throw new Error('obsidianWiki.errors.limit');
            let bytes=Buffer.byteLength(JSON.stringify(rows));
            for (const row of rows){
                row.evidence = (await pool.query(`select e.id,e.origin,e.snapshot,${currentSourceRelationEvidenceSql} as current,
        sc.document_id as "sourceDocumentId",tc.document_id as "targetDocumentId",
        coalesce(ss.label,ss.selector,ss.page::text) as "sourceLocator",coalesce(ts.label,ts.selector,ts.page::text) as "targetLocator"
        from source_relation_evidence e ${sourceRelationEvidenceJoins}
        left join source_spans ss on ss.id=sc.source_span_id left join source_spans ts on ts.id=tc.source_span_id
        where e.relation_id=$1 order by e.created_at,e.id limit 101`, [row.id])).rows;
                bytes+=Buffer.byteLength(JSON.stringify(row.evidence));if(bytes>20_000_000)throw new Error('obsidianWiki.errors.limit');
            }
            return rows;
        },
        async latest(memoraId: string, binding: string): Promise<ProjectionDelivery | null> {
            return (await pool.query('select * from obsidian_projection_revisions where memora_id=$1 and binding_hash=$2 order by created_at desc,id desc limit 1', [memoraId, binding])).rows[0] ?? null;
        },
        async base(memoraId: string, binding: string): Promise<ProjectionDelivery | null> {
            return (await pool.query("select * from obsidian_projection_revisions where memora_id=$1 and binding_hash=$2 and status='written' order by created_at desc,id desc limit 1", [memoraId, binding])).rows[0] ?? null;
        },
        async prepare(input: Omit<ProjectionDelivery, "id" | "status" | "error">): Promise<ProjectionDelivery> {
            return (await pool.query(`insert into obsidian_projection_revisions(memora_id,revision_id,binding_hash,relative_path,content,editable_hash,generated_hash,rendered_hash,base_hash,before_content)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`, [input.memora_id, input.revision_id, input.binding_hash, input.relative_path, input.content, input.editable_hash, input.generated_hash, input.rendered_hash, input.base_hash, input.before_content])).rows[0];
        },
        async finish(id: string, status: string, error: string | null = null) { await pool.query('update obsidian_projection_revisions set status=$2,error=$3 where id=$1', [id, status, error]); },
        async conflicts(binding: string) {
            return (await pool.query(`select distinct on(memora_id) id,memora_id,relative_path,status,error from obsidian_projection_revisions
        where binding_hash=$1 order by memora_id,created_at desc,id desc`, [binding])).rows.filter(r => ['conflict', 'error'].includes(r.status)).slice(0, 100);
        },
        async getDelivery(id: string): Promise<ProjectionDelivery | null> { return (await pool.query('select * from obsidian_projection_revisions where id=$1', [id])).rows[0] ?? null; }
    };
}
