import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { ChunkRecord, JsonObject, Queryable, SourceSpanRecord } from "./types.js";

interface ChunkRow extends QueryResultRow {
  id: string;
  documentId: string;
  sourceItemId: string;
  sourceSpanId: string | null;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  contentHash: string;
  language: string;
  chunkingVersion: string;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface PersistedChunkInput {
  id: string;
  sourceSpanId: string;
  chunkIndex: number;
  content: string;
  tokenCount?: number | null;
  contentHash: string;
  language?: string;
  chunkingVersion?: string;
  metadata?: JsonObject;
  span: {
    id: string;
    startOffset: number;
    endOffset: number;
    page?: number | null;
    sourceBlockId?: string | null;
    boundingBox?: JsonObject | null;
    selector?: string | null;
    label?: string | null;
    metadata?: JsonObject;
  };
}

const chunkReturning = [
  "id",
  "document_id as \"documentId\"",
  "source_item_id as \"sourceItemId\"",
  "source_span_id as \"sourceSpanId\"",
  "chunk_index as \"chunkIndex\"",
  "content",
  "token_count as \"tokenCount\"",
  "content_hash as \"contentHash\"",
  "language",
  "chunking_version as \"chunkingVersion\"",
  "metadata",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapChunk(row: ChunkRow): ChunkRecord {
  return {
    ...row,
    chunkIndex: Number(row.chunkIndex),
    tokenCount: row.tokenCount === null ? null : Number(row.tokenCount),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createChunkRepository(db: Queryable) {
  return {
    async replaceDocumentChunks(
      documentId: string,
      sourceItemId: string,
      chunks: PersistedChunkInput[]
    ): Promise<ChunkRecord[]> {
      const payload = chunks.map((chunk) => ({
        id: chunk.id,
        sourceSpanId: chunk.sourceSpanId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount ?? null,
        contentHash: chunk.contentHash,
        language: chunk.language ?? "und",
        chunkingVersion: chunk.chunkingVersion ?? "markdown-v1",
        metadata: chunk.metadata ?? {},
        spanId: chunk.span.id,
        startOffset: chunk.span.startOffset,
        endOffset: chunk.span.endOffset,
        page: chunk.span.page ?? null,
        sourceBlockId: chunk.span.sourceBlockId ?? null,
        boundingBox: chunk.span.boundingBox ?? null,
        selector: chunk.span.selector ?? null,
        label: chunk.span.label ?? null,
        spanMetadata: chunk.span.metadata ?? {}
      }));
      const connection = await acquireConnection(db);
      try {
        await connection.query("begin");
        await connection.query("delete from chunks where document_id = $1", [documentId]);
        await connection.query("delete from source_spans where document_id = $1", [documentId]);
        await connection.query(
          `insert into source_spans (
             id, document_id, source_item_id, start_offset, end_offset, page,
             source_block_id, bounding_box, selector, label, metadata
           )
           select "spanId", $1, $2, "startOffset", "endOffset", page,
                  "sourceBlockId", "boundingBox", selector, label, "spanMetadata"
           from jsonb_to_recordset($3::jsonb) as x(
             "spanId" uuid, "startOffset" integer, "endOffset" integer, page integer,
             "sourceBlockId" text, "boundingBox" jsonb, selector text,
             label text, "spanMetadata" jsonb
           )`,
          [documentId, sourceItemId, JSON.stringify(payload)]
        );
        const result = await connection.query<ChunkRow>(
          `insert into chunks (
             id, document_id, source_item_id, source_span_id, chunk_index, content,
             token_count, content_hash, language, chunking_version, metadata
           )
           select id, $1, $2, "sourceSpanId", "chunkIndex", content,
                  "tokenCount", "contentHash", language, "chunkingVersion", metadata
           from jsonb_to_recordset($3::jsonb) as x(
             id uuid, "sourceSpanId" uuid, "chunkIndex" integer, content text,
             "tokenCount" integer, "contentHash" text, language text,
             "chunkingVersion" text, metadata jsonb
           )
           returning ${chunkReturning}`,
          [documentId, sourceItemId, JSON.stringify(payload)]
        );
        await connection.query("commit");
        return result.rows.map(mapChunk).sort((left, right) => left.chunkIndex - right.chunkIndex);
      } catch (error) {
        await connection.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        connection.release?.();
      }
    },

    async listByDocument(documentId: string): Promise<ChunkRecord[]> {
      const result = await db.query<ChunkRow>(
        `select ${chunkReturning} from chunks where document_id = $1 order by chunk_index`,
        [documentId]
      );
      return result.rows.map(mapChunk);
    },

    async listSpansByDocument(documentId: string): Promise<SourceSpanRecord[]> {
      const result = await db.query<QueryResultRow & Record<string, unknown>>(
        `select id, document_id as "documentId", source_item_id as "sourceItemId",
                start_offset as "startOffset", end_offset as "endOffset", page,
                source_block_id as "sourceBlockId", bounding_box as "boundingBox",
                selector, label, metadata, created_at as "createdAt", updated_at as "updatedAt"
         from source_spans where document_id = $1 order by start_offset`,
        [documentId]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        documentId: String(row.documentId),
        sourceItemId: String(row.sourceItemId),
        startOffset: Number(row.startOffset),
        endOffset: Number(row.endOffset),
        page: row.page === null ? null : Number(row.page),
        sourceBlockId: row.sourceBlockId === null ? null : String(row.sourceBlockId),
        boundingBox: row.boundingBox === null ? null : asJsonObject(row.boundingBox),
        selector: row.selector === null ? null : String(row.selector),
        label: row.label === null ? null : String(row.label),
        metadata: asJsonObject(row.metadata),
        createdAt: mapTimestamp(row.createdAt),
        updatedAt: mapTimestamp(row.updatedAt)
      }));
    }
  };
}

interface RepositoryConnection extends Queryable {
  release?: () => void;
}

async function acquireConnection(db: Queryable): Promise<RepositoryConnection> {
  if ("connect" in db && typeof db.connect === "function") {
    return await (db.connect as () => Promise<RepositoryConnection>)();
  }
  return db;
}
