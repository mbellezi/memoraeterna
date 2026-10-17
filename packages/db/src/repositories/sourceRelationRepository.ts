import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  equivalentSourceRelationTypes,
  planPromotedSourceRelations,
  relationsConfig,
  selectDiscoveryPairs,
  symmetricSourceRelationTypes,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type PromotedSourceRelationPlan,
  type RelationsConfig
} from "@app/domain";
import { withTransaction, type PgPool } from "../client.js";
import { noteRelationStateSql } from "./note-relation-sql.js";
import { createRelationEventRepository } from "./relationEventRepository.js";
import { createRelationMatchRunRepository } from "./relationMatchRunRepository.js";
import type { RetrievalFence } from "./noteRetrievalSql.js";
import type { JsonObject, Queryable } from "./types.js";

export interface SourceRelationChunk {
  id: string;
  sourceItemId: string;
  documentId: string;
  sourceSpanId: string | null;
  content: string;
  contentHash: string;
  title: string;
  summary: string | null;
  rootId: string;
  /** Title of the original work the chunk belongs to; part of the content-stable prompt order. */
  rootTitle: string;
  /** Position of the chunk in its document. */
  chunkIndex: number;
}
export interface SourceRelationNote {
  id: string;
  type: string;
  sourceNoteId: string;
  targetNoteId: string;
  sourceIdea: string;
  targetIdea: string;
  sourceChunkId: string;
  targetChunkId: string;
  sourceItemId: string;
  targetSourceItemId: string;
  fingerprint: string;
}
/**
 * A relation to persist. A verdict decided without prose (source-relations-v5) has null ideas and
 * explanation: its identity is (source, target, type), its evidence merges into an existing relation
 * with that identity, and a relation the owner rejected is never brought back. Prose is only written
 * for relations saved by the earlier contract (fixtures of older rows); their identity includes it.
 */
export interface SourceRelationWrite {
  existingId: string | null;
  sourceItemId: string;
  targetSourceItemId: string;
  relationType: string;
  sourceIdea: string | null;
  targetIdea: string | null;
  explanation: string | null;
  importance: number;
  confidence: number;
  evidence: Array<{
    source: SourceRelationChunk;
    target: SourceRelationChunk;
    note: SourceRelationNote | null;
  }>;
}

/** What one promotion pass changed (design E, F3 D27). */
export interface SourceRelationPromotion {
  /** Promoted relations created. */
  promoted: number;
  /** Relations whose support count changed (a judged one keeps its origin and scores). */
  refreshed: number;
  /** Promoted relations removed (or a judged one's support cleared) when their support was lost. */
  retired: number;
  /** Relations not promoted because the owner rejected an equivalent one. */
  ownerRejected: number;
  /** The other roots whose pairs with the root were looked at. */
  otherRootIds: string[];
  /** The `promote` run of the events, when anything changed. */
  runId: string | null;
}

/** A root's composite vector (`source-composite-centroid-v2`) and its embedding space. */
export interface SourceDiscoveryVector {
  dimensions: 256 | 768 | 1024;
  strategy: string;
  /** The space part of the strategy: roots are compared only within one space. */
  spaceKey: string;
  model: string;
  provider: string;
  runtime: string;
  /** The vector literal as PostgreSQL prints it. */
  embedding: string;
}

/** The pairs discovery planned for a root and the state it stored (D27). */
export interface SourceDiscoveryPlan extends DiscoverySelection {
  /** The root's arrival position; null in a preview of a root never matched. */
  matchSeq: number | null;
  spaceKey: string;
  /** Earlier roots of the space that were candidates (current notes, a composite vector). */
  candidates: number;
}

// The hierarchy maps evidence owners to roots; the relation itself always keeps the actual owners.
export const sourceRelationTreeSql = `with recursive tree as (
  select id, id as root_id from source_items where parent_source_item_id is null
  union all select child.id, parent.root_id from source_items child join tree parent on child.parent_source_item_id = parent.id
)`;
const currentDocument = "d.metadata->>'supersededByDocumentId' is null";
const processableChunk = (
  alias: string
) => `not exists (select 1 from source_items child join chunks cc on cc.source_item_id = child.id
  join documents cd on cd.id = cc.document_id where child.parent_source_item_id = ${alias}.source_item_id and cd.metadata->>'supersededByDocumentId' is null)`;
/**
 * After `sourceRelationTreeSql`: the sources of roots $1 and $2 whose own chunks are evidence (no
 * child source has current chunks), read once per source rather than once per chunk.
 */
const processableSourcesSql = `processable as materialized (
  select t.id, t.root_id from tree t where t.root_id in ($1, $2) and not exists (
    select 1 from source_items child join chunks cc on cc.source_item_id = child.id join documents cd on cd.id = cc.document_id
     where child.parent_source_item_id = t.id and cd.metadata->>'supersededByDocumentId' is null))`;
const chunkColumns = `c.id, c.source_item_id as "sourceItemId", c.document_id as "documentId",
  c.source_span_id as "sourceSpanId", c.content, c.content_hash as "contentHash", s.title,
  c.chunk_index as "chunkIndex", (select root.title from source_items root where root.id = t.root_id) as "rootTitle",
  case when s.metadata->>'summaryStale' = 'true' then null else s.summary end as summary`;
// A note's review status is not a fact of the evidence: approving a note keeps what it supports current.
// Discarded and archived notes stay non-current through the explicit status checks below.
const noteFacts = (alias: string) =>
  `concat_ws('|',${alias}.id::text,${alias}.idea_statement,${alias}.body_markdown,${alias}.supersession_status)`;

/**
 * The facts-only fingerprint of a note relation as source evidence (F3 D11): the relation ID, both
 * endpoints, the direction, the type and both notes' facts, lower endpoint first. Status, band,
 * probability, veto and `metadata` are not facts of the evidence, so writing them never makes a
 * source relation stale; a change of type or direction does. `a` and `b` are the relation's two
 * endpoint notes in either order. Migration 0056 re-keyed every stored fingerprint to this formula.
 */
export function noteRelationFingerprintSql(relation: string, a: string, b: string): string {
  const loFirst = `${a}.id = ${relation}.source_atomic_note_id`;
  return `md5(concat_ws('|',${relation}.id::text,${relation}.source_atomic_note_id::text,
  ${relation}.target_atomic_note_id::text,${relation}.direction,coalesce(${relation}.relation_type,''),
  case when ${loFirst} then ${noteFacts(a)} else ${noteFacts(b)} end,
  case when ${loFirst} then ${noteFacts(b)} else ${noteFacts(a)} end))`;
}
const noteFingerprint = noteRelationFingerprintSql("n", "a", "b");

/**
 * The note relations between roots that source matching may use: applied (F3 D9, D23), between
 * current, source-owned notes whose evidence chunks are current. `a` reads to `b` in the stored
 * direction (a symmetric relation reads from its lower endpoint); a relation whose direction is
 * unknown is left out, as it was before relations v2. The endpoints join on the relation's own
 * columns. `roots` is the condition on the two notes' roots (`ta.root_id`, `tb.root_id`).
 */
const noteRelationsBetweenRootsSql = (roots: string) => `from atomic_note_relations n
        join atomic_notes a on a.id = case when n.direction = 'hi_to_lo' then n.target_atomic_note_id else n.source_atomic_note_id end
        join atomic_notes b on b.id = case when n.direction = 'hi_to_lo' then n.source_atomic_note_id else n.target_atomic_note_id end
        join tree ta on ta.id = a.created_from_source_item_id join tree tb on tb.id = b.created_from_source_item_id
        join chunks ca on ca.id = a.evidence_chunk_id join documents da on da.id = ca.document_id
        join chunks cb on cb.id = b.evidence_chunk_id join documents db on db.id = cb.document_id
        where ${roots}
          and a.id in (n.source_atomic_note_id,n.target_atomic_note_id) and b.id in (n.source_atomic_note_id,n.target_atomic_note_id) and a.id <> b.id
          and n.direction <> 'unknown'
          and ca.source_item_id = a.created_from_source_item_id and cb.source_item_id = b.created_from_source_item_id
          and ${noteRelationStateSql.applied("n")} and a.status not in ('rejected','archived') and b.status not in ('rejected','archived')
          and coalesce(to_jsonb(a)->>'ownership','source')='source' and coalesce(to_jsonb(b)->>'ownership','source')='source'
          and a.supersession_status = 'current' and b.supersession_status = 'current'
          and da.metadata->>'supersededByDocumentId' is null and db.metadata->>'supersededByDocumentId' is null`;
