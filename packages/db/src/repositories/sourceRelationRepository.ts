import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { PgPool } from "../client.js";
import type { JsonObject, Queryable } from "./types.js";

export interface SourceRelationChunk {
  id: string; sourceItemId: string; documentId: string; sourceSpanId: string | null;
  content: string; contentHash: string; title: string; summary: string | null; rootId: string;
}
export interface SourceRelationNote {
  id: string; type: string; sourceNoteId: string; targetNoteId: string;
  sourceIdea: string; targetIdea: string; sourceChunkId: string; targetChunkId: string;
  sourceItemId: string; targetSourceItemId: string; fingerprint: string;
}
export interface SourceRelationCandidate {
  id: string; textScore: number; vectorScore: number; graphScore: number; noteScore: number;
}
export interface SourceRelationWrite {
  existingId: string | null; sourceItemId: string; targetSourceItemId: string; relationType: string;
  sourceIdea: string; targetIdea: string; explanation: string; importance: number; confidence: number;
  evidence: Array<{ source: SourceRelationChunk; target: SourceRelationChunk; note: SourceRelationNote | null }>;
}

// The hierarchy maps evidence owners to roots; the relation itself always keeps the actual owners.
export const sourceRelationTreeSql = `with recursive tree as (
  select id, id as root_id from source_items where parent_source_item_id is null
  union all select child.id, parent.root_id from source_items child join tree parent on child.parent_source_item_id = parent.id
)`;
const currentDocument = "d.metadata->>'supersededByDocumentId' is null";
const processableChunk = (alias: string) => `not exists (select 1 from source_items child join chunks cc on cc.source_item_id = child.id
  join documents cd on cd.id = cc.document_id where child.parent_source_item_id = ${alias}.source_item_id and cd.metadata->>'supersededByDocumentId' is null)`;
const chunkColumns = `c.id, c.source_item_id as "sourceItemId", c.document_id as "documentId",
  c.source_span_id as "sourceSpanId", c.content, c.content_hash as "contentHash", s.title,
  case when s.metadata->>'summaryStale' = 'true' then null else s.summary end as summary`;
const noteFacts = (alias:string) => `concat_ws('|',${alias}.id::text,${alias}.idea_statement,${alias}.body_markdown,${alias}.status::text,${alias}.supersession_status)`;
const noteFingerprint = `md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
  least(${noteFacts("a")},${noteFacts("b")}),greatest(${noteFacts("a")},${noteFacts("b")})))`;

// Currentness is derived at read time, so edits and review changes never leave live stale edges.
const evidenceJoins = `left join chunks sc on sc.id = e.source_chunk_id
  left join chunks tc on tc.id = e.target_chunk_id
  left join documents sd on sd.id = sc.document_id left join documents td on td.id = tc.document_id
  left join atomic_note_relations n on n.id = e.note_relation_id
  left join atomic_notes a on a.id = e.source_note_id
  left join atomic_notes b on b.id = e.target_note_id`;
const currentEvidence = `(sc.id is not null and tc.id is not null
  and sd.metadata->>'supersededByDocumentId' is null and td.metadata->>'supersededByDocumentId' is null
  and sc.content_hash = e.snapshot->>'sourceHash' and tc.content_hash = e.snapshot->>'targetHash'
  and (e.origin = 'source_analysis' or (n.id is not null and n.status <> 'rejected'
    and a.status not in ('rejected','archived') and b.status not in ('rejected','archived')
    and a.supersession_status = 'current' and b.supersession_status = 'current'
    and ${noteFingerprint} = e.snapshot->>'noteFingerprint')))`;
export const currentSourceRelationSql = `exists (select 1 from source_relation_evidence e ${evidenceJoins}
  where e.relation_id = r.id and ${currentEvidence})`;

