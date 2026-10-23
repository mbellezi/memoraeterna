import type { QueryResultRow } from "pg";

import {
  topicReadLimits,
  type TopicChangeSet,
  type TopicChangeSetSummary,
  type TopicCentralNote,
  type TopicContributingSource,
  type TopicHealth,
  type TopicItemKind,
  type TopicItemLeaf,
  type TopicLastChange,
  type TopicManagement,
  type TopicMessageParams,
  type TopicNameState,
  type TopicNodeSummary,
  type TopicNotes,
  type TopicPageTopic,
  type TopicPathEntry,
  type TopicRelationStances,
  type TopicShape,
  type TopicShapeNode,
  type TopicShapeWarning,
  type TopicSubtopic,
  type TopicTree,
  type TopicUndoAvailability
} from "@app/domain";
import { StructureEventSchema, isRedirectEvent } from "@app/domain/topic-tree";
import type { StructureEvent } from "@app/domain/topic-tree";

import type { PgPool } from "../client.js";
import { shownNoteRelationSql } from "./note-relation-sql.js";
import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

// Read model of the topic screens (F2 T16): the navigator's children and leaves, the Topic page's
// map of content, the Shape cells and the before and after of a change-set. Everything here reads
// and nothing writes (the engine writes the topic tables through `topicTreeRepository` alone, D9):
// a multi-statement read runs in one `repeatable read, read only` snapshot, so an answer is never a
// mixture of two generations.
//
// Counting is derived from what the engine keeps exact: `items` of a topic is the sum of
// `topic_stats.direct_items` over its subtree (primary placements, notes and sources), so the cost
// of a navigator page follows the number of topics, never the number of notes. Every statement
// reaches `topic_placements`, `atomic_notes` and `atomic_note_relations` through an index
// (`scripts/topics/read-benchmark.ts` EXPLAINs the statements below on a 30,000-note library).

type Snapshot = Queryable;

/** Bounds of the repository's own work. */
export const topicReadDefaults = {
  /** The most central notes of a topic whose relations feed the stance and neighbour counts. */
  relationNotes: 100,
  /** Notes each topic of a large subtree offers to that sample (a lone leaf offers them all). */
  relationNotesPerTopic: 5,
  /** Strongest relations read per note. */
  relationsPerNote: 50,
  /** Neighbouring leaves returned for the service to lift. */
  relatedLeaves: 200,
  /** Days "new this week" and "moved from" look back. */
  recentDays: 7,
  /** Events of one change-set read for a before and after (a build has many more). */
  changeSetEvents: 5_000,
  /** Violations read for the Shape warnings and counts. */
  violations: 5_000,
  /** Ancestors above a topic (the root and the depth cap bound a path to `pathMax` topics). */
  pathHops: topicReadLimits.pathMax - 1,
  /** Redirects followed from a retired topic. */
  redirectHops: 8
} as const;

export type TopicReadErrorCode = "invalidCursor";

