import type { QueryResultRow } from "pg";

import { GardenerFindingInputSchema, gardenerFindingKinds } from "@app/domain";
import type {
  GardenerFindingInput,
  GardenerFindingKind,
  GardenerFindingStatus,
  ChangeSetRisk
} from "@app/domain";

import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

/**
 * What AUDIT found for the owner, and the `backlog` and `budget` Inbox items (F4 D19, D29), in
 * `gardener_findings`. A finding is unique per kind and fingerprint: finding it again updates its
 * row, a resolved one reopens, and a dismissed one stays dismissed (the owner's verdict persists).
 * Findings carry the addresses of the objects they name and scalar parameters, never copy.
 */
export interface GardenerFindingRecord {
  id: string;
  kind: GardenerFindingKind;
  fingerprint: string;
  /** `memora://` addresses. */
  objectRefs: string[];
  params: Record<string, unknown>;
  risk: ChangeSetRisk;
  status: GardenerFindingStatus;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

interface FindingRow extends QueryResultRow {
  id: string;
  kind: GardenerFindingKind;
  fingerprint: string;
  objectRefs: unknown;
  params: unknown;
  risk: ChangeSetRisk;
  status: GardenerFindingStatus;
  createdAt: unknown;
  updatedAt: unknown;
  closedAt: unknown;
}

const columns = `id, kind, fingerprint, object_refs as "objectRefs", params, risk, status,
  created_at as "createdAt", updated_at as "updatedAt", closed_at as "closedAt"`;

/** Findings one page lists at most (the Inbox pages by 50). */
export const gardenerFindingPageMax = 50;
/** Findings one `record` call writes at most; a lint caps its findings below it. */
export const gardenerFindingBatchMax = 500;

function mapFinding(row: FindingRow): GardenerFindingRecord {
  return {
    id: row.id,
    kind: row.kind,
    fingerprint: row.fingerprint,
    objectRefs: Array.isArray(row.objectRefs) ? row.objectRefs.map(String) : [],
    params: asJsonObject(row.params),
    risk: row.risk,
    status: row.status,
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt),
    closedAt: mapNullableTimestamp(row.closedAt)
  };
}

/** What `record` did with each finding it was given. */
export interface RecordFindingsResult {
  created: number;
  /** A resolved finding found again: open once more. */
  reopened: number;
  /** An open finding whose objects, parameters or risk changed. */
  updated: number;
  /** An open finding found again unchanged. */
  unchanged: number;
  /** A dismissed finding found again: it stays dismissed. */
  dismissed: number;
}

export interface ListFindingsInput {
  kinds?: readonly GardenerFindingKind[];
  /** Default `open`. */
  status?: GardenerFindingStatus;
  /** The `next` of the previous page. */
  after?: string | null;
  limit?: number;
}

export interface FindingsPage {
  findings: GardenerFindingRecord[];
  /** Pass as `after` to continue; null at the end. */
  next: string | null;
}

/** Risk then age: high first, the oldest first within a risk (D29). */
const riskRank = `(case f.risk when 'high' then 0 when 'medium' then 1 else 2 end)`;

interface PageCursor {
  rank: number;
  createdAt: string;
  id: string;
}

/**
 * The cursor of a row, built by the database so its time keeps the microseconds a JavaScript date
 * would cut (a cut time sorts before its own row and the row would come back on the next page).
 */
const cursorColumn = `${riskRank} || '|' || to_char(f.created_at at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || f.id::text as cursor`;

function decodeCursor(value: string | null | undefined): PageCursor | null {
  if (!value) return null;
  const [rank, createdAt, id] = value.split("|");
  if (rank === undefined || createdAt === undefined || id === undefined) return null;
  const parsed = Number(rank);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 2 ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    return null;
  }
  return { rank: parsed, createdAt, id };
}

const kindSet: ReadonlySet<string> = new Set(gardenerFindingKinds);

