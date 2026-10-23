import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  budgetedQueries,
  closePgPool,
  createPgPool,
  createStatementCanceler,
  StatementBudgetError,
  type PgPool,
  type StatementCanceler
} from "./client.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "./sidecar/index.js";

// Canceling an Ask's running statement against a real PostgreSQL database: the marker, the control
// connection and the two ways a statement ends with SQLSTATE 57014 (a cancel and a timeout).
const workspace = resolve(import.meta.dirname, "../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)(
  "canceling an Ask statement on a real PostgreSQL database",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool;
    let canceler: StatementCanceler;

    /** Backends that run a marked statement right now. */
    const activeMarked = async () =>
      (
        await pool.query<{ n: string }>(
          `select count(*) as n from pg_stat_activity
          where datname = current_database() and state = 'active' and starts_with(query, '/* ask:')`
        )
      ).rows[0]!.n;
    const idle = (n: number) => new Promise((resolve) => setTimeout(resolve, n));

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-statement-cancel-"));
      // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_statement_cancel_test",
          user: "memora_statement_cancel_test",
          password: `statement-cancel-${randomUUID()}`,
          startupTimeoutMs: 30_000,
          shutdownTimeoutMs: 10_000
        });
        try {
          connection = await manager.start();
        } catch (error) {
          await manager.stop().catch(() => undefined);
          if (attempt >= 3) throw error;
        }
      }
      pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
      canceler = createStatementCanceler(pool);
    }, 60_000);

    afterAll(async () => {
      await canceler?.close();
      if (pool) await closePgPool(pool);
      await manager?.stop();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }, 30_000);

    it("stops a 30 s statement in well under a second and reports the cancel", async () => {
      const requestId = randomUUID();
      const controller = new AbortController();
      const reason = new Error("canceled");
      const started = Date.now();
      const settled = budgetedQueries(pool, () => 60_000, controller.signal, { requestId })
        .query("select pg_sleep(30)")
        .catch((error: unknown) => error);
      // Wait until the server really runs it, then cancel as the service does: abort, then cancel.
      await expect.poll(activeMarked, { interval: 20, timeout: 5_000 }).toBe("1");
      controller.abort(reason);
      await expect(canceler.cancelActive(requestId)).resolves.toBe(1);
      const failure = await settled;
      expect(failure).toBe(reason);
      expect(failure).not.toBeInstanceOf(StatementBudgetError);
      expect(Date.now() - started).toBeLessThan(1_000);
      // No backend is left running it, and the connection it used holds no changed setting.
      await expect(activeMarked()).resolves.toBe("0");
      const sessions = await Promise.all(
        [1, 2, 3, 4].map(() => pool.query<{ statement_timeout: string }>("show statement_timeout"))
      );
      expect(sessions.map((result) => result.rows[0]!.statement_timeout)).toEqual([
        "0",
        "0",
        "0",
        "0"
      ]);
    });

    it("still reports a statement that ran out of its budget as a timeout", async () => {
      const started = Date.now();
      const failure = await budgetedQueries(pool, () => 300, new AbortController().signal, {
        requestId: randomUUID()
      })
        .query("select pg_sleep(30)")
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StatementBudgetError);
      expect(Date.now() - started).toBeLessThan(5_000);
      await expect(activeMarked()).resolves.toBe("0");
    });

    it("cancels the statement of its own request and no other that is running", async () => {
      const mine = randomUUID();
      const theirs = randomUUID();
      const controller = new AbortController();
      const reason = new Error("canceled");
      const settledMine = budgetedQueries(pool, () => 60_000, controller.signal, {
        requestId: mine
      })
        .query("select pg_sleep(30)")
        .catch((error: unknown) => error);
      const settledTheirs = budgetedQueries(pool, () => 60_000, undefined, { requestId: theirs })
        .query<{ slept: string }>("select 'done' as slept from pg_sleep(1.5)")
        .catch((error: unknown) => error);
      await expect.poll(activeMarked, { interval: 20, timeout: 5_000 }).toBe("2");
      controller.abort(reason);
      await expect(canceler.cancelActive(mine)).resolves.toBe(1);
      expect(await settledMine).toBe(reason);
      expect(await activeMarked()).toBe("1");
      expect(((await settledTheirs) as { rows: { slept: string }[] }).rows).toEqual([
        { slept: "done" }
      ]);
    });

    it("leaves the statement a recycled connection runs now alone once the request's own has ended", async () => {
      const single = createPgPool({ connectionString: pool.options.connectionString!, max: 1 });
      try {
        const gone = randomUUID();
        await budgetedQueries(single, () => 60_000, undefined, { requestId: gone }).query(
          "select 1"
        );
        // The only connection now runs somebody else's statement.
        const others = budgetedQueries(single, () => 60_000, undefined, {
          requestId: randomUUID()
        })
          .query<{ slept: string }>("select 'done' as slept from pg_sleep(1)")
          .catch((error: unknown) => error);
        await expect.poll(activeMarked, { interval: 20, timeout: 5_000 }).toBe("1");
        await expect(createStatementCanceler(single).cancelActive(gone)).resolves.toBe(0);
        expect(((await others) as { rows: { slept: string }[] }).rows).toEqual([{ slept: "done" }]);
      } finally {
        await closePgPool(single);
      }
    });

    it("finds the statement even when the cancel overtakes it on the way to the server", async () => {
      const requestId = randomUUID();
      const controller = new AbortController();
      const reason = new Error("canceled");
      const settled = budgetedQueries(pool, () => 60_000, controller.signal, { requestId })
        .query("select pg_sleep(30)")
        .catch((error: unknown) => error);
      // Cancel at once, before the statement is known to be active on the server.
      await idle(0);
      controller.abort(reason);
      await canceler.cancelActive(requestId);
      expect(await settled).toBe(reason);
      await expect(activeMarked()).resolves.toBe("0");
    });
  }
);
