import { describe, expect, it } from "vitest";

import {
  defaultPriceTable,
  PriceTableSchema,
  priceTableVersion,
  resolvePrice,
  tokensCostUsd,
  type PriceTable
} from "./price-table.js";

describe("the price table (F4 D14)", () => {
  it("is valid, versioned and dated per entry", () => {
    expect(PriceTableSchema.parse(defaultPriceTable)).toEqual(defaultPriceTable);
    expect(defaultPriceTable.version).toBe(priceTableVersion);
    for (const entry of defaultPriceTable.entries)
      expect(entry.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("meters Codex OAuth as a subscription, whatever the model", () => {
    const price = resolvePrice(defaultPriceTable, "openai-codex", "gpt-5.6-luna");
    expect(price).toMatchObject({ billing: "subscription", known: true });
    expect(tokensCostUsd(price, { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });

  it("prices the Decisions model by its input tokens only", () => {
    const price = resolvePrice(defaultPriceTable, "openai-decisions", "gpt-6-luna");
    expect(price).toMatchObject({ billing: "per_token", known: true, inputUsdPerM: 0.1 });
    expect(tokensCostUsd(price, { inputTokens: 2_000_000, outputTokens: 50 })).toBeCloseTo(0.2, 12);
  });

  it("matches dated snapshots and the Gemini models/ prefix, not other models of the family", () => {
    expect(resolvePrice(defaultPriceTable, "openai-compatible", "GPT-5-2025-08-07")).toMatchObject({
      known: true,
      outputUsdPerM: 10
    });
    expect(resolvePrice(defaultPriceTable, "google", "models/gemini-2.5-flash")).toMatchObject({
      known: true,
      outputUsdPerM: 2.5
    });
    expect(resolvePrice(defaultPriceTable, "openai-compatible", "gpt-5-mini")).toMatchObject({
      known: true,
      outputUsdPerM: 2
    });
    expect(resolvePrice(defaultPriceTable, "openai-compatible", "gpt-5-turbo").known).toBe(false);
  });

  it("prices an unknown model conservatively, above every listed price and never zero", () => {
    const unknown = resolvePrice(defaultPriceTable, "openai-compatible", "someone/new-model");
    expect(unknown.known).toBe(false);
    expect(unknown.billing).toBe("per_token");
    const priced = defaultPriceTable.entries.filter((entry) => entry.billing === "per_token");
    const maxInput = Math.max(...priced.map((entry) => entry.inputUsdPerM));
    const maxOutput = Math.max(...priced.map((entry) => entry.outputUsdPerM));
    expect(unknown.inputUsdPerM).toBeCloseTo(maxInput * 1.5, 12);
    expect(unknown.outputUsdPerM).toBeCloseTo(maxOutput * 1.5, 12);
    expect(tokensCostUsd(unknown, { inputTokens: 1, outputTokens: 1 })).toBeGreaterThan(0);
    // An unknown provider kind is priced the same way, never as a subscription.
    expect(resolvePrice(defaultPriceTable, "other", "x").billing).toBe("per_token");
  });

  it("refuses a table that cannot price an unknown model, duplicates and upper-case ids", () => {
    const entry = defaultPriceTable.entries[0]!;
    const only = (entries: PriceTable["entries"]) =>
      PriceTableSchema.safeParse({ ...defaultPriceTable, entries }).success;
    expect(only([entry])).toBe(false);
    const priced = defaultPriceTable.entries.find(
      (item) => item.billing === "per_token" && item.outputUsdPerM > 0
    )!;
    // The Decisions entry alone prices no output: an unknown writer would cost nothing to write.
    expect(
      only(defaultPriceTable.entries.filter((item) => item.provider === "openai-decisions"))
    ).toBe(false);
    expect(only([priced, priced])).toBe(false);
    expect(only([{ ...priced, model: "GPT-X" }])).toBe(false);
    expect(only([priced])).toBe(true);
  });
});
