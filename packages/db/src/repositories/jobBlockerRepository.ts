// The blocker writes of the Gardener's background policy (F4 D7, T75) over the `jobs` columns of
// migration 0060 (T74): `blocked_class`, `blocked_reason` (the reason alone, e.g. `user_pause`) and
// `blocked_at`. A blocked row stays `queued` and is never claimed (T74's claim skips it) until a
// clearing event or its `run_after` clears it; its attempts and dedupe key are kept, so blocking
// never burns an attempt nor loses the key.
import type { GardenerBlocker, GardenerBlockerKey } from "@app/domain";

import { createJobRepository } from "./jobRepository.js";
import type { Queryable } from "./types.js";

/** One blocked group: queued rows of a type held by one reason. */
export interface BlockedJobGroup {
  type: string;
  blockerClass: string;
  reason: string;
  count: number;
  /** The earliest `run_after` of the group: when its first row may clear by time. */
  earliestRunAfter: Date;
}

const blockerKeySql = "(blocked_class || '.' || blocked_reason)";

export function createJobBlockerRepository(db: Queryable) {
  return {
    /**
     * Stamps the queued rows of each type with the blocker a global gate holds them by (for the
     * status; the claim already skips their types): rows with no blocker, and rows held by another
     * of `gateReasons`. Rows a per-task blocker holds keep theirs. Returns the rows stamped.
     */
    async stampGateBlocks(
      stamps: ReadonlyArray<{ type: string; blocker: Pick<GardenerBlocker, "class" | "reason"> }>,
      gateReasons: readonly GardenerBlockerKey[]
    ): Promise<number> {
      if (stamps.length === 0) return 0;
      const result = await db.query(
        `update jobs j
         set blocked_class = s.blocker_class, blocked_reason = s.reason, blocked_at = now(),
             updated_at = now()
         from unnest($1::text[], $2::text[], $3::text[]) as s(type, blocker_class, reason)
         where j.type = s.type and j.status = 'queued'
           and (j.blocked_class is null
             or ((j.blocked_class || '.' || j.blocked_reason) = any($4::text[])
               and (j.blocked_class, j.blocked_reason) is distinct from (s.blocker_class, s.reason)))`,
        [
          stamps.map((stamp) => stamp.type),
          stamps.map((stamp) => stamp.blocker.class),
          stamps.map((stamp) => stamp.blocker.reason),
          [...gateReasons]
        ]
      );
      return result.rowCount ?? 0;
    },

    /**
     * Clears the queued rows held by one of `reasons` (D7: a clearing event clears exactly the rows
     * of its reasons) and makes them due. `dueOnly` clears only rows whose `run_after` has passed
     * (a reset time); `exceptTypes` keeps the rows of types a gate still holds by that reason.
     * A `paused` row keeps its own `run_after`: a paused blocker never sets a clear time (its
     * per-task block is due at once), and a row the gates stamped while it waited for a retry
     * backoff or a debounce still waits for it, so a pause, an idle or a power toggle never
     * shortens a backoff. Returns the types it cleared rows of, so their workers can be woken.
     */
    async clearBlocks(input: {
      reasons: readonly GardenerBlockerKey[];
      dueOnly?: boolean;
      exceptTypes?: readonly string[];
    }): Promise<{ cleared: number; types: string[] }> {
      if (input.reasons.length === 0) return { cleared: 0, types: [] };
      const values: unknown[] = [[...input.reasons]];
      const filters: string[] = [];
      if (input.dueOnly) filters.push("and run_after <= now()");
      if (input.exceptTypes?.length) {
        values.push([...input.exceptTypes]);
        filters.push(`and not (type = any($${values.length}::text[]))`);
      }
      const result = await db.query<{ type: string }>(
        `update jobs
         set blocked_class = null, blocked_reason = null, blocked_at = null,
             run_after = case
               when blocked_class = 'paused' then run_after
               else least(run_after, now())
             end,
             updated_at = now()
         where status = 'queued' and blocked_class is not null
           and ${blockerKeySql} = any($1::text[]) ${filters.join(" ")}
         returning type`,
        values
      );
      return {
        cleared: result.rowCount ?? result.rows.length,
        types: [...new Set(result.rows.map((row) => row.type))].sort()
      };
    },

    /** The blocked queued rows by type and reason, for the startup re-gate and the status. */
    async blockedGroups(): Promise<BlockedJobGroup[]> {
      const result = await db.query<{
        type: string;
        blockerClass: string;
        reason: string;
        count: string | number;
        earliestRunAfter: Date | string;
      }>(
        `select type, blocked_class as "blockerClass", blocked_reason as reason,
                count(*) as count, min(run_after) as "earliestRunAfter"
         from jobs
         where status = 'queued' and blocked_class is not null
         group by type, blocked_class, blocked_reason
         order by type, blocked_class, blocked_reason`
      );
      return result.rows.map((row) => ({
        type: row.type,
        blockerClass: row.blockerClass,
        reason: row.reason,
        count: Number(row.count),
        earliestRunAfter: new Date(row.earliestRunAfter)
      }));
    },

    /**
     * Returns a running job that met a blocker after its claim to the queue (D7) through the job
     * repository's per-task block (`setAside`): the attempt its claim counted is given back, its
     * dedupe key restored, and `run_after` set to the time the blocker clears (now when unknown).
     * When a queued job holds the key now, this one merges into it (the queued job keeps the
     * higher priority, this one ends canceled with `result.mergedInto`). Resolves false when the
     * job is no longer running.
     */
    async blockTask(input: {
      jobId: string;
      blocker: Pick<GardenerBlocker, "class" | "reason">;
      runAfter?: Date | null;
      dedupeKey?: string | null;
    }): Promise<boolean> {
      const setAside = await createJobRepository(db).setAside(input.jobId, {
        blocker: input.blocker,
        clearAt: input.runAfter ?? new Date(),
        dedupeKey: input.dedupeKey ?? null
      });
      return setAside !== null;
    }
  };
}

export type JobBlockerRepository = ReturnType<typeof createJobBlockerRepository>;
