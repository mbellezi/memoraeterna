import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AiCassette,
  AiCassetteError,
  resolveAiCassetteConfig,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./index.js";
import { resolveAiLaneRuntimeConfig } from "./runtime-config.js";
import { createAiScheduler } from "./scheduler/scheduler.js";
import { fakeSchedulerClock } from "./scheduler/test-clock.js";
import type { LaneKey, LaneTicket } from "./scheduler/types.js";

// Recorded-timing replay (F3 3.17, D5): a served entry waits its recorded `durationMs` inside the
// lane slot its call holds, so a throughput rerun queues and overlaps like the recording did.
const descriptor: AiModelDescriptor = {
  providerId: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  capabilities: ["atomic-note-generation", "structured-output"],
  parameterCapabilities: {},
  limits: {},
  requirements: { network: true }
};

const request = (name: string): AiTaskRequest => ({
  taskType: "atomic-note-generation",
  input: `Type the pair ${name}.`,
  modelId: "gpt-test",
  requiredCapabilities: ["atomic-note-generation"],
  parameters: { reasoningLevel: "low" },
  metadata: { applicationInstruction: "Return JSON only." }
});

/** Answers every call after `durationMs` of recorded time. */
class FakeAdapter implements AiModelAdapter {
  public calls = 0;
  public constructor(private readonly durationMs: number) {}
  public describe() {
    return descriptor;
  }
  public canHandle() {
    return true;
  }
  public async run(call: AiTaskRequest): Promise<AiTaskResult> {
    this.calls += 1;
    return {
      taskType: call.taskType,
      output: { answer: call.input },
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      runtime: descriptor.runtime,
      durationMs: this.durationMs,
      inputTokens: 100,
      outputTokens: 20
    };
  }
}

/** A delay the test ends by hand: it records what each call waited for. */
function manualWaits() {
  const waits: Array<{
    ms: number;
    signal: AbortSignal | undefined;
    end: () => void;
    fail: (reason: unknown) => void;
  }> = [];
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      waits.push({ ms, signal, end: resolve, fail: reject });
    });
  return { waits, wait };
}

