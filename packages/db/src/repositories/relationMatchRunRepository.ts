import type { QueryResultRow } from "pg";

import { relationRunTitleKey, type ChangeSetRisk } from "@app/domain";

import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

/**
 * The passes that change relations (F3 D14); the `kind` CHECK of `relation_match_runs` holds the same
 * list. A run groups the `relation_events` of one pass, which `revertRun` of the event repository
 * can revert exactly.
 */
export const relationMatchRunKinds = [
  "match",
  "link",
  "type",
  "promote",
  "discover",
  "review",
  "veto",
  "reconcile",
  "retype"
] as const;
export type RelationMatchRunKind = (typeof relationMatchRunKinds)[number];

/**
 * The outcome of a run whose changes were reverted. Only `revertRun` sets it; a run's own outcome
 * (what `finish` records) is free text of 1 to 200 characters.
 */
export const relationRunRevertedOutcome = "reverted";

/** A run's change-set fields (F4 D10, D11): what the Activity and the Inbox show of it. */
export interface RelationMatchRunChangeSet {
  /** A message key and its scalar parameters; null reads as the kind's default title. */
  titleKey: string | null;
  titleParams: JsonObject;
  risk: ChangeSetRisk;
  /** The owner's verdict when the run waits for review; null when it never did. */
  reviewStatus: "pending_review" | "kept" | "dismissed" | null;
  /** When the run was reverted; null otherwise (or reverted before F4 recorded the time). */
  undoneAt: Date | null;
  /** The job that ran it (provenance; the job may since have been pruned). */
  jobId: string | null;
}

/** How a run describes itself as a change-set; every field is optional. */
export interface RelationMatchRunDescription {
  titleKey?: string;
  titleParams?: JsonObject;
  risk?: ChangeSetRisk;
  /** A run that waits for the owner's verdict (Suggest autonomy, D12). */
  pendingReview?: boolean;
}

export interface RelationMatchRunRecord extends RelationMatchRunChangeSet {
  id: string;
  kind: RelationMatchRunKind;
  /** The source the run worked for. No foreign key: history outlives a deleted source (F2 D32). */
  rootId: string | null;
  deciderKey: string | null;
  calibrationVersion: string | null;
  startedAt: Date;
  /** Null while the run is open. */
  finishedAt: Date | null;
  outcome: string | null;
  counts: JsonObject;
  timings: JsonObject;
}

export interface RelationMatchRunStart extends RelationMatchRunDescription {
  kind: RelationMatchRunKind;
  rootId?: string | null;
  deciderKey?: string | null;
  calibrationVersion?: string | null;
  jobId?: string | null;
}

export interface RelationMatchRunFinish extends RelationMatchRunDescription {
  outcome: string;
  /** Replaces the run's counts when given. */
  counts?: JsonObject;
  /** Replaces the run's timings when given. */
  timings?: JsonObject;
}

interface RunRow extends QueryResultRow {
  id: string;
  kind: RelationMatchRunKind;
  rootId: string | null;
  deciderKey: string | null;
  calibrationVersion: string | null;
  startedAt: unknown;
  finishedAt: unknown;
  outcome: string | null;
  counts: unknown;
  timings: unknown;
  titleKey: string | null;
  titleParams: unknown;
  risk: ChangeSetRisk;
  reviewStatus: RelationMatchRunChangeSet["reviewStatus"];
  undoneAt: unknown;
  jobId: string | null;
}

const columns = `id, kind, root_id as "rootId", decider_key as "deciderKey",
  calibration_version as "calibrationVersion", started_at as "startedAt",
  finished_at as "finishedAt", outcome, counts, timings, title_key as "titleKey",
  title_params as "titleParams", risk, review_status as "reviewStatus", undone_at as "undoneAt",
  job_id as "jobId"`;

const mapRun = (row: RunRow): RelationMatchRunRecord => ({
  id: row.id,
  kind: row.kind,
  rootId: row.rootId,
  deciderKey: row.deciderKey,
  calibrationVersion: row.calibrationVersion,
  startedAt: mapTimestamp(row.startedAt),
  finishedAt: mapNullableTimestamp(row.finishedAt),
  outcome: row.outcome,
  counts: asJsonObject(row.counts),
  timings: asJsonObject(row.timings),
  titleKey: row.titleKey,
  titleParams: asJsonObject(row.titleParams),
  risk: row.risk,
  reviewStatus: row.reviewStatus,
  undoneAt: mapNullableTimestamp(row.undoneAt),
  jobId: row.jobId
});

