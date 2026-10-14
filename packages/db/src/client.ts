import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;
export type DbClient = ReturnType<typeof createDbClient>;

export interface PgPoolConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  onError?: (error: Error) => void;
}

export function createPgPool(config: PgPoolConfig): PgPool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000
  });
  pool.on("error", (error) => config.onError?.(error));
  return pool;
}

export function createDbClient(pool: PgPool) {
  return drizzle(pool, { schema });
}

export async function closePgPool(pool: PgPool): Promise<void> {
  await pool.end();
}

/**
 * Runs `work` in one PostgreSQL transaction on a dedicated connection: commit when it resolves,
 * rollback when it throws (the original error is rethrown), and always release the connection.
 * Callers keep slow work (model inference, file copies) outside `work`.
 */
export async function withTransaction<T>(
  pool: PgPool,
  work: (client: PgClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
