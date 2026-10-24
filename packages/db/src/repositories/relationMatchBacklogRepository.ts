import type { QueryResultRow } from "pg";

import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

/**
 * The MATCH backlog (F4 D16, spec 3.5): a change of the note decider (a model, a runtime build, a
 * prompt) offers to decide the notes again under the new one. The offer is a `backlog` finding of
 * the Inbox, unique per decider (`gardener_findings` is unique per kind and fingerprint), so a
 * dismissal persists and an offer is never made twice for one decider. The notes it would re-match
 * are the current ones whose stored match state names another decider.
 *
 * A change of the matching values (F4 Q4) is offered the same way, as its own `reason` of the same
 * task: the notes and source pairs decided while other values were in force.
 */
export const matchBacklogFindingKind = "backlog";
/** The `params.task` of a MATCH backlog among the `backlog` findings other tasks may add. */
export const matchBacklogTask = "match";
/** The `params.reason` of the offers: a decider that changed, matching values that changed. */
export const matchBacklogReasons = ["decider_changed", "settings_changed"] as const;
export type MatchBacklogReason = (typeof matchBacklogReasons)[number];

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

/** A span of time as an offer reads it: an end that is null is open. */
export interface MatchBacklogRange {
  from: Date | null;
  to: Date | null;
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

/** The current notes that match `predicate` (in the space `$2`, when one is given). */
const affectedFrom = (predicate: string) => `
  from note_match_state s
  join atomic_notes n on n.id = s.note_id
  where ${predicate} and ($2::text is null or s.space_key = $2)
    and n.status not in ('rejected', 'archived') and n.supersession_status = 'current'`;

/** The current notes whose stored match state names another decider. */
const otherDecider = affectedFrom("s.decider_key <> $1");

/** A time inside one of the spans given as two parallel arrays of bounds (null: an open end). */
const insideRanges = (column: string, lows: string, highs: string) =>
  `exists (select 1 from unnest(${lows}::timestamptz[], ${highs}::timestamptz[]) as r(lo, hi)
            where ${column} >= coalesce(r.lo, '-infinity') and ${column} < coalesce(r.hi, 'infinity'))`;

/**
 * A page of the notes `affected` selects, in ID order after the note at `after`, each with its
 * hierarchy root (the topmost source of the note's source item, as `linkRootOf` finds it).
 */
const listNotesSql = (affected: string, after: string, limit: string) => `
  with recursive page as (
    select n.id as note_id, n.created_from_source_item_id as source_id ${affected}
      and (${after}::uuid is null or n.id > ${after}::uuid)
    order by n.id
    limit ${limit}
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
   order by page.note_id`;

const pageLimit = (limit: number) => Math.max(1, Math.min(5_000, Math.trunc(limit)));

/** The spans as the two arrays of bounds a query takes. */
const rangeBounds = (ranges: readonly MatchBacklogRange[]) => [
  ranges.map((range) => range.from?.toISOString() ?? null),
  ranges.map((range) => range.to?.toISOString() ?? null)
];

export function createRelationMatchBacklogRepository(db: Queryable) {
  return {
    /** How many current notes were matched under a decider other than `deciderKey`. */
    async countAffected(input: { deciderKey: string; spaceKey: string | null }): Promise<number> {
      const result = await db.query<{ count: number }>(
        `select count(*)::int as count ${otherDecider}`,
        [input.deciderKey, input.spaceKey]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /** A page of those notes in ID order after `afterNoteId`, each with its hierarchy root. */
    async listAffected(input: {
      deciderKey: string;
      spaceKey: string | null;
      afterNoteId: string | null;
      limit: number;
    }): Promise<MatchBacklogNote[]> {
      const result = await db.query<MatchBacklogNote>(listNotesSql(otherDecider, "$3", "$4"), [
        input.deciderKey,
        input.spaceKey,
        input.afterNoteId,
        pageLimit(input.limit)
      ]);
      return result.rows;
    },

    /**
     * How many current notes were matched inside one of these spans of time: the spans in which
     * other matching values were in force (F4 Q4).
     */
    async countDecidedIn(input: {
      ranges: readonly MatchBacklogRange[];
      spaceKey: string | null;
    }): Promise<number> {
      if (input.ranges.length === 0) return 0;
      const [lows, highs] = rangeBounds(input.ranges);
      const result = await db.query<{ count: number }>(
        `select count(*)::int as count
           ${affectedFrom(insideRanges("s.matched_at", "$1", "$3"))}`,
        [lows, input.spaceKey, highs]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /** A page of those notes in ID order after `afterNoteId`, each with its hierarchy root. */
    async listDecidedIn(input: {
      ranges: readonly MatchBacklogRange[];
      spaceKey: string | null;
      afterNoteId: string | null;
      limit: number;
    }): Promise<MatchBacklogNote[]> {
      if (input.ranges.length === 0) return [];
      const [lows, highs] = rangeBounds(input.ranges);
      const result = await db.query<MatchBacklogNote>(
        listNotesSql(affectedFrom(insideRanges("s.matched_at", "$1", "$5")), "$3", "$4"),
        [lows, input.spaceKey, input.afterNoteId, pageLimit(input.limit), highs]
      );
      return result.rows;
    },

    /** How many source pairs were judged inside one of these spans of time. */
    async countPairsDecidedIn(ranges: readonly MatchBacklogRange[]): Promise<number> {
      if (ranges.length === 0) return 0;
      const [lows, highs] = rangeBounds(ranges);
      const result = await db.query<{ count: number }>(
        `select count(*)::int as count from source_matching_decisions d
          where ${insideRanges("d.created_at", "$1", "$2")}`,
        [lows, highs]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /**
     * A page, in ID order after `afterRootId`, of the source roots that judged a pair inside one of
     * these spans of time: the roots whose discovery judges those pairs again.
     */
    async listPairRootsDecidedIn(input: {
      ranges: readonly MatchBacklogRange[];
      afterRootId: string | null;
      limit: number;
    }): Promise<string[]> {
      if (input.ranges.length === 0) return [];
      const [lows, highs] = rangeBounds(input.ranges);
      const result = await db.query<{ rootId: string }>(
        `select d.source_root_id::text as "rootId" from source_matching_decisions d
          where ${insideRanges("d.created_at", "$1", "$2")}
            and ($3::uuid is null or d.source_root_id > $3::uuid)
          group by d.source_root_id
          order by d.source_root_id
          limit $4`,
        [lows, highs, input.afterRootId, pageLimit(input.limit)]
      );
      return result.rows.map((row) => row.rootId);
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
     * Resolves the open MATCH backlog findings of one `reason` but `exceptFingerprint`: after the
     * decider (or the matching values) changed again, or once nothing is left to match again, an
     * older offer is moot. Offers of the other reason are not touched. A finding that states no
     * reason is a decider's offer (the first kind of offer, F4 T83).
     */
    async resolveOpen(
      exceptFingerprint: string | null,
      reason: MatchBacklogReason = "decider_changed"
    ): Promise<number> {
      const result = await db.query(
        `update gardener_findings set status = 'resolved', closed_at = now(), updated_at = now()
          where kind = $1 and params ->> 'task' = $2 and status = 'open'
            and coalesce(params ->> 'reason', 'decider_changed') = $4
            and fingerprint is distinct from $3::text`,
        [matchBacklogFindingKind, matchBacklogTask, exceptFingerprint, reason]
      );
      return result.rowCount ?? 0;
    }
  };
}
