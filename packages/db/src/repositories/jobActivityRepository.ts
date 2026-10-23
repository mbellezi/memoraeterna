import type { JobLane, JobStatus, Queryable } from "./types.js";

/** What a reader of the job activity gets at most from one read. */
export const jobActivityChangedIdsMax = 50;

/**
 * A write commits some time after it chose its `updated_at` (the transaction's start), so the next
 * read starts this far before the previous cursor: it may name a job twice, never skip one.
 */
const cursorOverlapSql = "interval '1 second'";

/**
 * Jobs of one lane by state. A queued job a blocker set aside (D5, D7) counts as `blocked`, never as
 * `queued`: readers of queued work skip it.
 */
export type JobActivityCounts = Record<JobStatus | "blocked", number>;

export interface JobActivity {
  /** Jobs by lane and state; a combination with no job is zero. */
  counts: Record<JobLane, JobActivityCounts>;
  /** Jobs touched since the previous read, newest first (a superset is fine); empty at the first read. */
  changedIds: string[];
  /** More jobs were touched than `changedIds` holds. */
  changedIdsTruncated: boolean;
  /** The database clock at this read: pass it back as `since` on the next one. */
  cursor: string;
}

interface CountRow {
  lane: JobLane;
  status: keyof JobActivityCounts;
  count: number;
}

const emptyCounts = (): JobActivityCounts => ({
  queued: 0,
  blocked: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0
});

/**
 * The read behind `job.progress`: counts of the `jobs` table by lane and state (a blocked queued
 * job apart from the queued ones), and which jobs changed since the last read. Two cheap
 * statements per read; it writes nothing.
 */
export function createJobActivityRepository(db: Queryable) {
  return {
    async read(options: { since?: string | null; limit?: number } = {}): Promise<JobActivity> {
      const limit = Math.max(1, Math.min(options.limit ?? jobActivityChangedIdsMax, 500));
      // The cursor first: whatever commits during the read is covered by the next one.
      const clock = await db.query<{ cursor: string }>("select clock_timestamp()::text as cursor");
      const cursor = clock.rows[0]?.cursor;
      if (!cursor) throw new Error("job_activity_clock_unavailable");
      const [counted, changed] = await Promise.all([
        db.query<CountRow>(
          `select lane,
                  case when status = 'queued' and blocked_class is not null then 'blocked'
                       else status::text end as status,
                  count(*)::int as count
           from jobs
           group by 1, 2`
        ),
        options.since
          ? db.query<{ id: string }>(
              `select id from jobs
               where updated_at >= $1::timestamptz - ${cursorOverlapSql}
               order by updated_at desc, id
               limit $2`,
              [options.since, limit + 1]
            )
          : Promise.resolve({ rows: [] as Array<{ id: string }> })
      ]);
      const counts: JobActivity["counts"] = { heavy: emptyCounts(), light: emptyCounts() };
      for (const row of counted.rows) {
        const lane = counts[row.lane];
        if (lane && row.status in lane) lane[row.status] = row.count;
      }
      return {
        counts,
        changedIds: changed.rows.slice(0, limit).map((row) => row.id),
        changedIdsTruncated: changed.rows.length > limit,
        cursor
      };
    }
  };
}

export type JobActivityRepository = ReturnType<typeof createJobActivityRepository>;
