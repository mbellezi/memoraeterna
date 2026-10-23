// The reads behind the Gardener's status (F4 D27, T86): the unfinished tasks no blocker holds, the
// running jobs (whose durations feed the time-left estimate) and the coverage shares. It writes
// nothing. Blocked tasks come from `createJobBlockerRepository(db).blockedGroups()`.
import { currentTopicNoteSql } from "./topicTreeLoadRepository.js";
import type { Queryable } from "./types.js";

/** The unfinished tasks of one job type that no blocker holds (see `StatusTaskFacts`). */
export interface StatusTaskRow {
  type: string;
  running: number;
  /** Queued, due and free to run. */
  ready: number;
  /** Queued and due, but a task of the same scope is running. */
  sameScope: number;
  /** Queued for another attempt after a failed one. */
  retrying: number;
  /** Queued for later: a debounce, a re-request. */
  scheduled: number;
}

export interface StatusRunningJob {
  id: string;
  type: string;
  lockedAt: Date | null;
}

/** How a job that stopped running ended: its status and, when it finished, the time. */
export interface StatusJobEnd {
  id: string;
  status: string;
  finishedAt: Date | null;
}

/**
 * The counts the coverage shares are made of: the current notes, those placed in the active tree,
 * those matched in its embedding space, and the stored overviews with those whose members are
 * unchanged since they were written (D27).
 */
export interface StatusCoverageCounts {
  notes: number;
  placedNotes: number;
  matchedNotes: number;
  overviews: number;
  freshOverviews: number;
}

const currentNote = currentTopicNoteSql("a");

/**
 * The members fingerprint of a topic's subtree, as `topicOverviewSql.members` computes it for one
 * topic (an overview is stale when it differs): `md5` of the primary placements' `kind:id:vector
 * fingerprint`, in item order. A sidecar test holds the two equal.
 */
const memberFingerprint = `md5(coalesce(string_agg(
    p.item_kind || ':' || coalesce(p.note_id, p.source_item_id)::text || ':' ||
    coalesce(p.item_fingerprint, ''), ','
    order by p.item_kind, coalesce(p.note_id, p.source_item_id)), ''))`;

export const gardenerStatusSql = {
  /** $1 the job types to count, $2 how many seconds ahead a task scheduled for later still counts. */
  tasks: `select j.type,
      (count(*) filter (where j.status = 'running'))::int as running,
      (count(*) filter (where j.status = 'queued' and j.blocked_class is null
         and j.run_after <= now() and not held.same_scope))::int as ready,
      (count(*) filter (where j.status = 'queued' and j.blocked_class is null
         and j.run_after <= now() and held.same_scope))::int as "sameScope",
      (count(*) filter (where j.status = 'queued' and j.blocked_class is null
         and j.run_after > now() and j.attempts > 0))::int as retrying,
      (count(*) filter (where j.status = 'queued' and j.blocked_class is null
         and j.run_after > now() and j.attempts = 0
         and j.run_after <= now() + make_interval(secs => $2::float8)))::int as scheduled
    from jobs j
    cross join lateral (
      select j.scope_key is not null and j.status = 'queued' and exists (
        select 1 from jobs r where r.status = 'running' and r.scope_key = j.scope_key
      ) as same_scope
    ) held
    where j.status in ('queued', 'running') and j.type = any($1::text[])
    group by j.type
    order by j.type`,
  /** $1 the job types to read. */
  running: `select id, type, locked_at as "lockedAt" from jobs
    where status = 'running' and type = any($1::text[]) order by locked_at nulls last, id`,
  /** $1 job IDs. */
  ends: `select id, status::text as status, finished_at as "finishedAt" from jobs
    where id = any($1::uuid[])`,
  notes: `select count(*)::int as notes from atomic_notes a where ${currentNote}`,
  /** The current notes with a primary placement in the active tree. */
  placed: `select count(distinct p.note_id)::int as placed
    from topic_placements p
    join topic_trees t on t.id = p.tree_id and t.status = 'active'
    join atomic_notes a on a.id = p.note_id
    where p.item_kind = 'note' and p.rank = 0 and ${currentNote}`,
  /** The current notes matched in the embedding space of the active tree. */
  matched: `select count(*)::int as matched
    from note_match_state m
    join topic_trees t on t.status = 'active' and t.space_key = m.space_key
    join atomic_notes a on a.id = m.note_id
    where ${currentNote}`,
  /** The stored overviews of the active tree's live topics, and those whose members are unchanged. */
  overviews: `with recursive tree as (select id from topic_trees where status = 'active'),
    roots as (
      select o.topic_id, o.member_fingerprint
      from topic_overviews o
      join topics t on t.id = o.topic_id and t.retired_at is null
      join tree on tree.id = t.tree_id
    ),
    sub(root_id, id) as (
      select r.topic_id, r.topic_id from roots r
      union all
      select sub.root_id, c.id from sub
        join lateral (
          select k.id from topics k
           where k.tree_id = (select id from tree) and k.parent_id = sub.id
             and k.retired_at is null offset 0) c on true
    ),
    current as (
      select sub.root_id, ${memberFingerprint} as fingerprint
      from sub
      join topic_placements p on p.topic_id = sub.id and p.role = 'primary'
      group by sub.root_id
    )
    select count(*)::int as overviews,
           (count(*) filter (where r.member_fingerprint = coalesce(c.fingerprint, md5(''))))::int
             as "freshOverviews"
    from roots r left join current c on c.root_id = r.topic_id`
} as const;

