import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, aiErrorRetryAfterMs, lanePermitOf } from "@app/ai";

import { AiService } from "./ai-service.js";
import { isTransientJobFailure } from "./job-failure.js";

/**
 * The circuit breaker of a remote lane on the AI service (F3 D32, T47b): five consecutive transient
 * failures open it, new calls then fail fast and are audited, a single probe closes it again, and
 * the local lane never notices.
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
const codexLane = `remote:${ids.codexConfig}`;

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

const capabilities = [
  "text-generation",
  "summarization",
  "structured-output",
  "atomic-note-generation",
  "offline"
];

/** What the provider does with a call: answer it, or fail it as the adapters' retry loop reports. */
type Behavior = "answer" | "busy";

function adapter(providerId: string, modelId: string, runtime: string, behave: () => Behavior) {
  return {
    describe: () => ({
      providerId,
      modelId,
      runtime,
      capabilities,
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string }, signal?: AbortSignal) => {
      // As `runRemoteCall` does: every response reports its outcome to the lane of the call.
      const permit = lanePermitOf(signal);
      if (behave() === "busy") {
        permit?.observeOutcome("transient");
        throw new AiProviderError("The provider is busy.", {
          kind: "http",
          transient: true,
          status: 503
        });
      }
      permit?.observeOutcome("ok");
      return {
        taskType: request.taskType,
        output: "ok",
        providerId,
        modelId,
        runtime,
        durationMs: 1
      };
    })
  };
}

/** The scheduler reads `performance.now`, which the tests move by hand. */
const advance = (milliseconds: number) => void vi.advanceTimersByTime(milliseconds);

function service(behavior: { provider: Behavior } = { provider: "answer" }) {
  const logger = { info: vi.fn(), error: vi.fn() };
  const ai = new AiService({
    userDataPath: "/tmp/ai-breaker-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    logger
  });
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    createLocalAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  const remote = adapter("openai-codex", "writer", "remote", () => behavior.provider);
  const local = adapter("local-gguf", "local-writer", "local", () => "answer");
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(remote)
  );
  vi.spyOn(internals, "createLocalAdapter").mockImplementation(async () =>
    internals.registerAdapter(local)
  );
  return { ai, remote, local, behavior, logger };
}

const rows = () => state.record.mock.calls.map(([row]) => row as Record<string, unknown>);
const breaker = (ai: AiService, lane = codexLane) =>
  ai.laneSnapshots().find((snapshot) => snapshot.lane === lane)?.breaker;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] });
  state.record.mockReset().mockResolvedValue("run-id");
  state.selections.clear();
  state.selections.set("text-generation", remoteSelection);
  state.selections.set("summarization", localSelection);
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

describe("the circuit breaker of a remote lane on the AI service", () => {
  it("fails new calls fast once five transient failures in a row opened it, and audits each one", async () => {
    const { ai, remote, logger } = service({ provider: "busy" });
    for (let call = 0; call < 5; call++)
      await expect(ai.runDefaultTask("text-generation", `question ${call}`)).rejects.toMatchObject({
        status: 503
      });
    expect(breaker(ai)).toMatchObject({ state: "open", opened: 1 });
    expect(remote.run).toHaveBeenCalledTimes(5);

    const failure = await ai
      .runDefaultTask("text-generation", "an Ask while the provider is down", {
        origin: "consultation"
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "errors.ai.providerUnavailable",
      transient: true,
      lane: codexLane,
      aiTaskRunId: "run-id"
    });
    // Nothing reached the provider, and a job retries the failure after the breaker's period.
    expect(remote.run).toHaveBeenCalledTimes(5);
    expect(isTransientJobFailure(failure)).toBe(true);
    expect(aiErrorRetryAfterMs(failure)).toBe(30_000);
    // S9: one row for the call that failed fast, with the lane, priority, class and deadline.
    expect(rows()).toHaveLength(6);
    expect(rows()[5]).toMatchObject({
      status: "failed",
      error: "errors.ai.providerUnavailable",
      lane: codexLane,
      workloadClass: "answer",
      priority: 0,
      deadlineMs: 180_000,
      deadlineOutcome: "met",
      durationMs: 0,
      retryWaitMs: 0,
      requeueMs: 0,
      provider: "openai-codex",
      // Nothing was sent: the monthly ledger counts it as nothing, not at its output budget.
      budgetEstimateUsd: 0
    });
    expect(logger.info).toHaveBeenCalledWith(
      `AI lane ${codexLane}: circuit breaker closed -> open (failures)`
    );
  });

  it("leaves the local lane alone while a remote lane is down", async () => {
    const { ai } = service({ provider: "busy" });
    for (let call = 0; call < 5; call++)
      await ai.runDefaultTask("text-generation", "question").catch(() => undefined);
    expect(breaker(ai)?.state).toBe("open");
    await expect(ai.runDefaultTask("summarization", "a local summary")).resolves.toMatchObject({
      output: "ok"
    });
    expect(breaker(ai, "local")).toBeNull();
  });

  it("lets one probe through after the open period and closes on its answer", async () => {
    const { ai, remote, behavior, logger } = service({ provider: "busy" });
    for (let call = 0; call < 5; call++)
      await ai.runDefaultTask("text-generation", "question").catch(() => undefined);
    advance(29_999);
    await expect(ai.runDefaultTask("text-generation", "too early")).rejects.toThrow(
      "errors.ai.providerUnavailable"
    );
    expect(remote.run).toHaveBeenCalledTimes(5);
    // The provider is back; the first call after the period is the probe.
    behavior.provider = "answer";
    advance(1);
    await expect(ai.runDefaultTask("text-generation", "the probe")).resolves.toMatchObject({
      output: "ok"
    });
    expect(remote.run).toHaveBeenCalledTimes(6);
    expect(breaker(ai)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    await expect(ai.runDefaultTask("text-generation", "normal again")).resolves.toMatchObject({
      output: "ok"
    });
    expect(logger.info.mock.calls.map(([line]) => String(line).split(": ")[1])).toEqual([
      "circuit breaker closed -> open (failures)",
      "circuit breaker open -> half_open (elapsed)",
      "circuit breaker half_open -> closed (probe_answered)"
    ]);
  });

  it("opens again when the probe fails, for another full period", async () => {
    const { ai, remote } = service({ provider: "busy" });
    for (let call = 0; call < 5; call++)
      await ai.runDefaultTask("text-generation", "question").catch(() => undefined);
    advance(30_000);
    await expect(ai.runDefaultTask("text-generation", "the probe")).rejects.toMatchObject({
      status: 503
    });
    expect(remote.run).toHaveBeenCalledTimes(6);
    expect(breaker(ai)).toMatchObject({ state: "open", opened: 2, reopensInMs: 30_000 });
    await expect(ai.runDefaultTask("text-generation", "refused")).rejects.toThrow(
      "errors.ai.providerUnavailable"
    );
    expect(remote.run).toHaveBeenCalledTimes(6);
  });
});
