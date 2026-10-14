import type { PgPool } from "../client.js";

/** Projection authorization, not retrieval: keep unavailable original IDs and all
 * retained derivatives. Related links contribute provenance, never tree placement.
 * UNION terminates cycles without imposing a logical hierarchy depth limit.
 */
export async function scopedProjectionPages(
  db: Pick<PgPool, "query">,
  pageIds: string[],
  allowed: string[]
): Promise<string[]> {
  if (pageIds.length > 1000) throw new Error("obsidianWiki.errors.limit");
  const rows = (
    await db.query(
      `with recursive
    pages as (select p.*,r.content from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id),
    refs(page_id,kind,id) as (
      select page_id,case target_kind when 'page' then 'wiki_page' else target_kind end,target_id from wiki_memberships
      union select p.id,case l->>'kind' when 'page' then 'wiki_page' else l->>'kind' end,(l->>'id')::uuid from pages p cross join lateral jsonb_array_elements(coalesce(p.content->'automatic'->'links','[]')) l
      union select id,case toc_owner_kind when 'page' then 'wiki_page' else toc_owner_kind end,toc_owner_id from pages where toc_owner_id is not null
      union select id,'entity',(content->>'entityId')::uuid from pages where content->>'entityId' is not null
    ), edges(kind,id,target_kind,target_id) as (
      select 'wiki_page',p.id,d.kind,d.input_id from pages p join wiki_dependencies d on d.revision_id=p.current_revision_id
      union select 'wiki_section',(s->>'id')::uuid,'wiki_page',p.id from pages p cross join lateral jsonb_array_elements(p.content->'sections') s
      union select 'wiki_page',page_id,kind,id from refs
      union select 'wiki_page',p.id,'source',e.source_item_id from pages p join wiki_evidence e on e.page_id=p.id where
        exists(select 1 from jsonb_array_elements(p.content->'sections') s where s->'evidenceIds' ? e.id::text)
        or exists(select 1 from jsonb_array_elements(coalesce(p.content->'automatic'->'groups','[]')) g where g->'explanationEvidenceIds' ? e.id::text)
        or exists(select 1 from jsonb_array_elements(p.content->'sections') s cross join lateral jsonb_array_elements(coalesce(s->'interpretations','[]')) i cross join lateral jsonb_array_elements(i->'evidence') original where original->>'chunkId'=e.chunk_id::text)
      union select 'wiki_page',p.id,'source',(e->>'sourceItemId')::uuid from pages p cross join lateral jsonb_array_elements(p.content->'sections') s cross join lateral jsonb_array_elements(coalesce(s->'interpretations','[]')) i cross join lateral jsonb_array_elements(i->'evidence') e
      union select 'wiki_page',p.id,'wiki_page',c.id from pages p join pages c on
        c.toc_owner_kind='page' and c.toc_owner_id=p.id or p.content->'sections'='[]'::jsonb and c.parent_id=p.id
        where not c.archived
      union select 'atomic_note',id,'source',created_from_source_item_id from atomic_notes where created_from_source_item_id is not null
      union select 'atomic_note',note_id,'source',source_id from atomic_note_evidence
      union select 'atomic_note',atomic_note_id,'source',source_item_id from atomic_note_source_links
      union select 'atomic_note',n.id,'source',c.source_item_id from atomic_notes n join chunks c on c.id=n.evidence_chunk_id
      union select 'atomic_note',l.atomic_note_id,'source',c.source_item_id from atomic_note_source_links l join chunks c on c.id=l.chunk_id
      union select 'note_relation',id,'atomic_note',source_atomic_note_id from atomic_note_relations
      union select 'note_relation',id,'atomic_note',target_atomic_note_id from atomic_note_relations
      union select 'relation_evidence',id,'atomic_note',source_note_id from source_relation_evidence where source_note_id is not null
      union select 'relation_evidence',id,'atomic_note',target_note_id from source_relation_evidence where target_note_id is not null
      union select 'relation_evidence',id,'source_relation',relation_id from source_relation_evidence
      union select 'source_relation',id,'source',source_item_id from source_relations
      union select 'source_relation',id,'source',target_source_item_id from source_relations
      union select 'document',id,'source',source_item_id from documents
      union select 'chunk',id,'source',source_item_id from chunks
      union select 'summary',id,'source',source_item_id from source_summaries
      union select 'entity',entity_id,'source',source_item_id from entity_mentions
      union select 'entity_mention',id,'source',source_item_id from entity_mentions
    ), lineage(page_id,kind,id) as (
      select id,'wiki_page'::text,id from pages where id=any($1::uuid[])
      union select l.page_id,e.target_kind,e.target_id from lineage l join edges e on e.kind=l.kind and e.id=l.id
    ) select page_id from lineage group by page_id
      having count(*) filter(where kind='source')>0 and bool_and(kind<>'source' or coalesce(id=any($2::uuid[]),false))`,
      [pageIds, allowed]
    )
  ).rows;
  return rows.map((r) => String(r.page_id));
}
