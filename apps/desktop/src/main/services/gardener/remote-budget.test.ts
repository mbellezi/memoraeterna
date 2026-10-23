import { defaultDecisionsLimits } from "@app/ai";
import type { BudgetLedgerEntry, Queryable } from "@app/db";
import {
  budgetContinueSettingKey,
  defaultPriceTable,
  RemoteBudgetRefusal,
  resolvePrice,
  subscriptionDailyCallsSettingKey,
  tokensCostUsd
} from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import { isTransientJobFailure } from "../job-failure.js";
import {
  attemptTokenEstimate,
  countedInLedger,
  RemoteBudget,
  type RemoteBudgetCall
} from "./remote-budget.js";

/**
 * The RemoteBudget (F4 D14, T76) against a scripted database: per-attempt reservations under one
 * mutex, release after the audit, the pause share and the cap, the subscription call cap, unknown
 * prices, NULL usage, and the ledger windows.
 */
function database(ledger: Array<Partial<BudgetLedgerEntry>> = []) {
  const settings = new Map<string, unknown>();
  const ledgerWindows: Array<[Date, Date]> = [];
  const pool: Queryable = {
    query: (async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("from ai_task_runs")) {
        ledgerWindows.push([values[0] as Date, values[1] as Date]);
        return {
          rows: ledger.map((entry) => ({
            provider: entry.provider ?? "openai-compatible",
            modelId: entry.modelId ?? "gpt-5",
            calls: String(entry.calls ?? 1),
            inputTokens: String(entry.inputTokens ?? 0),
            outputTokens: String(entry.outputTokens ?? 0),
            estimatedCalls: String(entry.estimatedCalls ?? 0),
            estimateUsd: entry.estimateUsd ?? null,
            unestimatedCalls: String(entry.unestimatedCalls ?? 0),
            unestimatedInputTokens: String(entry.unestimatedInputTokens ?? 0),
            unestimatedOutputTokens: String(entry.unestimatedOutputTokens ?? 0)
          }))
        };
      }
      if (text.startsWith("select") && text.includes("from settings")) {
        const key = values[0] as string;
        return settings.has(key)
          ? { rows: [{ key, value: settings.get(key), updatedAt: new Date() }] }
          : { rows: [] };
      }
      if (text.includes("insert into settings")) {
        settings.set(values[0] as string, values[1]);
        return { rows: [{ key: values[0], value: values[1], updatedAt: new Date() }] };
      }
      throw new Error(`unexpected statement ${text.slice(0, 60)}`);
    }) as Queryable["query"]
  };
  return { pool, settings, ledgerWindows };
}

const gpt5 = resolvePrice(defaultPriceTable, "openai-compatible", "gpt-5");
/** One attempt of this estimate costs exactly US$ 1 on gpt-5 (100,000 output tokens at US$ 10/M). */
const dollarAttempt = { inputTokens: 0, outputTokens: 100_000 };

function call(overrides: Partial<RemoteBudgetCall> = {}): RemoteBudgetCall {
  return {
    lane: "remote:priced",
    provider: "openai-compatible",
    modelId: "gpt-5",
    budgetClass: "background",
    priority: 3,
    estimate: dollarAttempt,
    ...overrides
  };
}

function budget(
  options: {
    cap?: number;
    calls?: number;
    ledger?: Array<Partial<BudgetLedgerEntry>>;
    now?: () => Date;
  } = {}
) {
  const db = database(options.ledger);
  let changes = 0;
  const service = new RemoteBudget({
    getPool: () => db.pool,
    monthlyCapUsd: () => options.cap ?? 10,
    subscriptionDailyCalls: () => options.calls ?? 800,
    ...(options.now ? { now: options.now } : {}),
    onChange: () => {
      changes += 1;
    }
  });
  return { service, db, changes: () => changes };
}

const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof RemoteBudgetRefusal ? error.blockedReason : error)
  );

