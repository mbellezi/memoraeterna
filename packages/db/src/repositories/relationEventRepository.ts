import type { QueryResultRow } from "pg";

import { withTransaction, type PgPool } from "../client.js";
import { relationRunRevertedOutcome } from "./relationMatchRunRepository.js";
import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

/**
 * The kinds of relation event (F3 D14); the `kind` CHECK of `relation_events` holds the same list.
 * The canonical note upsert and the veto record `applied`, `suggested`, `typed`, `untyped`,
 * `vetoed` and `reconciled` themselves, in their own statement; the review writer (`kept`,
 * `removed`) and source promotion (`promoted`, `retired`) append theirs with `append`.
 */
export const relationEventKinds = [
  "applied",
  "suggested",
  "typed",
  "untyped",
  "vetoed",
  "kept",
  "removed",
  "promoted",
  "retired",
  "reconciled"
] as const;
export type RelationEventKind = (typeof relationEventKinds)[number];

/** The relation table an event is about: note relations or source relations. */
export const relationEventRelationKinds = ["note", "source"] as const;
export type RelationEventRelationKind = (typeof relationEventRelationKinds)[number];

/** The table of each relation kind, which `revertRun` restores rows in. */
const relationTables = {
  note: "atomic_note_relations",
  source: "source_relations"
} as const satisfies Record<RelationEventRelationKind, string>;

export interface RelationEventRecord {
  id: string;
  /** The global append order: a run is reverted by walking its events backwards. */
  seq: number;
  runId: string;
  relationKind: RelationEventRelationKind;
  /** No foreign key (F2 D32): the event outlives a deleted relation. */
  relationId: string | null;
  pairKey: string;
  kind: RelationEventKind;
  /** The relation row (`to_jsonb`) before the change; null when the change created it. */
  before: JsonObject | null;
  /** The relation row after the change; null when the change deleted it. */
  after: JsonObject | null;
  at: Date;
}

export interface RelationEventInput {
  runId: string;
  relationKind: RelationEventRelationKind;
  relationId: string | null;
  pairKey: string;
  kind: RelationEventKind;
  before: JsonObject | null;
  after: JsonObject | null;
}

/** Something that stops a run from being reverted exactly; the revert changes nothing then. */
export type RelationRevertBlocker =
  /** The run is still open: more events may arrive. Finish (or cancel) it first. */
  | { code: "run_open"; runId: string }
  /**
   * A later run, not reverted, changed the same relation (the F2 undo precedent). `eventId` and
   * `eventKind` are that run's first event on it; revert the later run first.
   */
  | ({
      code: "later_run";
      runId: string;
      runKind: string;
      startedAt: Date;
      eventKind: RelationEventKind;
    } & RelationRevertItem)
  /**
   * The relation is no longer what the run left: `changed_since` (written by something that
   * records no event, such as a human review), `row_missing` (deleted), `row_exists` (the run
   * deleted it and a row is back), or `restore_refused` (the database refused the earlier row, for
   * example a pair that exists under another ID). `eventId` is the run's event that cannot be undone.
   */
  | ({
      code: "changed_since" | "row_missing" | "row_exists" | "restore_refused";
      reason: string;
    } & RelationRevertItem);

interface RelationRevertItem {
  relationKind: RelationEventRelationKind;
  relationId: string | null;
  pairKey: string;
  eventId: string;
}

/** A relation row a revert changed. `none`: created and deleted within the run, so nothing remains. */
export interface RelationRevertedRelation {
  relationKind: RelationEventRelationKind;
  relationId: string;
  pairKey: string;
  change: "restored" | "deleted" | "recreated" | "none";
}

export type RelationRevertResult =
  | {
      kind: "reverted";
      runId: string;
      /** The run's events, all of which stay in the log. */
      events: number;
      restored: number;
      deleted: number;
      recreated: number;
      /** Events with no relation row to restore (no relation ID or no image). */
      skipped: number;
      /** Every relation row the revert touched, for the caller's push and re-promotion. */
      relations: RelationRevertedRelation[];
    }
  | {
      kind: "blocked";
      runId: string;
      /** The first blockers (at most `maxRevertBlockers`). */
      blockers: RelationRevertBlocker[];
      blockerCount: number;
    }
  | { kind: "already_reverted"; runId: string }
  | { kind: "not_found"; runId: string };

/** How many blockers a blocked revert names. */
export const maxRevertBlockers = 200;

