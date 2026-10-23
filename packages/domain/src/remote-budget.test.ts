import { describe, expect, it } from "vitest";

import { defaultPriceTable, resolvePrice } from "./price-table.js";
import {
  auditedCallUsd,
  callAdmission,
  defaultRemoteBudgetConfig,
  estimateImport,
  localBudgetDay,
  localMonth,
  localMonthWindow,
  moneyAdmission,
  nextLocalBudgetDay,
  refusable,
  RemoteBudgetRefusal,
  remoteBudgetConfigSchema,
  remoteBudgetRefusalOf
} from "./remote-budget.js";

describe("the remote budget's arithmetic (F4 D14)", () => {
  it("has the spec's start values in typed configuration", () => {
    expect(defaultRemoteBudgetConfig).toEqual({
      defaultMonthlyCapUsd: 5,
      pauseShare: 0.8,
      subscriptionDailyCalls: 800,
      importTokensPerChunk: { input: 2_100, output: 1_000 }
    });
    expect(remoteBudgetConfigSchema.safeParse({ pauseShare: 1 }).success).toBe(false);
    expect(remoteBudgetConfigSchema.safeParse({ subscriptionDailyCalls: -1 }).success).toBe(false);
  });

  it("admits an attempt only while spend, reservations and its estimate stay within the cap", () => {
    const base = { capUsd: 10, pauseShare: 0.8, continued: false };
    expect(moneyAdmission({ ...base, spentUsd: 5, reservedUsd: 2, estimateUsd: 1 })).toBe("admit");
    expect(moneyAdmission({ ...base, spentUsd: 5, reservedUsd: 2, estimateUsd: 1.01 })).toBe(
      "money_80"
    );
    expect(
      moneyAdmission({ ...base, continued: true, spentUsd: 5, reservedUsd: 2, estimateUsd: 2 })
    ).toBe("admit");
    expect(
      moneyAdmission({ ...base, continued: true, spentUsd: 5, reservedUsd: 3, estimateUsd: 2.01 })
    ).toBe("money_100");
    // Past the cap the verdict is money_100 whether or not the person continued.
    expect(moneyAdmission({ ...base, spentUsd: 9, reservedUsd: 0, estimateUsd: 2 })).toBe(
      "money_100"
    );
    // A cap of zero allows no background spend.
    expect(
      moneyAdmission({ ...base, capUsd: 0, spentUsd: 0, reservedUsd: 0, estimateUsd: 1e-9 })
    ).toBe("money_100");
  });

  it("counts every attempt as one call against the daily subscription cap", () => {
    expect(callAdmission({ usedCalls: 797, reservedCalls: 2, capCalls: 800 })).toBe("admit");
    expect(callAdmission({ usedCalls: 797, reservedCalls: 3, capCalls: 800 })).toBe(
      "subscription_daily"
    );
    expect(callAdmission({ usedCalls: 0, reservedCalls: 0, capCalls: 0 })).toBe(
      "subscription_daily"
    );
  });

  it("refuses only background work off P0", () => {
    expect(refusable("background", 2)).toBe(true);
    expect(refusable("background", 3)).toBe(true);
    expect(refusable("background", null)).toBe(true);
    expect(refusable("background", 0)).toBe(false);
    expect(refusable("user", 2)).toBe(false);
    expect(refusable("interactive", 0)).toBe(false);
    expect(refusable(null, 3)).toBe(false);
  });

  it("keeps the estimate as spend when the provider reported no usage, never zero", () => {
    const price = resolvePrice(defaultPriceTable, "openai-compatible", "gpt-5");
    expect(
      auditedCallUsd({ price, inputTokens: 1_000_000, outputTokens: 100_000, estimateUsd: 99 })
    ).toBeCloseTo(1.25 + 1, 12);
    expect(auditedCallUsd({ price, inputTokens: null, outputTokens: 10, estimateUsd: 0.5 })).toBe(
      0.5
    );
    // A failed attempt the provider accepted without reporting its usage counts on top of the
    // reported tokens; with a missing count the whole estimate already covers it.
    expect(
      auditedCallUsd({
        price,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        estimateUsd: 99,
        unreportedUsd: 0.75
      })
    ).toBeCloseTo(1.25 + 1 + 0.75, 12);
    expect(
      auditedCallUsd({
        price,
        inputTokens: null,
        outputTokens: 10,
        estimateUsd: 0.5,
        unreportedUsd: 0.2
      })
    ).toBe(0.5);
    expect(
      auditedCallUsd({ price, inputTokens: 5, outputTokens: undefined, estimateUsd: 0.25 })
    ).toBe(0.25);
    // A row written before 0061 with no usage and no estimate: its output budget, not zero.
    expect(
      auditedCallUsd({
        price,
        inputTokens: null,
        outputTokens: null,
        estimateUsd: null,
        fallbackOutputTokens: 16_384
      })
    ).toBeCloseTo((16_384 * 10) / 1e6, 12);
    const subscription = resolvePrice(defaultPriceTable, "openai-codex", "any");
    expect(
      auditedCallUsd({ price: subscription, inputTokens: null, outputTokens: null, estimateUsd: 3 })
    ).toBe(0);
  });

  it("names the local month and day windows", () => {
    const at = new Date(2026, 11, 31, 23, 59);
    expect(localMonth(at)).toBe("2026-12");
    expect(localBudgetDay(at)).toBe("2026-12-31");
    expect(localMonthWindow(at)).toEqual({
      start: new Date(2026, 11, 1),
      end: new Date(2027, 0, 1)
    });
    expect(nextLocalBudgetDay(at)).toEqual(new Date(2027, 0, 1));
  });

  it("recognizes a refusal, also wrapped or rebuilt across a boundary", () => {
    const refusal = new RemoteBudgetRefusal("money_100", new Date(2026, 11, 1));
    expect(refusal.name).toBe("BackgroundBlocked");
    expect(refusal.blockedClass).toBe("cap");
    expect(refusal.message).toBe("gardener.blocked.cap.money_100");
    expect(remoteBudgetRefusalOf(new Error("wrapped", { cause: refusal }))).toBe(refusal);
    const plain = Object.assign(new Error("x"), {
      name: "BackgroundBlocked",
      blockedClass: "cap",
      blockedReason: "subscription_daily"
    });
    expect(remoteBudgetRefusalOf(plain)?.blockedReason).toBe("subscription_daily");
    expect(remoteBudgetRefusalOf(new Error("other"))).toBeNull();
    expect(
      remoteBudgetRefusalOf(Object.assign(new Error("x"), { name: "BackgroundBlocked" }))
    ).toBeNull();
  });

  it("estimates an import from its chunks on its writer route", () => {
    const table = defaultPriceTable;
    expect(estimateImport({ chunkCount: 10, route: null, table })).toEqual({ billing: "none" });
    expect(
      estimateImport({
        chunkCount: 10,
        route: { locality: "local", provider: "local-mlx", modelId: "m" },
        table
      })
    ).toEqual({ billing: "local" });
    expect(
      estimateImport({
        chunkCount: 10,
        route: { locality: "remote", provider: "openai-codex", modelId: "gpt-5.6-luna" },
        table
      })
    ).toEqual({ billing: "subscription" });
    const priced = estimateImport({
      chunkCount: 66,
      route: { locality: "remote", provider: "openai-compatible", modelId: "gpt-5" },
      table
    });
    expect(priced).toMatchObject({ billing: "per_token", known: true });
    expect(priced.billing === "per_token" && priced.usd).toBeCloseTo(
      (66 * 2_100 * 1.25 + 66 * 1_000 * 10) / 1e6,
      12
    );
    const unknown = estimateImport({
      chunkCount: 1,
      route: { locality: "remote", provider: "openai-compatible", modelId: "mystery" },
      table
    });
    expect(unknown).toMatchObject({ billing: "per_token", known: false });
  });
});
