import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveDeadline } from "./ai-execution-queue.js";
import { AiService, aiTaskPriority } from "./ai-service.js";

const state = vi.hoisted(() => ({
  selection: {} as Record<string, unknown>,
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async () => state.selection,
    recordTaskRun: state.record
  }),
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const uuid = "00000000-0000-4000-8000-000000000001";

function service(run: (input: string, signal?: AbortSignal) => Promise<unknown>) {
  const ai = new AiService({
    userDataPath: "/tmp/ai-priority-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false
  });
  const adapter = {
    describe: () => ({
      providerId: "openai-codex",
      modelId: "fixture",
      capabilities: ["summarization", "reranking", "text-generation"],
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 }, temperature: { min: 0, max: 2 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string; input: string }, signal?: AbortSignal) => ({
      taskType: request.taskType,
      output: await run(request.input, signal),
      providerId: "openai-codex",
      modelId: "fixture",
      runtime: "fixture",
      durationMs: 1
    }))
  };
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(adapter)
  );
  return ai;
}

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
  state.selection = {
    profileId: uuid,
    providerConfigId: uuid,
    localModelId: null,
    provider: "openai-codex",
    modelId: "fixture",
    runtime: "fixture",
    revision: "1",
    repository: null,
    quantization: null,
    baseUrl: "https://fixture.invalid",
    parameters: { temperature: 0.2 },
    modelDefaultParameters: {},
    requiredCapabilities: ["summarization", "reranking", "text-generation"]
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AI call priority", () => {
  it("serves what the user waits for first and everything else as background work", () => {
    expect(aiTaskPriority({ embeddingInputType: "query" })).toBe("interactive");
    expect(aiTaskPriority({ origin: "consultation" })).toBe("interactive");
    expect(aiTaskPriority({ origin: "settings" })).toBe("interactive");
    expect(aiTaskPriority({ embeddingInputType: "document", origin: "ingestion" })).toBe(
      "background"
    );
    expect(aiTaskPriority({ origin: "organization" })).toBe("background");
    expect(aiTaskPriority({})).toBe("background");
    expect(aiTaskPriority({ origin: "job", priority: "interactive" })).toBe("interactive");
    expect(aiTaskPriority({ origin: "consultation", priority: "background" })).toBe("background");
  });

  it("runs an Ask question right after the call in flight, ahead of queued background work", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const order: string[] = [];
    const ai = service(async (input) => {
      const name = ["import 1", "import 2", "import 3", "ask"].find((candidate) =>
        input.includes(candidate)
      )!;
      order.push(name);
      if (name === "import 1") {
        started.resolve();
        await gate.promise;
      }
      return "ok";
    });
    const background = { origin: "ingestion", ingestionRunId: "run" };
    const calls = [ai.runDefaultTask("summarization", "import 1", background)];
    await started.promise;
    calls.push(
      ai.runDefaultTask("summarization", "import 2", background),
      ai.runDefaultTask("summarization", "import 3", background),
      ai.runDefaultTask("reranking", "ask", { origin: "consultation" })
    );
    gate.resolve();
    await Promise.all(calls);
    expect(order).toEqual(["import 1", "ask", "import 2", "import 3"]);
  });

  it("does not count the wait behind an import against the timeout of an Ask", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const ai = service(async (input) => {
      if (input.includes("import")) {
        started.resolve();
        await gate.promise;
      }
      return "answer";
    });
    const importing = ai.runDefaultTask("summarization", "import", { origin: "ingestion" });
    await started.promise;
    const deadline = new ActiveDeadline(2_000);
    const ask = ai.runDefaultTask("reranking", "ask", { origin: "consultation" }, deadline.signal);
    // The Ask waits twenty seconds for the one call in flight; its two-second timeout does not run.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deadline.signal.aborted).toBe(false);
    gate.resolve();
    await expect(ask).resolves.toMatchObject({ output: "answer" });
    await importing;
    expect(deadline.signal.aborted).toBe(false);
    expect(state.record.mock.calls.at(-1)?.[0]).toMatchObject({ status: "succeeded" });
    deadline.dispose();
  });

  it("times an Ask out while its own call executes", async () => {
    vi.useFakeTimers();
    const ai = service(
      (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        )
    );
    const deadline = new ActiveDeadline(2_000);
    const ask = ai.runDefaultTask("reranking", "ask", { origin: "consultation" }, deadline.signal);
    const settled = expect(ask).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    deadline.dispose();
  });

  it("resumes the clock of an Ask that is canceled while it waits", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const ai = service(async () => {
      started.resolve();
      await gate.promise;
      return "ok";
    });
    const importing = ai.runDefaultTask("summarization", "import", { origin: "ingestion" });
    await started.promise;
    const parent = new AbortController();
    const deadline = new ActiveDeadline(1_000, parent.signal);
    const ask = ai.runDefaultTask("reranking", "ask", { origin: "consultation" }, deadline.signal);
    const settled = expect(ask).rejects.toThrow("canceled");
    parent.abort(new Error("canceled"));
    await settled;
    gate.resolve();
    await importing;
    deadline.dispose();
  });
});