/** $1 and $2 are the two roots, in either order. */
const pairNoteRelationsSql = noteRelationsBetweenRootsSql(
  "((ta.root_id = $1 and tb.root_id = $2) or (ta.root_id = $2 and tb.root_id = $1))"
);

// Currentness is derived at read time, so edits and review changes never leave live stale edges.
// Note-origin evidence is current only while its note relation is applied (F3 C3): an automatic
// veto is not a status, and a withdrawn note relation stops supporting its source relation.
export const sourceRelationEvidenceJoins = `left join chunks sc on sc.id = e.source_chunk_id
  left join chunks tc on tc.id = e.target_chunk_id
  left join documents sd on sd.id = sc.document_id left join documents td on td.id = tc.document_id
  left join atomic_note_relations n on n.id = e.note_relation_id
  left join atomic_notes a on a.id = e.source_note_id
  left join atomic_notes b on b.id = e.target_note_id`;
export const currentSourceRelationEvidenceSql = `(sc.id is not null and tc.id is not null
  and sd.metadata->>'supersededByDocumentId' is null and td.metadata->>'supersededByDocumentId' is null
  and sc.content_hash = e.snapshot->>'sourceHash' and tc.content_hash = e.snapshot->>'targetHash'
  and (e.origin = 'source_analysis' or (n.id is not null and ${noteRelationStateSql.applied("n")}
    and a.status not in ('rejected','archived') and b.status not in ('rejected','archived')
    and a.supersession_status = 'current' and b.supersession_status = 'current'
    and ${noteFingerprint} = e.snapshot->>'noteFingerprint')))`;
export const currentSourceRelationSql = `exists (select 1 from source_relation_evidence e ${sourceRelationEvidenceJoins}
  where e.relation_id = r.id and ${currentSourceRelationEvidenceSql})`;
/**
 * Every importance-ordered read of source relations (F3 R4, I-R11): a promoted relation has no
 * score, so it lists after the scored ones, the better supported first. `r` is the relation alias.
 */
export const sourceRelationImportanceOrderSql = (r = "r") =>
  `${r}.importance desc nulls last, ${r}.support_count desc nulls last`;

/** Evidence rows promotion wrote carry this writer; only those are removed when support is lost. */
const promotionEvidenceWriter = "promotion";
const compositeStrategyPrefix = "source-composite-centroid-v2:";

