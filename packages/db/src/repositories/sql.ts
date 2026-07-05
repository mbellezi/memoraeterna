import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

export interface ColumnMap {
  readonly [property: string]: string;
}

export function firstRow<T extends QueryResultRow>(rows: readonly T[]): T | null {
  return rows[0] ?? null;
}

export function mapTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  return new Date(String(value));
}

export function mapNullableTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return mapTimestamp(value);
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function insertRow<T extends QueryResultRow>(
  db: Queryable,
  tableName: string,
  values: Record<string, unknown>,
  returning: string
): Promise<T> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  const columns = entries.map(([column]) => `"${column}"`);
  const placeholders = entries.map((_, index) => `$${index + 1}`);
  const params = entries.map(([, value]) => value);
  const result = await db.query<T>(
    `insert into ${tableName} (${columns.join(", ")}) values (${placeholders.join(", ")}) returning ${returning}`,
    params
  );
  const row = firstRow(result.rows);
  if (!row) {
    throw new Error(`Insert into ${tableName} did not return a row.`);
  }
  return row;
}

export async function updateRow<T extends QueryResultRow>(
  db: Queryable,
  tableName: string,
  id: string,
  patch: Record<string, unknown>,
  returning: string
): Promise<T | null> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    const result = await db.query<T>(`select ${returning} from ${tableName} where id = $1`, [id]);
    return firstRow(result.rows);
  }

  const assignments = entries.map(([column], index) => `"${column}" = $${index + 2}`);
  assignments.push(`"updated_at" = now()`);
  const params = [id, ...entries.map(([, value]) => value)];
  const result = await db.query<T>(
    `update ${tableName} set ${assignments.join(", ")} where id = $1 returning ${returning}`,
    params
  );
  return firstRow(result.rows);
}

export async function findById<T extends QueryResultRow>(
  db: Queryable,
  tableName: string,
  id: string,
  returning: string
): Promise<T | null> {
  const result = await db.query<T>(`select ${returning} from ${tableName} where id = $1`, [id]);
  return firstRow(result.rows);
}

export async function listRows<T extends QueryResultRow>(
  db: Queryable,
  tableName: string,
  returning: string,
  limit = 100
): Promise<T[]> {
  const result = await db.query<T>(`select ${returning} from ${tableName} order by created_at desc limit $1`, [
    limit
  ]);
  return [...result.rows];
}
