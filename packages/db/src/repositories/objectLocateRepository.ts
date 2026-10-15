import type { QueryResultRow } from "pg";

import {
  objectLocateListLimit,
  objectLocatePathLimit,
  type ObjectLocateResult,
  type ObjectPlacement
} from "@app/domain";

import type { Queryable } from "./types.js";

/**
 * Read-only location of an object (`objects.locate`): its primary path from the library root,
 * the other places it appears in (today the legacy wiki pages that include it), the objects that
 * cite it and a few counts, in one statement. Every lookup is by primary key or by an existing
 * index, so the cost does not grow with the size of the library; `npm run db:object-locate:verify`
 * and `scripts/objects/locate-benchmark.ts` check both the answers and the latency on a real
 * database. Canonical tables stay authoritative: nothing here writes.
 *
 * Legacy wiki pages (docs/plan.md F2 wipes them) are presented as topic, entity or question
 * placements marked `legacy`, with the wiki page ID as their ID.
 */
interface LocateRow extends QueryResultRow {
  title: string | null;
  path: Array<{ id: string; title: string }>;
  alsoIn: ObjectPlacement[];
  citedBy: ObjectPlacement[];
  alsoInCount: number;
  citedByCount: number;
  notes: number;
  passages: number;
  children: number;
}

/** The ancestors of a source, itself first: depth 0 is the source, the root has the greatest depth. */
const sourceChain = (start: string) => `chain as (
  select s.id, s.title, s.parent_source_item_id as parent_id, 0 as depth
    from source_items s ${start}
  union all
  select parent.id, parent.title, parent.parent_source_item_id, chain.depth + 1
    from chain join source_items parent on parent.id = chain.parent_id
   where chain.depth < $3::int
)`;

/** Legacy wiki pages as placements: a saved answer is a question, an entity page an entity. */
const pagePlacement = `jsonb_build_object(
  'kind', case page.kind when 'entity' then 'entity' when 'synthesis' then 'question' else 'topic' end,
  'id', page.id, 'title', page.title, 'legacy', true)`;

const finalSelect = (objectTitle: string, citedFrom: string, counts: string) => `
select ${objectTitle} as title,
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) order by c.depth desc)
              from chain c), '[]'::jsonb) as path,
  coalesce((select jsonb_agg(entry.placement order by entry.title, entry.id)
              from (select page.id, page.title, ${pagePlacement} as placement
                      from placed_pages page order by page.title, page.id limit $2::int) entry),
           '[]'::jsonb) as "alsoIn",
  coalesce((select jsonb_agg(entry.placement order by entry.legacy, entry.kind, entry.title, entry.id)
              from (select * from ${citedFrom} order by legacy, kind, title, id limit $2::int) entry),
           '[]'::jsonb) as "citedBy",
  (select count(*)::int from placed_pages) as "alsoInCount",
  (select count(*)::int from ${citedFrom}) as "citedByCount",
  ${counts}`;

const placedPages = (kind: string) => `placed_pages as (
  select distinct page.id, page.title, page.kind
    from wiki_memberships m join wiki_pages page on page.id = m.page_id
   where m.target_kind = '${kind}' and m.target_id = $1::uuid and not page.archived
)`;

/** Current legacy pages that depend on, or hold evidence from, the object. */
const citingPages = (dependency: string, evidence: string | null) => `citing_pages as (
  select page.id, page.title, page.kind
    from wiki_dependencies d
    join wiki_page_revisions r on r.id = d.revision_id
    join wiki_pages page on page.id = r.page_id and page.current_revision_id = r.id
   where d.kind = '${dependency}' and d.input_id = $1::uuid and not page.archived
  ${
    evidence
      ? `union
  select page.id, page.title, page.kind
    from wiki_evidence e join wiki_pages page on page.id = e.page_id
   where e.${evidence} = $1::uuid and not page.archived`
      : ""
  }
)`;