export function createSourceRelationRepository(pool: PgPool) {
  return {
    async roots(sourceIds: string[]): Promise<string[]> {
      return (
        await pool.query<{ id: string } & QueryResultRow>(
          `${sourceRelationTreeSql}
        select distinct tree.root_id as id, root.title from tree join source_items root on root.id = tree.root_id
        where tree.id = any($1::uuid[]) order by root.title, id`,
          [sourceIds]
        )
      ).rows.map((row) => row.id);
    },

    async fingerprint(rootId: string): Promise<string> {
      const result = await pool.query(
        `${sourceRelationTreeSql}
        select md5(coalesce(string_agg(concat_ws('|', s.id::text, s.title, s.summary, s.metadata->>'summaryStale',
          d.id::text, d.content_hash, c.id::text, c.content_hash, c.chunking_version,c.source_span_id::text,
          summary.output_hash, summary.prompt_version, (summary.metadata->'concepts')::text), E'\\n' order by s.id, d.id,c.id), '')) as fingerprint
        from tree t join source_items s on s.id = t.id
        left join source_summaries summary on summary.source_item_id = s.id and summary.is_current
        left join documents d on d.source_item_id = s.id and ${currentDocument}
        left join chunks c on c.document_id = d.id where t.root_id = $1`,
        [rootId]
      );
      const vectors: string[] = [];
      for (const dimensions of [256, 768, 1024]) {
        const state = await pool.query(
          `${sourceRelationTreeSql}
          select md5(coalesce(string_agg(concat_ws('|',e.target_id::text,e.model,e.provider,e.runtime,e.strategy,e.content_hash),E'\\n' order by e.target_id,e.model),'')) as fingerprint
          from embeddings_${dimensions} e left join chunks c on e.target_type = 'chunk' and c.id = e.target_id
          join tree t on t.id = case when e.target_type = 'source_item' then e.target_id else c.source_item_id end
          where t.root_id = $1`,
          [rootId]
        );
        vectors.push(String(state.rows[0]?.fingerprint ?? ""));
      }
      return hash(JSON.stringify([result.rows[0]?.fingerprint, ...vectors]));
    },

    /**
     * The note relations a pair's prompt lists: those no source relation cites yet, best first.
     * The direction of symmetric types is decided by the prompt's content order, not by an ID order.
     */
    async pairNotes(left: string, right: string, limit = 16): Promise<SourceRelationNote[]> {
      return (
        await pool.query<SourceRelationNote & QueryResultRow>(
          `${sourceRelationTreeSql}
        select n.id, n.relation_type as type, a.id as "sourceNoteId", b.id as "targetNoteId",
          a.idea_statement as "sourceIdea", b.idea_statement as "targetIdea",
          a.evidence_chunk_id as "sourceChunkId", b.evidence_chunk_id as "targetChunkId",
          a.created_from_source_item_id as "sourceItemId", b.created_from_source_item_id as "targetSourceItemId",
          ${noteFingerprint} as fingerprint
        ${pairNoteRelationsSql}
          and not exists (select 1 from source_relation_evidence existing_evidence where existing_evidence.note_relation_id = n.id)
        order by n.final_score desc, a.idea_statement, b.idea_statement, n.id limit $3`,
          [left, right, limit]
        )
      ).rows;
    },

    /**
     * Fingerprints of every note relation between two roots, cited as evidence or not, sorted. A
     * pair's decision key uses these, so a relation persisted from one side (which removes its note
     * relations from the prompt) never makes the other side judge the same pair again.
     */
    async pairNoteFingerprints(left: string, right: string): Promise<string[]> {
      return (
        await pool.query<{ fingerprint: string } & QueryResultRow>(
          `${sourceRelationTreeSql}
        select distinct ${noteFingerprint} as fingerprint
        ${pairNoteRelationsSql}
        order by fingerprint`,
          [left, right]
        )
      ).rows.map((row) => row.fingerprint);
    },

    /**
     * The evidence passages of a pair: the note-cited passages first, then lexical, vector and
     * concept pairs across the two roots, at most `limit` per root. Roots whose passage pairs exceed
     * `bounds.exactEvidencePairs` (a book pair) take D27's fallback instead of the |A| x |B| cross
     * joins: the note-cited passages and exact vector pairs among each root's
     * `bounds.boundedEvidenceChunks` passages nearest to the other root's centroid (F3 R19).
     */
    async pairChunks(
      left: string,
      right: string,
      noteChunkIds: string[],
      limit = 8,
      bounds: Pick<
        RelationsConfig["sourceJudge"],
        "exactEvidencePairs" | "boundedEvidenceChunks"
      > = relationsConfig.sourceJudge
    ): Promise<SourceRelationChunk[]> {
      // The query is asymmetric (left chunks pair with right chunks): visit the works in a content
      // order, so the evidence never depends on which of the two roots started the match.
      [left, right] = await orderRootsByTitle(pool, left, right);
      const notes = noteChunkIds.length
        ? (
            await pool.query<SourceRelationChunk & QueryResultRow>(
              `${sourceRelationTreeSql} select ${chunkColumns},t.root_id as "rootId" from chunks c join source_items s on s.id = c.source_item_id
         join tree t on t.id = c.source_item_id join documents d on d.id = c.document_id
         where c.id = any($1::uuid[]) and ${currentDocument} and ${processableChunk("c")}
         order by array_position($1::uuid[], c.id)`,
              [noteChunkIds]
            )
          ).rows
        : [];
      const sizes = (
        await pool.query<{ left: number; right: number } & QueryResultRow>(
          `${sourceRelationTreeSql}, ${processableSourcesSql}
          select count(*) filter (where t.root_id = $1)::int as left, count(*) filter (where t.root_id = $2)::int as right
            from chunks c join processable t on t.id = c.source_item_id join documents d on d.id = c.document_id
           where ${currentDocument}`,
          [left, right]
        )
      ).rows[0];
      if ((sizes?.left ?? 0) * (sizes?.right ?? 0) > bounds.exactEvidencePairs)
        return capPerRoot(
          [
            ...notes,
            ...(await boundedVectorEvidence(pool, left, right, limit, bounds.boundedEvidenceChunks))
          ],
          [left, right],
          limit
        );
      const result = await pool.query(
        `${sourceRelationTreeSql}, pairs as (
        select a.id as a, b.id as b, similarity(a.content, b.content) as score,
          sa.title as a_title, sb.title as b_title, a.chunk_index as a_index, b.chunk_index as b_index,
          row_number() over (partition by a.source_item_id, b.source_item_id order by similarity(a.content,b.content) desc, a.chunk_index, b.chunk_index, a.id, b.id) as position
        from chunks a join source_items sa on sa.id = a.source_item_id join tree ta on ta.id = a.source_item_id
        join documents da on da.id = a.document_id
        join chunks b on b.source_item_id <> a.source_item_id join source_items sb on sb.id = b.source_item_id
        join tree tb on tb.id = b.source_item_id
        join documents db on db.id = b.document_id
        where ta.root_id = $1 and tb.root_id = $2 and da.metadata->>'supersededByDocumentId' is null
          and db.metadata->>'supersededByDocumentId' is null and ${processableChunk("a")} and ${processableChunk("b")}
      ), selected as (
        select a,b from pairs order by position, score desc, a_title, b_title, a_index, b_index, a, b limit $3
      )
        select ${chunkColumns},t.root_id as "rootId" from chunks c join source_items s on s.id = c.source_item_id join tree t on t.id = c.source_item_id
        where c.id in (select a from selected union select b from selected) order by s.title, c.chunk_index, c.id`,
        [left, right, limit]
      );
      const semanticPairs: Array<{ a: string; b: string; score: number }> = [];
      for (const dimensions of [256, 768, 1024]) {
        const vector = await pool.query(
          `${sourceRelationTreeSql}
          select a.id as a,b.id as b,1 - (av.embedding <=> bv.embedding) as score
          from chunks a join tree ta on ta.id = a.source_item_id join documents da on da.id = a.document_id
          join embeddings_${dimensions} av on av.target_id = a.id and av.target_type = 'chunk' and av.content_hash = a.content_hash
          join chunks b on b.source_item_id <> a.source_item_id join tree tb on tb.id = b.source_item_id join documents db on db.id = b.document_id
          join embeddings_${dimensions} bv on bv.target_id = b.id and bv.target_type = 'chunk' and bv.content_hash = b.content_hash
            and bv.provider = av.provider and bv.model = av.model and bv.runtime = av.runtime and bv.strategy = av.strategy
          where ta.root_id = $1 and tb.root_id = $2 and av.strategy like 'native-v2:%'
            and da.metadata->>'supersededByDocumentId' is null and db.metadata->>'supersededByDocumentId' is null
            and ${processableChunk("a")} and ${processableChunk("b")}
          order by av.embedding <=> bv.embedding, a.content_hash, b.content_hash, a.chunk_index, b.chunk_index, a.id, b.id limit $3`,
          [left, right, limit]
        );
        semanticPairs.push(...(vector.rows as typeof semanticPairs));
      }
      const conceptPairs = await pool.query(
        `${sourceRelationTreeSql}, concepts as (
        select t.root_id,c.id,c.chunk_index,idea->>'idea' as idea from source_summaries summary
        join source_items s on s.id = summary.source_item_id and s.metadata->>'summaryStale' is distinct from 'true'
        join tree t on t.id = s.id cross join lateral jsonb_array_elements(coalesce(summary.metadata->'concepts','[]'::jsonb)) idea
        cross join lateral jsonb_array_elements_text(idea->'evidenceChunkIds') evidence
        join chunks c on c.id::text = evidence and c.source_item_id = s.id join documents d on d.id = c.document_id
        where summary.is_current and t.root_id in ($1,$2) and ${currentDocument}
      ) select a.id as a,b.id as b,similarity(a.idea,b.idea) as score from concepts a join concepts b on a.root_id <> b.root_id
        where a.root_id = $1 and b.root_id = $2
        order by score desc, a.idea, b.idea, a.chunk_index, b.chunk_index, a.id, b.id limit $3`,
        [left, right, limit]
      );
      const rankedIds = [
        ...new Set(
          [...semanticPairs.sort((a, b) => b.score - a.score), ...conceptPairs.rows]
            .slice(0, limit)
            .flatMap((pair) => [pair.a, pair.b])
        )
      ];
      const semantic = rankedIds.length
        ? ((
            await pool.query(
              `${sourceRelationTreeSql} select ${chunkColumns},t.root_id as "rootId"
        from chunks c join tree t on t.id = c.source_item_id join source_items s on s.id = c.source_item_id
        where c.id = any($1::uuid[]) order by array_position($1::uuid[],c.id)`,
              [rankedIds]
            )
          ).rows as SourceRelationChunk[])
        : [];
      // Interleave semantic and lexical evidence, retaining provenance and independently known note passages.
      const direct: SourceRelationChunk[] = [];
      for (let index = 0; index < Math.max(result.rows.length, semantic.length); index++) {
        if (semantic[index]) direct.push(semantic[index]!);
        if (result.rows[index]) direct.push(result.rows[index] as SourceRelationChunk);
      }
      return capPerRoot([...notes, ...direct], [left, right], limit);
    },

    /**
     * The saved relations between two roots (any endpoints within them), with the roots of their
     * endpoints and how they came to be: a judged verdict merges into them and never brings back
     * one the owner rejected.
     */
    async existing(left: string, right: string) {
      return (
        await pool.query(
          `${sourceRelationTreeSql}
        select r.id, r.source_item_id as "sourceItemId", r.target_source_item_id as "targetSourceItemId", r.relation_type as "relationType",
          r.source_idea as "sourceIdea", r.target_idea as "targetIdea", r.status, r.origin,
          a.root_id as "sourceRootId", b.root_id as "targetRootId"
        from source_relations r join tree a on a.id = r.source_item_id join tree b on b.id = r.target_source_item_id
        join source_items rs on rs.id = r.source_item_id join source_items rt on rt.id = r.target_source_item_id
        where (a.root_id = $1 and b.root_id = $2) or (a.root_id = $2 and b.root_id = $1)
        order by ${sourceRelationImportanceOrderSql()}, rs.title, rt.title, r.relation_type, r.source_idea, r.target_idea, r.id limit 100`,
          [left, right]
        )
      ).rows;
    },
    async decision(key: string): Promise<JsonObject | null> {
      return (
        (await pool.query("select metadata from source_matching_decisions where key = $1", [key]))
          .rows[0]?.metadata ?? null
      );
    },
    async runState(key: string): Promise<JsonObject | null> {
      return (
        (await pool.query("select state from source_matching_runs where key = $1", [key])).rows[0]
          ?.state ?? null
      );
    },
    async saveRun(key: string, rootId: string, state: JsonObject) {
      await pool.query(
        `insert into source_matching_runs (key,source_root_id,state) values ($1,$2,$3)
        on conflict (key) do update set state = excluded.state, updated_at = now()`,
        [key, rootId, state]
      );
    },
    async commitDecision(
      key: string,
      left: string,
      right: string,
      relations: SourceRelationWrite[],
      metadata: JsonObject
    ) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await lockRootPair(client, left, right);
        if (
          (await client.query("select 1 from source_matching_decisions where key = $1", [key])).rows
            .length
        ) {
          await client.query("commit");
          return 0;
        }
        let persisted = 0;
        for (const relation of relations)
          if (await persistRelation(client, relation, relationMetadata(metadata))) persisted++;
        await client.query(
          "insert into source_matching_decisions (key,source_root_id,target_root_id,metadata) values ($1,$2,$3,$4)",
          [key, left, right, { ...metadata, persistedCount: persisted }]
        );
        await client.query("commit");
        return persisted;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async review(id: string, status: string, expectedUpdatedAt: string): Promise<boolean> {
      return (
        (
          await pool.query(
            `update source_relations set status = $2::atomic_note_relation_status,
        metadata = metadata || jsonb_build_object('reviewedAt',now(),'previousStatus',status,'reviewHistory',
          coalesce(metadata->'reviewHistory','[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to',$2::text,'at',now()))), updated_at = now()
        where id = $1 and date_trunc('milliseconds',updated_at) = $3::timestamptz returning id`,
            [id, status, expectedUpdatedAt]
          )
        ).rows.length > 0
      );
    },

    /**
     * Promotes a root's typed applied cross-root note relations into source relations with no call
     * (design E, F3 D27): per other root, the relations `planPromotedSourceRelations` plans, with
     * no scores, the supporting note relations as evidence and their count; a judged relation of
     * the same root pair and type keeps its origin and scores and only has its support refreshed;
     * an owner rejection of an equivalent relation is final; a promoted relation whose support is
     * gone is retired (one the owner accepted is kept). Recomputed from the current set, so a
     * second pass changes nothing. Every change is an event of one `promote` run (D14). Limit the
     * pass to some other roots with `otherRootIds`.
     */
    async promoteFromNotes(
      rootId: string,
      options: { otherRootIds?: readonly string[] } = {}
    ): Promise<SourceRelationPromotion> {
      return promoteFromNotes(pool, rootId, options.otherRootIds ?? null);
    },

    /** The root's newest composite vector, or null when it has none (a book whose chapters wait). */
    async discoveryVector(rootId: string): Promise<SourceDiscoveryVector | null> {
      return readDiscoveryVector(pool, rootId);
    },

    /**
     * Plans the discovery pairs of a root (D27) in one transaction serialized per embedding space:
     * the root takes its arrival position (`match_seq`, kept on a later match), the earlier roots of
     * the space with current notes are compared on their composite vectors (an exact scan), the
     * root's nearest and its reverse neighbours are selected, and the state of the root and of the
     * reverse neighbours is stored, so a later root sees it.
     */
    async planDiscovery(input: SourceDiscoveryInput): Promise<SourceDiscoveryPlan> {
      return planDiscovery(pool, input, false);
    },

    /**
     * What `planDiscovery` would select now, read-only: nothing is stored, so a run that cannot
     * judge (no judge routed) moves no bar. A root never matched is compared with every root of
     * the space, as it would arrive last.
     */
    async previewDiscovery(input: SourceDiscoveryInput): Promise<SourceDiscoveryPlan> {
      return planDiscovery(pool, input, true);
    },

    /**
     * The roots earlier plans of a root selected (in the run states other than `exceptKey`) whose
     * pair was never judged under any key: a re-plan selects them again (`owed`), since their bars
     * moved with the plan that selected them.
     */
    async owedDiscoveryRoots(rootId: string, exceptKey: string): Promise<string[]> {
      return (
        await pool.query<{ id: string } & QueryResultRow>(
          `select distinct candidate.id
             from source_matching_runs run
             cross join lateral jsonb_array_elements_text(
               case when jsonb_typeof(run.state->'discovery'->'roots') = 'array'
                 then run.state->'discovery'->'roots' else '[]'::jsonb end) as candidate(id)
            where run.source_root_id = $1 and run.key <> $2
              and run.state->'discovery'->>'status' = 'planned'
              and not exists (select 1 from source_matching_decisions d
                where (d.source_root_id = $1 and d.target_root_id::text = candidate.id)
                   or (d.target_root_id = $1 and d.source_root_id::text = candidate.id))
            order by candidate.id`,
          [rootId, exceptKey]
        )
      ).rows.map((row) => row.id);
    },

    /** The stored discovery state of some roots (the order replay and the tests read it). */
    async matchStates(rootIds: readonly string[]) {
      return (
        await pool.query<
          {
            rootId: string;
            matchSeq: string;
            nearestRootId: string | null;
            nearestCosine: number | null;
            spaceKey: string;
            fingerprint: string;
          } & QueryResultRow
        >(
          `select root_id as "rootId", match_seq as "matchSeq", nearest_root_id as "nearestRootId",
             nearest_cosine as "nearestCosine", space_key as "spaceKey", fingerprint
           from source_match_state where root_id = any($1::uuid[]) order by match_seq`,
          [rootIds]
        )
      ).rows.map((row) => ({ ...row, matchSeq: Number(row.matchSeq) }));
    }
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Distinct passages in order, at most `limit` per root, of the two roots only. */
function capPerRoot(
  chunks: readonly SourceRelationChunk[],
  roots: readonly string[],
  limit: number
): SourceRelationChunk[] {
  const perRoot = new Map<string, number>();
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()].filter((chunk) => {
    if (!roots.includes(chunk.rootId)) return false;
    const count = perRoot.get(chunk.rootId) ?? 0;
    if (count >= limit) return false;
    perRoot.set(chunk.rootId, count + 1);
    return true;
  });
}

/**
 * D27's evidence fallback for large roots (F3 R19): in the embedding space the two roots share
 * most, each root's `bounded` passages nearest to the other root's centroid, then the exact pairs
 * among them by distance (content, then IDs, break ties). Linear in the roots' passages, where the
 * cross joins are quadratic. $1 and $2 are the roots in content order.
 */
async function boundedVectorEvidence(
  pool: PgPool,
  left: string,
  right: string,
  limit: number,
  bounded: number
): Promise<SourceRelationChunk[]> {
  const pairs: Array<{ a: string; b: string; score: number }> = [];
  for (const dimensions of [256, 768, 1024]) {
    const side = (
      root: string
    ) => `select c.id, c.content_hash, c.chunk_index, e.embedding, e.provider, e.model, e.runtime, e.strategy
        from chunks c join processable t on t.id = c.source_item_id join documents d on d.id = c.document_id
        join embeddings_${dimensions} e on e.target_id = c.id and e.target_type = 'chunk' and e.content_hash = c.content_hash
       where t.root_id = ${root} and e.strategy like 'native-v2:%' and ${currentDocument}`;
    const spaces = (alias: string) =>
      `(select provider, model, runtime, strategy, count(*) as n from ${alias} group by 1, 2, 3, 4)`;
    const rows = await pool.query<{ a: string; b: string; score: number } & QueryResultRow>(
      `${sourceRelationTreeSql}, ${processableSourcesSql}, a_side as materialized (${side("$1")}),
      b_side as materialized (${side("$2")}),
      space as (
        select provider, model, runtime, strategy from ${spaces("a_side")} a join ${spaces("b_side")} b
          using (provider, model, runtime, strategy)
         order by a.n + b.n desc, strategy limit 1
      ), a_space as (select a.* from a_side a join space using (provider, model, runtime, strategy)),
      b_space as (select b.* from b_side b join space using (provider, model, runtime, strategy)),
      centers as materialized (
        select (select avg(embedding) from a_space) as a_center, (select avg(embedding) from b_space) as b_center
      ), a_top as (
        select a.* from a_space a cross join centers
         order by a.embedding <=> centers.b_center, a.content_hash, a.chunk_index, a.id limit $4
      ), b_top as (
        select b.* from b_space b cross join centers
         order by b.embedding <=> centers.a_center, b.content_hash, b.chunk_index, b.id limit $4
      )
      select a.id as a, b.id as b, 1 - (a.embedding <=> b.embedding) as score from a_top a cross join b_top b
       order by a.embedding <=> b.embedding, a.content_hash, b.content_hash, a.chunk_index, b.chunk_index, a.id, b.id
       limit $3`,
      [left, right, limit, bounded]
    );
    pairs.push(...rows.rows);
  }
  const ids = [
    ...new Set(
      pairs
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .flatMap((pair) => [pair.a, pair.b])
    )
  ];
  if (!ids.length) return [];
  return (
    await pool.query<SourceRelationChunk & QueryResultRow>(
      `${sourceRelationTreeSql} select ${chunkColumns},t.root_id as "rootId"
        from chunks c join tree t on t.id = c.source_item_id join source_items s on s.id = c.source_item_id
       where c.id = any($1::uuid[]) order by array_position($1::uuid[],c.id)`,
      [ids]
    )
  ).rows;
}

/** Serializes the writers of one pair of roots: judged decisions and promotion. */
async function lockRootPair(db: Queryable, left: string, right: string): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    [left, right].sort().join(":")
  ]);
}

