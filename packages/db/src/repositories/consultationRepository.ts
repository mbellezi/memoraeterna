import { retainedNoteCurrentSql } from "./noteEvidence.js";
import {
  currentSourceRelationEvidenceSql,
  sourceRelationEvidenceJoins
} from "./sourceRelationRepository.js";
import { inTopicChunks, inTopicNotes, topicScopeCtes } from "./topicScopeSql.js";
import type { PgPool } from "../client.js";

/**
 * The summary-concept signal, computed once per statement because it depends only on a chunk's
 * source: the concepts of the current, fresh summaries of the sources in scope; a concept is
 * grounded when every one of its evidence IDs, read as text, is the ID of a current chunk of a
 * source in scope; a source's signal is its best grounded concept. Asked per candidate chunk,
 * with the evidence check matching `chunks.id::text` (no index can serve it), the signal grew
 * with sources x chunks x concepts and its plan could flip into a scan of `chunks` per document
 * for every evidence ID: minutes per question at a hundred sources (the F3 24 h soak).
 */
const conceptRanksCtes = `concept_rows as materialized(
      select summary.id as summary_id,summary.source_item_id as id,concept.ord,concept.value as concept
      from source_summaries summary join source_items ss on ss.id=summary.source_item_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(summary.metadata->'concepts')='array' then summary.metadata->'concepts' else '[]'::jsonb end) with ordinality concept(value,ord)
      where not $3 and summary.source_item_id=any($1::uuid[]) and summary.is_current and ss.metadata->>'summaryStale' is distinct from 'true'
        and case when jsonb_typeof(concept.value->'evidenceChunkIds')='array' then jsonb_array_length(concept.value->'evidenceChunkIds')>0 else false end),
    scope_chunk_ids as materialized(
      select cc.id::text as id from chunks cc join documents dd on dd.id=cc.document_id
      where cc.source_item_id=any($1::uuid[]) and dd.metadata->>'supersededByDocumentId' is null),
    grounded_concepts as materialized(
      select r.summary_id,r.ord from concept_rows r cross join lateral jsonb_array_elements_text(r.concept->'evidenceChunkIds') cid(value)
      left join scope_chunk_ids hit on hit.id=cid.value
      group by r.summary_id,r.ord having bool_and(hit.id is not null)),
    concept_ranks as materialized(
      select r.id,max(ts_rank_cd(to_tsvector('simple',unaccent(r.concept->>'idea')),terms.q)) as rank
      from concept_rows r join grounded_concepts g on g.summary_id=r.summary_id and g.ord=r.ord cross join terms
      group by r.id)`;

/**
 * The source-relation signal, computed once per statement: the best-ranked current relation
 * between two sources in scope, for each chunk its evidence rests on (source or target side).
 */
const relationRanksCtes = `relation_ranks as materialized(
      select x.chunk_id as id,max(ts_rank_cd(to_tsvector('simple',unaccent(concat_ws(' ',r.source_idea,r.target_idea,r.explanation))),terms.q)) as rank
      from source_relations r join source_relation_evidence e on e.relation_id=r.id ${sourceRelationEvidenceJoins} cross join terms
      cross join lateral (values (e.source_chunk_id),(e.target_chunk_id)) x(chunk_id)
      where r.source_item_id=any($1::uuid[]) and r.target_source_item_id=any($1::uuid[]) and r.status<>'rejected' and (not $3 or r.status='accepted') and ${currentSourceRelationEvidenceSql}
      group by x.chunk_id)`;

/**
 * Original-passage retrieval for Ask: lexical candidates and compatible vector hits. With a topic,
 * only the passages of the topic's subtree are candidates (the sources alone are not enough: a
 * source may hold passages no note of the topic rests on).
 */
