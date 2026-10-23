import type { QueryResultRow } from "pg";

import { topicAddressResolution } from "@app/domain";
import type {
  AddressResolution,
  AddressTarget,
  NeighbourEvidence,
  PersistedAddress,
  RedirectNode,
  TitleGroup
} from "@app/domain";

import { withVectorScanSettings } from "./noteRetrievalSql.js";
import { currentTopicNoteSql } from "./topicTreeLoadRepository.js";
import type { Queryable } from "./types.js";

/**
 * The reads of AUDIT's lints (F4 D19, spec 3.7): the nearest neighbours of the notes embedded
 * since the last audit (the partial HNSW indexes of migration 0058), the notes that share a
 * title, the notes whose vector is missing or older than their text, and the persisted
 * `memora://` addresses with whether the objects they name still exist. Everything here only
 * reads; findings are written by `gardenerFindingRepository`, structure by the engine.
 *
 * A "cursor" is the (time, ID) of the last row a scan examined, the time as the text PostgreSQL
 * gives it (microseconds), so a scan resumes exactly after it.
 */

/** The embedding space of the audited tree: the table, and the strategy and model of its vectors. */
export interface AuditEmbeddingSpace {
  dimensions: 256 | 768 | 1024;
  spaceKey: string;
  model: string;
}

export interface ScanCursor {
  at: string;
  id: string;
}

function embeddingTable(space: AuditEmbeddingSpace): string {
  const { dimensions } = space;
  if (dimensions === 256 || dimensions === 768 || dimensions === 1024) {
    return `embeddings_${dimensions}`;
  }
  throw new Error(`Unsupported embedding dimension: ${String(dimensions)}`);
}

/** The strategy a note vector of the space is stored under (`knowledge-service.ts`). */
const strategyOf = (space: AuditEmbeddingSpace): string => `native-v2:${space.spaceKey}`;

/** Microsecond-exact UTC text of a timestamp column (the cursor of a scan). */
const timestampText = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Case-, accent- and whitespace-insensitive title: the duplicate lint's notion of "the same". */
const normalizedTitle = (column: string): string =>
  `lower(f_unaccent(regexp_replace(btrim(${column}), '\\s+', ' ', 'g')))`;

export interface DuplicateBatch {
  /** The notes examined, in cursor order. */
  notes: { id: string; at: string; title: string }[];
  neighbours: NeighbourEvidence[];
}

export interface StaleNoteCandidate {
  id: string;
  /** The source the note was created from (a re-embedding job names it). */
  sourceItemId: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
  /** The content hash stored with the note's vector in the space; null when it has none. */
  storedHash: string | null;
  /** The time the scan resumes after (the note's `updated_at`). */
  at: string;
}

export interface DuplicatePairEvidence {
  a: string;
  b: string;
  /** Both notes are current. */
  bothCurrent: boolean;
  /** The cosine of their vectors in the space, null when either has none. */
  cosine: number | null;
  sameTitle: boolean;
}

