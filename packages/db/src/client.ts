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
