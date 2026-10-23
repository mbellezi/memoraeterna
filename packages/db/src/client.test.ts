import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  budgetedQueries,
  createStatementCanceler,
  StatementBudgetError,
  type PgPool
} from "./client.js";

/** A pool whose one client records what it is sent and answers `fail` with the given error. */
function recordingPool(fail?: { text: string; error: Error }) {
  const sent: string[] = [];
  const release = vi.fn();
  const connect = vi.fn(async () => ({
    query: async (text: string) => {
      sent.push(text);
      if (fail && text === fail.text) throw fail.error;
      return { rows: [{ ok: true }], rowCount: 1 };
    },
    release
  }));
  return { pool: { connect } as unknown as PgPool, sent, release, connect };
}

describe("statements bounded by a caller's time budget", () => {
  it("runs each statement in its own transaction, limited to what is left of the budget", async () => {
    const { pool, sent, release } = recordingPool();
    let left = 90_000.7;
    const queries = budgetedQueries(pool, () => left);
    expect((await queries.query("select 1")).rows).toEqual([{ ok: true }]);
    left = 1_500;
    await queries.query("select 2", [1]);
    expect(sent).toEqual([
      "begin; set local statement_timeout = 90000",
      "select 1",
      "commit",
      "begin; set local statement_timeout = 1500",
      "select 2",
      "commit"
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("reports a statement the timeout stopped as out of budget, after rolling it back", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014"
    });
    const { pool, sent, release } = recordingPool({ text: "select slow()", error: timeout });
    const failure = await budgetedQueries(pool, () => 5_000)
      .query("select slow()")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StatementBudgetError);
    expect((failure as Error).cause).toBe(timeout);
    expect(sent.at(-1)).toBe("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("passes any other failure on unchanged", async () => {
    const broken = Object.assign(new Error("syntax error"), { code: "42601" });
    const { pool, release } = recordingPool({ text: "selec 1", error: broken });
    await expect(budgetedQueries(pool, () => 5_000).query("selec 1")).rejects.toBe(broken);
    expect(release).toHaveBeenCalledOnce();
  });

  it("starts no statement once the budget is spent or the caller gave up", async () => {
    const { pool, connect } = recordingPool();
    await expect(budgetedQueries(pool, () => 0.5).query("select 1")).rejects.toBeInstanceOf(
      StatementBudgetError
    );
    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    await expect(
      budgetedQueries(pool, () => 60_000, controller.signal).query("select 1")
    ).rejects.toThrow("canceled");
    expect(connect).not.toHaveBeenCalled();
  });
});

const canceledByRequest = () =>
  Object.assign(new Error("canceling statement due to user request"), { code: "57014" });

/**
 * A pool whose one client hangs on a marked statement until the pool's own `query` (the canceler's
 * control connection) answers `cancelAnswers` in turn; the first `true` ends the statement with 57014.
 */
function cancellablePool(cancelAnswers: boolean[]) {
  const sent: string[] = [];
  let stop: ((error: Error) => void) | undefined;
  const release = vi.fn();
  const client = {
    query: (text: string) => {
      sent.push(text);
      return text.startsWith("/* ask:")
        ? new Promise<never>((_resolve, reject) => {
            stop = reject;
          })
        : Promise.resolve({ rows: [], rowCount: 0 });
    },
    release
  };
  const answers = [...cancelAnswers];
  const control = vi.fn<(text: string, values: unknown[]) => Promise<unknown>>(async () => {
    const canceled = answers.shift() ?? false;
    if (canceled) stop?.(canceledByRequest());
    return { rows: [{ canceled }] };
  });
  const pool = { connect: async () => client, query: control } as unknown as PgPool;
  return { pool, sent, control, release };
}

describe("statements an Ask can cancel", () => {
  it("starts each statement with the request's marker and leaves unmarked callers alone", async () => {
    const { pool, sent } = recordingPool();
    const id = randomUUID();
    await budgetedQueries(pool, () => 5_000, undefined, { requestId: id }).query("select 1");
    await budgetedQueries(pool, () => 5_000).query("select 2");
    expect(sent.filter((text) => text.includes("select"))).toEqual([
      `/* ask:${id} */ select 1`,
      "select 2"
    ]);
    expect(() =>
      budgetedQueries(pool, () => 5_000, undefined, { requestId: "x */ select 1; /*" })
    ).toThrow(TypeError);
  });

  it("cancels the statement in flight by its marker and reports the cancel, not a timeout", async () => {
    const { pool, sent, control, release } = cancellablePool([true]);
    const id = randomUUID();
    const controller = new AbortController();
    const running = budgetedQueries(pool, () => 60_000, controller.signal, {
      requestId: id
    }).query("select pg_sleep(30)");
    const settled = running.catch((error: unknown) => error);
    await vi.waitFor(() => expect(sent).toContain(`/* ask:${id} */ select pg_sleep(30)`));
    controller.abort(new Error("canceled"));
    await expect(createStatementCanceler(pool).cancelActive(id)).resolves.toBe(1);
    const failure = await settled;
    expect(failure).not.toBeInstanceOf(StatementBudgetError);
    expect((failure as Error).message).toBe("canceled");
    expect(control).toHaveBeenCalledWith(expect.stringContaining("pg_cancel_backend"), [
      `/* ask:${id} */`
    ]);
    // The failed statement was rolled back and its connection returned.
    expect(sent.at(-1)).toBe("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("asks again while the statement is still in flight and finds nothing yet", async () => {
    const { pool, sent, control } = cancellablePool([false, false, true]);
    const id = randomUUID();
    const controller = new AbortController();
    const settled = budgetedQueries(pool, () => 60_000, controller.signal, { requestId: id })
      .query("select pg_sleep(30)")
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(sent.some((text) => text.includes("pg_sleep"))).toBe(true));
    controller.abort(new Error("canceled"));
    await expect(createStatementCanceler(pool).cancelActive(id)).resolves.toBe(1);
    expect(control).toHaveBeenCalledTimes(3);
    expect(((await settled) as Error).message).toBe("canceled");
  });

  it("costs no round trip when the request has no statement in flight", async () => {
    const { pool, control } = cancellablePool([true]);
    await expect(createStatementCanceler(pool).cancelActive(randomUUID())).resolves.toBe(0);
    expect(control).not.toHaveBeenCalled();
    await expect(createStatementCanceler(pool).cancelActive("a */ b")).rejects.toThrow(TypeError);
  });

  it("starts no statement when the cancel came while its transaction began", async () => {
    const controller = new AbortController();
    const sent: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          sent.push(text);
          if (text.startsWith("begin")) controller.abort(new Error("canceled"));
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      })
    } as unknown as PgPool;
    await expect(
      budgetedQueries(pool, () => 60_000, controller.signal, { requestId: randomUUID() }).query(
        "select 1"
      )
    ).rejects.toThrow("canceled");
    expect(sent).toEqual(["begin; set local statement_timeout = 60000", "rollback"]);
  });

  it("still reports a statement the timeout stopped as out of budget while the signal is live", async () => {
    const { pool } = recordingPool({
      text: "/* ask:abc */ select slow()",
      error: Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014"
      })
    });
    await expect(
      budgetedQueries(pool, () => 5_000, new AbortController().signal, {
        requestId: "abc"
      }).query("select slow()")
    ).rejects.toBeInstanceOf(StatementBudgetError);
  });
});