describe("the RemoteBudget's money meter", () => {
  it("admits concurrent attempts at the edge one at a time, never past the cap", async () => {
    // Spend 7 of a cap of 10, the person continued: three US$ 1 attempts fit, the fourth does not.
    const { service } = budget({ cap: 10, ledger: [{ inputTokens: 0, outputTokens: 700_000 }] });
    await service.continuePastPause();
    const tickets = await Promise.all([1, 2, 3, 4].map(() => service.open(call())));
    const verdicts = await Promise.all(tickets.map((ticket) => refusalOf(ticket.admitAttempt(1))));
    expect(verdicts.filter((verdict) => verdict === null)).toHaveLength(3);
    expect(verdicts.filter((verdict) => verdict === "money_100")).toHaveLength(1);
    const snapshot = await service.snapshot();
    expect(snapshot.money.spentUsd).toBeCloseTo(7, 9);
    expect(snapshot.money.reservedUsd).toBeCloseTo(3, 9);
    expect(snapshot.money.state).toBe("exhausted");
  });

  it("reserves every attempt of a retried call and refuses the one that would pass the cap", async () => {
    const { service } = budget({ cap: 2.5 });
    await service.continuePastPause();
    const ticket = await service.open(call());
    await ticket.admitAttempt(1);
    await ticket.admitAttempt(2);
    const refusal = await ticket.admitAttempt(3).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RemoteBudgetRefusal);
    expect((refusal as RemoteBudgetRefusal).blockedReason).toBe("money_100");
    expect((refusal as RemoteBudgetRefusal).clearsAt).toBeInstanceOf(Date);
    expect(ticket.estimateUsd).toBeCloseTo(2, 9);
  });

  it("holds a reservation until the audit settles it, then counts what was used", async () => {
    const { service, changes } = budget({ cap: 100 });
    const ticket = await service.open(call());
    await ticket.admitAttempt(1);
    expect((await service.snapshot()).money).toMatchObject({ spentUsd: 0, reservedUsd: 1 });
    const before = changes();
    await ticket.settle({ inputTokens: 1_000, outputTokens: 2_000 });
    const after = (await service.snapshot()).money;
    expect(after.reservedUsd).toBe(0);
    expect(after.spentUsd).toBeCloseTo(
      tokensCostUsd(gpt5, { inputTokens: 1_000, outputTokens: 2_000 }),
      12
    );
    expect(changes()).toBeGreaterThan(before);
    // A second settle (a retried completion) changes nothing.
    await ticket.settle({ inputTokens: 1e9, outputTokens: 1e9 });
    expect((await service.snapshot()).money.spentUsd).toBeCloseTo(after.spentUsd, 12);
    await expect(ticket.admitAttempt(2)).rejects.toThrow(/settled/u);
  });

  it("keeps the reservation as spend when the provider reported no usage", async () => {
    const { service } = budget({ cap: 100 });
    const ticket = await service.open(call());
    await ticket.admitAttempt(1);
    await ticket.admitAttempt(2);
    await ticket.settle({ inputTokens: 500, outputTokens: null });
    expect((await service.snapshot()).money).toMatchObject({ spentUsd: 2, reservedUsd: 0 });
  });

  it("keeps the estimate of an accepted attempt that reported no usage when a retry did", async () => {
    // Attempt 1 stalled after its deltas (accepted, billed, no usage), attempt 2 failed with an error
    // status (not accepted), attempt 3 answered with its usage: attempt 1 stays as spend.
    const { service } = budget({ cap: 100 });
    const ticket = await service.open(call());
    await ticket.admitAttempt(1);
    ticket.attemptFailed({ attempt: 1, unreported: true });
    await ticket.admitAttempt(2);
    ticket.attemptFailed({ attempt: 2, unreported: false });
    await ticket.admitAttempt(3);
    const usage = { inputTokens: 1_000, outputTokens: 2_000 };
    // The audit stores what the ledger counts beyond the reported usage; with a missing count, all.
    expect(ticket.auditEstimateUsd(usage)).toBeCloseTo(1, 12);
    expect(ticket.auditEstimateUsd({ inputTokens: 1_000 })).toBeCloseTo(3, 12);
    await ticket.settle(usage);
    expect((await service.snapshot()).money.spentUsd).toBeCloseTo(
      tokensCostUsd(gpt5, usage) + 1,
      12
    );
    // A clean call stores nothing beyond its usage; a subscription call is not metered in money.
    const clean = await service.open(call());
    await clean.admitAttempt(1);
    expect(clean.auditEstimateUsd(usage)).toBe(0);
    const codex = await service.open(call({ provider: "openai-codex", modelId: "gpt-5.6-luna" }));
    await codex.admitAttempt(1);
    codex.attemptFailed({ attempt: 1, unreported: true });
    expect(codex.auditEstimateUsd(usage)).toBeNull();
  });

  it("pauses past the pause share until the person continues, then stops at the cap", async () => {
    const { service, db } = budget({ cap: 5, ledger: [{ inputTokens: 0, outputTokens: 300_000 }] });
    // Spent 3 of 5: one more dollar reaches 4 (80%), a second would pass it.
    const first = await service.open(call());
    await first.admitAttempt(1);
    const paused = await service.open(call());
    expect(await refusalOf(paused.admitAttempt(1))).toBe("money_80");
    expect((await service.snapshot()).money.state).toBe("paused");
    const continued = await service.continuePastPause();
    expect(continued.money).toMatchObject({ continued: true, state: "open" });
    expect(db.settings.get(budgetContinueSettingKey)).toEqual({
      month: continued.month,
      capUsd: 5
    });
    await paused.admitAttempt(1);
    const third = await service.open(call());
    expect(await refusalOf(third.admitAttempt(1))).toBe("money_100");
    expect((await service.snapshot()).money.state).toBe("exhausted");
  });

  it("never refuses P0, user-started or interactive work, and meters only what the ledger counts", async () => {
    const { service } = budget({ cap: 0 });
    const p0 = await service.open(call({ priority: 0 }));
    await p0.admitAttempt(1);
    expect(p0.metered).toBe(true);
    for (const budgetClass of ["user", "interactive"] as const) {
      const ticket = await service.open(call({ budgetClass }));
      expect(ticket.metered).toBe(false);
      await ticket.admitAttempt(1);
      expect(ticket.estimateUsd).toBeNull();
    }
    // An unclassified P2 call is counted, as the ledger counts its row, and never refused.
    const unknown = await service.open(call({ budgetClass: null, priority: 2 }));
    expect(unknown.metered).toBe(true);
    await unknown.admitAttempt(1);
    expect((await service.snapshot()).money.reservedUsd).toBeCloseTo(2, 9);
    // The local lane is never metered.
    expect((await service.open(call({ lane: "local" }))).metered).toBe(false);
    const background = await service.open(call());
    expect(await refusalOf(background.admitAttempt(1))).toBe("money_100");
    expect(countedInLedger(null, 1)).toBe(false);
    expect(countedInLedger(null, 3)).toBe(true);
    expect(countedInLedger("user", 3)).toBe(false);
  });

  it("prices a model missing from the table conservatively", async () => {
    const { service } = budget({ cap: 1_000 });
    const unknown = resolvePrice(defaultPriceTable, "openai-compatible", "brand-new-model");
    const ticket = await service.open(call({ modelId: "brand-new-model" }));
    await ticket.admitAttempt(1);
    expect(ticket.estimateUsd).toBeCloseTo(tokensCostUsd(unknown, dollarAttempt), 12);
    expect(ticket.estimateUsd!).toBeGreaterThan(1);
  });

  it("loads the month from the ledger: estimates of calls without usage and the old rows' budgets", async () => {
    const { service, db } = budget({
      cap: 100,
      ledger: [
        { inputTokens: 1_000_000, outputTokens: 0, estimateUsd: 0.5 },
        { unestimatedInputTokens: 0, unestimatedOutputTokens: 100_000 },
        { provider: "openai-codex", modelId: "gpt-5.6-luna", inputTokens: 9e9, outputTokens: 9e9 }
      ]
    });
    const snapshot = await service.snapshot();
    expect(snapshot.money.spentUsd).toBeCloseTo(1.25 + 0.5 + 1, 9);
    expect(db.ledgerWindows).toHaveLength(1);
    const [start, end] = db.ledgerWindows[0]!;
    expect(start.getDate()).toBe(1);
    expect(end.getMonth()).toBe((start.getMonth() + 1) % 12);
  });

  it("reloads at a month rollover and leaves a call admitted in the old month out of the new one", async () => {
    let now = new Date(2026, 9, 31, 23, 59);
    const { service, db } = budget({ cap: 100, now: () => now });
    const ticket = await service.open(call());
    await ticket.admitAttempt(1);
    now = new Date(2026, 10, 1, 0, 1);
    await ticket.settle({ inputTokens: 0, outputTokens: 100_000 });
    const snapshot = await service.snapshot();
    expect(snapshot.month).toBe("2026-11");
    expect(snapshot.money).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
    expect(db.ledgerWindows).toHaveLength(2);
  });
});