/** Two roots in a content order (title, then ID only when the titles are equal). */
async function orderRootsByTitle(
  pool: PgPool,
  left: string,
  right: string
): Promise<[string, string]> {
  const rows = (
    await pool.query<{ id: string } & QueryResultRow>(
      "select id from source_items where id = any($1::uuid[]) order by title, id",
      [[left, right]]
    )
  ).rows;
  return rows.length === 2 ? [rows[0]!.id, rows[1]!.id] : [left, right];
}
/** The raw verdicts belong to the decision row; relation and evidence rows keep its provenance. */
function relationMetadata(metadata: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "items"));
}

/**
 * The identity of a relation decided without prose: its endpoints and type. A symmetric type reads
 * the same both ways, so its identity does not depend on which endpoint is stored first.
 */
export function sourceRelationIdentityKey(
  sourceItemId: string,
  targetSourceItemId: string,
  relationType: string
): string {
  const endpoints = symmetricSourceRelationTypes.includes(relationType)
    ? [sourceItemId, targetSourceItemId].sort()
    : [sourceItemId, targetSourceItemId];
  return hash(JSON.stringify(["source-relation", ...endpoints, relationType]));
}

/** $1 one source: its root. */
const rootOfSql = `${sourceRelationTreeSql} select root_id from tree where id = $1`;

