import type { QueryResultRow } from "pg";

import { mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/**
 * Reads of the Gardener's outcome cache (F4 D8, D9). The rows are written by the job repository
 * in the statement that finishes a job (`finish`) and released by a manual retry (`retry`).
 */
export interface GardenerOutcomeRecord {
  kind: string;
  subjectKey: string;
  lastOutcome: "done" | "no_change" | "skipped" | "failed";
  lastFingerprint: string | null;
  failedFingerprint: string | null;
  consecutiveFailures: number;
  lastErrorClass: string | null;
  lastJobId: string | null;
  quarantinedAt: Date | null;
  updatedAt: Date;
}

interface GardenerOutcomeRow extends QueryResultRow {
  kind: string;
  subjectKey: string;
  lastOutcome: GardenerOutcomeRecord["lastOutcome"];
  lastFingerprint: string | null;
  failedFingerprint: string | null;
  consecutiveFailures: number;
  lastErrorClass: string | null;
  lastJobId: string | null;
  quarantinedAt: unknown;
  updatedAt: unknown;
}

const columns = `kind, subject_key as "subjectKey", last_outcome as "lastOutcome",
  last_fingerprint as "lastFingerprint", failed_fingerprint as "failedFingerprint",
  consecutive_failures as "consecutiveFailures", last_error_class as "lastErrorClass",
  last_job_id as "lastJobId", quarantined_at as "quarantinedAt", updated_at as "updatedAt"`;

function mapOutcome(row: GardenerOutcomeRow): GardenerOutcomeRecord {
  return {
    kind: row.kind,
    subjectKey: row.subjectKey,
    lastOutcome: row.lastOutcome,
    lastFingerprint: row.lastFingerprint,
    failedFingerprint: row.failedFingerprint,
    consecutiveFailures: Number(row.consecutiveFailures),
    lastErrorClass: row.lastErrorClass,
    lastJobId: row.lastJobId,
    quarantinedAt: mapNullableTimestamp(row.quarantinedAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createGardenerOutcomeRepository(db: Queryable) {
  return {
    async get(kind: string, subjectKey: string): Promise<GardenerOutcomeRecord | null> {
      const result = await db.query<GardenerOutcomeRow>(
        `select ${columns} from gardener_outcomes where kind = $1 and subject_key = $2`,
        [kind, subjectKey]
      );
      return result.rows[0] ? mapOutcome(result.rows[0]) : null;
    },

    /** The quarantined subjects, newest first (the Inbox's `quarantined` items read these). */
    async listQuarantined(limit = 50): Promise<GardenerOutcomeRecord[]> {
      const result = await db.query<GardenerOutcomeRow>(
        `select ${columns} from gardener_outcomes where quarantined_at is not null
          order by quarantined_at desc, kind, subject_key limit $1`,
        [Math.max(1, Math.min(500, Math.trunc(limit)))]
      );
      return result.rows.map(mapOutcome);
    },

    /** How many subjects are quarantined now (E2's numerator reads the same rows). */
    async countQuarantined(): Promise<number> {
      const result = await db.query<{ count: number }>(
        "select count(*)::int as count from gardener_outcomes where quarantined_at is not null"
      );
      return Number(result.rows[0]?.count ?? 0);
    }
  };
}