describe("a refused attempt in a job", () => {
  it("is transient: the job waits for the cap to clear instead of failing for good", () => {
    for (const reason of ["money_80", "money_100", "subscription_daily"] as const)
      expect(isTransientJobFailure(new RemoteBudgetRefusal(reason, null))).toBe(true);
    expect(isTransientJobFailure(new Error("gardener.blocked.cap.other"))).toBe(false);
  });
});

describe("the price table and the estimates", () => {
  it("prices the Decisions model as the decider's typed limits do", () => {
    expect(
      resolvePrice(
        defaultPriceTable,
        defaultDecisionsLimits.providerId,
        defaultDecisionsLimits.model
      )
    ).toMatchObject({
      billing: "per_token",
      known: true,
      inputUsdPerM: defaultDecisionsLimits.pricePerMillionInputTokensUsd,
      outputUsdPerM: 0
    });
  });

  it("splits the planning estimate into input bytes plus margin and the output budget", () => {
    // UTF-8 bytes: "é" takes two.
    expect(attemptTokenEstimate("abc", "ée", 512)).toEqual({
      inputTokens: 3 + 3 + 1024,
      outputTokens: 512
    });
    expect(attemptTokenEstimate("", "", -5).outputTokens).toBe(0);
  });

  it("estimates an import on the route that writes its notes and graph", async () => {
    const { service } = budget();
    const routeModel = vi.fn(async () => ({
      locality: "remote" as const,
      provider: "openai-compatible",
      modelId: "gpt-5"
    }));
    await expect(service.estimateImport({ chunkCount: 66 }, { routeModel })).resolves.toEqual({
      billing: "per_token",
      usd: (66 * 2_100 * 1.25 + 66 * 1_000 * 10) / 1e6,
      known: true,
      priceTableVersion: defaultPriceTable.version
    });
    expect(routeModel).toHaveBeenCalledWith("knowledge-graph-generation", {
      operation: "graph_source_chunks",
      workloadClass: "write-quality"
    });
    await expect(
      service.estimateImport({ chunkCount: 66 }, { routeModel: async () => null })
    ).resolves.toEqual({ billing: "none" });
  });
});