/** A refused call (a malformed cursor); a missing object is a null answer. */
export class TopicReadError extends Error {
  override readonly name = "TopicReadError";
  constructor(
    readonly code: TopicReadErrorCode,
    message: string
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// SQL (exported so the benchmark can EXPLAIN exactly what the repository runs)

/** Origins whose placements count as "new this week": content arriving, not the tree being built. */
const arrivalOrigins = "('place', 'gate', 'human')";
/** Origins "changed today" lists: structure that changed, not routine placements. */
const structuralOrigins = "('rebalance', 'audit', 'areas', 'naming', 'human', 'rebuild')";
/** Notes the tree places: neither discarded nor archived (superseded notes are filtered by the engine). */
const liveNote = "n.status not in ('rejected', 'archived')";
/** Later change-sets up to which an undo check reads them one by one rather than by index lookups. */
const blockedScanLimit = 400;

/**
 * One step down the tree: the live children of `sub.id`. Each parent is probed through the index on
 * (tree, parent, position) by itself (the fence keeps the planner from scanning the whole tree and
 * filtering it against the working table), so the cost follows the size of the subtree whatever the
 * statistics say: a table that was just filled and not analyzed yet still plans well.
 */
const childrenOf = (parent: string) => `cross join lateral (
        select k.id from topics k
         where k.tree_id = $1 and k.parent_id = ${parent} and k.retired_at is null offset 0) c`;

/**
 * $1 tree, `since` the parameter holding the start: primary placements of the last days per topic.
 * The recent change-sets come first and the events of each are read through the index on the
 * change-set (the fences keep the planner from starting at the events, which are the largest table
 * here, whatever it believes about the filters).
 */
const recentPlacementsSql = (since: number) => `select e.topic_id, count(*)::int as n
    from (
      select cs.id from topic_change_sets cs
       where cs.tree_id = $1 and cs.created_at >= $${since}::timestamptz and cs.status = 'applied'
         and cs.origin in ${arrivalOrigins} offset 0) c
    cross join lateral (
      select ev.topic_id from topic_structure_events ev
       where ev.change_set_id = c.id and ev.op = 'item.place' and (ev.after ->> 'rank') = '0'
       offset 0) e
   group by e.topic_id`;

/** $1 tree: primary placements that wait (gate or split check) or lack a vector, per topic. */
const flaggedSql = `select p.topic_id,
         (count(*) filter (where not p.needs_vector and (p.needs_gate or p.needs_split_check)))::int as waiting,
         (count(*) filter (where p.needs_vector))::int as vectorless
    from topic_placements p
   where p.tree_id = $1 and p.rank = 0 and (p.needs_gate or p.needs_split_check or p.needs_vector)
   group by p.topic_id`;

export const topicReadSql = {
  activeTree: `select t.id, t.generation::text as generation, t.space_key as "spaceKey", r.id as "rootId"
      from topic_trees t
      join topics r on r.tree_id = t.id and r.role = 'root' and r.retired_at is null
     where t.status = 'active'`,
  topic: `select t.id, t.tree_id as "treeId", t.retired_at is not null as retired, t.redirect_to as "redirectTo"
      from topics t where t.id = $1`,
  /** $1 tree, $2 parent, $3 position and $4 id of the cursor (nulls: first page), $5 limit. */
  children: `select t.id, t.position from topics t
     where t.tree_id = $1 and t.parent_id = $2 and t.retired_at is null
       and ($3::int is null or (t.position, t.id) > ($3::int, $4::uuid))
     order by t.position, t.id limit $5`,
  /** $1 tree, $2 topic IDs, $3 since. One row per topic, in the order of $2. */
  nodes: `with recursive tops as (
      select t.id, w.ord from unnest($2::uuid[]) with ordinality as w(id, ord)
        join topics t on t.id = w.id and t.tree_id = $1 and t.retired_at is null
    ), sub as (
      select tops.id as top, tops.id from tops
      union all
      select sub.top, c.id from sub
        ${childrenOf("sub.id")}
    ), recent as (${recentPlacementsSql(3)}),
    flagged as (${flaggedSql}),
    totals as (
      select sub.top, coalesce(sum(s.direct_items), 0)::int as items, coalesce(sum(r.n), 0)::int as recent
        from sub
        left join topic_stats s on s.topic_id = sub.id
        left join recent r on r.topic_id = sub.id
       group by sub.top
    )
    select t.id, t.parent_id as "parentId", t.role, t.title, t.name_state as "nameState",
           t.name_language as "nameLanguage", t.description, t.aliases, t.management, t.position,
           t.updated_at as "updatedAt",
           coalesce(s.direct_items, 0) as "directItems", coalesce(s.children, 0) as children,
           coalesce(s.health, 'good') as health, s.coherence,
           totals.items, totals.recent as "newThisWeek",
           case when t.role = 'root'
                then greatest(coalesce(s.direct_items, 0) - coalesce(f.vectorless, 0), 0)
                else coalesce(f.waiting, 0) end as unsorted
      from tops
      join topics t on t.id = tops.id
      left join topic_stats s on s.topic_id = t.id
      left join totals on totals.top = t.id
      left join flagged f on f.topic_id = t.id
     order by tops.ord`,
  /** $1 tree, $2 topic: the topic and every live descendant. */
  subtree: `with recursive sub as (
      select t.id from topics t where t.id = $2 and t.tree_id = $1 and t.retired_at is null
      union all
      select c.id from sub ${childrenOf("sub.id")}
    ) select id from sub`,
  /** $1 topic, $2 hops: the topic and its ancestors, root first. */
  path: `with recursive up as (
      select t.id, t.parent_id, t.title, 0 as hops from topics t where t.id = $1
      union all
      select p.id, p.parent_id, p.title, up.hops + 1 from up join topics p on p.id = up.parent_id
       where up.hops < $2::int
    ) select id, title from up order by hops desc`,
  /**
   * $1 topic IDs: primary placements by kind, and the distinct root sources of the notes. Every
   * topic is probed through the index on its own (the fence keeps the planner from reading the whole
   * table for a large subtree), so the cost follows the placements of the subtree.
   */
  counts: `select (count(*) filter (where p.item_kind = 'note'))::int as notes,
         (count(*) filter (where p.item_kind = 'source'))::int as "sourceItems",
         (count(distinct p.root_source_item_id) filter (where p.item_kind = 'note'))::int as sources
      from unnest($1::uuid[]) as s(id)
      cross join lateral (
        select q.item_kind, q.root_source_item_id from topic_placements q
         where q.topic_id = s.id and q.role = 'primary' offset 0) p`,
  /** $1 topic IDs, $2 title length, $3 subtitle length, $4 limit. */
  sources: `select top.id, left(src.title, $2::int) as title, left(src.subtitle, $3::int) as subtitle,
         top."noteCount"
      from (
        select g.root as id, g.n as "noteCount" from (
          select p.root_source_item_id as root, count(*)::int as n
            from unnest($1::uuid[]) as s(id)
            cross join lateral (
              select q.root_source_item_id from topic_placements q
               where q.topic_id = s.id and q.role = 'primary' and q.item_kind = 'note'
                 and q.root_source_item_id is not null offset 0) p
           group by p.root_source_item_id) g
         order by g.n desc, g.root limit $4::int) top
      join source_items src on src.id = top.id
     order by top."noteCount" desc, src.title, top.id`,
  /** $1 topic, $2 limit: a topic's own central notes. */
  directCentral: `select p.note_id as id from topic_placements p
     where p.topic_id = $1 and p.role = 'primary' and p.item_kind = 'note'
     order by p.centrality desc nulls last, p.id limit $2::int`,
  /**
   * $1 tree, $2 topics (the children shown): the most central note of each child's subtree. The
   * best note of every topic below a child comes from the index in centrality order, so no
   * placement is read beyond the first note of each topic.
   */
  representatives: `with recursive sub as (
      select t.id as top, t.id from topics t where t.id = any($2::uuid[]) and t.tree_id = $1
      union all
      select sub.top, c.id from sub
        ${childrenOf("sub.id")}
    )
    select distinct on (best.top) best.top as "topicId", best.id
      from (
        select sub.top, p.note_id as id, p.centrality, p.pid
          from sub
          cross join lateral (
            select q.note_id, q.centrality, q.id as pid from topic_placements q
             where q.topic_id = sub.id and q.role = 'primary' and q.item_kind = 'note'
             order by q.centrality desc nulls last, q.id limit 1) p
      ) best
     order by best.top, best.centrality desc nulls last, best.pid`,
  /** $1 note IDs in display order, $2 title and $4 idea length, $3 tree. */
  centralNotes: `select n.id, left(n.title, $2::int) as title, left(n.idea_statement, $4::int) as idea,
         n.created_from_source_item_id as "sourceId", left(src.title, $2::int) as "sourceTitle",
         (coalesce(n.metadata ->> 'humanProtected', '') = 'true'
          or exists (select 1 from atomic_note_review_events ev
                      where ev.atomic_note_id = n.id and ev.action = 'edit')) as human,
         (select count(*)::int from (
            select x.target_atomic_note_id as other from atomic_note_relations x
             where x.source_atomic_note_id = n.id and ${shownNoteRelationSql("x")}
            union all
            select x.source_atomic_note_id from atomic_note_relations x
             where x.target_atomic_note_id = n.id and ${shownNoteRelationSql("x")}) r
           join atomic_notes o on o.id = r.other and o.status not in ('rejected', 'archived')
         ) as "relationCount",
         p.centrality, p.moved_from_topic_id as "movedFromId", p.moved_at as "movedAt",
         mt.title as "movedFromTitle"
      from unnest($1::uuid[]) with ordinality as w(id, ord)
      join topic_placements p on p.note_id = w.id and p.tree_id = $3 and p.rank = 0
      join atomic_notes n on n.id = w.id
      left join source_items src on src.id = n.created_from_source_item_id
      left join topics mt on mt.id = p.moved_from_topic_id
     order by w.ord`,
  /**
   * $1 topic IDs, $2 notes read, $3 relations per note, $4 tree, $5 neighbours returned, $6 notes
   * read per topic. Relations of the most central notes (the best few of every topic, then the best
   * of those): the stance counts by type, and the neighbouring topics (the topic that holds the
   * other note) outside the subtree, for the service to lift. Every lookup is a probe by key: the
   * limits keep the planner from joining whole tables for a large subtree.
   */
  relations: `with mine as (
      select m.note_id from (
        select p.note_id, p.centrality, p.pid
          from unnest($1::uuid[]) as s(id)
          cross join lateral (
            select q.note_id, q.centrality, q.id as pid from topic_placements q
             where q.topic_id = s.id and q.role = 'primary' and q.item_kind = 'note'
             order by q.centrality desc nulls last, q.id limit $6::int) p
      ) m
      order by m.centrality desc nulls last, m.pid limit $2::int
    ), rel as materialized (
      select r.id, r.relation_type, r.other
        from mine m
        cross join lateral (
          (select x.id, coalesce(x.relation_type, 'related') as relation_type,
                  x.target_atomic_note_id as other
             from atomic_note_relations x
            where x.source_atomic_note_id = m.note_id and ${shownNoteRelationSql("x")}
            order by x.final_score desc, x.id limit $3::int)
          union all
          (select x.id, coalesce(x.relation_type, 'related'), x.source_atomic_note_id
             from atomic_note_relations x
            where x.target_atomic_note_id = m.note_id and ${shownNoteRelationSql("x")}
            order by x.final_score desc, x.id limit $3::int)
        ) r
    ), live as materialized (
      select rel.id, rel.relation_type, rel.other, held.topic_id
        from rel
        cross join lateral (
          select o.id from atomic_notes o
           where o.id = rel.other and o.status not in ('rejected', 'archived') limit 1) o
        left join lateral (
          select po.topic_id from topic_placements po
           where po.note_id = o.id and po.tree_id = $4 and po.rank = 0 limit 1) held on true
    )
    select 'stance' as kind, live.relation_type as key, count(distinct live.id)::int as n
      from live group by live.relation_type
    union all
    select 'topic', top.topic_id::text, top.n from (
      select live.topic_id, count(distinct live.id)::int as n
        from live
       where live.topic_id is not null
         and live.topic_id not in (select s from unnest($1::uuid[]) as s)
       group by live.topic_id
       order by n desc, live.topic_id limit $5::int) top`,
  /** $1 tree, $2 topic: the latest applied change-set that referenced the topic. */
  lastChange: `select cs.id, cs.origin, cs.status, cs.title_key as "titleKey", cs.title_params as "titleParams",
         cs.risk, cs.generation::text as generation, coalesce(cs.applied_at, cs.created_at) as at
      from topic_structure_events e
      join topic_change_sets cs on cs.id = e.change_set_id
     where e.ref_topic_ids && array[$2]::uuid[] and cs.tree_id = $1 and cs.status = 'applied'
     order by cs.generation desc limit 1`,
  /**
   * $1 tree, $2 change-set IDs: those a later (applied or undone) change-set touches the same
   * topics or items as, the footprint undo checks. With few later change-sets they are read one by
   * one; with many, the change-set's topics and items are looked up in the indexes of the events
   * (a large change-set would make the topic index read thousands of entries otherwise).
   */
  blocked: `with mine as (
      select cs.id, cs.generation,
             (select coalesce(array_agg(distinct r), '{}'::uuid[])
                from topic_structure_events e cross join lateral unnest(e.ref_topic_ids) r
               where e.change_set_id = cs.id) as refs,
             (select coalesce(array_agg(distinct e.item_kind), '{}'::text[])
                from topic_structure_events e where e.change_set_id = cs.id and e.item_id is not null) as kinds,
             (select coalesce(array_agg(distinct e.item_id), '{}'::uuid[])
                from topic_structure_events e where e.change_set_id = cs.id and e.item_id is not null) as items,
             (select count(*) from topic_change_sets l
               where l.tree_id = $1 and l.generation > cs.generation
                 and l.status in ('applied', 'undone')) as later
        from topic_change_sets cs where cs.id = any($2::uuid[]) and cs.tree_id = $1
    )
    select m.id from mine m
     where case when m.later <= ${blockedScanLimit} then
         exists (select 1 from topic_change_sets lc
                  where lc.tree_id = $1 and lc.generation > m.generation
                    and lc.status in ('applied', 'undone')
                    and exists (select 1 from topic_structure_events ev
                                 where ev.change_set_id = lc.id
                                   and ((ev.ref_topic_ids || '{}'::uuid[]) && m.refs
                                        or ev.item_id = any(m.items))))
       else
         exists (select 1 from topic_structure_events later
                   join topic_change_sets lc on lc.id = later.change_set_id
                  where later.ref_topic_ids && m.refs and lc.tree_id = $1
                    and lc.generation > m.generation and lc.status in ('applied', 'undone'))
         or exists (select 1 from unnest(m.kinds) as k(kind)
                      cross join unnest(m.items) as i(id)
                      join topic_structure_events later on later.item_kind = k.kind and later.item_id = i.id
                      join topic_change_sets lc on lc.id = later.change_set_id
                     where lc.tree_id = $1 and lc.generation > m.generation
                       and lc.status in ('applied', 'undone'))
       end`,
  /** $1 tree, $2 start of the day, $3 limit: structural change-sets applied since. */
  changedToday: `select cs.id, cs.origin, cs.status, cs.title_key as "titleKey", cs.title_params as "titleParams",
         cs.risk, cs.generation::text as generation, coalesce(cs.applied_at, cs.created_at) as at
      from topic_change_sets cs
     where cs.tree_id = $1 and cs.status = 'applied' and cs.created_at >= $2::timestamptz
       and cs.origin in ${structuralOrigins}
     order by cs.created_at desc, cs.id limit $3::int`,
  /** $1 tree, $2 limit: proposals that wait for the owner, with the first topic they reference. */
  pending: `select cs.id, cs.origin, cs.status, cs.title_key as "titleKey", cs.title_params as "titleParams",
         cs.risk, coalesce(cs.applied_at, cs.created_at) as at,
         (select e.topic_id from topic_structure_events e
           where e.change_set_id = cs.id and e.topic_id is not null order by e.seq limit 1) as "topicId"
      from topic_change_sets cs
     where cs.tree_id = $1 and cs.status = 'pending_review'
     order by cs.created_at desc, cs.id limit $2::int`,
  /**
   * $1 tree: every topic of the tree, retired ones included, with what a map of the shape needs. The
   * walk from the root is made on these rows, so no plan can depend on the tree's statistics.
   */
  topology: `select t.id, t.parent_id as "parentId", t.retired_at is not null as retired, t.title,
         t.management, t.position, coalesce(s.direct_items, 0) as "directItems",
         coalesce(s.health, 'good') as health, s.coherence
      from topics t left join topic_stats s on s.topic_id = t.id
     where t.tree_id = $1`,
  /** $1 tree, $2 limit: the stored violations of every topic that is not in good health. */
  violations: `select s.topic_id as "topicId", v.value ->> 'code' as invariant, v.value ->> 'reason' as reason,
         v.value ->> 'severity' as severity,
         coalesce((v.value ->> 'awaitingApproval')::boolean, false) as awaiting,
         v.value -> 'value' as measured
      from topic_stats s
      join topics t on t.id = s.topic_id and t.tree_id = $1 and t.retired_at is null
      cross join lateral jsonb_array_elements(s.violations) as v(value)
     where s.health <> 'good' and jsonb_typeof(s.violations) = 'array' and jsonb_typeof(v.value) = 'object'
     order by s.topic_id, v.value ->> 'reason'
     limit $2::int`,
  /** $1 tree, $2 since. */
  recent: recentPlacementsSql(2),
  flagged: flaggedSql,
  /** $1 tree: the eligible items and the engine's own counts. */
  status: `select
      (select count(*) from atomic_notes n where ${liveNote} and n.supersession_status = 'current')::int as notes,
      (select count(*) from source_items s where s.parent_source_item_id is null)::int as roots,
      (select coalesce(sum(s.direct_items), 0) from topic_stats s join topics t on t.id = s.topic_id
        where t.tree_id = $1)::int as placed,
      (select count(*) from topic_placements p where p.tree_id = $1 and p.needs_gate and p.rank = 0)::int as "needsGate"`,
  /** $1 change-set. */
  changeSet: `select cs.id, cs.tree_id as "treeId", cs.origin, cs.status, cs.title_key as "titleKey",
         cs.title_params as "titleParams", cs.risk, cs.generation::text as generation,
         coalesce(cs.applied_at, cs.created_at) as at
      from topic_change_sets cs where cs.id = $1`,
  /** $1 change-set, $2 limit. */
  changeSetEvents: `select e.seq, e.op, e.topic_id as "topicId", e.item_kind as "itemKind", e.item_id as "itemId",
         e.before, e.after
      from topic_structure_events e where e.change_set_id = $1 order by e.seq limit $2::int`,
  /** $1 topic IDs: the title and the parent of each. */
  topicTitles: `select t.id, t.title, t.parent_id as "parentId", p.title as "parentTitle"
      from topics t left join topics p on p.id = t.parent_id where t.id = any($1::uuid[])`,
  /** $1 note IDs, $2 source IDs, $3 title length. */
  itemTitles: `select 'note' as kind, n.id, left(n.title, $3::int) as title from atomic_notes n where n.id = any($1::uuid[])
      union all
      select 'source', s.id, left(s.title, $3::int) from source_items s where s.id = any($2::uuid[])`
} as const;

// ---------------------------------------------------------------------------
// Rows

interface TreeRow extends QueryResultRow {
  id: string;
  generation: string;
  spaceKey: string;
  rootId: string;
}

interface NodeRow extends QueryResultRow {
  id: string;
  parentId: string | null;
  role: "root" | "topic";
  title: string | null;
  nameState: TopicNameState;
  nameLanguage: string | null;
  description: string | null;
  aliases: unknown;
  management: TopicManagement;
  position: number;
  updatedAt: Date | string;
  directItems: number;
  children: number;
  health: TopicHealth;
  coherence: number | null;
  items: number;
  newThisWeek: number;
  unsorted: number;
}

interface LeafRow extends QueryResultRow {
  kind: TopicItemKind;
  placementId: string;
  topicId: string;
  id: string;
  role: "primary" | "secondary";
  centrality: number | null;
  needsGate: boolean;
  needsSplitCheck: boolean;
  needsVector: boolean;
  title: string;
  sourceTitle: string | null;
  human: boolean | null;
}

interface ChangeSetRow extends QueryResultRow {
  id: string;
  origin: TopicChangeSetSummary["origin"];
  status: TopicChangeSetSummary["status"];
  titleKey: string;
  titleParams: unknown;
  risk: TopicChangeSetSummary["risk"];
  generation?: string | null;
  at: Date | string;
}

const iso = (value: Date | string): string => mapTimestamp(value).toISOString();

/** Message-key parameters keep scalars only, so a stored object never fails a whole answer. */
function messageParams(value: unknown): TopicMessageParams {
  const output: TopicMessageParams = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key.length === 0 || key.length > 60) continue;
      if (entry === null || typeof entry === "boolean") output[key] = entry;
      else if (typeof entry === "number" && Number.isFinite(entry)) output[key] = entry;
      else if (typeof entry === "string") output[key] = entry.slice(0, 300);
    }
  }
  return output;
}

