import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { relationsConfig } from "@app/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  decideDrop,
  droppedBy,
  hourFactor,
  plannedTokensByHour,
  projectSpend
} from "./soak-budget.js";
import { discoveryNeighboursKnob, helperBatchKnob } from "./relations-dev-options.js";
import { buildTimeline, type TimelineEntry } from "./soak-driver.js";
import {
  SoakKnobRefusal,
  discoveryNeighboursKnobName,
  fakeRemoteKnobName,
  readSoakKnob,
  readSoakPlan,
  soakConflictingKnobs,
  soakKnobName,
  soakPlanFileSchema
} from "./soak-plan.js";
import { expandWindows } from "./soak-plan-f4.js";
import { decisionsAdmitKnobName, realWriterKnobName } from "./soak-real-writer.js";

const repository = resolve(import.meta.dirname, "../../../../../..");
const planPath = join(repository, "scripts", "soak", "plan.json");
const hour = 3_600_000;
const minute = 60_000;

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("the 7-day profile of the plan", () => {
  const { profile } = readSoakPlan(planPath, "soak7");
  const f4 = profile.f4!;

  it("runs seven days and a half hour of warm-up in F4's run folder, with no fake provider", () => {
    expect(profile).toMatchObject({
      seed: 20261028,
      durationHours: 168,
      warmupMinutes: 30,
      runFolder: "f4"
    });
    expect(profile.remote).toBeUndefined();
    expect(f4.decisions).toBe("off");
  });

  it("freezes the expected spend and the cap, and the plan cannot be read without them", () => {
    expect(f4.codex).toMatchObject({ expected: 3_200_000, cap: 4_700_000, dropFromHour0: 0 });
    const raw = JSON.parse(readFileSync(planPath, "utf8")) as {
      profiles: Record<string, { f4: { codex: Record<string, unknown> } }>;
    };
    for (const missing of ["expected", "cap"]) {
      const broken = structuredClone(raw);
      delete broken.profiles.soak7!.f4.codex[missing];
      expect(soakPlanFileSchema.safeParse(broken).success, missing).toBe(false);
    }
  });

  it("plays the cadence of spec 5.4 over 168 h", () => {
    const timeline = buildTimeline(profile);
    const count = (kind: string) => timeline.filter((entry) => entry.kind === kind).length;
    // Four imports a day: three articles and, one a day, a re-import (odd days) or a typing fault (even days).
    expect(count("article")).toBe(21);
    expect(count("source_reimport")).toBe(4);
    expect(count("typing_fault")).toBe(3);
    expect(count("article") + count("source_reimport") + count("typing_fault")).toBe(28);
    expect(count("ask")).toBe(56);
    expect(count("explain")).toBe(168);
    expect(count("explain_burst")).toBe(14);
    expect(count("note_edit")).toBe(56);
    expect(count("topic_open")).toBe(84);
    expect(count("contention_burst")).toBe(14);
    expect(count("burst_edit")).toBe(84);
    expect(count("gguf_abort")).toBeGreaterThanOrEqual(13);
    expect(count("mlx_kill")).toBeGreaterThanOrEqual(27);
    expect(timeline.map((entry) => entry.atMs)).toEqual(
      timeline.map((entry) => entry.atMs).toSorted((a, b) => a - b)
    );
  });

  it("keeps the odd-day re-import on odd days and the typing-fault source on even days", () => {
    const timeline = buildTimeline(profile);
    const day = (entry: TimelineEntry) => Math.floor(entry.atMs / (24 * hour)) + 1;
    expect(timeline.filter((e) => e.kind === "source_reimport").map(day)).toEqual([1, 3, 5, 7]);
    expect(timeline.filter((e) => e.kind === "typing_fault").map(day)).toEqual([2, 4, 6]);
  });

  it("puts the bursts at hour 6 + 12k, each with six edits two minutes apart in six roots", () => {
    const timeline = buildTimeline(profile);
    const bursts = timeline.filter((entry) => entry.kind === "contention_burst");
    expect(bursts.map((entry) => entry.atMs / hour).slice(0, 4)).toEqual([6, 18, 30, 42]);
    const edits = timeline.filter((entry) => entry.kind === "burst_edit").slice(0, 6);
    expect(edits.map((entry) => (entry.atMs - 6 * hour) / minute)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(edits.map((entry) => entry.index % 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("holds the twelve windows of the table, none overlapping, and a daily pause at hour 10 + 24k", () => {
    const windows = expandWindows(f4, profile.durationHours * 60);
    const named = windows.filter((window) => !window.id.startsWith("pause"));
    expect(
      named.map((w) => [w.id.slice(0, 4), w.startMinute / 60, w.durationMinutes / 60])
    ).toEqual([
      ["w030", 30, 2],
      ["w044", 44, 2],
      ["w054", 54, 0.25],
      ["w066", 66, 6],
      ["w078", 78, 1 / 3],
      ["w084", 84, 12],
      ["w102", 102, 1 / 6],
      ["w114", 114, 0.5],
      ["w120", 120, 1 / 6],
      ["w132", 132, 4],
      ["w140", 140, 1],
      ["w146", 146, 6]
    ]);
    const pauses = windows.filter((window) => window.id.startsWith("pause"));
    expect(pauses.map((w) => [w.startMinute / 60, w.durationMinutes])).toEqual(
      [10, 34, 58, 82, 106, 130, 154].map((start) => [start, 30])
    );
    for (const [index, window] of windows.entries()) {
      const next = windows[index + 1];
      if (next)
        expect(window.startMinute + window.durationMinutes).toBeLessThanOrEqual(next.startMinute);
    }
  });

  it("expects the status the table names, and the mid-run cap lowers the daily cap by ten calls", () => {
    const windows = expandWindows(f4, 168 * 60);
    const expectation = (prefix: string) =>
      windows.find((window) => window.id.startsWith(prefix))?.expect;
    expect(expectation("w030")).toEqual({ class: "waiting", reason: "provider_rate_limit" });
    expect(expectation("w044")).toEqual({ class: "paused", reason: "autonomy_off" });
    expect(expectation("w054")).toEqual({ class: "waiting", reason: "provider_unavailable" });
    expect(expectation("w066")).toBeUndefined();
    expect(expectation("w078")).toEqual({ class: "offline", reason: "network_unreachable" });
    expect(expectation("w084")).toEqual({ class: "cap", reason: "subscription_daily" });
    expect(windows.find((w) => w.id.startsWith("w084"))?.params.extraCalls).toBe(10);
    expect(expectation("w102")).toEqual({ class: "no_model", reason: "signin_required" });
    expect(expectation("w114")).toEqual({ class: "no_model", reason: "no_decider" });
    expect(expectation("w120")).toEqual({ class: "download", reason: "model_verifying" });
    expect(expectation("w132")).toEqual({ class: "paused", reason: "only_idle_user_active" });
    expect(expectation("w140")).toEqual({ class: "paused", reason: "only_ac_on_battery" });
    expect(expectation("pause-1")).toEqual({ class: "paused", reason: "user_pause" });
    // The money window's two stages are expected at run time, when the budget reaches them.
    expect(expectation("w146")).toBeUndefined();
    expect(windows.find((w) => w.id.startsWith("w146"))?.params).toMatchObject({
      attempts: 8,
      backfillRelations: 10,
      continueAfterMinutes: 10
    });
  });

  it("injects the fault rates of the table at the fetch layer, seeded", () => {
    expect(f4.injection).toMatchObject({
      rates: {
        rateLimit: 0.02,
        unavailable: 0.01,
        lateFirstByte: 0.005,
        stall: 0.002,
        malformed: 0.003,
        unauthorized: 0.001,
        contextOverflow: 0.001
      },
      retryAfterSeconds: [1, 10],
      stallMs: 25_000,
      lateFirstByteMs: 35_000
    });
  });

  it("plans about 452k tokens a day, the table's total, and 3.2M over the run", () => {
    const entries = buildTimeline(profile);
    const planned = plannedTokensByHour({ entries, plan: f4, windows: [], applied: [] }, 168);
    const perDay = planned.slice(0, 24).reduce((sum, value) => sum + value, 0);
    expect(perDay).toBeGreaterThan(440_000);
    expect(perDay).toBeLessThan(465_000);
    const total = planned.reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThan(3_000_000);
    expect(total).toBeLessThan(3_300_000);
  });
});

describe("the gate S profile", () => {
  const { profile } = readSoakPlan(planPath, "soak7-gate");

  it("plays every window kind once, the harness-cap window of 20 minutes and the daily pause, in about five and a half hours", () => {
    const windows = expandWindows(profile.f4!, profile.durationHours * 60);
    expect(new Set(windows.map((window) => window.kind))).toEqual(
      new Set([
        "usage_limit",
        "autonomy_off",
        "refused",
        "autonomy_suggest",
        "enotfound",
        "codex_daily_cap",
        "unauthorized",
        "ranker_invalid",
        "embedder_verifying",
        "only_idle",
        "only_ac",
        "money",
        "pause",
        "harness_cap"
      ])
    );
    expect(windows.find((window) => window.kind === "harness_cap")?.durationMinutes).toBe(20);
    expect(
      windows
        .filter((window) => ["codex_daily_cap", "money"].includes(window.kind))
        .map((w) => w.durationMinutes)
    ).toEqual([30, 30]);
    for (const [index, window] of windows.entries()) {
      const next = windows[index + 1];
      // A gap for the status to settle between two windows.
      if (next)
        expect(
          next.startMinute - (window.startMinute + window.durationMinutes)
        ).toBeGreaterThanOrEqual(5);
    }
    const last = windows.at(-1)!;
    expect(last.startMinute + last.durationMinutes).toBeLessThanOrEqual(profile.durationHours * 60);
    expect(profile.durationHours).toBeLessThanOrEqual(5.5);
  });

  it("brings more background calls to the mid-run cap than its headroom, so the 30 minutes cross it", () => {
    // Gate S of 10-25: calls so far + 10 in 30 minutes met 3 background calls and never crossed.
    const window = expandWindows(profile.f4!, profile.durationHours * 60).find(
      (entry) => entry.kind === "codex_daily_cap"
    )!;
    expect(window.params.backfillRelations).toBeGreaterThan(window.params.extraCalls! + 1);
  });

  it("aims its forced malformed answer at a structured caller and no other forced fault at one", () => {
    // Gate S of 10-25: the one malformed answer reached a summary, which never repairs.
    const forced = profile.f4!.injection!.forced;
    expect(forced.find((entry) => entry.kind === "malformed")).toMatchObject({
      afterMinute: 3,
      count: 1,
      aim: "structured"
    });
    expect(forced.filter((entry) => entry.aim !== undefined)).toHaveLength(1);
  });

  it("gives the windows whose condition affects only some work that work, so the sentence has something to name", () => {
    // Gate S of 10-25: g070 met its first call at minute 9 of 10, g170 set no task aside no_decider
    // and g190 found no Gardener work in progress, so their classes were never compared.
    const windows = expandWindows(profile.f4!, profile.durationHours * 60);
    const window = (id: string) => windows.find((entry) => entry.id === id)!;

    // A refused connection: backfill calls at the start meet it at once and are set aside.
    const refused = window("g070-refused");
    expect(refused.params.backfillRelations).toBeGreaterThanOrEqual(2);
    expect(refused.params.backfillDelayMinutes).toBeUndefined();

    // A missing decider: edited notes queue their match (60 s debounce), which it sets aside.
    const ranker = window("g170-ranker-invalid");
    expect(ranker.params.noteEdits).toBeGreaterThanOrEqual(1);
    // The match is due after the debounce and the task stays set aside to the window's end: the
    // window must outlast the settle and that wait by a few samples.
    expect(ranker.durationMinutes * minute).toBeGreaterThanOrEqual(
      ranker.settleMinutes * minute + relationsConfig.match.debounceMs + 3 * minute
    );

    // A model being verified: backfills due late stay work in progress (within the status's 5
    // minutes) for several samples after the settle, and call only when the window is nearly over.
    const embedder = window("g190-embedder-verifying");
    const delay = embedder.params.backfillDelayMinutes!;
    expect(embedder.params.backfillRelations).toBeGreaterThanOrEqual(1);
    expect(delay).toBeGreaterThanOrEqual(embedder.settleMinutes + 3);
    expect(delay).toBeLessThanOrEqual(embedder.settleMinutes + 5);
    expect(delay).toBeLessThan(embedder.durationMinutes);
  });

  it("keeps every answer in this profile and in no other 7-day profile", () => {
    expect(profile.f4!.capture).toBe("answers");
    expect(readSoakPlan(planPath, "soak7").profile.f4!.capture).toBeUndefined();
  });

  it("forces a burst of every fault kind so each ends a whole call", () => {
    const kinds = new Set(profile.f4!.injection!.forced.map((entry) => entry.kind));
    expect(kinds).toEqual(
      new Set([
        "rate_limit",
        "unavailable",
        "late_first_byte",
        "stall",
        "malformed",
        "unauthorized",
        "context_overflow"
      ])
    );
  });
});

describe("the knobs of the 7-day soak", () => {
  const writerId = "5a1d2f50-3c1e-4d7a-9b38-0d2f2f6a7c11";

  /** A worktree holding the plan and a data root with a profile folder, as the outside soak has. */
  function setup() {
    const worktree = mkdtempSync(join(tmpdir(), "soak7-worktree-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "soak7-data-"));
    scratch.push(worktree, dataRoot);
    mkdirSync(join(worktree, "scripts", "soak"), { recursive: true });
    writeFileSync(join(worktree, "scripts", "soak", "plan.json"), readFileSync(planPath, "utf8"));
    mkdirSync(join(dataRoot, "profiles", "env-soak7"), { recursive: true });
    return {
      worktree,
      dataRoot,
      options: {
        isPackaged: false,
        workspaceRoot: worktree,
        userDataPath: join(dataRoot, "profiles", "env-soak7")
      },
      env: (extra: Record<string, string> = {}) => ({
        [soakKnobName]: "scripts/soak/plan.json",
        MEMORA_SOAK_PROFILE: "soak7",
        MEMORA_SOAK_DATA_ROOT: dataRoot,
        [realWriterKnobName]: writerId,
        ...extra
      })
    };
  }

  it("run from a worktree outside the checkout against the data root's profile, with the real writer and no fakes", () => {
    const { options, env, dataRoot } = setup();
    const settings = readSoakKnob(soakKnobName, env(), options)!;
    expect(settings.profileName).toBe("soak7");
    expect(settings.realWriter).toEqual({ providerConfigId: writerId });
    expect(settings.paths.cacheRoot).toBe(dataRoot);
    expect(settings.decisions).toBeNull();
  });

  it("run gate S, which keeps every answer, on its own profile folder and no other: the owner confirmed the retention for that one", () => {
    const { options, env, dataRoot } = setup();
    for (const folder of ["env-soak7-gate", "env-soak7-run", "env-soak7-gate-r1"])
      mkdirSync(join(dataRoot, "profiles", folder), { recursive: true });
    const at = (folder: string) => ({
      ...options,
      userDataPath: join(dataRoot, "profiles", folder)
    });
    const gate = env({ MEMORA_SOAK_PROFILE: "soak7-gate" });
    expect(readSoakKnob(soakKnobName, gate, at("env-soak7-gate"))?.profileName).toBe("soak7-gate");
    for (const folder of ["env-soak7", "env-soak7-run", "env-soak7-gate-r1"])
      expect(() => readSoakKnob(soakKnobName, gate, at(folder))).toThrow(
        expect.objectContaining({ code: "capture" })
      );
    // The 7-day soak asks for no capture and runs on its clones as before.
    expect(readSoakKnob(soakKnobName, env(), at("env-soak7-run"))?.profileName).toBe("soak7");
  });

  it("refuse the profile without the real writer: its spend is bounded by the cap the writer runs under", () => {
    const { options, env } = setup();
    const withoutWriter = env();
    delete (withoutWriter as Record<string, string | undefined>)[realWriterKnobName];
    expect(() => readSoakKnob(soakKnobName, withoutWriter, options)).toThrow(
      expect.objectContaining({ code: "needsRealWriter" })
    );
  });

  it("refuse the real writer on an F3 profile, which has no token cap", () => {
    const { options, env } = setup();
    expect(() =>
      readSoakKnob(
        soakKnobName,
        env({ MEMORA_SOAK_PROFILE: "soak24", [fakeRemoteKnobName]: "scripts/soak/plan.json" }),
        options
      )
    ).toThrow(expect.objectContaining({ code: "realWriter" }));
  });

  it("refuse a profile folder outside the data root's profiles, the worktree's own .cache included", () => {
    const { options, env, worktree } = setup();
    mkdirSync(join(worktree, ".cache", "profiles", "env-soak7"), { recursive: true });
    for (const userDataPath of [
      join(worktree, ".cache", "profiles", "env-soak7"),
      join(worktree, "library")
    ])
      expect(() => readSoakKnob(soakKnobName, env(), { ...options, userDataPath })).toThrow(
        expect.objectContaining({ code: "outsideProfiles" })
      );
  });

  it("refuse the knob that sets the discovery neighbours, and the helper batch, inside a soak run", () => {
    const { options, env } = setup();
    expect(soakConflictingKnobs).toContain("MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS");
    expect(discoveryNeighboursKnobName).toBe("MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS");
    // The very knobs the relations configuration of a DEV run reads (T88's C2 knob, T63's B1).
    expect(discoveryNeighboursKnobName).toBe(discoveryNeighboursKnob);
    expect(soakConflictingKnobs).toContain(helperBatchKnob);
    for (const knob of [discoveryNeighboursKnobName, "MEMORA_RELATIONS_HELPER_BATCH"])
      for (const value of ["1", "2"])
        expect(() => readSoakKnob(soakKnobName, env({ [knob]: value }), options), knob).toThrow(
          expect.objectContaining({ code: "conflictingKnob" })
        );
  });

  it("refuse the Decisions decider's DEV knobs unless the dormant admission names them", () => {
    const { options, env } = setup();
    for (const knob of [
      "MEMORA_RELATIONS_DECISIONS",
      "MEMORA_RELATIONS_DECISIONS_KEY_FILE",
      "MEMORA_RELATIONS_DECISIONS_CAP_USD"
    ])
      expect(() => readSoakKnob(soakKnobName, env({ [knob]: "on" }), options), knob).toThrow(
        expect.objectContaining({ code: "conflictingKnob" })
      );
    // The 7-day soak's plan keeps Decisions off, so even the admission is refused for it.
    expect(() =>
      readSoakKnob(
        soakKnobName,
        env({ [decisionsAdmitKnobName]: "1", MEMORA_RELATIONS_DECISIONS: "on" }),
        options
      )
    ).toThrow(expect.objectContaining({ code: "decisions" }));
  });

  it("admit the Decisions decider only for a plan profile that says so, with the owner-only key file and a daily cap of at most US$0.50", () => {
    const { options, env, worktree, dataRoot } = setup();
    // C4's remote check: a profile of the plan that names the admission.
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.profiles.soak7.f4.decisions = "admitted";
    writeFileSync(join(worktree, "scripts", "soak", "plan.json"), JSON.stringify(plan));
    const keyFile = join(dataRoot, "decisions-key");
    writeFileSync(keyFile, "synthetic-key-for-the-test\n", { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const admitted = (extra: Record<string, string> = {}) =>
      env({
        [decisionsAdmitKnobName]: "1",
        MEMORA_RELATIONS_DECISIONS: "on",
        MEMORA_RELATIONS_DECISIONS_KEY_FILE: keyFile,
        MEMORA_RELATIONS_DECISIONS_CAP_USD: "0.50",
        ...extra
      });
    expect(readSoakKnob(soakKnobName, admitted(), options)!.decisions).toEqual({ capUsd: 0.5 });
    // Each condition on its own: a cap above the ceiling, a relative key path, the opt-in knob off.
    for (const extra of [
      { MEMORA_RELATIONS_DECISIONS_CAP_USD: "0.9" },
      { MEMORA_RELATIONS_DECISIONS_KEY_FILE: "key" },
      { MEMORA_RELATIONS_DECISIONS: "off" }
    ])
      expect(
        () => readSoakKnob(soakKnobName, admitted(extra), options),
        JSON.stringify(extra)
      ).toThrow(expect.objectContaining({ code: "decisions" }));
    // A key file others can read.
    chmodSync(keyFile, 0o644);
    expect(() => readSoakKnob(soakKnobName, admitted(), options)).toThrow(
      expect.objectContaining({ code: "decisions" })
    );
    chmodSync(keyFile, 0o600);
    // Without the real writer the admission has nothing to admit.
    const noWriter = admitted();
    delete (noWriter as Record<string, string | undefined>)[realWriterKnobName];
    expect(() => readSoakKnob(soakKnobName, noWriter, options)).toThrow(SoakKnobRefusal);
  });

  it("are refused when packaged", () => {
    const { options, env } = setup();
    expect(() => readSoakKnob(soakKnobName, env(), { ...options, isPackaged: true })).toThrow(
      SoakKnobRefusal
    );
  });
});

describe("the drop steps", () => {
  const { profile } = readSoakPlan(planPath, "soak7");
  const f4 = profile.f4!;
  const entries = buildTimeline(profile);
  const durationMs = profile.durationHours * hour;

  it("keep the even entries of their kind and leave note edits, bursts and a floor of imports and Asks", () => {
    const all = new Set([1, 2, 3, 4, 5]);
    const kept = (kind: string) =>
      entries.filter((entry) => entry.kind === kind && droppedBy(entry, all) === null).length;
    const baseline = (kind: string) => entries.filter((entry) => entry.kind === kind).length;
    expect(kept("explain_burst")).toBe(0);
    expect(kept("explain")).toBe(baseline("explain") / 2);
    expect(kept("ask")).toBe(baseline("ask") / 2);
    expect(kept("topic_open")).toBe(baseline("topic_open") / 2);
    expect(kept("article")).toBe(Math.ceil(baseline("article") / 2));
    expect(kept("note_edit")).toBe(baseline("note_edit"));
    expect(kept("burst_edit")).toBe(baseline("burst_edit"));
    expect(kept("contention_burst")).toBe(baseline("contention_burst"));
    // At least two imports and four Asks a day survive every step.
    const day = (entry: TimelineEntry) => Math.floor(entry.atMs / (24 * hour));
    for (let index = 0; index < 7; index += 1) {
      const imports = entries.filter(
        (entry) =>
          day(entry) === index &&
          ["article", "source_reimport", "typing_fault"].includes(entry.kind) &&
          droppedBy(entry, all) === null
      );
      const asks = entries.filter(
        (entry) => day(entry) === index && entry.kind === "ask" && droppedBy(entry, all) === null
      );
      expect(imports.length).toBeGreaterThanOrEqual(2);
      expect(asks.length).toBeGreaterThanOrEqual(4);
    }
  });

  const input = (overrides: Partial<Parameters<typeof decideDrop>[0]> = {}) => ({
    entries,
    plan: f4,
    windows: expandWindows(f4, profile.durationHours * 60),
    applied: [],
    nowMs: 25 * hour,
    spentTokens: 800_000,
    capTokens: 4_700_000,
    durationMs,
    actualByHour: Array.from({ length: 25 }, () => 19_000),
    ...overrides
  });

  it("apply nothing while spent plus the projection fits the cap", () => {
    const decision = decideDrop(input());
    expect(decision.willPassCap).toBe(false);
    expect(decision.step).toBeNull();
    expect(decision.overFloor).toBe(false);
  });

  it("scale the projection by measured over planned outside the window hours", () => {
    const base = projectSpend(input());
    const doubled = projectSpend(input({ actualByHour: Array.from({ length: 25 }, () => 38_000) }));
    expect(base.hoursInRatio).toBeGreaterThanOrEqual(6);
    expect(doubled.ratio / base.ratio).toBeCloseTo(2, 5);
    expect(doubled.projectedTokens / base.projectedTokens).toBeCloseTo(2, 2);
    // Before six hours outside the windows the ratio is 1.
    expect(projectSpend(input({ nowMs: 3 * hour, actualByHour: [1, 1, 1] })).ratio).toBe(1);
  });

  it("take the next step each time the projection passes the cap, never reverted, and then report the floor", () => {
    const applied: Array<{ step: number; atMs: number }> = [];
    const steps: Array<number | null> = [];
    for (let check = 0; check < 7; check += 1) {
      const decision = decideDrop(input({ applied, capTokens: 1_000_000 }));
      steps.push(decision.step);
      if (decision.step !== null) applied.push({ step: decision.step, atMs: 25 * hour });
      if (check === 5) expect(decision.overFloor).toBe(true);
    }
    expect(steps).toEqual([1, 2, 3, 4, 5, null, null]);
  });

  it("scale the planned hours by what the windows block", () => {
    const windows = expandWindows(f4, profile.durationHours * 60);
    // Hours 30 and 31 are the usage-limit window: no remote tokens are planned in them.
    expect(hourFactor(30, windows, f4.codex.windowTokenFactor)).toBe(0);
    expect(hourFactor(31, windows, f4.codex.windowTokenFactor)).toBe(0);
    expect(hourFactor(32, windows, f4.codex.windowTokenFactor)).toBe(1);
    expect(hourFactor(44, windows, f4.codex.windowTokenFactor)).toBe(0.75);
  });
});