/**
 * Where a verdict without prose goes (F3 D27 merge rules): the relation of the same type (or its
 * equivalent, `contrasts` for `contradicts`) between the same endpoints, or one between the two
 * roots themselves read the same way (the one row of a root pair and type that promotion keeps,
 * which a book's chapters' verdicts join); its own identity first, then an accepted one, then a
 * judged one, then the strongest. A promoted relation it lands on is upgraded to `judged` with the
 * verdict's scores and keeps its support count; a judged one is never downgraded. Nowhere when the
 * owner rejected an equivalent relation. Runs inside the decision's transaction and pair lock.
 */
async function resolveDecidedRelation(
  db: Queryable,
  relation: SourceRelationWrite,
  metadata: JsonObject
): Promise<{ id: string; reversed: boolean } | null> {
  const identity = sourceRelationIdentityKey(
    relation.sourceItemId,
    relation.targetSourceItemId,
    relation.relationType
  );
  const symmetric = symmetricSourceRelationTypes.includes(relation.relationType);
  const sourceRoot = String((await db.query(rootOfSql, [relation.sourceItemId])).rows[0]?.root_id);
  const targetRoot = String(
    (await db.query(rootOfSql, [relation.targetSourceItemId])).rows[0]?.root_id
  );
  const equivalent = (
    await db.query<
      { id: string; status: string; origin: string; reversed: boolean } & QueryResultRow
    >(
      `${sourceRelationTreeSql}
      select r.id, r.status::text as status, r.origin, ta.root_id <> $6::uuid as reversed
        from source_relations r join tree ta on ta.id = r.source_item_id join tree tb on tb.id = r.target_source_item_id
       where r.relation_type = any($3::text[])
         and ((r.source_item_id = $1 and r.target_source_item_id = $2)
           or ($4 and r.source_item_id = $2 and r.target_source_item_id = $1)
           or (r.source_item_id = ta.root_id and r.target_source_item_id = tb.root_id
             and ((ta.root_id = $6 and tb.root_id = $7) or ($4 and ta.root_id = $7 and tb.root_id = $6))))
       order by (r.identity_key = $5) desc, (r.status = 'accepted') desc, (r.origin = 'judged') desc,
         ${sourceRelationImportanceOrderSql()}, r.created_at, r.id`,
      [
        relation.sourceItemId,
        relation.targetSourceItemId,
        equivalentSourceRelationTypes(relation.relationType),
        symmetric,
        identity,
        sourceRoot,
        targetRoot
      ]
    )
  ).rows;
  if (equivalent.some((row) => row.status === "rejected")) return null;
  const chosen = equivalent[0];
  if (chosen) {
    if (chosen.origin === "promoted")
      await db.query(
        `update source_relations set origin = 'judged', importance = $2, confidence = $3,
           metadata = metadata || $4::jsonb, updated_at = now() where id = $1`,
        [chosen.id, relation.importance, relation.confidence, JSON.stringify(metadata)]
      );
    return { id: chosen.id, reversed: chosen.reversed };
  }
  const result = await db.query(
    `insert into source_relations (identity_key,source_item_id,target_source_item_id,relation_type,importance,confidence,metadata)
    values ($1,$2,$3,$4,$5,$6,$7) on conflict (identity_key) do update set identity_key = excluded.identity_key returning id`,
    [
      identity,
      relation.sourceItemId,
      relation.targetSourceItemId,
      relation.relationType,
      relation.importance,
      relation.confidence,
      metadata
    ]
  );
  return { id: String(result.rows[0]!.id), reversed: false };
}

/** A symmetric relation stored the other way round receives its evidence turned to match. */
function reverseEvidence(
  evidence: SourceRelationWrite["evidence"][number]
): SourceRelationWrite["evidence"][number] {
  const { source, target, note } = evidence;
  return {
    source: target,
    target: source,
    note: note
      ? {
          ...note,
          sourceNoteId: note.targetNoteId,
          targetNoteId: note.sourceNoteId,
          sourceChunkId: note.targetChunkId,
          targetChunkId: note.sourceChunkId,
          sourceIdea: note.targetIdea,
          targetIdea: note.sourceIdea,
          sourceItemId: note.targetSourceItemId,
          targetSourceItemId: note.sourceItemId
        }
      : null
  };
}

/** The key of one evidence row: its origin, both passages at their revisions and the note relation. */
function evidenceKey(
  origin: "atomic_notes" | "source_analysis",
  source: Pick<SourceRelationChunk, "id" | "contentHash">,
  target: Pick<SourceRelationChunk, "id" | "contentHash">,
  note: Pick<SourceRelationNote, "id" | "fingerprint"> | null
): string {
  return hash(
    JSON.stringify([
      origin,
      source.id,
      source.contentHash,
      target.id,
      target.contentHash,
      note?.id,
      note?.fingerprint
    ])
  );
}

/** Persists one relation and its evidence; false when it was not written (owner-rejected). */
async function persistRelation(
  db: Queryable,
  write: SourceRelationWrite,
  metadata: JsonObject
): Promise<boolean> {
  let relation = write;
  let id = relation.existingId;
  if (id) {
    const current = await db.query(
      "select id from source_relations where id = $1 and source_item_id = $2 and target_source_item_id = $3 and relation_type = $4",
      [id, relation.sourceItemId, relation.targetSourceItemId, relation.relationType]
    );
    if (!current.rows.length) throw new Error("errors.sourceRelations.invalidOutput");
  } else if (relation.sourceIdea === null || relation.targetIdea === null) {
    const decided = await resolveDecidedRelation(db, relation, metadata);
    if (decided === null) return false;
    id = decided.id;
    if (decided.reversed)
      relation = {
        ...relation,
        sourceItemId: relation.targetSourceItemId,
        targetSourceItemId: relation.sourceItemId,
        evidence: relation.evidence.map(reverseEvidence)
      };
  } else {
    const identity = hash(
      JSON.stringify([
        relation.sourceItemId,
        relation.targetSourceItemId,
        relation.relationType,
        relation.sourceIdea.toLowerCase().trim(),
        relation.targetIdea.toLowerCase().trim()
      ])
    );
    const result = await db.query(
      `insert into source_relations (identity_key,source_item_id,target_source_item_id,relation_type,source_idea,target_idea,explanation,importance,confidence,metadata)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (identity_key) do update set identity_key = excluded.identity_key returning id`,
      [
        identity,
        relation.sourceItemId,
        relation.targetSourceItemId,
        relation.relationType,
        relation.sourceIdea,
        relation.targetIdea,
        relation.explanation,
        relation.importance,
        relation.confidence,
        metadata
      ]
    );
    id = String(result.rows[0]!.id);
  }
  for (const { source, target, note } of relation.evidence) {
    const origin = note ? "atomic_notes" : "source_analysis";
    const snapshot = {
      sourceHash: source.contentHash,
      targetHash: target.contentHash,
      sourceId: source.id,
      targetId: target.id,
      sourceSpanId: source.sourceSpanId,
      targetSpanId: target.sourceSpanId,
      sourceExcerpt: source.content,
      targetExcerpt: target.content,
      noteFingerprint: note?.fingerprint ?? null
    };
    // Evidence owners and revisions are checked again inside the transaction.
    const valid = await db.query(
      `select c.id from chunks c join documents d on d.id = c.document_id
      where ((c.id = $1 and c.source_item_id = $2 and c.content_hash = $3) or (c.id = $4 and c.source_item_id = $5 and c.content_hash = $6)) and ${currentDocument}`,
      [
        source.id,
        relation.sourceItemId,
        source.contentHash,
        target.id,
        relation.targetSourceItemId,
        target.contentHash
      ]
    );
    if (valid.rows.length !== 2) throw new Error("errors.sourceRelations.staleEvidence");
    await db.query(
      `insert into source_relation_evidence (relation_id,evidence_key,origin,source_chunk_id,target_chunk_id,note_relation_id,source_note_id,target_note_id,snapshot,metadata)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (relation_id,evidence_key) do nothing`,
      [
        id,
        evidenceKey(origin, source, target, note),
        origin,
        source.id,
        target.id,
        note?.id ?? null,
        note?.sourceNoteId ?? null,
        note?.targetNoteId ?? null,
        snapshot,
        metadata
      ]
    );
  }
  return true;
}

