import type { PoolClient, QueryResultRow } from "pg";

import type { NoteRelationBand } from "@app/domain";

import type { PgPool } from "../client.js";
import { currentNoteSql, noteRelationStateSql, shownNoteRelationSql } from "./note-relation-sql.js";

/**
 * Read model of `relations.branch` (F5 D19, Map › Grafo): the note graph of one branch of the
 * active topic tree, or of one source, in one read-only snapshot without AI.
 *
 *   scope       a topic (it and its live descendants; a retired topic is read through
 *               `redirect_to`) or a source (it and the sources below it: their current notes, and
 *               the topics those notes are primarily placed in with their ancestors below the root)
 *   notes       the scope's current notes, each in its primary topic (a source's note the tree has
 *               not placed yet has none), ranked by degree inside the scope, then by recency
 *               (`created_at`), then ID; at most `perTopicLimit` per topic and `noteLimit` in all
 *   edges       the shown relations among the drawn notes, strongest first (probability, unknown
 *               last, then the stored score and ID), at most `relationLimit`
 *   outside     the shown relations from a drawn note to a current note outside the scope, counted
 *               per that note's primary topic (the strongest `outsideMax` topics); bounded by the
 *               drawn notes, so a large branch never reads every relation leaving it
 *   superEdges  the shown relations inside the scope between two colour groups, counted per pair
 *               (the strongest `superEdgeMax` pairs): the topic super-nodes of the zoomed-out canvas
 *   truncated   a scope note or a relation among the drawn notes was left out by a limit
 *
 * Colours: the colour group of a topic is its ancestor-or-self at `colourDepth` (relative to the
 * scope topic; for a source, to the tree root), or the topic itself when it is shallower. The
 * groups at `colourDepth` take indices in the stable order of their titles (code units, an unnamed
 * topic as ""), then IDs; the shallower ones follow in the order of depth, title and ID; the index is
 * that position modulo `colourCount`, so a call with the same scope and depth always colours alike
 * whatever the note limits. The renderer maps index i to `--graph-topic-<i + 1>`.
 *
 * Relations are read only through the predicates of `note-relation-sql.ts` (D9, D11): an edge, a
 * degree, an outside count and a super-edge all count shown relations (applied, kept or suggested)
 * between two current notes. `scripts/bench/branch-bench.ts` measures the read.
 */

export const relationBranchLimits = {
  /** Colours of `--graph-topic-1..12`. */
  colourCount: 12,
  /** Outside topics listed, the most connected first. */
  outsideMax: 40,
  /** Super-edges listed, the heaviest first. */
  superEdgeMax: 500,
  /** Source levels walked below the scope source. */
  sourceDepthMax: 8,
  /** Topic levels walked below the scope topic (the tree is capped well below it). */
  topicDepthMax: 16,
  /** Redirects followed from a retired topic (the bound of `objects.get` and `locate`). */
  redirectMax: 8
} as const;

export type RelationBranchScope = { topicId: string } | { sourceId: string };

export interface RelationBranchRequest {
  scope: RelationBranchScope;
  colourDepth: 1 | 2 | 3;
  noteLimit: number;
  perTopicLimit: number;
  relationLimit: number;
}

export interface RelationBranchTopic {
  id: string;
  /** "" for an unnamed topic or the tree root: the interface localizes the label. */
  title: string;
  colourIndex: number;
  /** Null for the tree root; a parent outside the list for the scope topic of a branch. */
  parentId: string | null;
  /** The scope's current notes primarily placed in this topic itself (not its subtopics). */
  noteCount: number;
}

export interface RelationBranchNode {
  id: string;
  title: string;
  /** The note's primary topic; null for a source's note the tree has not placed yet. */
  topicId: string | null;
  /** Shown relations to other notes of the scope. */
  degree: number;
}

export interface RelationBranchEdge {
  id: string;
  /** The stored endpoints (lower ID first); the direction is not part of this read. */
  a: string;
  b: string;
  type: string;
  band: NoteRelationBand | null;
}

export interface RelationBranchRead {
  /** A topic scope: the scope topic first, then by depth, title and ID. */
  topics: RelationBranchTopic[];
  nodes: RelationBranchNode[];
  edges: RelationBranchEdge[];
  outside: { topicId: string; title: string; edgeCount: number }[];
  superEdges: { a: string; b: string; weight: number }[];
  truncated: boolean;
}

interface TopicRow extends QueryResultRow {
  id: string;
  parentId: string | null;
  title: string | null;
}

