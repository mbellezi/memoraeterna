// What the zero-config end-to-end test (F2 T32) reads back from the database once the light lane
// drained: placements, topic names, E1 on the cached tree, the Unsorted share and the AI audit.
// Plain SELECTs on the library the run just made; the verdict is `assertions.ts`.
import { createHash } from "node:crypto";

import { createLegacyStateRepository, hasLegacyContent, noteRelationStateLabelSql } from "@app/db";
import type { PgPool } from "@app/db";
import { areasActive, itemKey, isLive, shapeReport, walkTopics } from "@app/domain/topic-tree";

import { loadTopicTreeCache } from "../topic-tree/topic-cache.js";

export interface E6Topic {
  id: string;
  parentId: string | null;
  title: string | null;
  nameState: string;
  nameSource: string | null;
  nameLanguage: string | null;
  /** Notes whose primary placement is this topic. */
  notes: number;
}

export interface E1Facts {
  /** Current notes and current root sources. */
  items: number;
  reachable: number;
  reachability: number;
  /** Live topics off the root, placements on retired topics and items without a primary. */
  orphans: { topics: number; retiredPlacements: number; unplaced: number; total: number };
  hardViolations: number;
  hardReasons: string[];
  softViolations: Record<string, number>;
  /** Items the Unsorted share counts (D27) over the items; reported, not gating. */
  unsortedShare: number;
  needsVectorItems: number;
}

/**
 * The end state as content, with no ID and no time: what two replays of one recording must share
 * (F3 T55k). `digest` covers the topics (name, parent, notes) and every note relation (the notes by
 * title, type, direction, band, status and veto).
 */
export interface EndStateFacts {
  noteRelations: number;
  sourceRelations: number;
  digest: string;
}

export interface StoreFacts {
  activeTree: { id: string; generation: string } | null;
  currentNotes: number;
  /** Current notes with exactly one primary placement on a live topic. */
  notesWithPrimary: number;
  notesWithoutPrimary: string[];
  topics: E6Topic[];
  /** Notes placed directly on the root (waiting, or Unsorted), and the ones that wait for the gate. */
  root: { directNotes: number; needsGate: number; needsVector: number; fallbackNone: number };
  /**
   * The gate's no-decider fallback (owner decision 19): current notes it decided that still owe a
   * ranker decision (`fallback-none`, wherever REBALANCE moved them), notes that wait for the gate
   * anywhere (`needs_gate`), and the items the fallback decided over the run (change-set summaries).
   */
  fallback: { notes: number; waitingNotes: number; decisions: number };
  e1: E1Facts | null;
  /** The newest change-set that named a live topic; null when none was named. */
  lastNamedAt: Date | null;
  legacyRows: number;
  ingestionRuns: Array<{ status: string; count: number }>;
  /** Stages that failed inside a run that went on (a failed stage is recorded, not thrown). */
  failedStages: number;
  failedJobs: Array<{ type: string; count: number }>;
  /**
   * Matching over the ingestion runs (F3 D25): the runs that decided their notes, the runs whose
   * graph stage failed, and how many of those still decided theirs.
   */
  matching: {
    runs: number;
    matchedRuns: number;
    graphFailedRuns: number;
    graphFailedMatchedRuns: number;
  };
  endState: EndStateFacts;
  aiCalls: Array<{ taskType: string; adapter: string | null; status: string; count: number }>;
}

const expectedNotesSql = `select id::text as id from atomic_notes
  where status::text not in ('rejected', 'archived') and supersession_status = 'current'`;
const expectedSourcesSql =
  "select id::text as id from source_items where parent_source_item_id is null";