// --- promotion (design E, F3 D27) ------------------------------------------------------------------

interface PromotionRow extends QueryResultRow {
  id: string;
  type: string;
  probability: number | null;
  subjectNoteId: string;
  objectNoteId: string;
  subjectRootId: string;
  objectRootId: string;
  subjectIdea: string;
  objectIdea: string;
  subjectChunkId: string;
  objectChunkId: string;
  fingerprint: string;
}

interface PromotionChunk extends QueryResultRow {
  id: string;
  contentHash: string;
  content: string;
  sourceSpanId: string | null;
  rootId: string;
  sourceItemId: string;
}

interface HeldRelation extends QueryResultRow {
  id: string;
  sourceItemId: string;
  targetSourceItemId: string;
  sourceRootId: string;
  targetRootId: string;
  relationType: string;
  status: string;
  origin: "judged" | "promoted";
  supportCount: number | null;
  identityKey: string;
  importance: number | null;
}

/**
 * $1 the root, $2 the other roots (null: all): the typed applied note relations between the root
 * and other roots, each read from its subject (a symmetric one from its lower endpoint).
 */
const promotionRelationsSql = `${sourceRelationTreeSql}
  select n.id, n.relation_type as type, coalesce(n.probability, n.final_score)::float8 as probability,
    a.id as "subjectNoteId", b.id as "objectNoteId", ta.root_id as "subjectRootId", tb.root_id as "objectRootId",
    a.idea_statement as "subjectIdea", b.idea_statement as "objectIdea",
    a.evidence_chunk_id as "subjectChunkId", b.evidence_chunk_id as "objectChunkId", ${noteFingerprint} as fingerprint
  ${noteRelationsBetweenRootsSql(`$1 in (ta.root_id, tb.root_id) and ta.root_id <> tb.root_id
    and ($2::uuid[] is null or (case when ta.root_id = $1 then tb.root_id else ta.root_id end) = any($2::uuid[]))`)}
    and n.relation_type is not null
  order by n.id`;

/** $1 the root, $2 the other roots (null: all): the source relations promotion may hold with them. */
const heldOtherRootsSql = `${sourceRelationTreeSql}
  select distinct case when ta.root_id = $1 then tb.root_id else ta.root_id end as id
    from source_relations r join tree ta on ta.id = r.source_item_id join tree tb on tb.id = r.target_source_item_id
   where $1 in (ta.root_id, tb.root_id) and ta.root_id <> tb.root_id
     and (r.origin = 'promoted' or r.support_count is not null)
     and ($2::uuid[] is null or (case when ta.root_id = $1 then tb.root_id else ta.root_id end) = any($2::uuid[]))`;

/** $1, $2 two roots: every source relation between them, any endpoints within them. */
const heldRelationsSql = `${sourceRelationTreeSql}
  select r.id, r.source_item_id as "sourceItemId", r.target_source_item_id as "targetSourceItemId",
    ta.root_id as "sourceRootId", tb.root_id as "targetRootId", r.relation_type as "relationType",
    r.status::text as status, r.origin, r.support_count as "supportCount", r.identity_key as "identityKey", r.importance
    from source_relations r join tree ta on ta.id = r.source_item_id join tree tb on tb.id = r.target_source_item_id
   where (ta.root_id = $1 and tb.root_id = $2) or (ta.root_id = $2 and tb.root_id = $1)
   order by r.created_at, r.id
   for update of r`;

/** $1 chunk IDs: the passages of promoted evidence, current documents only, with their roots. */
const promotionChunksSql = `${sourceRelationTreeSql}
  select c.id, c.content_hash as "contentHash", c.content, c.source_span_id as "sourceSpanId",
    t.root_id as "rootId", c.source_item_id as "sourceItemId"
    from chunks c join documents d on d.id = c.document_id join tree t on t.id = c.source_item_id
   where c.id = any($1::uuid[]) and ${currentDocument}`;

/** $1 a relation's endpoint: the sources within it (itself and its descendants). */
const subtreeSql = `with recursive sub as (
    select id from source_items where id = $1 union all
    select child.id from source_items child join sub on child.parent_source_item_id = sub.id
  ) select id from sub`;

const imageSql = "select to_jsonb(r) as image from source_relations r where r.id = $1";

