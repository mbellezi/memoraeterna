import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAiLaneProbeConfig, type LaneSnapshot } from "@app/ai";

import { laneProbePrompt, laneProbeNotes } from "./lane-probe-fixture.js";
import {
  laneProbePlan,
  laneProbeRequested,
  laneProbeVerdict,
  measureLanes,
  readLaneProbeKnob,
  runLaneProbe,
  type LaneProbeAi,
  type LaneProbeLevelReport
} from "./lane-probe.js";

const dev = { isPackaged: false, workspaceRoot: "/work/memora" };
const knob = (value: string, extra: Record<string, string> = {}) => ({
  MEMORA_DEV_LANE_PROBE: value,
  ...extra
});

describe("MEMORA_DEV_LANE_PROBE knob", () => {
  it("is off when unset or blank, packaged or not", () => {
    expect(readLaneProbeKnob({}, dev)).toBeNull();
    expect(readLaneProbeKnob(knob("  "), dev)).toBeNull();
    expect(readLaneProbeKnob({}, { ...dev, isPackaged: true })).toBeNull();
  });

  it("names a JSON report under the workspace's .cache", () => {
    expect(readLaneProbeKnob(knob(".cache/f3/b5/lane-probe.json"), dev)).toBe(
      resolve("/work/memora/.cache/f3/b5/lane-probe.json")
    );
    expect(readLaneProbeKnob(knob(" .cache/lane.json "), dev)).toBe(
      resolve("/work/memora/.cache/lane.json")
    );
  });

  it("is refused in a packaged build", () => {
    expect(() =>
      readLaneProbeKnob(knob(".cache/lane-probe.json"), { ...dev, isPackaged: true })
    ).toThrow("MEMORA_DEV_LANE_PROBE is refused in packaged builds");
  });

  it("is refused with a cassette or another measurement run", () => {
    for (const name of ["MEMORA_AI_CASSETTE", "MEMORA_GOLDEN_RUN", "MEMORA_MATCHING_BENCHMARK"])
      expect(() =>
        readLaneProbeKnob(knob(".cache/lane-probe.json", { [name]: "replay" }), dev)
      ).toThrow(`refused with ${name}`);
  });

  it("is refused for a report outside .cache or that is not a JSON file", () => {
    for (const value of [
      "lane-probe.json",
      "../outside/lane-probe.json",
      "/etc/lane-probe.json",
      ".cache/lane-probe.txt",
      ".cache",
      ".cache/../src/lane-probe.json",
      "1"
    ])
      expect(() => readLaneProbeKnob(knob(value), dev)).toThrow("must name a .json report");
  });
});

describe("a probe the app starts for", () => {
  it("is requested only by a knob the probe accepts, so a refused knob leaves the app as it was", () => {
    const report = ".cache/f3/b5/lane-probe.json";
    expect(laneProbeRequested(knob(report), dev)).toBe(true);
    expect(laneProbeRequested({}, dev)).toBe(false);
    expect(laneProbeRequested(knob(report), { ...dev, isPackaged: true })).toBe(false);
    expect(laneProbeRequested(knob(report, { MEMORA_GOLDEN_RUN: "m.json" }), dev)).toBe(false);
    expect(laneProbeRequested(knob("report.json"), dev)).toBe(false);
  });
});

describe("lane probe plan", () => {
  it("spends about 40 calls on concurrency 1, 2 and 3 in proportion to the concurrency", () => {
    expect(laneProbePlan(defaultAiLaneProbeConfig)).toEqual([
      { concurrency: 1, calls: 7 },
      { concurrency: 2, calls: 13 },
      { concurrency: 3, calls: 20 }
    ]);
  });

  it("always spends exactly the configured calls, with a full round at every level", () => {
    for (const calls of [6, 7, 8, 11, 40, 99, 500])
      for (const levels of [[1, 2, 3], [2, 4], [1], [3, 5, 8]]) {
        const slots = levels.reduce((sum, level) => sum + level, 0);
        if (calls < slots) continue;
        const plan = laneProbePlan({ levels, calls });
        expect(plan.reduce((sum, level) => sum + level.calls, 0)).toBe(calls);
        for (const level of plan) expect(level.calls).toBeGreaterThanOrEqual(level.concurrency);
      }
  });
});