export function createGardenerFindingRepository(db: Queryable) {
  return {
    /**
     * Records findings (each validated), in one statement. A pair of kind and fingerprint given twice
     * counts once, the last one winning.
     */
    async record(findings: readonly GardenerFindingInput[]): Promise<RecordFindingsResult> {
      const result: RecordFindingsResult = {
        created: 0,
        reopened: 0,
        updated: 0,
        unchanged: 0,
        dismissed: 0
      };
      const unique = new Map<string, GardenerFindingInput>();
      for (const finding of findings) {
        const parsed = GardenerFindingInputSchema.parse(finding);
        unique.set(`${parsed.kind}\u0000${parsed.fingerprint}`, parsed);
      }
      const rows = [...unique.values()];
      if (rows.length === 0) return result;
      if (rows.length > gardenerFindingBatchMax)
        throw new Error("gardener_findings_batch_too_large");
      const outcome = await db.query<QueryResultRow & { before: string | null; written: boolean }>(
        `with incoming as (
           select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
             as i(kind, fingerprint, object_refs, params, risk)
         ), written as (
           insert into gardener_findings as f (kind, fingerprint, object_refs, params, risk)
           select kind, fingerprint, object_refs::jsonb, params::jsonb, risk from incoming
           on conflict (kind, fingerprint) do update set
             object_refs = excluded.object_refs,
             params = excluded.params,
             risk = excluded.risk,
             status = case when f.status = 'resolved' then 'open' else f.status end,
             closed_at = case when f.status = 'resolved' then null else f.closed_at end,
             updated_at = now()
           where f.status = 'resolved'
              or f.object_refs is distinct from excluded.object_refs
              or f.params is distinct from excluded.params
              or f.risk is distinct from excluded.risk
           returning kind, fingerprint
         )
         select g.status as before, (w.fingerprint is not null) as written
           from incoming i
           left join gardener_findings g on g.kind = i.kind and g.fingerprint = i.fingerprint
           left join written w on w.kind = i.kind and w.fingerprint = i.fingerprint`,
        [
          rows.map((row) => row.kind),
          rows.map((row) => row.fingerprint),
          rows.map((row) => JSON.stringify(row.objectRefs)),
          rows.map((row) => JSON.stringify(row.params)),
          rows.map((row) => row.risk)
        ]
      );
      for (const row of outcome.rows) {
        if (row.before === null) result.created += 1;
        else if (row.before === "resolved") result.reopened += 1;
        else if (row.before === "dismissed") result.dismissed += 1;
        else if (row.written) result.updated += 1;
        else result.unchanged += 1;
      }
      return result;
    },

    /**
     * Resolves the open findings of `kind` that a full scan did not find again (`found` lists the
     * fingerprints it did find), optionally only those whose fingerprint starts with `prefix`.
     */
    async resolveMissing(
      kind: GardenerFindingKind,
      found: readonly string[],
      options: { prefix?: string } = {}
    ): Promise<number> {
      const result = await db.query(
        `update gardener_findings set status = 'resolved', closed_at = now(), updated_at = now()
          where kind = $1 and status = 'open' and fingerprint <> all($2::text[])
            and ($3::text is null or starts_with(fingerprint, $3))`,
        [kind, [...found], options.prefix ?? null]
      );
      return result.rowCount ?? 0;
    },

    /** Resolves the open findings with these fingerprints (their objects are gone or fixed). */
    async resolve(kind: GardenerFindingKind, fingerprints: readonly string[]): Promise<number> {
      if (fingerprints.length === 0) return 0;
      const result = await db.query(
        `update gardener_findings set status = 'resolved', closed_at = now(), updated_at = now()
          where kind = $1 and status = 'open' and fingerprint = any($2::text[])`,
        [kind, [...fingerprints]]
      );
      return result.rowCount ?? 0;
    },

    /** The owner's dismissal of an open finding; it stays dismissed when found again. */
    async dismiss(id: string): Promise<GardenerFindingRecord | null> {
      const result = await db.query<FindingRow>(
        `update gardener_findings f set status = 'dismissed', closed_at = now(), updated_at = now()
          where f.id = $1 and f.status = 'open' returning ${columns}`,
        [id]
      );
      return result.rows[0] ? mapFinding(result.rows[0]) : null;
    },

    /** Takes a dismissal back (the Inbox's undo). */
    async reopen(id: string): Promise<GardenerFindingRecord | null> {
      const result = await db.query<FindingRow>(
        `update gardener_findings f set status = 'open', closed_at = null, updated_at = now()
          where f.id = $1 and f.status = 'dismissed' returning ${columns}`,
        [id]
      );
      return result.rows[0] ? mapFinding(result.rows[0]) : null;
    },

    async get(id: string): Promise<GardenerFindingRecord | null> {
      const result = await db.query<FindingRow>(
        `select ${columns} from gardener_findings f where f.id = $1`,
        [id]
      );
      return result.rows[0] ? mapFinding(result.rows[0]) : null;
    },

    /** A page of findings by risk (high first) and age (oldest first), keyset paged. */
    async list(input: ListFindingsInput = {}): Promise<FindingsPage> {
      const limit = Math.max(1, Math.min(gardenerFindingPageMax, Math.trunc(input.limit ?? 50)));
      const kinds = input.kinds?.filter((kind) => kindSet.has(kind));
      const cursor = decodeCursor(input.after);
      const result = await db.query<FindingRow & { cursor: string }>(
        `select ${columns}, ${cursorColumn} from gardener_findings f
          where f.status = $1 and ($2::text[] is null or f.kind = any($2::text[]))
            and ($3::int is null or (${riskRank}, f.created_at, f.id) > ($3::int, $4::timestamptz, $5::uuid))
          order by ${riskRank}, f.created_at, f.id
          limit $6`,
        [
          input.status ?? "open",
          kinds && kinds.length > 0 ? kinds : null,
          cursor?.rank ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1
        ]
      );
      const page = result.rows.slice(0, limit);
      return {
        findings: page.map(mapFinding),
        next: result.rows.length > limit ? (page.at(-1)?.cursor ?? null) : null
      };
    },

    /** How many findings of each kind have the status (default `open`): the Inbox's counters. */
    async counts(status: GardenerFindingStatus = "open"): Promise<Record<string, number>> {
      const result = await db.query<{ kind: string; count: number }>(
        `select kind, count(*)::int as count from gardener_findings where status = $1 group by kind`,
        [status]
      );
      return Object.fromEntries(result.rows.map((row) => [row.kind, Number(row.count)]));
    },

    /**
     * The open findings of a kind whose turn it is to be checked again: the longest unchecked first
     * (`updated_at`). {@link GardenerFindingRepository.touch} moves the ones still true to the end.
     */
    async dueForCheck(kind: GardenerFindingKind, limit: number): Promise<GardenerFindingRecord[]> {
      const result = await db.query<FindingRow>(
        `select ${columns} from gardener_findings f
          where f.kind = $1 and f.status = 'open' order by f.updated_at, f.id limit $2`,
        [kind, Math.max(0, Math.min(1_000, Math.trunc(limit)))]
      );
      return result.rows.map(mapFinding);
    },

    /** Marks open findings as checked now without changing them. */
    async touch(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const result = await db.query(
        `update gardener_findings set updated_at = now()
          where id = any($1::uuid[]) and status = 'open'`,
        [[...ids]]
      );
      return result.rowCount ?? 0;
    }
  };
}

export type GardenerFindingRepository = ReturnType<typeof createGardenerFindingRepository>;