interface BranchRow extends QueryResultRow {
  noteTotal: number;
  topicCounts: { topicId: string; n: number }[];
  nodes: RelationBranchNode[];
  edges: RelationBranchEdge[];
  outside: { topicId: string; title: string; edgeCount: number }[];
  superEdges: { a: string; b: string; weight: number }[];
}

const activeTree = `(select tree.id from topic_trees tree where tree.status = 'active')`;

/**
 * $1 topic, $2 redirects followed, $3 levels walked. The live topic (through `redirect_to` when it
 * is retired or its tree is) and its live descendants, the scope topic first. No row: no live topic.
 */
const topicScopeTopicsSql = `
with recursive follow(id, redirect_to, dead, depth) as (
  select t.id, t.redirect_to, (t.retired_at is not null or tree.status <> 'active'), 0
    from topics t join topic_trees tree on tree.id = t.tree_id where t.id = $1::uuid
  union all
  select t.id, t.redirect_to, (t.retired_at is not null or tree.status <> 'active'), f.depth + 1
    from follow f
    join topics t on t.id = f.redirect_to
    join topic_trees tree on tree.id = t.tree_id
   where f.dead and f.depth < $2::int
),
live as (select f.id from follow f where not f.dead order by f.depth limit 1),
sub(id, tree_id, parent_id, title, depth) as (
  select t.id, t.tree_id, t.parent_id, t.title, 0
    from topics t where t.id = (select id from live)
  union all
  select k.id, k.tree_id, k.parent_id, k.title, sub.depth + 1
    from sub join topics k on k.tree_id = sub.tree_id and k.parent_id = sub.id and k.retired_at is null
   where sub.depth < $3::int
)
select s.id, s.parent_id as "parentId", s.title from sub s`;

/**
 * The source, the sources below it and their current notes, each with its primary topic (if any);
 * `source` and `depth` are the placeholders of the source ID and the levels walked.
 */
const sourceScopeCtes = (source: string, depth: string) => `src(id, depth) as (
  select s.id, 0 from source_items s where s.id = ${source}::uuid
  union all
  select c.id, src.depth + 1 from src join source_items c on c.parent_source_item_id = src.id
   where src.depth < ${depth}::int
),
-- Read per source through each table's source index (OFFSET 0 keeps the laterals; a join or an
-- IN over the sources was planned as a scan of every note).
linked(id) as (
  select n.id from src cross join lateral (
    select n.id from atomic_notes n where n.created_from_source_item_id = src.id offset 0) n
  union select l.atomic_note_id from src cross join lateral (
    select l.atomic_note_id from atomic_note_source_links l where l.source_item_id = src.id offset 0) l
  union select e.note_id from src cross join lateral (
    select e.note_id from atomic_note_evidence e where e.source_id = src.id offset 0) e
),
scope_notes as materialized (
  select n.id, n.title, n.created_at, pl.topic_id, true as current
    from linked join atomic_notes n on n.id = linked.id
    left join lateral (
      select p.topic_id from topic_placements p
       where p.note_id = n.id and p.item_kind = 'note' and p.rank = 0 and p.tree_id = ${activeTree}
       limit 1) pl on true
   where ${currentNoteSql("n")}
)`;

/**
 * $1 source, $2 source levels walked. The live topics the source's current notes are primarily
 * placed in and their ancestors below the tree root. The source exists exactly when `exists` is true.
 */
const sourceScopeTopicsSql = `
with recursive ${sourceScopeCtes("$1", "$2")},
up(id, parent_id, title, role) as (
  select t.id, t.parent_id, t.title, t.role from topics t
   where t.id in (select topic_id from scope_notes) and t.retired_at is null
  union
  select t.id, t.parent_id, t.title, t.role from up join topics t on t.id = up.parent_id
   where t.retired_at is null
)
select u.id, u.parent_id as "parentId", u.title,
       exists (select 1 from src) as "exists"
  from up u where u.role <> 'root'
union all
-- One marker row says whether the source exists when it has no placed note.
select null, null, null, exists (select 1 from src)
 order by 1 nulls first`;

/** The scope notes of a topic branch: $8 the branch's topic IDs. */
const topicScopeNotesCte = `scope_notes as materialized (
  select n.id, n.title, n.created_at, p.topic_id, true as current
    from unnest($8::uuid[]) as branch(topic_id)
    -- Per topic through the placement index (OFFSET 0 keeps the lateral), so the cost follows the
    -- branch; an ANY over the topics was planned as a scan of every placement.
    cross join lateral (
      select p.topic_id, p.note_id from topic_placements p
       where p.topic_id = branch.topic_id and p.item_kind = 'note' and p.rank = 0
         and p.tree_id = ${activeTree}
      offset 0) p
    join atomic_notes n on n.id = p.note_id
   where ${currentNoteSql("n")}
)`;