const eventBatchSize = 500;

interface EventRow extends QueryResultRow {
  id: string;
  seq: string | number;
  runId: string;
  relationKind: RelationEventRelationKind;
  relationId: string | null;
  pairKey: string;
  kind: RelationEventKind;
  before: unknown;
  after: unknown;
  at: unknown;
}

interface RevertEventRow extends QueryResultRow {
  id: string;
  seq: string | number;
  relationKind: RelationEventRelationKind;
  relationId: string | null;
  pairKey: string;
  hasBefore: boolean;
  hasAfter: boolean;
}

const eventColumns = `id, seq, run_id as "runId", relation_kind as "relationKind",
  relation_id as "relationId", pair_key as "pairKey", kind, before, after, at`;

const mapImage = (value: unknown): JsonObject | null =>
  value === null || value === undefined ? null : asJsonObject(value);

const mapEvent = (row: EventRow): RelationEventRecord => ({
  id: row.id,
  seq: Number(row.seq),
  runId: row.runId,
  relationKind: row.relationKind,
  relationId: row.relationId,
  pairKey: row.pairKey,
  kind: row.kind,
  before: mapImage(row.before),
  after: mapImage(row.after),
  at: mapTimestamp(row.at)
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A revert that found blockers: thrown inside its transaction so everything rolls back. */
class RevertBlocked extends Error {
  constructor(
    readonly blockers: RelationRevertBlocker[],
    readonly count: number
  ) {
    super("Relation run revert blocked");
  }
}

interface RevertStateRow extends QueryResultRow {
  present: boolean;
  matches: boolean;
}

/**
 * Where a relation row stands against one image of an event (`side`): whether the row exists and
 * whether it equals the image, compared as typed rows (so timestamps compare as instants). The
 * image never leaves the database: it is read from the event, so the numbers and text restored are
 * exactly the ones recorded.
 */
const stateSql = (table: string, side: "before" | "after") => `
select (t.id is not null) as present,
       (t.id is not null and ev.${side} is not null and row(t.*) is not distinct from row(rec.*)) as matches
  from relation_events ev
  left join ${table} t on t.id = ev.relation_id
  left join lateral jsonb_populate_record(null::${table}, ev.${side}) rec on true
 where ev.id = $1::uuid`;

/** $1 event ID. Puts the row back to the event's `before` image, column by column, in place. */
const updateSql = (table: string, columnList: readonly string[]) => `
update ${table} t
   set (${columnList.map((column) => `"${column}"`).join(", ")}) =
       (select ${columnList.map((column) => `rec."${column}"`).join(", ")}
          from jsonb_populate_record(null::${table}, ev.before) rec)
  from relation_events ev
 where ev.id = $1::uuid and t.id = ev.relation_id`;

const insertSql = (table: string) => `
insert into ${table}
select rec.* from relation_events ev, jsonb_populate_record(null::${table}, ev.before) rec
 where ev.id = $1::uuid`;

const deleteSql = (table: string) => `
delete from ${table} t using relation_events ev where ev.id = $1::uuid and t.id = ev.relation_id`;

const columnListSql = `
select a.attname as name from pg_attribute a
 where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
   and a.attgenerated = '' and a.attname <> 'id'
 order by a.attnum`;

/**
 * Relation events (F3 D14, I-R8): the append-only log of every automatic relation change, with the
 * relation row before and after, grouped by run (`relationMatchRunRepository`). `revertRun` puts a
 * run's rows back byte for byte. The caller's pool serves reverts, which run in one transaction.
 */
export function createRelationEventRepository(pool: PgPool) {
  const columnCache = new Map<string, string[]>();
  /** The columns a restore sets: every column but the ID, read once from the catalog. */
  const columnsOf = async (db: Queryable, table: string): Promise<string[]> => {
    const cached = columnCache.get(table);
    if (cached) return cached;
    const names = (await db.query<{ name: string }>(columnListSql, [table])).rows.map(
      (row) => row.name
    );
    columnCache.set(table, names);
    return names;
  };

  async function revert(
    client: Queryable,
    runId: string
  ): Promise<Exclude<RelationRevertResult, { kind: "blocked" }>> {
    if (!uuidPattern.test(runId)) return { kind: "not_found", runId };
    // The run row serializes reverts of one run and its `finish`.
    const run = (
      await client.query<{ finishedAt: unknown; outcome: string | null }>(
        `select finished_at as "finishedAt", outcome from relation_match_runs
          where id = $1::uuid for update`,
        [runId]
      )
    ).rows[0];
    if (!run) return { kind: "not_found", runId };
    if (run.outcome === relationRunRevertedOutcome) return { kind: "already_reverted", runId };
    if (run.finishedAt === null) throw new RevertBlocked([{ code: "run_open", runId }], 1);

    // Lock the rows first: a writer that holds one commits its change and its event before the
    // later-run check below reads the log.
    for (const relationKind of relationEventRelationKinds) {
      await client.query(
        `select t.id from ${relationTables[relationKind]} t
          where t.id in (select e.relation_id from relation_events e
                          where e.run_id = $1::uuid and e.relation_kind = $2)
          order by t.id for update of t`,
        [runId, relationKind]
      );
    }

    // A later run's event on the same relation (by ID, or by pair when the row was re-created)
    // blocks, unless that run was itself reverted: its revert put the row back as this run left it.
    const later = await client.query<{
      runId: string;
      runKind: string;
      startedAt: unknown;
      eventId: string;
      eventKind: RelationEventKind;
      relationKind: RelationEventRelationKind;
      relationId: string | null;
      pairKey: string;
      total: string;
    }>(
      `with mine as (
         select relation_kind, relation_id, pair_key, min(seq) as first_seq
           from relation_events
          where run_id = $1::uuid and (before is not null or after is not null)
          group by relation_kind, relation_id, pair_key
       ), hits as (
         select e.run_id, e.id as event_id, e.seq, e.kind as event_kind,
                m.relation_kind, m.relation_id, m.pair_key
           from mine m
           join relation_events e
             on e.relation_kind = m.relation_kind and e.relation_id = m.relation_id
            and e.seq > m.first_seq and e.run_id <> $1::uuid
         union
         select e.run_id, e.id, e.seq, e.kind, m.relation_kind, m.relation_id, m.pair_key
           from mine m
           join relation_events e
             on e.relation_kind = m.relation_kind and e.pair_key = m.pair_key
            and e.seq > m.first_seq and e.run_id <> $1::uuid
       ), blocking as (
         select distinct on (h.run_id, h.relation_kind, h.relation_id, h.pair_key)
                h.run_id, h.event_id, h.seq, h.event_kind, h.relation_kind, h.relation_id,
                h.pair_key, run.kind as run_kind, run.started_at
           from hits h
           join relation_match_runs run on run.id = h.run_id and run.outcome is distinct from $2
          order by h.run_id, h.relation_kind, h.relation_id, h.pair_key, h.seq
       )
       select run_id as "runId", run_kind as "runKind", started_at as "startedAt",
              event_id as "eventId", event_kind as "eventKind", relation_kind as "relationKind",
              relation_id as "relationId", pair_key as "pairKey", count(*) over() as total
         from blocking order by started_at, seq, relation_id
        limit ${maxRevertBlockers}`,
      [runId, relationRunRevertedOutcome]
    );
    if (later.rows.length > 0)
      throw new RevertBlocked(
        later.rows.map((row) => ({
          code: "later_run" as const,
          runId: row.runId,
          runKind: row.runKind,
          startedAt: mapTimestamp(row.startedAt),
          eventKind: row.eventKind,
          eventId: row.eventId,
          relationKind: row.relationKind,
          relationId: row.relationId,
          pairKey: row.pairKey
        })),
        Number(later.rows[0]!.total)
      );

    // Walk the run backwards. Each event expects the row to stand as the event left it (so a chain
    // of changes is checked link by link) and puts it back as the event found it.
    const blockers: RelationRevertBlocker[] = [];
    let blockerCount = 0;
    const block = (blocker: RelationRevertBlocker) => {
      blockerCount += 1;
      if (blockers.length < maxRevertBlockers) blockers.push(blocker);
    };
    const blockedRelations = new Set<string>();
    const net = new Map<
      string,
      {
        relationKind: RelationEventRelationKind;
        relationId: string;
        pairKey: string;
        startPresent: boolean;
        endPresent: boolean;
      }
    >();
    let events = 0;
    let skipped = 0;
    let cursor: number | null = null;
    for (;;) {
      const batch: { rows: RevertEventRow[] } = await client.query<RevertEventRow>(
        `select id, seq, relation_kind as "relationKind", relation_id as "relationId",
                pair_key as "pairKey", (before is not null) as "hasBefore",
                (after is not null) as "hasAfter"
           from relation_events
          where run_id = $1::uuid and ($2::bigint is null or seq < $2::bigint)
          order by seq desc limit ${eventBatchSize}`,
        [runId, cursor]
      );
      for (const row of batch.rows) {
        events += 1;
        const { hasBefore, hasAfter } = row;
        if (row.relationId === null || (!hasBefore && !hasAfter)) {
          skipped += 1;
          continue;
        }
        const key = `${row.relationKind}:${row.relationId}`;
        if (blockedRelations.has(key)) continue;
        const item: RelationRevertItem = {
          relationKind: row.relationKind,
          relationId: row.relationId,
          pairKey: row.pairKey,
          eventId: row.id
        };
        const table = relationTables[row.relationKind];
        const state = (await client.query<RevertStateRow>(stateSql(table, "after"), [row.id]))
          .rows[0]!;
        const refuse = (code: "changed_since" | "row_missing" | "row_exists", reason: string) => {
          blockedRelations.add(key);
          block({ code, reason, ...item });
        };
        if (!hasAfter) {
          if (state.present) {
            refuse("row_exists", "The run deleted this relation and a row exists again.");
            continue;
          }
        } else if (!state.present) {
          refuse("row_missing", "The relation was deleted after the run.");
          continue;
        } else if (!state.matches) {
          refuse("changed_since", "The relation changed after the run without an event.");
          continue;
        }
        const entry = net.get(key) ?? {
          relationKind: row.relationKind,
          relationId: row.relationId,
          pairKey: row.pairKey,
          startPresent: hasAfter,
          endPresent: hasBefore
        };
        entry.endPresent = hasBefore;
        net.set(key, entry);

        // Deleting a row the run created cannot be refused: relation rows are referenced only by
        // caches that cascade or null out.
        if (!hasBefore) {
          await client.query(deleteSql(table), [row.id]);
          continue;
        }
        // Putting a row back may be refused (a pair taken by another row, an endpoint gone): the
        // step rolls back to here and blocks instead of failing the revert.
        await client.query("savepoint revert_step");
        try {
          if (state.present)
            await client.query(updateSql(table, await columnsOf(client, table)), [row.id]);
          else await client.query(insertSql(table), [row.id]);
          const restored = (await client.query<RevertStateRow>(stateSql(table, "before"), [row.id]))
            .rows[0]!;
          if (!restored.matches)
            throw new Error(
              `Relation ${row.relationId} was not restored byte for byte from event ${row.id}.`
            );
          await client.query("release savepoint revert_step");
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (typeof code !== "string" || !code.startsWith("23")) throw error;
          await client.query("rollback to savepoint revert_step");
          await client.query("release savepoint revert_step");
          blockedRelations.add(key);
          net.delete(key);
          block({
            code: "restore_refused",
            reason: `${code}: ${(error as { constraint?: string }).constraint ?? (error as Error).message}`,
            ...item
          });
        }
      }
      const last = batch.rows.at(-1);
      if (!last || batch.rows.length < eventBatchSize) break;
      cursor = Number(last.seq);
    }
    if (blockerCount > 0) throw new RevertBlocked(blockers, blockerCount);

    const relations: RelationRevertedRelation[] = [...net.values()].map((entry) => ({
      relationKind: entry.relationKind,
      relationId: entry.relationId,
      pairKey: entry.pairKey,
      change: entry.startPresent
        ? entry.endPresent
          ? "restored"
          : "deleted"
        : entry.endPresent
          ? "recreated"
          : "none"
    }));
    await client.query(
      `update relation_match_runs
          set outcome = $2, counts = counts || jsonb_build_object('revertedEvents', $3::int)
        where id = $1::uuid`,
      [runId, relationRunRevertedOutcome, events]
    );
    const count = (change: RelationRevertedRelation["change"]) =>
      relations.filter((relation) => relation.change === change).length;
    return {
      kind: "reverted",
      runId,
      events,
      restored: count("restored"),
      deleted: count("deleted"),
      recreated: count("recreated"),
      skipped,
      relations
    };
  }

  return {
    /**
     * Appends one event to its run's log. The canonical upsert and the veto record theirs inside
     * their own statement; this serves the writers that change relations otherwise (the review
     * writer, source promotion). Pass the writer's `transaction` so the event commits with the
     * change. `before` and `after` are the relation row (`to_jsonb`) around the change: a creation
     * has no `before`, a deletion no `after`, and each names the relation by its `id`.
     */
    async append(input: RelationEventInput, transaction?: Queryable): Promise<RelationEventRecord> {
      if (!(relationEventKinds as readonly string[]).includes(input.kind))
        throw new Error(`Unknown relation event kind "${String(input.kind)}".`);
      if (!(relationEventRelationKinds as readonly string[]).includes(input.relationKind))
        throw new Error(`Unknown relation event relation kind "${String(input.relationKind)}".`);
      if (input.pairKey.length < 1 || input.pairKey.length > 200)
        throw new Error("A relation event pair key has 1 to 200 characters.");
      for (const image of [input.before, input.after]) {
        if (image === null) continue;
        if (
          input.relationId === null ||
          String(image.id).toLowerCase() !== input.relationId.toLowerCase()
        )
          throw new Error("A relation event image is the row of the relation it names (its id).");
      }
      const row = (
        await (transaction ?? pool).query<EventRow>(
          `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
           values ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7::jsonb)
           returning ${eventColumns}`,
          [
            input.runId,
            input.relationKind,
            input.relationId,
            input.pairKey,
            input.kind,
            input.before === null ? null : JSON.stringify(input.before),
            input.after === null ? null : JSON.stringify(input.after)
          ]
        )
      ).rows[0];
      if (!row) throw new Error("Relation event insert returned no row.");
      return mapEvent(row);
    },

    async get(eventId: string): Promise<RelationEventRecord | null> {
      const row = (
        await pool.query<EventRow>(
          `select ${eventColumns} from relation_events where id = $1::uuid`,
          [eventId]
        )
      ).rows[0];
      return row ? mapEvent(row) : null;
    },

    /** A run's events in append order; `afterSeq` and `limit` page through a large run. */
    async listByRun(
      runId: string,
      page: { afterSeq?: number; limit?: number } = {}
    ): Promise<RelationEventRecord[]> {
      const result = await pool.query<EventRow>(
        `select ${eventColumns} from relation_events
          where run_id = $1::uuid and ($2::bigint is null or seq > $2::bigint)
          order by seq limit $3`,
        [runId, page.afterSeq ?? null, Math.max(1, Math.min(page.limit ?? 1000, 10_000))]
      );
      return result.rows.map(mapEvent);
    },

    /** Every event of one relation, in append order, across runs. */
    async listByRelation(
      relationKind: RelationEventRelationKind,
      relationId: string
    ): Promise<RelationEventRecord[]> {
      const result = await pool.query<EventRow>(
        `select ${eventColumns} from relation_events
          where relation_kind = $1 and relation_id = $2::uuid order by seq`,
        [relationKind, relationId]
      );
      return result.rows.map(mapEvent);
    },

    /** How many events of each kind a run recorded (the counts a run finishes with). */
    async countByKind(runId: string): Promise<Partial<Record<RelationEventKind, number>>> {
      const result = await pool.query<{ kind: RelationEventKind; count: number }>(
        `select kind, count(*)::int as count from relation_events where run_id = $1::uuid group by kind`,
        [runId]
      );
      return Object.fromEntries(result.rows.map((row) => [row.kind, row.count]));
    },

    /**
     * Reverts a finished run exactly (I-R8): in one transaction, walking its events backwards, every
     * relation row it created is deleted, every row it deleted is put back and every row it changed
     * gets its earlier values back, column by column from the recorded image (timestamps included),
     * and the run's outcome becomes `reverted`. The events stay: the log is append-only.
     *
     * It changes nothing and names what stops it when the run is open, a later run (not reverted)
     * changed one of its relations, or a relation no longer stands as the run left it (a human
     * review, a deleted note, a pair taken by another row). Reverting a run that was already
     * reverted, or that does not exist, says so. Only the relation rows are restored: caches kept
     * beside them (explanations, source evidence) are derived and are rebuilt by their writers, and
     * the caller pushes `relationsChanged` and enqueues re-promotion for the `relations` it gets
     * back (I-R10).
     */
    async revertRun(runId: string): Promise<RelationRevertResult> {
      try {
        return await withTransaction(pool, (client) => revert(client, runId));
      } catch (error) {
        if (error instanceof RevertBlocked)
          return {
            kind: "blocked",
            runId,
            blockers: error.blockers,
            blockerCount: error.count
          };
        throw error;
      }
    }
  };
}
