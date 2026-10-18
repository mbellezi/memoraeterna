import type { QueryResultRow } from "pg";

import {
  chooseSecondRing,
  objectNeighborhoodLimits,
  type NeighbourCandidate,
  type NoteRelationBand,
  type NoteRelationDirection,
  type ObjectNeighborhood,
  type ObjectNeighborhoodEdge,
  type ObjectNeighborhoodNode
} from "@app/domain";

import type { PgPool } from "../client.js";
import {
  currentNoteSql,
  noteRelationStateLabelSql,
  noteRelationStateSql,
  shownNoteRelationSql
} from "./note-relation-sql.js";

/**
 * Read model of `objects.neighborhood` (F3 D43, R30): the bounded local graph of a note, in one
 * read-only snapshot without AI. Relations are read only through the predicates of
 * `note-relation-sql.ts` (D9): a drawn relation is shown (applied, kept or suggested) between two
 * current notes, and its `state` says which. Every statement looks rows up by primary key or by an
 * existing index, so a hub of 400 relations costs one ranked read, never a scan of the library;
 * `scripts/objects/note-page-benchmark.ts` measures it (p95 <= 20 ms at depth 1, <= 50 ms at
 * depth 2 on a library of 30,000 notes with hubs of 400).
 *
 *   1. the focus and its shown relations, ranked: probability (unknown last), the stored legacy
 *      score (which never leaves this module), the other note's title, ID
 *   2. depth 2 only: the shown relations of the strongest depth-1 notes, each read by its stored
 *      rank first (so a hub neighbour costs a bounded read) and its endpoints' currency after
 *   3. every shown relation among the chosen nodes, through the unique pair index
 */
export interface NeighborhoodRequest {
  objectId: string;
  depth: 1 | 2;
  limit: number;
}

interface NoteFacts {
  id: string;
  title: string;
  ideaStatement: string;
  language: string | null;
}

interface NeighboursRow extends QueryResultRow {
  focus: NoteFacts | null;
  total: number | string;
  neighbours: NoteFacts[];
}

interface SecondRingRow extends QueryResultRow {
  seedRank: number | string;
  probability: number | string | null;
  finalScore: number | string;
  note: NoteFacts;
}

interface EdgeRow extends QueryResultRow {
  id: string;
  lo: string;
  hi: string;
  type: string;
  direction: NoteRelationDirection;
  band: NoteRelationBand | null;
  state: string;
}

const self = { alias: "s", current: "s.current" };
const other = { alias: "o", current: "o.current" };

/** $1 note ID, $2 neighbours listed. One row: the focus, the exact number of shown relations, the page. */
const neighboursSql = `
with self as materialized (
  select n.id, n.title, n.idea_statement, nullif(n.language, 'und') as language,
         ${currentNoteSql("n")} as current
    from atomic_notes n where n.id = $1::uuid
),
rel as (
  select r.id, o.id as other_id, o.title as other_title, o.idea_statement as other_idea,
         o.language as other_language, r.probability, r.final_score
    from atomic_note_relations r
    cross join self s
    -- Primary-key lookups per relation, each endpoint's currency read once (even for a hub).
    cross join lateral (
      select o.id, o.title, o.idea_statement, nullif(o.language, 'und') as language,
             ${currentNoteSql("o")} as current
        from atomic_notes o
       where o.id = case when r.source_atomic_note_id = $1::uuid
                         then r.target_atomic_note_id else r.source_atomic_note_id end
       limit 1) o
   where (r.source_atomic_note_id = $1::uuid or r.target_atomic_note_id = $1::uuid)
     and ${shownNoteRelationSql("r", [self, other])}
),
ranked as (
  select rel.*, row_number() over (
           order by rel.probability desc nulls last, rel.final_score desc, rel.other_title, rel.other_id) as ord
    from rel
)
select (select jsonb_build_object('id', s.id, 'title', s.title, 'ideaStatement', s.idea_statement,
                                  'language', s.language) from self s) as focus,
       (select count(*) from ranked)::int as total,
       coalesce((select jsonb_agg(jsonb_build_object(
                   'id', ranked.other_id, 'title', ranked.other_title,
                   'ideaStatement', ranked.other_idea, 'language', ranked.other_language)
                   order by ranked.ord)
                   from ranked where ranked.ord <= $2::int), '[]'::jsonb) as neighbours`;

/**
 * $1 the focus, $2 the seeds (depth-1 notes, strongest first), $3 relations of a seed read by their
 * stored rank (state only), $4 candidates kept per seed. The state pre-filter and the ranking use
 * the stored columns, so a hub neighbour costs one bounded read; the full predicate (both
 * endpoints current) then decides which of those are drawn.
 */
const secondRingSql = `
select seed.ord::int as "seedRank", c.probability, c.final_score as "finalScore",
       jsonb_build_object('id', c.id, 'title', c.title, 'ideaStatement', c.idea_statement,
                          'language', c.language) as note
  from unnest($2::uuid[]) with ordinality as seed(id, ord)
  join atomic_notes sn on sn.id = seed.id
  cross join lateral (
    select o.id, o.title, o.idea_statement, nullif(o.language, 'und') as language,
           x.probability, x.final_score
      from (select r.* from atomic_note_relations r
             where (r.source_atomic_note_id = seed.id or r.target_atomic_note_id = seed.id)
               and ${noteRelationStateSql.shown("r")}
             order by r.probability desc nulls last, r.final_score desc, r.id
             limit $3::int) x
      cross join lateral (
        select o.id, o.title, o.idea_statement, o.language, ${currentNoteSql("o")} as current
          from atomic_notes o
         where o.id = case when x.source_atomic_note_id = seed.id
                           then x.target_atomic_note_id else x.source_atomic_note_id end
         limit 1) o
     where o.id <> $1::uuid and ${shownNoteRelationSql("x", ["sn", other])}
     order by x.probability desc nulls last, x.final_score desc, x.id
     limit $4::int) c
 order by seed.ord, c.probability desc nulls last, c.final_score desc, c.id`;

