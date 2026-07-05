import type { QueryResultRow } from "pg";

import { firstRow, mapTimestamp } from "./sql.js";
import type { Queryable, SettingRecord } from "./types.js";

interface SettingRow extends QueryResultRow {
  key: string;
  value: unknown;
  updatedAt: unknown;
}

const returning = ["key", "value", "updated_at as \"updatedAt\""].join(", ");

function mapSetting(row: SettingRow): SettingRecord {
  return {
    key: row.key,
    value: row.value,
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createSettingsRepository(db: Queryable) {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const result = await db.query<SettingRow>(`select ${returning} from settings where key = $1`, [key]);
      const row = firstRow(result.rows);
      return row ? (row.value as T) : null;
    },

    async set(key: string, value: unknown): Promise<SettingRecord> {
      const result = await db.query<SettingRow>(
        `insert into settings (key, value)
         values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()
         returning ${returning}`,
        [key, value]
      );
      const row = firstRow(result.rows);
      if (!row) {
        throw new Error("Setting upsert did not return a row.");
      }
      return mapSetting(row);
    },

    async delete(key: string): Promise<boolean> {
      const result = await db.query("delete from settings where key = $1", [key]);
      return (result.rowCount ?? 0) > 0;
    }
  };
}
