import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildTimeline } from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { plannedTokensByHour } from "../../apps/desktop/src/main/services/dev/soak-budget.ts";
import {
  readSoakPlan,
  type SoakProfile
} from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import { expandWindows } from "../../apps/desktop/src/main/services/dev/soak-plan-f4.ts";

// F4 D38b (owner 2026-11-11): the dedicated E1 contention run and its pilot. The figures derived
// from the cadence c follow the design's fixed formulas (e1-design-v2 section 5.1), so the freeze
// that sets c* from the pilot moves them together, and this test pins them:
//   waves W = #{k >= 0 : offset + k c <= 1470 - B} (the profile's `untilMinutes` = 1470 - B);
//   window start = offset + k_w c + B + 1, k_w the largest k with that <= 740;
//   kill minutes = offset + k_T c + 2.0, k_T = ceil((T - offset) / c) for T in 360, 600, 960, 1320,
//   moved to the next wave when that wave is inside the window or is an abort's wave.
// B is read from the profile (B = 1470 - `untilMinutes`), so a freeze that sets c*, B and the
// derived figures by these formulas passes; the provisional figures are pinned only while the
// profile's description says its cadence is provisional. The pilot keeps the cadence it ran at.
const plan = resolve(import.meta.dirname, "plan.json");
const minute = 60_000;
/** The provisional busy time B of a wave (minutes), before the freeze puts the pilot's in its place. */
const provisionalBusy = 4.5;
/** B of a profile: its plan length less the last minute a wave may start at. */
const busyOf = (profile: SoakProfile) =>
  profile.durationHours * 60 - profile.driver.editWave!.untilMinutes!;
const killTargets = [360, 600, 960, 1320];
const otherKinds = [
  "article",
  "ask",
  "explain",
  "explain_burst",
  "note_edit",
  "source_reimport",
  "typing_fault",
  "topic_open",
  "contention_burst",
  "burst_edit",
  "post_outage_probe"
];

const wavesOf = (profile: SoakProfile) =>
  buildTimeline(profile)
    .filter((entry) => entry.kind === "edit_wave")
    .map((entry) => entry.atMs / minute);
const killsOf = (profile: SoakProfile) =>
  buildTimeline(profile)
    .filter((entry) => entry.kind === "mlx_kill")
    .map((entry) => entry.atMs / minute);
/** The wave an abort armed at `armed` fires in: the first wave's embeddings after it. */
const abortWave = (waves: readonly number[], armed: number) =>
  waves.findIndex((start) => start >= armed);
const close = (a: number, b: number) => Math.abs(a - b) < 0.001;