const aliasList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
    : [];

/** `real` columns arrive as JS numbers; a stored value outside 0..1 is clamped, never rejected. */
const unit = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));

function nodeOf(row: NodeRow): TopicNodeSummary {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    nameState: row.nameState,
    management: row.management,
    items: row.items,
    directItems: row.directItems,
    unsorted: row.unsorted,
    children: row.children,
    health: row.health,
    newThisWeek: row.newThisWeek,
    position: row.position,
    updatedAt: iso(row.updatedAt)
  };
}

function pageTopicOf(row: NodeRow): TopicPageTopic {
  return {
    ...nodeOf(row),
    description: row.description,
    aliases: aliasList(row.aliases).slice(0, 10),
    nameLanguage: row.nameLanguage,
    coherence: unit(row.coherence)
  };
}

// ---------------------------------------------------------------------------
// Cursors

interface ChildCursor {
  position: number;
  id: string;
}

/** `[roleRank, centrality, id]`: where the next page of leaves starts. */
type LeafCursor = [0 | 1, number | null, string];

const encodeCursor = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new TopicReadError("invalidCursor", "The cursor is not valid");
  }
}

function decodeChildCursor(cursor: string): ChildCursor {
  const value = decodeCursor(cursor);
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    (value[0] as number) >= 0 &&
    typeof value[1] === "string" &&
    uuidPattern.test(value[1])
  ) {
    return { position: value[0] as number, id: value[1] };
  }
  throw new TopicReadError("invalidCursor", "The cursor is not valid");
}

