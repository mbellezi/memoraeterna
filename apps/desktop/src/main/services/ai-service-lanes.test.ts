import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActiveDeadline,
  createAiScheduler,
  LocalDeadlineError,
  NodeLlamaCppAdapter,
  resolveAiLaneRuntimeConfig,
  type AiScheduler
} from "@app/ai";

import { AiService } from "./ai-service.js";
import { isTransientJobFailure } from "./job-failure.js";

/**
 * The AI service on the lane scheduler (F3 T47): local and remote lanes, priorities, telemetry
 * after the lane is released, one audit row per execution with the scheduler's columns, and the
 * local deadline outcomes.
 */

const state = vi.hoisted(() => ({
  selections: new Map<string, Record<string, unknown>>(),
  models: new Map<string, Record<string, unknown>>(),
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string) => state.selections.get(task) ?? null,
    recordTaskRun: state.record
  }),
  createLocalModelRepository: () => ({
    findById: async (id: string) => state.models.get(id) ?? null
  })
}));

const ids = {
  remoteProfile: "00000000-0000-4000-8000-000000000001",
  codexConfig: "00000000-0000-4000-8000-0000000000c1",
  localProfile: "00000000-0000-4000-8000-000000000002",
  localModel: "00000000-0000-4000-8000-0000000000a1"
};

const remoteSelection = {
  profileId: ids.remoteProfile,
  providerConfigId: ids.codexConfig,
  localModelId: null,
  provider: "openai-codex",
  modelId: "writer",
  runtime: "remote",
  revision: null,
  repository: null,
  quantization: null,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: ["text-generation", "summarization", "structured-output"]
};
const localSelection = {
  profileId: ids.localProfile,
  providerConfigId: null,
  localModelId: ids.localModel,
  provider: "local-gguf",
  modelId: "local-writer",
  runtime: "gguf",
  revision: "1",
  repository: null,
  quantization: "Q8_0",
  baseUrl: null,
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: ["summarization", "atomic-note-generation"]
};

type Run = (request: { taskType: string; input: string }, signal?: AbortSignal) => Promise<unknown>;

function adapter(providerId: string, modelId: string, runtime: string, run: Run) {
  return {
    describe: () => ({
      providerId,
      modelId,
      runtime,
      capabilities: [
        "text-generation",
        "summarization",
        "structured-output",
        "atomic-note-generation",
        "offline"
      ],
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string; input: string }, signal?: AbortSignal) => ({
      taskType: request.taskType,
      output: await run(request, signal),
      providerId,
      modelId,
      runtime,
      durationMs: 1
    }))
  };
}

function service(
  runs: { remote?: Run; local?: Run } = {},
  options: { scheduler?: AiScheduler } = {}
) {
  const ai = new AiService({
    userDataPath: "/tmp/ai-lane-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    lanes: {},
    ...options
  });
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    createLocalAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  const remote = adapter("openai-codex", "writer", "remote", runs.remote ?? (async () => "ok"));
  const local = adapter("local-gguf", "local-writer", "local", runs.local ?? (async () => "ok"));
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(remote)
  );
  vi.spyOn(internals, "createLocalAdapter").mockImplementation(async () =>
    internals.registerAdapter(local)
  );
  return { ai, remote, local };
}

/** A call that runs until the test opens its gate. */
function gate() {
  const opened = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  return {
    started: started.promise,
    open: () => opened.resolve(),
    hold: async () => {
      started.resolve();
      await opened.promise;
    }
  };
}