export async function collectStoreFacts(pool: PgPool): Promise<StoreFacts> {
  const tree = (
    await pool.query<{ id: string; generation: string }>(
      "select id::text as id, generation::text as generation from topic_trees where status = 'active'"
    )
  ).rows[0];
  const notes = (await pool.query<{ id: string }>(expectedNotesSql)).rows.map((row) => row.id);
  const sources = (await pool.query<{ id: string }>(expectedSourcesSql)).rows.map((row) => row.id);
  const legacy = await createLegacyStateRepository(pool).legacyContentCounts();
  const ingestionRuns = (
    await pool.query<{ status: string; count: number }>(
      "select status::text as status, count(*)::int as count from ingestion_runs group by 1 order by 1"
    )
  ).rows;
  const failedStages = Number(
    (
      await pool.query<{ count: number }>(
        `select count(*)::int as count from ingestion_runs r,
           jsonb_each(coalesce(r.stages_checkpoint, '{}'::jsonb)) as stage
         where stage.value ->> 'status' = 'failed'`
      )
    ).rows[0]?.count ?? 0
  );
  const failedJobs = (
    await pool.query<{ type: string; count: number }>(
      `select type::text as type, count(*)::int as count from jobs
       where status::text in ('failed') group by 1 order by 1`
    )
  ).rows;
  const matching = (
    await pool.query<StoreFacts["matching"]>(
      `select count(*)::int as runs,
         count(*) filter (where matched)::int as "matchedRuns",
         count(*) filter (where graph_failed)::int as "graphFailedRuns",
         count(*) filter (where graph_failed and matched)::int as "graphFailedMatchedRuns"
       from (select coalesce(stages_checkpoint -> 'atomicNoteMatching' ->> 'status' = 'completed', false) as matched,
                    coalesce(stages_checkpoint -> 'knowledgeGraph' ->> 'status' = 'failed', false) as graph_failed
             from ingestion_runs) runs`
    )
  ).rows[0]!;
  const aiCalls = (
    await pool.query<{ taskType: string; adapter: string | null; status: string; count: number }>(
      `select task_type::text as "taskType", adapter, status::text as status, count(*)::int as count
       from ai_task_runs group by 1, 2, 3 order by 1, 2, 3`
    )
  ).rows;
  const common = {
    currentNotes: notes.length,
    legacyRows: hasLegacyContent(legacy) ? 1 : 0,
    ingestionRuns,
    failedStages,
    failedJobs,
    matching,
    aiCalls
  };
  if (!tree) {
    return {
      ...common,
      endState: await collectEndState(pool, []),
      activeTree: null,
      notesWithPrimary: 0,
      notesWithoutPrimary: notes.slice(0, 10),
      topics: [],
      root: { directNotes: 0, needsGate: 0, needsVector: 0, fallbackNone: 0 },
      fallback: { notes: 0, waitingNotes: 0, decisions: 0 },
      e1: null,
      lastNamedAt: null
    };
  }

  const missing = await pool.query<{ id: string }>(
    `select n.id::text as id from atomic_notes n
     where n.status::text not in ('rejected', 'archived') and n.supersession_status = 'current'
       and (select count(*) from topic_placements p
              join topics t on t.id = p.topic_id and t.retired_at is null
            where p.tree_id = $1::uuid and p.item_kind = 'note' and p.note_id = n.id and p.rank = 0) <> 1
     order by n.id limit 10`,
    [tree.id]
  );
  const missingCount = await pool.query<{ count: number }>(
    `select count(*)::int as count from atomic_notes n
     where n.status::text not in ('rejected', 'archived') and n.supersession_status = 'current'
       and (select count(*) from topic_placements p
              join topics t on t.id = p.topic_id and t.retired_at is null
            where p.tree_id = $1::uuid and p.item_kind = 'note' and p.note_id = n.id and p.rank = 0) <> 1`,
    [tree.id]
  );
  const topics = (
    await pool.query<{
      id: string;
      parentId: string | null;
      title: string | null;
      nameState: string;
      nameSource: string | null;
      nameLanguage: string | null;
      notes: number;
    }>(
      `select t.id::text as id, t.parent_id::text as "parentId", t.title, t.name_state as "nameState",
         t.name_source as "nameSource", t.name_language as "nameLanguage",
         (select count(*) from topic_placements p
          where p.topic_id = t.id and p.rank = 0 and p.item_kind = 'note')::int as notes
       from topics t
       where t.tree_id = $1::uuid and t.retired_at is null and t.role = 'topic'
       order by t.title nulls last, t.id`,
      [tree.id]
    )
  ).rows;
  const root = (
    await pool.query<{
      directNotes: number;
      needsGate: number;
      needsVector: number;
      fallbackNone: number;
    }>(
      `select count(*) filter (where p.item_kind = 'note')::int as "directNotes",
         count(*) filter (where p.item_kind = 'note' and p.needs_gate)::int as "needsGate",
         count(*) filter (where p.needs_vector)::int as "needsVector",
         count(*) filter (where p.item_kind = 'note' and p.decided_by = 'fallback-none')::int
           as "fallbackNone"
       from topic_placements p join topics t on t.id = p.topic_id
       where p.tree_id = $1::uuid and p.rank = 0 and t.role = 'root' and t.retired_at is null`,
      [tree.id]
    )
  ).rows[0]!;
  const fallbackNotes = (
    await pool.query<{ notes: number; waitingNotes: number }>(
      `select count(*) filter (where p.decided_by = 'fallback-none')::int as notes,
         count(*) filter (where p.needs_gate)::int as "waitingNotes"
       from topic_placements p
       where p.tree_id = $1::uuid and p.rank = 0 and p.item_kind = 'note'`,
      [tree.id]
    )
  ).rows[0]!;
  const fallbackDecisions = (
    await pool.query<{ decisions: number }>(
      `select coalesce(sum(coalesce((c.summary ->> 'fallbackNone')::int, 0)
           + coalesce((c.summary ->> 'fallback')::int, 0)), 0)::int as decisions
       from topic_change_sets c
       where c.tree_id = $1::uuid and c.status = 'applied' and c.origin in ('place', 'gate')`,
      [tree.id]
    )
  ).rows[0]!;
  const named = (
    await pool.query<{ at: Date | null }>(
      `select max(c.applied_at) as at from topics t
         join topic_change_sets c on c.id = t.named_change_set_id
       where t.tree_id = $1::uuid and t.retired_at is null and t.role = 'topic'`,
      [tree.id]
    )
  ).rows[0];

  return {
    ...common,
    endState: await collectEndState(pool, topics),
    activeTree: tree,
    notesWithPrimary: notes.length - Number(missingCount.rows[0]?.count ?? 0),
    notesWithoutPrimary: missing.rows.map((row) => row.id),
    topics,
    root,
    fallback: {
      notes: fallbackNotes.notes,
      waitingNotes: fallbackNotes.waitingNotes,
      decisions: fallbackDecisions.decisions
    },
    e1: await collectE1(pool, tree.id, notes, sources),
    lastNamedAt: named?.at ? new Date(named.at) : null
  };
}

