import { describe, expect, it } from "vitest";

import type { JobRecord } from "../../../../shared/ipc";
import {
  autonomyOptions,
  currencySymbol,
  formatAmount,
  formatMoney,
  gardenerTone,
  labelsView,
  parseCap,
  spendView,
  treeShapeOptions
} from "./knowledge-model";

const job = (patch: Partial<JobRecord>): JobRecord => ({ id: "j1", ...patch }) as JobRecord;

describe("the words of Knowledge", () => {
  it("names the three autonomy levels and the three tree shapes, each with copy keys", () => {
    expect(autonomyOptions.map((option) => option.value)).toEqual(["off", "suggest", "auto"]);
    expect(autonomyOptions[2]?.description).toBe("settingsKnowledge.autonomy.auto.description");
    expect(treeShapeOptions.map((option) => option.value)).toEqual(["broad", "balanced", "deep"]);
  });

  it("writes money and the cap's symbol in the person's language", () => {
    expect(formatMoney("pt-BR", 12)).toContain("12,00");
    expect(formatMoney("en", 12)).toBe("$12.00");
    expect(formatAmount("pt-BR", 5)).toBe("5,00");
    expect(currencySymbol("pt-BR")).toBe("US$");
    expect(currencySymbol("en")).toBe("$");
  });

  it("reads a cap typed with a comma or a point, and brings a value into range", () => {
    expect(parseCap("12,5")).toBe(12.5);
    expect(parseCap(" 7.25 ")).toBe(7.25);
    expect(parseCap("abc")).toBeNull();
    expect(parseCap("")).toBeNull();
    expect(parseCap("99999999")).toBeLessThanOrEqual(99999999);
  });
});

describe("the month's spend", () => {
  const money = (spentUsd: number, capUsd: number, state: "open" | "paused" | "exhausted") => ({
    spentUsd,
    reservedUsd: 0,
    capUsd,
    pauseShare: 0.8,
    continued: false,
    state,
    priceTableVersion: "t"
  });

  it("is a share of the cap that never passes 100, and nothing while unknown", () => {
    expect(spendView(null)).toBeNull();
    expect(spendView(money(3, 12, "open"))?.percent).toBe(25);
    expect(spendView(money(20, 12, "exhausted"))?.percent).toBe(100);
    expect(spendView(money(0, 0, "exhausted"))?.percent).toBe(100);
    expect(spendView(money(10, 12, "paused"))?.state).toBe("paused");
  });
});

describe("the Gardener's tone", () => {
  const status = (state: "running" | "idle" | "blocked" | "attention") =>
    ({ state, params: {}, coverage: { placed: 1, matched: 1, overviewsFresh: 1 } }) as never;
  it("moves while it works, is fine when idle and warns when it is held", () => {
    expect(gardenerTone(status("running"))).toBe("working");
    expect(gardenerTone(status("idle"))).toBe("ok");
    expect(gardenerTone(status("blocked"))).toBe("warn");
    expect(gardenerTone(status("attention"))).toBe("warn");
  });
});

describe("where the connection descriptions stand", () => {
  it("is idle with no job, working while one is queued or running, done or failed after", () => {
    expect(labelsView(null)).toEqual({ kind: "idle" });
    expect(labelsView(job({ status: "queued", progress: 0, canCancel: true }))).toMatchObject({
      kind: "working",
      queued: true,
      canCancel: true
    });
    expect(labelsView(job({ status: "running", progress: 0.4, canCancel: false }))).toMatchObject({
      kind: "working",
      queued: false,
      progress: 0.4
    });
    expect(
      labelsView(job({ status: "succeeded", labelResult: { updated: 3, contentLanguage: "en" } }))
    ).toEqual({ kind: "done", updated: 3 });
    expect(labelsView(job({ status: "failed", canRetry: true }))).toEqual({
      kind: "failed",
      canRetry: true,
      jobId: "j1"
    });
    expect(labelsView(job({ status: "canceled" }))).toEqual({ kind: "idle" });
  });
});
