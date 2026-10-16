// What the zero-config end-to-end test (F2 T32) reads back from the database once the light lane
// drained: placements, topic names, E1 on the cached tree, the Unsorted share and the AI audit.
// Plain SELECTs on the library the run just made; the verdict is `assertions.ts`.
import { createLegacyStateRepository, hasLegacyContent } from "@app/db";
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

export interface StoreFacts {
  activeTree: { id: string; generation: string } | null;
  currentNotes: number;
  /** Current notes with exactly one primary placement on a live topic. */
  notesWithPrimary: number;
  notesWithoutPrimary: string[];
  topics: E6Topic[];
  /** Notes placed directly on the root (waiting, or Unsorted), and the ones that wait for the gate. */
  root: { directNotes: number; needsGate: number; needsVector: number };
  e1: E1Facts | null;
  /** The newest change-set that named a live topic; null when none was named. */
  lastNamedAt: Date | null;
  legacyRows: number;
  ingestionRuns: Array<{ status: string; count: number }>;
  /** Stages that failed inside a run that went on (a failed stage is recorded, not thrown). */
  failedStages: number;
  failedJobs: Array<{ type: string; count: number }>;
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
    aiCalls
  };
  if (!tree) {
    return {
      ...common,
      activeTree: null,
      notesWithPrimary: 0,
      notesWithoutPrimary: notes.slice(0, 10),
      topics: [],
      root: { directNotes: 0, needsGate: 0, needsVector: 0 },
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
    await pool.query<{ directNotes: number; needsGate: number; needsVector: number }>(
      `select count(*) filter (where p.item_kind = 'note')::int as "directNotes",
         count(*) filter (where p.item_kind = 'note' and p.needs_gate)::int as "needsGate",
         count(*) filter (where p.needs_vector)::int as "needsVector"
       from topic_placements p join topics t on t.id = p.topic_id
       where p.tree_id = $1::uuid and p.rank = 0 and t.role = 'root' and t.retired_at is null`,
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
    activeTree: tree,
    notesWithPrimary: notes.length - Number(missingCount.rows[0]?.count ?? 0),
    notesWithoutPrimary: missing.rows.map((row) => row.id),
    topics,
    root,
    e1: await collectE1(pool, tree.id, notes, sources),
    lastNamedAt: named?.at ? new Date(named.at) : null
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
