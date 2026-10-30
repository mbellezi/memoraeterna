import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildTimeline } from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { readSoakPlan } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import { expandWindows } from "../../apps/desktop/src/main/services/dev/soak-plan-f4.ts";

// D38a (owner 10-30): soak7-r1-20261026T0254 stopped on two harness predicates at 95.07 h; its last
// executed action was plan minute 5705 (explain #95). The complement `soak7-tail` runs the rest of
// soak7's plan on a clone of r1's profile: tail minute = soak7 minute - 5675 (30 min of warm-up
// first), nothing at or before 5705 again.
const plan = resolve(import.meta.dirname, "plan.json");
const t0 = 5705;
const shift = 5675;
const minute = 60_000;
/** The local faults keep their own period (no offset field; D1 keeps the driver as it is). */
const localKinds = new Set(["mlx_kill", "gguf_abort"]);
/** soak7-r1's harness spend at its last sample: spent plus reserved in flight (10-30 01:59:16Z). */
const r1HarnessSpend = 1_938_106 + 9_440;
const ownerCeiling = 8_000_000;

describe("the soak7-tail plan (D38a complement of soak7-r1)", () => {
  const soak7 = readSoakPlan(plan, "soak7").profile;
  const tail = readSoakPlan(plan, "soak7-tail").profile;

  it("runs soak7's actions after minute 5705, shifted by -5675, and nothing else", () => {
    const remaining = buildTimeline(soak7)
      .filter((entry) => entry.atMs / minute > t0 && !localKinds.has(entry.kind))
      .map((entry) => `${entry.kind}@${entry.atMs / minute}`);
    const shifted = buildTimeline(tail)
      .filter((entry) => !localKinds.has(entry.kind))
      .map((entry) => `${entry.kind}@${entry.atMs / minute + shift}`);
    expect(shifted).toHaveLength(216);
    expect(shifted.toSorted()).toEqual(remaining.toSorted());
    // The first action comes after the warm-up, at soak7's next explain (5765).
    expect(Math.min(...buildTimeline(tail).map((entry) => entry.atMs / minute))).toBe(90);
  });

  it("opens soak7's windows after 5705, id for id, and no other", () => {
    const remaining = expandWindows(soak7.f4!, soak7.durationHours * 60)
      .filter((window) => window.startMinute > t0)
      .map((window) => ({ ...window, startMinute: window.startMinute - shift }));
    const windows = expandWindows(tail.f4!, tail.durationHours * 60);
    expect(windows).toEqual(remaining);
    expect(windows.map((window) => window.id)).toEqual([
      "w102-unauthorized",
      "pause-5",
      "w114-ranker-invalid",
      "w120-embedder-verifying",
      "pause-6",
      "w132-only-idle",
      "w140-only-ac",
      "w146-money",
      "pause-7"
    ]);
    for (const window of windows) expect(window.startMinute + shift).toBeGreaterThan(t0);
  });

  it("covers soak7's 168 h of plan time with r1's 5705 minutes", () => {
    expect(shift + tail.durationHours * 60).toBeGreaterThanOrEqual(soak7.durationHours * 60);
    expect(tail.warmupMinutes).toBe(t0 - shift);
  });

  it("caps Codex by the registered rule, inside soak7's cap less r1's spend", () => {
    const { expected, cap } = tail.f4!.codex;
    expect(cap).toBe(Math.round(expected * 1.34375 * 1.1));
    expect(r1HarnessSpend + cap).toBeLessThanOrEqual(soak7.f4!.codex.cap);
    expect(soak7.f4!.codex.cap).toBeLessThanOrEqual(ownerCeiling);
    // Soak7's frozen unit costs, factors and injection rates: no new variable.
    expect(tail.f4!.codex.tokens).toEqual(soak7.f4!.codex.tokens);
    expect(tail.f4!.codex.windowTokenFactor).toEqual(soak7.f4!.codex.windowTokenFactor);
    expect(tail.f4!.injection).toEqual(soak7.f4!.injection);
    expect(tail.f4!.money).toEqual(soak7.f4!.money);
  });

  it("draws a new seed, so the corpus order and the seeded picks do not repeat r1's", () => {
    expect(tail.seed).not.toBe(soak7.seed);
    expect(soak7.seed).toBe(20261028);
  });
});