describe("lane probe prompts", () => {
  it("are decide-sized, distinct per call and a function of the call number alone", () => {
    const prompts = Array.from({ length: 40 }, (_, index) => laneProbePrompt(index));
    expect(new Set(prompts).size).toBe(40);
    expect(laneProbePrompt(3)).toBe(laneProbePrompt(3));
    for (const prompt of prompts) {
      // About 1.3k tokens at 4 characters each.
      expect(prompt.length).toBeGreaterThan(4_000);
      expect(prompt.length).toBeLessThan(6_500);
      expect(prompt).toContain("Note A (");
      expect(prompt).toContain("Note J (");
    }
    // No two calls start the same way, so a provider cannot serve one from a cached prefix.
    expect(new Set(prompts.map((prompt) => prompt.slice(0, 40))).size).toBe(40);
    expect(laneProbeNotes).toHaveLength(12);
  });
});

function level(
  concurrency: number,
  callsPerMinute: number | null,
  extra: Partial<LaneProbeLevelReport> = {}
): LaneProbeLevelReport {
  return {
    concurrency,
    calls: 10,
    attempted: 10,
    ok: callsPerMinute === null ? 0 : 10,
    failed: 0,
    retried: 0,
    rateLimits: 0,
    wallMs: 1_000,
    callsPerMinute,
    latencyMs: { p50: 3_000, p95: 4_000, max: 5_000 },
    inputTokens: null,
    outputTokens: null,
    errors: [],
    ...extra
  };
}

describe("lane probe verdict", () => {
  it("supports a Codex maximum of 3 only when 1, 2 and 3 all ran without a 429 or a failure", () => {
    const verdict = laneProbeVerdict([level(1, 20), level(2, 38), level(3, 54)]);
    expect(verdict).toMatchObject({
      codexMax: 3,
      gain: { "1": 1, "2": 1.9, "3": 2.7 },
      measuredC: 2.7,
      rOverCFactor: 0.74
    });
    expect(verdict.note).toContain("the Codex maximum can be 3");
  });

  it("stays at the last clean level when a higher one saw a 429 or a failed call", () => {
    const limited = laneProbeVerdict([level(1, 20), level(2, 38), level(3, 54, { rateLimits: 2 })]);
    expect(limited.codexMax).toBe(2);
    expect(limited.measuredC).toBe(1.9);
    expect(limited.rOverCFactor).toBe(1.05);
    expect(limited.note).toContain("Concurrency 3 saw 2 rate limits");
    const failed = laneProbeVerdict([level(1, 20), level(2, 30, { failed: 1 })]);
    expect(failed.codexMax).toBe(1);
    expect(failed.rOverCFactor).toBe(2);
    expect(laneProbeVerdict([level(1, 20, { rateLimits: 1 })]).codexMax).toBeNull();
    expect(laneProbeVerdict([level(1, null, { failed: 1 })])).toMatchObject({
      codexMax: null,
      measuredC: null,
      rOverCFactor: null
    });
  });
});

/** A Codex lane that answers after `latencyMs` and answers 429 above `providerLimit` calls at once. */
function fakeLane(
  options: {
    maximum?: number;
    providerLimit?: number;
    latencyMs?: number;
    runtime?: "remote" | "local";
    failCall?: (call: number) => boolean;
  } = {}
) {
  const latencyMs = options.latencyMs ?? 3_000;
  const state = { inFlight: 0, calls: 0, peak: 0, rateLimits: 0, streak: 0, started: false };
  const snapshot = (): LaneSnapshot[] =>
    state.started
      ? [
          {
            lane: "remote:codex-1",
            limit: options.maximum ?? 3,
            maximum: options.maximum ?? 3,
            running: state.inFlight,
            held: 0,
            waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
            pausedForMs: null,
            successStreak: state.streak,
            rateLimits: state.rateLimits,
            breaker: null
          }
        ]
      : [];
  const ai = {
    laneSnapshots: snapshot,
    runDefaultTask: vi.fn(async () => {
      state.started = true;
      const call = ++state.calls;
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      const limited = state.inFlight > (options.providerLimit ?? Infinity);
      if (limited) state.rateLimits += 1;
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      state.inFlight -= 1;
      if (options.failCall?.(call))
        throw new Error("The provider is busy. authorization: Bearer sk-secret-token");
      state.streak += 1;
      return {
        taskType: "reranking",
        output: "{}",
        providerId: "openai-codex",
        modelId: "gpt-luna",
        runtime: options.runtime ?? "remote",
        profileId: "profile-1",
        aiTaskRunId: `run-${call}`,
        outputLanguage: "en",
        durationMs: latencyMs,
        inputTokens: 1_300,
        outputTokens: 40,
        attempts: limited ? 2 : 1
      };
    })
  };
  return { ai: ai as unknown as LaneProbeAi, state, run: ai.runDefaultTask };
}

