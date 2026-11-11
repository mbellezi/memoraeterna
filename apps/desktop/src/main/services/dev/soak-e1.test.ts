import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { plannedEntryTokens } from "./soak-budget.js";
import { startE1, withWaveMarker } from "./soak-e1.js";
import { readSoakPlan } from "./soak-plan.js";
import { soakF4Schema } from "./soak-plan-f4.js";

// The dedicated E1 contention run (F4 D38b): the wave marker, the driver's start under autonomy
// Off with the power pinned idle, and the plan's E1 section with its allow-list of windows.
const planPath = resolve(import.meta.dirname, "../../../../../../scripts/soak/plan.json");

describe("the edit wave's marker", () => {
  it("puts the wave's marker at the head of the body and replaces an earlier one, never stacking", () => {
    const body = "A long body.\n\nSecond paragraph.";
    const first = withWaveMarker(body, 3);
    expect(first).toBe("[e1 r3]\n\nA long body.\n\nSecond paragraph.");
    const second = withWaveMarker(first, 4);
    expect(second).toBe("[e1 r4]\n\nA long body.\n\nSecond paragraph.");
    // The body keeps its length over waves of the same digit count.
    expect(withWaveMarker(second, 5)).toHaveLength(first.length);
    // Only a marker at the head is a marker: one inside the text is the person's.
    expect(withWaveMarker("Text [e1 r1]\n\nmore", 2)).toBe("[e1 r2]\n\nText [e1 r1]\n\nmore");
  });
});

describe("the E1 run's start", () => {
  const plan = {
    autonomy: "off",
    power: "idle",
    floorReads: "scoped",
    dayOrigin: "warmup_end"
  } as const;
  const deps = (autonomy: string) => {
    const update = vi.fn();
    const setDevOverride = vi.fn();
    return {
      update,
      setDevOverride,
      deps: {
        controls: { current: () => ({ autonomy }), update },
        power: { setDevOverride },
        relationCalls: async () => ({ day: "2026-11-14", calls: 12 }),
        now: () => Date.parse("2026-11-14T08:00:00.000Z")
      }
    };
  };

  it("refuses a start whose stored controls do not read Off, before anything is set", async () => {
    for (const autonomy of ["auto", "suggest"]) {
      const { deps: start, setDevOverride, update } = deps(autonomy);
      await expect(startE1(plan, start)).rejects.toThrow(/autonomy off .* read (auto|suggest)/u);
      expect(setDevOverride).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("pins the power reading idle under Off, records the start, and never writes the controls", async () => {
    const { deps: start, setDevOverride, update } = deps("off");
    expect(await startE1(plan, start)).toEqual({
      autonomyAtStart: "off",
      powerPinnedAt: "2026-11-14T08:00:00.000Z",
      relationCallsAtStart: { day: "2026-11-14", calls: 12 }
    });
    expect(setDevOverride).toHaveBeenCalledWith({
      startedAt: Date.parse("2026-11-14T08:00:00.000Z"),
      blocks: [{ active: false, onBattery: false }]
    });
    expect(update).not.toHaveBeenCalled();
    // An unreadable counter is recorded as unknown, not a refusal.
    const failing = deps("off");
    failing.deps.relationCalls = async () => {
      throw new Error("no table");
    };
    expect((await startE1(plan, failing.deps)).relationCallsAtStart).toBeNull();
  });
});

describe("the plan's E1 section", () => {
  const soak7 = readSoakPlan(planPath, "soak7").profile.f4!;
  const base = { ...soak7, injection: undefined, money: undefined, windowSeries: [] };
  const e1 = { autonomy: "off", power: "idle", floorReads: "scoped", dayOrigin: "warmup_end" };

  it("is absent on soak7 and its gate and tails, which read as before", () => {
    for (const name of ["soak7", "soak7-gate", "soak7-tail", "soak7-tail2"])
      expect(readSoakPlan(planPath, name).profile.f4?.e1).toBeUndefined();
  });

  it("allows only ranker-invalid windows beside it: every other kind changes or lifts the run's conditions", () => {
    const window = (kind: string) => ({
      id: `w-${kind}`,
      kind,
      startMinute: 60,
      durationMinutes: 10
    });
    expect(
      soakF4Schema.safeParse({ ...base, e1, windows: [window("ranker_invalid")] }).success
    ).toBe(true);
    for (const kind of [
      "autonomy_off",
      "autonomy_suggest",
      "pause",
      "only_idle",
      "only_ac",
      "money",
      "usage_limit",
      "codex_daily_cap",
      "harness_cap"
    ]) {
      const parsed = soakF4Schema.safeParse({ ...base, e1, windows: [window(kind)] });
      expect(parsed.success, kind).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain("dedicated E1 run");
    }
    const series = soakF4Schema.safeParse({
      ...base,
      e1,
      windows: [],
      windowSeries: [
        {
          idPrefix: "pause",
          kind: "pause",
          everyMinutes: 60,
          offsetMinutes: 10,
          durationMinutes: 5
        }
      ]
    });
    expect(series.success).toBe(false);
    // The same windows stay allowed without the E1 section.
    expect(soakF4Schema.safeParse({ ...base, windows: [window("only_idle")] }).success).toBe(true);
  });

  it("takes an expected spend of 0 and an optional edit-wave price (0 when absent)", () => {
    const codex = { ...soak7.codex, expected: 0 };
    expect(soakF4Schema.safeParse({ ...base, e1, windows: [], codex }).success).toBe(true);
    expect(soakF4Schema.safeParse({ ...base, codex: { ...codex, expected: -1 } }).success).toBe(
      false
    );
    expect(plannedEntryTokens({ kind: "edit_wave" }, soak7.codex.tokens)).toBe(0);
    expect(plannedEntryTokens({ kind: "edit_wave" }, { ...soak7.codex.tokens, edit_wave: 7 })).toBe(
      7
    );
    expect(
      soakF4Schema.safeParse({ ...base, e1: { ...e1, autonomy: "auto" }, windows: [] }).success
    ).toBe(false);
  });
});