async function promoteFromNotes(
  pool: PgPool,
  rootId: string,
  otherRootIds: readonly string[] | null
): Promise<SourceRelationPromotion> {
  const filter = otherRootIds ? [...otherRootIds] : null;
  const relations = (await pool.query<PromotionRow>(promotionRelationsSql, [rootId, filter])).rows;
  const held = (
    await pool.query<{ id: string } & QueryResultRow>(heldOtherRootsSql, [rootId, filter])
  ).rows;
  const others = [
    ...new Set([
      ...relations.map((row) =>
        row.subjectRootId === rootId ? row.objectRootId : row.subjectRootId
      ),
      ...held.map((row) => row.id)
    ])
  ].filter((id) => id !== rootId);
  const result: SourceRelationPromotion = {
    promoted: 0,
    refreshed: 0,
    retired: 0,
    ownerRejected: 0,
    otherRootIds: [],
    runId: null
  };
  if (!others.length) return result;
  const titles = new Map(
    (
      await pool.query<{ id: string; title: string } & QueryResultRow>(
        "select id, title from source_items where id = any($1::uuid[])",
        [[rootId, ...others]]
      )
    ).rows.map((row) => [row.id, row.title])
  );
  const compareRoots = (a: string, b: string) => {
    const [ta, tb] = [titles.get(a) ?? "", titles.get(b) ?? ""];
    return ta < tb ? -1 : ta > tb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  const plans = planPromotedSourceRelations({
    rootId,
    relations: relations.map((row) => ({
      id: row.id,
      type: row.type,
      subjectRootId: row.subjectRootId,
      objectRootId: row.objectRootId,
      probability: row.probability === null ? null : Number(row.probability),
      contentKey: `${row.subjectIdea}\u0000${row.objectIdea}`
    })),
    compareRoots
  });
  const byId = new Map(relations.map((row) => [row.id, row]));
  const chunks = new Map(
    (
      await pool.query<PromotionChunk>(promotionChunksSql, [
        [...new Set(relations.flatMap((row) => [row.subjectChunkId, row.objectChunkId]))]
      ])
    ).rows.map((row) => [row.id, row])
  );
  const runs = createRelationMatchRunRepository(pool);
  const events = createRelationEventRepository(pool);
  let runId: string | null = null;
  const openRun = async () => (runId ??= (await runs.start({ kind: "promote", rootId })).id);
  result.otherRootIds = others.toSorted(compareRoots);
  let outcome: "succeeded" | "failed" = "failed";
  try {
    for (const other of result.otherRootIds) {
      const pairKey = [rootId, other].sort().join(":");
      const pairPlans = plans.filter((plan) =>
        [plan.sourceRootId, plan.targetRootId].includes(other)
      );
      await withTransaction(pool, async (client) => {
        await lockRootPair(client, rootId, other);
        const rows = (await client.query<HeldRelation>(heldRelationsSql, [rootId, other])).rows;
        const handled = new Set<string>();
        const record = async (
          kind: "promoted" | "retired",
          relationId: string,
          before: JsonObject | null,
          after: JsonObject | null
        ) =>
          events.append(
            {
              runId: await openRun(),
              relationKind: "source",
              relationId,
              pairKey,
              kind,
              before,
              after
            },
            client
          );
        const image = async (id: string) =>
          ((await client.query<{ image: JsonObject } & QueryResultRow>(imageSql, [id])).rows[0]
            ?.image ?? null) as JsonObject | null;
        for (const plan of pairPlans) {
          const equivalents = rows.filter((row) => matchesPlan(row, plan));
          equivalents.forEach((row) => handled.add(row.id));
          if (equivalents.some((row) => row.status === "rejected")) {
            result.ownerRejected += 1;
            continue;
          }
          const target = pickPromotionTarget(equivalents, plan);
          const support = plan.noteRelationIds.length;
          let relationId: string;
          if (!target) {
            const inserted = await client.query<{ id: string } & QueryResultRow>(
              `insert into source_relations (identity_key, source_item_id, target_source_item_id, relation_type,
                 importance, confidence, origin, support_count, metadata)
               values ($1, $2, $3, $4, null, null, 'promoted', $5, $6) on conflict (identity_key) do nothing returning id`,
              [
                sourceRelationIdentityKey(plan.sourceRootId, plan.targetRootId, plan.type),
                plan.sourceRootId,
                plan.targetRootId,
                plan.type,
                support,
                { promotedBy: await openRun() }
              ]
            );
            if (!inserted.rows[0]) continue;
            relationId = inserted.rows[0].id;
            await record("promoted", relationId, null, await image(relationId));
            result.promoted += 1;
          } else {
            relationId = target.id;
            if (target.supportCount !== support) {
              const before = await image(relationId);
              await client.query(
                "update source_relations set support_count = $2, updated_at = now() where id = $1",
                [relationId, support]
              );
              await record("promoted", relationId, before, await image(relationId));
              result.refreshed += 1;
            }
          }
          const relation = target ?? {
            sourceItemId: plan.sourceRootId,
            targetSourceItemId: plan.targetRootId
          };
          await syncPromotionEvidence(client, relationId, relation, plan, byId, chunks, openRun);
        }
        for (const row of rows) {
          if (handled.has(row.id) || row.status === "rejected") continue;
          if (row.origin === "promoted" && row.status === "pending_review") {
            const before = await image(row.id);
            await client.query("delete from source_relations where id = $1", [row.id]);
            await record("retired", row.id, before, null);
            result.retired += 1;
          } else if (row.supportCount !== null && row.origin === "judged") {
            const before = await image(row.id);
            await client.query(
              "update source_relations set support_count = null, updated_at = now() where id = $1",
              [row.id]
            );
            await removeStalePromotionEvidence(client, row.id, []);
            await record("retired", row.id, before, await image(row.id));
            result.retired += 1;
          } else if (row.origin === "promoted") {
            // The owner kept it: the relation stays, with nothing promotion no longer supports.
            await removeStalePromotionEvidence(client, row.id, []);
          }
        }
      });
    }
    outcome = "succeeded";
  } finally {
    if (runId)
      await runs.finish(runId, {
        outcome,
        counts: {
          promoted: result.promoted,
          refreshed: result.refreshed,
          retired: result.retired,
          ownerRejected: result.ownerRejected
        }
      });
  }
  result.runId = runId;
  return result;
}

/** Whether a held relation is the plan's relation: the same root pair read the same way and type. */
function matchesPlan(row: HeldRelation, plan: PromotedSourceRelationPlan): boolean {
  if (!equivalentSourceRelationTypes(plan.type).includes(row.relationType)) return false;
  if (row.sourceRootId === plan.sourceRootId && row.targetRootId === plan.targetRootId) return true;
  return (
    plan.symmetric &&
    row.sourceRootId === plan.targetRootId &&
    row.targetRootId === plan.sourceRootId
  );
}

/**
 * The relation a plan lands on: one between the roots themselves first, then an accepted one, then
 * a judged one (never downgraded), then the strongest.
 */
function pickPromotionTarget(
  rows: readonly HeldRelation[],
  plan: PromotedSourceRelationPlan
): HeldRelation | null {
  const atRoots = (row: HeldRelation) =>
    [plan.sourceRootId, plan.targetRootId].includes(row.sourceItemId) &&
    [plan.sourceRootId, plan.targetRootId].includes(row.targetSourceItemId);
  return (
    rows.toSorted(
      (a, b) =>
        Number(atRoots(b)) - Number(atRoots(a)) ||
        Number(b.status === "accepted") - Number(a.status === "accepted") ||
        Number(b.origin === "judged") - Number(a.origin === "judged") ||
        (b.importance ?? -1) - (a.importance ?? -1) ||
        (a.id < b.id ? -1 : 1)
    )[0] ?? null
  );
}

/**
 * Writes the evidence of a promoted (or support-refreshed) relation: each supporting note relation
 * with its two passages, turned to the relation's endpoints, where both passages lie within them
 * and are current; promotion evidence of note relations that no longer support it is removed.
 */
async function syncPromotionEvidence(
  db: Queryable,
  relationId: string,
  relation: { sourceItemId: string; targetSourceItemId: string },
  plan: PromotedSourceRelationPlan,
  relations: ReadonlyMap<string, PromotionRow>,
  chunks: ReadonlyMap<string, PromotionChunk>,
  /** Opens the pass's run on its first change: a pass that changes nothing records no run. */
  runId: () => Promise<string>
): Promise<void> {
  const within = async (endpoint: string) =>
    new Set(
      (await db.query<{ id: string } & QueryResultRow>(subtreeSql, [endpoint])).rows.map(
        (row) => row.id
      )
    );
  const [sourceScope, targetScope] = [
    await within(relation.sourceItemId),
    await within(relation.targetSourceItemId)
  ];
  const held = new Set(
    (
      await db.query<{ key: string } & QueryResultRow>(
        "select evidence_key as key from source_relation_evidence where relation_id = $1",
        [relationId]
      )
    ).rows.map((row) => row.key)
  );
  const keys: string[] = [];
  for (const id of plan.noteRelationIds) {
    const note = relations.get(id);
    if (!note) continue;
    let [source, target] = [chunks.get(note.subjectChunkId), chunks.get(note.objectChunkId)];
    let [sourceNote, targetNote] = [note.subjectNoteId, note.objectNoteId];
    if (source && !sourceScope.has(source.sourceItemId)) {
      [source, target] = [target, source];
      [sourceNote, targetNote] = [targetNote, sourceNote];
    }
    if (!source || !target) continue;
    if (!sourceScope.has(source.sourceItemId) || !targetScope.has(target.sourceItemId)) continue;
    const key = evidenceKey("atomic_notes", source, target, note);
    keys.push(key);
    if (held.has(key)) continue;
    await db.query(
      `insert into source_relation_evidence (relation_id, evidence_key, origin, source_chunk_id, target_chunk_id,
         note_relation_id, source_note_id, target_note_id, snapshot, metadata)
       values ($1, $2, 'atomic_notes', $3, $4, $5, $6, $7, $8, $9) on conflict (relation_id, evidence_key) do nothing`,
      [
        relationId,
        key,
        source.id,
        target.id,
        note.id,
        sourceNote,
        targetNote,
        {
          sourceHash: source.contentHash,
          targetHash: target.contentHash,
          sourceId: source.id,
          targetId: target.id,
          sourceSpanId: source.sourceSpanId,
          targetSpanId: target.sourceSpanId,
          sourceExcerpt: source.content,
          targetExcerpt: target.content,
          noteFingerprint: note.fingerprint
        },
        { writer: promotionEvidenceWriter, runId: await runId() }
      ]
    );
  }
  await removeStalePromotionEvidence(db, relationId, keys);
}

async function removeStalePromotionEvidence(
  db: Queryable,
  relationId: string,
  keep: readonly string[]
): Promise<void> {
  await db.query(
    `delete from source_relation_evidence where relation_id = $1 and origin = 'atomic_notes'
       and metadata->>'writer' = $2 and not (evidence_key = any($3::text[]))`,
    [relationId, promotionEvidenceWriter, [...keep]]
  );
}

// --- discovery (design E, F3 D27) ------------------------------------------------------------------

async function readDiscoveryVector(
  db: Queryable,
  rootId: string
): Promise<SourceDiscoveryVector | null> {
  let newest: { vector: SourceDiscoveryVector; createdAt: number } | null = null;
  for (const dimensions of [256, 768, 1024] as const) {
    const row = (
      await db.query<
        {
          embedding: string;
          strategy: string;
          model: string;
          provider: string;
          runtime: string;
          createdAt: Date;
        } & QueryResultRow
      >(
        `select embedding::text as embedding, strategy, model, provider, runtime, created_at as "createdAt"
           from embeddings_${dimensions}
          where target_type = 'source_item' and target_id = $1 and strategy like '${compositeStrategyPrefix}%'
          order by created_at desc limit 1`,
        [rootId]
      )
    ).rows[0];
    if (!row) continue;
    const createdAt = new Date(row.createdAt).getTime();
    if (newest && newest.createdAt >= createdAt) continue;
    const space = `${dimensions}:${row.strategy.slice(compositeStrategyPrefix.length)}`;
    newest = {
      vector: {
        dimensions,
        strategy: row.strategy,
        spaceKey: space.length <= 200 ? space : `${dimensions}:${hash(space)}`,
        model: row.model,
        provider: row.provider,
        runtime: row.runtime,
        embedding: row.embedding
      },
      createdAt
    };
  }
  return newest?.vector ?? null;
}

interface CandidateRow extends QueryResultRow {
  rootId: string;
  title: string;
  cosine: number;
  linked: boolean;
  nearestRootId: string | null;
  nearestCosine: number | null;
  nearestRootCosine: number | null;
}

export interface SourceDiscoveryInput {
  rootId: string;
  vector: SourceDiscoveryVector;
  fingerprint: string;
  neighbours: number;
  /** A re-match run's visibility fence (3.17): only released roots are candidates. */
  fence?: RetrievalFence | undefined;
  /** Roots earlier plans of the root selected and nobody judged (`owedDiscoveryRoots`). */
  owed?: readonly string[] | undefined;
}

async function planDiscovery(
  pool: PgPool,
  input: SourceDiscoveryInput,
  preview: boolean
): Promise<SourceDiscoveryPlan> {
  const { rootId, vector } = input;
  return withTransaction(pool, async (client) => {
    if (!preview)
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `source-discovery:${vector.spaceKey}`
      ]);
    const seqRow = (
      await client.query<{ matchSeq: string } & QueryResultRow>(
        preview
          ? `select match_seq as "matchSeq" from source_match_state where root_id = $1`
          : `insert into source_match_state (root_id, space_key, fingerprint, matched_at) values ($1, $2, $3, now())
           on conflict (root_id) do update set space_key = excluded.space_key, fingerprint = excluded.fingerprint, matched_at = now()
           returning match_seq as "matchSeq"`,
        preview ? [rootId] : [rootId, vector.spaceKey, input.fingerprint]
      )
    ).rows[0];
    const seq = seqRow ? Number(seqRow.matchSeq) : null;
    // An exact scan: a library has at most thousands of roots, each with one composite vector.
    // Cosines are read at the precision `nearest_cosine` stores (`real`): a bar an earlier plan
    // stored then equals the cosine it came from, and a re-plan compares the same numbers.
    const candidates = (
      await client.query<CandidateRow>(
        `${sourceRelationTreeSql}
        select m.root_id as "rootId", root.title, (1 - (e.embedding <=> $2::vector))::real::float8 as cosine,
          m.nearest_root_id as "nearestRootId", m.nearest_cosine::float8 as "nearestCosine",
          (select (1 - (e.embedding <=> ne.embedding))::real::float8 from embeddings_${vector.dimensions} ne
            where ne.target_type = 'source_item' and ne.target_id = m.nearest_root_id
              and ne.strategy = $3 and ne.model = $4 limit 1) as "nearestRootCosine",
          exists (select 1 from source_relations r join tree sa on sa.id = r.source_item_id join tree sb on sb.id = r.target_source_item_id
            where r.status <> 'rejected' and ((sa.root_id = $1 and sb.root_id = m.root_id) or (sa.root_id = m.root_id and sb.root_id = $1))) as linked
          from source_match_state m
          join source_items root on root.id = m.root_id and root.parent_source_item_id is null
          join embeddings_${vector.dimensions} e on e.target_type = 'source_item' and e.target_id = m.root_id
            and e.strategy = $3 and e.model = $4 and e.provider = $5 and e.runtime = $6
         where m.space_key = $7 and m.root_id <> $1 and ($8::bigint is null or m.match_seq < $8)
           and ($9::uuid[] is null or m.root_id = any($9::uuid[]))
           and exists (select 1 from atomic_notes note join tree t on t.id = note.created_from_source_item_id
             where t.root_id = m.root_id and note.status not in ('rejected','archived') and note.supersession_status = 'current')`,
        [
          rootId,
          vector.embedding,
          vector.strategy,
          vector.model,
          vector.provider,
          vector.runtime,
          vector.spaceKey,
          seq,
          input.fence ? [...input.fence.rootSourceItemIds] : null
        ]
      )
    ).rows.map((row): DiscoveryCandidate => ({
      rootId: row.rootId,
      title: row.title,
      cosine: Number(row.cosine),
      linked: row.linked,
      nearestRootId: row.nearestRootId,
      nearestCosine: row.nearestCosine === null ? null : Number(row.nearestCosine),
      nearestRootCosine: row.nearestRootCosine === null ? null : Number(row.nearestRootCosine)
    }));
    const selection = selectDiscoveryPairs({
      rootId,
      candidates,
      neighbours: input.neighbours,
      ...(input.owed ? { owed: input.owed } : {})
    });
    if (!preview) {
      await client.query(
        "update source_match_state set nearest_root_id = $2, nearest_cosine = $3 where root_id = $1",
        [rootId, selection.state.nearestRootId, selection.state.nearestCosine]
      );
      for (const update of selection.reverse)
        await client.query(
          "update source_match_state set nearest_root_id = $2, nearest_cosine = $3 where root_id = $1",
          [update.rootId, update.nearestRootId, update.nearestCosine]
        );
    }
    return {
      ...selection,
      matchSeq: seq,
      spaceKey: vector.spaceKey,
      candidates: candidates.length
    };
  });
}