const sourceLocateSql = `
with recursive ${sourceChain("where s.id = $1::uuid")},
${placedPages("source")},
${citingPages("source", "source_item_id")},
linked_notes as (
  select n.id, n.title, n.created_from_source_item_id as from_id, n.status, n.supersession_status as supersession
    from atomic_notes n where n.created_from_source_item_id = $1::uuid
  union
  select n.id, n.title, n.created_from_source_item_id, n.status, n.supersession_status
    from atomic_note_source_links l join atomic_notes n on n.id = l.atomic_note_id
   where l.source_item_id = $1::uuid
  union
  select n.id, n.title, n.created_from_source_item_id, n.status, n.supersession_status
    from atomic_note_evidence e join atomic_notes n on n.id = e.note_id
   where e.source_id = $1::uuid
),
cited_by as (
  select page.id, page.title, true as legacy,
         case page.kind when 'entity' then 'entity' when 'synthesis' then 'question' else 'topic' end as kind,
         ${pagePlacement} as placement
    from citing_pages page
  union all
  select note.id, note.title, false, 'note',
         jsonb_build_object('kind', 'note', 'id', note.id, 'title', note.title, 'legacy', false)
    from linked_notes note
   where note.from_id <> $1::uuid and note.status not in ('rejected', 'archived')
     and note.supersession = 'current'
)
${finalSelect(
  "(select title from chain where depth = 0)",
  "cited_by",
  `(select count(*)::int from linked_notes where status <> 'rejected') as notes,
  (select count(*)::int from chunks c join documents d on d.id = c.document_id
    where c.source_item_id = $1::uuid and not (d.metadata ? 'supersededByDocumentId')) as passages,
  (select count(*)::int from source_items child where child.parent_source_item_id = $1::uuid) as children`
)}`;

const noteLocateSql = `
with recursive note as (
  select n.id, n.title, coalesce(n.owning_source_item_id, n.created_from_source_item_id) as source_id
    from atomic_notes n where n.id = $1::uuid
),
${sourceChain("join note on s.id = note.source_id")},
${placedPages("atomic_note")},
${citingPages("atomic_note", null)},
cited_by as (
  select page.id, page.title, true as legacy,
         case page.kind when 'entity' then 'entity' when 'synthesis' then 'question' else 'topic' end as kind,
         ${pagePlacement} as placement
    from citing_pages page
)
${finalSelect(
  "(select title from note)",
  "cited_by",
  `0 as notes,
  (select count(*)::int from atomic_note_source_links where atomic_note_id = $1::uuid) as passages,
  0 as children`
)}`;

function place(items: ObjectPlacement[]): ObjectPlacement[] {
  return items.map(({ kind, id, title, legacy }) => ({ kind, id, title, legacy }));
}

function toResult(
  kind: "source" | "note",
  id: string,
  row: LocateRow | undefined
): ObjectLocateResult | null {
  if (!row || row.title === null) return null;
  const chain = row.path.map(({ id: itemId, title }) => ({
    kind: "source" as const,
    id: itemId,
    title
  }));
  const object = { kind, id, title: row.title };
  return {
    object,
    // A source ends its own chain; a note hangs from its owning source, when that source exists.
    primaryPath: kind === "source" ? chain : [...chain, object],
    alsoIn: place(row.alsoIn),
    citedBy: place(row.citedBy),
    counts: {
      alsoIn: Number(row.alsoInCount),
      citedBy: Number(row.citedByCount),
      notes: Number(row.notes),
      passages: Number(row.passages),
      children: Number(row.children)
    }
  };
}

export function createObjectLocateRepository(db: Queryable) {
  const parameters = (id: string) => [id, objectLocateListLimit, objectLocatePathLimit - 1];
  return {
    /** Where a source is; null when no such source exists. */
    async locateSource(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(sourceLocateSql, parameters(id));
      return toResult("source", id, result.rows[0]);
    },

    /** Where a note is; null when no such note exists. */
    async locateNote(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(noteLocateSql, parameters(id));
      return toResult("note", id, result.rows[0]);
    },

    /** The statements behind `locateSource` and `locateNote`, for EXPLAIN in verification. */
    statements: { source: sourceLocateSql, note: noteLocateSql }
  };
}