export function createSourceRelationRepository(pool: PgPool) {
  return {
    async roots(sourceIds: string[]): Promise<string[]> {
      return (await pool.query<{ id: string } & QueryResultRow>(`${sourceRelationTreeSql}
        select distinct root_id as id from tree where id = any($1::uuid[]) order by id`, [sourceIds])).rows.map((row) => row.id);
    },

    async fingerprint(rootId: string): Promise<string> {
      const result = await pool.query(`${sourceRelationTreeSql}
        select md5(coalesce(string_agg(concat_ws('|', s.id::text, s.title, s.summary, s.metadata->>'summaryStale',
          d.id::text, d.content_hash, c.id::text, c.content_hash, c.chunking_version,c.source_span_id::text,
          summary.output_hash, summary.prompt_version, (summary.metadata->'concepts')::text), E'\\n' order by s.id, d.id,c.id), '')) as fingerprint
        from tree t join source_items s on s.id = t.id
        left join source_summaries summary on summary.source_item_id = s.id and summary.is_current
        left join documents d on d.source_item_id = s.id and ${currentDocument}
        left join chunks c on c.document_id = d.id where t.root_id = $1`, [rootId]);
      const vectors: string[] = [];
      for (const dimensions of [256,768,1024]) {
        const state = await pool.query(`${sourceRelationTreeSql}
          select md5(coalesce(string_agg(concat_ws('|',e.target_id::text,e.model,e.provider,e.runtime,e.strategy,e.content_hash),E'\\n' order by e.target_id,e.model),'')) as fingerprint
          from embeddings_${dimensions} e left join chunks c on e.target_type = 'chunk' and c.id = e.target_id
          join tree t on t.id = case when e.target_type = 'source_item' then e.target_id else c.source_item_id end
          where t.root_id = $1`,[rootId]);
        vectors.push(String(state.rows[0]?.fingerprint ?? ""));
      }
      return hash(JSON.stringify([result.rows[0]?.fingerprint,...vectors]));
    },

    async candidates(rootId: string, limit: number): Promise<SourceRelationCandidate[]> {
      const text = await pool.query(`${sourceRelationTreeSql}, units as (
        select t.root_id, s.id, s.title || ' ' || case when s.metadata->>'summaryStale' = 'true' then ''
          else coalesce(concept->>'idea',s.summary,'') end as content
        from tree t join source_items s on s.id = t.id
        left join source_summaries summary on summary.source_item_id = s.id and summary.is_current
        left join lateral jsonb_array_elements(coalesce(summary.metadata->'concepts','[]'::jsonb)) concept on true
        union all select t.root_id,c.source_item_id,c.content from chunks c join tree t on t.id = c.source_item_id
          join documents d on d.id = c.document_id where ${currentDocument} and ${processableChunk("c")}
      ) select b.root_id as id, max(similarity(a.content, b.content)) as score
        from units a join units b on b.root_id <> a.root_id where a.root_id = $1
        group by b.root_id having max(similarity(a.content, b.content)) >= 0.08 order by score desc, id limit $2`, [rootId, limit]);
      const notes = await pool.query(`${sourceRelationTreeSql}
        select case when ta.root_id = $1 then tb.root_id else ta.root_id end as id, max(n.final_score) as score
        from atomic_note_relations n join atomic_notes a on a.id = n.source_atomic_note_id
        join atomic_notes b on b.id = n.target_atomic_note_id join tree ta on ta.id = a.created_from_source_item_id
        join tree tb on tb.id = b.created_from_source_item_id
        where ta.root_id <> tb.root_id and $1 in (ta.root_id, tb.root_id) and n.status <> 'rejected'
          and not exists (select 1 from source_relation_evidence existing_evidence where existing_evidence.note_relation_id = n.id)
          and a.status not in ('rejected','archived') and b.status not in ('rejected','archived')
          and a.supersession_status = 'current' and b.supersession_status = 'current'
        group by 1 order by score desc, id limit $2`, [rootId, limit]);
      const graph = await pool.query(`${sourceRelationTreeSql}
        select tb.root_id as id, count(distinct a.entity_id)::float / (1 + count(*)) as score
        from entity_mentions a join tree ta on ta.id = a.source_item_id
        join entities entity on entity.id = a.entity_id and entity.type = 'Concept'
        join entity_mentions b on b.entity_id = a.entity_id join tree tb on tb.id = b.source_item_id
        where ta.root_id = $1 and tb.root_id <> $1 group by tb.root_id order by score desc, id limit $2`, [rootId, limit]);
      const vectors: QueryResultRow[] = [];
      for (const dimensions of [256, 768, 1024]) {
        const result = await pool.query(`${sourceRelationTreeSql}
          select neighbor.root_id as id, max(neighbor.score) as score
          from embeddings_${dimensions} a
          left join chunks ac on a.target_type = 'chunk' and ac.id = a.target_id
          left join documents ad on ad.id = ac.document_id
          join tree ta on ta.id = case when a.target_type = 'source_item' then a.target_id else ac.source_item_id end
          cross join lateral (
            select tb.root_id, 1 - (a.embedding <=> b.embedding) as score
            from embeddings_${dimensions} b
            left join chunks bc on b.target_type = 'chunk' and bc.id = b.target_id
            left join documents bd on bd.id = bc.document_id
            join tree tb on tb.id = case when b.target_type = 'source_item' then b.target_id else bc.source_item_id end
            where b.target_type = a.target_type and tb.root_id <> $1
              and (b.target_type = 'source_item' or (bc.content_hash = b.content_hash and bd.metadata->>'supersededByDocumentId' is null))
              and b.model = a.model and b.provider = a.provider and b.runtime = a.runtime and b.strategy = a.strategy
            order by b.embedding <=> a.embedding limit $2
          ) neighbor where ta.root_id = $1 and neighbor.score >= 0.4
            and ((a.target_type = 'source_item' and a.strategy like 'source-composite-centroid-v2:%')
              or (a.target_type = 'chunk' and a.strategy like 'native-v2:%' and ac.content_hash = a.content_hash and ad.metadata->>'supersededByDocumentId' is null))
          group by neighbor.root_id order by score desc, id limit $2`, [rootId, limit]);
        vectors.push(...result.rows);
      }
      const candidates = new Map<string, SourceRelationCandidate>();
      for (const [rows, kind] of [[text.rows, "textScore"], [vectors, "vectorScore"], [graph.rows, "graphScore"], [notes.rows, "noteScore"]] as const) {
        for (const row of rows) {
          const id = String(row.id), candidate = candidates.get(id) ?? { id, textScore: 0, vectorScore: 0, graphScore: 0, noteScore: 0 };
          candidate[kind] = Math.max(candidate[kind], Number(row.score)); candidates.set(id, candidate);
        }
      }
      return [...candidates.values()];
    },

    async pairNotes(left: string, right: string, limit = 16): Promise<SourceRelationNote[]> {
      // Legacy storage sorts UUIDs. Direction must come from the validated matching metadata.
      return (await pool.query<SourceRelationNote & QueryResultRow>(`${sourceRelationTreeSql}
        select n.id, n.relation_type as type, a.id as "sourceNoteId", b.id as "targetNoteId",
          a.idea_statement as "sourceIdea", b.idea_statement as "targetIdea",
          a.evidence_chunk_id as "sourceChunkId", b.evidence_chunk_id as "targetChunkId",
          a.created_from_source_item_id as "sourceItemId", b.created_from_source_item_id as "targetSourceItemId",
          ${noteFingerprint} as fingerprint
        from atomic_note_relations n
        join atomic_notes a on a.id::text = n.metadata->>'semanticSourceAtomicNoteId'
        join atomic_notes b on b.id::text = n.metadata->>'semanticTargetAtomicNoteId'
        join tree ta on ta.id = a.created_from_source_item_id join tree tb on tb.id = b.created_from_source_item_id
        join chunks ca on ca.id = a.evidence_chunk_id join documents da on da.id = ca.document_id
        join chunks cb on cb.id = b.evidence_chunk_id join documents db on db.id = cb.document_id
        where ((ta.root_id = $1 and tb.root_id = $2) or (ta.root_id = $2 and tb.root_id = $1))
          and not exists (select 1 from source_relation_evidence existing_evidence where existing_evidence.note_relation_id = n.id)
          and a.id in (n.source_atomic_note_id,n.target_atomic_note_id) and b.id in (n.source_atomic_note_id,n.target_atomic_note_id) and a.id <> b.id
          and ca.source_item_id = a.created_from_source_item_id and cb.source_item_id = b.created_from_source_item_id
          and n.status <> 'rejected' and a.status not in ('rejected','archived') and b.status not in ('rejected','archived')
          and a.supersession_status = 'current' and b.supersession_status = 'current'
          and da.metadata->>'supersededByDocumentId' is null and db.metadata->>'supersededByDocumentId' is null
        order by n.final_score desc, n.id limit $3`, [left, right, limit])).rows.map((note) =>
          ["contrasts","similar_to"].includes(note.type) && note.sourceItemId > note.targetSourceItemId ? {
            ...note,sourceItemId:note.targetSourceItemId,targetSourceItemId:note.sourceItemId,
            sourceNoteId:note.targetNoteId,targetNoteId:note.sourceNoteId,sourceChunkId:note.targetChunkId,targetChunkId:note.sourceChunkId,
            sourceIdea:note.targetIdea,targetIdea:note.sourceIdea
          } : note);
    },

    async pairChunks(left: string, right: string, noteChunkIds: string[], limit = 8): Promise<SourceRelationChunk[]> {
      const notes = noteChunkIds.length ? (await pool.query<SourceRelationChunk & QueryResultRow>(
        `${sourceRelationTreeSql} select ${chunkColumns},t.root_id as "rootId" from chunks c join source_items s on s.id = c.source_item_id
         join tree t on t.id = c.source_item_id join documents d on d.id = c.document_id
         where c.id = any($1::uuid[]) and ${currentDocument} and ${processableChunk("c")}`, [noteChunkIds])).rows : [];
      const result = await pool.query(`${sourceRelationTreeSql}, pairs as (
        select a.id as a, b.id as b, similarity(a.content, b.content) as score,
          row_number() over (partition by a.source_item_id, b.source_item_id order by similarity(a.content,b.content) desc, a.id, b.id) as position
        from chunks a join tree ta on ta.id = a.source_item_id join documents da on da.id = a.document_id
        join chunks b on b.source_item_id <> a.source_item_id join tree tb on tb.id = b.source_item_id
        join documents db on db.id = b.document_id
        where ta.root_id = $1 and tb.root_id = $2 and da.metadata->>'supersededByDocumentId' is null
          and db.metadata->>'supersededByDocumentId' is null and ${processableChunk("a")} and ${processableChunk("b")}
      ), selected as (select a,b from pairs order by position, score desc, a,b limit $3)
        select ${chunkColumns},t.root_id as "rootId" from chunks c join source_items s on s.id = c.source_item_id join tree t on t.id = c.source_item_id
        where c.id in (select a from selected union select b from selected) order by c.source_item_id,c.chunk_index`, [left, right, limit]);
      const semanticPairs: Array<{a:string;b:string;score:number}> = [];
      for (const dimensions of [256,768,1024]) {
        const vector = await pool.query(`${sourceRelationTreeSql}
          select a.id as a,b.id as b,1 - (av.embedding <=> bv.embedding) as score
          from chunks a join tree ta on ta.id = a.source_item_id join documents da on da.id = a.document_id
          join embeddings_${dimensions} av on av.target_id = a.id and av.target_type = 'chunk' and av.content_hash = a.content_hash
          join chunks b on b.source_item_id <> a.source_item_id join tree tb on tb.id = b.source_item_id join documents db on db.id = b.document_id
          join embeddings_${dimensions} bv on bv.target_id = b.id and bv.target_type = 'chunk' and bv.content_hash = b.content_hash
            and bv.provider = av.provider and bv.model = av.model and bv.runtime = av.runtime and bv.strategy = av.strategy
          where ta.root_id = $1 and tb.root_id = $2 and av.strategy like 'native-v2:%'
            and da.metadata->>'supersededByDocumentId' is null and db.metadata->>'supersededByDocumentId' is null
            and ${processableChunk("a")} and ${processableChunk("b")}
          order by av.embedding <=> bv.embedding,a.id,b.id limit $3`,[left,right,limit]);
        semanticPairs.push(...vector.rows as typeof semanticPairs);
      }
      const conceptPairs = await pool.query(`${sourceRelationTreeSql}, concepts as (
        select t.root_id,c.id,idea->>'idea' as idea from source_summaries summary
        join source_items s on s.id = summary.source_item_id and s.metadata->>'summaryStale' is distinct from 'true'
        join tree t on t.id = s.id cross join lateral jsonb_array_elements(coalesce(summary.metadata->'concepts','[]'::jsonb)) idea
        cross join lateral jsonb_array_elements_text(idea->'evidenceChunkIds') evidence
        join chunks c on c.id::text = evidence and c.source_item_id = s.id join documents d on d.id = c.document_id
        where summary.is_current and t.root_id in ($1,$2) and ${currentDocument}
      ) select a.id as a,b.id as b,similarity(a.idea,b.idea) as score from concepts a join concepts b on a.root_id <> b.root_id
        where a.root_id = $1 and b.root_id = $2 order by score desc,a.id,b.id limit $3`,[left,right,limit]);
      const rankedIds = [...new Set([...semanticPairs.sort((a,b) => b.score-a.score),...conceptPairs.rows].slice(0,limit).flatMap((pair) => [pair.a,pair.b]))];
      const semantic = rankedIds.length ? (await pool.query(`${sourceRelationTreeSql} select ${chunkColumns},t.root_id as "rootId"
        from chunks c join tree t on t.id = c.source_item_id join source_items s on s.id = c.source_item_id
        where c.id = any($1::uuid[]) order by array_position($1::uuid[],c.id)`,[rankedIds])).rows as SourceRelationChunk[] : [];
      // Interleave semantic and lexical evidence, retaining provenance and independently known note passages.
      const direct: SourceRelationChunk[] = [];
      for (let index=0; index < Math.max(result.rows.length,semantic.length);index++) {
        if (semantic[index]) direct.push(semantic[index]!);
        if (result.rows[index]) direct.push(result.rows[index] as SourceRelationChunk);
      }
      return [...new Map([...notes,...direct.slice(0,limit * 2)].map((chunk) => [chunk.id, chunk])).values()];
    },

    async existing(left: string, right: string) {
      return (await pool.query(`${sourceRelationTreeSql}
        select r.id, r.source_item_id as "sourceItemId", r.target_source_item_id as "targetSourceItemId", r.relation_type as "relationType",
          r.source_idea as "sourceIdea", r.target_idea as "targetIdea", r.status
        from source_relations r join tree a on a.id = r.source_item_id join tree b on b.id = r.target_source_item_id
        where (a.root_id = $1 and b.root_id = $2) or (a.root_id = $2 and b.root_id = $1)
        order by r.importance desc, r.id limit 100`, [left, right])).rows;
    },
    async decision(key: string): Promise<JsonObject | null> { return (await pool.query("select metadata from source_matching_decisions where key = $1", [key])).rows[0]?.metadata ?? null; },
    async runState(key: string): Promise<JsonObject | null> {
      return (await pool.query("select state from source_matching_runs where key = $1", [key])).rows[0]?.state ?? null;
    },
    async saveRun(key: string, rootId: string, state: JsonObject) {
      await pool.query(`insert into source_matching_runs (key,source_root_id,state) values ($1,$2,$3)
        on conflict (key) do update set state = excluded.state, updated_at = now()`, [key, rootId, state]);
    },
    async commitDecision(key: string, left: string, right: string, relations: SourceRelationWrite[], metadata: JsonObject) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [[left, right].sort().join(":")]);
        if ((await client.query("select 1 from source_matching_decisions where key = $1", [key])).rows.length) { await client.query("commit"); return 0; }
        for (const relation of relations) await persistRelation(client, relation, metadata);
        await client.query("insert into source_matching_decisions (key,source_root_id,target_root_id,metadata) values ($1,$2,$3,$4)", [key, left, right, {...metadata,persistedCount:relations.length}]);
        await client.query("commit"); return relations.length;
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    },
    async review(id: string, status: string, expectedUpdatedAt: string): Promise<boolean> {
      return (await pool.query(`update source_relations set status = $2::atomic_note_relation_status,
        metadata = metadata || jsonb_build_object('reviewedAt',now(),'previousStatus',status,'reviewHistory',
          coalesce(metadata->'reviewHistory','[]'::jsonb) || jsonb_build_array(jsonb_build_object('from',status,'to',$2::text,'at',now()))), updated_at = now()
        where id = $1 and date_trunc('milliseconds',updated_at) = $3::timestamptz returning id`, [id,status,expectedUpdatedAt])).rows.length > 0;
    }
  };
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
async function persistRelation(db: Queryable, relation: SourceRelationWrite, metadata: JsonObject) {
  const identity = hash(JSON.stringify([relation.sourceItemId,relation.targetSourceItemId,relation.relationType,
    relation.sourceIdea.toLowerCase().trim(),relation.targetIdea.toLowerCase().trim()]));
  let id = relation.existingId;
  if (id) {
    const current = await db.query("select id from source_relations where id = $1 and source_item_id = $2 and target_source_item_id = $3 and relation_type = $4",
      [id,relation.sourceItemId,relation.targetSourceItemId,relation.relationType]);
    if (!current.rows.length) throw new Error("errors.sourceRelations.invalidOutput");
  } else {
    const result = await db.query(`insert into source_relations (identity_key,source_item_id,target_source_item_id,relation_type,source_idea,target_idea,explanation,importance,confidence,metadata)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (identity_key) do update set identity_key = excluded.identity_key returning id`,
    [identity,relation.sourceItemId,relation.targetSourceItemId,relation.relationType,relation.sourceIdea,relation.targetIdea,relation.explanation,relation.importance,relation.confidence,metadata]);
    id = String(result.rows[0]!.id);
  }
  for (const { source, target, note } of relation.evidence) {
    const origin = note ? "atomic_notes" : "source_analysis";
    const snapshot = { sourceHash: source.contentHash, targetHash: target.contentHash,
      sourceId: source.id, targetId: target.id, sourceSpanId: source.sourceSpanId, targetSpanId: target.sourceSpanId,
      sourceExcerpt: source.content, targetExcerpt: target.content, noteFingerprint: note?.fingerprint ?? null };
    // Evidence owners and revisions are checked again inside the transaction.
    const valid = await db.query(`select c.id from chunks c join documents d on d.id = c.document_id
      where ((c.id = $1 and c.source_item_id = $2 and c.content_hash = $3) or (c.id = $4 and c.source_item_id = $5 and c.content_hash = $6)) and ${currentDocument}`,
    [source.id,relation.sourceItemId,source.contentHash,target.id,relation.targetSourceItemId,target.contentHash]);
    if (valid.rows.length !== 2) throw new Error("errors.sourceRelations.staleEvidence");
    await db.query(`insert into source_relation_evidence (relation_id,evidence_key,origin,source_chunk_id,target_chunk_id,note_relation_id,source_note_id,target_note_id,snapshot,metadata)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (relation_id,evidence_key) do nothing`,
    [id,hash(JSON.stringify([origin,source.id,source.contentHash,target.id,target.contentHash,note?.id,note?.fingerprint])),origin,source.id,target.id,note?.id ?? null,note?.sourceNoteId ?? null,note?.targetNoteId ?? null,snapshot,metadata]);
  }
}

