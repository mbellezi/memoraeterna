import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable, SourceItemType } from "./types.js";

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
  rankingScore: number | null;
  matchKind: "traditional" | "embedding" | "combined" | null;
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
  rankingScore: number | null;
  matchKind: "traditional" | "embedding" | "combined" | null;
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
                case when $3 = '' then null else greatest(scores.text_score, scores.embedding_score)
                  + least(scores.text_score, scores.embedding_score) * 0.15 end as "rankingScore",
                case when $3 = '' then null
                  when scores.text_score > 0 and scores.embedding_score > 0
                    and abs(scores.text_score - scores.embedding_score) < 0.08 then 'combined'
                  when scores.embedding_score > scores.text_score then 'embedding'
                  else 'traditional' end as "matchKind"
         from source_items source
         left join source_items parent on parent.id = source.parent_source_item_id
         left join ${embeddingTable} source_embedding
           on source_embedding.target_type = 'source_item' and source_embedding.target_id = source.id
             and source_embedding.model = $9 and $8::vector is not null
         left join lateral (
           select
             case when strpos(unaccent(lower(concat_ws(' ', source.title, source.subtitle, source.source_uri, source.metadata->'descriptor'))), unaccent(lower($3))) > 0
               then greatest(0.75, similarity(unaccent(lower(source.title)), unaccent(lower($3)))) else 0 end as text_score,
             case when source_embedding.id is null then 0
               else greatest(0, 1 - (source_embedding.embedding <=> $8::vector)) end as embedding_score
         ) scores on true
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
           and ($3 = '' or scores.text_score > 0 or scores.embedding_score > 0)
           and (not $4::boolean or source.parent_source_item_id is not distinct from $5::uuid)
           and ($7::uuid[] is null or source.id = any($7))
         order by case when $3 <> '' then greatest(scores.text_score, scores.embedding_score)
                    + least(scores.text_score, scores.embedding_score) * 0.15 end desc nulls last,
                  hierarchy.position nulls last, case when source.parent_source_item_id is not null then source.created_at end asc, source.updated_at desc, source.id
         limit $2 offset $6`,
        [input.sourceTypes ?? [], input.limit ?? 100, input.query ?? "", input.parentId !== undefined, input.parentId ?? null, input.offset ?? 0, input.ids ?? null, queryVector, input.embeddingModel ?? null]
      );
      return result.rows.map((row) => ({
        ...row,
        metadata: asJsonObject(row.metadata),
        parentTitle: row.parentTitle ?? null,
        textScore: row.textScore == null ? null : Number(row.textScore),
        embeddingScore: row.embeddingScore == null ? null : Number(row.embeddingScore),
        rankingScore: row.rankingScore == null ? null : Number(row.rankingScore),
        matchKind: row.matchKind ?? null,
        updatedAt: mapTimestamp(row.updatedAt)
      }));
    }
  };
}