describe("the soak7-e1 plan (D38b: the dedicated E1 contention run)", () => {
  const run = readSoakPlan(plan, "soak7-e1").profile;
  const wave = run.driver.editWave!;
  const c = wave.everyMinutes;
  const offset = wave.offsetMinutes;
  const end = run.durationHours * 60;
  const waves = wavesOf(run);
  const busy = busyOf(run);
  const provisional = run.description.includes("provisional");

  it("runs W waves in the plan day by the formula, at fractional minutes spread over the sample phase", () => {
    expect(run.durationHours).toBe(24.5);
    expect(run.warmupMinutes).toBe(30);
    // B: the provisional 4.5 min, or the pilot's largest busy time in whole minutes (the freeze).
    if (provisional) expect(busy).toBe(provisionalBusy);
    else expect(Number.isInteger(busy) && busy >= 1 && busy <= 30).toBe(true);
    // The freeze's grid: c = n + 0.382 with max(10, B + 4) <= c <= 23.382.
    expect(Math.round((c - 0.382) * 1000) % 1000).toBe(0);
    expect(c).toBeGreaterThanOrEqual(Math.max(10, busy + 4));
    expect(c).toBeLessThanOrEqual(23.382);
    let count = 0;
    while (offset + count * c <= end - busy) count += 1;
    expect(waves).toHaveLength(count);
    if (provisional) expect(waves).toHaveLength(100);
    expect(waves[0]).toBeCloseTo(31.4, 6);
    expect(Math.min(...waves)).toBeGreaterThanOrEqual(run.warmupMinutes);
    expect(waves.at(-1)! + busy).toBeLessThanOrEqual(end);
    // Fractional cadence (R6): the waves start at many phases of the minute samples.
    expect(
      new Set(waves.map((start) => Math.round((start % 1) * 100))).size
    ).toBeGreaterThanOrEqual(Math.min(80, Math.floor(0.8 * waves.length)));
    expect(wave.notes).toBe(1000);
    expect(wave.order).toBe("alternate");
  });

  it("places the window and the kills where the formulas put them for the profile's cadence", () => {
    const windows = expandWindows(run.f4!, end);
    expect(windows).toHaveLength(1);
    const window = windows[0]!;
    let kw = 0;
    while (offset + (kw + 1) * c + busy + 1 <= 740) kw += 1;
    expect(close(window.startMinute, offset + kw * c + busy + 1)).toBe(true);
    expect(window).toMatchObject({ kind: "ranker_invalid", durationMinutes: 30, settleMinutes: 2 });
    // The window starts after wave k_w's drain and covers one or two waves; it settles before the next.
    const covered = waves.filter(
      (start) => start >= window.startMinute && start < window.startMinute + window.durationMinutes
    );
    expect(covered.length).toBeGreaterThanOrEqual(1);
    expect(covered.length).toBeLessThanOrEqual(2);
    const after = waves.find((start) => start >= window.startMinute + window.durationMinutes)!;
    expect(after).toBeGreaterThan(
      window.startMinute + window.durationMinutes + window.settleMinutes
    );
    expect(waves[kw]! + busy).toBeLessThan(window.startMinute);

    const aborts = [1, 2].map((index) => index * run.local.ggufAbort.everyMinutes + 17);
    const abortWaves = new Set(aborts.map((armed) => abortWave(waves, armed)));
    if (provisional) expect([...abortWaves]).toEqual([48, 97]);
    const inWindow = (k: number) =>
      waves[k]! >= window.startMinute && waves[k]! < window.startMinute + window.durationMinutes;
    // Two aborts, in two waves of the day.
    expect(abortWaves.size).toBe(2);
    for (const k of abortWaves) expect(k).toBeGreaterThan(0);
    const expected = killTargets.map((target) => {
      let k = Math.ceil((target - offset) / c);
      while (inWindow(k) || abortWaves.has(k)) k += 1;
      return offset + k * c + 2;
    });
    const kills = killsOf(run);
    expect(kills).toHaveLength(4);
    kills.forEach((kill, index) => expect(close(kill, expected[index]!)).toBe(true));
    // Each kill falls 2.0 min into a wave (its ranker phase), outside the window and the abort waves.
    for (const kill of kills) {
      const k = waves.findIndex((start) => close(start + 2, kill));
      expect(k).toBeGreaterThan(0);
      expect(inWindow(k)).toBe(false);
      expect(abortWaves.has(k)).toBe(false);
    }
    expect(run.local.mlxKill.everyMinutes).toBeUndefined();
  });

  it("plays no other action and injects nothing; Codex expected 0 under a 50,000 cap by reservation", () => {
    const kinds = new Set(buildTimeline(run).map((entry) => entry.kind));
    for (const kind of otherKinds) expect(kinds.has(kind as never), kind).toBe(false);
    expect([...kinds].toSorted()).toEqual(["edit_wave", "gguf_abort", "mlx_kill"]);
    expect(run.f4!.injection).toBeUndefined();
    expect(run.remote).toBeUndefined();
    const projected = plannedTokensByHour(
      {
        entries: buildTimeline(run),
        plan: run.f4!,
        windows: expandWindows(run.f4!, end),
        applied: []
      },
      Math.ceil(run.durationHours)
    ).reduce((sum, tokens) => sum + tokens, 0);
    expect(projected).toBe(0);
    expect(run.f4!.codex).toMatchObject({ expected: 0, cap: 50_000, dropFromHour0: 0 });
    expect(run.f4!.e1).toEqual({
      autonomy: "off",
      power: "idle",
      floorReads: "scoped",
      dayOrigin: "warmup_end"
    });
    expect(run.f4!.decisions).toBe("off");
    expect(run.f4!.capture).toBeUndefined();
  });

  it("draws seeds of its own: no other soak's corpus order or picks repeat", () => {
    const pilot = readSoakPlan(plan, "soak7-e1-pilot").profile;
    const seeds = ["soak7", "soak7-gate", "soak7-tail", "soak7-tail2"].map(
      (name) => readSoakPlan(plan, name).profile.seed
    );
    expect(run.seed).toBe(20261114);
    expect(pilot.seed).toBe(20261111);
    for (const seed of seeds) {
      expect(run.seed).not.toBe(seed);
      expect(pilot.seed).not.toBe(seed);
    }
  });
});

