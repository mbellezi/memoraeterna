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
}

export function createPgPool(config: PgPoolConfig): PgPool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000
  });
}

export function createDbClient(pool: PgPool) {
  return drizzle(pool, { schema });
}

export async function closePgPool(pool: PgPool): Promise<void> {
  await pool.end();
}