export function createGardenerStatusRepository(db: Queryable) {
  return {
    /**
     * The unfinished tasks of these job types by type; a type with none is absent. A task scheduled
     * for later (a debounce, the daily housekeeping) counts only within `scheduledWithinSeconds`: one
     * due tomorrow is not work in progress.
     */
    async taskCounts(
      types: readonly string[],
      scheduledWithinSeconds = 300
    ): Promise<StatusTaskRow[]> {
      if (types.length === 0) return [];
      const result = await db.query<StatusTaskRow>(gardenerStatusSql.tasks, [
        [...types],
        scheduledWithinSeconds
      ]);
      return result.rows;
    },

    /** The running jobs of these types with the time each started (its claim). */
    async runningJobs(types: readonly string[]): Promise<StatusRunningJob[]> {
      if (types.length === 0) return [];
      const result = await db.query<{ id: string; type: string; lockedAt: Date | string | null }>(
        gardenerStatusSql.running,
        [[...types]]
      );
      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        lockedAt: row.lockedAt === null ? null : new Date(row.lockedAt)
      }));
    },

    /** How these jobs stand now; a job pruned meanwhile is absent. */
    async jobEnds(ids: readonly string[]): Promise<StatusJobEnd[]> {
      if (ids.length === 0) return [];
      const result = await db.query<{
        id: string;
        status: string;
        finishedAt: Date | string | null;
      }>(gardenerStatusSql.ends, [[...ids]]);
      return result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt)
      }));
    },

    /** What the coverage shares are made of; every count is zero for an empty library. */
    async coverage(): Promise<StatusCoverageCounts> {
      const [notes, placed, matched, overviews] = await Promise.all([
        db.query<{ notes: number }>(gardenerStatusSql.notes),
        db.query<{ placed: number }>(gardenerStatusSql.placed),
        db.query<{ matched: number }>(gardenerStatusSql.matched),
        db.query<{ overviews: number; freshOverviews: number }>(gardenerStatusSql.overviews)
      ]);
      return {
        notes: Number(notes.rows[0]?.notes ?? 0),
        placedNotes: Number(placed.rows[0]?.placed ?? 0),
        matchedNotes: Number(matched.rows[0]?.matched ?? 0),
        overviews: Number(overviews.rows[0]?.overviews ?? 0),
        freshOverviews: Number(overviews.rows[0]?.freshOverviews ?? 0)
      };
    }
  };
}

export type GardenerStatusRepository = ReturnType<typeof createGardenerStatusRepository>;
