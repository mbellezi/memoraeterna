import type { QueryResultRow } from "pg";

import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

/**
 * The MATCH backlog (F4 D16, spec 3.5): a change of the note decider (a model, a runtime build, a
 * prompt) offers to decide the notes again under the new one. The offer is a `backlog` finding of
 * the Inbox, unique per decider (`gardener_findings` is unique per kind and fingerprint), so a
 * dismissal persists and an offer is never made twice for one decider. The notes it would re-match
 * are the current ones whose stored match state names another decider.
 */
export const matchBacklogFindingKind = "backlog";
/** The `params.task` of a MATCH backlog among the `backlog` findings other tasks may add. */
export const matchBacklogTask = "match";

export interface MatchBacklogFinding {
  id: string;
  fingerprint: string;
  status: "open" | "dismissed" | "resolved";
  params: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** A note a backlog would match again, with the hierarchy root its job is scoped to. */
export interface MatchBacklogNote {
  noteId: string;
  rootId: string;
}

interface FindingRow extends QueryResultRow {
  id: string;
  fingerprint: string;
  status: MatchBacklogFinding["status"];
  params: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const findingColumns = `id, fingerprint, status, params, created_at as "createdAt",
  updated_at as "updatedAt"`;

const mapFinding = (row: FindingRow): MatchBacklogFinding => ({
  id: row.id,
  fingerprint: row.fingerprint,
  status: row.status,
  params: asJsonObject(row.params),
  createdAt: mapTimestamp(row.createdAt),
  updatedAt: mapNullableTimestamp(row.updatedAt) ?? mapTimestamp(row.createdAt)
});

/** The current notes whose stored match state names another decider (in `spaceKey` when given). */
const affectedSql = `
  from note_match_state s
  join atomic_notes n on n.id = s.note_id
  where s.decider_key <> $1 and ($2::text is null or s.space_key = $2)
    and n.status not in ('rejected', 'archived') and n.supersession_status = 'current'`;

export function createRelationMatchBacklogRepository(db: Queryable) {
  return {
    /** How many current notes were matched under a decider other than `deciderKey`. */
    async countAffected(input: { deciderKey: string; spaceKey: string | null }): Promise<number> {
      const result = await db.query<{ count: number }>(
        `select count(*)::int as count ${affectedSql}`,
        [input.deciderKey, input.spaceKey]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /**
     * A page of those notes in ID order after `afterNoteId`, each with its hierarchy root (the
     * topmost source of the note's source item, as `linkRootOf` finds it).
     */
    async listAffected(input: {
      deciderKey: string;
      spaceKey: string | null;
      afterNoteId: string | null;
      limit: number;
    }): Promise<MatchBacklogNote[]> {
      const limit = Math.max(1, Math.min(5_000, Math.trunc(input.limit)));
      const result = await db.query<{ noteId: string; rootId: string }>(
        `with recursive page as (
           select n.id as note_id, n.created_from_source_item_id as source_id ${affectedSql}
             and ($3::uuid is null or n.id > $3::uuid)
           order by n.id
           limit $4
         ), up as (
           select page.note_id, item.id, item.parent_source_item_id, 0 as depth
             from page join source_items item on item.id = page.source_id
           union all
           select up.note_id, parent.id, parent.parent_source_item_id, up.depth + 1
             from up join source_items parent on parent.id = up.parent_source_item_id
            where up.depth < 64
         )
         select page.note_id::text as "noteId",
                coalesce(top.id, page.source_id)::text as "rootId"
           from page
           left join lateral (
             select up.id from up where up.note_id = page.note_id order by up.depth desc limit 1
           ) top on true
          order by page.note_id`,
        [input.deciderKey, input.spaceKey, input.afterNoteId, limit]
      );
      return result.rows;
    },

    /**
     * Makes the offer for one decider (`fingerprint`): inserts its `backlog` finding, or updates the
     * count of the open one. A finding the owner dismissed, or one an acceptance resolved, stays
     * closed: it resolves to null and nothing is written.
     */
    async offer(input: {
      fingerprint: string;
      params: JsonObject;
    }): Promise<{ finding: MatchBacklogFinding; created: boolean } | null> {
      const result = await db.query<FindingRow & { created: boolean }>(
        `insert into gardener_findings as f (kind, fingerprint, params, risk)
         values ($1, $2, $3::jsonb, 'low')
         on conflict (kind, fingerprint) do update
           set params = excluded.params, updated_at = now()
           where f.status = 'open'
         returning ${findingColumns}, (f.xmax = 0) as created`,
        [matchBacklogFindingKind, input.fingerprint, JSON.stringify(input.params)]
      );
      const row = result.rows[0];
      return row ? { finding: mapFinding(row), created: row.created === true } : null;
    },

    /** The MATCH backlog finding with this ID; null for another kind of finding or none. */
    async find(id: string): Promise<MatchBacklogFinding | null> {
      const result = await db.query<FindingRow>(
        `select ${findingColumns} from gardener_findings
          where id = $1::uuid and kind = $2 and params ->> 'task' = $3`,
        [id, matchBacklogFindingKind, matchBacklogTask]
      );
      return result.rows[0] ? mapFinding(result.rows[0]) : null;
    },

    /** Resolves an open MATCH backlog finding (an acceptance queued its notes). */
    async resolve(id: string): Promise<boolean> {
      const result = await db.query(
        `update gardener_findings set status = 'resolved', closed_at = now(), updated_at = now()
          where id = $1::uuid and kind = $2 and params ->> 'task' = $3 and status = 'open'`,
        [id, matchBacklogFindingKind, matchBacklogTask]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Resolves the open MATCH backlog findings of any decider but `exceptFingerprint`: after the
     * decider changed again, or once nothing is left to match again, an older offer is moot.
     */
    async resolveOpen(exceptFingerprint: string | null): Promise<number> {
      const result = await db.query(
        `update gardener_findings set status = 'resolved', closed_at = now(), updated_at = now()
          where kind = $1 and params ->> 'task' = $2 and status = 'open'
            and fingerprint is distinct from $3::text`,
        [matchBacklogFindingKind, matchBacklogTask, exceptFingerprint]
      );
      return result.rowCount ?? 0;
    }
  };
}