export async function listSourceRelations(
  pool: PgPool,
  sourceId: string,
  targetId: string | null,
  offset = 0,
  limit = 30,
  relationId?: string
) {
  const result = await pool.query(
    `with recursive source_scope as (
      select id from source_items where id = $1 union all select child.id from source_items child join source_scope parent on child.parent_source_item_id = parent.id
    ), target_scope as (
      select id from source_items where id = $2 union all select child.id from source_items child join target_scope parent on child.parent_source_item_id = parent.id
    )
    select r.id, r.source_item_id as "sourceItemId", r.target_source_item_id as "targetSourceItemId",
      a.title as "sourceTitle", b.title as "targetTitle", r.relation_type as "relationType",
      r.source_idea as "sourceIdea", r.target_idea as "targetIdea", r.explanation,r.importance,r.confidence,r.status,
      r.origin, r.support_count as "supportCount",
      ${currentSourceRelationSql} as current,r.updated_at as "updatedAt",count(*) over()::int as total
    from source_relations r join source_items a on a.id = r.source_item_id join source_items b on b.id = r.target_source_item_id
    where ($5::uuid is null or r.id=$5) and (r.source_item_id in (select id from source_scope) or r.target_source_item_id in (select id from source_scope))
      and ($2::uuid is null or (r.source_item_id in (select id from source_scope) and r.target_source_item_id in (select id from target_scope))
        or (r.target_source_item_id in (select id from source_scope) and r.source_item_id in (select id from target_scope)))
    order by (r.status = 'rejected'), ${sourceRelationImportanceOrderSql()}, r.id limit $3 offset $4`,
    [sourceId, targetId, limit + 1, offset, relationId ?? null]
  );
  const rows = result.rows.slice(0, limit);
  const relations = [];
  for (const row of rows) {
    const evidence = await pool.query(
      `select e.id,e.origin,coalesce(e.source_chunk_id::text,e.snapshot->>'sourceId') as "sourceChunkId",
      coalesce(e.target_chunk_id::text,e.snapshot->>'targetId') as "targetChunkId",
      e.snapshot->>'sourceSpanId' as "sourceSpanId", e.snapshot->>'targetSpanId' as "targetSpanId",
      e.snapshot->>'sourceExcerpt' as "sourceExcerpt", e.snapshot->>'targetExcerpt' as "targetExcerpt",
      e.source_note_id as "sourceNoteId",e.target_note_id as "targetNoteId",e.note_relation_id as "noteRelationId",${currentSourceRelationEvidenceSql} as current
      from source_relation_evidence e ${sourceRelationEvidenceJoins} where e.relation_id = $1 order by current desc,e.created_at,e.id limit 100`,
      [row.id]
    );
    const { total: _total, ...value } = row;
    relations.push({
      ...value,
      importance: value.importance === null ? null : Number(value.importance),
      confidence: value.confidence === null ? null : Number(value.confidence),
      supportCount: value.supportCount === null ? null : Number(value.supportCount),
      updatedAt: new Date(row.updatedAt).toISOString(),
      evidence: evidence.rows
    });
  }
  return {
    relations,
    hasMore: result.rows.length > limit,
    total: Number(result.rows[0]?.total ?? 0)
  };
}
