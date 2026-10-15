import type { QueryResultRow } from "pg";

import {
  objectLocateListLimit,
  objectLocatePathLimit,
  objectLocateTopicPathLimit,
  type ObjectLocateResult,
  type ObjectRef,
  type ObjectTopicRef
} from "@app/domain";

import type { Queryable } from "./types.js";

/**
 * Read-only location of an object (`objects.locate`, docs/f2-decisions.md D24): its primary path
 * (the topics from the root of the active tree down to the topic it is placed in, then the source
 * chain from the library root), its secondary topic placements, the objects that cite it and a few
 * counts, in one statement. Every lookup is by primary key or by an existing index, so the cost
 * does not grow with the size of the library; `npm run db:object-locate:verify` and
 * `scripts/objects/locate-benchmark.ts` check both the answers and the latency on a real
 * database. Canonical tables stay authoritative: nothing here writes, and a library with no active
 * tree, or an object the tree does not hold yet, simply has no topic entries.
 *
 * A note is placed on its own; a source is placed through its root source (only root sources are
 * items of the tree). The tree root and a topic that is not named yet come back with an empty
 * title: no placeholder is stored (D11) and the interface localizes the label.
 */
interface LocateRow extends QueryResultRow {
  title: string | null;
  /** The source chain, root first. */
  path: Array<{ id: string; title: string }>;
  /** The topics from the tree root to the primary topic, root first; empty when not placed. */
  topicPath: Array<{ id: string; title: string }>;
  alsoIn: ObjectTopicRef[];
  citedBy: ObjectRef[];
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

/**
 * The placements of one item in the active tree: its note, or the root source of a chain. A retired
 * tree keeps its rows, so the active one is chosen first (a partial unique index holds it).
 */
const placements = (itemFilter: string) => `placed as (
  select p.topic_id, p.rank
    from topic_placements p
   where ${itemFilter}
     and p.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')
)`;

/** The primary topic and its ancestors up to the root, the primary topic first. */
const topicChain = `topic_chain as (
  select t.id, t.parent_id, t.title, 0 as depth
    from placed join topics t on t.id = placed.topic_id
   where placed.rank = 0 and t.retired_at is null
  union all
  select parent.id, parent.parent_id, parent.title, topic_chain.depth + 1
    from topic_chain join topics parent on parent.id = topic_chain.parent_id
   where topic_chain.depth < ${objectLocateTopicPathLimit - 1} and parent.retired_at is null
)`;

/** The secondary placements, in rank order. */
const alsoInTopics = `also_in as (
  select t.id, coalesce(t.title, '') as title, placed.rank
    from placed join topics t on t.id = placed.topic_id
   where placed.rank > 0 and t.retired_at is null
)`;

const finalSelect = (objectTitle: string, counts: string) => `
select ${objectTitle} as title,
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) order by c.depth desc)
              from chain c), '[]'::jsonb) as path,
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', coalesce(c.title, ''))
                             order by c.depth desc)
              from topic_chain c), '[]'::jsonb) as "topicPath",
  coalesce((select jsonb_agg(jsonb_build_object('kind', 'topic', 'id', a.id, 'title', a.title)
                             order by a.rank, a.id)
              from also_in a), '[]'::jsonb) as "alsoIn",
  coalesce((select jsonb_agg(jsonb_build_object('kind', entry.kind, 'id', entry.id, 'title', entry.title)
                             order by entry.kind, entry.title, entry.id)
              from (select * from cited_by order by kind, title, id limit $2::int) entry),
           '[]'::jsonb) as "citedBy",
  (select count(*)::int from also_in) as "alsoInCount",
  (select count(*)::int from cited_by) as "citedByCount",
  ${counts}`;

const sourceLocateSql = `
with recursive ${sourceChain("where s.id = $1::uuid")},
${placements(`p.source_item_id = (select c.id from chain c order by c.depth desc limit 1)`)},
${topicChain},
${alsoInTopics},
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
  select note.id, note.title, 'note' as kind
    from linked_notes note
   where note.from_id <> $1::uuid and note.status not in ('rejected', 'archived')
     and note.supersession = 'current'
)
${finalSelect(
  "(select title from chain where depth = 0)",
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
${placements(`p.note_id = $1::uuid`)},
${topicChain},
${alsoInTopics},
cited_by as (
  -- Overviews that cite a note join here with the overview tables (F2 T31).
  select null::uuid as id, null::text as title, null::text as kind where false
)
${finalSelect(
  "(select title from note)",
  `0 as notes,
  (select count(*)::int from atomic_note_source_links where atomic_note_id = $1::uuid) as passages,
  0 as children`
)}`;

function topicRefs(items: ReadonlyArray<{ id: string; title: string }>): ObjectRef[] {
  return items.map(({ id, title }) => ({ kind: "topic" as const, id, title }));
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
    // Topics first, then the source chain; a source ends its own chain and a note hangs from its
    // owning source, when that source exists.
    primaryPath: [...topicRefs(row.topicPath), ...chain, ...(kind === "note" ? [object] : [])],
    // Only the contract's fields pass; the process boundary validates their values.
    alsoIn: row.alsoIn.map(({ kind: otherKind, id: otherId, title }) => ({
      kind: otherKind,
      id: otherId,
      title
    })),
    citedBy: row.citedBy.map(({ kind: citedKind, id: citedId, title }) => ({
      kind: citedKind,
      id: citedId,
      title
    })),
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
  // The walk stops at depth `pathLimit - 1`, so the chain holds at most `pathLimit` sources.
  const parameters = (id: string, pathLimit: number) => [id, objectLocateListLimit, pathLimit - 1];
  return {
    /** Where a source is; null when no such source exists. */
    async locateSource(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(
        sourceLocateSql,
        parameters(id, objectLocatePathLimit)
      );
      return toResult("source", id, result.rows[0]);
    },

    /** Where a note is; null when no such note exists. The note itself takes one slot of the path. */
    async locateNote(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(
        noteLocateSql,
        parameters(id, objectLocatePathLimit - 1)
      );
      return toResult("note", id, result.rows[0]);
    },

    /** The statements behind `locateSource` and `locateNote`, for EXPLAIN in verification. */
    statements: { source: sourceLocateSql, note: noteLocateSql }
  };
}
