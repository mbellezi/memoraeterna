import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildTimeline } from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { plannedTokensByHour } from "../../apps/desktop/src/main/services/dev/soak-budget.ts";
import { readSoakPlan } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import { expandWindows } from "../../apps/desktop/src/main/services/dev/soak-plan-f4.ts";

// D38a (owner 11-10): soak7-tail-20261109T1621 ended at tail minute 613 (an operator quit from the
// app's menu bar; clean shutdown, 0 FAIL). Its last executed action was topic_open at tail minute 605,
// soak7 plan minute 6280. The second complement `soak7-tail2` runs the rest of soak7's plan on a
// clone of the tail's profile: tail2 minute = soak7 minute - 6250 (30 min of warm-up first), nothing
// at or before 6280 again.
const plan = resolve(import.meta.dirname, "plan.json");
const t0 = 6280;
const shift = 6250;
const tailShift = 5675;
const minute = 60_000;
/** The local faults keep their own period (no offset field; D1 keeps the driver as it is). */
const localKinds = new Set(["mlx_kill", "gguf_abort"]);
/** soak7-r1's harness spend at its last sample (spent + reserved, 10-30 01:59:16Z). */
const r1HarnessSpend = 1_938_106 + 9_440;
/** soak7-tail's harness spend at its last sample (spent 127,739 + reserved 0, 11-10 02:35:01Z). */
const tailHarnessSpend = 127_739;
const ownerCeiling = 8_000_000;

describe("the soak7-tail2 plan (D38a second complement, after soak7-tail)", () => {
  const soak7 = readSoakPlan(plan, "soak7").profile;
  const tail = readSoakPlan(plan, "soak7-tail").profile;
  const tail2 = readSoakPlan(plan, "soak7-tail2").profile;

  it("runs soak7's actions after minute 6280, shifted by -6250, and nothing else", () => {
    const remaining = buildTimeline(soak7)
      .filter((entry) => entry.atMs / minute > t0 && !localKinds.has(entry.kind))
      .map((entry) => `${entry.kind}@${entry.atMs / minute}`);
    const shifted = buildTimeline(tail2)
      .filter((entry) => !localKinds.has(entry.kind))
      .map((entry) => `${entry.kind}@${entry.atMs / minute + shift}`);
    expect(shifted.length).toBeGreaterThan(150);
    expect(shifted.toSorted()).toEqual(remaining.toSorted());
    // The first action comes after the warm-up.
    expect(Math.min(...buildTimeline(tail2).map((entry) => entry.atMs / minute))).toBeGreaterThan(
      tail2.warmupMinutes
    );
  });

  it("is the tail's own plan after the tail's last action, re-shifted by -575", () => {
    const tailRest = buildTimeline(tail)
      .filter((entry) => entry.atMs / minute + tailShift > t0 && !localKinds.has(entry.kind))
      .map((entry) => `${entry.kind}@${entry.atMs / minute + tailShift}`);
    const shifted = buildTimeline(tail2)
      .filter((entry) => !localKinds.has(entry.kind))
      .map((entry) => `${entry.kind}@${entry.atMs / minute + shift}`)
      .filter((at) => Number(at.split("@")[1]) <= tailShift + tail.durationHours * 60);
    expect(shifted.toSorted()).toEqual(tailRest.toSorted());
  });

  it("opens soak7's windows after 6280, id for id, and no other", () => {
    const remaining = expandWindows(soak7.f4!, soak7.durationHours * 60)
      .filter((window) => window.startMinute > t0)
      .map((window) => ({ ...window, startMinute: window.startMinute - shift }));
    const tailWindows = new Map(
      expandWindows(tail.f4!, tail.durationHours * 60).map((window) => [window.id, window])
    );
    const windows = expandWindows(tail2.f4!, tail2.durationHours * 60);
    expect(windows.map((window) => window.id)).toEqual([
      "pause-5",
      "w114-ranker-invalid",
      "w120-embedder-verifying",
      "pause-6",
      "w132-only-idle",
      "w140-only-ac",
      "w146-money",
      "pause-7"
    ]);
    // soak7's windows (the pauses are the tail's explicit ones) at the same shift, settings unchanged.
    const soak7Ids = new Set(remaining.map((window) => window.id));
    for (const window of windows) {
      expect(window.startMinute + shift).toBeGreaterThan(t0);
      const own = tailWindows.get(window.id)!;
      expect({ ...window, startMinute: window.startMinute + shift }).toEqual({
        ...own,
        startMinute: own.startMinute + tailShift
      });
      if (soak7Ids.has(window.id))
        expect(window).toEqual(remaining.find((other) => other.id === window.id));
    }
  });

  it("covers soak7's 168 h of plan time with r1's and the tail's minutes", () => {
    expect(shift + tail2.durationHours * 60).toBeGreaterThanOrEqual(soak7.durationHours * 60);
    expect(tail2.warmupMinutes).toBe(t0 - shift);
  });

  it("caps Codex by the registered rule, inside soak7's cap less r1's and the tail's spend", () => {
    const { expected, cap } = tail2.f4!.codex;
    const windows = expandWindows(tail2.f4!, tail2.durationHours * 60);
    const projected = plannedTokensByHour(
      { entries: buildTimeline(tail2), plan: tail2.f4!, windows, applied: [] },
      Math.ceil(tail2.durationHours)
    ).reduce((sum, tokens) => sum + tokens, 0);
    expect(expected).toBe(Math.round(projected));
    expect(cap).toBe(Math.round(expected * 1.34375 * 1.1));
    expect(r1HarnessSpend + tailHarnessSpend + cap).toBeLessThanOrEqual(soak7.f4!.codex.cap);
    expect(soak7.f4!.codex.cap).toBeLessThanOrEqual(ownerCeiling);
    // Soak7's frozen unit costs, factors, injection rates, bounds and local faults: no new variable.
    expect(tail2.f4!.codex.tokens).toEqual(soak7.f4!.codex.tokens);
    expect(tail2.f4!.codex.windowTokenFactor).toEqual(soak7.f4!.codex.windowTokenFactor);
    expect(tail2.f4!.injection).toEqual(soak7.f4!.injection);
    expect(tail2.f4!.money).toEqual(soak7.f4!.money);
    expect(tail2.bounds).toEqual(soak7.bounds);
    expect(tail2.local).toEqual(soak7.local);
    expect(tail2.f4!.decisions).toEqual(soak7.f4!.decisions);
  });

  it("draws a new seed, so the corpus order and the seeded picks repeat neither r1's nor the tail's", () => {
    expect(tail2.seed).not.toBe(soak7.seed);
    expect(tail2.seed).not.toBe(tail.seed);
  });
});
