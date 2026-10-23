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

/**
 * SQLSTATE `query_canceled`, which PostgreSQL raises when a statement stops because `statement_timeout`
 * ran out or because a backend was asked to cancel it (`pg_cancel_backend`).
 */
const queryCanceled = "57014";

/** A request id is a plain token, so a marker built from it can never close its own comment. */
const requestIdPattern = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The comment an Ask's statements start with. `pg_stat_activity` shows the first bytes of the
 * statement a backend runs, so a cancel finds the request's own statement by this marker and never
 * a statement that a recycled pooled connection runs for someone else.
 */
function statementMarker(requestId: string): string {
  if (!requestIdPattern.test(requestId))
    throw new TypeError("A statement marker takes a request id of letters, digits and hyphens.");
  return `/* ask:${requestId} */`;
}

/** Statements in flight in this process per request id: a cancel repeats until they have ended. */
const inFlight = new Map<string, number>();

function trackStatement(requestId: string): () => void {
  inFlight.set(requestId, (inFlight.get(requestId) ?? 0) + 1);
  let tracked = true;
  return () => {
    if (!tracked) return;
    tracked = false;
    const left = (inFlight.get(requestId) ?? 1) - 1;
    if (left > 0) inFlight.set(requestId, left);
    else inFlight.delete(requestId);
  };
}

/** What a request that asked for a marker passes: its id, which the marker carries. */
export interface BudgetedQueriesOptions {
  /** Marks every statement with this request id so {@link StatementCanceler} can stop it. */
  requestId?: string;
}

/**
 * Statements bounded by what their caller still has of a time budget. Each runs in its own short
 * transaction whose `statement_timeout` is `remainingMs()` when it starts, so a slow statement stops
 * at the caller's deadline instead of running on past it; it then rejects with
 * {@link StatementBudgetError}. No statement starts once the budget is spent or `signal` ended, and
 * each commits before the next begins, so no transaction outlives its statement.
 *
 * A statement that PostgreSQL stopped while `signal` had ended was stopped on request (a
 * {@link StatementCanceler}, or the deadline that ended `signal`): it rejects with the signal's
 * reason, never as an out-of-budget statement, so a cancel is not reported as a timeout.
 */
export function budgetedQueries(
  pool: PgPool,
  remainingMs: () => number,
  signal?: AbortSignal,
  options: BudgetedQueriesOptions = {}
): Pick<PgPool, "query"> {
  const marker = options.requestId === undefined ? null : statementMarker(options.requestId);
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
      // A cancel that came while the transaction began found no statement to stop: none starts.
      signal?.throwIfAborted();
      const ended = marker === null ? null : trackStatement(options.requestId!);
      let result: QueryResult;
      try {
        result = await client.query(marker === null ? text : `${marker} ${text}`, values);
      } finally {
        ended?.();
      }
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: unknown }).code === queryCanceled) {
        signal?.throwIfAborted();
        throw new StatementBudgetError({ cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  };
  // The text-and-values form is the only one offered: repositories use no other.
  return { query: query as unknown as PgPool["query"] };
}

/** Stops the statements of a request on a connection of its own. */
export interface StatementCanceler {
  /**
   * Cancels the statement the request has running, repeating briefly while one is still in flight
   * (it may not have reached the server yet). Resolves with how many backends were signalled; a
   * request with no statement in flight costs no database round trip.
   */
  cancelActive(requestId: string): Promise<number>;
  close(): Promise<void>;
}

/** Looks only at active backends of this database whose statement starts with the marker. */
const cancelByMarker = `select pg_cancel_backend(pid) as canceled from pg_stat_activity
  where datname = current_database() and pid <> pg_backend_pid() and state = 'active'
    and starts_with(query, $1)`;
const cancelPasses = 20;
const cancelRepeatMs = 25;

/**
 * A canceler for the statements `budgetedQueries` runs on `pool`. It asks from a control pool of one
 * connection, built on first use from the pool's own connection string and released when idle, so a
 * pool that is full of the slow statements being cancelled cannot delay the cancel.
 */
export function createStatementCanceler(pool: PgPool): StatementCanceler {
  let control: PgPool | undefined;
  const run = (text: string, values: unknown[]) => {
    const connectionString = pool.options?.connectionString;
    if (!connectionString) return pool.query(text, values);
    control ??= createPgPool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 2_000,
      connectionTimeoutMillis: 2_000
    });
    return control.query(text, values);
  };
  return {
    async cancelActive(requestId) {
      const marker = statementMarker(requestId);
      let signalled = 0;
      for (let pass = 0; pass < cancelPasses && inFlight.has(requestId); pass++) {
        const { rows } = await run(cancelByMarker, [marker]);
        signalled += rows.filter((row) => (row as { canceled?: unknown }).canceled === true).length;
        if (inFlight.has(requestId))
          await new Promise((resolve) => setTimeout(resolve, cancelRepeatMs));
      }
      return signalled;
    },
    async close() {
      const closing = control;
      control = undefined;
      await closing?.end();
    }
  };
}
