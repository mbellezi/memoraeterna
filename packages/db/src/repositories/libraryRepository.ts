import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable, SourceItemType } from "./types.js";

export const librarySemanticCandidateFloor = 0.4;
export const librarySemanticStandaloneFloor = 0.48;

export function qualifiesLibrarySemanticMatch(embeddingScore: number, corroborated: boolean): boolean {
  return embeddingScore >= librarySemanticStandaloneFloor
    || (corroborated && embeddingScore >= librarySemanticCandidateFloor);
}

export interface LibrarySourceRecord {
  id: string;
  parentSourceItemId: string | null;
  parentTitle: string | null;
  structurePosition: number | null;
  childCount: number;
  hasDocument: boolean;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  sourceUri: string | null;
  language: string;
  summary: string | null;
  metadata: JsonObject;
  processingStatus: string;
  currentStage: string;
  updatedAt: Date;
  textScore: number | null;
  embeddingScore: number | null;
  graphScore: number | null;
  rankingScore: number | null;
  matchKind: "traditional" | "embedding" | "graph" | "combined" | null;
  matchExcerpt: string | null;
  matchLocation: string | null;
  embeddingNeedsRefresh: boolean;
}

interface LibrarySourceRow extends QueryResultRow {
  id: string;
  parentSourceItemId: string | null;
  parentTitle: string | null;
  structurePosition: number | null;
  childCount: number;
  hasDocument: boolean;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  sourceUri: string | null;
  language: string;
  summary: string | null;
  metadata: unknown;
  processingStatus: string;
  currentStage: string;
  updatedAt: unknown;
  textScore: number | null;
  embeddingScore: number | null;
  graphScore: number | null;
  rankingScore: number | null;
  matchKind: "traditional" | "embedding" | "graph" | "combined" | null;
  matchExcerpt: string | null;
  matchLocation: string | null;
  embeddingNeedsRefresh: boolean;
}

