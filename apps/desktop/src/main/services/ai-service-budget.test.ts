import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderError,
  OpenAiCompatibleAdapter,
  resolveAiRuntimeConfig,
  runRemoteCall
} from "@app/ai";
import type { Queryable } from "@app/db";
import { RemoteBudgetRefusal } from "@app/domain";

import { AiService } from "./ai-service.js";
import { RemoteBudget } from "./gardener/remote-budget.js";

/**
 * The AI service on the RemoteBudget (F4 D14, T76): a metered remote call reserves each attempt in
 * the retry loop before it is sent, the audit records its class, job and estimate, and the
 * reservation is released only once the audit row committed.
 */

const state = vi.hoisted(() => ({
  selections: new Map<string, Record<string, unknown>>(),
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string) => state.selections.get(task) ?? null,
    recordTaskRun: state.record
  })
}));

const ids = {
  profile: "00000000-0000-4000-8000-000000000001",
  config: "00000000-0000-4000-8000-0000000000c1",
  job: "00000000-0000-4000-8000-0000000000b1"
};

/** An OpenAI API configuration serving a priced model (US$ 1.25/M input, US$ 10/M output). */
const pricedSelection = {
  profileId: ids.profile,
  providerConfigId: ids.config,
  localModelId: null,
  provider: "openai-compatible",
  modelId: "gpt-5",
  runtime: "remote",
  revision: null,
  repository: null,
  quantization: null,
  baseUrl: "https://api.example.test/v1",
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: ["text-generation", "structured-output"]
};

/** A settings table in memory; the audit is never read back (the ledger starts empty). */
function budgetDatabase(): Queryable {
  const settings = new Map<string, unknown>();
  return {
    query: (async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("from ai_task_runs")) return { rows: [] };
      if (text.startsWith("select")) {
        const key = values[0] as string;
        return settings.has(key) ? { rows: [{ key, value: settings.get(key) }] } : { rows: [] };
      }
      settings.set(values[0] as string, values[1]);
      return { rows: [{ key: values[0], value: values[1], updatedAt: new Date() }] };
    }) as Queryable["query"]
  };
}

type Attempt = (number: number) => Promise<unknown>;