const inner = (name: "a" | "b" | "c") => ({ alias: name, current: `${name}.current` });

/**
 * The graph of the scope notes: $1 notes per topic, $2 notes, $3 edges read (the limit plus one),
 * $4/$5 each topic and its colour group, $6 outside topics read, $7 super-edges read; the scope
 * from $8 on. One row.
 */
const graphSql = (scopeCtes: string) => `
with recursive ${scopeCtes},
-- The relations in a shown state that start at a scope note (each found once, through its stored
-- first endpoint), read per note by index (OFFSET 0 keeps the lateral one), so the cost follows the
-- scope, not the library; then every one of them between two scope notes, by one hash join.
outgoing as materialized (
  select r.id, r.source_atomic_note_id, r.target_atomic_note_id, r.relation_type, r.band,
         r.status, r.vetoed_at, r.probability, r.final_score
    from scope_notes a
    cross join lateral (
      select r.* from atomic_note_relations r
       where r.source_atomic_note_id = a.id and ${noteRelationStateSql.shown("r")}
      offset 0) r
),
internal as materialized (
  select r.id, r.source_atomic_note_id as lo, r.target_atomic_note_id as hi,
         coalesce(r.relation_type, 'related') as type, r.band, r.probability, r.final_score
    from outgoing r
    join scope_notes a on a.id = r.source_atomic_note_id
    join scope_notes b on b.id = r.target_atomic_note_id
   where ${shownNoteRelationSql("r", [inner("a"), inner("b")])}
),
degree as (
  select x.id, count(*)::int as n
    from (select lo as id from internal union all select hi from internal) x group by x.id
),
ranked as (
  select s.id, s.title, s.topic_id, coalesce(d.n, 0) as degree, s.created_at,
         row_number() over (partition by s.topic_id
                            order by coalesce(d.n, 0) desc, s.created_at desc, s.id) as topic_rank
    from scope_notes s left join degree d on d.id = s.id
),
chosen as materialized (
  select r.id, r.title, r.topic_id, r.degree, true as current,
         row_number() over (order by r.degree desc, r.created_at desc, r.id) as ord
    from ranked r where r.topic_rank <= $1::int
   order by r.degree desc, r.created_at desc, r.id
   limit $2::int
),
drawn as (
  select i.* from internal i
   where i.lo in (select id from chosen) and i.hi in (select id from chosen)
   order by i.probability desc nulls last, i.final_score desc, i.id
   limit $3::int
),
-- The relations of the drawn notes whose other note is outside the scope (bounded by the drawn
-- notes, so a large branch never reads every relation leaving it). NOT IN over the scope notes is
-- one hashed lookup; a join or NOT EXISTS on the materialized scope was planned as a scan per row.
outside_rel as (
  select r.id, op.topic_id
    from chosen c
    cross join lateral (
      select r.id, r.status, r.band, r.vetoed_at, r.target_atomic_note_id as other_id
        from atomic_note_relations r
       where r.source_atomic_note_id = c.id and ${noteRelationStateSql.shown("r")}
      union all
      select r.id, r.status, r.band, r.vetoed_at, r.source_atomic_note_id
        from atomic_note_relations r
       where r.target_atomic_note_id = c.id and ${noteRelationStateSql.shown("r")}) r
    join atomic_notes o on o.id = r.other_id
    cross join lateral (
      select p.topic_id from topic_placements p
       where p.note_id = o.id and p.item_kind = 'note' and p.rank = 0 and p.tree_id = ${activeTree}
       limit 1) op
   where r.other_id not in (select id from scope_notes)
     and ${shownNoteRelationSql("r", [inner("c"), "o"])}
),
outside as (
  -- Counted first, then each topic read by its key; OFFSET 0 keeps the lookup per topic (a plain
  -- join was planned as a scan of every topic per row).
  select g.topic_id, coalesce(t.title, '') as title, g.edge_count
    from (select topic_id, count(*)::int as edge_count from outside_rel group by topic_id) g
    cross join lateral (
      select t.title from topics t where t.id = g.topic_id and t.retired_at is null offset 0) t
   order by g.edge_count desc, coalesce(t.title, ''), g.topic_id
   limit $6::int
),
colour_group as (
  select x.topic_id, x.group_id from unnest($4::uuid[], $5::uuid[]) as x(topic_id, group_id)
),
super as (
  select least(ga.group_id, gb.group_id) as a, greatest(ga.group_id, gb.group_id) as b,
         count(*)::int as weight
    from internal i
    join scope_notes na on na.id = i.lo join scope_notes nb on nb.id = i.hi
    join colour_group ga on ga.topic_id = na.topic_id
    join colour_group gb on gb.topic_id = nb.topic_id
   where ga.group_id <> gb.group_id
   group by 1, 2
   order by weight desc, a, b
   limit $7::int
)
select
  (select count(*)::int from scope_notes) as "noteTotal",
  coalesce((select jsonb_agg(jsonb_build_object('topicId', c.topic_id, 'n', c.n))
              from (select topic_id, count(*)::int as n from scope_notes
                     where topic_id is not null group by topic_id) c), '[]'::jsonb) as "topicCounts",
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'topicId', c.topic_id,
                                                'degree', c.degree) order by c.ord)
              from chosen c), '[]'::jsonb) as nodes,
  coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'a', d.lo, 'b', d.hi, 'type', d.type,
                                                'band', d.band)
                             order by d.probability desc nulls last, d.final_score desc, d.id)
              from drawn d), '[]'::jsonb) as edges,
  coalesce((select jsonb_agg(jsonb_build_object('topicId', o.topic_id, 'title', o.title,
                                                'edgeCount', o.edge_count)
                             order by o.edge_count desc, o.title, o.topic_id)
              from outside o), '[]'::jsonb) as outside,
  coalesce((select jsonb_agg(jsonb_build_object('a', s.a, 'b', s.b, 'weight', s.weight)
                             order by s.weight desc, s.a, s.b)
              from super s), '[]'::jsonb) as "superEdges"`;