function decodeLeafCursor(cursor: string): LeafCursor {
  const value = decodeCursor(cursor);
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    (value[0] === 0 || value[0] === 1) &&
    (value[1] === null || (typeof value[1] === "number" && Number.isFinite(value[1]))) &&
    typeof value[2] === "string" &&
    uuidPattern.test(value[2])
  ) {
    return [value[0], value[1] as number | null, value[2]];
  }
  throw new TopicReadError("invalidCursor", "The cursor is not valid");
}

// ---------------------------------------------------------------------------
// Statements shared by the reads

interface ActiveTree {
  id: string;
  generation: number;
  rootId: string;
}

async function activeTree(db: Snapshot): Promise<ActiveTree | null> {
  const row = (await db.query<TreeRow>(topicReadSql.activeTree)).rows[0];
  return row ? { id: row.id, generation: Number(row.generation), rootId: row.rootId } : null;
}

/** The live topic `id` names, following the redirects of retired topics; null when there is none. */
async function resolveTopic(
  db: Snapshot,
  tree: ActiveTree,
  id: string
): Promise<{ id: string; redirectedFrom: string | null } | null> {
  let current = id;
  for (let hop = 0; hop <= topicReadDefaults.redirectHops; hop += 1) {
    const row = (
      await db.query<{ id: string; treeId: string; retired: boolean; redirectTo: string | null }>(
        topicReadSql.topic,
        [current]
      )
    ).rows[0];
    if (!row || row.treeId !== tree.id) return null;
    if (!row.retired) return { id: row.id, redirectedFrom: row.id === id ? null : id };
    if (!row.redirectTo) return null;
    current = row.redirectTo;
  }
  return null;
}

async function readNodes(
  db: Snapshot,
  tree: ActiveTree,
  ids: readonly string[],
  since: Date
): Promise<NodeRow[]> {
  if (ids.length === 0) return [];
  return (await db.query<NodeRow>(topicReadSql.nodes, [tree.id, [...ids], since])).rows;
}

async function readSubtreeIds(db: Snapshot, tree: ActiveTree, id: string): Promise<string[]> {
  return (await db.query<{ id: string }>(topicReadSql.subtree, [tree.id, id])).rows.map(
    (row) => row.id
  );
}

async function readPath(db: Snapshot, id: string): Promise<TopicPathEntry[]> {
  const rows = (
    await db.query<{ id: string; title: string | null }>(topicReadSql.path, [
      id,
      topicReadDefaults.pathHops
    ])
  ).rows;
  return rows.map((row) => ({ id: row.id, title: row.title }));
}

/** Children of a topic in keyset pages: the IDs, and the cursor of the next page. */
async function readChildIds(
  db: Snapshot,
  tree: ActiveTree,
  parentId: string,
  options: { cursor?: string | undefined; limit: number }
): Promise<{ ids: string[]; next: string | null }> {
  const cursor = options.cursor ? decodeChildCursor(options.cursor) : null;
  const rows = (
    await db.query<{ id: string; position: number }>(topicReadSql.children, [
      tree.id,
      parentId,
      cursor?.position ?? null,
      cursor?.id ?? null,
      options.limit + 1
    ])
  ).rows;
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    ids: page.map((row) => row.id),
    next:
      rows.length > options.limit && last
        ? encodeCursor([last.position, last.id] satisfies [number, string])
        : null
  };
}

/** The `since` of "new this week". */
const weekStart = (now: Date): Date =>
  new Date(now.getTime() - topicReadDefaults.recentDays * 24 * 60 * 60 * 1000);

