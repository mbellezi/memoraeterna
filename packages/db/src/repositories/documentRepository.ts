import type { QueryResultRow } from "pg";

import { asJsonObject, findById, insertRow, listRows, mapTimestamp, updateRow } from "./sql.js";
import type { DocumentRecord, JsonObject, Queryable } from "./types.js";

interface DocumentRow extends QueryResultRow {
  id: string;
  sourceItemId: string;
  title: string;
  canonicalMarkdown: string;
  contentHash: string;
  language: string;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateDocumentInput {
  sourceItemId: string;
  title: string;
  canonicalMarkdown: string;
  contentHash: string;
  language?: string;
  metadata?: JsonObject;
}

export interface UpdateDocumentInput {
  title?: string;
  canonicalMarkdown?: string;
  contentHash?: string;
  language?: string;
  metadata?: JsonObject;
}

const returning = [
  "id",
  "source_item_id as \"sourceItemId\"",
  "title",
  "canonical_markdown as \"canonicalMarkdown\"",
  "content_hash as \"contentHash\"",
  "language",
  "metadata",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    sourceItemId: row.sourceItemId,
    title: row.title,
    canonicalMarkdown: row.canonicalMarkdown,
    contentHash: row.contentHash,
    language: row.language,
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createDocumentRepository(db: Queryable) {
  return {
    async create(input: CreateDocumentInput): Promise<DocumentRecord> {
      const row = await insertRow<DocumentRow>(
        db,
        "documents",
        {
          source_item_id: input.sourceItemId,
          title: input.title,
          canonical_markdown: input.canonicalMarkdown,
          content_hash: input.contentHash,
          language: input.language ?? "und",
          metadata: input.metadata ?? {}
        },
        returning
      );
      return mapDocument(row);
    },

    async findById(id: string): Promise<DocumentRecord | null> {
      const row = await findById<DocumentRow>(db, "documents", id, returning);
      return row ? mapDocument(row) : null;
    },

    async listBySourceItem(sourceItemId: string): Promise<DocumentRecord[]> {
      const result = await db.query<DocumentRow>(
        `select ${returning} from documents where source_item_id = $1 order by created_at desc`,
        [sourceItemId]
      );
      return result.rows.map(mapDocument);
    },

    async update(id: string, input: UpdateDocumentInput): Promise<DocumentRecord | null> {
      const row = await updateRow<DocumentRow>(
        db,
        "documents",
        id,
        {
          title: input.title,
          canonical_markdown: input.canonicalMarkdown,
          content_hash: input.contentHash,
          language: input.language,
          metadata: input.metadata
        },
        returning
      );
      return row ? mapDocument(row) : null;
    },

    async list(limit?: number): Promise<DocumentRecord[]> {
      const rows = await listRows<DocumentRow>(db, "documents", returning, limit);
      return rows.map(mapDocument);
    }
  };
}
