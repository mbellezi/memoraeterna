import type { QueryResultRow } from "pg";

import {
  asJsonObject,
  findById,
  insertRow,
  listRows,
  mapNullableTimestamp,
  mapTimestamp,
  updateRow
} from "./sql.js";
import type { JsonObject, ObsidianSyncFileRecord, ObsidianSyncStatus, Queryable } from "./types.js";

interface ObsidianSyncFileRow extends QueryResultRow {
  id: string;
  sourceItemId: string | null;
  documentId: string | null;
  memoraType: string;
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  syncVersion: number;
  status: ObsidianSyncStatus;
  lastSyncedAt: unknown;
  deletedAt: unknown;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateObsidianSyncFileInput {
  sourceItemId?: string | null;
  documentId?: string | null;
  memoraType: string;
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  syncVersion?: number;
  status?: ObsidianSyncStatus;
  lastSyncedAt?: Date | null;
  metadata?: JsonObject;
}

export interface UpdateObsidianSyncFileInput {
  sourceItemId?: string | null;
  documentId?: string | null;
  memoraType?: string;
  relativePath?: string;
  contentHash?: string;
  mtimeMs?: number;
  syncVersion?: number;
  status?: ObsidianSyncStatus;
  lastSyncedAt?: Date | null;
  deletedAt?: Date | null;
  metadata?: JsonObject;
}

const returning = [
  "id",
  "source_item_id as \"sourceItemId\"",
  "document_id as \"documentId\"",
  "memora_type as \"memoraType\"",
  "relative_path as \"relativePath\"",
  "content_hash as \"contentHash\"",
  "mtime_ms as \"mtimeMs\"",
  "sync_version as \"syncVersion\"",
  "status",
  "last_synced_at as \"lastSyncedAt\"",
  "deleted_at as \"deletedAt\"",
  "metadata",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapObsidianSyncFile(row: ObsidianSyncFileRow): ObsidianSyncFileRecord {
  return {
    id: row.id,
    sourceItemId: row.sourceItemId,
    documentId: row.documentId,
    memoraType: row.memoraType,
    relativePath: row.relativePath,
    contentHash: row.contentHash,
    mtimeMs: Number(row.mtimeMs),
    syncVersion: Number(row.syncVersion),
    status: row.status,
    lastSyncedAt: mapNullableTimestamp(row.lastSyncedAt),
    deletedAt: mapNullableTimestamp(row.deletedAt),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createObsidianSyncRepository(db: Queryable) {
  return {
    async create(input: CreateObsidianSyncFileInput): Promise<ObsidianSyncFileRecord> {
      const row = await insertRow<ObsidianSyncFileRow>(
        db,
        "obsidian_sync_files",
        {
          source_item_id: input.sourceItemId ?? null,
          document_id: input.documentId ?? null,
          memora_type: input.memoraType,
          relative_path: input.relativePath,
          content_hash: input.contentHash,
          mtime_ms: input.mtimeMs,
          sync_version: input.syncVersion ?? 1,
          status: input.status ?? "pending",
          last_synced_at: input.lastSyncedAt,
          metadata: input.metadata ?? {}
        },
        returning
      );
      return mapObsidianSyncFile(row);
    },

    async findById(id: string): Promise<ObsidianSyncFileRecord | null> {
      const row = await findById<ObsidianSyncFileRow>(db, "obsidian_sync_files", id, returning);
      return row ? mapObsidianSyncFile(row) : null;
    },

    async findByRelativePath(relativePath: string): Promise<ObsidianSyncFileRecord | null> {
      const result = await db.query<ObsidianSyncFileRow>(
        `select ${returning} from obsidian_sync_files where relative_path = $1`,
        [relativePath]
      );
      const row = result.rows[0] ?? null;
      return row ? mapObsidianSyncFile(row) : null;
    },

    async update(id: string, input: UpdateObsidianSyncFileInput): Promise<ObsidianSyncFileRecord | null> {
      const row = await updateRow<ObsidianSyncFileRow>(
        db,
        "obsidian_sync_files",
        id,
        {
          source_item_id: input.sourceItemId,
          document_id: input.documentId,
          memora_type: input.memoraType,
          relative_path: input.relativePath,
          content_hash: input.contentHash,
          mtime_ms: input.mtimeMs,
          sync_version: input.syncVersion,
          status: input.status,
          last_synced_at: input.lastSyncedAt,
          deleted_at: input.deletedAt,
          metadata: input.metadata
        },
        returning
      );
      return row ? mapObsidianSyncFile(row) : null;
    },

    async list(limit?: number): Promise<ObsidianSyncFileRecord[]> {
      const rows = await listRows<ObsidianSyncFileRow>(db, "obsidian_sync_files", returning, limit);
      return rows.map(mapObsidianSyncFile);
    }
  };
}