describe("the soak7-e1-pilot plan (D38b calibration, never a result)", () => {
  const run = readSoakPlan(plan, "soak7-e1").profile;
  const pilot = readSoakPlan(plan, "soak7-e1-pilot").profile;
  const waves = wavesOf(pilot);
  const c = pilot.driver.editWave!.everyMinutes;
  const offset = pilot.driver.editWave!.offsetMinutes;
  // The pilot runs at the provisional cadence and B; the freeze moves soak7-e1 only.
  const busy = provisionalBusy;
  const frozen = !run.description.includes("provisional");
  const cadenceFree = (profile: SoakProfile) => ({
    ...profile.driver.editWave!,
    untilMinutes: 0,
    ...(frozen ? { everyMinutes: 0 } : {})
  });

  it("runs 8 waves at the provisional cadence (soak7-e1's until the freeze) in 2.5 h, the last done before the end", () => {
    expect(pilot.durationHours).toBe(2.5);
    expect(c).toBe(14.382);
    expect(busyOf(pilot)).toBe(busy);
    expect(cadenceFree(pilot)).toEqual(cadenceFree(run));
    expect(waves).toHaveLength(8);
    waves.forEach((start, k) => expect(close(start, offset + k * c)).toBe(true));
    expect(waves.at(-1)! + busy).toBeLessThanOrEqual(150);
    expect(pilot.description).toContain("calibration only");
  });

  it("covers wave 3 only with its window, kills in waves 1 and 5, the abort in wave 6: U = 0, 2, 4, 7", () => {
    const [window] = expandWindows(pilot.f4!, 150);
    expect(close(window!.startMinute, offset + 2 * c + busy + 1)).toBe(true);
    expect(window!.durationMinutes).toBe(15);
    const covered = waves
      .map((start, k) => [start, k] as const)
      .filter(
        ([start]) =>
          start >= window!.startMinute && start < window!.startMinute + window!.durationMinutes
      )
      .map(([, k]) => k);
    expect(covered).toEqual([3]);
    // Released and drained before wave 4.
    expect(
      window!.startMinute + window!.durationMinutes + window!.settleMinutes + busy
    ).toBeLessThan(waves[4]!);
    const killed = killsOf(pilot).map((kill) => waves.findIndex((start) => close(start + 2, kill)));
    expect(killed).toEqual([1, 5]);
    expect(abortWave(waves, pilot.local.ggufAbort.everyMinutes + 17)).toBe(6);
    expect(2 * pilot.local.ggufAbort.everyMinutes + 17).toBeGreaterThan(150);
    const touched = new Set([...covered, ...killed, 6]);
    expect(waves.map((_, k) => k).filter((k) => !touched.has(k))).toEqual([0, 2, 4, 7]);
  });

  it("differs from soak7-e1 only in what calibration needs (seed, length, faults, window)", () => {
    const strip = (profile: SoakProfile) => ({
      ...profile,
      description: "",
      seed: 0,
      durationHours: 0,
      local: null,
      driver: { ...profile.driver, editWave: cadenceFree(profile) },
      f4: { ...profile.f4!, windows: [] }
    });
    expect(strip(pilot)).toEqual(strip(run));
    expect(pilot.f4!.codex).toEqual(run.f4!.codex);
    expect(pilot.f4!.e1).toEqual(run.f4!.e1);
  });
});