export function createConsultationRepository(pool: Pick<PgPool, "query">) {
  return {
    async candidates(
      sourceIds: string[],
      question: string,
      reviewedOnly: boolean,
      vectorIds: string[] = [],
      topicId: string | null = null
    ) {
      // OR lexemes preserve recall for natural questions; exact-title is a separate ranked signal.
      const rows = (
        await pool.query(
          `with recursive roots as(select id,id as root_id from source_items where parent_source_item_id is null union all select s.id,r.root_id from source_items s join roots r on s.parent_source_item_id=r.id),terms as(select to_tsquery('simple',coalesce(nullif(string_agg(quote_literal(word),' | '),''),'''__empty__''')) as q from (select distinct unnest(tsvector_to_array(to_tsvector('simple',unaccent($2)))) as word) words), ${topicScopeCtes("$5")}, ${conceptRanksCtes}, ${relationRanksCtes}, candidates as(
      select roots.root_id as "rootId",c.id as "chunkId",c.source_item_id as "sourceItemId",c.document_id as "documentId",c.source_span_id as "sourceSpanId",c.content_hash as "contentHash",c.content as excerpt,s.title as "sourceTitle",c.chunk_index as "chunkIndex",d.created_at as "documentCreatedAt",coalesce(sp.label,sp.selector,sp.page::text) as locator,
      ts_rank_cd(to_tsvector('simple',unaccent(c.content)),terms.q) as text,
      case when unaccent(lower(s.title))=unaccent(lower($2)) then 1 else ts_rank_cd(to_tsvector('simple',unaccent(s.title)),terms.q) end as title,
      case when $3 then 0 else coalesce(concept_ranks.rank,0) end as concept,
      coalesce((select max(ts_rank_cd(to_tsvector('simple',unaccent(n.idea_statement||' '||n.body_markdown)),terms.q)) from atomic_notes n where n.evidence_chunk_id=c.id and n.created_from_source_item_id=c.source_item_id and ${inTopicNotes("$5", "n.id")} and n.status not in('rejected','archived') and n.supersession_status='current' and ${retainedNoteCurrentSql()} and (not $3 or n.status='approved') and not exists(select 1 from atomic_note_source_links l left join chunks lc on lc.id=l.chunk_id left join documents ld on ld.id=lc.document_id where l.atomic_note_id=n.id and (lc.id is null or lc.source_item_id<>l.source_item_id or l.source_item_id<>all($1::uuid[]) or ld.metadata->>'supersededByDocumentId' is not null))),0) as note,
      case when $3 then 0 else coalesce((select max(ts_rank_cd(to_tsvector('simple',unaccent(e.canonical_name||' '||e.aliases::text)),terms.q)) from entity_mentions m join entities e on e.id=m.entity_id where m.chunk_id=c.id and m.source_item_id=c.source_item_id),0) end as entity,
      coalesce(relation_ranks.rank,0) as relation
      from chunks c join roots on roots.id=c.source_item_id join documents d on d.id=c.document_id join source_items s on s.id=c.source_item_id left join source_spans sp on sp.id=c.source_span_id cross join terms
      left join concept_ranks on concept_ranks.id=c.source_item_id left join relation_ranks on relation_ranks.id=c.id
      where c.source_item_id=any($1::uuid[]) and ${inTopicChunks("$5", "c.id")}
        and d.metadata->>'supersededByDocumentId' is null
        and c.metadata->>'processingMode' is distinct from 'catalog_metadata'
        and d.metadata->>'processingMode' is distinct from 'catalog_metadata'
        and c.chunking_version<>'catalog-metadata-v1')
      select *,count(*) over()::int as total from candidates where "chunkId"=any($4::uuid[]) or "chunkId" in(select "chunkId" from candidates order by greatest(text,title,concept,note,entity,relation) desc,"sourceTitle","chunkIndex","chunkId" limit 200) order by greatest(text,title,concept,note,entity,relation) desc,"sourceTitle","chunkIndex","chunkId"`,
          [sourceIds, question, reviewedOnly, vectorIds, topicId]
        )
      ).rows;
      return rows.map((r) => ({
        ...r,
        documentCreatedAt: new Date(r.documentCreatedAt).toISOString()
      }));
    },
    async vector(
      sourceIds: string[],
      vector: {
        embedding: number[];
        model: string;
        provider: string;
        runtime: string;
        spaceKey: string;
      },
      topicId: string | null = null
    ) {
      const dimensions = vector.embedding.length;
      if (![256, 768, 1024].includes(dimensions) || !vector.embedding.every(Number.isFinite))
        return [];
      return (
        await pool.query(
          `with recursive ${topicScopeCtes("$7")} select e.target_id as id,1-(e.embedding <=> $2::vector) as score from embeddings_${dimensions} e join chunks c on c.id=e.target_id join documents d on d.id=c.document_id
      join source_items s on s.id=c.source_item_id
      where e.target_type='chunk' and c.source_item_id=any($1::uuid[]) and ${inTopicChunks("$7", "c.id")} and e.model=$3 and e.provider=$4 and e.runtime=$5 and e.strategy=$6 and e.content_hash=c.content_hash and d.metadata->>'supersededByDocumentId' is null order by e.embedding <=> $2::vector,s.title,c.chunk_index,e.target_id limit 100`,
          [
            sourceIds,
            JSON.stringify(vector.embedding),
            vector.model,
            vector.provider,
            vector.runtime,
            `native-v2:${vector.spaceKey}`,
            topicId
          ]
        )
      ).rows;
    }
  };
}