const topicGraphSql = graphSql(topicScopeNotesCte);
const sourceGraphSql = graphSql(sourceScopeCtes("$8", "$9"));

/** Code-unit order: the same on every machine and runtime, so colours never move with a locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface PlacedTopic {
  id: string;
  parentId: string | null;
  title: string;
  depth: number;
}

/**
 * Depths in the scope: a topic whose parent is not listed starts at `base` (0 for the scope topic of
 * a branch; 1 for a source, whose list stops below the tree root).
 */
function withDepths(rows: TopicRow[], base: number): PlacedTopic[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depths = new Map<string, number>();
  const depthOf = (id: string, guard = 0): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const row = byId.get(id)!;
    const parent = row.parentId;
    const depth =
      parent && byId.has(parent) && guard < relationBranchLimits.topicDepthMax
        ? depthOf(parent, guard + 1) + 1
        : base;
    depths.set(id, depth);
    return depth;
  };
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    title: row.title ?? "",
    depth: depthOf(row.id)
  }));
}

/**
 * Each topic's colour group (its ancestor-or-self at `colourDepth`, or itself when shallower) and
 * each group's colour index, as documented at the top of this module. Pure, for the tests.
 */
export function relationBranchColours(
  topics: readonly PlacedTopic[],
  colourDepth: number
): { groupOf: Map<string, string>; colourOf: Map<string, number> } {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const groupOf = new Map<string, string>();
  const groupFor = (topic: PlacedTopic): string => {
    const known = groupOf.get(topic.id);
    if (known !== undefined) return known;
    let group = topic.id;
    if (topic.depth > colourDepth) {
      const parent = topic.parentId ? byId.get(topic.parentId) : undefined;
      group = parent ? groupFor(parent) : topic.id;
    }
    groupOf.set(topic.id, group);
    return group;
  };
  for (const topic of topics) groupFor(topic);
  const groups = [...new Set(groupOf.values())].map((id) => byId.get(id)!);
  const atDepth = groups
    .filter((group) => group.depth === colourDepth)
    .sort((x, y) => compareText(x.title, y.title) || compareText(x.id, y.id));
  const shallower = groups
    .filter((group) => group.depth !== colourDepth)
    .sort((x, y) => x.depth - y.depth || compareText(x.title, y.title) || compareText(x.id, y.id));
  const colourOf = new Map<string, number>();
  [...atDepth, ...shallower].forEach((group, index) =>
    colourOf.set(group.id, index % relationBranchLimits.colourCount)
  );
  return { groupOf, colourOf };
}

interface Statement {
  text: string;
  values: unknown[];
}

interface PreparedBranch {
  topics: Statement;
  graph: Statement;
  placed: PlacedTopic[];
  groupOf: Map<string, string>;
  colourOf: Map<string, number>;
}

