import { createHash, randomUUID } from "node:crypto";
import { createWikiContextRepository } from "./wikiContextRepository.js";
import type { PgPool, PgClient } from "../client.js";
import { currentSourceRelationSql } from "./sourceRelationRepository.js";

interface Content {
  title: string; kind: string; parentId: string | null; position: number; archived: boolean;
  aliases: string[]; collectionIds: string[]; entityId: string | null; pinned: boolean; review: string;
  sections: Array<{ id: string; title: string; kind: string; markdown: string; provenance: string; protected: boolean; evidenceReview: string; evidenceIds: string[] }>;
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
    async list() {
      const result = await pool.query(`select ${pageColumns} from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id order by p.position, p.title, p.id limit 1000`);
      return result.rows.map((row) => { const { sections: _sections, ...item } = flatten(row); return item; });
    },
    async get(id: string, revisionId?: string) {
      const row = (await pool.query(`select ${pageColumns.replace('p.current_revision_id as "revisionId"', 'r.id as "revisionId"')} from wiki_pages p join wiki_page_revisions r on r.page_id=p.id
        where p.id=$1 and r.id=coalesce($2::uuid,p.current_revision_id)`, [id, revisionId ?? null])).rows[0];
      if (!row) return null;
      const evidence = (await pool.query(evidenceSql, [id])).rows.map(({ snapshot, ...item }) => ({ ...snapshot, ...item }));
      const ids = new Set((row.content as Content).sections.flatMap((s) => s.evidenceIds));
      const breadcrumbs = (await pool.query(`with recursive ancestors as (
        select id,parent_id,title,0 as depth from wiki_pages where id=$1 union all
        select p.id,p.parent_id,p.title,a.depth+1 from wiki_pages p join ancestors a on p.id=a.parent_id where a.depth<100
        ) select id,title from ancestors order by depth desc`, [id])).rows;
      return { ...flatten(row), evidence: evidence.filter((e) => ids.has(e.id)), breadcrumbs, impacts: await createWikiContextRepository(pool).impacts(id) };
    },
    async history(id: string) {
      return (await pool.query(`select id,number,created_at as "createdAt",origin,content from wiki_page_revisions where page_id=$1 order by number desc limit 100`, [id])).rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
    },
    async save(input: { id?: string | undefined; expectedRevisionId: string | null; content: Content; evidenceChunkIds: string[] }, authority?: { transaction: PgClient; origin: "organization" | "human"; allocatedTarget: boolean; humanApproved: boolean }) {
      const db = authority?.transaction ?? await pool.connect();
      try {
        if (!authority) await db.query("begin");
        // Serializes all placement mutations, including concurrent reciprocal moves.
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        const id = input.id ?? randomUUID();
        const current = (await db.query("select p.*,r.content,r.number from wiki_pages p left join wiki_page_revisions r on r.id=p.current_revision_id where p.id=$1 for update of p", [id])).rows[0];
        if ((input.id && !current && !authority?.allocatedTarget) || (current?.current_revision_id ?? null) !== input.expectedRevisionId) throw new Error("wiki.errors.conflict");
        const content = structuredClone(input.content);
        if (content.parentId) {
          const ancestors = (await db.query(`with recursive a as (select id,parent_id from wiki_pages where id=$1 union all
            select p.id,p.parent_id from wiki_pages p join a on a.parent_id=p.id) select id from a`, [content.parentId])).rows;
          if (!ancestors.length || ancestors.some((a) => a.id === id)) throw new Error("wiki.errors.cycle");
        }
        if (content.collectionIds.includes(id)) throw new Error("wiki.errors.cycle");
        if (content.collectionIds.length) {
          const collections = await db.query("select id from wiki_pages where id=any($1::uuid[]) and kind='collection' and not archived", [content.collectionIds]);
          if (collections.rows.length !== new Set(content.collectionIds).size) throw new Error("wiki.errors.invalid");
        }
        if (content.entityId && !(await db.query("select id from entities where id=$1", [content.entityId])).rows.length) throw new Error("wiki.errors.invalid");
        // Every desktop edit is human protected, independently of review state.
        for (const section of content.sections) {
          if (!authority || authority.origin === "human") section.protected = true;
          else if (!authority.humanApproved && (current?.content as Content | undefined)?.sections.some(s => s.id === section.id && s.protected && JSON.stringify(s) !== JSON.stringify(section))) throw new Error("organization.errors.protected");
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
        const revisionId = randomUUID();
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
          r.content->>'review' as review,not exists(select 1 from wiki_dependencies dep where dep.revision_id=r.id and dep.stale_reason is not null) and not exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->>'evidenceReview'='needs_review') and not exists(select 1 from wiki_evidence e left join chunks c on c.id=e.chunk_id left join documents d on d.id=e.document_id where e.page_id=p.id and (c.id is null or c.content_hash<>e.snapshot->>'contentHash' or d.metadata->>'supersededByDocumentId' is not null) and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text)) as current,p.title as breadcrumb,unaccent(lower(p.title))=unaccent(lower($1)) or exists(select 1 from jsonb_array_elements_text(r.content->'aliases') alias where unaccent(lower(alias))=unaccent(lower($1))) as exact
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