export function createAuditLintRepository(db: Queryable) {
  return {
    /**
     * The next `limit` current notes embedded in the space after the cursor, each with its
     * `neighbours` nearest other current notes in the space. The vector query runs with the
     * iterative HNSW scan of note retrieval, so the filter on current notes still fills the limit.
     */
    async duplicateBatch(
      space: AuditEmbeddingSpace,
      after: ScanCursor | null,
      limit: number,
      neighbours: number
    ): Promise<DuplicateBatch> {
      const table = embeddingTable(space);
      const rows = await withVectorScanSettings(db, async (connection) => {
        const result = await connection.query<
          QueryResultRow & {
            id: string;
            at: string;
            title: string;
            otherId: string | null;
            cosine: number | null;
          }
        >(
          `with batch as (
             select e.target_id as id, ${timestampText("e.created_at")} as at,
                    e.created_at as sort_at, e.embedding, n.title
               from ${table} e
               join atomic_notes n on n.id = e.target_id
              where e.target_type = 'atomic_note' and e.strategy = $1 and e.model = $2
                and ${currentTopicNoteSql("n")}
                and ($3::timestamptz is null or (e.created_at, e.target_id) > ($3::timestamptz, $4::uuid))
              order by e.created_at, e.target_id
              limit $5::int
           )
           select b.id, b.at, b.title, nn.other_id as "otherId", nn.cosine
             from batch b
             left join lateral (
               select e.target_id as other_id,
                      greatest(0, 1 - (e.embedding <=> b.embedding)) as cosine
                 from ${table} e
                 join atomic_notes c on c.id = e.target_id
                where e.target_type = 'atomic_note' and e.strategy = $1 and e.model = $2
                  and e.target_id <> b.id and ${currentTopicNoteSql("c")}
                order by e.embedding <=> b.embedding
                limit $6::int
             ) nn on true
            order by b.sort_at, b.id, nn.cosine desc nulls last`,
          [strategyOf(space), space.model, after?.at ?? null, after?.id ?? null, limit, neighbours]
        );
        return result.rows;
      });
      const notes = new Map<string, { id: string; at: string; title: string }>();
      const found: NeighbourEvidence[] = [];
      for (const row of rows) {
        if (!notes.has(row.id)) notes.set(row.id, { id: row.id, at: row.at, title: row.title });
        if (row.otherId !== null && row.cosine !== null) {
          found.push({ noteId: row.id, otherId: row.otherId, cosine: Number(row.cosine) });
        }
      }
      return { notes: [...notes.values()], neighbours: found };
    },

    /**
     * The groups of current notes that share a normalized title with any of `noteIds`, each group
     * with at least two notes. The trigram index narrows the join before the exact comparison.
     */
    async titleGroups(noteIds: readonly string[]): Promise<TitleGroup[]> {
      if (noteIds.length === 0) return [];
      const result = await db.query<QueryResultRow & { ids: string[] }>(
        `with wanted as (
           select ${normalizedTitle("a.title")} as key, min(f_unaccent(a.title)) as sample
             from atomic_notes a
            where a.id = any($1::uuid[]) and ${currentTopicNoteSql("a")} and btrim(a.title) <> ''
            group by 1
         )
         select array_agg(n.id order by n.id) as ids
           from wanted w
           join atomic_notes n on f_unaccent(n.title) % w.sample
                              and ${normalizedTitle("n.title")} = w.key
          where ${currentTopicNoteSql("n")}
          group by w.key
         having count(*) > 1
          order by w.key`,
        [[...noteIds]]
      );
      return result.rows.map((row) => row.ids);
    },

    /** Whether each pair is still a pair of current notes, and what the vectors and titles say. */
    async pairEvidence(
      space: AuditEmbeddingSpace,
      pairs: readonly (readonly [string, string])[]
    ): Promise<DuplicatePairEvidence[]> {
      if (pairs.length === 0) return [];
      const table = embeddingTable(space);
      const result = await db.query<
        QueryResultRow & {
          a: string;
          b: string;
          bothCurrent: boolean;
          cosine: number | null;
          sameTitle: boolean;
        }
      >(
        `select p.a, p.b,
                (ca.id is not null and cb.id is not null) as "bothCurrent",
                case when ea.embedding is null or eb.embedding is null then null
                     else greatest(0, 1 - (ea.embedding <=> eb.embedding)) end as cosine,
                coalesce(${normalizedTitle("ca.title")} = ${normalizedTitle("cb.title")}
                         and btrim(ca.title) <> '', false) as "sameTitle"
           from unnest($1::uuid[], $2::uuid[]) as p(a, b)
           left join atomic_notes ca on ca.id = p.a and ${currentTopicNoteSql("ca")}
           left join atomic_notes cb on cb.id = p.b and ${currentTopicNoteSql("cb")}
           left join ${table} ea on ea.target_type = 'atomic_note' and ea.target_id = p.a
                                and ea.strategy = $3 and ea.model = $4
           left join ${table} eb on eb.target_type = 'atomic_note' and eb.target_id = p.b
                                and eb.strategy = $3 and eb.model = $4`,
        [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]), strategyOf(space), space.model]
      );
      return result.rows.map((row) => ({
        a: row.a,
        b: row.b,
        bothCurrent: row.bothCurrent,
        cosine: row.cosine === null ? null : Number(row.cosine),
        sameTitle: row.sameTitle
      }));
    },

    /**
     * Current notes with no vector in the space whose `note-embedding` job is neither waiting nor
     * ended within `retryHours`: the ones to queue. Ordered by ID.
     */
    async notesWithoutVector(
      space: AuditEmbeddingSpace,
      limit: number,
      retryHours: number
    ): Promise<{ id: string; sourceItemId: string }[]> {
      const table = embeddingTable(space);
      const result = await db.query<QueryResultRow & { id: string; sourceItemId: string }>(
        `select n.id, n.created_from_source_item_id as "sourceItemId"
           from atomic_notes n
          where ${currentTopicNoteSql("n")}
            and not exists (
              select 1 from ${table} e where e.target_type = 'atomic_note' and e.target_id = n.id
                 and e.strategy = $1 and e.model = $2)
            and not exists (${recentEmbeddingJob("n.id", "$3")})
          order by n.id
          limit $4::int`,
        [strategyOf(space), space.model, retryHours, limit]
      );
      return result.rows;
    },

    /**
     * The next `limit` current notes edited after their vector in the space was written, after the
     * cursor, in the order of the edit. Their text is checked against the stored hash by the caller.
     */
    async notesEditedAfterVector(
      space: AuditEmbeddingSpace,
      after: ScanCursor | null,
      limit: number,
      retryHours: number
    ): Promise<StaleNoteCandidate[]> {
      const table = embeddingTable(space);
      const result = await db.query<
        QueryResultRow & {
          id: string;
          sourceItemId: string;
          title: string;
          ideaStatement: string;
          bodyMarkdown: string;
          storedHash: string | null;
          at: string;
        }
      >(
        `select n.id, n.created_from_source_item_id as "sourceItemId", n.title,
                n.idea_statement as "ideaStatement", n.body_markdown as "bodyMarkdown",
                e.content_hash as "storedHash", ${timestampText("n.updated_at")} as at
           from atomic_notes n
           join ${table} e on e.target_type = 'atomic_note' and e.target_id = n.id
                          and e.strategy = $1 and e.model = $2
          where ${currentTopicNoteSql("n")} and n.updated_at > e.created_at
            and ($3::timestamptz is null or (n.updated_at, n.id) > ($3::timestamptz, $4::uuid))
            and not exists (${recentEmbeddingJob("n.id", "$5")})
          order by n.updated_at, n.id
          limit $6::int`,
        [strategyOf(space), space.model, after?.at ?? null, after?.id ?? null, retryHours, limit]
      );
      return result.rows;
    },

    /** The addresses the app keeps in its recents and pins, newest open first. */
    async persistedAddresses(limit: number): Promise<PersistedAddress[]> {
      const result = await db.query<
        QueryResultRow & { address: string; parentAddress: string | null }
      >(
        `select address, parent_address as "parentAddress" from view_history
          order by opened_at desc, id limit $1::int`,
        [limit]
      );
      const addresses: PersistedAddress[] = [];
      for (const row of result.rows) {
        addresses.push({ address: row.address, role: "entry" });
        if (row.parentAddress) addresses.push({ address: row.parentAddress, role: "parent" });
      }
      return addresses;
    },

    /**
     * How each address resolves now: a source, note or entity exists or not, a topic is live or
     * reaches a live topic through its redirects, and a question has no table to check.
     */
    async addressResolutions(
      targets: readonly AddressTarget[],
      maxHops: number
    ): Promise<Map<string, AddressResolution>> {
      const resolutions = new Map<string, AddressResolution>();
      const idsOf = (kind: AddressTarget["kind"]) =>
        targets.filter((target) => target.kind === kind).map((target) => target.id);
      const tables = [
        ["source", "source_items"],
        ["note", "atomic_notes"],
        ["entity", "entities"]
      ] as const;
      for (const [kind, table] of tables) {
        const ids = idsOf(kind);
        if (ids.length === 0) continue;
        const result = await db.query<QueryResultRow & { id: string }>(
          `select id from ${table} where id = any($1::uuid[])`,
          [ids]
        );
        const existing = new Set(result.rows.map((row) => row.id));
        for (const target of targets) {
          if (target.kind === kind) {
            resolutions.set(target.address, existing.has(target.id) ? "ok" : "missing");
          }
        }
      }
      const topicIds = idsOf("topic");
      if (topicIds.length > 0) {
        const result = await db.query<
          QueryResultRow & { id: string; retired: boolean; redirectTo: string | null }
        >(
          `with recursive walk as (
             select t.id, t.retired_at is not null as retired, t.redirect_to, 0 as hops
               from topics t where t.id = any($1::uuid[])
             union
             select t.id, t.retired_at is not null, t.redirect_to, w.hops + 1
               from walk w join topics t on t.id = w.redirect_to
              where w.retired and w.hops < $2::int
           )
           select distinct id, retired, redirect_to as "redirectTo" from walk`,
          [topicIds, maxHops]
        );
        const nodes = new Map<string, RedirectNode>(
          result.rows.map((row) => [row.id, { retired: row.retired, redirectTo: row.redirectTo }])
        );
        for (const target of targets) {
          if (target.kind === "topic") {
            resolutions.set(target.address, topicAddressResolution(nodes, target.id, maxHops));
          }
        }
      }
      for (const target of targets) {
        if (target.kind === "question") resolutions.set(target.address, "ok");
      }
      return resolutions;
    }
  };
}

export type AuditLintRepository = ReturnType<typeof createAuditLintRepository>;

/**
 * A `note-embedding` job of the note that waits or runs, or ended less than `retryHours` ago: the
 * note is not queued again meanwhile (a failing note is tried once per window).
 */
function recentEmbeddingJob(noteId: string, hours: string): string {
  return `select 1 from jobs j
     where j.type = 'note-embedding' and j.payload->>'atomicNoteId' = ${noteId}::text
       and (j.status in ('queued', 'running')
            or j.finished_at > now() - make_interval(hours => ${hours}::int))`;
}