/** The local midnight before `now`. */
function dayStart(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

interface TopologyRow {
  id: string;
  parentId: string | null;
  retired: boolean;
  title: string | null;
  management: TopicManagement;
  position: number;
  directItems: number;
  health: TopicHealth;
  coherence: number | null;
}

async function readTopology(db: Snapshot, tree: ActiveTree): Promise<TopologyRow[]> {
  return (await db.query<TopologyRow>(topicReadSql.topology, [tree.id])).rows;
}

/**
 * The live topics below `rootId` (the root included, depth 0) in breadth-first order, each level by
 * position then ID; null when `rootId` is not a live topic of the rows. A cycle ends the walk.
 */
function walkLive(
  rows: readonly TopologyRow[],
  rootId: string
): Array<TopologyRow & { depth: number }> | null {
  const root = rows.find((row) => row.id === rootId);
  if (!root || root.retired) return null;
  const below = new Map<string, TopologyRow[]>();
  for (const row of rows) {
    if (row.retired || row.parentId === null) continue;
    const list = below.get(row.parentId) ?? [];
    list.push(row);
    below.set(row.parentId, list);
  }
  const cells: Array<TopologyRow & { depth: number }> = [];
  const seen = new Set<string>([root.id]);
  let level: Array<TopologyRow & { depth: number }> = [{ ...root, depth: 0 }];
  while (level.length > 0) {
    cells.push(...level);
    const next: Array<TopologyRow & { depth: number }> = [];
    for (const cell of level) {
      const children = [...(below.get(cell.id) ?? [])].sort(
        (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        next.push({ ...child, depth: cell.depth + 1 });
      }
    }
    level = next;
  }
  return cells;
}

interface LeafQuery {
  /** Topics whose placements are listed (the topic itself, or its whole subtree). */
  topicIds: readonly string[];
  /** The root of the tree: every item placed directly on it is unsorted (docs D27). */
  rootId: string;
  scope: "direct" | "subtree";
  kind: "all" | "note";
  cursor?: string | undefined;
  limit: number;
}

/**
 * A page of placements as leaves: primary first, by centrality, with a keyset cursor. Each topic
 * contributes at most one page from its own index range (the fence keeps the planner from reading
 * the whole table for a large subtree); the pages merge into one, and only that page is joined to
 * the notes and sources.
 */
async function readLeaves(
  db: Snapshot,
  query: LeafQuery
): Promise<{ items: TopicItemLeaf[]; next: string | null }> {
  const values: unknown[] = [[...query.topicIds], topicReadLimits.itemTitleMax];
  const where: string[] = ["q.topic_id = s.id"];
  if (query.scope === "subtree") where.push("q.role = 'primary'");
  if (query.kind === "note") where.push("q.item_kind = 'note'");
  if (query.cursor) {
    const [roleRank, centrality, id] = decodeLeafCursor(query.cursor);
    values.push(roleRank === 0 ? "primary" : "secondary", centrality, id);
    const [role, central, pid] = [values.length - 2, values.length - 1, values.length];
    where.push(`(q.role > $${role}::text or (q.role = $${role}::text and (
        ($${central}::real is not null and (q.centrality < $${central}::real
           or q.centrality is null or (q.centrality = $${central}::real and q.id > $${pid}::uuid)))
        or ($${central}::real is null and q.centrality is null and q.id > $${pid}::uuid))))`);
  }
  values.push(query.limit + 1);
  const limit = `$${values.length}::int`;
  const rows = (
    await db.query<LeafRow>(
      `select page.kind, page.pid as "placementId", page.topic_id as "topicId",
              coalesce(page.note_id, page.source_item_id) as id,
              page.role, page.centrality, page.needs_gate as "needsGate",
              page.needs_split_check as "needsSplitCheck", page.needs_vector as "needsVector",
              left(coalesce(n.title, s.title, ''), $2::int) as title,
              left(src.title, $2::int) as "sourceTitle",
              case when n.id is null then null
                   else (coalesce(n.metadata ->> 'humanProtected', '') = 'true'
                         or exists (select 1 from atomic_note_review_events ev
                                     where ev.atomic_note_id = n.id and ev.action = 'edit')) end as human
         from (
           select merged.* from unnest($1::uuid[]) as s(id)
             cross join lateral (
               select q.id as pid, q.topic_id, q.item_kind as kind, q.note_id, q.source_item_id, q.role,
                      q.centrality, q.needs_gate, q.needs_split_check, q.needs_vector
                 from topic_placements q
                where ${where.join(" and ")}
                order by q.role, q.centrality desc nulls last, q.id
                limit ${limit} offset 0) merged
            order by merged.role, merged.centrality desc nulls last, merged.pid
            limit ${limit}) page
         left join atomic_notes n on n.id = page.note_id
         left join source_items s on s.id = page.source_item_id
         left join source_items src on src.id = n.created_from_source_item_id
        order by page.role, page.centrality desc nulls last, page.pid`,
      values
    )
  ).rows;
  const page = rows.slice(0, query.limit);
  const sourceIds = page.filter((row) => row.kind === "source").map((row) => row.id);
  const noteCounts = new Map<string, number>();
  if (sourceIds.length > 0) {
    const counted = await db.query<{ id: string; n: number }>(
      `select p.root as id, count(*)::int as n
         from unnest($1::uuid[]) as s(id)
         cross join lateral (
           select q.root_source_item_id as root from topic_placements q
            where q.topic_id = s.id and q.item_kind = 'note'
              and ($3::boolean is false or q.role = 'primary') offset 0) p
        where p.root = any($2::uuid[])
        group by p.root`,
      [[...query.topicIds], sourceIds, query.scope === "subtree"]
    );
    for (const row of counted.rows) noteCounts.set(row.id, row.n);
  }
  const items = page.map((row): TopicItemLeaf => {
    const waiting =
      row.role === "primary" &&
      !row.needsVector &&
      (row.topicId === query.rootId || row.needsGate || row.needsSplitCheck);
    return row.kind === "note"
      ? {
          kind: "note",
          id: row.id,
          title: row.title,
          sourceTitle: row.sourceTitle,
          provenance: row.human ? "human" : "ai",
          role: row.role,
          unsorted: waiting
        }
      : {
          kind: "source",
          id: row.id,
          title: row.title,
          noteCount: noteCounts.get(row.id) ?? 0,
          role: row.role,
          unsorted: waiting
        };
  });
  const last = page.at(-1);
  return {
    items,
    next:
      rows.length > query.limit && last
        ? encodeCursor([
            last.role === "primary" ? 0 : 1,
            last.centrality,
            last.placementId
          ] satisfies LeafCursor)
        : null
  };
}

/** Whether each change-set can be undone: applied, not a build or an undo, and nothing later touches it. */
async function undoAvailability(
  db: Snapshot,
  tree: ActiveTree | { id: string },
  rows: readonly Pick<ChangeSetRow, "id" | "origin" | "status">[]
): Promise<Map<string, TopicUndoAvailability>> {
  const output = new Map<string, TopicUndoAvailability>();
  const candidates: string[] = [];
  for (const row of rows) {
    if (row.status !== "applied" || row.origin === "build" || row.origin === "undo") {
      output.set(row.id, "unavailable");
    } else {
      candidates.push(row.id);
    }
  }
  if (candidates.length > 0) {
    const blocked = new Set(
      (await db.query<{ id: string }>(topicReadSql.blocked, [tree.id, candidates])).rows.map(
        (row) => row.id
      )
    );
    for (const id of candidates) output.set(id, blocked.has(id) ? "blocked" : "available");
  }
  return output;
}

function summaryOf(row: ChangeSetRow, undo: TopicUndoAvailability): TopicChangeSetSummary {
  return {
    id: row.id,
    origin: row.origin,
    status: row.status,
    titleKey: row.titleKey,
    titleParams: messageParams(row.titleParams),
    risk: row.risk,
    at: iso(row.at),
    undo
  };
}

const emptyStances = (): TopicRelationStances => ({
  supports: 0,
  contrasts: 0,
  extends: 0,
  similar_to: 0,
  depends_on: 0,
  clarifies: 0,
  mentions: 0,
  related: 0
});

// ---------------------------------------------------------------------------
// Results

/** A neighbouring topic as the database sees it: the topic that holds the other note. */
export interface TopicRelatedLeaf {
  topicId: string;
  relationCount: number;
}

/**
 * What `readPage` reads. The service completes it into a `topics.page` answer: it lifts
 * `relatedLeaves` to the level of the page (it holds the cached ancestry) and adds the overview.
 */
export interface TopicPageRows {
  generation: number;
  treeId: string;
  topic: TopicPageTopic;
  redirectedFrom: string | null;
  path: TopicPathEntry[];
  counts: { notes: number; sources: number; subtopics: number };
  subtopics: TopicSubtopic[];
  centralNotes: TopicCentralNote[];
  moreNotes: number;
  sources: TopicContributingSource[];
  relatedLeaves: TopicRelatedLeaf[];
  relationStances: TopicRelationStances;
  lastChange: TopicLastChange | null;
}

export interface TopicAncestry {
  treeId: string;
  generation: number;
  rootId: string;
  /** Every live topic with its parent and depth (the root is 0). */
  topics: Array<{ id: string; parentId: string | null; title: string | null; depth: number }>;
}

export interface TopicStatusCounts {
  generation: number;
  /** Current notes and root sources. */
  items: number;
  placed: number;
  needsGate: number;
}

export interface TopicReadOptions {
  /** The clock of the reads: "new this week", "moved from" and "changed today" (default now). */
  now?: Date;
}

export interface TopicShapeReadInput {
  rootId: string | null;
  depth: number;
  nodeLimit: number;
}

// ---------------------------------------------------------------------------
// Repository

export function createTopicReadRepository(pool: PgPool) {
  /** One consistent snapshot for a read of several statements. */
  async function snapshot<T>(read: (db: Snapshot) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin transaction isolation level repeatable read, read only");
      const result = await read(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    /** `topics.tree`; null when there is no active tree or the parent is not a live topic of it. */
    async readTree(
      input: {
        parentId: string | null;
        cursor?: string | undefined;
        limit: number;
        includeItems: boolean;
        itemLimit: number;
      },
      options: TopicReadOptions = {}
    ): Promise<TopicTree | null> {
      const now = options.now ?? new Date();
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const parentId = input.parentId ?? tree.rootId;
        const children = await readChildIds(db, tree, parentId, {
          cursor: input.cursor,
          limit: input.limit
        });
        const rows = await readNodes(db, tree, [parentId, ...children.ids], weekStart(now));
        const [parentRow, ...childRows] = rows;
        if (!parentRow || parentRow.id !== parentId) return null;
        let items: TopicItemLeaf[] = [];
        let moreItems = 0;
        if (input.includeItems && input.itemLimit > 0) {
          items = (
            await readLeaves(db, {
              topicIds: [parentId],
              rootId: tree.rootId,
              scope: "direct",
              kind: "all",
              limit: input.itemLimit
            })
          ).items;
        }
        if (input.includeItems) {
          const secondary = (
            await db.query<{ n: number }>(
              `select count(*)::int as n from topic_placements p
                where p.topic_id = $1 and p.role = 'secondary'`,
              [parentId]
            )
          ).rows[0];
          moreItems = Math.max(0, parentRow.directItems + (secondary?.n ?? 0) - items.length);
        }
        return {
          generation: tree.generation,
          parent: nodeOf(parentRow),
          nodes: childRows.map(nodeOf),
          items,
          moreItems,
          unsorted: parentRow.unsorted,
          nextCursor: children.next
        };
      });
    },

    /** `topics.path`: null when the topic does not exist; a retired topic resolves to its successor. */
    async readPath(id: string): Promise<{
      resolvedId: string;
      redirectedFrom: string | null;
      path: TopicPathEntry[];
    } | null> {
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const resolved = await resolveTopic(db, tree, id);
        if (!resolved) return null;
        return {
          resolvedId: resolved.id,
          redirectedFrom: resolved.redirectedFrom,
          path: await readPath(db, resolved.id)
        };
      });
    },

    /** `topics.notes`: a page of a topic's leaves. */
    async readItems(input: {
      id: string;
      cursor?: string | undefined;
      limit: number;
      scope: "direct" | "subtree";
      kind: "all" | "note";
    }): Promise<(TopicNotes & { generation: number }) | null> {
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const resolved = await resolveTopic(db, tree, input.id);
        if (!resolved) return null;
        const topicIds =
          input.scope === "subtree" ? await readSubtreeIds(db, tree, resolved.id) : [resolved.id];
        const page = await readLeaves(db, {
          topicIds,
          rootId: tree.rootId,
          scope: input.scope,
          kind: input.kind,
          cursor: input.cursor,
          limit: input.limit
        });
        return { generation: tree.generation, items: page.items, nextCursor: page.next };
      });
    },

    /** `topics.page` without the lifted neighbours and the overview; null when the topic is gone. */
    async readPage(
      input: { id: string; noteLimit: number },
      options: TopicReadOptions = {}
    ): Promise<TopicPageRows | null> {
      const now = options.now ?? new Date();
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const resolved = await resolveTopic(db, tree, input.id);
        if (!resolved) return null;
        const since = weekStart(now);
        const [topicRow] = await readNodes(db, tree, [resolved.id], since);
        if (!topicRow) return null;
        const path = await readPath(db, resolved.id);
        const subtree = await readSubtreeIds(db, tree, resolved.id);

        const counted = (
          await db.query<{ notes: number; sources: number }>(topicReadSql.counts, [subtree])
        ).rows[0];
        const notes = counted?.notes ?? 0;

        // The children shown: a map of the next level, with their own item counts and descriptions.
        let subtopics: TopicSubtopic[] = [];
        const picked: string[] = [];
        if (topicRow.children > 0) {
          const childIds = await readChildIds(db, tree, resolved.id, {
            limit: Math.max(topicReadLimits.subtopicsMax, input.noteLimit)
          });
          const childRows = await readNodes(
            db,
            tree,
            childIds.ids.slice(0, topicReadLimits.subtopicsMax),
            since
          );
          subtopics = childRows.map((row) => ({
            id: row.id,
            title: row.title,
            items: row.items,
            description: row.description,
            health: row.health
          }));
          // Central notes of an internal topic: the best note of each child first, then its own.
          const kids = childIds.ids.slice(0, input.noteLimit);
          const representatives = new Map(
            (
              await db.query<{ topicId: string; id: string }>(topicReadSql.representatives, [
                tree.id,
                kids
              ])
            ).rows.map((row) => [row.topicId, row.id])
          );
          for (const kid of kids) {
            const note = representatives.get(kid);
            if (note && !picked.includes(note)) picked.push(note);
          }
        }
        if (picked.length < input.noteLimit) {
          const direct = await db.query<{ id: string }>(topicReadSql.directCentral, [
            resolved.id,
            input.noteLimit
          ]);
          for (const row of direct.rows) {
            if (picked.length >= input.noteLimit) break;
            if (!picked.includes(row.id)) picked.push(row.id);
          }
        }
        const central = await readCentralNotes(db, tree, picked.slice(0, input.noteLimit), since);

        const sources = (
          await db.query<TopicContributingSource>(topicReadSql.sources, [
            subtree,
            topicReadLimits.itemTitleMax,
            topicReadLimits.subtitleMax,
            topicReadLimits.sourcesMax
          ])
        ).rows;

        const relationRows = (
          await db.query<{ kind: "stance" | "topic"; key: string; n: number }>(
            topicReadSql.relations,
            [
              subtree,
              topicReadDefaults.relationNotes,
              topicReadDefaults.relationsPerNote,
              tree.id,
              topicReadDefaults.relatedLeaves,
              Math.max(
                topicReadDefaults.relationNotesPerTopic,
                Math.ceil(topicReadDefaults.relationNotes / subtree.length)
              )
            ]
          )
        ).rows;
        const relationStances = emptyStances();
        const relatedLeaves: TopicRelatedLeaf[] = [];
        for (const row of relationRows) {
          if (row.kind === "stance") {
            const type =
              row.key in relationStances ? (row.key as keyof TopicRelationStances) : "related";
            relationStances[type] += row.n;
          } else {
            relatedLeaves.push({ topicId: row.key, relationCount: row.n });
          }
        }

        const last = (await db.query<ChangeSetRow>(topicReadSql.lastChange, [tree.id, resolved.id]))
          .rows[0];
        let lastChange: TopicLastChange | null = null;
        if (last) {
          const undo = (await undoAvailability(db, tree, [last])).get(last.id) ?? "unavailable";
          lastChange = {
            changeSetId: last.id,
            titleKey: last.titleKey,
            titleParams: messageParams(last.titleParams),
            at: iso(last.at),
            undo
          };
        }

        return {
          generation: tree.generation,
          treeId: tree.id,
          topic: pageTopicOf(topicRow),
          redirectedFrom: resolved.redirectedFrom,
          path,
          counts: { notes, sources: counted?.sources ?? 0, subtopics: topicRow.children },
          subtopics,
          centralNotes: central,
          moreNotes: Math.max(0, notes - central.length),
          sources,
          relatedLeaves,
          relationStances,
          lastChange
        };
      });
    },

    /** `topics.shape`: null when there is no active tree or the root is not a live topic of it. */
    async readShape(
      input: TopicShapeReadInput,
      options: TopicReadOptions = {}
    ): Promise<TopicShape | null> {
      const now = options.now ?? new Date();
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const rootId = input.rootId ?? tree.rootId;
        const topology = await readTopology(db, tree);
        const cells = walkLive(topology, rootId);
        if (!cells) return null;

        const recent = new Map(
          (
            await db.query<{ topic_id: string; n: number }>(topicReadSql.recent, [
              tree.id,
              weekStart(now)
            ])
          ).rows.map((row) => [row.topic_id, row.n])
        );
        const flagged = new Map(
          (
            await db.query<{ topic_id: string; waiting: number; vectorless: number }>(
              topicReadSql.flagged,
              [tree.id]
            )
          ).rows.map((row) => [row.topic_id, row])
        );

        // Subtree sums bottom-up: the cells come level by level, so the reverse order has every
        // child before its parent.
        const items = new Map<string, number>();
        const week = new Map<string, number>();
        const childCount = new Map<string, number>();
        for (const cell of [...cells].reverse()) {
          items.set(cell.id, (items.get(cell.id) ?? 0) + cell.directItems);
          week.set(cell.id, (week.get(cell.id) ?? 0) + (recent.get(cell.id) ?? 0));
          if (cell.id !== rootId && cell.parentId !== null) {
            items.set(cell.parentId, (items.get(cell.parentId) ?? 0) + (items.get(cell.id) ?? 0));
            week.set(cell.parentId, (week.get(cell.parentId) ?? 0) + (week.get(cell.id) ?? 0));
            childCount.set(cell.parentId, (childCount.get(cell.parentId) ?? 0) + 1);
          }
        }

        // The cells within the depth and the node limit; `truncated` when the walk has more.
        const nodes: TopicShapeNode[] = [];
        for (const cell of cells) {
          if (cell.depth > input.depth || nodes.length >= input.nodeLimit) break;
          nodes.push({
            id: cell.id,
            // The cells form a tree of their own: the requested root has no parent in it.
            parentId: cell.id === rootId ? null : cell.parentId,
            depth: cell.depth,
            title: cell.title,
            management: cell.management,
            items: items.get(cell.id) ?? 0,
            directItems: cell.directItems,
            children: childCount.get(cell.id) ?? 0,
            health: cell.health,
            newThisWeek: week.get(cell.id) ?? 0,
            coherence: unit(cell.coherence)
          });
        }
        const truncated = nodes.length < cells.length;

        const total = items.get(rootId) ?? 0;
        let depthSum = 0;
        let unsorted = 0;
        let needsVector = 0;
        for (const cell of cells) {
          depthSum += cell.directItems * cell.depth;
          const flags = flagged.get(cell.id);
          needsVector += flags?.vectorless ?? 0;
          unsorted +=
            cell.id === tree.rootId
              ? Math.max(0, cell.directItems - (flags?.vectorless ?? 0))
              : (flags?.waiting ?? 0);
        }

        const inShape = new Set(cells.map((cell) => cell.id));
        const stored = (
          await db.query<{
            topicId: string;
            invariant: string | null;
            reason: string | null;
            severity: string | null;
            awaiting: boolean;
            measured: unknown;
          }>(topicReadSql.violations, [tree.id, topicReadDefaults.violations])
        ).rows.filter((row) => inShape.has(row.topicId) && row.reason);
        const counted = stored.filter((row) => !row.awaiting);
        const hard = counted.filter((row) => row.severity === "hard").length;
        const soft = counted.filter((row) => row.severity !== "hard").length;
        const rank = (row: (typeof stored)[number]): number =>
          row.awaiting ? 1 : row.severity === "hard" ? 0 : 2;
        const warnings: TopicShapeWarning[] = [];
        for (const row of [...stored].sort(
          (a, b) =>
            rank(a) - rank(b) ||
            (items.get(b.topicId) ?? 0) - (items.get(a.topicId) ?? 0) ||
            (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0)
        )) {
          const params: TopicMessageParams = {
            invariant: row.invariant ?? "",
            severity: row.severity ?? "soft",
            awaitingApproval: row.awaiting
          };
          if (typeof row.measured === "number" && Number.isFinite(row.measured)) {
            params.value = row.measured;
          }
          warnings.push({
            topicId: row.topicId,
            code: (row.reason as string).slice(0, 80),
            params,
            changeSetId: null,
            pendingReview: false
          });
        }
        const pending = (
          await db.query<ChangeSetRow & { topicId: string | null }>(topicReadSql.pending, [
            tree.id,
            topicReadLimits.shapeWarningsMax
          ])
        ).rows;
        const proposals: TopicShapeWarning[] = pending
          .filter((row) => row.topicId === null || inShape.has(row.topicId))
          .map((row) => ({
            topicId: row.topicId,
            code: "pending-review",
            params: { origin: row.origin, risk: row.risk, titleKey: row.titleKey },
            changeSetId: row.id,
            pendingReview: true
          }));

        const today = (
          await db.query<ChangeSetRow>(topicReadSql.changedToday, [
            tree.id,
            dayStart(now),
            topicReadLimits.shapeChangedMax
          ])
        ).rows;
        const undo = await undoAvailability(db, tree, today);

        // Placed items against the ones a walk from the root reaches (a retired topic is empty).
        const wholeTree = rootId === tree.rootId ? cells : walkLive(topology, tree.rootId);
        const reach = {
          reachable: (wholeTree ?? []).reduce((sum, cell) => sum + cell.directItems, 0),
          placed: topology.reduce((sum, row) => sum + row.directItems, 0)
        };
        return {
          generation: tree.generation,
          summary: {
            items: total,
            topics: Math.max(0, cells.length - 1),
            meanDepth: total > 0 ? depthSum / total : 0,
            reachable: reach.placed > 0 ? Math.min(1, reach.reachable / reach.placed) : 1,
            unsortedShare: total > 0 ? Math.min(1, unsorted / total) : 0,
            needsVector,
            soft,
            hard
          },
          nodes,
          truncated,
          warnings: [...proposals, ...warnings].slice(0, topicReadLimits.shapeWarningsMax),
          changedToday: today.map((row) => summaryOf(row, undo.get(row.id) ?? "unavailable"))
        };
      });
    },

    /** `topics.changeSets.get`; null when the change-set does not exist. */
    async readChangeSet(id: string): Promise<TopicChangeSet | null> {
      return snapshot(async (db) => {
        const row = (
          await db.query<ChangeSetRow & { treeId: string }>(topicReadSql.changeSet, [id])
        ).rows[0];
        if (!row) return null;
        const undo =
          (await undoAvailability(db, { id: row.treeId }, [row])).get(row.id) ?? "unavailable";
        const read = await db.query<{
          seq: number;
          op: string;
          topicId: string | null;
          itemKind: TopicItemKind | null;
          itemId: string | null;
          before: unknown;
          after: unknown;
        }>(topicReadSql.changeSetEvents, [id, topicReadDefaults.changeSetEvents + 1]);
        const eventsTruncated = read.rows.length > topicReadDefaults.changeSetEvents;
        const events: StructureEvent[] = [];
        for (const event of read.rows.slice(0, topicReadDefaults.changeSetEvents)) {
          const parsed = StructureEventSchema.safeParse(
            event.itemKind !== null && event.itemId !== null
              ? {
                  op: event.op,
                  item: `${event.itemKind}:${event.itemId}`,
                  topicId: event.topicId,
                  before: event.before,
                  after: event.after
                }
              : { op: event.op, topicId: event.topicId, before: event.before, after: event.after }
          );
          if (parsed.success) events.push(parsed.data);
        }
        const described = await describeEvents(db, events);
        return {
          summary: summaryOf(row, undo),
          before: described.before,
          after: described.after,
          truncated: eventsTruncated || described.truncated
        };
      });
    },

    /** The live topics with parents and titles, for lifting neighbours to a level. */
    async readAncestry(): Promise<TopicAncestry | null> {
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const rows = (walkLive(await readTopology(db, tree), tree.rootId) ?? []).map((cell) => ({
          id: cell.id,
          parentId: cell.parentId,
          title: cell.title,
          depth: cell.depth
        }));
        return {
          treeId: tree.id,
          generation: tree.generation,
          rootId: tree.rootId,
          topics: rows
        };
      });
    },

    /** The counts of `topics.status` that only the database knows; null without an active tree. */
    async readStatusCounts(): Promise<TopicStatusCounts | null> {
      return snapshot(async (db) => {
        const tree = await activeTree(db);
        if (!tree) return null;
        const row = (
          await db.query<{ notes: number; roots: number; placed: number; needsGate: number }>(
            topicReadSql.status,
            [tree.id]
          )
        ).rows[0];
        return {
          generation: tree.generation,
          items: (row?.notes ?? 0) + (row?.roots ?? 0),
          placed: row?.placed ?? 0,
          needsGate: row?.needsGate ?? 0
        };
      });
    },

    /** The statements behind the reads, for EXPLAIN in verification and the benchmark. */
    statements: topicReadSql
  };
}

