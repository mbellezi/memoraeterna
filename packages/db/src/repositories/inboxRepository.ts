import type { QueryResultRow } from "pg";

import {
  inboxCursor,
  inboxKinds,
  inboxReadLimits,
  parseInboxCursor,
  relationConfidenceBands,
  type ChangeSetRisk,
  type InboxKind,
  type InboxObject
} from "@app/domain";

import {
  currentNoteEndpointsSql,
  noteRelationStateSql,
  suggestedNoteRelationSql,
  withdrawnNoteRelationSql
} from "./note-relation-sql.js";
import type { Queryable } from "./types.js";

/**
 * The Inbox's read model over the stores (F4 D29, spec 3.10): one ordered listing of the open
 * items the database holds, and the reads that name them. Nothing here writes a verdict except the
 * quarantine's dismissal, which has no store of its own: it is stamped on the job that quarantined
 * the subject (`payload.inboxDismissedAt`) and holds only until a newer quarantine of that subject.
 * Relation visibility is read through `note-relation-sql.ts` alone (F3 D9). Obsidian conflicts are
 * not here: the sync service lists them, and the Inbox service merges them by the same order.
 */

/** The kinds this repository lists; the sync service lists `obsidian_conflict`. */
export const inboxDatabaseKinds: readonly InboxKind[] = inboxKinds.filter(
  (kind) => kind !== "obsidian_conflict"
);

/** One open item's place in the list. `key` is `<kind>:<id>`, the last tie of the order. */
export interface InboxRowKey {
  kind: InboxKind;
  id: string;
  risk: ChangeSetRisk;
  rank: number;
  /** An ISO UTC time with microseconds. */
  at: string;
  key: string;
  cursor: string;
}

export interface InboxRowsPage {
  /** At most `limit` rows. */
  rows: InboxRowKey[];
  /** More rows follow the last one. */
  hasMore: boolean;
}

export interface InboxCountRows {
  byKind: Partial<Record<InboxKind, number>>;
  byRisk: Record<ChangeSetRisk, number>;
}

export interface InboxPageInput {
  kinds?: readonly InboxKind[] | undefined;
  risk?: ChangeSetRisk | undefined;
  /** The `cursor` of the last row of the previous page. */
  after?: string | null | undefined;
  limit: number;
}

export class InboxCursorError extends Error {
  override readonly name = "InboxCursorError";
}

/** A quarantined subject, as the Inbox words it. */
export interface InboxQuarantineRecord {
  kind: string;
  subjectKey: string;
  errorClass: string | null;
  failures: number;
  lastJobId: string | null;
  quarantinedAt: string;
}

