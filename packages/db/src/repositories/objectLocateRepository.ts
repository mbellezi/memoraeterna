import type { QueryResultRow } from "pg";

import {
  objectLocateListLimit,
  objectLocatePathLimit,
  objectLocateTopicPathLimit,
  type ObjectLocateResult,
  type ObjectRef,
  type ObjectTopicRef
} from "@app/domain";

import { currentNoteSql } from "./note-relation-sql.js";
import { topicScopeCtes } from "./topicScopeSql.js";
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
 * items of the tree). A topic is its own place: the chain of its ancestors from the root (a retired
 * topic is read through `redirect_to` to the live topic that replaced it); an entity is placed where
 * its mentioning notes are (F5 T119, D11). The tree root and a topic that is not named yet come back with an empty
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
  union all
  -- Live topics of the active tree whose overview cites a passage or span of the source (F2 T31).
  select t.id, coalesce(t.title, '') as title, 'topic' as kind
    from (
      select c.topic_id from topic_overview_citations c
        join chunks ch on ch.id = c.chunk_id
       where ch.source_item_id = $1::uuid
      union
      select c.topic_id from topic_overview_citations c
        join source_spans sp on sp.id = c.source_span_id
       where sp.source_item_id = $1::uuid
    ) cited
    join topics t on t.id = cited.topic_id
   where t.retired_at is null
     and t.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')
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
  -- Live topics of the active tree whose overview cites the note (F2 T31).
  select t.id, coalesce(t.title, '') as title, 'topic' as kind
    from (select distinct c.topic_id from topic_overview_citations c where c.note_id = $1::uuid) cited
    join topics t on t.id = cited.topic_id
   where t.retired_at is null
     and t.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')
)
${finalSelect(
  "(select title from note)",
  `0 as notes,
  (select count(*)::int from atomic_note_source_links where atomic_note_id = $1::uuid) as passages,
  0 as children`
)}`;

/** The most pages shown as citing a topic's notes (F5 T119, spec 3.3). */
export const topicCitingPagesLimit = 10;
/** The most topics an entity is placed in: its primary one and the rest of the top five. */
export const entityPlacementLimit = 5;
/** Longest chain of redirects followed from a retired topic (the same bound as `objects.get`). */
const topicRedirectLimit = 8;

/**
 * A topic: its ancestors up to the root, itself last in the path. A topic that is retired, or that
 * belongs to a tree that is no longer active, resolves through `redirect_to` (a bounded chain) to
 * the live topic that replaced it, and the answer describes that topic; with no live successor it
 * has no place (no row). `citedBy` lists the other live topics of the active tree whose overview
 * cites a note of this topic's subtree, through `topicScopeCtes` (the one definition of a topic's
 * members). $1 topic, $2 ancestors walked, $3 redirects followed, $4 pages shown.
 */
const topicLocateSql = `
with recursive follow(id, redirect_to, dead, depth) as (
  select t.id, t.redirect_to, (t.retired_at is not null or tree.status <> 'active'), 0
    from topics t join topic_trees tree on tree.id = t.tree_id where t.id = $1::uuid
  union all
  select t.id, t.redirect_to, (t.retired_at is not null or tree.status <> 'active'), f.depth + 1
    from follow f
    join topics t on t.id = f.redirect_to
    join topic_trees tree on tree.id = t.tree_id
   where f.dead and f.depth < $3::int
),
live as (select f.id from follow f where not f.dead order by f.depth limit 1),
topic_chain as (
  select t.id, t.parent_id, t.title, 0 as depth from topics t where t.id = (select id from live)
  union all
  select parent.id, parent.parent_id, parent.title, c.depth + 1
    from topic_chain c join topics parent on parent.id = c.parent_id
   where c.depth < $2::int and parent.retired_at is null
),
${topicScopeCtes("(select id from live)")},
cited_by as (
  select t.id, coalesce(t.title, '') as title, 'topic' as kind
    from (
      select distinct c.topic_id from topic_overview_citations c
       where c.note_id in (select note_id from topic_note_ids)
    ) cited
    join topics t on t.id = cited.topic_id
   where t.retired_at is null and t.id <> (select id from live)
     and t.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')
)
select (select coalesce(t.title, '') from topics t where t.id = (select id from live)) as title,
  '[]'::jsonb as path,
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', coalesce(c.title, ''))
                             order by c.depth desc)
              from topic_chain c), '[]'::jsonb) as "topicPath",
  '[]'::jsonb as "alsoIn",
  coalesce((select jsonb_agg(jsonb_build_object('kind', entry.kind, 'id', entry.id, 'title', entry.title)
                             order by entry.title, entry.id)
              from (select * from cited_by order by title, id limit $4::int) entry),
           '[]'::jsonb) as "citedBy",
  0 as "alsoInCount",
  (select count(*)::int from cited_by) as "citedByCount",
  coalesce((select st.n from topic_stats st where st.topic_id = (select id from live)), 0) as notes,
  0 as passages,
  coalesce((select st.children from topic_stats st where st.topic_id = (select id from live)), 0) as children`;

/**
 * An entity: the topics of the active tree where the current notes that mention it are primarily
 * placed, the five with the most notes (ties by title, then ID). The first is its primary place and
 * ends the path with the entity; the rest are `alsoIn`. An entity none of whose notes is placed has
 * the entity alone in its path. $1 entity, $2 topics kept, $3 ancestors walked.
 */
const entityLocateSql = `
with recursive entity as (select e.id, e.canonical_name as title from entities e where e.id = $1::uuid),
mentions as (
  select p.topic_id, count(*)::int as notes
    from atomic_note_entity_links l
    join atomic_notes n on n.id = l.atomic_note_id
    join topic_placements p on p.note_id = n.id and p.rank = 0
     and p.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')
   where l.entity_id = $1::uuid and ${currentNoteSql("n")}
   group by p.topic_id
),
ranked as (
  select m.topic_id, m.notes, coalesce(t.title, '') as title,
         row_number() over (order by m.notes desc, coalesce(t.title, ''), m.topic_id) as place
    from mentions m join topics t on t.id = m.topic_id and t.retired_at is null
),
top_places as (select * from ranked where place <= $2::int),
topic_chain as (
  select t.id, t.parent_id, t.title, 0 as depth
    from top_places tp join topics t on t.id = tp.topic_id where tp.place = 1
  union all
  select parent.id, parent.parent_id, parent.title, c.depth + 1
    from topic_chain c join topics parent on parent.id = c.parent_id
   where c.depth < $3::int and parent.retired_at is null
)
select (select title from entity) as title,
  '[]'::jsonb as path,
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', coalesce(c.title, ''))
                             order by c.depth desc)
              from topic_chain c), '[]'::jsonb) as "topicPath",
  coalesce((select jsonb_agg(jsonb_build_object('kind', 'topic', 'id', tp.topic_id, 'title', tp.title)
                             order by tp.place)
              from top_places tp where tp.place > 1), '[]'::jsonb) as "alsoIn",
  '[]'::jsonb as "citedBy",
  greatest((select count(*)::int from ranked) - 1, 0) as "alsoInCount",
  0 as "citedByCount",
  (select count(*)::int from atomic_note_entity_links l join atomic_notes n on n.id = l.atomic_note_id
    where l.entity_id = $1::uuid and ${currentNoteSql("n")}) as notes,
  0 as passages,
  0 as children`;

function topicRefs(items: ReadonlyArray<{ id: string; title: string }>): ObjectRef[] {
  return items.map(({ id, title }) => ({ kind: "topic" as const, id, title }));
}

function toResult(
  kind: "source" | "note" | "topic" | "entity",
  id: string,
  row: LocateRow | undefined
): ObjectLocateResult | null {
  if (!row || row.title === null) return null;
  if (kind === "topic") {
    // The topic that answers is the end of its own chain: the live one when `id` was redirected.
    const own = row.topicPath.at(-1);
    if (!own) return null;
    id = own.id;
  }
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
    primaryPath: [
      ...topicRefs(row.topicPath),
      ...chain,
      ...(kind === "note" || kind === "entity" ? [object] : [])
    ],
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

    /**
     * Where a topic is: its ancestors from the root, itself last. A retired topic answers for the
     * live topic that replaced it (`object` is that topic); one with no live successor, or no such
     * topic, is null.
     */
    async locateTopic(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(topicLocateSql, [
        id,
        objectLocateTopicPathLimit - 1,
        topicRedirectLimit,
        topicCitingPagesLimit
      ]);
      return toResult("topic", id, result.rows[0]);
    },

    /**
     * Where an entity is: the topics its notes are primarily placed in, top five by count. Null when
     * no such entity exists.
     */
    async locateEntity(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(entityLocateSql, [
        id,
        entityPlacementLimit,
        objectLocateTopicPathLimit - 1
      ]);
      return toResult("entity", id, result.rows[0]);
    },

    /** Where a note is; null when no such note exists. The note itself takes one slot of the path. */
    async locateNote(id: string): Promise<ObjectLocateResult | null> {
      const result = await db.query<LocateRow>(
        noteLocateSql,
        parameters(id, objectLocatePathLimit - 1)
      );
      return toResult("note", id, result.rows[0]);
    },

    /** The statements behind the four `locate` reads, for EXPLAIN in verification. */
    statements: {
      source: sourceLocateSql,
      note: noteLocateSql,
      topic: topicLocateSql,
      entity: entityLocateSql
    }
  };
}
