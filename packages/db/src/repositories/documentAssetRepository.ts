import type { QueryResultRow } from "pg";

import { asJsonObject, findById, insertRow, listRows, mapTimestamp, updateRow } from "./sql.js";
import type { DocumentAssetRecord, JsonObject, Queryable } from "./types.js";

interface DocumentAssetRow extends QueryResultRow {
  id: string;
  documentId: string | null;
  sourceItemId: string | null;
  originalFileName: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  storageBase: string;
  relativePath: string;
  role: string;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateDocumentAssetInput {
  documentId?: string | null;
  sourceItemId?: string | null;
  originalFileName: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  storageBase: string;
  relativePath: string;
  role?: string;
  metadata?: JsonObject;
}

export interface UpdateDocumentAssetInput {
  documentId?: string | null;
  sourceItemId?: string | null;
  originalFileName?: string;
  sha256?: string;
  mimeType?: string;
  sizeBytes?: number;
  storageBase?: string;
  relativePath?: string;
  role?: string;
  metadata?: JsonObject;
}

const returning = [
  "id",
  "document_id as \"documentId\"",
  "source_item_id as \"sourceItemId\"",
  "original_file_name as \"originalFileName\"",
  "sha256",
  "mime_type as \"mimeType\"",
  "size_bytes as \"sizeBytes\"",
  "storage_base as \"storageBase\"",
  "relative_path as \"relativePath\"",
  "role",
  "metadata",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapDocumentAsset(row: DocumentAssetRow): DocumentAssetRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    sourceItemId: row.sourceItemId,
    originalFileName: row.originalFileName,
    sha256: row.sha256,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    storageBase: row.storageBase,
    relativePath: row.relativePath,
    role: row.role,
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createDocumentAssetRepository(db: Queryable) {
  return {
    async create(input: CreateDocumentAssetInput): Promise<DocumentAssetRecord> {
      const row = await insertRow<DocumentAssetRow>(
        db,
        "document_assets",
        {
          document_id: input.documentId ?? null,
          source_item_id: input.sourceItemId ?? null,
          original_file_name: input.originalFileName,
          sha256: input.sha256,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          storage_base: input.storageBase,
          relative_path: input.relativePath,
          role: input.role ?? "source",
          metadata: input.metadata ?? {}
        },
        returning
      );
      return mapDocumentAsset(row);
    },

    async findById(id: string): Promise<DocumentAssetRecord | null> {
      const row = await findById<DocumentAssetRow>(db, "document_assets", id, returning);
      return row ? mapDocumentAsset(row) : null;
    },

    async listByDocument(documentId: string): Promise<DocumentAssetRecord[]> {
      const result = await db.query<DocumentAssetRow>(
        `select ${returning} from document_assets where document_id = $1 order by created_at desc`,
        [documentId]
      );
      return result.rows.map(mapDocumentAsset);
    },

    async listBySourceItem(sourceItemId: string): Promise<DocumentAssetRecord[]> {
      const result = await db.query<DocumentAssetRow>(
        `select ${returning} from document_assets where source_item_id = $1 order by created_at desc`,
        [sourceItemId]
      );
      return result.rows.map(mapDocumentAsset);
    },

    async update(id: string, input: UpdateDocumentAssetInput): Promise<DocumentAssetRecord | null> {
      const row = await updateRow<DocumentAssetRow>(
        db,
        "document_assets",
        id,
        {
          document_id: input.documentId,
          source_item_id: input.sourceItemId,
          original_file_name: input.originalFileName,
          sha256: input.sha256,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          storage_base: input.storageBase,
          relative_path: input.relativePath,
          role: input.role,
          metadata: input.metadata
        },
        returning
      );
      return row ? mapDocumentAsset(row) : null;
    },

    async list(limit?: number): Promise<DocumentAssetRecord[]> {
      const rows = await listRows<DocumentAssetRow>(db, "document_assets", returning, limit);
      return rows.map(mapDocumentAsset);
    }
  };
}