export function createLibraryRepository(db: Queryable) {
  return {
    async listSources(input: { sourceTypes?: SourceItemType[] | undefined; limit?: number | undefined; offset?: number | undefined; query?: string | undefined; parentId?: string | null | undefined; ids?: string[] | undefined; queryEmbedding?: number[] | undefined; embeddingModel?: string | undefined } = {}): Promise<LibrarySourceRecord[]> {
      const dimensions = input.queryEmbedding?.length;
      if (dimensions !== undefined && dimensions !== 256 && dimensions !== 768 && dimensions !== 1_024) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      if (input.queryEmbedding?.some((value) => !Number.isFinite(value))) {
        throw new Error("Embedding contains a non-finite value.");
      }
      const embeddingTable = `embeddings_${dimensions ?? 256}`;
      const queryVector = input.queryEmbedding ? `[${input.queryEmbedding.join(",")}]` : null;
      const result = await db.query<LibrarySourceRow>(
        `select source.id, source.parent_source_item_id as "parentSourceItemId",
                parent.title as "parentTitle",
                hierarchy.position as "structurePosition",
                (select count(*)::int from source_items child where child.parent_source_item_id = source.id) as "childCount",
                exists(select 1 from documents document where document.source_item_id = source.id) as "hasDocument",
                source.type, source.title, source.subtitle,
                source.source_uri as "sourceUri", source.language, source.summary,
                source.metadata, coalesce(run.status::text, 'pending') as "processingStatus",
                coalesce(run.current_stage, 'queued') as "currentStage",
                source.updated_at as "updatedAt",
                case when $3 = '' then null else scores.text_score end as "textScore",
                case when $3 = '' then null else scores.embedding_score end as "embeddingScore",
                case when $3 = '' then null else coalesce(graph_scores.graph_score, 0) end as "graphScore",
                case when $3 = '' then null else
                  greatest(scores.text_score, scores.embedding_score, coalesce(graph_scores.graph_score, 0))
                  + (
                    scores.text_score
                    + case when scores.embedding_score >= $11 then scores.embedding_score else 0 end
                    + coalesce(graph_scores.graph_score, 0)
                    - greatest(
                        scores.text_score,
                        case when scores.embedding_score >= $11 then scores.embedding_score else 0 end,
                        coalesce(graph_scores.graph_score, 0)
                      )
                  ) * 0.15 end as "rankingScore",
                case when $3 = '' then null
                  when (scores.text_score > 0)::int
                    + (scores.embedding_score >= $11)::int
                    + (coalesce(graph_scores.graph_score, 0) > 0)::int >= 2 then 'combined'
                  when coalesce(graph_scores.graph_score, 0) > 0 then 'graph'
                  when scores.embedding_score >= $11 then 'embedding'
                  else 'traditional' end as "matchKind"
                ,case when $3 = '' then null
                  when coalesce(graph_scores.graph_score, 0) > 0 then graph_scores.excerpt
                  when scores.embedding_score >= $11 then chunk_scores.best_excerpt
                  else null end as "matchExcerpt"
                ,case when $3 = '' then null
                  when coalesce(graph_scores.graph_score, 0) > 0 then graph_scores.location
                  when scores.embedding_score >= $11 then chunk_scores.best_location
                  else null end as "matchLocation"
                ,case when $8::vector is null then false
                  else source_embedding.id is null and chunk_scores.best_score is null end as "embeddingNeedsRefresh"
         from source_items source
         left join source_items parent on parent.id = source.parent_source_item_id
         left join ${embeddingTable} source_embedding
           on source_embedding.target_type = 'source_item' and source_embedding.target_id = source.id
             and source_embedding.model = $9 and $8::vector is not null
         left join lateral (
           select max(candidate.score) as best_score, avg(candidate.score) as top_average,
                  (array_agg(candidate.excerpt order by candidate.score desc))[1] as best_excerpt,
                  (array_agg(candidate.location order by candidate.score desc))[1] as best_location
           from (
             select greatest(0, 1 - (embedding.embedding <=> $8::vector)) as score,
                    chunk.content as excerpt, span.selector as location
             from ${embeddingTable} embedding
             join chunks chunk on chunk.id = embedding.target_id
             join documents document on document.id = chunk.document_id
             left join source_spans span on span.id = chunk.source_span_id
             where $8::vector is not null and embedding.target_type = 'chunk'
               and embedding.model = $9 and chunk.source_item_id = source.id
               and not (document.metadata ? 'supersededByDocumentId')
             order by embedding.embedding <=> $8::vector
             limit 3
           ) candidate
         ) chunk_scores on true
         left join lateral (
           select
             case when strpos(unaccent(lower(concat_ws(' ', source.title, source.subtitle, source.source_uri, source.metadata->'descriptor'))), unaccent(lower($3))) > 0
               then greatest(0.75, similarity(unaccent(lower(source.title)), unaccent(lower($3)))) else 0 end as text_score,
             case when chunk_scores.best_score is not null then
                 (chunk_scores.best_score * 0.7 + chunk_scores.top_average * 0.2
                   + coalesce(greatest(0, 1 - (source_embedding.embedding <=> $8::vector)), 0) * 0.1)
                 / case when source_embedding.id is null then 0.9 else 1 end
               when source_embedding.id is null then 0
               else greatest(0, 1 - (source_embedding.embedding <=> $8::vector)) end as embedding_score
         ) scores on true
         left join lateral (
           select candidate.score as graph_score, candidate.excerpt, candidate.location
           from (
             select entity.confidence::double precision as score, chunk.content as excerpt,
                    coalesce(span.selector, entity.canonical_name) as location
             from entities entity
             join entity_mentions mention on mention.entity_id = entity.id and mention.source_item_id = source.id
             join chunks chunk on chunk.id = mention.chunk_id
             left join source_spans span on span.id = chunk.source_span_id
             where unaccent(lower(entity.canonical_name)) = unaccent(lower($3))
                or exists(select 1 from jsonb_array_elements_text(entity.aliases) alias
                          where unaccent(lower(alias)) = unaccent(lower($3)))
             union all
             select relation.confidence::double precision as score, chunk.content as excerpt,
                    coalesce(span.selector, relation.predicate) as location
             from entity_relations relation
             join entities subject on subject.id = relation.subject_entity_id
             join entities object on object.id = relation.object_entity_id
             join chunks chunk on chunk.id = relation.evidence_chunk_id
             left join source_spans span on span.id = chunk.source_span_id
             where relation.source_item_id = source.id
               and (unaccent(lower(subject.canonical_name)) = unaccent(lower($3))
                 or unaccent(lower(object.canonical_name)) = unaccent(lower($3)))
           ) candidate
           order by candidate.score desc
           limit 1
         ) graph_scores on true
         left join lateral (
           select status, current_stage from ingestion_runs
           where source_item_id = source.id
           order by created_at desc limit 1
         ) run on true
         left join lateral (
           select division.position
           from document_divisions division
           join document_structures structure on structure.id = division.structure_id
           where division.child_source_item_id = source.id
             and structure.status = 'materialized'
           order by structure.revision desc
           limit 1
         ) hierarchy on true
         where (coalesce(array_length($1::source_item_type[], 1), 0) = 0 or source.type = any($1))
           and ($3 = '' or scores.text_score > 0 or coalesce(graph_scores.graph_score, 0) > 0
             or scores.embedding_score >= $10
             or (scores.embedding_score >= $11
               and (scores.text_score > 0 or coalesce(graph_scores.graph_score, 0) > 0)))
           and (not $4::boolean or source.parent_source_item_id is not distinct from $5::uuid)
           and ($7::uuid[] is null or source.id = any($7))
         order by case when $3 <> '' then
                    greatest(scores.text_score, scores.embedding_score, coalesce(graph_scores.graph_score, 0))
                    + (scores.text_score
                      + case when scores.embedding_score >= $11 then scores.embedding_score else 0 end
                      + coalesce(graph_scores.graph_score, 0)
                      - greatest(scores.text_score,
                          case when scores.embedding_score >= $11 then scores.embedding_score else 0 end,
                          coalesce(graph_scores.graph_score, 0))) * 0.15 end desc nulls last,
                  hierarchy.position nulls last, case when source.parent_source_item_id is not null then source.created_at end asc, source.updated_at desc, source.id
         limit $2 offset $6`,
        [input.sourceTypes ?? [], input.limit ?? 100, input.query ?? "", input.parentId !== undefined, input.parentId ?? null, input.offset ?? 0, input.ids ?? null, queryVector, input.embeddingModel ?? null, librarySemanticStandaloneFloor, librarySemanticCandidateFloor]
      );
      return result.rows.map((row) => ({
        ...row,
        metadata: asJsonObject(row.metadata),
        parentTitle: row.parentTitle ?? null,
        textScore: row.textScore == null ? null : Number(row.textScore),
        embeddingScore: row.embeddingScore == null ? null : Number(row.embeddingScore),
        graphScore: row.graphScore == null ? null : Number(row.graphScore),
        rankingScore: row.rankingScore == null ? null : Number(row.rankingScore),
        matchKind: row.matchKind ?? null,
        matchExcerpt: row.matchExcerpt ?? null,
        matchLocation: row.matchLocation ?? null,
        embeddingNeedsRefresh: Boolean(row.embeddingNeedsRefresh),
        updatedAt: mapTimestamp(row.updatedAt)
      }));
    }
  };
}