export type TopicReadRepository = ReturnType<typeof createTopicReadRepository>;

// ---------------------------------------------------------------------------
// Pieces of the page and the change-set views

async function readCentralNotes(
  db: Snapshot,
  tree: ActiveTree,
  ids: readonly string[],
  since: Date
): Promise<TopicCentralNote[]> {
  if (ids.length === 0) return [];
  const rows = (
    await db.query<{
      id: string;
      title: string;
      idea: string;
      sourceId: string | null;
      sourceTitle: string | null;
      human: boolean;
      relationCount: number;
      centrality: number | null;
      movedFromId: string | null;
      movedAt: Date | string | null;
      movedFromTitle: string | null;
    }>(topicReadSql.centralNotes, [
      [...ids],
      topicReadLimits.itemTitleMax,
      tree.id,
      topicReadLimits.ideaMax
    ])
  ).rows;
  return rows.map((row): TopicCentralNote => {
    const note: TopicCentralNote = {
      id: row.id,
      title: row.title,
      idea: row.idea,
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      relationCount: row.relationCount,
      provenance: row.human ? "human" : "ai",
      centrality: unit(row.centrality)
    };
    if (row.movedFromId && row.movedAt) {
      const movedAt = mapTimestamp(row.movedAt);
      if (movedAt >= since) {
        note.movedFrom = {
          id: row.movedFromId,
          title: row.movedFromTitle,
          at: movedAt.toISOString()
        };
      }
    }
    return note;
  });
}

