import type { QueryResultRow } from "pg";

import { firstRow, mapTimestamp } from "./sql.js";
import type { Queryable, StorageSettingsRecord } from "./types.js";

interface StorageSettingsRow extends QueryResultRow {
  id: string;
  obsidianVaultPath: string | null;
  obsidianManagedRoot: string;
  obsidianSyncEnabled: boolean;
  obsidianSyncPaused: boolean;
  deletePolicy: string;
  uploadCopyEnabled: boolean;
  uploadCopyBasePath: string | null;
  updatedAt: unknown;
}

export interface UpsertStorageSettingsInput {
  id?: string;
  obsidianVaultPath?: string | null;
  obsidianManagedRoot?: string;
  obsidianSyncEnabled?: boolean;
  obsidianSyncPaused?: boolean;
  deletePolicy?: string;
  uploadCopyEnabled?: boolean;
  uploadCopyBasePath?: string | null;
}

const returning = [
  "id",
  "obsidian_vault_path as \"obsidianVaultPath\"",
  "obsidian_managed_root as \"obsidianManagedRoot\"",
  "obsidian_sync_enabled as \"obsidianSyncEnabled\"",
  "obsidian_sync_paused as \"obsidianSyncPaused\"",
  "delete_policy as \"deletePolicy\"",
  "upload_copy_enabled as \"uploadCopyEnabled\"",
  "upload_copy_base_path as \"uploadCopyBasePath\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapStorageSettings(row: StorageSettingsRow): StorageSettingsRecord {
  return {
    id: row.id,
    obsidianVaultPath: row.obsidianVaultPath,
    obsidianManagedRoot: row.obsidianManagedRoot,
    obsidianSyncEnabled: row.obsidianSyncEnabled,
    obsidianSyncPaused: row.obsidianSyncPaused,
    deletePolicy: row.deletePolicy,
    uploadCopyEnabled: row.uploadCopyEnabled,
    uploadCopyBasePath: row.uploadCopyBasePath,
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createStorageSettingsRepository(db: Queryable) {
  return {
    async get(id = "default"): Promise<StorageSettingsRecord | null> {
      const result = await db.query<StorageSettingsRow>(`select ${returning} from storage_settings where id = $1`, [
        id
      ]);
      const row = firstRow(result.rows);
      return row ? mapStorageSettings(row) : null;
    },

    async upsert(input: UpsertStorageSettingsInput): Promise<StorageSettingsRecord> {
      const id = input.id ?? "default";
      const result = await db.query<StorageSettingsRow>(
        `insert into storage_settings (
           id,
           obsidian_vault_path,
           obsidian_managed_root,
           obsidian_sync_enabled,
           obsidian_sync_paused,
           delete_policy,
           upload_copy_enabled,
           upload_copy_base_path
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set
           obsidian_vault_path = excluded.obsidian_vault_path,
           obsidian_managed_root = excluded.obsidian_managed_root,
           obsidian_sync_enabled = excluded.obsidian_sync_enabled,
           obsidian_sync_paused = excluded.obsidian_sync_paused,
           delete_policy = excluded.delete_policy,
           upload_copy_enabled = excluded.upload_copy_enabled,
           upload_copy_base_path = excluded.upload_copy_base_path,
           updated_at = now()
         returning ${returning}`,
        [
          id,
          input.obsidianVaultPath ?? null,
          input.obsidianManagedRoot ?? "Memora",
          input.obsidianSyncEnabled ?? false,
          input.obsidianSyncPaused ?? false,
          input.deletePolicy ?? "tombstone",
          input.uploadCopyEnabled ?? false,
          input.uploadCopyBasePath ?? null
        ]
      );
      const row = firstRow(result.rows);
      if (!row) {
        throw new Error("Storage settings upsert did not return a row.");
      }
      return mapStorageSettings(row);
    }
  };
}