/** Real file reads sit between a call and its wait, so tests poll instead of flushing microtasks. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 60));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-cassette-timing-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function record(names: readonly string[], durationMs: number) {
  const adapter = new FakeAdapter(durationMs);
  const recording = new AiCassette({ mode: "record", directory }).wrap(adapter);
  for (const name of names) await recording.run(request(name));
  return adapter;
}

describe("AI cassette timing configuration", () => {
  const base = { isPackaged: false, baseDirectory: "/repo" };
  const cassette = { MEMORA_AI_CASSETTE: "replay", MEMORA_AI_CASSETTE_DIR: ".cache/golden/a" };

  it("is off unless MEMORA_AI_CASSETTE_TIMING says recorded", () => {
    expect(resolveAiCassetteConfig(cassette, base)).not.toHaveProperty("timing");
    expect(
      resolveAiCassetteConfig({ ...cassette, MEMORA_AI_CASSETTE_TIMING: " " }, base)
    ).not.toHaveProperty("timing");
    expect(
      resolveAiCassetteConfig({ ...cassette, MEMORA_AI_CASSETTE_TIMING: "recorded" }, base)
    ).toMatchObject({ mode: "replay", timing: "recorded" });
    expect(
      resolveAiCassetteConfig(
        { ...cassette, MEMORA_AI_CASSETTE: "record", MEMORA_AI_CASSETTE_TIMING: "recorded" },
        base
      )
    ).toMatchObject({ mode: "record", timing: "recorded" });
  });

  it("rejects an unknown value and a timing without a cassette", () => {
    expect(() =>
      resolveAiCassetteConfig({ ...cassette, MEMORA_AI_CASSETTE_TIMING: "fast" }, base)
    ).toThrow(AiCassetteError);
    expect(() => resolveAiCassetteConfig({ MEMORA_AI_CASSETTE_TIMING: "recorded" }, base)).toThrow(
      "needs MEMORA_AI_CASSETTE"
    );
    expect(() =>
      resolveAiCassetteConfig(
        { MEMORA_AI_CASSETTE: "off", MEMORA_AI_CASSETTE_TIMING: "recorded" },
        base
      )
    ).toThrow("needs MEMORA_AI_CASSETTE");
  });
});

describe("AI cassette recorded timing", () => {
  it("serves at once when timing is off", async () => {
    await record(["a"], 1200);
    const { waits, wait } = manualWaits();
    const replay = new AiCassette({ mode: "replay", directory }, undefined, wait);
    const result = await replay.wrap(new FakeAdapter(0)).run(request("a"));
    expect(result.output).toEqual({ answer: "Type the pair a." });
    expect(waits).toEqual([]);
    expect(replay.stats()).not.toHaveProperty("timing");
  });

  it("makes a served entry wait its recorded duration before it answers", async () => {
    await record(["a"], 1200);
    const { waits, wait } = manualWaits();
    const replay = new AiCassette(
      { mode: "replay", directory, timing: "recorded" },
      undefined,
      wait
    );
    const live = new FakeAdapter(0);
    let answered = false;
    const call = replay
      .wrap(live)
      .run(request("a"))
      .then((result) => {
        answered = true;
        return result;
      });
    await until(() => waits.length === 1);
    // The recorded 1,200 ms, less the few milliseconds the lookup itself took.
    expect(waits[0]!.ms).toBeGreaterThan(1_100);
    expect(waits[0]!.ms).toBeLessThanOrEqual(1_200);
    expect(answered).toBe(false);
    waits[0]!.end();
    const result = await call;
    expect(result.output).toEqual({ answer: "Type the pair a." });
    // The provider was not called: the cost stays zero.
    expect(live.calls).toBe(0);
    expect(replay.stats()).toMatchObject({
      timing: "recorded",
      served: 1,
      recorded: 0,
      misses: 0
    });
    expect(replay.stats().waitedMs).toBe(waits[0]!.ms);
  });

  it("serves in record mode with the same timing and sends a miss live, untimed", async () => {
    const recorder = await record(["a"], 800);
    expect(recorder.calls).toBe(1);
    const { waits, wait } = manualWaits();
    const resumed = new AiCassette(
      { mode: "record", directory, timing: "recorded" },
      undefined,
      wait
    );
    const live = new FakeAdapter(500);
    const wrapped = resumed.wrap(live);
    const served = wrapped.run(request("a"));
    await until(() => waits.length === 1);
    waits[0]!.end();
    await served;
    // A miss goes live (and is recorded); the live call takes its own time, so nothing waits.
    await wrapped.run(request("b"));
    expect(live.calls).toBe(1);
    expect(waits).toHaveLength(1);
    expect(resumed.stats()).toMatchObject({ served: 1, recorded: 1 });
  });

  it("waits each occurrence of a repeated call for its own recorded duration", async () => {
    await record(["a"], 300);
    // A second occurrence of the same key, recorded with a longer duration.
    const longer = new AiCassette({ mode: "record", directory }).wrap(new FakeAdapter(900));
    await longer.run(request("a"));
    await longer.run(request("a"));
    const { waits, wait } = manualWaits();
    const replay = new AiCassette(
      { mode: "replay", directory, timing: "recorded" },
      undefined,
      wait
    );
    const wrapped = replay.wrap(new FakeAdapter(0));
    const first = wrapped.run(request("a"));
    await until(() => waits.length === 1);
    waits[0]!.end();
    await first;
    const second = wrapped.run(request("a"));
    await until(() => waits.length === 2);
    expect(waits[0]!.ms).toBeLessThanOrEqual(300);
    expect(waits[1]!.ms).toBeLessThanOrEqual(900);
    waits[1]!.end();
    await second;
  });

  it("returns the entry when the call is canceled while it waits", async () => {
    await record(["a"], 1000);
    const { waits, wait } = manualWaits();
    const replay = new AiCassette(
      { mode: "replay", directory, timing: "recorded" },
      undefined,
      wait
    );
    const wrapped = replay.wrap(new FakeAdapter(0));
    const controller = new AbortController();
    const canceled = wrapped.run(request("a"), controller.signal);
    await until(() => waits.length === 1);
    expect(waits[0]!.signal).toBe(controller.signal);
    controller.abort(new Error("canceled"));
    waits[0]!.fail(new Error("canceled"));
    await expect(canceled).rejects.toThrow("canceled");
    expect(replay.stats()).toMatchObject({ served: 0, misses: 0 });
    // A retry is served from the same entry.
    const retried = wrapped.run(request("a"));
    await until(() => waits.length === 2);
    waits[1]!.end();
    await expect(retried).resolves.toMatchObject({ output: { answer: "Type the pair a." } });
  });

  it("really waits when no test delay is given", async () => {
    await record(["a"], 60);
    const replay = new AiCassette({ mode: "replay", directory, timing: "recorded" });
    const startedAt = performance.now();
    const result = await replay.wrap(new FakeAdapter(0)).run(request("a"));
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(45);
    // The audit shows the time the call took, the recorded wait included.
    expect(result.durationMs).toBeGreaterThanOrEqual(45);
    const again = new AiCassette({ mode: "replay", directory, timing: "recorded" });
    const controller = new AbortController();
    const canceled = again.wrap(new FakeAdapter(0)).run(request("a"), controller.signal);
    controller.abort(new Error("stop"));
    await expect(canceled).rejects.toThrow("stop");
  });
});

describe("AI cassette recorded timing inside a lane", () => {
  const ticket = (lane: LaneKey): LaneTicket => ({
    lane,
    priority: "P2",
    workloadClass: "write-fast",
    label: lane,
    ...(lane.startsWith("remote:") ? { remoteKind: "api-key" as const } : {})
  });

  async function replayThrough(lane: LaneKey) {
    await record(["a", "b"], 1000);
    const { waits, wait } = manualWaits();
    const wrapped = new AiCassette(
      { mode: "replay", directory, timing: "recorded" },
      undefined,
      wait
    ).wrap(new FakeAdapter(0));
    const time = fakeSchedulerClock();
    const scheduler = createAiScheduler(
      resolveAiLaneRuntimeConfig({}, { environment: {} }),
      time.clock
    );
    const calls = ["a", "b"].map((name) =>
      scheduler.run(ticket(lane), () => wrapped.run(request(name)))
    );
    return { waits, calls };
  }

  it("holds the slot of a serial lane for the recorded time, so the next call queues", async () => {
    const { waits, calls } = await replayThrough("local");
    await until(() => waits.length === 1);
    // Only the first call holds the slot and waits; the second has not started.
    await quiet();
    expect(waits).toHaveLength(1);
    waits[0]!.end();
    await until(() => waits.length === 2);
    waits[1]!.end();
    await expect(Promise.all(calls)).resolves.toHaveLength(2);
  });

  it("lets calls overlap on a remote lane that allows two", async () => {
    const { waits, calls } = await replayThrough("remote:codex");
    await until(() => waits.length === 2);
    for (const wait of waits) wait.end();
    await expect(Promise.all(calls)).resolves.toHaveLength(2);
  });
});
