import type { QueryResultRow } from "pg";

import { asJsonObject } from "./sql.js";
import type { Queryable, SearchEvidenceRecord, SourceItemType } from "./types.js";

interface SearchRow extends QueryResultRow {
  sourceItemId: string;
  sourceTitle: string;
  sourceType: SourceItemType;
  documentId: string;
  chunkId: string;
  sourceSpanId: string | null;
  excerpt: string;
  page: number | null;
  sourceBlockId: string | null;
  boundingBox: unknown;
  selector: string | null;
  textScore: number;
  vectorScore: number;
  finalScore: number;
}

export interface HybridSearchInput {
  text: string;
  sourceTypes?: SourceItemType[];
  embedding?: number[];
  embeddingModel?: string;
  limit?: number;
}

function mapSearchRow(row: SearchRow): SearchEvidenceRecord {
  return {
    ...row,
    page: row.page === null ? null : Number(row.page),
    boundingBox: row.boundingBox === null ? null : asJsonObject(row.boundingBox),
    textScore: Number(row.textScore),
    vectorScore: Number(row.vectorScore),
    finalScore: Number(row.finalScore)
  };
}

export function createSearchRepository(db: Queryable) {
  return {
    async search(input: HybridSearchInput): Promise<SearchEvidenceRecord[]> {
      const dimensions = input.embedding?.length;
      if (dimensions !== undefined && dimensions !== 256 && dimensions !== 768) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      const embeddingJoin = dimensions
        ? `left join embeddings_${dimensions} e on e.chunk_id = c.id and ($4::text is null or e.model = $4)`
        : "";
      const vectorExpression = dimensions
        ? "coalesce(greatest(0, 1 - (e.embedding <=> $3::vector)), 0)"
        : "0::double precision";
      const result = await db.query<SearchRow>(
        `with scored as (
           select s.id as "sourceItemId", s.title as "sourceTitle", s.type as "sourceType",
                  d.id as "documentId", c.id as "chunkId", c.source_span_id as "sourceSpanId",
                  c.content as excerpt, sp.page, sp.source_block_id as "sourceBlockId",
                  sp.bounding_box as "boundingBox", sp.selector,
                  least(1, greatest(
                    ts_rank_cd(to_tsvector('simple', unaccent(c.content)),
                               plainto_tsquery('simple', unaccent($1))),
                    similarity(unaccent(c.content), unaccent($1))
                  )) as "textScore",
                  ${vectorExpression} as "vectorScore"
           from chunks c
           join documents d on d.id = c.document_id
           join source_items s on s.id = c.source_item_id
           left join source_spans sp on sp.id = c.source_span_id
           ${embeddingJoin}
           where (coalesce(array_length($2::source_item_type[], 1), 0) = 0 or s.type = any($2))
         )
         select *, least(1, ("textScore" * 0.55) + ("vectorScore" * 0.45)) as "finalScore"
         from scored
         where "textScore" > 0 or "vectorScore" > 0
         order by "finalScore" desc, "textScore" desc
         limit ${dimensions ? "$5" : "$3"}`,
        dimensions
          ? [
              input.text,
              input.sourceTypes ?? [],
              `[${input.embedding?.join(",")}]`,
              input.embeddingModel ?? null,
              input.limit ?? 20
            ]
          : [input.text, input.sourceTypes ?? [], input.limit ?? 20]
      );
      return result.rows.map(mapSearchRow);
    }
  };
}
