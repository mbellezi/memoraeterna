import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiCassette, AiProviderError } from "@app/ai";
import type {
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressEvent,
  AiTaskRequest,
  AiTaskResult
} from "@app/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecordRetry, recordRetryDelaysMs } from "./record-retry.js";

const descriptor = (runtime: AiModelDescriptor["runtime"]): AiModelDescriptor => ({
  providerId: runtime === "remote" ? "openai-codex" : "local-mlx",
  modelId: "gpt-test",
  runtime,
  capabilities: ["knowledge-graph-generation"],
  parameterCapabilities: {},
  limits: {},
  requirements: { network: runtime === "remote" }
});

const request = (input: string): AiTaskRequest => ({
  taskType: "knowledge-graph-generation",
  input,
  modelId: "gpt-test",
  requiredCapabilities: ["knowledge-graph-generation"],
  parameters: {},
  metadata: { applicationInstruction: "Return JSON only." }
});

const stalled = () =>
  new AiProviderError("AI provider stream stalled for 20000 ms.", {
    kind: "stalled",
    transient: true
  });
const rejected = () =>
  new AiProviderError("AI provider rejected the request (400).", {
    kind: "http",
    transient: false,
    status: 400
  });

/** Fails its first calls with the given errors, then answers; streams a delta per attempt. */
class FlakyAdapter implements AiModelAdapter {
  public calls = 0;
  public constructor(
    private readonly failures: Array<() => Error>,
    private readonly runtime: AiModelDescriptor["runtime"] = "remote"
  ) {}
  public describe() {
    return descriptor(this.runtime);
  }
  public canHandle() {
    return true;
  }
  public async run(call: AiTaskRequest): Promise<AiTaskResult> {
    this.calls += 1;
    const failure = this.failures[this.calls - 1];
    if (failure) throw failure();
    return {
      taskType: call.taskType,
      output: { entities: [call.input] },
      providerId: "openai-codex",
      modelId: "gpt-test",
      runtime: this.runtime,
      durationMs: 4_000,
      inputTokens: 100,
      outputTokens: 20
    };
  }
  public async runStreaming(
    call: AiTaskRequest,
    _signal: AbortSignal | undefined,
    onProgress: (event: AiProgressEvent) => void
  ): Promise<AiTaskResult> {
    onProgress({ kind: "text", delta: `try ${this.calls + 1}` });
    onProgress({ progress: this.calls === 0 ? 0.6 : 0.3 });
    return this.run(call);
  }
}

/** A clock the waits move: each wait advances it by its length. */
function fakeTime() {
  let at = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      waits.push(ms);
      at += ms;
    }
  };
}

