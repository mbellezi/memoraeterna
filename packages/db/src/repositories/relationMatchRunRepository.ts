import type { QueryResultRow } from "pg";

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

export interface RelationMatchRunRecord {
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

export interface RelationMatchRunStart {
  kind: RelationMatchRunKind;
  rootId?: string | null;
  deciderKey?: string | null;
  calibrationVersion?: string | null;
}

export interface RelationMatchRunFinish {
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
}

const columns = `id, kind, root_id as "rootId", decider_key as "deciderKey",
  calibration_version as "calibrationVersion", started_at as "startedAt",
  finished_at as "finishedAt", outcome, counts, timings`;

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
  timings: asJsonObject(row.timings)
});

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Runs of relation passes (F3 D14): `start` one, write its events, `finish` it. */
export function createRelationMatchRunRepository(db: Queryable) {
  return {
    /** Opens a run. Its events join it by its ID (see `relationEventRepository`). */
    async start(input: RelationMatchRunStart): Promise<RelationMatchRunRecord> {
      if (!(relationMatchRunKinds as readonly string[]).includes(input.kind))
        throw new Error(`Unknown relation run kind "${String(input.kind)}".`);
      const row = (
        await db.query<RunRow>(
          `insert into relation_match_runs (kind, root_id, decider_key, calibration_version, started_at)
           values ($1, $2::uuid, $3, $4, clock_timestamp())
           returning ${columns}`,
          [
            input.kind,
            input.rootId ?? null,
            input.deciderKey ?? null,
            input.calibrationVersion ?? null
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
      const row = (
        await db.query<RunRow>(
          `update relation_match_runs
              set finished_at = clock_timestamp(), outcome = $2,
                  counts = coalesce($3::jsonb, counts), timings = coalesce($4::jsonb, timings)
            where id = $1::uuid and finished_at is null
            returning ${columns}`,
          [
            runId,
            input.outcome,
            input.counts === undefined ? null : JSON.stringify(input.counts),
            input.timings === undefined ? null : JSON.stringify(input.timings)
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