describe("the RemoteBudget's call meter (subscription routes)", () => {
  const codex = (overrides: Partial<RemoteBudgetCall> = {}) =>
    call({ provider: "openai-codex", modelId: "gpt-5.6-luna", lane: "remote:codex", ...overrides });

  it("counts each background attempt as one call of the daily cap and stores the count", async () => {
    const { service, db } = budget({ calls: 3 });
    const first = await service.open(codex());
    await first.admitAttempt(1);
    await first.admitAttempt(2);
    expect(first.estimateUsd).toBeNull();
    const second = await service.open(codex());
    await second.admitAttempt(1);
    const third = await service.open(codex());
    const refusal = await third.admitAttempt(1).catch((error: unknown) => error);
    expect((refusal as RemoteBudgetRefusal).blockedReason).toBe("subscription_daily");
    expect((refusal as RemoteBudgetRefusal).clearsAt).toBeInstanceOf(Date);
    await first.settle({ inputTokens: 10, outputTokens: 10 });
    expect(db.settings.get(subscriptionDailyCallsSettingKey)).toMatchObject({ calls: 2 });
    const snapshot = await service.snapshot();
    expect(snapshot.calls).toMatchObject({ usedCalls: 2, reservedCalls: 1, capCalls: 3 });
    expect(snapshot.money.spentUsd).toBe(0);
    // A P0 Codex call is admitted past the cap.
    await (await service.open(codex({ priority: 0 }))).admitAttempt(1);
  });

  it("starts each local day from the stored count of that day only", async () => {
    let now = new Date(2026, 9, 23, 10);
    const { service, db } = budget({ calls: 800, now: () => now });
    db.settings.set(subscriptionDailyCallsSettingKey, { day: "2026-10-23", calls: 799 });
    expect((await service.snapshot()).calls.usedCalls).toBe(799);
    const ticket = await service.open(codex());
    await ticket.admitAttempt(1);
    expect(await refusalOf((await service.open(codex())).admitAttempt(1))).toBe(
      "subscription_daily"
    );
    now = new Date(2026, 9, 24, 0, 5);
    // The call admitted yesterday settles into yesterday's count, not today's.
    await ticket.settle({});
    expect((await service.snapshot()).calls).toMatchObject({ usedCalls: 0, reservedCalls: 0 });
    await (await service.open(codex())).admitAttempt(1);
  });

  it("releases a replayed call's reservations without spending", async () => {
    const { service } = budget({ calls: 1 });
    const ticket = await service.open(codex());
    await ticket.admitAttempt(1);
    await ticket.settle({ replayed: true });
    expect((await service.snapshot()).calls).toMatchObject({ usedCalls: 0, reservedCalls: 0 });
  });
});