async function probe(lane: ReturnType<typeof fakeLane>, config = defaultAiLaneProbeConfig) {
  const measuring = measureLanes({ ai: lane.ai, config });
  await vi.runAllTimersAsync();
  return measuring;
}

describe("measuring the lane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs 40 calls at concurrency 1, 2 and 3 and reports wall time, throughput and tokens per level", async () => {
    const lane = fakeLane();
    const report = await probe(lane);
    expect(report.error).toBeUndefined();
    expect(report.levels.map((entry) => [entry.concurrency, entry.attempted, entry.ok])).toEqual([
      [1, 7, 7],
      [2, 13, 13],
      [3, 20, 20]
    ]);
    // 7 sequential calls, then 7 rounds of two, then 7 rounds of three, at 3 s each.
    expect(report.levels.map((entry) => entry.wallMs)).toEqual([21_000, 21_000, 21_000]);
    expect(report.levels.map((entry) => entry.callsPerMinute)).toEqual([20, 37.14, 57.14]);
    expect(report.levels[2]).toMatchObject({
      rateLimits: 0,
      failed: 0,
      retried: 0,
      latencyMs: { p50: 3_000, p95: 3_000, max: 3_000 },
      inputTokens: 26_000,
      outputTokens: 800
    });
    expect(lane.state.peak).toBe(3);
    expect(report.lane).toEqual({ key: "remote:codex-1", maximum: 3 });
    expect(report.route).toEqual({
      profileId: "profile-1",
      providerId: "openai-codex",
      modelId: "gpt-luna"
    });
    expect(report.stoppedAfter).toBeNull();
    expect(report.verdict).toMatchObject({ codexMax: 3, measuredC: 2.86, rOverCFactor: 0.7 });
    expect(lane.run).toHaveBeenCalledTimes(40);
    // Decide-sized calls on the reranking route, from P2, asking for a short answer.
    expect(lane.run.mock.calls[0]).toMatchObject([
      "reranking",
      expect.stringContaining("Probe request 1."),
      { operation: "lane_probe", priority: "P2" },
      undefined,
      { maxOutputTokens: 256 }
    ]);
  });

  it("runs each level at exactly its concurrency", async () => {
    const lane = fakeLane();
    const report = await probe(lane, { levels: [2], calls: 6 });
    // The probe's first call runs alone (3 s); the other five go two at a time (3 rounds).
    expect(report.levels[0]).toMatchObject({ concurrency: 2, attempted: 6, ok: 6, wallMs: 12_000 });
    expect(lane.state.peak).toBe(2);
  });

  it("stops at the first level that sees a 429 and keeps the Codex maximum below it", async () => {
    const lane = fakeLane({ providerLimit: 2 });
    const report = await probe(lane);
    expect(report.stoppedAfter).toEqual({ concurrency: 3, reason: "rate_limited" });
    const third = report.levels[2]!;
    expect(third.rateLimits).toBeGreaterThan(0);
    expect(third.attempted).toBeLessThan(third.calls);
    expect(third.retried).toBeGreaterThan(0);
    expect(report.verdict).toMatchObject({ codexMax: 2 });
    expect(report.verdict!.note).toContain("Concurrency 3 saw");
  });

  it("stops at a failed call, keeps its redacted error and does not go on to the next level", async () => {
    const lane = fakeLane({ failCall: (call) => call === 9 });
    const report = await probe(lane);
    expect(report.stoppedAfter).toEqual({ concurrency: 2, reason: "failed" });
    expect(report.levels).toHaveLength(2);
    expect(report.levels[1]).toMatchObject({ failed: 1 });
    expect(report.levels[1]!.errors.join(" ")).toContain("The provider is busy.");
    expect(report.levels[1]!.errors.join(" ")).not.toContain("sk-secret-token");
    expect(report.verdict!.codexMax).toBe(1);
    expect(lane.state.calls).toBeLessThan(40);
  });

  it("refuses a route that does not run on the ChatGPT/Codex lane", async () => {
    const lane = fakeLane({ runtime: "local" });
    const report = await probe(lane);
    expect(report.error).toContain("route it to a ChatGPT/Codex profile");
    expect(report.verdict).toBeNull();
    expect(lane.state.calls).toBe(1);
  });

  it("refuses a lane too narrow for its top level, as in serial mode", async () => {
    const lane = fakeLane({ maximum: 1 });
    const report = await probe(lane);
    expect(report.error).toContain("The lane allows 1 calls at once and the probe tries 3");
    expect(report.verdict).toBeNull();
    expect(lane.state.calls).toBe(1);
  });

  it("reports a route with no model as a failed call", async () => {
    const lane = fakeLane();
    lane.run.mockImplementationOnce(async () => null as never);
    const report = await probe(lane);
    expect(report.levels[0]).toMatchObject({ failed: 1, errors: ["errors.ai.noCompatibleModel"] });
    expect(report.stoppedAfter).toEqual({ concurrency: 1, reason: "failed" });
  });
});