function service(attempt: Attempt, cap = 100) {
  const budget = new RemoteBudget({ getPool: budgetDatabase, monthlyCapUsd: () => cap });
  const ai = new AiService({
    userDataPath: "/tmp/ai-budget-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    lanes: {},
    isPackaged: false,
    remoteBudget: budget
  });
  const sent: number[] = [];
  const runtime = resolveAiRuntimeConfig({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
  // A remote adapter that runs the shared retry loop on the signal it is given, as every remote
  // adapter does, so the admission bound to that signal sees each attempt.
  const adapter = {
    describe: () => ({
      providerId: "openai-compatible",
      modelId: "gpt-5",
      runtime: "remote",
      capabilities: ["text-generation", "structured-output"],
      parameterCapabilities: { maxTokens: { min: 1, max: 100_000 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string }, signal?: AbortSignal) => {
      let number = 0;
      const output = await runRemoteCall(
        { config: runtime, random: () => 0 },
        { streaming: false, signal, taskType: request.taskType as never },
        async () => {
          number += 1;
          sent.push(number);
          return attempt(number);
        }
      );
      return {
        taskType: request.taskType,
        output,
        providerId: "openai-compatible",
        modelId: "gpt-5",
        runtime: "remote",
        durationMs: 1,
        inputTokens: 1_000,
        outputTokens: 2_000
      };
    })
  };
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(adapter)
  );
  return { ai, budget, sent };
}

const rows = () => state.record.mock.calls.map(([row]) => row as Record<string, unknown>);
const busy = () => new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
/** 10,000 output tokens on gpt-5: US$ 0.10 of output budget per attempt, plus the input bytes. */
const limits = { maxOutputTokens: 10_000 };
const background = {
  workloadClass: "write-fast" as const,
  priority: "P3" as const,
  budgetClass: "background" as const,
  jobId: ids.job
};

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
  state.selections.clear();
  state.selections.set("text-generation", pricedSelection);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote calls on the RemoteBudget", () => {
  it("audits the class, the job and the estimate, and spends the reported usage", async () => {
    const { ai, budget } = service(async () => "answer");
    await expect(
      ai.runDefaultTask("text-generation", "a prompt", background, undefined, limits)
    ).resolves.toMatchObject({ output: "answer" });
    const row = rows()[0]!;
    expect(row).toMatchObject({ budgetClass: "background", jobId: ids.job, status: "succeeded" });
    // The call reported its usage and no attempt went unreported: nothing counts beyond it.
    expect(row.budgetEstimateUsd).toBe(0);
    const money = (await budget.snapshot()).money;
    expect(money.reservedUsd).toBe(0);
    expect(money.spentUsd).toBeCloseTo((1_000 * 1.25 + 2_000 * 10) / 1e6, 12);
  });

  it("releases the reservation only after the audit row committed", async () => {
    const { ai, budget } = service(async () => "answer");
    const committed = Promise.withResolvers<string>();
    const writing = Promise.withResolvers<void>();
    state.record.mockImplementationOnce(() => {
      writing.resolve();
      return committed.promise;
    });
    const call = ai.runDefaultTask("text-generation", "a prompt", background, undefined, limits);
    await writing.promise;
    const during = (await budget.snapshot()).money;
    expect(during.reservedUsd).toBeGreaterThan(0.1);
    expect(during.spentUsd).toBe(0);
    committed.resolve("run-id");
    await call;
    expect((await budget.snapshot()).money.reservedUsd).toBe(0);
  });

  it("re-reserves a retried attempt and refuses the one past the cap, sending nothing more", async () => {
    // Room for one attempt and not two: the retry after a transient failure is refused.
    const { ai, budget, sent } = service(async () => {
      throw busy();
    }, 0.15);
    await budget.continuePastPause();
    const failure = await ai
      .runDefaultTask("text-generation", "a prompt", background, undefined, limits)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteBudgetRefusal);
    expect((failure as RemoteBudgetRefusal).blockedReason).toBe("money_100");
    expect(sent).toEqual([1]);
    const row = rows()[0]!;
    expect(row).toMatchObject({ status: "failed", budgetClass: "background" });
    // The billed first attempt reported no usage: its estimate stays as spend.
    const money = (await budget.snapshot()).money;
    expect(money.reservedUsd).toBe(0);
    expect(money.spentUsd).toBeCloseTo(row.budgetEstimateUsd as number, 12);
  });

  it("refuses background work before anything is sent, never P0 or user-started work", async () => {
    const { ai, sent } = service(async () => "answer", 0);
    await expect(
      ai.runDefaultTask("text-generation", "a prompt", background, undefined, limits)
    ).rejects.toBeInstanceOf(RemoteBudgetRefusal);
    expect(sent).toEqual([]);
    await expect(
      ai.runDefaultTask(
        "text-generation",
        "a prompt",
        { ...background, budgetClass: "user", priority: "P2" },
        undefined,
        limits
      )
    ).resolves.toMatchObject({ output: "answer" });
    await expect(
      ai.runDefaultTask(
        "text-generation",
        "a prompt",
        { ...background, priority: "P0" },
        undefined,
        limits
      )
    ).resolves.toMatchObject({ output: "answer" });
    expect(sent).toEqual([1, 1]);
    // User-started work is audited with its class and no estimate: it is not metered.
    expect(rows().at(-2)).toMatchObject({ budgetClass: "user" });
    expect(rows().at(-2)!.budgetEstimateUsd).toBeUndefined();
  });

  it("keeps the estimate of a retried attempt that stalled after its deltas without usage", async () => {
    // Attempt 1 is accepted, streams a few deltas and stalls before its usage arrives (billed by the
    // provider, reported to nobody); attempt 2 answers with its usage. The stalled attempt is spend.
    const encoder = new TextEncoder();
    const event = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    let requests = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      requests += 1;
      const stall = requests === 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          for (let index = 0; index < 5; index += 1)
            controller.enqueue(event({ choices: [{ delta: { content: "w " } }] }));
          if (stall) return;
          controller.enqueue(
            event({ choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 5 } })
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const runtime = {
      deadlines: { stallMs: 50, answerStartMs: 5_000, firstByteMs: 5_000 },
      retry: { baseDelayMs: 1, maxDelayMs: 1 }
    };
    const budget = new RemoteBudget({ getPool: budgetDatabase, monthlyCapUsd: () => 100 });
    const ai = new AiService({
      userDataPath: "/tmp/ai-budget-tests",
      getPool: () => ({}) as never,
      workspaceRoot: "/tmp",
      resourcesPath: "/tmp",
      lanes: {},
      isPackaged: false,
      runtime,
      remoteBudget: budget
    });
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: pricedSelection.baseUrl,
      apiKey: "test-key-not-a-secret",
      modelId: "gpt-5",
      capabilities: ["text-generation", "structured-output"],
      runtime,
      fetch: fakeFetch,
      random: () => 0
    });
    const internals = ai as unknown as {
      createAdapter: () => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
      internals.registerAdapter(adapter)
    );
    await expect(
      ai.runDefaultTask("text-generation", "a prompt", background, undefined, limits)
    ).resolves.toMatchObject({ output: "w w w w w " });
    expect(requests).toBe(2);
    const row = rows()[0]!;
    expect(row).toMatchObject({ status: "succeeded", inputTokens: 1_000, outputTokens: 5 });
    const reported = (1_000 * 1.25 + 5 * 10) / 1e6;
    const money = (await budget.snapshot()).money;
    expect(money.reservedUsd).toBe(0);
    // The stalled attempt's estimate stays as spend on top of the reported usage, and the audit
    // stores it so a reload of the ledger counts the same.
    expect(row.budgetEstimateUsd as number).toBeGreaterThan(0.1);
    expect(money.spentUsd).toBeCloseTo(reported + (row.budgetEstimateUsd as number), 12);
  });
});