describe("the record's retry of a transient remote failure (FRMISS)", () => {
  it("answers a call that failed transiently, with the whole call's duration, and counts it", async () => {
    const time = fakeTime();
    const events: unknown[] = [];
    const retry = new RecordRetry({ ...time, onRetry: (event) => events.push(event) });
    const adapter = new FlakyAdapter([stalled, stalled]);
    const result = await retry.wrap(adapter).run(request("Introduction"));

    expect(result.output).toEqual({ entities: ["Introduction"] });
    expect(adapter.calls).toBe(3);
    expect(time.waits).toEqual([recordRetryDelaysMs[0], recordRetryDelaysMs[1]]);
    // The failed tries and the waits are on the record's clock, so a replay waits them too.
    expect(result.durationMs).toBe(recordRetryDelaysMs[0]! + recordRetryDelaysMs[1]!);
    expect(retry.stats()).toEqual({
      calls: 1,
      retries: 2,
      recovered: 1,
      exhausted: 0,
      byTask: { "knowledge-graph-generation": 2 }
    });
    expect(events).toEqual([
      {
        taskType: "knowledge-graph-generation",
        attempt: 2,
        delayMs: recordRetryDelaysMs[0],
        error: "AI provider stream stalled for 20000 ms."
      },
      {
        taskType: "knowledge-graph-generation",
        attempt: 3,
        delayMs: recordRetryDelaysMs[1],
        error: "AI provider stream stalled for 20000 ms."
      }
    ]);
  });

  it("keeps the answer's own duration and touches nothing when the first try answers", async () => {
    const retry = new RecordRetry(fakeTime());
    const result = await retry.wrap(new FlakyAdapter([])).run(request("Abstract"));
    expect(result.durationMs).toBe(4_000);
    expect(retry.stats()).toEqual({ calls: 0, retries: 0, recovered: 0, exhausted: 0, byTask: {} });
  });

  it("never retries a deterministic failure, and leaves a local adapter as it is", async () => {
    const time = fakeTime();
    const retry = new RecordRetry(time);
    const adapter = new FlakyAdapter([rejected]);
    await expect(retry.wrap(adapter).run(request("x"))).rejects.toThrow("rejected the request");
    expect(adapter.calls).toBe(1);
    expect(time.waits).toEqual([]);

    const local = new FlakyAdapter([stalled], "local");
    expect(retry.wrap(local)).toBe(local);
    expect(retry.stats().calls).toBe(0);
  });

  it("gives up after its last wait, or at once when the token cap is reached, and says so", async () => {
    const time = fakeTime();
    const retry = new RecordRetry({ ...time, delaysMs: [5, 7] });
    const adapter = new FlakyAdapter([stalled, stalled, stalled, stalled]);
    await expect(retry.wrap(adapter).run(request("x"))).rejects.toThrow("stalled");
    expect(adapter.calls).toBe(3);
    expect(time.waits).toEqual([5, 7]);
    expect(retry.stats()).toMatchObject({ calls: 1, retries: 2, recovered: 0, exhausted: 1 });

    const capped = new RecordRetry({ ...fakeTime(), allow: () => false });
    const once = new FlakyAdapter([stalled]);
    await expect(capped.wrap(once).run(request("x"))).rejects.toThrow("stalled");
    expect(once.calls).toBe(1);
    expect(capped.stats()).toMatchObject({ calls: 1, retries: 0, exhausted: 1 });
  });

  it("stops at a canceled call instead of trying it again", async () => {
    const controller = new AbortController();
    const retry = new RecordRetry({
      now: () => 0,
      sleep: async (_ms, signal) => {
        controller.abort(new Error("canceled"));
        signal?.throwIfAborted();
      }
    });
    const adapter = new FlakyAdapter([stalled]);
    await expect(retry.wrap(adapter).run(request("x"), controller.signal)).rejects.toThrow(
      "canceled"
    );
    expect(adapter.calls).toBe(1);
  });

  it("restarts the streamed answer on a new try and never moves the progress back", async () => {
    const retry = new RecordRetry(fakeTime());
    const adapter = new FlakyAdapter([stalled]);
    const seen: AiProgressEvent[] = [];
    await retry.wrap(adapter).runStreaming!(request("x"), undefined, (event) => seen.push(event));
    expect(seen).toEqual([
      { kind: "text", delta: "try 1" },
      { progress: 0.6 },
      { kind: "text", delta: "try 2", restart: true }
    ]);
  });

  describe("under the cassette", () => {
    let directory = "";
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "memora-record-retry-"));
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("records a flaky call as one answer that a replay serves at its first call, timed as recorded", async () => {
      // The record: the provider stalls once; the caller (the product's job) gets the answer.
      const time = fakeTime();
      const retry = new RecordRetry(time);
      const recording = new AiCassette({ mode: "record", directory }).wrap(
        retry.wrap(new FlakyAdapter([stalled]))
      );
      const recorded = await recording.run(request("The Replication Experiment"));
      expect(recorded.output).toEqual({ entities: ["The Replication Experiment"] });

      // The replay: served at once, never a miss, waiting what the record waited.
      const waited: number[] = [];
      const replay = new AiCassette(
        { mode: "replay", directory, timing: "recorded" },
        () => new Date(),
        async (ms) => {
          waited.push(ms);
        }
      );
      const live = new FlakyAdapter([]);
      const served = await replay.wrap(live).run(request("The Replication Experiment"));
      expect(served.output).toEqual(recorded.output);
      expect(live.calls).toBe(0);
      expect(replay.stats()).toMatchObject({ served: 1, misses: 0, recorded: 0 });
      expect(waited).toHaveLength(1);
      expect(waited[0]).toBeGreaterThan(recordRetryDelaysMs[0]! - 1_000);
    });
  });
});
