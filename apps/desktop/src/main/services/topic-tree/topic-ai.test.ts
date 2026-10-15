import { describe, expect, it, vi } from "vitest";

import { TopicAiBudget, localDay, readTopicAiMode } from "./topic-ai.js";
import type { TopicAiBudgetStore } from "./topic-ai.js";

describe("G1: the topic AI mode (D23)", () => {
  it("ignores MEMORA_GOLDEN_TOPICS=deterministic without MEMORA_GOLDEN_RUN", () => {
    expect(readTopicAiMode({ MEMORA_GOLDEN_TOPICS: "deterministic" }, false)).toBe("full");
    expect(
      readTopicAiMode({ MEMORA_GOLDEN_RUN: "  ", MEMORA_GOLDEN_TOPICS: "deterministic" }, false)
    ).toBe("full");
    expect(readTopicAiMode({}, false)).toBe("full");
  });

  it("defaults a golden run to deterministic and reads full when asked", () => {
    expect(readTopicAiMode({ MEMORA_GOLDEN_RUN: "golden.json" }, false)).toBe("deterministic");
    expect(
      readTopicAiMode({ MEMORA_GOLDEN_RUN: "golden.json", MEMORA_GOLDEN_TOPICS: "full" }, false)
    ).toBe("full");
  });

  it("never runs golden in a packaged build", () => {
    expect(
      readTopicAiMode(
        { MEMORA_GOLDEN_RUN: "golden.json", MEMORA_GOLDEN_TOPICS: "deterministic" },
        true
      )
    ).toBe("full");
  });

  it("reports an unknown value and spends nothing", () => {
    const warn = vi.fn();
    expect(
      readTopicAiMode({ MEMORA_GOLDEN_RUN: "golden.json", MEMORA_GOLDEN_TOPICS: "fast" }, false, {
        warn
      })
    ).toBe("deterministic");
    expect(warn).toHaveBeenCalledOnce();
  });
});

function memoryStore(initial: unknown = null): TopicAiBudgetStore & { value: unknown } {
  const store = {
    value: initial,
    read: async () => store.value,
    write: async (record: unknown) => {
      store.value = record;
    }
  };
  return store;
}

describe("D34: the daily cap of background topic AI", () => {
  it("reserves calls up to the cap and then refuses, keeping the count", async () => {
    const store = memoryStore();
    const now = new Date(2026, 9, 15, 10);
    const budget = new TopicAiBudget({ store, cap: () => 3, now: () => now });
    await expect(budget.reserve(2)).resolves.toBe(true);
    await expect(budget.reserve(2)).resolves.toBe(false);
    await expect(budget.reserve()).resolves.toBe(true);
    await expect(budget.usage()).resolves.toEqual({
      day: localDay(now),
      calls: 3,
      cap: 3,
      remaining: 0,
      capReached: true
    });
    await expect(budget.reserve()).resolves.toBe(false);
  });

  it("starts each local day from zero", async () => {
    let now = new Date(2026, 9, 15, 23, 59);
    const store = memoryStore();
    const budget = new TopicAiBudget({ store, cap: () => 1, now: () => now });
    await expect(budget.reserve()).resolves.toBe(true);
    await expect(budget.reserve()).resolves.toBe(false);
    now = new Date(2026, 9, 16, 0, 1);
    await expect(budget.usage()).resolves.toMatchObject({ day: "2026-10-16", calls: 0 });
    await expect(budget.reserve()).resolves.toBe(true);
  });

  it("never overspends under concurrent reservations, and ignores an unreadable record", async () => {
    const store = memoryStore({ day: "garbage" });
    const budget = new TopicAiBudget({ store, cap: () => 5, now: () => new Date(2026, 9, 15) });
    const results = await Promise.all(Array.from({ length: 12 }, () => budget.reserve()));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(store.value).toEqual({ day: "2026-10-15", calls: 5 });
  });

  it("refuses to reserve a non-positive or fractional number of calls", () => {
    const budget = new TopicAiBudget({ store: memoryStore(), cap: () => 5 });
    expect(() => budget.reserve(0)).toThrow(RangeError);
    expect(() => budget.reserve(1.5)).toThrow(RangeError);
  });
});
