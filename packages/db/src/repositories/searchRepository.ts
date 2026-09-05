import type { QueryResultRow } from "pg";

import { asJsonObject } from "./sql.js";
import type { AtomicNoteSearchRecord, Queryable, SearchEvidenceRecord, SourceItemType } from "./types.js";

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
}

interface NoteSearchRow extends QueryResultRow {
  noteId: string;
  sourceItemId: string;
  sourceTitle: string;
  sourceType: SourceItemType;
  title: string;
  ideaStatement: string;
  excerpt: string;
  status: AtomicNoteSearchRecord["status"];
  textScore: number;
  vectorScore: number;
}

export interface TextSearchInput {
  text: string;
  sourceTypes?: SourceItemType[];
  sourceItemIds?: string[];
  limit?: number;
}

export interface VectorSearchInput {
  embedding: number[];
  embeddingModel: string;
  sourceTypes?: SourceItemType[];
  sourceItemIds?: string[];
  limit?: number;
}

function mapSearchRow(row: SearchRow, finalScore: number): SearchEvidenceRecord {
  return {
    ...row,
    page: row.page === null ? null : Number(row.page),
    boundingBox: row.boundingBox === null ? null : asJsonObject(row.boundingBox),
    textScore: Number(row.textScore),
    vectorScore: Number(row.vectorScore),
    graphScore: 0,
    finalScore
  };
}

const evidenceColumns = `s.id as "sourceItemId", s.title as "sourceTitle", s.type as "sourceType",
  d.id as "documentId", c.id as "chunkId", c.source_span_id as "sourceSpanId",
  c.content as excerpt, sp.page, sp.source_block_id as "sourceBlockId",
  sp.bounding_box as "boundingBox", sp.selector`;

const noteColumns = `n.id as "noteId", s.id as "sourceItemId", s.title as "sourceTitle",
  s.type as "sourceType", n.title, n.idea_statement as "ideaStatement",
  n.body_markdown as excerpt, n.status`;

function mapNoteSearchRow(row: NoteSearchRow, finalScore: number): AtomicNoteSearchRecord {
  return {
    ...row,
    textScore: Number(row.textScore),
    vectorScore: Number(row.vectorScore),
    graphScore: 0,
    finalScore
  };
}

export function createSearchRepository(db: Queryable) {
  return {
    async searchText(input: TextSearchInput): Promise<SearchEvidenceRecord[]> {
      const result = await db.query<SearchRow>(
        `with scored as (
           select ${evidenceColumns},
                  least(1, greatest(
                    ts_rank_cd(to_tsvector('simple', unaccent(c.content)),
                               plainto_tsquery('simple', unaccent($1))),
                    similarity(unaccent(c.content), unaccent($1))
                  )) as "textScore",
                  0::double precision as "vectorScore"
           from chunks c
           join documents d on d.id = c.document_id
           join source_items s on s.id = c.source_item_id
           left join source_spans sp on sp.id = c.source_span_id
           where not (d.metadata ? 'supersededByDocumentId') and (coalesce(array_length($2::source_item_type[], 1), 0) = 0 or s.type = any($2))
             and (coalesce(array_length($4::uuid[], 1), 0) = 0 or s.id = any($4))
         )
         select * from scored where "textScore" > 0
         order by "textScore" desc, "chunkId"
         limit $3`,
        [input.text, input.sourceTypes ?? [], input.limit ?? 20, input.sourceItemIds ?? []]
      );
      return result.rows.map((row) => mapSearchRow(row, Number(row.textScore)));
    },

    async searchVector(input: VectorSearchInput): Promise<SearchEvidenceRecord[]> {
      const dimensions = input.embedding.length;
      if (dimensions !== 256 && dimensions !== 768 && dimensions !== 1_024) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      const result = await db.query<SearchRow>(
        `select ${evidenceColumns},
                0::double precision as "textScore",
                greatest(0, 1 - (e.embedding <=> $1::vector)) as "vectorScore"
         from embeddings_${dimensions} e
         join chunks c on c.id = e.chunk_id
         join documents d on d.id = c.document_id
         join source_items s on s.id = c.source_item_id
         left join source_spans sp on sp.id = c.source_span_id
         where not (d.metadata ? 'supersededByDocumentId') and e.target_type = 'chunk' and e.model = $2
           and (coalesce(array_length($3::source_item_type[], 1), 0) = 0 or s.type = any($3))
           and (coalesce(array_length($5::uuid[], 1), 0) = 0 or s.id = any($5))
         order by e.embedding <=> $1::vector
         limit $4`,
        [`[${input.embedding.join(",")}]`, input.embeddingModel, input.sourceTypes ?? [], input.limit ?? 20, input.sourceItemIds ?? []]
      );
      return result.rows.map((row) => mapSearchRow(row, Number(row.vectorScore)));
    },

    async searchNotesText(input: TextSearchInput): Promise<AtomicNoteSearchRecord[]> {
      const result = await db.query<NoteSearchRow>(
        `with scored as (
           select ${noteColumns},
                  least(1, greatest(
                    ts_rank_cd(to_tsvector('simple', unaccent(n.title || ' ' || n.idea_statement || ' ' || n.body_markdown)),
                               plainto_tsquery('simple', unaccent($1))),
                    similarity(unaccent(n.title), unaccent($1)),
                    similarity(unaccent(n.idea_statement), unaccent($1))
                  )) as "textScore",
                  0::double precision as "vectorScore"
           from atomic_notes n
           join source_items s on s.id = n.created_from_source_item_id
           where n.status <> 'rejected'
             and (coalesce(array_length($2::source_item_type[], 1), 0) = 0 or s.type = any($2))
             and (coalesce(array_length($4::uuid[], 1), 0) = 0 or s.id = any($4))
         )
         select * from scored where "textScore" > 0
         order by "textScore" desc, "noteId"
         limit $3`,
        [input.text, input.sourceTypes ?? [], input.limit ?? 20, input.sourceItemIds ?? []]
      );
      return result.rows.map((row) => mapNoteSearchRow(row, Number(row.textScore)));
    },

    async searchNotesVector(input: VectorSearchInput): Promise<AtomicNoteSearchRecord[]> {
      const dimensions = input.embedding.length;
      if (dimensions !== 256 && dimensions !== 768 && dimensions !== 1_024) {
        throw new Error(`Unsupported embedding dimension: ${dimensions}`);
      }
      const result = await db.query<NoteSearchRow>(
        `select ${noteColumns},
                0::double precision as "textScore",
                greatest(0, 1 - (e.embedding <=> $1::vector)) as "vectorScore"
         from embeddings_${dimensions} e
         join atomic_notes n on n.id = e.target_id
         join source_items s on s.id = n.created_from_source_item_id
         where e.target_type = 'atomic_note' and e.model = $2
           and n.status <> 'rejected'
           and (coalesce(array_length($3::source_item_type[], 1), 0) = 0 or s.type = any($3))
           and (coalesce(array_length($5::uuid[], 1), 0) = 0 or s.id = any($5))
         order by e.embedding <=> $1::vector
         limit $4`,
        [`[${input.embedding.join(",")}]`, input.embeddingModel, input.sourceTypes ?? [], input.limit ?? 20, input.sourceItemIds ?? []]
      );
      return result.rows.map((row) => mapNoteSearchRow(row, Number(row.vectorScore)));
    }
  };
}
