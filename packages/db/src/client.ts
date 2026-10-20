import { drizzle } from "drizzle-orm/node-postgres";
import pg, { type QueryResult } from "pg";

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

/** A statement stopped because the time its caller allowed had run out. */
export class StatementBudgetError extends Error {
  public constructor(options?: ErrorOptions) {
    super("The statement was stopped: its caller's time budget ran out.", options);
    this.name = "StatementBudgetError";
  }
}

/** SQLSTATE `query_canceled`, which PostgreSQL raises when `statement_timeout` stops a statement. */
const queryCanceled = "57014";

/**
 * Statements bounded by what their caller still has of a time budget. Each runs in its own short
 * transaction whose `statement_timeout` is `remainingMs()` when it starts, so a slow statement stops
 * at the caller's deadline instead of running on past it; it then rejects with
 * {@link StatementBudgetError}. No statement starts once the budget is spent or `signal` ended, and
 * each commits before the next begins, so no transaction outlives its statement.
 */
export function budgetedQueries(
  pool: PgPool,
  remainingMs: () => number,
  signal?: AbortSignal
): Pick<PgPool, "query"> {
  const budget = () => {
    signal?.throwIfAborted();
    const ms = Math.floor(remainingMs());
    if (!(ms >= 1)) throw new StatementBudgetError();
    return ms;
  };
  const query = async (text: string, values?: unknown[]): Promise<QueryResult> => {
    budget();
    const client = await pool.connect();
    try {
      // Read again once connected: the wait for a pooled connection used some of it.
      await client.query(`begin; set local statement_timeout = ${budget()}`);
      const result = await client.query(text, values);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: unknown }).code === queryCanceled)
        throw new StatementBudgetError({ cause: error });
      throw error;
    } finally {
      client.release();
    }
  };
  // The text-and-values form is the only one offered: repositories use no other.
  return { query: query as unknown as PgPool["query"] };
}