/** $1 the chosen nodes. Every shown relation between two of them, by the unique pair index. */
const edgesSql = `
select r.id, r.source_atomic_note_id as lo, r.target_atomic_note_id as hi,
       coalesce(r.relation_type, 'related') as type, r.direction, r.band,
       ${noteRelationStateLabelSql("r")} as state
  from (select a.id as lo, b.id as hi
          from unnest($1::uuid[]) a(id) join unnest($1::uuid[]) b(id) on a.id < b.id) p
  join atomic_note_relations r on r.source_atomic_note_id = p.lo and r.target_atomic_note_id = p.hi
  join atomic_notes ln on ln.id = r.source_atomic_note_id
  join atomic_notes hn on hn.id = r.target_atomic_note_id
 where ${shownNoteRelationSql("r", ["ln", "hn"])}
 order by r.probability desc nulls last, r.final_score desc, r.id`;

/**
 * The statements are fixed text over primary keys and indexes, so planning costs more than running
 * them: a named statement is planned once per connection. One name, one statement.
 */
const preparedNames = {
  neighbours: "object-neighborhood-neighbours",
  secondRing: "object-neighborhood-second-ring",
  edges: "object-neighborhood-edges"
} as const;
function prepared(
  statement: keyof typeof preparedNames,
  text: string,
  values: unknown[]
): { name: string; text: string; values: unknown[] } {
  return { name: preparedNames[statement], text, values };
}

const node = (facts: NoteFacts, depth: 0 | 1 | 2): ObjectNeighborhoodNode => ({
  id: facts.id,
  kind: "note",
  title: facts.title,
  ideaStatement: facts.ideaStatement,
  language: facts.language,
  depth
});

/** Slots a depth-2 answer keeps for the second ring, as a quarter of the nodes it may hold. */
export function secondRingReserve(limit: number): number {
  return Math.floor((limit - 1) / 4);
}

function mapEdge(row: EdgeRow): ObjectNeighborhoodEdge | null {
  // `state` is the label of a shown relation, so it is one of these three; anything else is not drawn.
  if (row.state !== "applied" && row.state !== "kept" && row.state !== "suggested") return null;
  return {
    id: row.id,
    lo: row.lo,
    hi: row.hi,
    direction: row.direction,
    type: row.type,
    state: row.state,
    band: row.band
  };
}

export function createObjectNeighborhoodRepository(pool: PgPool) {
  return {
    /**
     * Null when the note does not exist. One consistent snapshot: repeatable read, read only. The
     * focus is always the first node; at depth 2 the second ring takes the slots the depth-1 notes
     * leave (at least a quarter of them are kept for it while the focus has that many relations).
     */
    async read(request: NeighborhoodRequest): Promise<ObjectNeighborhood | null> {
      const { objectId, depth, limit } = request;
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read, read only");
        const first = (
          await client.query<NeighboursRow>(
            prepared("neighbours", neighboursSql, [objectId, Math.max(0, limit - 1)])
          )
        ).rows[0];
        if (!first?.focus) {
          await client.query("commit");
          return null;
        }
        const room = limit - 1;
        const reserve = depth === 2 ? secondRingReserve(limit) : 0;
        const core = Math.min(first.neighbours.length, room - reserve);
        let ring: ObjectNeighborhoodNode[] = [];
        if (depth === 2 && core > 0 && room > 0) {
          const seeds = first.neighbours.slice(0, objectNeighborhoodLimits.seeds);
          const rows = (
            await client.query<SecondRingRow>(
              prepared("secondRing", secondRingSql, [
                objectId,
                seeds.map((seed) => seed.id),
                objectNeighborhoodLimits.seedPool,
                objectNeighborhoodLimits.perSeed
              ])
            )
          ).rows;
          const facts = new Map(rows.map((row) => [row.note.id, row.note]));
          const candidates: NeighbourCandidate[] = rows.map((row) => ({
            id: row.note.id,
            seedRank: Number(row.seedRank),
            probability: row.probability === null ? null : Number(row.probability),
            finalScore: Number(row.finalScore)
          }));
          const taken = new Set([objectId, ...first.neighbours.map((neighbour) => neighbour.id)]);
          ring = chooseSecondRing(candidates, taken, room - core).map((id) =>
            node(facts.get(id)!, 2)
          );
        }
        // Depth-1 notes the second ring did not need come back, in rank order.
        const depthOne = first.neighbours
          .slice(0, Math.min(first.neighbours.length, room - ring.length))
          .map((neighbour) => node(neighbour, 1));
        const nodes = [node(first.focus, 0), ...depthOne, ...ring];
        const edges =
          nodes.length > 1
            ? (
                await client.query<EdgeRow>(
                  prepared("edges", edgesSql, [nodes.map((entry) => entry.id)])
                )
              ).rows.flatMap((row) => mapEdge(row) ?? [])
            : [];
        await client.query("commit");
        const total = Number(first.total);
        return {
          focus: objectId,
          depth,
          nodes,
          edges,
          neighbourTotal: total,
          truncated: total > depthOne.length
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** The statements behind `read`, for EXPLAIN in verification and the benchmark. */
    statements: { neighbours: neighboursSql, secondRing: secondRingSql, edges: edgesSql }
  };
}