/** The relations and the topics as content, hashed: two replays of one recording share the digest. */
async function collectEndState(pool: PgPool, topics: readonly E6Topic[]): Promise<EndStateFacts> {
  const rows = (
    await pool.query<{
      lo: string;
      hi: string;
      type: string | null;
      direction: string;
      band: string | null;
      status: string;
      state: string;
    }>(
      `select lo.title as lo, hi.title as hi, r.relation_type as type, r.direction, r.band,
         r.status::text as status, ${noteRelationStateLabelSql("r")} as state
       from atomic_note_relations r
         join atomic_notes lo on lo.id = r.source_atomic_note_id
         join atomic_notes hi on hi.id = r.target_atomic_note_id`
    )
  ).rows;
  const sourceRelations = Number(
    (await pool.query<{ count: number }>("select count(*)::int as count from source_relations"))
      .rows[0]?.count ?? 0
  );
  const relations = rows
    .map((row) => {
      // The pair reads in UUID order; the digest names the notes by title, in the relation's direction.
      const [from, to] =
        row.direction === "lo_to_hi"
          ? [row.lo, row.hi]
          : row.direction === "hi_to_lo"
            ? [row.hi, row.lo]
            : [row.lo, row.hi].sort();
      return JSON.stringify([from, to, row.type, row.band, row.status, row.state]);
    })
    .sort();
  const titles = new Map(topics.map((topic) => [topic.id, topic.title ?? ""]));
  const placed = topics
    .map((topic) =>
      JSON.stringify([topic.title ?? "", titles.get(topic.parentId ?? "") ?? "", topic.notes])
    )
    .sort();
  return {
    noteRelations: rows.length,
    sourceRelations,
    digest: createHash("sha256")
      .update(JSON.stringify({ topics: placed, relations }))
      .digest("hex")
  };
}

/** E1 on the tree the engine cached: the domain invariants plus the orphan counts of its definition. */
async function collectE1(
  pool: PgPool,
  treeId: string,
  notes: readonly string[],
  sources: readonly string[]
): Promise<E1Facts | null> {
  const cache = await loadTopicTreeCache(pool, treeId);
  if (!cache) return null;
  const { state, config } = cache;
  const expected = [
    ...notes.map((id) => itemKey("note", id)),
    ...sources.map((id) => itemKey("source", id))
  ];
  const report = shapeReport(state, config, {
    areasActive: areasActive(state),
    expectedItems: expected
  });
  const reached = new Set<string>();
  walkTopics(state, (node) => reached.add(node.id));
  let offRoot = 0;
  for (const node of state.topics.values()) if (isLive(node) && !reached.has(node.id)) offRoot += 1;
  let retiredPlacements = 0;
  for (const placements of state.placements.values()) {
    for (const placement of placements) {
      const topic = state.topics.get(placement.topicId);
      if (!topic || !isLive(topic)) retiredPlacements += 1;
    }
  }
  const unplaced = expected.filter(
    (item) => !state.placements.get(item)?.some((placement) => placement.rank === 0)
  ).length;
  return {
    items: report.items,
    reachable: report.reachable,
    reachability: report.reachability,
    orphans: {
      topics: offRoot,
      retiredPlacements,
      unplaced,
      total: offRoot + retiredPlacements + unplaced
    },
    hardViolations: report.violations.hardCount,
    hardReasons: report.violations.hard,
    softViolations: report.violations.soft,
    unsortedShare: report.unsortedShare,
    needsVectorItems: report.needsVectorItems
  };
}
