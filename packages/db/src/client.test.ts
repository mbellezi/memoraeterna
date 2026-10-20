import { describe, expect, it, vi } from "vitest";

import { budgetedQueries, StatementBudgetError, type PgPool } from "./client.js";

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