interface Side {
  topics: Array<{ id: string; title: string | null; parentTitle: string | null }>;
  items: Array<{
    kind: TopicItemKind;
    id: string;
    title: string;
    topicId: string | null;
    topicTitle: string | null;
  }>;
}

/**
 * The textual before and after of a change-set's events: the topics created, renamed, moved,
 * retired or restored with their parent's title, and the items placed, unplaced or moved with the
 * topic they were in. Each side lists at most `changeSetTopicsMax` topics and `changeSetItemsMax` items.
 */
async function describeEvents(
  db: Snapshot,
  events: readonly StructureEvent[]
): Promise<{ before: Side; after: Side; truncated: boolean }> {
  const topicIds = new Set<string>();
  const noteIds = new Set<string>();
  const sourceIds = new Set<string>();
  const wanted = (id: string | null | undefined): void => {
    if (id) topicIds.add(id);
  };
  for (const event of events) {
    wanted(event.topicId);
    if (event.op === "topic.create" || event.op === "topic.move") {
      wanted(event.before?.parentId);
      wanted(event.after?.parentId);
    }
    if (event.op === "item.place" || event.op === "item.unplace" || event.op === "item.move") {
      wanted(event.before?.topicId);
      wanted(event.after?.topicId);
      const separator = event.item.indexOf(":");
      const kind = event.item.slice(0, separator);
      const id = event.item.slice(separator + 1);
      (kind === "note" ? noteIds : sourceIds).add(id);
    }
  }
  const titles = new Map<string, { title: string | null; parentTitle: string | null }>();
  if (topicIds.size > 0) {
    const rows = await db.query<{
      id: string;
      title: string | null;
      parentId: string | null;
      parentTitle: string | null;
    }>(topicReadSql.topicTitles, [[...topicIds]]);
    for (const row of rows.rows)
      titles.set(row.id, { title: row.title, parentTitle: row.parentTitle });
  }
  const itemTitles = new Map<string, string>();
  if (noteIds.size > 0 || sourceIds.size > 0) {
    const rows = await db.query<{ kind: TopicItemKind; id: string; title: string }>(
      topicReadSql.itemTitles,
      [[...noteIds].slice(0, 5_000), [...sourceIds].slice(0, 5_000), topicReadLimits.itemTitleMax]
    );
    for (const row of rows.rows) itemTitles.set(`${row.kind}:${row.id}`, row.title);
  }
  const titleOf = (id: string | null | undefined): string | null =>
    id ? (titles.get(id)?.title ?? null) : null;

  const before: Side = { topics: [], items: [] };
  const after: Side = { topics: [], items: [] };
  let truncated = false;
  const addTopic = (
    side: Side,
    id: string,
    title: string | null,
    parentTitle: string | null
  ): void => {
    if (side.topics.some((topic) => topic.id === id)) return;
    if (side.topics.length >= topicReadLimits.changeSetTopicsMax) {
      truncated = true;
      return;
    }
    side.topics.push({ id, title, parentTitle });
  };
  const addItem = (side: Side, item: string, topicId: string | null): void => {
    if (side.items.some((entry) => `${entry.kind}:${entry.id}` === item)) return;
    if (side.items.length >= topicReadLimits.changeSetItemsMax) {
      truncated = true;
      return;
    }
    const separator = item.indexOf(":");
    side.items.push({
      kind: item.slice(0, separator) === "note" ? "note" : "source",
      id: item.slice(separator + 1),
      title: itemTitles.get(item) ?? "",
      topicId,
      topicTitle: titleOf(topicId)
    });
  };
  for (const event of events) {
    const current = titles.get(event.topicId);
    switch (event.op) {
      case "topic.create":
        // A creation is its own `after`; the inverse of one (an undo) deletes the topic again.
        if (event.after) {
          addTopic(after, event.topicId, event.after.title, titleOf(event.after.parentId));
        } else if (event.before) {
          addTopic(before, event.topicId, event.before.title, titleOf(event.before.parentId));
        }
        break;
      case "topic.retire":
        // A redirect re-point (F4 D19) leaves a retired topic retired: nothing leaves the tree.
        if (isRedirectEvent(event)) break;
        addTopic(before, event.topicId, current?.title ?? null, current?.parentTitle ?? null);
        break;
      case "topic.restore":
        addTopic(after, event.topicId, current?.title ?? null, current?.parentTitle ?? null);
        break;
      case "topic.rename":
        addTopic(before, event.topicId, event.before.title, current?.parentTitle ?? null);
        addTopic(after, event.topicId, event.after.title, current?.parentTitle ?? null);
        break;
      case "topic.move":
        addTopic(before, event.topicId, current?.title ?? null, titleOf(event.before.parentId));
        addTopic(after, event.topicId, current?.title ?? null, titleOf(event.after.parentId));
        break;
      case "topic.describe":
      case "topic.manage":
        addTopic(before, event.topicId, current?.title ?? null, current?.parentTitle ?? null);
        addTopic(after, event.topicId, current?.title ?? null, current?.parentTitle ?? null);
        break;
      case "item.place":
        addItem(after, event.item, event.after.topicId);
        break;
      case "item.unplace":
        addItem(before, event.item, event.before.topicId);
        break;
      case "item.move":
        addItem(before, event.item, event.before.topicId);
        addItem(after, event.item, event.after.topicId);
        break;
    }
  }
  return { before, after, truncated };
}