const rows = () => state.record.mock.calls.map(([row]) => row as Record<string, unknown>);

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
  state.selections.clear();
  state.selections.set("text-generation", remoteSelection);
  state.selections.set("summarization", localSelection);
  state.selections.set("atomic-note-generation", localSelection);
  state.models.clear();
  state.models.set(ids.localModel, {
    id: ids.localModel,
    catalogId: null,
    capabilities: ["text-generation", "offline"]
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AI calls on lanes", () => {
  it("answers a remote Ask while a long local generation holds the local lane", async () => {
    const generation = gate();
    const { ai } = service({
      local: async () => {
        await generation.hold();
        return "summary";
      },
      remote: async () => "answer"
    });
    const summarizing = ai.runDefaultTask("summarization", "a long local generation", {
      origin: "ingestion"
    });
    await generation.started;
    const ask = await ai.runDefaultTask("text-generation", "a question", {
      origin: "consultation"
    });
    expect(ask).toMatchObject({ output: "answer" });
    // The Ask did not wait for the local call: its queue time is its own preparation only.
    expect(rows()[0]).toMatchObject({ lane: `remote:${ids.codexConfig}`, priority: 0 });
    expect(rows()[0]!.queueMs as number).toBeLessThan(100);
    generation.open();
    await expect(summarizing).resolves.toMatchObject({ output: "summary" });
  });

  it("runs one local call at a time across services sharing a scheduler, settings tests first", async () => {
    const scheduler = createAiScheduler(resolveAiLaneRuntimeConfig({}, { environment: {} }));
    const first = gate();
    const order: string[] = [];
    let running = 0,
      maximum = 0;
    const local: Run = async (request) => {
      running++;
      maximum = Math.max(maximum, running);
      const name = ["one", "two", "three"].find((candidate) => request.input.includes(candidate))!;
      order.push(name);
      if (name === "one") await first.hold();
      running--;
      return name;
    };
    const a = service({ local }, { scheduler });
    const b = service({ local }, { scheduler });
    vi.spyOn(
      b.ai as unknown as { executeLocalModelTest: () => Promise<string> },
      "executeLocalModelTest"
    ).mockImplementation(async () => {
      order.push("local test");
      return "OK";
    });
    const calls: Array<Promise<unknown>> = [a.ai.runDefaultTask("summarization", "one")];
    await first.started;
    calls.push(
      b.ai.runDefaultTask("summarization", "two"),
      b.ai.testLocalModel(ids.localModel),
      b.ai.runDefaultTask("summarization", "three")
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["one"]);
    first.open();
    await Promise.all(calls);
    expect(order).toEqual(["one", "local test", "two", "three"]);
    expect(maximum).toBe(1);
  });

  it("keeps each call on its own adapter when two configurations share provider and model ids", async () => {
    const configA = "00000000-0000-4000-8000-0000000000d1";
    const configB = "00000000-0000-4000-8000-0000000000d2";
    const shared = { ...remoteSelection, provider: "openai-compatible", modelId: "same-model" };
    state.selections.set("text-generation", {
      ...shared,
      providerConfigId: configA,
      baseUrl: "https://a.invalid/v1"
    });
    state.selections.set("summarization", {
      ...shared,
      providerConfigId: configB,
      baseUrl: "https://b.invalid/v1"
    });
    const { ai } = service();
    const internals = ai as unknown as {
      createAdapter: (id: string) => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    const adapters: Record<string, ReturnType<typeof adapter>> = {
      [configA]: adapter("openai-compatible", "same-model", "remote", async () => "from A"),
      [configB]: adapter("openai-compatible", "same-model", "remote", async () => "from B")
    };
    const registeredB = Promise.withResolvers<void>();
    vi.mocked(internals.createAdapter).mockImplementation(async (id: string) => {
      const registered = internals.registerAdapter(adapters[id]!);
      // The call on lane A resumes only after the call on lane B registered its adapter.
      if (id === configA) await registeredB.promise;
      else registeredB.resolve();
      return registered;
    });
    const [a, b] = await Promise.all([
      ai.runDefaultTask("text-generation", "question"),
      ai.runDefaultTask("summarization", "text")
    ]);
    expect(a).toMatchObject({ output: "from A" });
    expect(b).toMatchObject({ output: "from B" });
    expect(
      rows()
        .map((row) => row.lane)
        .sort()
    ).toEqual([`remote:${configA}`, `remote:${configB}`]);
  });

  it("writes the audit and the monitoring entry after the lane is released", async () => {
    const audit = Promise.withResolvers<string>();
    state.record.mockImplementationOnce(() => audit.promise);
    const order: string[] = [];
    const { ai } = service({
      local: async (request) => {
        order.push(request.input.includes("first") ? "first ran" : "second ran");
        return "ok";
      }
    });
    const first = ai.runDefaultTask("summarization", "first");
    const second = ai.runDefaultTask("summarization", "second");
    await expect(second).resolves.toMatchObject({ aiTaskRunId: "run-id" });
    // The second call ran on the local lane while the first call's audit was still being written.
    expect(order).toEqual(["first ran", "second ran"]);
    audit.resolve("first-run");
    await expect(first).resolves.toMatchObject({ aiTaskRunId: "first-run" });
  });
});

describe("the scheduler's audit of every execution (S9)", () => {
  it("records lane, class, priority and deadline for succeeded, failed and cancelled calls", async () => {
    const controller = new AbortController();
    const blocking = gate();
    const { ai } = service({
      remote: async () => "answer",
      local: async (request, signal) => {
        if (request.input.includes("fails")) throw new Error("errors.localModels.runtimeFailed");
        if (request.input.includes("cancelled")) {
          controller.abort(new Error("user canceled"));
          signal?.throwIfAborted();
        }
        if (request.input.includes("hold")) await blocking.hold();
        return "ok";
      }
    });
    await ai.runDefaultTask("text-generation", "question", { origin: "consultation" });
    await expect(
      ai.runDefaultTask("summarization", "this one fails", { origin: "ingestion" })
    ).rejects.toThrow("errors.localModels.runtimeFailed");
    await expect(
      ai.runDefaultTask("summarization", "cancelled", {}, controller.signal)
    ).rejects.toThrow("user canceled");
    await ai.runDefaultTask("atomic-note-generation", "repair these notes", {
      operation: "atomic_note_repair",
      priority: "P3"
    });
    // A call cancelled while it waits never executed: it has no row.
    const holding = ai.runDefaultTask("summarization", "hold", {});
    await blocking.started;
    const waiting = new AbortController();
    const cancelledWhileWaiting = ai.runDefaultTask("summarization", "never", {}, waiting.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    waiting.abort(new Error("gone"));
    await expect(cancelledWhileWaiting).rejects.toThrow("gone");
    blocking.open();
    await holding;

    expect(rows()).toHaveLength(5);
    expect(rows()[0]).toMatchObject({
      status: "succeeded",
      lane: `remote:${ids.codexConfig}`,
      workloadClass: "answer",
      priority: 0,
      deadlineMs: 180_000,
      deadlineOutcome: "met",
      isRepair: false,
      retryWaitMs: 0,
      requeueMs: 0
    });
    expect(rows()[1]).toMatchObject({
      status: "failed",
      lane: "local",
      workloadClass: "write-fast",
      priority: 2,
      deadlineMs: 140_000,
      deadlineOutcome: "met"
    });
    expect(rows()[2]).toMatchObject({ status: "canceled", lane: "local", deadlineOutcome: "met" });
    expect(rows()[3]).toMatchObject({
      status: "succeeded",
      workloadClass: "write-quality",
      priority: 3,
      deadlineMs: 350_000,
      isRepair: true
    });
    expect(rows()[4]).toMatchObject({ status: "succeeded", lane: "local" });
  });

  it("records a call its local deadline ended as aborted, and does not retry a second one on the same input", async () => {
    const { ai } = service({
      local: async () => {
        throw new LocalDeadlineError("Local model call exceeded its 180000 ms deadline.", {
          code: "deadline",
          deadlineMs: 180_000
        });
      }
    });
    const first = await ai.runDefaultTask("summarization", "slow input").catch((e: unknown) => e);
    const second = await ai.runDefaultTask("summarization", "slow input").catch((e: unknown) => e);
    const other = await ai.runDefaultTask("summarization", "other input").catch((e: unknown) => e);
    expect(rows().map((row) => row.deadlineOutcome)).toEqual(["aborted", "aborted", "aborted"]);
    expect(isTransientJobFailure(first)).toBe(true);
    // A second consecutive deadline on the same input is deterministic: the job fails once.
    expect(second).toMatchObject({ code: "deadline_repeated" });
    expect(isTransientJobFailure(second)).toBe(false);
    expect(isTransientJobFailure(other)).toBe(true);
  });

  it("keeps the local lane held while a wedged runtime stops and fails the calls that need it (C11)", async () => {
    const recovery = Promise.withResolvers<void>();
    const wedging = gate();
    const order: string[] = [];
    const { ai } = service({
      local: async (request) => {
        if (request.input.includes("wedges")) {
          await wedging.hold();
          throw new LocalDeadlineError("Local model call did not stop.", {
            code: "aborted_deadline",
            deadlineMs: 180_000,
            recovery: recovery.promise
          });
        }
        order.push(request.input.split("\n").at(-1)!);
        return "ok";
      }
    });
    const wedged = ai.runDefaultTask("summarization", "this wedges");
    await wedging.started;
    // Waiting for the lane when the runtime wedges: it fails instead of queueing behind the hold.
    const waiting = ai.runDefaultTask("summarization", "queued before", { priority: "P0" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    wedging.open();
    await expect(wedged).rejects.toMatchObject({ code: "aborted_deadline" });
    const queued = await waiting.catch((error: unknown) => error);
    expect(queued).toMatchObject({ code: "wedged", deadlineMs: 140_000 });
    // Admitted while the lane is held: refused at once, as a failure a job retries.
    const refused = await ai
      .runDefaultTask("atomic-note-generation", "meanwhile", { priority: "P0" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "wedged", deadlineMs: 350_000 });
    expect(isTransientJobFailure(refused)).toBe(true);
    // Remote lanes are not held.
    await expect(ai.runDefaultTask("text-generation", "question")).resolves.toMatchObject({
      output: "ok"
    });
    expect(order).toEqual([]);
    recovery.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(ai.runDefaultTask("summarization", "after recovery")).resolves.toMatchObject({
      output: "ok"
    });
    expect(order).toEqual(["after recovery"]);
    // The refused calls never executed, so only the three that did have audit rows.
    expect(rows().map((row) => [row.lane, row.status])).toEqual([
      ["local", "failed"],
      [`remote:${ids.codexConfig}`, "succeeded"],
      ["local", "succeeded"]
    ]);
  });

  it("holds the local lane behind a real GGUF adapter whose native call ignores its deadline", async () => {
    const lanes = { localDeadlines: { totalMs: { "write-fast": 100 }, graceMs: 100 } };
    const ai = new AiService({
      userDataPath: "/tmp/ai-lane-tests",
      getPool: () => ({}) as never,
      workspaceRoot: "/tmp",
      resourcesPath: "/tmp",
      isPackaged: false,
      lanes
    });
    const native = Promise.withResolvers<{ output: string; durationMs: number }>();
    const order: string[] = [];
    const gguf = new NodeLlamaCppAdapter(
      {
        modelId: "local-writer",
        modelPath: "/models/writer.gguf",
        capabilities: ["summarization", "text-generation", "offline"],
        localDeadlines: resolveAiLaneRuntimeConfig(lanes, { environment: {} }).localDeadlines
      },
      async (input) => {
        if (input.prompt.includes("stuck")) return native.promise;
        order.push("next ran");
        return { output: "ok", durationMs: 1 };
      }
    );
    const internals = ai as unknown as {
      createLocalAdapter: () => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    vi.spyOn(internals, "createLocalAdapter").mockImplementation(async () =>
      internals.registerAdapter(gguf)
    );
    const startedAt = Date.now();
    await expect(ai.runDefaultTask("summarization", "stuck")).rejects.toMatchObject({
      code: "aborted_deadline"
    });
    // Settled at its deadline plus the grace period, not when the native call ends.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(gguf.wedged).toBe(true);
    // A new GGUF call fails visibly instead of waiting, with its deadline paused, for the lane.
    await expect(
      ai.runDefaultTask("summarization", "meanwhile", { priority: "P0" })
    ).rejects.toMatchObject({ code: "wedged" });
    expect(order).toEqual([]);
    native.resolve({ output: "late", durationMs: 1 });
    await vi.waitFor(() => expect(gguf.wedged).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(ai.runDefaultTask("summarization", "afterwards")).resolves.toMatchObject({
      output: "ok"
    });
    expect(order).toEqual(["next ran"]);
    expect(rows()[0]).toMatchObject({ deadlineOutcome: "aborted", deadlineMs: 100 });
  });

  it("does not count the wait for the lane against a caller's own timeout", async () => {
    vi.useFakeTimers();
    const generation = gate();
    const { ai } = service({
      local: async (request) => {
        if (request.input.includes("first")) await generation.hold();
        return "ok";
      }
    });
    const first = ai.runDefaultTask("summarization", "first");
    await generation.started;
    const deadline = new ActiveDeadline(1_000);
    const second = ai.runDefaultTask("summarization", "second", {}, deadline.signal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deadline.signal.aborted).toBe(false);
    generation.open();
    await expect(second).resolves.toMatchObject({ output: "ok" });
    await first;
    deadline.dispose();
  });
});
