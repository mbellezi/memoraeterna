import { shownNoteRelationSql, type PgPool } from "@app/db";

import type {
  JobDoneRecord,
  JobFailureRecord,
  OutcomeRecord,
  SoakSample,
  TaskRunRecord
} from "./soak-records.js";

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
              (extract(epoch from locked_at) * 1000)::float8 as "lockedAt",
              (extract(epoch from created_at) * 1000)::float8 as "createdAt",
              scope_key as "scopeKey", blocked_class as "blockedClass",
              blocked_reason as "blockedReason"
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

/**
 * The model calls of an Ask that really started since `sinceMs` (epoch milliseconds), whatever
 * their outcome: whether an Ask reached its model. They are the audit rows whose prompt is the
 * Ask's own (`consultation.knowledge`, one of the compositions the call recorded), not every call
 * of the answer class. A call recorded with no duration did not run, unless it is remote and its
 * request may have been sent. The driver runs one Ask at a time, so the calls are that Ask's.
 */
export async function countAnswerCalls(db: Db, sinceMs: number): Promise<number> {
  const result = await db.query<{ calls: number }>(
    `select count(*)::int as calls from ai_task_runs
      where prompt_compositions @> '[{"promptId": "consultation.knowledge"}]'::jsonb
        and started_at >= $1 and (duration_ms > 0 or runtime = 'remote')`,
    [new Date(sinceMs)]
  );
  return result.rows[0]?.calls ?? 0;
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
            started_at as "startedAt", finished_at as "finishedAt",
            input_tokens as "inputTokens", output_tokens as "outputTokens",
            budget_class as "budgetClass", job_id::text as "jobId",
            budget_estimate_usd as "budgetEstimateUsd"
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

/**
 * The jobs that ended `failed` after `sinceMs` (epoch milliseconds), oldest first, with the error
 * they kept: the audit rows only show failed AI calls, and a job can fail with none.
 */
export async function readFailedJobs(db: Db, sinceMs: number): Promise<JobFailureRecord[]> {
  const result = await db.query<Omit<JobFailureRecord, "at"> & { at: Date }>(
    `select id::text as id, type as "jobType", lane, coalesce(finished_at, updated_at) as at,
            attempts, payload ->> 'sourceItemId' as "sourceItemId", left(error, 200) as error
       from jobs
      where status = 'failed' and updated_at > $1
      order by coalesce(finished_at, updated_at), id limit 1000`,
    [new Date(sinceMs)]
  );
  return result.rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

/**
 * The jobs that reached a final state after `sinceMs` (epoch milliseconds), oldest first (F4 E3):
 * what the report needs to tell whether a task was completed within 24 h of its creation. A failed
 * attempt that was queued again is not final; the job is read when it ends.
 */
export async function readFinishedJobs(db: Db, sinceMs: number): Promise<JobDoneRecord[]> {
  const result = await db.query<
    Omit<JobDoneRecord, "type" | "createdAt" | "finishedAt" | "quarantinedAt"> & {
      createdAt: Date;
      finishedAt: Date | null;
      quarantinedAt: Date | null;
    }
  >(
    `select id::text as id, type as "jobType", lane, status::text as status, outcome,
            scope_key as "scopeKey", subject_key as "subjectKey", attempts,
            created_at as "createdAt", finished_at as "finishedAt",
            quarantined_at as "quarantinedAt", left(result ->> 'status', 60) as "resultStatus",
            input_fingerprint as "inputFingerprint"
       from jobs
      where status in ('succeeded', 'failed', 'canceled')
        and coalesce(finished_at, updated_at) > $1
      order by coalesce(finished_at, updated_at), id limit 2000`,
    [new Date(sinceMs)]
  );
  return result.rows.map((row) => ({
    ...row,
    type: "job_done" as const,
    status: row.status as JobDoneRecord["status"],
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    quarantinedAt: row.quarantinedAt ? row.quarantinedAt.toISOString() : null
  }));
}

/** The (kind, subject) outcome rows that changed after `sinceMs` (F4 E2), oldest first. */
export async function readOutcomeChanges(db: Db, sinceMs: number): Promise<OutcomeRecord[]> {
  const result = await db.query<
    Omit<OutcomeRecord, "type" | "at" | "quarantinedAt"> & {
      at: Date;
      quarantinedAt: Date | null;
    }
  >(
    `select kind, subject_key as "subjectKey", last_outcome as "lastOutcome",
            last_fingerprint as "lastFingerprint", failed_fingerprint as "failedFingerprint",
            consecutive_failures as "consecutiveFailures",
            left(last_error_class, 200) as "lastErrorClass", updated_at as at,
            quarantined_at as "quarantinedAt"
       from gardener_outcomes
      where updated_at > $1
      order by updated_at, kind, subject_key limit 2000`,
    [new Date(sinceMs)]
  );
  return result.rows.map((row) => ({
    ...row,
    type: "outcome" as const,
    at: row.at.toISOString(),
    quarantinedAt: row.quarantinedAt ? row.quarantinedAt.toISOString() : null
  }));
}

/** Backends waiting on a lock and the longest wait (F4 E1's `pg_locks` arm). */
export async function readLockWaits(db: Db): Promise<{ waiting: number; longestMs: number }> {
  const result = await db.query<{ waiting: number; longestMs: number }>(
    `select count(*)::int as waiting,
            coalesce(max(extract(epoch from now() - state_change) * 1000), 0)::float8 as "longestMs"
       from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
  );
  const row = result.rows[0];
  return { waiting: Number(row?.waiting ?? 0), longestMs: Math.round(Number(row?.longestMs ?? 0)) };
}

/**
 * A topic page to open (F4 topic-open action): a placed topic of the active tree with at least
 * three primary notes, chosen by `seed` and `index` only. Its title names the view-history entry.
 */
export async function pickTopicToOpen(
  db: Db,
  seed: number,
  index: number
): Promise<{ id: string; title: string; hasOverview: boolean } | null> {
  const result = await db.query<{ id: string; title: string | null; hasOverview: boolean }>(
    `select t.id::text as id, t.title, (o.topic_id is not null) as "hasOverview"
       from topics t
       join topic_trees tr on tr.id = t.tree_id and tr.status = 'active'
       left join topic_overviews o on o.topic_id = t.id
      where t.role = 'topic' and t.retired_at is null
        and (select count(*) from topic_placements p
              where p.topic_id = t.id and p.role = 'primary' and p.item_kind = 'note') >= 3
      order by md5(t.id::text || $1::text || $2::text)
      limit 1`,
    [String(seed), String(index)]
  );
  const row = result.rows[0];
  return row ? { id: row.id, title: row.title ?? "Topic", hasOverview: row.hasOverview } : null;
}

/**
 * A note no person edited yet, in the `rootIndex`-th root (by a seeded order) that has one: the
 * burst's six edits land in six roots (F4). Wraps around when fewer roots have an editable note.
 */
export async function pickEditableNoteInRoot(
  db: Db,
  seed: number,
  index: number,
  rootIndex: number
): Promise<{ id: string; title: string; bodyMarkdown: string; updatedAt: string } | null> {
  const result = await db.query<{
    id: string;
    title: string;
    bodyMarkdown: string;
    updatedAt: Date;
  }>(
    `with editable as (
       select a.id, a.title, a.body_markdown, a.updated_at,
              coalesce(root.id, s.id) as root_id
         from atomic_notes a
         join source_items s on s.id = a.created_from_source_item_id
         left join source_items root on root.id = s.parent_source_item_id
        where a.status in ('active', 'approved') and a.supersession_status = 'current'
          and coalesce(a.metadata ->> 'humanProtected', 'false') <> 'true'
     ), roots as (
       select root_id, row_number() over (order by md5(root_id::text || $1::text || $2::text)) as position
         from (select distinct root_id from editable) distinct_roots
     )
     select e.id::text as id, e.title, e.body_markdown as "bodyMarkdown", e.updated_at as "updatedAt"
       from editable e join roots r on r.root_id = e.root_id
      where r.position = ($3::int % greatest((select count(*) from roots), 1)) + 1
      order by md5(e.id::text || $1::text || $2::text)
      limit 1`,
    [String(seed), String(index), rootIndex]
  );
  const row = result.rows[0];
  return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null;
}

/** Notes of the library to embed again in a contention burst, in a seeded order (F4). */
export async function pickNotesToReembed(
  db: Db,
  seed: number,
  index: number,
  count: number
): Promise<Array<{ atomicNoteId: string; sourceItemId: string }>> {
  const result = await db.query<{ atomicNoteId: string; sourceItemId: string }>(
    `select id::text as "atomicNoteId", created_from_source_item_id::text as "sourceItemId"
       from atomic_notes
      where status in ('active', 'approved') and supersession_status = 'current'
      order by md5(id::text || $1::text || $2::text) limit $3`,
    [String(seed), String(index), count]
  );
  return result.rows;
}