/** Reads the scope's topics and builds the graph statement; null when the scope does not exist. */
async function prepareBranch(
  client: PoolClient,
  request: RelationBranchRequest
): Promise<PreparedBranch | null> {
  const { scope, colourDepth, noteLimit, perTopicLimit, relationLimit } = request;
  let topics: Statement;
  let topicRows: TopicRow[];
  let base: number;
  let graphText: string;
  let scopeValues: unknown[];
  if ("topicId" in scope) {
    topics = {
      text: topicScopeTopicsSql,
      values: [scope.topicId, relationBranchLimits.redirectMax, relationBranchLimits.topicDepthMax]
    };
    topicRows = (await client.query<TopicRow>(topics.text, topics.values)).rows;
    if (topicRows.length === 0) return null;
    base = 0;
    graphText = topicGraphSql;
    scopeValues = [topicRows.map((row) => row.id)];
  } else {
    topics = {
      text: sourceScopeTopicsSql,
      values: [scope.sourceId, relationBranchLimits.sourceDepthMax]
    };
    const rows = (await client.query<TopicRow & { exists: boolean }>(topics.text, topics.values))
      .rows;
    if (!rows[0]?.exists) return null;
    topicRows = rows.filter((row) => row.id !== null);
    base = 1;
    graphText = sourceGraphSql;
    scopeValues = [scope.sourceId, relationBranchLimits.sourceDepthMax];
  }
  const placed = withDepths(topicRows, base);
  const { groupOf, colourOf } = relationBranchColours(placed, colourDepth);
  const groupPairs = [...groupOf.entries()];
  return {
    topics,
    graph: {
      text: graphText,
      values: [
        perTopicLimit,
        noteLimit,
        relationLimit + 1,
        groupPairs.map(([topicId]) => topicId),
        groupPairs.map(([, group]) => group),
        relationBranchLimits.outsideMax,
        relationBranchLimits.superEdgeMax,
        ...scopeValues
      ]
    },
    placed,
    groupOf,
    colourOf
  };
}

/** Runs `work` in one repeatable-read, read-only snapshot on its own connection. */
async function inSnapshot<T>(pool: PgPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin transaction isolation level repeatable read, read only");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createRelationBranchRepository(pool: PgPool) {
  return {
    /**
     * Null when the topic has no live successor or the source does not exist. One consistent
     * snapshot: repeatable read, read only.
     */
    read(request: RelationBranchRequest): Promise<RelationBranchRead | null> {
      return inSnapshot(pool, async (client) => {
        const prepared = await prepareBranch(client, request);
        if (!prepared) return null;
        const { relationLimit } = request;
        const row = (await client.query<BranchRow>(prepared.graph.text, prepared.graph.values))
          .rows[0]!;
        const counts = new Map(row.topicCounts.map((count) => [count.topicId, count.n]));
        const { groupOf, colourOf } = prepared;
        return {
          topics: sortByDepth(prepared.placed).map((topic) => ({
            id: topic.id,
            title: topic.title,
            colourIndex: colourOf.get(groupOf.get(topic.id)!)!,
            parentId: topic.parentId,
            noteCount: counts.get(topic.id) ?? 0
          })),
          nodes: row.nodes,
          edges: row.edges.slice(0, relationLimit),
          outside: row.outside,
          superEdges: row.superEdges,
          truncated: row.noteTotal > row.nodes.length || row.edges.length > relationLimit
        };
      });
    },

    /**
     * The executed plans (`explain (analyze, format json)`) of the two statements `read` runs for
     * this request, for `scripts/bench/branch-bench.ts`; null when the scope does not exist.
     */
    explain(request: RelationBranchRequest): Promise<{ topics: unknown; graph: unknown } | null> {
      return inSnapshot(pool, async (client) => {
        const prepared = await prepareBranch(client, request);
        if (!prepared) return null;
        const plan = async ({ text, values }: Statement) =>
          (
            await client.query<{ "QUERY PLAN": unknown }>(
              `explain (analyze, format json) ${text}`,
              values
            )
          ).rows[0]!["QUERY PLAN"];
        return { topics: await plan(prepared.topics), graph: await plan(prepared.graph) };
      });
    }
  };
}

function sortByDepth(topics: PlacedTopic[]): PlacedTopic[] {
  return [...topics].sort(
    (x, y) => x.depth - y.depth || compareText(x.title, y.title) || compareText(x.id, y.id)
  );
}
