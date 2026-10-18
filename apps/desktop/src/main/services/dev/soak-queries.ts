import { shownNoteRelationSql, type PgPool } from "@app/db";

import type { SoakSample, TaskRunRecord } from "./soak-records.js";

/**
 * The SQL of the soak's ports (F3 T62): what the driver picks to explain, edit and ask about, and
 * what the collector reads every minute. Kept apart from the ports so a real PostgreSQL test can
 * run each statement against the product's schema.
 */

type Db = Pick<PgPool, "query">;

/**
 * Relations the Note page shows, those with no explanation first, in an order that depends on
 * `seed` only. `explained` says the relation already has a stored explanation.
 */
export async function pickRelationsToExplain(
  db: Db,
  count: number,
  seed: number
): Promise<Array<{ id: string; explained: boolean }>> {
  const result = await db.query<{ id: string; explained: boolean }>(
    `select r.id::text as id, (x.relation_id is not null) as explained
       from atomic_note_relations r
       join atomic_notes a on a.id = r.source_atomic_note_id
       join atomic_notes b on b.id = r.target_atomic_note_id
       left join atomic_note_relation_explanations x on x.relation_id = r.id
      where ${shownNoteRelationSql("r", ["a", "b"])}
      order by (x.relation_id is not null), md5(r.id::text || $2::text)
      limit $1`,
    [count, String(seed)]
  );
  return result.rows;
}

/** Forgets stored explanations, so opening the relation again asks the writer (a DEV clone only). */
export async function forgetExplanations(db: Db, relationIds: readonly string[]): Promise<number> {
  if (relationIds.length === 0) return 0;
  const result = await db.query(
    "delete from atomic_note_relation_explanations where relation_id = any($1::uuid[])",
    [relationIds]
  );
  return result.rowCount ?? 0;
}

/** A note no person edited yet (an edit protects it), in a seeded order. */
export async function pickEditableNote(
  db: Db,
  seed: number,
  index: number
): Promise<{ id: string; title: string; bodyMarkdown: string; updatedAt: string } | null> {
  const result = await db.query<{
    id: string;
    title: string;
    bodyMarkdown: string;
    updatedAt: Date;
  }>(
    `select id::text as id, title, body_markdown as "bodyMarkdown", updated_at as "updatedAt"
       from atomic_notes
      where status in ('active', 'approved') and supersession_status = 'current'
        and coalesce(metadata ->> 'humanProtected', 'false') <> 'true'
      order by md5(id::text || $1::text || $2::text)
      limit 1`,
    [String(seed), String(index)]
  );
  const row = result.rows[0];
  return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null;
}

/** The title of a source in the library, chosen by `seed` and `index`: what a question is about. */
export async function pickQuestionTitle(
  db: Db,
  seed: number,
  index: number
): Promise<string | null> {
  const result = await db.query<{ title: string }>(
    `select title from source_items
      where title is not null and length(trim(title)) > 2
      order by md5(id::text || $1::text || $2::text) limit 1`,
    [String(seed), String(index)]
  );
  return result.rows[0]?.title ?? null;
}

/** Jobs that are queued or running now, and the number of jobs in each status. */
export async function readJobs(
  db: Db
): Promise<{ jobs: SoakSample["jobs"]; counts: SoakSample["jobCounts"] }> {
  const [jobs, counts] = await Promise.all([
    db.query<SoakSample["jobs"][number]>(
      `select id::text as id, type, status::text as status, lane,
              payload ->> 'sourceItemId' as "sourceItemId", attempts,
              (extract(epoch from updated_at) * 1000)::float8 as "updatedAt",
              (extract(epoch from run_after) * 1000)::float8 as "runAfter",
              (extract(epoch from locked_at) * 1000)::float8 as "lockedAt"
         from jobs where status in ('queued', 'running')
        order by created_at limit 400`
    ),
    db.query<{ status: string; count: number }>(
      "select status::text as status, count(*)::int as count from jobs group by status"
    )
  ]);
  return {
    jobs: jobs.rows,
    counts: Object.fromEntries(counts.rows.map((row) => [row.status, row.count]))
  };
}

/** The audit rows of the calls that ended after `sinceMs` (epoch milliseconds), oldest first. */
export async function readTaskRuns(db: Db, sinceMs: number): Promise<TaskRunRecord[]> {
  const result = await db.query<
    Omit<TaskRunRecord, "startedAt" | "finishedAt"> & { startedAt: Date; finishedAt: Date }
  >(
    `select id::text as id, task_type as "taskType", provider, model_id as "modelId", runtime,
            workload_class as "workloadClass", lane, priority, deadline_ms as "deadlineMs",
            deadline_outcome as "deadlineOutcome", is_repair as "isRepair",
            schema_mode as "schemaMode", retry_wait_ms as "retryWaitMs",
            requeue_ms as "requeueMs", queue_ms as "queueMs", duration_ms as "durationMs",
            attempt, status, left(error, 300) as error,
            started_at as "startedAt", finished_at as "finishedAt"
       from ai_task_runs
      where finished_at is not null and finished_at > $1
      order by finished_at limit 5000`,
    [new Date(sinceMs)]
  );
  return result.rows.map((row) => ({
    ...row,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString()
  }));
}
