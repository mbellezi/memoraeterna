import type { QueryResultRow } from "pg";
import {
  gardenerJobKeys,
  gardenerJobPayload,
  sanitizeStoredValue,
  type GardenerBlocker,
  type GardenerBlockerClass
} from "@app/domain";
import { taskHistoryCutoffKey, terminalTaskStatusesSql } from "./taskHistory.js";

import { asJsonObject, findById, mapNullableTimestamp, mapTimestamp, updateRow } from "./sql.js";
import type { JobLane, JobOutcome, JobRecord, JobStatus, JsonObject, Queryable } from "./types.js";

interface JobRow extends QueryResultRow {
  id: string;
  type: string;
  status: JobStatus;
  priority: number;
  payload: unknown;
  result: unknown;
  error: string | null;
  progress: number;
  attempts: number;
  maxAttempts: number;
  runAfter: unknown;
  lockedAt: unknown;
  lockedBy: string | null;
  finishedAt: unknown;
  cancelRequestedAt: unknown;
  lane: JobLane;
  dedupeKey: string | null;
  scopeKey: string | null;
  subjectKey: string | null;
  outcome: JobOutcome | null;
  blockedClass: string | null;
  blockedReason: string | null;
  blockedAt: unknown;
  quarantinedAt: unknown;
  inputFingerprint: string | null;
  claimedDedupeKey?: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateJobInput {
  type: string;
  payload?: JsonObject;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
  /** Defaults to `heavy`. */
  lane?: JobLane;
  /** Fails on a key that a queued job already holds; `enqueueDeduped` merges instead. */
  dedupeKey?: string;
}

/**
 * Debounce of a deduped job. A request with a delay moves the start of the queued job to `delayMs`
 * from now, never earlier than it was and never later than `maxDelayMs` after the first request
 * (unless it already was), and not at all once the job is due (`run_after` has passed). A request
 * with `delayMs` 0 is immediate: it makes the job due now and nothing a debounced request does
 * later moves it back.
 */
export interface JobDebounce {
  delayMs: number;
  maxDelayMs: number;
}

export const defaultJobDebounce: Readonly<JobDebounce> = Object.freeze({
  delayMs: 10_000,
  maxDelayMs: 60_000
});

/** An immediate request: the job runs as soon as a worker is free. */
export const immediateJobDebounce: Readonly<JobDebounce> = Object.freeze({
  delayMs: 0,
  maxDelayMs: 0
});

/** Same bound as the `jobs_dedupe_key` check, in code points like `char_length`. */
export const jobDedupeKeyMaxLength = 200;

export interface EnqueueDedupedInput {
  type: string;
  lane: JobLane;
  /** Names the work, for example `topic-place:<tree>:<root>`; the queued job keeps its payload. */
  dedupeKey: string;
  payload?: JsonObject;
  priority?: number;
  maxAttempts?: number;
  debounce?: JobDebounce;
}

/**
 * A job update. Setting `status` keeps the Gardener columns consistent with it: a succeeded job
 * gets the outcome `done` unless one is given, and a status other than `succeeded`, `queued` or
 * `failed` clears the outcome, the blocker or the quarantine mark that only those carry.
 */
export interface UpdateJobInput {
  status?: JobStatus;
  priority?: number;
  payload?: JsonObject;
  result?: JsonObject | null;
  error?: string | null;
  progress?: number;
  attempts?: number;
  maxAttempts?: number;
  runAfter?: Date;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  finishedAt?: Date | null;
  cancelRequestedAt?: Date | null;
  outcome?: JobOutcome | null;
  inputFingerprint?: string | null;
}

/**
 * What the job's end writes to the outcome cache of its (kind, subject) (D8, D9): a success
 * (`done`, `no_change`) records the fingerprint and ends a failure run; a failed job extends the
 * run when it failed on the same fingerprint and quarantines the subject at `quarantineAfter`; a
 * skip leaves both as they are.
 */
export interface GardenerOutcomeWrite {
  kind: string;
  subjectKey: string;
  result: JobOutcome | "failed";
  fingerprint: string | null;
  errorClass?: string | null;
  quarantineAfter: number;
}

/** A blocker met by a claimed job, when it clears if known, and the key it held (D7). */
export interface SetAsideJobInput {
  blocker: Pick<GardenerBlocker, "class" | "reason">;
  /** The clear time when known, else a recheck time; the job is due again then. */
  clearAt: Date;
  /** The dedupe key the job held when claimed (`claimedDedupeKey`). */
  dedupeKey: string | null;
  /** The result of the step that met the blocker, kept for the code that reads it. */
  result?: JsonObject | null;
}

/** Which blocked jobs to release; every given field narrows the set. */
export interface BlockedJobFilter {
  ids?: readonly string[];
  types?: readonly string[];
  classes?: readonly GardenerBlockerClass[];
  reasons?: readonly string[];
  /**
   * Only the jobs set aside with a clear time that has passed (`run_after` at or after the block
   * time, a clear time that had already passed included); a released job keeps its start. A row a
   * gate stamped keeps its older `run_after` and is left to the gate. Without it a released job is
   * due at once.
   */
  due?: boolean;
}

const returning = [
  "id",
  "type",
  "status",
  "priority",
  "payload",
  "result",
  "error",
  "progress",
  "attempts",
  'max_attempts as "maxAttempts"',
  'run_after as "runAfter"',
  'locked_at as "lockedAt"',
  'locked_by as "lockedBy"',
  'finished_at as "finishedAt"',
  'cancel_requested_at as "cancelRequestedAt"',
  "lane",
  'dedupe_key as "dedupeKey"',
  'scope_key as "scopeKey"',
  'subject_key as "subjectKey"',
  "outcome",
  'blocked_class as "blockedClass"',
  'blocked_reason as "blockedReason"',
  'blocked_at as "blockedAt"',
  'quarantined_at as "quarantinedAt"',
  'input_fingerprint as "inputFingerprint"',
  'created_at as "createdAt"',
  'updated_at as "updatedAt"'
].join(", ");

/** The same columns qualified by `alias`, for statements that join `jobs` to itself. */
const returningFrom = (alias: string) =>
  returning
    .split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The scope or subject key of a new job: the key the kind table gives, or `root:<id>` of the
 * hierarchy root of `$rootOf` (the way relation-link.ts `linkRootOf` finds it; a source that is
 * gone names itself).
 */
const keySql = (key: string, rootOf: string) =>
  `case when ${rootOf}::uuid is null then ${key}::text else 'root:' || coalesce((
     with recursive up as (
       select id, parent_source_item_id, 0 as depth from source_items where id = ${rootOf}::uuid
       union all
       select parent.id, parent.parent_source_item_id, up.depth + 1
         from source_items parent join up on parent.id = up.parent_source_item_id
        where up.depth < 64
     )
     select id::text from up order by depth desc limit 1), ${rootOf}::text) end`;

/** The stored payload and the scope and subject parameters of a new job of `type`. */
function jobKeys(type: string, payload: JsonObject) {
  const stored = sanitizeStoredValue(gardenerJobPayload(type, payload));
  const keys = gardenerJobKeys(type, stored);
  return {
    payload: stored,
    scopeKey: keys.scopeKey,
    subjectKey: keys.subjectKey,
    rootOf: keys.rootOf && uuidPattern.test(keys.rootOf) ? keys.rootOf : null
  };
}

/** The columns an update writes, with the Gardener columns kept consistent with the status. */
function jobPatch(input: UpdateJobInput): Record<string, unknown> {
  const status = input.status;
  return {
    status,
    priority: input.priority,
    payload: input.payload,
    result: input.result,
    error: input.error,
    progress: input.progress === undefined ? undefined : Math.round(input.progress * 10_000),
    attempts: input.attempts,
    max_attempts: input.maxAttempts,
    run_after: input.runAfter,
    locked_at: input.lockedAt,
    locked_by: input.lockedBy,
    finished_at: input.finishedAt,
    cancel_requested_at: input.cancelRequestedAt,
    outcome:
      input.outcome !== undefined
        ? input.outcome
        : status === undefined
          ? undefined
          : status === "succeeded"
            ? "done"
            : null,
    input_fingerprint: input.inputFingerprint,
    ...(status !== undefined && status !== "queued"
      ? { blocked_class: null, blocked_reason: null, blocked_at: null }
      : {}),
    ...(status !== undefined && status !== "failed" ? { quarantined_at: null } : {})
  };
}

/** The constraint name of a unique violation, or null for any other error. */
function uniqueViolation(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
    ? String((error as { constraint?: unknown }).constraint ?? "")
    : null;
}

/** The scope a `jobs_running_scope_uidx` violation names (`Key (scope_key)=(<scope>) ...`). */
function conflictingScope(error: unknown): string | null {
  const detail = (error as { detail?: unknown }).detail;
  const match =
    typeof detail === "string" ? /^Key \(scope_key\)=\((.+)\) already exists/u.exec(detail) : null;
  return match?.[1] ?? null;
}

/** Claim attempts after a same-scope race before giving up for this pass. */
const scopeClaimAttempts = 4;

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: Number(row.priority),
    payload: asJsonObject(row.payload),
    result: row.result === null ? null : asJsonObject(row.result),
    error: row.error,
    progress: Number(row.progress) / 10_000,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    runAfter: mapTimestamp(row.runAfter),
    lockedAt: mapNullableTimestamp(row.lockedAt),
    lockedBy: row.lockedBy,
    finishedAt: mapNullableTimestamp(row.finishedAt),
    cancelRequestedAt: mapNullableTimestamp(row.cancelRequestedAt),
    lane: row.lane,
    dedupeKey: row.dedupeKey,
    scopeKey: row.scopeKey ?? null,
    subjectKey: row.subjectKey ?? null,
    outcome: row.outcome ?? null,
    blockedClass: row.blockedClass ?? null,
    blockedReason: row.blockedReason ?? null,
    blockedAt: mapNullableTimestamp(row.blockedAt),
    quarantinedAt: mapNullableTimestamp(row.quarantinedAt),
    inputFingerprint: row.inputFingerprint ?? null,
    ...(row.claimedDedupeKey !== undefined ? { claimedDedupeKey: row.claimedDedupeKey } : {}),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

/** Re-embeds one atomic note after its text changed; background work that never calls a generative model. */
export const noteEmbeddingJobType = "note-embedding";
/** Short job: it runs ahead of the long ingestion jobs that were queued before it. */
const noteEmbeddingJobPriority = 10;

function assertDedupeInput(input: EnqueueDedupedInput, debounce: JobDebounce): void {
  const keyLength = Array.from(input.dedupeKey).length;
  if (keyLength < 1 || keyLength > jobDedupeKeyMaxLength) throw new Error("job_dedupe_key_invalid");
  if (input.lane !== "heavy" && input.lane !== "light") throw new Error("job_lane_invalid");
  const { delayMs, maxDelayMs } = debounce;
  if (
    !Number.isFinite(delayMs) ||
    !Number.isFinite(maxDelayMs) ||
    delayMs < 0 ||
    maxDelayMs < delayMs
  )
    throw new Error("job_debounce_invalid");
}

/**
 * Ends a running job that met a queued job holding its dedupe key by merging into it (D7): the
 * queued job takes the higher priority and does the work; this one ends canceled with
 * `result.mergedInto` and its claim's attempt given back. Null when no queued job holds the key
 * any more (it was claimed meanwhile) or this one is not running.
 */
async function mergeIntoQueued(
  db: Queryable,
  id: string,
  dedupeKey: string,
  result: unknown
): Promise<{ job: JobRecord; mergedInto: string } | null> {
  const merged = await db.query<JobRow & { mergedInto: string }>(
    `with dup as (
       select id from jobs where dedupe_key = $2 and status = 'queued' and id <> $1
       for update
     ), raised as (
       update jobs d set priority = greatest(d.priority, (select priority from jobs where id = $1)),
              updated_at = now()
         from dup where d.id = dup.id
       returning d.id
     )
     update jobs j
        set status = 'canceled', attempts = greatest(j.attempts - 1, 0),
            result = coalesce($3::jsonb, j.result, '{}'::jsonb)
              || jsonb_build_object('mergedInto', (select id from raised)),
            error = null, finished_at = now(), locked_at = null, locked_by = null,
            updated_at = now()
      where j.id = $1 and j.status = 'running' and exists (select 1 from raised)
     returning ${returningFrom("j")}, (select id from raised) as "mergedInto"`,
    [id, dedupeKey, result]
  );
  const row = merged.rows[0];
  return row ? { job: mapJob(row), mergedInto: row.mergedInto } : null;
}

export function createJobRepository(db: Queryable) {
  return {
    /**
     * Queues the re-embedding of a note unless one is already waiting for it. A queued job reads
     * the note when it runs, so it covers every edit made before then; a running job may have read
     * the text before the edit, so it does not count. Call it inside the editing transaction: the
     * lock then makes concurrent edits of one note queue a single job.
     */
    async enqueueNoteEmbedding(input: {
      atomicNoteId: string;
      sourceItemId: string;
    }): Promise<boolean> {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        `${noteEmbeddingJobType}:${input.atomicNoteId}`
      ]);
      const result = await db.query(
        `insert into jobs (type, priority, payload)
         select $1, $2, jsonb_build_object('atomicNoteId', $3::text, 'sourceItemId', $4::text)
          where not exists (
            select 1 from jobs
             where type = $1 and status = 'queued' and payload->>'atomicNoteId' = $3::text
          )`,
        [noteEmbeddingJobType, noteEmbeddingJobPriority, input.atomicNoteId, input.sourceItemId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Queues the re-embedding of many notes in one statement after the embedding space changed
     * (D26), skipping notes that already have a queued job for the same space (a job of another
     * space ends without a call). `spaceKey` names the space the jobs embed into: a job skips a
     * note only when a vector of its text exists in that space.
     */
    async enqueueNoteEmbeddings(
      notes: readonly { atomicNoteId: string; sourceItemId: string }[],
      options: { spaceKey?: string } = {}
    ): Promise<number> {
      if (notes.length === 0) return 0;
      const result = await db.query(
        `insert into jobs (type, priority, payload)
         select $1, $2, jsonb_build_object('atomicNoteId', n.id, 'sourceItemId', n.source)
                  || case when $5::text is null then '{}'::jsonb
                          else jsonb_build_object('spaceKey', $5::text) end
           from unnest($3::text[], $4::text[]) as n(id, source)
          where not exists (
            select 1 from jobs
             where type = $1 and status = 'queued' and payload->>'atomicNoteId' = n.id
               and payload->>'spaceKey' is not distinct from $5::text
          )`,
        [
          noteEmbeddingJobType,
          noteEmbeddingJobPriority,
          notes.map((note) => note.atomicNoteId),
          notes.map((note) => note.sourceItemId),
          options.spaceKey ?? null
        ]
      );
      return result.rowCount ?? 0;
    },

    /**
     * How many `note-embedding` jobs that named the space `spaceKey` stored a vector (D26), only
     * those finished at or after `since` when it is given.
     */
    async countSpaceEmbeddings(spaceKey: string, since?: Date): Promise<number> {
      const result = await db.query<QueryResultRow & { count: number }>(
        `select count(*)::int as count from jobs
          where type = $1 and status = 'succeeded' and payload->>'spaceKey' = $2
            and result->>'embedded' = 'true'
            and ($3::timestamptz is null or finished_at >= $3)`,
        [noteEmbeddingJobType, spaceKey, since ?? null]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /** Whether a `note-embedding` job that names the space `spaceKey` is queued or running. */
    async hasOpenSpaceEmbeddings(spaceKey: string): Promise<boolean> {
      const result = await db.query<QueryResultRow & { open: boolean }>(
        `select exists (select 1 from jobs where type = $1 and status in ('queued', 'running')
            and payload->>'spaceKey' = $2) as open`,
        [noteEmbeddingJobType, spaceKey]
      );
      return result.rows[0]?.open === true;
    },

    /**
     * Inserts a job. Its scope and subject keys come from the kind table (`@app/domain`
     * `gardenerJobKeys`): an inline ingestion stage gets none, an ingestion job the root of its
     * source.
     */
    async create(input: CreateJobInput): Promise<JobRecord> {
      const keys = jobKeys(input.type, input.payload ?? {});
      const result = await db.query<JobRow>(
        `insert into jobs (type, payload, priority, max_attempts, run_after, lane, dedupe_key,
           scope_key, subject_key)
         values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), coalesce($6::text, 'heavy'), $7,
           ${keySql("$8", "$10")}, ${keySql("$9", "$10")})
         returning ${returning}`,
        [
          input.type,
          keys.payload,
          input.priority ?? 0,
          input.maxAttempts ?? 3,
          input.runAfter ?? null,
          input.lane ?? null,
          input.dedupeKey ?? null,
          keys.scopeKey,
          keys.subjectKey,
          keys.rootOf
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Insert into jobs did not return a row.");
      return mapJob(row);
    },

    /**
     * Queues a job unless one with the same key is already queued; then that job absorbs the
     * request and its start moves by the merge rule, which depends on the order of requests only
     * through whether the job is due (`run_after <= now`, exactly what `claimNext` claims):
     * - an immediate request (`delayMs` 0) sets `run_after = least(run_after, now)`, so the job is
     *   due now;
     * - a debounced request leaves a due job as it is, so nothing postpones a job that is due,
     *   and otherwise moves `run_after` forward by the debounce, up to the cap after `created_at`.
     * "Due" is derived from `run_after`, not stored: a second marker could disagree with it.
     * A running job never absorbs a request: it may have read its inputs already, so a new queued
     * job is created next to it. Safe under any number of concurrent callers (one insert-or-update
     * on the partial unique index; the merge reads the clock after it holds the row).
     * A merge raises the queued job's priority to the request's when that is higher (D6). A job
     * set aside by a blocker is looked at again: the new request releases the blocker and starts
     * it by its own debounce, as a new job would (a blocker it still meets sets it aside again).
     */
    async enqueueDeduped(
      input: EnqueueDedupedInput
    ): Promise<{ job: JobRecord; created: boolean }> {
      const debounce = input.debounce ?? defaultJobDebounce;
      assertDedupeInput(input, debounce);
      const keys = jobKeys(input.type, input.payload ?? {});
      const result = await db.query<JobRow & { created: boolean }>(
        `insert into jobs as j (type, lane, dedupe_key, priority, payload, max_attempts, run_after,
           scope_key, subject_key)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::double precision),
           ${keySql("$9", "$11")}, ${keySql("$10", "$11")})
         on conflict (dedupe_key) where dedupe_key is not null and status = 'queued'
         do update set
           run_after = case
             when j.blocked_class is not null then excluded.run_after
             when $7::double precision <= 0 then least(j.run_after, clock_timestamp())
             when j.run_after <= clock_timestamp() then j.run_after
             else greatest(
               j.run_after,
               least(excluded.run_after, j.created_at + make_interval(secs => $8::double precision))
             )
           end,
           priority = greatest(j.priority, excluded.priority),
           blocked_class = null, blocked_reason = null, blocked_at = null,
           updated_at = now()
         where j.type = excluded.type and j.lane = excluded.lane
         returning ${returning}, (j.xmax = 0) as created`,
        [
          input.type,
          input.lane,
          input.dedupeKey,
          input.priority ?? 0,
          keys.payload,
          input.maxAttempts ?? 3,
          debounce.delayMs / 1000,
          debounce.maxDelayMs / 1000,
          keys.scopeKey,
          keys.subjectKey,
          keys.rootOf
        ]
      );
      const row = result.rows[0];
      // The key is queued for another type or lane: a caller bug, never merged silently.
      if (!row) throw new Error("job_dedupe_key_conflict");
      return { job: mapJob(row), created: row.created === true };
    },

    async latestByType(type: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `select ${returning} from jobs where type = $1 order by (status in ('queued', 'running')) desc, created_at desc limit 1`,
        [type]
      );
      return result.rows[0] ? mapJob(result.rows[0]) : null;
    },

    async findById(id: string): Promise<JobRecord | null> {
      const row = await findById<JobRow>(db, "jobs", id, returning);
      return row ? mapJob(row) : null;
    },

    async update(id: string, input: UpdateJobInput): Promise<JobRecord | null> {
      const row = await updateRow<JobRow>(db, "jobs", id, jobPatch(input), returning);
      return row ? mapJob(row) : null;
    },

    /**
     * Ends a job and, when `outcome` is given, writes its (kind, subject) outcome cache in the same
     * statement (D8, D9): a failed job that failed on the same fingerprint as the run before it
     * extends the run and, at `quarantineAfter` failed jobs, quarantines the subject and marks
     * this job.
     */
    async finish(
      id: string,
      input: UpdateJobInput,
      outcome?: GardenerOutcomeWrite
    ): Promise<JobRecord | null> {
      if (!outcome) return this.update(id, input);
      // The quarantine mark comes from the outcome cache, never from the patch.
      const patch = Object.entries(jobPatch(input)).filter(
        ([column, value]) => value !== undefined && column !== "quarantined_at"
      );
      const params: unknown[] = [
        id,
        outcome.kind,
        outcome.subjectKey,
        outcome.result,
        outcome.fingerprint,
        outcome.errorClass?.slice(0, 200) ?? null,
        Math.max(1, Math.trunc(outcome.quarantineAfter))
      ];
      const assignments = patch.map(([column, value]) => {
        params.push(sanitizeStoredValue(value));
        return `"${column}" = $${params.length}`;
      });
      const failedRun = `case when o.consecutive_failures > 0
              and o.failed_fingerprint is not distinct from excluded.failed_fingerprint
            then o.consecutive_failures + 1 else 1 end`;
      const result = await db.query<JobRow>(
        `with outcome as (
           insert into gardener_outcomes as o (kind, subject_key, last_outcome, last_fingerprint,
             failed_fingerprint, consecutive_failures, last_error_class, last_job_id, quarantined_at)
           values ($2, $3, $4,
             case when $4 in ('done', 'no_change') then $5::text end,
             case when $4 = 'failed' then $5::text end,
             case when $4 = 'failed' then 1 else 0 end,
             case when $4 = 'failed' then $6::text end,
             $1::uuid,
             case when $4 = 'failed' and $7::int <= 1 then now() end)
           on conflict (kind, subject_key) do update set
             last_outcome = excluded.last_outcome,
             last_fingerprint = case when excluded.last_outcome = 'failed' or excluded.last_outcome = 'skipped'
               then o.last_fingerprint else excluded.last_fingerprint end,
             failed_fingerprint = case excluded.last_outcome
               when 'failed' then excluded.failed_fingerprint
               when 'skipped' then o.failed_fingerprint end,
             consecutive_failures = case excluded.last_outcome
               when 'failed' then ${failedRun}
               when 'skipped' then o.consecutive_failures else 0 end,
             last_error_class = case excluded.last_outcome
               when 'failed' then excluded.last_error_class
               when 'skipped' then o.last_error_class end,
             last_job_id = excluded.last_job_id,
             quarantined_at = case excluded.last_outcome
               when 'failed' then case when ${failedRun} >= $7::int then
                 coalesce(case when o.failed_fingerprint is not distinct from excluded.failed_fingerprint
                   then o.quarantined_at end, now()) end
               when 'skipped' then o.quarantined_at end,
             updated_at = now()
           returning quarantined_at
         )
         update jobs set ${[
           ...assignments,
           `quarantined_at = case when $4 = 'failed' and ${
             patch.some(([column, value]) => column === "status" && value === "failed")
               ? "true"
               : "false"
           } then (select quarantined_at from outcome) end`,
           "updated_at = now()"
         ].join(", ")}
         where id = $1
         returning ${returning}`,
        params
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async listQueued(limit = 25): Promise<JobRecord[]> {
      const result = await db.query<JobRow>(
        `select ${returning}
         from jobs
         where status = 'queued' and run_after <= now()
         order by priority desc, run_after asc
         limit $1`,
        [limit]
      );
      return result.rows.map(mapJob);
    },

    /**
     * The newest jobs the Jobs screen shows, of one lane when `lane` is given (so the Gardener's
     * light volume never crowds the imports out). A job set aside by a blocker is waiting, not
     * queued: it is left out unless `includeBlocked`.
     */
    async list(
      limit?: number,
      options: { lane?: JobLane; includeBlocked?: boolean } = {}
    ): Promise<JobRecord[]> {
      const values: unknown[] = [limit ?? 100];
      const filters: string[] = [];
      if (options.lane) {
        values.push(options.lane);
        filters.push(`and lane = $${values.length}`);
      }
      if (!options.includeBlocked) filters.push("and blocked_class is null");
      const result = await db.query<JobRow>(
        `select ${returning} from jobs
         where (payload->>'dashboardDismissedAt' is null or status in ('queued', 'running'))
           ${filters.join(" ")}
         order by created_at desc limit $1`,
        values
      );
      return result.rows.map(mapJob);
    },

    /** The queued and running jobs of a processing batch: its runs' ingestion jobs and batch jobs. */
    async activeIdsForBatch(batchId: string): Promise<string[]> {
      const result = await db.query<{ id: string }>(
        `select distinct j.id
         from jobs j
         left join ingestion_runs r on j.id = r.job_id or j.payload->>'ingestionRunId' = r.id::text
         where (r.batch_id = $1 or j.payload->>'batchId' = $1::text)
           and j.status in ('queued', 'running')`,
        [batchId]
      );
      return result.rows.map((row) => row.id);
    },
    /**
     * Claims the next due job, optionally of one lane and of the given types. The order matches
     * `jobs_lane_queue_idx`, so a lane claim reads the index in order. The claimed job drops its
     * dedupe key: from now on a request for the same work queues a new job (the key it held is
     * returned as `claimedDedupeKey`, for a blocker that sets it aside, D7).
     * Never claimed: a job set aside by a blocker, a job of a `gatedTypes` kind (a global gate,
     * whose rows keep their attempts and key), and a job whose scope has a running job (D6). Two
     * workers that claim jobs of one scope at once race on `jobs_running_scope_uidx`: the loser
     * claims again without that scope.
     */
    async claimNext(
      workerId: string,
      allowedTypes?: readonly string[],
      lane?: JobLane,
      options: { gatedTypes?: Iterable<string> } = {}
    ): Promise<JobRecord | null> {
      const gated = new Set(options.gatedTypes ?? []);
      const types = allowedTypes?.filter((type) => !gated.has(type));
      if (types && types.length === 0) return null;
      const excludedScopes: string[] = [];
      for (let attempt = 1; ; attempt += 1) {
        const values: unknown[] = [workerId];
        const filters: string[] = [];
        if (lane) {
          values.push(lane);
          filters.push(`and lane = $${values.length}`);
        }
        if (types) {
          values.push(types);
          filters.push(`and type = any($${values.length}::text[])`);
        } else if (gated.size > 0) {
          values.push([...gated]);
          filters.push(`and type <> all($${values.length}::text[])`);
        }
        if (excludedScopes.length > 0) {
          values.push(excludedScopes);
          filters.push(`and (scope_key is null or scope_key <> all($${values.length}::text[]))`);
        }
        try {
          const result = await db.query<JobRow>(
            `with candidate as (
               select id, dedupe_key from jobs j
               where status = 'queued' and run_after <= now() and blocked_class is null
                 ${filters.join(" ")}
                 and (j.scope_key is null or not exists (
                   select 1 from jobs r where r.scope_key = j.scope_key and r.status = 'running'))
               order by priority desc, run_after asc
               for update skip locked
               limit 1
             )
             update jobs
             set status = 'running', locked_at = now(), locked_by = $1,
                 attempts = attempts + 1, dedupe_key = null, updated_at = now()
             where id = (select id from candidate)
             returning ${returning}, (select dedupe_key from candidate) as "claimedDedupeKey"`,
            values
          );
          const row = result.rows[0];
          return row ? mapJob(row) : null;
        } catch (error) {
          if (uniqueViolation(error) !== "jobs_running_scope_uidx") throw error;
          // The scopes kept racing: nothing is claimed this pass, the next one looks again.
          if (attempt >= scopeClaimAttempts) return null;
          // Another worker started a job of that scope since this statement's snapshot.
          const scope = conflictingScope(error);
          if (scope) excludedScopes.push(scope);
        }
      }
    },

    async reportProgress(id: string, progress: number): Promise<JobRecord | null> {
      return this.update(id, { progress: Math.max(0, Math.min(1, progress)) });
    },

    async setAiExecution(
      id: string,
      input: {
        provider: string;
        modelId: string;
        reasoningLevel: string | null;
      }
    ): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `update jobs set
           payload = jsonb_set(payload, '{aiExecution}', $2::jsonb, true),
           updated_at = now()
         where id = $1
         returning ${returning}`,
        [id, input]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async requestCancel(id: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `update jobs
         set status = case when status = 'queued' then 'canceled'::job_status else status end,
             cancel_requested_at = now(),
             finished_at = case when status = 'queued' then now() else finished_at end,
             blocked_class = null, blocked_reason = null, blocked_at = null,
             updated_at = now()
         where id = $1 and status in ('queued', 'running')
         returning ${returning}`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    /**
     * Queues a finished job again (a manual retry). A retry is the user's word that the input may
     * be tried again: the quarantine of its (kind, subject) ends and the next run is not skipped
     * by fingerprint (D8), in the same statement.
     */
    async retry(id: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `with retried as (
           update jobs
           set status = 'queued', result = null, error = null, progress = 0, run_after = now(),
               payload = payload - 'dashboardDismissedAt',
               attempts = 0, dedupe_key = null, outcome = null, quarantined_at = null,
               input_fingerprint = null,
               locked_at = null, locked_by = null, finished_at = null,
               cancel_requested_at = null, updated_at = now()
           where id = $1 and status in ('failed', 'canceled', 'succeeded')
           returning *
         ), released as (
           update gardener_outcomes o
              set quarantined_at = null, consecutive_failures = 0, failed_fingerprint = null,
                  last_fingerprint = null, updated_at = now()
             from retried r
            where o.kind = r.type and o.subject_key = r.subject_key
         )
         select ${returningFrom("retried")} from retried`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    /**
     * Sets a claimed job aside for a blocker it met (D7): queued again with the attempt it burned
     * given back, its dedupe key restored, the blocker stamped and due at `clearAt`. When a newer
     * job holds the key, this one merges into it instead: the newer job keeps the higher priority
     * and this one ends canceled with `result.mergedInto`. Null when the job is not running.
     */
    async setAside(
      id: string,
      input: SetAsideJobInput
    ): Promise<{ job: JobRecord; mergedInto: string | null } | null> {
      const result = input.result === undefined ? null : sanitizeStoredValue(input.result);
      for (let attempt = 1; ; attempt += 1) {
        const restoreKey = attempt <= 2 ? input.dedupeKey : null;
        try {
          const queued = await db.query<JobRow>(
            `update jobs
             set status = 'queued', attempts = greatest(attempts - 1, 0), dedupe_key = $2,
                 blocked_class = $3, blocked_reason = $4, blocked_at = now(),
                 run_after = greatest($5::timestamptz, now()), result = coalesce($6::jsonb, result),
                 error = null, locked_at = null, locked_by = null, updated_at = now()
             where id = $1 and status = 'running'
             returning ${returning}`,
            [id, restoreKey, input.blocker.class, input.blocker.reason, input.clearAt, result]
          );
          const row = queued.rows[0];
          return row ? { job: mapJob(row), mergedInto: null } : null;
        } catch (error) {
          if (uniqueViolation(error) !== "jobs_dedupe_queued_uidx" || !restoreKey) throw error;
        }
        const merged = await mergeIntoQueued(db, id, input.dedupeKey!, result);
        if (merged) return merged;
        // The newer job was claimed meanwhile: the key is free again (or, past two tries, dropped).
      }
    },

    /**
     * Queues a running job again for its next attempt after a failed one (a retry with backoff):
     * `input` is the retry's update (`runAfter` its backoff), and the dedupe key its claim took is
     * restored, so a request made during the backoff joins it instead of queuing a duplicate (D7:
     * a job keeps its key while it waits). When a newer job holds the key now, this one merges
     * into it: the newer job keeps the higher priority and does the work, this one ends canceled
     * with `result.mergedInto`. Null when the job is not running.
     */
    async requeue(
      id: string,
      input: UpdateJobInput,
      dedupeKey: string | null
    ): Promise<{ job: JobRecord; mergedInto: string | null } | null> {
      const patch = Object.entries(jobPatch({ ...input, status: "queued" })).filter(
        ([, value]) => value !== undefined
      );
      for (let attempt = 1; ; attempt += 1) {
        const restoreKey = attempt <= 2 ? dedupeKey : null;
        const params: unknown[] = [id, restoreKey];
        const assignments = patch.map(([column, value]) => {
          params.push(sanitizeStoredValue(value));
          return `"${column}" = $${params.length}`;
        });
        try {
          const queued = await db.query<JobRow>(
            `update jobs set ${[...assignments, "dedupe_key = $2", "updated_at = now()"].join(", ")}
             where id = $1 and status = 'running'
             returning ${returning}`,
            params
          );
          const row = queued.rows[0];
          return row ? { job: mapJob(row), mergedInto: null } : null;
        } catch (error) {
          if (uniqueViolation(error) !== "jobs_dedupe_queued_uidx" || !restoreKey) throw error;
        }
        const result = input.result === undefined ? null : sanitizeStoredValue(input.result);
        const merged = await mergeIntoQueued(db, id, dedupeKey!, result);
        if (merged) return merged;
        // The newer job was claimed meanwhile: the key is free again (or, past two tries, dropped).
      }
    },

    /**
     * Stamps a blocker on the queued jobs a global gate holds (D7): they are never claimed while
     * their kind is gated, and the stamp says why. Returns how many were stamped.
     */
    async markBlocked(
      filter: { types?: readonly string[]; ids?: readonly string[] },
      blocker: GardenerBlocker
    ): Promise<number> {
      if (!filter.types && !filter.ids) throw new Error("job_block_filter_required");
      const result = await db.query(
        `update jobs
            set blocked_class = $1, blocked_reason = $2, blocked_at = coalesce(blocked_at, now()),
                updated_at = now()
          where status = 'queued'
            and ($3::text[] is null or type = any($3::text[]))
            and ($4::uuid[] is null or id = any($4::uuid[]))
            and (blocked_class is distinct from $1 or blocked_reason is distinct from $2)`,
        [blocker.class, blocker.reason, filter.types ? [...filter.types] : null, filter.ids ?? null]
      );
      return result.rowCount ?? 0;
    },

    /**
     * Releases blocked jobs (a clearing event, or every one at startup before the workers start,
     * D7). A released job is due at once, except with `due`, which releases only the jobs whose
     * clear time has passed. Returns how many were released.
     */
    async releaseBlocks(filter: BlockedJobFilter = {}): Promise<number> {
      const result = await db.query(
        `update jobs
            set blocked_class = null, blocked_reason = null, blocked_at = null,
                run_after = case when $5::boolean then run_after else least(run_after, now()) end,
                updated_at = now()
          where status = 'queued' and blocked_class is not null
            and ($1::uuid[] is null or id = any($1::uuid[]))
            and ($2::text[] is null or type = any($2::text[]))
            and ($3::text[] is null or blocked_class = any($3::text[]))
            and ($4::text[] is null or blocked_reason = any($4::text[]))
            and (not $5::boolean or (run_after <= now() and run_after >= blocked_at))`,
        [
          filter.ids ? [...filter.ids] : null,
          filter.types ? [...filter.types] : null,
          filter.classes ? [...filter.classes] : null,
          filter.reasons ? [...filter.reasons] : null,
          filter.due === true
        ]
      );
      return result.rowCount ?? 0;
    },

    /**
     * Retention (3.1): deletes succeeded and canceled jobs that finished before `before`, at most
     * `limit` per call, oldest first. Kept: failed and quarantined jobs (until resolved), the
     * `keepTypes` kinds (a model download's job owns its download row), a job an ingestion run
     * still names (its stage retry and history need it), and the newest job of each
     * type whatever its age: `latestByType` readers keep their answer (Areas reads its last
     * outcome as final for a build and must not ask the model again).
     */
    async pruneFinished(input: {
      before: Date;
      keepTypes?: readonly string[];
      limit?: number;
    }): Promise<number> {
      const result = await db.query(
        `with newest as (
           select type, max(created_at) as at from jobs group by type
         ), doomed as (
           select j.id from jobs j join newest n on n.type = j.type
            where j.status in ('succeeded', 'canceled')
              and coalesce(j.finished_at, j.updated_at) < $1
              and j.created_at < n.at
              and j.type <> all($2::text[])
              and not exists (select 1 from ingestion_runs r where r.job_id = j.id)
            order by coalesce(j.finished_at, j.updated_at)
            limit $3
         )
         delete from jobs where id in (select id from doomed)`,
        [
          input.before,
          [...(input.keepTypes ?? ["local-model-download"])],
          Math.max(1, Math.trunc(input.limit ?? 500))
        ]
      );
      return result.rowCount ?? 0;
    },

    async clearCompletedOrFailed(): Promise<number> {
      const result = await db.query(
        `with cutoff as (
           insert into settings(key,value) values($1,jsonb_build_object('before',clock_timestamp()))
           on conflict(key) do update set value=excluded.value,updated_at=now() returning value
         ) update jobs j
         set payload = jsonb_set(j.payload, '{dashboardDismissedAt}', (select value->'before' from cutoff))
         where j.status in ('succeeded', 'failed', 'canceled')
           and j.payload->>'dashboardDismissedAt' is null
           and not exists(select 1 from ingestion_runs r where r.job_id=j.id and r.status::text not in ${terminalTaskStatusesSql})`,
        [taskHistoryCutoffKey]
      );
      return result.rowCount ?? 0;
    },

    async recoverStale(staleAfterSeconds = 60): Promise<number> {
      const result = await db.query(
        `update jobs
         set status = case
               when cancel_requested_at is not null then 'canceled'::job_status
               when attempts < max_attempts then 'queued'::job_status
               else 'failed'::job_status
             end,
             error = case
               when cancel_requested_at is not null or attempts < max_attempts then error
               else coalesce(error, 'worker_crashed')
             end,
             finished_at = case when cancel_requested_at is not null or attempts >= max_attempts then now() else null end,
             run_after = now(), locked_at = null, locked_by = null, updated_at = now()
         where status = 'running'
           and locked_at < now() - make_interval(secs => $1)`,
        [staleAfterSeconds]
      );
      return result.rowCount ?? 0;
    },

    async recoverInterrupted(): Promise<number> {
      const result = await db.query(
        `update jobs
         set status = case
               when cancel_requested_at is not null then 'canceled'::job_status
               when attempts < max_attempts then 'queued'::job_status
               else 'failed'::job_status
             end,
             error = case
               when cancel_requested_at is not null or attempts < max_attempts then error
               else coalesce(error, 'worker_crashed')
             end,
             finished_at = case when cancel_requested_at is not null or attempts >= max_attempts then now() else null end,
             run_after = now(), locked_at = null, locked_by = null, updated_at = now()
         where status = 'running'`
      );
      return result.rowCount ?? 0;
    }
  };
}