describe("running the probe", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "lane-probe-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(workspace, { recursive: true, force: true });
  });

  it("writes the report and logs the verdict", async () => {
    vi.useFakeTimers();
    const lane = fakeLane();
    const logger = { info: vi.fn(), error: vi.fn() };
    const running = runLaneProbe({
      env: knob(".cache/f3/b5/lane-probe.json"),
      isPackaged: false,
      workspaceRoot: workspace,
      ai: lane.ai,
      logger
    });
    await vi.runAllTimersAsync();
    await expect(running).resolves.toBe("done");
    const report = JSON.parse(
      await readFile(join(workspace, ".cache/f3/b5/lane-probe.json"), "utf8")
    );
    expect(report).toMatchObject({
      version: "lane-probe-v1",
      verdict: { codexMax: 3 },
      config: { levels: [1, 2, 3], calls: 40 }
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("LANE_PROBE done: codexMax=3")
    );
  });

  it("is refused when packaged: nothing is sent and nothing is written", async () => {
    const lane = fakeLane();
    const logger = { info: vi.fn(), error: vi.fn() };
    await expect(
      runLaneProbe({
        env: knob(".cache/lane-probe.json"),
        isPackaged: true,
        workspaceRoot: workspace,
        ai: lane.ai,
        logger
      })
    ).resolves.toBe("refused");
    expect(lane.run).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "LANE_PROBE refused: MEMORA_DEV_LANE_PROBE is refused in packaged builds"
    );
    await expect(stat(join(workspace, ".cache"))).rejects.toThrow();
  });

  it("does nothing when the knob is unset", async () => {
    const lane = fakeLane();
    await expect(
      runLaneProbe({ env: {}, isPackaged: false, workspaceRoot: workspace, ai: lane.ai })
    ).resolves.toBe("off");
    expect(lane.run).not.toHaveBeenCalled();
  });

  it("writes a report with the error when the probe cannot measure, and says it failed", async () => {
    vi.useFakeTimers();
    const lane = fakeLane({ runtime: "local" });
    const logger = { info: vi.fn(), error: vi.fn() };
    const running = runLaneProbe({
      env: knob(".cache/lane-probe.json"),
      isPackaged: false,
      workspaceRoot: workspace,
      ai: lane.ai,
      logger
    });
    await vi.runAllTimersAsync();
    await expect(running).resolves.toBe("failed");
    const report = JSON.parse(await readFile(join(workspace, ".cache/lane-probe.json"), "utf8"));
    expect(report.error).toContain("ChatGPT/Codex");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("LANE_PROBE failed:"));
  });
});