/** A note relation an item names, with its two notes. */
export interface InboxRelationRecord {
  id: string;
  relationType: string | null;
  vetoSource: string | null;
  finalScore: number;
  /** The calibrated probability; null when an uncalibrated or threshold-only decider wrote it. */
  probability: number | null;
  sourceNote: { id: string; title: string };
  targetNote: { id: string; title: string };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const utc = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The suggestion arm's rule (D33), the SQL form of `routesToInbox`: not a contradiction (those are
 * the contradiction arm's, whatever their confidence), and a probability that is null or below the
 * typed "high" band.
 */
const suggestionRuleSql = `r.relation_type is distinct from 'contradicts'
  and (r.probability is null or r.probability < ${relationConfidenceBands.high}::real)`;

/**
 * The Inbox's arms over note relations. `state` is the visibility module's state predicate and
 * `whole` its full predicate (state and both endpoints current); the count reads `whole`. The page
 * reads `state` first, in the list's order, and checks the endpoints only on the rows it takes
 * until the page is full (`pageArm`), so a library with tens of thousands of such relations pays
 * the per-relation endpoint check for one page of them, not for all.
 */
const relationArms: ReadonlyArray<{
  kind: InboxKind;
  risk: ChangeSetRisk;
  state: string;
  whole: string;
  rule?: string;
}> = [
  {
    kind: "contradiction",
    risk: "medium",
    state: noteRelationStateSql.suggested("r"),
    whole: suggestedNoteRelationSql("r"),
    rule: "r.relation_type = 'contradicts'"
  },
  {
    kind: "suggestion",
    risk: "medium",
    state: noteRelationStateSql.suggested("r"),
    whole: suggestedNoteRelationSql("r"),
    rule: suggestionRuleSql
  },
  {
    kind: "withdrawn",
    risk: "low",
    state: noteRelationStateSql.withdrawn("r"),
    whole: withdrawnNoteRelationSql("r")
  }
];

const riskRank = { high: 0, medium: 1, low: 2 } as const satisfies Record<ChangeSetRisk, number>;

/** An arm as the count reads it: every relation the full predicate admits. */
const countArm = (arm: (typeof relationArms)[number]) => `
  select '${arm.kind}'::text, r.id::text, '${arm.risk}', r.updated_at
    from atomic_note_relations r
   where ${arm.whole}${arm.rule ? ` and ${arm.rule}` : ""}
     and ($1::text[] is null or '${arm.kind}' = any($1::text[]))`;

/**
 * An arm as the page reads it: the relations in the list's order (the cursor and the filters
 * applied on the state alone, which is cheap), then the endpoint check on the rows as they come,
 * stopping at the page's `$6` rows. `offset 0` keeps the planner from moving the check below the
 * sort. Cursor, kinds and risk are those of `pageSql`.
 */
const pageArm = (arm: (typeof relationArms)[number]) => {
  const key = `('${arm.kind}:' || r.id::text) collate "C"`;
  return `
  (select '${arm.kind}'::text, s.id::text, '${arm.risk}', s.updated_at
     from (select r.id, r.updated_at, r.source_atomic_note_id, r.target_atomic_note_id
             from atomic_note_relations r
            where ${arm.state}${arm.rule ? ` and ${arm.rule}` : ""}
              and ($1::text[] is null or '${arm.kind}' = any($1::text[]))
              and ($2::text is null or '${arm.risk}' = $2::text)
              and ($3::int is null
                   or (${riskRank[arm.risk]}, r.updated_at, ${key}) > ($3::int, $4::timestamptz, $5::text))
            order by r.updated_at, ${key}
           offset 0) s
    where ${currentNoteEndpointsSql("s")}
    limit $6::int)`;
};

/**
 * The open items of every database-backed kind as `(kind, id, risk, at)`; `$1` filters the kinds
 * (null: all). Each branch is the store's own predicate: pending change-sets (all three stores),
 * quarantined subjects that were not dismissed since, suggested `contradicts` relations and the
 * Divergences an automatic overview patch kept (`contradiction`, D17; a Divergence's ID is
 * `divergence:<finding id>`), the other suggested relations that are not "high" in confidence or
 * have no probability (`suggestion`, D33: the rule of `routesToInbox`, the bound from
 * `relationConfidenceBands`, a number from typed configuration), withdrawn relations (all through
 * the visibility module) and open findings of the Inbox's kinds. `bounded` is the page's form of
 * the relation arms (see `pageArm`); the count reads them whole.
 */
const openItemsSql = (bounded: boolean) => {
  const relation = (kind: InboxKind) => {
    const arm = relationArms.find((entry) => entry.kind === kind)!;
    return bounded ? pageArm(arm) : countArm(arm);
  };
  return `
  select 'review'::text as kind, (cs.kind || ':' || cs.id::text) as id, cs.risk::text as risk,
         cs.at as at
    from change_sets cs
   where cs.status = 'pending_review' and ($1::text[] is null or 'review' = any($1::text[]))
  union all
  select 'quarantined', o.kind || '|' || o.subject_key, 'medium', o.quarantined_at
    from gardener_outcomes o
   where o.quarantined_at is not null and ($1::text[] is null or 'quarantined' = any($1::text[]))
     and not exists (
       select 1 from jobs j
        where j.id = o.last_job_id and j.payload ->> 'inboxDismissedAt' is not null
          and (j.payload ->> 'inboxDismissedAt')::timestamptz >= o.quarantined_at)
  union all${relation("contradiction")}
  union all${relation("suggestion")}
  union all
  select 'contradiction', 'divergence:' || d.id::text, d.risk, d.created_at
    from gardener_findings d
   where d.status = 'open' and d.kind = 'divergence'
     and ($1::text[] is null or 'contradiction' = any($1::text[]))
  union all${relation("withdrawn")}
  union all
  select f.kind, f.id::text, f.risk, f.created_at
    from gardener_findings f
   where f.status = 'open' and f.kind in ('duplicate', 'backlog', 'budget')
     and ($1::text[] is null or f.kind = any($1::text[]))`;
};

/** Risk then age: high first, the oldest first, then the key in byte order (`collate "C"`). */
const rankSql = `(case items.risk when 'high' then 0 when 'medium' then 1 else 2 end)`;
const keySql = `(items.kind || ':' || items.id)`;

/** The statements of `page` and `counts`, exported for the EXPLAIN proof (T176). */
export const pageSql = `
  select items.kind, items.id, items.risk, ${rankSql} as rank, ${utc("items.at")} as at,
         ${keySql} as key
    from (${openItemsSql(true)}) items
   where ($2::text is null or items.risk = $2::text)
     and ($3::int is null or (${rankSql}, items.at, ${keySql} collate "C")
            > ($3::int, $4::timestamptz, $5::text))
   order by ${rankSql}, items.at, ${keySql} collate "C"
   limit $6::int`;

export const countsSql = `select items.kind, items.risk, count(*)::int as n from (${openItemsSql(false)}) items
   group by items.kind, items.risk`;

interface PageRow extends QueryResultRow {
  kind: InboxKind;
  id: string;
  risk: ChangeSetRisk;
  rank: number;
  at: string;
  key: string;
}

const clampLimit = (limit: number): number =>
  Math.max(1, Math.min(inboxReadLimits.pageMax, Math.trunc(limit)));

export function createInboxRepository(db: Queryable) {
  return {
    /** A page of the open items, by risk and age; `hasMore` says whether another page follows. */
    async page(input: InboxPageInput): Promise<InboxRowsPage> {
      const limit = clampLimit(input.limit);
      let after: ReturnType<typeof parseInboxCursor> = null;
      if (input.after) {
        after = parseInboxCursor(input.after);
        if (!after) throw new InboxCursorError("inbox.errors.invalidCursor");
      }
      const kinds = input.kinds?.filter((kind) => inboxDatabaseKinds.includes(kind));
      if (input.kinds && kinds && kinds.length === 0) return { rows: [], hasMore: false };
      const result = await db.query<PageRow>(pageSql, [
        kinds && kinds.length > 0 ? kinds : null,
        input.risk ?? null,
        after?.rank ?? null,
        after?.at ?? null,
        after?.key ?? null,
        limit + 1
      ]);
      const rows = result.rows.slice(0, limit).map((row): InboxRowKey => ({
        kind: row.kind,
        id: row.id,
        risk: row.risk,
        rank: Number(row.rank),
        at: row.at,
        key: row.key,
        cursor: inboxCursor({ rank: Number(row.rank), at: row.at, key: row.key })
      }));
      return { rows, hasMore: result.rows.length > limit };
    },

    /** How many open items each database-backed kind holds, and per risk. */
    async counts(): Promise<InboxCountRows> {
      const result = await db.query<{ kind: InboxKind; risk: ChangeSetRisk; n: number }>(
        countsSql,
        [null]
      );
      const counts: InboxCountRows = { byKind: {}, byRisk: { low: 0, medium: 0, high: 0 } };
      for (const row of result.rows) {
        counts.byKind[row.kind] = (counts.byKind[row.kind] ?? 0) + Number(row.n);
        counts.byRisk[row.risk] += Number(row.n);
      }
      return counts;
    },

    /**
     * The quarantined subjects named by these `<task kind>|<subject>` IDs. `lastJobId` is null when
     * the job that quarantined the subject is gone, so no Retry is offered that cannot run.
     */
    async quarantined(
      subjects: ReadonlyArray<{ kind: string; subjectKey: string }>
    ): Promise<InboxQuarantineRecord[]> {
      if (subjects.length === 0) return [];
      const result = await db.query<InboxQuarantineRecord>(
        `select o.kind, o.subject_key as "subjectKey", o.last_error_class as "errorClass",
                o.consecutive_failures::int as failures,
                (select j.id::text from jobs j where j.id = o.last_job_id) as "lastJobId",
                ${utc("o.quarantined_at")} as "quarantinedAt"
           from gardener_outcomes o
          where o.quarantined_at is not null
            and (o.kind, o.subject_key) in (select * from unnest($1::text[], $2::text[]))`,
        [subjects.map((entry) => entry.kind), subjects.map((entry) => entry.subjectKey)]
      );
      return result.rows;
    },

    /** The note relations with these IDs and their two notes (a relation whose note is gone is left out). */
    async relations(ids: readonly string[]): Promise<InboxRelationRecord[]> {
      if (ids.length === 0) return [];
      const result = await db.query<{
        id: string;
        relationType: string | null;
        vetoSource: string | null;
        finalScore: number;
        probability: number | null;
        sourceId: string;
        sourceTitle: string;
        targetId: string;
        targetTitle: string;
      }>(
        `select r.id::text as id, r.relation_type as "relationType", r.veto_source as "vetoSource",
                r.final_score as "finalScore", r.probability as "probability",
                s.id::text as "sourceId", left(s.title, $2::int) as "sourceTitle",
                t.id::text as "targetId", left(t.title, $2::int) as "targetTitle"
           from atomic_note_relations r
           join atomic_notes s on s.id = r.source_atomic_note_id
           join atomic_notes t on t.id = r.target_atomic_note_id
          where r.id = any($1::uuid[])`,
        [[...ids], inboxReadLimits.titleMax]
      );
      return result.rows.map((row) => ({
        id: row.id,
        relationType: row.relationType,
        vetoSource: row.vetoSource,
        finalScore: Number(row.finalScore),
        probability: row.probability === null ? null : Number(row.probability),
        sourceNote: { id: row.sourceId, title: row.sourceTitle },
        targetNote: { id: row.targetId, title: row.targetTitle }
      }));
    },

    /** The titles of these objects (a topic that is not named yet has none); gone ones are absent. */
    async titles(ids: {
      notes?: readonly string[];
      sources?: readonly string[];
      topics?: readonly string[];
    }): Promise<Map<string, InboxObject["title"]>> {
      const notes = [...(ids.notes ?? [])];
      const sources = [...(ids.sources ?? [])];
      const topics = [...(ids.topics ?? [])];
      const found = new Map<string, InboxObject["title"]>();
      if (notes.length + sources.length + topics.length === 0) return found;
      const result = await db.query<{ kind: string; id: string; title: string | null }>(
        `select 'note' as kind, n.id::text as id, left(n.title, $4::int) as title
           from atomic_notes n where n.id = any($1::uuid[])
         union all
         select 'source', s.id::text, left(s.title, $4::int)
           from source_items s where s.id = any($2::uuid[])
         union all
         select 'topic', t.id::text, left(t.title, $4::int)
           from topics t where t.id = any($3::uuid[])`,
        [notes, sources, topics, inboxReadLimits.titleMax]
      );
      for (const row of result.rows) found.set(`${row.kind}:${row.id}`, row.title);
      return found;
    },

    /**
     * When the vault's conflicts arose (the sync service lists them without a time): an editorial
     * operation's and a projection revision's creation, keyed `editorial:<id>` and
     * `projection:<id>`. Read only; an ID that is not a stored row is absent.
     */
    async obsidianConflictTimes(ids: {
      editorial: readonly string[];
      projection: readonly string[];
    }): Promise<Map<string, Date>> {
      const editorial = ids.editorial.filter((id) => uuidPattern.test(id));
      const projection = ids.projection.filter((id) => uuidPattern.test(id));
      const found = new Map<string, Date>();
      if (editorial.length + projection.length === 0) return found;
      const result = await db.query<{ kind: string; id: string; at: string }>(
        `select 'editorial' as kind, o.id::text as id, ${utc("o.created_at")} as at
           from obsidian_editorial_operations o where o.id = any($1::uuid[])
         union all
         select 'projection', r.id::text, ${utc("r.created_at")}
           from obsidian_projection_revisions r where r.id = any($2::uuid[])`,
        [editorial, projection]
      );
      for (const row of result.rows) found.set(`${row.kind}:${row.id}`, new Date(row.at));
      return found;
    },

    /**
     * Dismisses a quarantined subject's Inbox item: stamped on the job that quarantined it, so a
     * later quarantine of the subject (a newer time) is a new item. A subject whose job is gone has
     * nowhere to keep the stamp: its quarantine mark is released instead (the next failure on the
     * same input quarantines it again), which cannot be taken back. Null when the subject is not
     * quarantined.
     */
    async dismissQuarantine(
      kind: string,
      subjectKey: string
    ): Promise<"stamped" | "released" | null> {
      const stamped = await db.query(
        `update jobs j
            set payload = jsonb_set(j.payload, '{inboxDismissedAt}', to_jsonb(${utc("clock_timestamp()")}))
           from gardener_outcomes o
          where o.kind = $1 and o.subject_key = $2 and o.quarantined_at is not null
            and j.id = o.last_job_id`,
        [kind, subjectKey]
      );
      if ((stamped.rowCount ?? 0) > 0) return "stamped";
      const released = await db.query(
        `update gardener_outcomes set quarantined_at = null, updated_at = now()
          where kind = $1 and subject_key = $2 and quarantined_at is not null`,
        [kind, subjectKey]
      );
      return (released.rowCount ?? 0) > 0 ? "released" : null;
    },

    /** Takes a dismissal back (the Inbox's undo); false when there is nothing stamped to take. */
    async undismissQuarantine(kind: string, subjectKey: string): Promise<boolean> {
      const result = await db.query(
        `update jobs j set payload = j.payload - 'inboxDismissedAt'
           from gardener_outcomes o
          where o.kind = $1 and o.subject_key = $2 and o.quarantined_at is not null
            and j.id = o.last_job_id and j.payload ? 'inboxDismissedAt'`,
        [kind, subjectKey]
      );
      return (result.rowCount ?? 0) > 0;
    }
  };
}

export type InboxRepository = ReturnType<typeof createInboxRepository>;