const runRisks: readonly ChangeSetRisk[] = ["low", "medium", "high"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Checks a description; a title's parameters are scalars (they cross every boundary as is). */
function checkDescription(input: RelationMatchRunDescription): void {
  if (input.titleKey !== undefined && (input.titleKey.length < 1 || input.titleKey.length > 200))
    throw new Error("A relation run title key has 1 to 200 characters.");
  if (input.titleParams !== undefined) {
    if (!isPlainObject(input.titleParams))
      throw new Error("Relation run title parameters are an object.");
    for (const value of Object.values(input.titleParams))
      if (value !== null && !["string", "number", "boolean"].includes(typeof value))
        throw new Error("Relation run title parameters are scalars.");
  }
  if (input.risk !== undefined && !runRisks.includes(input.risk))
    throw new Error(`Unknown relation run risk "${String(input.risk)}".`);
}

/** The title key a run shows: its own, or its kind's default. */
export function relationRunTitle(run: Pick<RelationMatchRunRecord, "kind" | "titleKey">): string {
  return run.titleKey ?? relationRunTitleKey(run.kind);
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Runs of relation passes (F3 D14): `start` one, write its events, `finish` it. */
export function createRelationMatchRunRepository(db: Queryable) {
  return {
    /** Opens a run. Its events join it by its ID (see `relationEventRepository`). */
    async start(input: RelationMatchRunStart): Promise<RelationMatchRunRecord> {
      if (!(relationMatchRunKinds as readonly string[]).includes(input.kind))
        throw new Error(`Unknown relation run kind "${String(input.kind)}".`);
      checkDescription(input);
      if (input.jobId != null && !uuidPattern.test(input.jobId))
        throw new Error("A relation run job ID is a UUID.");
      const row = (
        await db.query<RunRow>(
          `insert into relation_match_runs (kind, root_id, decider_key, calibration_version, started_at,
             title_key, title_params, risk, review_status, job_id)
           values ($1, $2::uuid, $3, $4, clock_timestamp(), $5, coalesce($6::jsonb, '{}'::jsonb),
                   coalesce($7, 'low'), $8, $9::uuid)
           returning ${columns}`,
          [
            input.kind,
            input.rootId ?? null,
            input.deciderKey ?? null,
            input.calibrationVersion ?? null,
            input.titleKey ?? null,
            input.titleParams === undefined ? null : JSON.stringify(input.titleParams),
            input.risk ?? null,
            input.pendingReview ? "pending_review" : null,
            input.jobId ?? null
          ]
        )
      ).rows[0];
      if (!row) throw new Error("Relation run insert returned no row.");
      return mapRun(row);
    },

    /**
     * Closes an open run with its outcome, counts and timings. Resolves to null when the run does not
     * exist or is already finished: a run finishes once. `reverted` belongs to `revertRun`.
     */
    async finish(
      runId: string,
      input: RelationMatchRunFinish
    ): Promise<RelationMatchRunRecord | null> {
      if (input.outcome.length < 1 || input.outcome.length > 200)
        throw new Error("A relation run outcome has 1 to 200 characters.");
      if (input.outcome === relationRunRevertedOutcome)
        throw new Error(`The "${relationRunRevertedOutcome}" outcome is set by reverting a run.`);
      if (input.counts !== undefined && !isPlainObject(input.counts))
        throw new Error("Relation run counts are an object.");
      if (input.timings !== undefined && !isPlainObject(input.timings))
        throw new Error("Relation run timings are an object.");
      checkDescription(input);
      const row = (
        await db.query<RunRow>(
          `update relation_match_runs
              set finished_at = clock_timestamp(), outcome = $2,
                  counts = coalesce($3::jsonb, counts), timings = coalesce($4::jsonb, timings),
                  title_key = coalesce($5, title_key),
                  title_params = coalesce($6::jsonb, title_params),
                  risk = coalesce($7, risk),
                  review_status = case when $8::boolean then 'pending_review' else review_status end
            where id = $1::uuid and finished_at is null
            returning ${columns}`,
          [
            runId,
            input.outcome,
            input.counts === undefined ? null : JSON.stringify(input.counts),
            input.timings === undefined ? null : JSON.stringify(input.timings),
            input.titleKey ?? null,
            input.titleParams === undefined ? null : JSON.stringify(input.titleParams),
            input.risk ?? null,
            input.pendingReview === true
          ]
        )
      ).rows[0];
      return row ? mapRun(row) : null;
    },

    async get(runId: string): Promise<RelationMatchRunRecord | null> {
      const row = (
        await db.query<RunRow>(`select ${columns} from relation_match_runs where id = $1::uuid`, [
          runId
        ])
      ).rows[0];
      return row ? mapRun(row) : null;
    },

    /** Runs, newest first, optionally of one source or kind. */
    async list(
      filter: { rootId?: string; kind?: RelationMatchRunKind; limit?: number } = {}
    ): Promise<RelationMatchRunRecord[]> {
      const result = await db.query<RunRow>(
        `select ${columns} from relation_match_runs
          where ($1::uuid is null or root_id = $1::uuid) and ($2::text is null or kind = $2)
          order by started_at desc, id
          limit $3`,
        [filter.rootId ?? null, filter.kind ?? null, Math.max(1, Math.min(filter.limit ?? 50, 500))]
      );
      return result.rows.map(mapRun);
    }
  };
}