export async function listSourceRelations(pool: PgPool, sourceId: string, targetId: string | null, offset = 0, limit = 30) {
  const result = await pool.query(`with recursive source_scope as (
      select id from source_items where id = $1 union all select child.id from source_items child join source_scope parent on child.parent_source_item_id = parent.id
    ), target_scope as (
      select id from source_items where id = $2 union all select child.id from source_items child join target_scope parent on child.parent_source_item_id = parent.id
    )
    select r.id, r.source_item_id as "sourceItemId", r.target_source_item_id as "targetSourceItemId",
      a.title as "sourceTitle", b.title as "targetTitle", r.relation_type as "relationType",
      r.source_idea as "sourceIdea", r.target_idea as "targetIdea", r.explanation,r.importance,r.confidence,r.status,
      ${currentSourceRelationSql} as current,r.updated_at as "updatedAt",count(*) over()::int as total
    from source_relations r join source_items a on a.id = r.source_item_id join source_items b on b.id = r.target_source_item_id
    where (r.source_item_id in (select id from source_scope) or r.target_source_item_id in (select id from source_scope))
      and ($2::uuid is null or (r.source_item_id in (select id from source_scope) and r.target_source_item_id in (select id from target_scope))
        or (r.target_source_item_id in (select id from source_scope) and r.source_item_id in (select id from target_scope)))
    order by (r.status = 'rejected'), r.importance desc,r.id limit $3 offset $4`, [sourceId,targetId,limit + 1,offset]);
  const rows = result.rows.slice(0,limit);
  const relations = [];
  for (const row of rows) {
    const evidence = await pool.query(`select e.id,e.origin,coalesce(e.source_chunk_id::text,e.snapshot->>'sourceId') as "sourceChunkId",
      coalesce(e.target_chunk_id::text,e.snapshot->>'targetId') as "targetChunkId",
      e.snapshot->>'sourceSpanId' as "sourceSpanId", e.snapshot->>'targetSpanId' as "targetSpanId",
      e.snapshot->>'sourceExcerpt' as "sourceExcerpt", e.snapshot->>'targetExcerpt' as "targetExcerpt",
      e.source_note_id as "sourceNoteId",e.target_note_id as "targetNoteId",e.note_relation_id as "noteRelationId",${currentEvidence} as current
      from source_relation_evidence e ${evidenceJoins} where e.relation_id = $1 order by current desc,e.created_at,e.id limit 100`, [row.id]);
    const { total: _total, ...value } = row;
    relations.push({ ...value, updatedAt: new Date(row.updatedAt).toISOString(), evidence: evidence.rows });
  }
  return { relations, hasMore: result.rows.length > limit, total: Number(result.rows[0]?.total ?? 0) };
}
