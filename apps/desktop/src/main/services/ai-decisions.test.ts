import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiCassette,
  AiModelRegistry,
  createAiScheduler,
  decisionsCostUsd,
  DecisionsDisabledError,
  DecisionsUnavailableError,
  estimatePlanInputTokens,
  planDecisionRequests,
  resolveAiLaneRuntimeConfig,
  resolveDecisionsLimits,
  setAiAdapterDecorator,
  type AiScheduler
} from "@app/ai";
import type { PgPool } from "@app/db";
import {
  frozenRelationCalibrations,
  relationsConfig,
  RelationsConfigSchema,
  relationsDecisionsCredentialRef,
  relationsDecisionsSettingKey,
  relationsDecisionsSpendSettingKey,
  relationsDecisionsStateSettingKey,
  RemoteBudgetRefusal
} from "@app/domain";

import { DecisionsRuntime, type DecisionsRuntimeOptions } from "./ai-decisions.js";
import { decisionsDesign, relationDecisionsInstruction } from "./relations/decisions-identity.js";

/**
 * The Decisions runtime over an in-memory settings table and AI audit: routing by setup, the opt-in,
 * the key, the fallback reasons, the lane and its breaker, the spend cap and the audit. No network:
 * `fetch` is a fake, and nothing here reaches OpenAI.
 */

const store = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  runs: [] as Array<Record<string, unknown>>
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createSettingsRepository: () => ({
    get: async (key: string) => store.settings.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      store.settings.set(key, value);
      return { key, value };
    },
    delete: async (key: string) => store.settings.delete(key)
  }),
  createAiConfigRepository: () => ({
    recordTaskRun: async (run: Record<string, unknown>) => {
      store.runs.push(run);
      return `run-${store.runs.length}`;
    }
  })
}));

const key = "sk-proj-0123456789abcdefghij";
const limits = resolveDecisionsLimits({ retry: { baseDelayMs: 1, maxDelayMs: 2 } });
const note = (title: string) => `Title: ${title}\nIdea: Idea of ${title}\nText: Body of ${title}.`;

/** The settings table's spend counter as the budget's SQL reads and writes it. */
function fakePool(): PgPool {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("select value from settings"))
        return { rows: [{ value: store.settings.get(String(params[0])) }], rowCount: 1 };
      if (sql.includes("insert into settings")) {
        const [settingKey, day, tokens] = params as [string, string, number];
        const current = store.settings.get(settingKey) as
          { day: string; inputTokens: number; requests: number } | undefined;
        store.settings.set(
          settingKey,
          current?.day === day
            ? {
                day,
                inputTokens: current.inputTokens + tokens,
                requests: current.requests + 1
              }
            : { day, inputTokens: tokens, requests: 1 }
        );
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  } as unknown as PgPool;
}

const answer = (count: number, probability: number, tokens = 1_000) =>
  Response.json({
    model: "gpt-6-luna",
    answers: Array.from({ length: count }, (_, index) => ({
      type: "predicate",
      name: `rel_c${index + 1}`,
      probability
    })),
    usage: { input_tokens: tokens, output_tokens: 0 }
  });

interface Harness {
  runtime: DecisionsRuntime;
  scheduler: AiScheduler;
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  credentials: { save: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  secrets: Map<string, string>;
  logs: unknown[][];
}

function harness(
  options: Partial<DecisionsRuntimeOptions> & {
    preset?: string | null;
    enabled?: boolean;
    withKey?: boolean;
    fetchImpl?: typeof globalThis.fetch;
    config?: ReturnType<typeof RelationsConfigSchema.parse>;
  } = {}
): Harness {
  const { preset = "hybrid", enabled = true, withKey = true, fetchImpl, ...rest } = options;
  store.settings.clear();
  store.runs.length = 0;
  if (preset !== null) store.settings.set("ai.preset.v1", { mode: preset, at: "now" });
  if (enabled) store.settings.set(relationsDecisionsSettingKey, { enabled: true });
  const secrets = new Map<string, string>();
  if (withKey) secrets.set(relationsDecisionsCredentialRef, key);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(fetchImpl ?? (async () => answer(1, 0.9)));
  const credentials = {
    save: vi.fn(async (secret: string, ref?: string | null) => {
      secrets.set(ref ?? "other", secret);
      return ref ?? "other";
    }),
    remove: vi.fn(async (ref: string) => secrets.delete(ref))
  };
  const logs: unknown[][] = [];
  const scheduler = createAiScheduler(resolveAiLaneRuntimeConfig({}, { environment: {} }));
  const runtime = new DecisionsRuntime({
    getPool: () => fakePool(),
    scheduler,
    registry: new AiModelRegistry(),
    credentials,
    readSecret: async (reference) => {
      const secret = secrets.get(reference);
      if (!secret) throw new Error("errors.ai.missingCredential");
      return secret;
    },
    logger: { error: (...args) => logs.push(args), info: (...args) => logs.push(args) },
    limits: { retry: { baseDelayMs: 1, maxDelayMs: 2 } },
    fetch,
    random: () => 0.5,
    now: () => new Date("2026-10-20T10:00:00.000Z"),
    ...rest
  });
  return { runtime, scheduler, fetch, credentials, secrets, logs };
}

const lists = [
  { query: note("Query"), candidates: [note("One"), note("Two"), note("Three")] },
  { query: note("One"), candidates: [note("Query")] }
];
const decide = (h: Harness, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
  h.runtime.decide(
    {
      operation: "relation_decide_decisions",
      instruction: relationDecisionsInstruction(),
      lists,
      priority: "P2",
      sourceIds: [],
      ...extra
    },
    signal
  );

beforeEach(() => {
  store.settings.clear();
  store.runs.length = 0;
});

describe("where the Decisions decider is offered", () => {
  it.each([
    ["local", false],
    ["custom", false],
    [null, false],
    ["hybrid", true],
    ["cloud", true]
  ])("in the %s setup: %s", async (preset, offered) => {
    const h = harness({ preset });
    const status = await h.runtime.status();
    expect(status.presetAllowed).toBe(offered);
    expect(status.state).toBe(offered ? "ready" : "unavailable_preset");
    // Turned on in Hybrid and then switched to Local, it is never used: the setup decides, always.
    expect(await h.runtime.resolve()).toEqual(
      offered ? { use: "decisions" } : { use: "local", reason: null }
    );
    if (!offered) {
      await expect(decide(h)).rejects.toThrow("errors.relations.decisions.presetNotAllowed");
      expect(h.fetch).not.toHaveBeenCalled();
    }
  });

  it("cannot be turned on in Local, and is off until the person turns it on", async () => {
    const local = harness({ preset: "local", enabled: false });
    await expect(local.runtime.setEnabled(true)).rejects.toThrow(
      "errors.relations.decisions.presetNotAllowed"
    );
    expect(store.settings.get(relationsDecisionsSettingKey)).toBeUndefined();
    const fresh = harness({ preset: "hybrid", enabled: false });
    expect(await fresh.runtime.status()).toMatchObject({ state: "off", enabled: false });
    expect(await fresh.runtime.resolve()).toEqual({ use: "local", reason: null });
    expect(await fresh.runtime.setEnabled(true)).toMatchObject({ enabled: true, state: "ready" });
    expect(store.settings.get(relationsDecisionsSettingKey)).toEqual({ enabled: true });
    expect(await fresh.runtime.setEnabled(false)).toMatchObject({ enabled: false, state: "off" });
  });

  it("is on in a DEV proof without the opt-in, and a profile with no setup counts as Hybrid", async () => {
    const dev = harness({ preset: null, enabled: false, devEnabled: true });
    expect(await dev.runtime.resolve()).toEqual({ use: "decisions" });
    // The Local setup is still refused.
    const local = harness({ preset: "local", enabled: false, devEnabled: true });
    expect(await local.runtime.resolve()).toEqual({ use: "local", reason: null });
  });
});

describe("deciding", () => {
  it("scores each list in both candidate orders on its own remote lane and audits every request", async () => {
    const h = harness({
      fetchImpl: async (_url, init) => {
        const count = (JSON.parse(init!.body as string) as { questions: unknown[] }).questions
          .length;
        return answer(count, 0.9, 1_200);
      }
    });
    const result = await decide(h, {
      sourceIds: ["source-1"],
      jobId: undefined,
      stage: "atomic_note_matching"
    });
    // Three candidates: two orders, unless the shuffles agree; one candidate: one request.
    expect(h.fetch.mock.calls.length).toBe(result.calls);
    expect(result.calls).toBeGreaterThanOrEqual(2);
    expect(result.calls).toBeLessThanOrEqual(3);
    expect(result.decisions[0]!.map((d) => d.probability)).toEqual([
      expect.closeTo(0.9, 12),
      expect.closeTo(0.9, 12),
      expect.closeTo(0.9, 12)
    ]);
    expect(result.decisions[0]![0]!.logOdds).toBeCloseTo(Math.log(9), 6);
    expect(result.decisions[1]!).toHaveLength(1);
    expect(result.decisions.flat().every((decision) => decision.aiTaskRunId !== null)).toBe(true);
    expect(result.inputTokens).toBe(1_200 * result.calls);
    expect(result.costUsd).toBeCloseTo((1_200 * result.calls * 0.1) / 1_000_000, 10);
    // One audit row per request: provider, model, remote lane, class, tokens and cost.
    expect(store.runs).toHaveLength(result.calls);
    for (const run of store.runs)
      expect(run).toMatchObject({
        taskType: "reranking",
        provider: "openai-decisions",
        modelId: "gpt-6-luna",
        runtime: "remote",
        lane: "remote:openai-decisions",
        workloadClass: "decide",
        priority: 2,
        inputTokens: 1_200,
        status: "succeeded",
        sourceItemIds: ["source-1"]
      });
    expect(store.runs[0]!.costEstimate).toBeCloseTo(0.00012, 10);
    // The day's spend counts the reported input tokens.
    const status = await h.runtime.status();
    expect(status.requestsToday).toBe(result.calls);
    expect(status.spentTodayUsd).toBeCloseTo((1_200 * result.calls * 0.1) / 1_000_000, 10);
    expect(status.lastUsedAt).toBe("2026-10-20T10:00:00.000Z");
    // No request carried the key anywhere but the Authorization header.
    for (const [, init] of h.fetch.mock.calls) {
      expect(String(init!.body)).not.toContain(key);
      expect(init!.headers).toMatchObject({ authorization: `Bearer ${key}` });
    }
    expect(JSON.stringify(store.runs)).not.toContain(key);
  });

  it("runs at most the lane's limit of requests at once", async () => {
    let running = 0;
    let peak = 0;
    const h = harness({
      fetchImpl: async (_url, init) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        const count = (JSON.parse(init!.body as string) as { questions: unknown[] }).questions
          .length;
        return answer(count, 0.5, 10);
      }
    });
    const many = Array.from({ length: 12 }, (_, index) => ({
      query: note(`Query ${index}`),
      candidates: [note(`Candidate ${index}`)]
    }));
    await h.runtime.decide({
      operation: "relation_decide_decisions",
      instruction: relationDecisionsInstruction(),
      lists: many
    });
    expect(h.fetch).toHaveBeenCalledTimes(12);
    // `apiKeyMax` of the typed lane configuration.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  describe("with a DEV cassette", () => {
    afterEach(() => setAiAdapterDecorator(null));
    const oneList = [{ query: note("Q"), candidates: [note("C")] }];
    const ask = (h: Harness) =>
      h.runtime.decide({
        operation: "relation_decide_decisions",
        instruction: relationDecisionsInstruction(),
        lists: oneList
      });

    it("records, then replays with no key, no network and no spend", async () => {
      const directory = await mkdtemp(join(tmpdir(), "decisions-runtime-"));
      try {
        const recording = new AiCassette({ mode: "record", directory });
        setAiAdapterDecorator((adapter) => recording.wrap(adapter));
        const live = harness({
          cassetteMode: "record",
          fetchImpl: async () => answer(1, 0.8, 700)
        });
        const recorded = await ask(live);
        expect(recorded).toMatchObject({ calls: 1, inputTokens: 700, replayed: 0 });
        expect(recording.stats()).toMatchObject({ recorded: 1 });
        expect((await live.runtime.status()).requestsToday).toBe(1);

        // A fresh process: replay, no key stored, a provider that must not be reached.
        const replaying = new AiCassette({ mode: "replay", directory });
        setAiAdapterDecorator((adapter) => replaying.wrap(adapter));
        const offline = harness({ cassetteMode: "replay", withKey: false });
        expect(await offline.runtime.resolve()).toEqual({ use: "decisions" });
        const replayed = await ask(offline);
        expect(offline.fetch).not.toHaveBeenCalled();
        expect(replayed).toMatchObject({ calls: 1, inputTokens: 700, costUsd: 0, replayed: 1 });
        expect(replayed.decisions[0]![0]!.probability).toBeCloseTo(0.8, 12);
        // The audit keeps the recorded tokens and no cost; the day's spend stays zero.
        expect(store.runs[0]).toMatchObject({
          inputTokens: 700,
          costEstimate: 0,
          status: "succeeded"
        });
        expect(await offline.runtime.status()).toMatchObject({
          spentTodayUsd: 0,
          requestsToday: 0,
          keyStored: false,
          state: "ready"
        });
        // A request the cassette does not hold fails visibly, as a fallback, and calls nothing.
        await expect(
          offline.runtime.decide({
            operation: "relation_decide_decisions",
            instruction: relationDecisionsInstruction(),
            lists: [{ query: note("Other"), candidates: [note("C")] }]
          })
        ).rejects.toBeInstanceOf(DecisionsUnavailableError);
        expect(offline.fetch).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});

describe("falling back to the local ranker", () => {
  it("says no key was saved, and keeps saying it", async () => {
    const h = harness({ withKey: false });
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "no_key" });
    expect(await h.runtime.status()).toMatchObject({
      state: "fallback",
      fallbackReason: "no_key",
      keyStored: false
    });
    await expect(decide(h)).rejects.toMatchObject({
      reason: "no_key",
      message: "errors.relations.decisions.noKey"
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(store.settings.get(relationsDecisionsStateSettingKey)).toMatchObject({
      fallback: { reason: "no_key" }
    });
  });

  it("stops at the day's spend cap, before the next request, and starts again on a new day", async () => {
    const h = harness({
      config: RelationsConfigSchema.parse({ decisions: { dailyCapUsd: 0.0001 } }),
      fetchImpl: async () => answer(1, 0.9, 5_000)
    });
    await h.runtime.decide({
      operation: "relation_decide_decisions",
      instruction: relationDecisionsInstruction(),
      lists: [{ query: note("Q"), candidates: [note("C")] }]
    });
    // 5,000 input tokens at US$ 0.10 per million is US$ 0.0005, over the cap of US$ 0.0001.
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "spend_cap" });
    expect(await h.runtime.status()).toMatchObject({
      state: "fallback",
      fallbackReason: "spend_cap",
      dailyCapUsd: 0.0001
    });
    const calls = h.fetch.mock.calls.length;
    await expect(decide(h)).rejects.toMatchObject({ reason: "spend_cap" });
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    // Tomorrow the counter is zero again.
    store.settings.set(relationsDecisionsSpendSettingKey, {
      day: "2026-10-19",
      inputTokens: 5_000,
      requests: 1
    });
    expect(await h.runtime.resolve()).toEqual({ use: "decisions" });
  });

  it("takes the cap of a DEV proof run over the typed one", async () => {
    const h = harness({
      config: RelationsConfigSchema.parse({ decisions: { dailyCapUsd: 0.00001 } }),
      devCapUsd: 5
    });
    expect(await h.runtime.status()).toMatchObject({ dailyCapUsd: 5, state: "ready" });
    await expect(decide(h)).resolves.toMatchObject({ calls: expect.any(Number) });
  });

  it("refuses a plan that would pass the cap before it sends a request", async () => {
    const h = harness({
      config: RelationsConfigSchema.parse({ decisions: { dailyCapUsd: 0.00001 } })
    });
    await expect(decide(h)).rejects.toMatchObject({ reason: "spend_cap" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("marks a key the provider refuses, sends nothing more, and forgets it when a key is saved", async () => {
    const h = harness({
      fetchImpl: async () => new Response(`Incorrect API key provided: ${key}`, { status: 401 })
    });
    const failure = await decide(h).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(DecisionsUnavailableError);
    expect(failure).toMatchObject({
      reason: "invalid_key",
      message: "errors.relations.decisions.invalidKey"
    });
    // The key is nowhere: not in the message, the cause, the log or the audit.
    const text = JSON.stringify([
      (failure as Error).message,
      ((failure as Error).cause as Error | undefined)?.message,
      h.logs,
      store.runs
    ]);
    expect(text).not.toContain(key);
    expect(text).not.toContain("0123456789abcdefghij");
    expect(store.runs.every((run) => run.status === "failed")).toBe(true);
    expect(await h.runtime.status()).toMatchObject({ keyInvalid: true, state: "fallback" });
    const calls = h.fetch.mock.calls.length;
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "invalid_key" });
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    await h.runtime.saveKey("sk-proj-another-valid-key-0123456789");
    expect(await h.runtime.status()).toMatchObject({ keyInvalid: false, state: "ready" });
  });

  it("falls back on an exhausted quota and on a provider that keeps failing", async () => {
    const quota = harness({
      fetchImpl: async () =>
        new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })
    });
    await expect(decide(quota)).rejects.toMatchObject({ reason: "quota" });
    const down = harness({ fetchImpl: async () => new Response("down", { status: 503 }) });
    await expect(decide(down)).rejects.toMatchObject({
      reason: "network",
      message: "errors.relations.decisions.network"
    });
    // Every request retried, bounded by the typed attempts.
    expect(down.fetch.mock.calls.length).toBeGreaterThanOrEqual(limits.retry.maxAttempts);
    expect(down.fetch.mock.calls.length).toBeLessThanOrEqual(3 * limits.retry.maxAttempts);
    // Five failures in a row opened the lane's breaker: that is now the reason it cannot decide.
    expect(await down.runtime.status()).toMatchObject({
      state: "fallback",
      fallbackReason: "breaker_open"
    });
  });

  it("remembers a failed request while the decider can still decide, until the next success", async () => {
    let failing = true;
    const h = harness({
      fetchImpl: async () => (failing ? new Response("down", { status: 503 }) : answer(1, 0.7, 50))
    });
    const one = () =>
      h.runtime.decide({
        operation: "relation_decide_decisions",
        instruction: relationDecisionsInstruction(),
        lists: [{ query: note("Q"), candidates: [note("C")] }]
      });
    await expect(one()).rejects.toMatchObject({ reason: "network" });
    // Four failures: the breaker (five) is still closed, so it is ready, and says what happened.
    expect(await h.runtime.status()).toMatchObject({ state: "ready", fallbackReason: "network" });
    failing = false;
    await one();
    expect(await h.runtime.status()).toMatchObject({ state: "ready", fallbackReason: null });
  });

  it("opens the lane's breaker after consecutive transient failures and fails fast, then probes", async () => {
    const h = harness({ fetchImpl: async () => new Response("down", { status: 503 }) });
    const single = (index: number) =>
      h.runtime.decide({
        operation: "relation_decide_decisions",
        instruction: relationDecisionsInstruction(),
        lists: [{ query: note(`Q${index}`), candidates: [note(`C${index}`)] }]
      });
    await expect(single(1)).rejects.toMatchObject({ reason: "network" });
    await expect(single(2)).rejects.toMatchObject({ reason: "network" });
    const sent = h.fetch.mock.calls.length;
    expect(
      h.scheduler.snapshot().find((lane) => lane.lane === "remote:openai-decisions")
    ).toMatchObject({
      breaker: { state: "open" }
    });
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "breaker_open" });
    await expect(single(3)).rejects.toMatchObject({ reason: "breaker_open" });
    expect(h.fetch).toHaveBeenCalledTimes(sent);
  });

  it("rethrows a cancellation as it is, not as a fallback", async () => {
    const controller = new AbortController();
    const h = harness({
      fetchImpl: async (_url, init) => {
        controller.abort(new Error("canceled"));
        throw init?.signal?.reason ?? new Error("aborted");
      }
    });
    const failure = await decide(h, {}, controller.signal).catch((caught: unknown) => caught);
    expect(failure).not.toBeInstanceOf(DecisionsUnavailableError);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("the OpenAI Platform key", () => {
  it("is stored under its fixed reference of the secure store, never in a setting or a status", async () => {
    const h = harness({ withKey: false });
    const status = await h.runtime.saveKey(`  ${key}  `);
    expect(h.credentials.save).toHaveBeenCalledOnce();
    expect(h.credentials.save).toHaveBeenCalledWith(key, relationsDecisionsCredentialRef);
    expect(status).toMatchObject({ keyStored: true, keyInvalid: false });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(JSON.stringify([...store.settings])).not.toContain(key);
    // Removing it clears the secret and every sign of its use.
    const removed = await h.runtime.removeKey();
    expect(h.credentials.remove).toHaveBeenCalledWith(relationsDecisionsCredentialRef);
    expect(removed).toMatchObject({ keyStored: false, keyInvalid: false, lastUsedAt: null });
  });

  it.each(["short", "has a space in the middle of it 0123456789", "sk-proj-ñ-0123456789abcdef"])(
    "refuses %j as not a key, without storing it",
    async (candidate) => {
      const h = harness({ withKey: false });
      await expect(h.runtime.saveKey(candidate)).rejects.toThrow(
        "errors.relations.decisions.keyFormat"
      );
      expect(h.credentials.save).not.toHaveBeenCalled();
    }
  );

  it("reads the key from a DEV file instead of the secure store when a run names one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decisions-key-"));
    try {
      const file = join(directory, "key");
      await writeFile(file, `${key}\n`);
      const h = harness({ withKey: false, devKeyFile: file });
      expect(await h.runtime.resolve()).toEqual({ use: "decisions" });
      expect(await h.runtime.status()).toMatchObject({ keyStored: true });
      await decide(h);
      expect(h.fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `Bearer ${key}` });
      expect(JSON.stringify(await h.runtime.status())).not.toContain(key);
      // An empty or missing file is no key.
      await writeFile(file, "\n");
      expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "no_key" });
      const missing = harness({ withKey: false, devKeyFile: join(directory, "absent") });
      expect(await missing.runtime.resolve()).toEqual({ use: "local", reason: "no_key" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tests the key with one tiny request, and marks a refused key", async () => {
    const works = harness();
    expect(await works.runtime.testKey()).toMatchObject({ keyStored: true, keyInvalid: false });
    expect(works.fetch).toHaveBeenCalledOnce();
    const refused = harness({ fetchImpl: async () => new Response("no", { status: 401 }) });
    await expect(refused.runtime.testKey()).rejects.toMatchObject({ reason: "invalid_key" });
    expect(await refused.runtime.status()).toMatchObject({ keyInvalid: true });
    const none = harness({ withKey: false });
    await expect(none.runtime.testKey()).rejects.toMatchObject({ reason: "no_key" });
    expect(none.fetch).not.toHaveBeenCalled();
  });
});

/** Twelve lists of one candidate: twelve requests, of which the lane runs a few at a time. */
const manyLists = () =>
  Array.from({ length: 12 }, (_, index) => ({
    query: note(`Query ${index}`),
    candidates: [note(`Candidate ${index}`)]
  }));
const decideMany = (h: Harness) =>
  h.runtime.decide({
    operation: "relation_decide_decisions",
    instruction: relationDecisionsInstruction(),
    lists: manyLists()
  });
/** A provider that takes a moment to answer and honors the abort of its request. */
const slowAnswer =
  (onStart: () => void): typeof globalThis.fetch =>
  async (_url, init) => {
    onStart();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 40);
      init!.signal!.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init!.signal!.reason);
      });
    });
    return answer(1, 0.5, 10);
  };

describe("nothing is sent once the person says so", () => {
  it("turning it off stops the requests already admitted: queued, retrying and in flight", async () => {
    let started = 0;
    let off = false;
    let sentAfterOff = 0;
    const h = harness({
      fetchImpl: slowAnswer(() => {
        started += 1;
        if (off) sentAfterOff += 1;
      })
    });
    const plan = decideMany(h).catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(started).toBeGreaterThan(0), { interval: 1 });
    await h.runtime.setEnabled(false);
    off = true;
    const failure = await plan;
    expect(failure).toBeInstanceOf(DecisionsDisabledError);
    expect(failure).not.toBeInstanceOf(DecisionsUnavailableError);
    expect(sentAfterOff).toBe(0);
    // Only what the lane had running when it was turned off was sent, never the queue behind it.
    expect(started).toBeLessThan(12);
    // It is a choice, not a failure: no fallback is recorded, and the lane and the cap are free.
    expect(store.settings.get(relationsDecisionsStateSettingKey)).not.toMatchObject({
      fallback: { reason: expect.any(String) }
    });
    expect(
      h.scheduler.snapshot().find((lane) => lane.lane === "remote:openai-decisions")?.running
    ).toBe(0);
    // Turned on again, it works: the stop belonged to the plans admitted before it.
    await h.runtime.setEnabled(true);
    await expect(decide(h)).resolves.toMatchObject({ calls: expect.any(Number) });
  });

  it.each(["local", "custom"] as const)(
    "switching the setup to %s stops them too, and withdraws the opt-in",
    async (mode) => {
      let started = 0;
      let left = false;
      let sentAfterLeaving = 0;
      const h = harness({
        fetchImpl: slowAnswer(() => {
          started += 1;
          if (left) sentAfterLeaving += 1;
        })
      });
      const plan = decideMany(h).catch((caught: unknown) => caught);
      await vi.waitFor(() => expect(started).toBeGreaterThan(0), { interval: 1 });
      // The setup is written first, then the runtime is told (as the class-route service does).
      store.settings.set("ai.preset.v1", { mode, at: "now" });
      await h.runtime.presetChanged(mode);
      left = true;
      expect(await plan).toBeInstanceOf(DecisionsDisabledError);
      expect(sentAfterLeaving).toBe(0);
      expect(started).toBeLessThan(12);
      expect(store.settings.get(relationsDecisionsSettingKey)).toEqual({ enabled: false });
      // Back in Hybrid it asks again: the opt-in is not resumed silently.
      store.settings.set("ai.preset.v1", { mode: "hybrid", at: "now" });
      await h.runtime.presetChanged("hybrid");
      expect(await h.runtime.status()).toMatchObject({ state: "off", enabled: false });
      expect(await h.runtime.resolve()).toEqual({ use: "local", reason: null });
    }
  );

  it("a Hybrid to Cloud change leaves a plan and the opt-in alone", async () => {
    const h = harness();
    store.settings.set("ai.preset.v1", { mode: "cloud", at: "now" });
    await h.runtime.presetChanged("cloud");
    expect(store.settings.get(relationsDecisionsSettingKey)).toEqual({ enabled: true });
    await expect(decide(h)).resolves.toMatchObject({ calls: expect.any(Number) });
  });

  it("re-checks the opt-in and the setup when a request gets its permit, even if nobody told the runtime", async () => {
    let started = 0;
    const h = harness({
      fetchImpl: slowAnswer(() => {
        started += 1;
        // The setting changes behind the runtime's back (another path wrote it).
        store.settings.set(relationsDecisionsSettingKey, { enabled: false });
      })
    });
    const failure = await decideMany(h).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(DecisionsDisabledError);
    // The lane's first requests were already out; none got its permit after the change.
    expect(started).toBeLessThanOrEqual(4);
    const sent = started;
    await expect(decide(h)).rejects.toBeInstanceOf(DecisionsDisabledError);
    expect(started).toBe(sent);
  });

  it("refuses a retry the person turned off while it waited, and audits the request as canceled", async () => {
    let calls = 0;
    const h = harness({
      fetchImpl: async () => {
        calls += 1;
        // The provider fails once; during the backoff the opt-in is withdrawn.
        store.settings.set(relationsDecisionsSettingKey, { enabled: false });
        return new Response("bad gateway", { status: 502 });
      }
    });
    const failure = await h.runtime
      .decide({
        operation: "relation_decide_decisions",
        instruction: relationDecisionsInstruction(),
        lists: [{ query: note("Q"), candidates: [note("C")] }]
      })
      .catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(DecisionsDisabledError);
    expect(calls).toBe(1);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: "canceled" });
    expect(store.settings.get(relationsDecisionsStateSettingKey)).not.toMatchObject({
      fallback: { reason: expect.any(String) }
    });
  });

  it("refuses the key test while it is off or in the Local setup, before it reads the key", async () => {
    const off = harness({ enabled: false });
    await expect(off.runtime.testKey()).rejects.toBeInstanceOf(DecisionsDisabledError);
    await expect(off.runtime.testKey()).rejects.toThrow("errors.relations.decisions.turnedOff");
    const local = harness({ preset: "local" });
    await expect(local.runtime.testKey()).rejects.toBeInstanceOf(DecisionsDisabledError);
    await expect(local.runtime.testKey()).rejects.toThrow(
      "errors.relations.decisions.presetNotAllowed"
    );
    expect(off.fetch).not.toHaveBeenCalled();
    expect(local.fetch).not.toHaveBeenCalled();
  });
});

describe("the day's cap is never passed", () => {
  const one = [{ query: note("Q"), candidates: [note("C")] }];
  const planCostUsd = () =>
    decisionsCostUsd(
      estimatePlanInputTokens(
        planDecisionRequests(one, relationDecisionsInstruction(), limits),
        limits
      ),
      limits
    );
  const planTokens = () =>
    estimatePlanInputTokens(
      planDecisionRequests(one, relationDecisionsInstruction(), limits),
      limits
    );

  it("admits one of several plans that are admitted together when the cap leaves room for 1.2", async () => {
    // Each plan bills what it was estimated at, and the cap leaves room for 1.2 plans.
    const h = harness({
      config: RelationsConfigSchema.parse({ decisions: { dailyCapUsd: 1.2 * planCostUsd() } }),
      fetchImpl: async () => answer(1, 0.5, planTokens())
    });
    const ask = () =>
      h.runtime.decide({
        operation: "relation_decide_decisions",
        instruction: relationDecisionsInstruction(),
        lists: one
      });
    const outcomes = await Promise.allSettled([ask(), ask(), ask()]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes.filter((entry) => entry.status === "rejected"))
      expect(outcome.reason).toMatchObject({ reason: "spend_cap" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const status = await h.runtime.status();
    expect(status.spentTodayUsd).toBeLessThanOrEqual(status.dailyCapUsd);
    // The reservation went with the plan: the money not spent is free again.
    expect(status.spentTodayUsd).toBeCloseTo(planCostUsd(), 10);
  });

  it("holds the reservation of a plan only while it runs", async () => {
    const h = harness({
      config: RelationsConfigSchema.parse({ decisions: { dailyCapUsd: 2.5 * planCostUsd() } }),
      // A plan that bills a tenth of its estimate.
      fetchImpl: async () => answer(1, 0.5, Math.round(planTokens() / 10))
    });
    const ask = () =>
      h.runtime.decide({
        operation: "relation_decide_decisions",
        instruction: relationDecisionsInstruction(),
        lists: one
      });
    for (let index = 0; index < 5; index += 1) await ask();
    expect(h.fetch).toHaveBeenCalledTimes(5);
    await Promise.all([ask(), ask()]);
    expect(h.fetch).toHaveBeenCalledTimes(7);
  });

  it("stops queued requests of an admitted plan when the usage reported is far above the estimate", async () => {
    const lists = manyLists();
    const tokens = estimatePlanInputTokens(
      planDecisionRequests(lists, relationDecisionsInstruction(), limits),
      limits
    );
    const h = harness({
      // Room for the plan's estimate, and each request bills ten times its share.
      config: RelationsConfigSchema.parse({
        decisions: { dailyCapUsd: 1.1 * decisionsCostUsd(tokens, limits) }
      }),
      fetchImpl: async () => answer(1, 0.5, Math.round((tokens / 12) * 10))
    });
    const failure = await decideMany(h).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ reason: "spend_cap" });
    expect(h.fetch.mock.calls.length).toBeLessThan(12);
  });

  it("charges the cap for a long key test as it does for a plan", async () => {
    const h = harness({
      config: RelationsConfigSchema.parse({ decisions: { dailyCapUsd: 0.0000001 } })
    });
    await expect(h.runtime.testKey()).rejects.toMatchObject({ reason: "spend_cap" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("a lane that cannot serve soon, and an account with no credit", () => {
  const exhausted = async () =>
    new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 });

  it("sends nothing more today once the account has no credit, until a key is saved or tested", async () => {
    let clock = new Date("2026-10-20T10:00:00.000Z");
    let provider = exhausted;
    const h = harness({ now: () => clock, fetchImpl: async () => provider() });
    const works = async () => answer(1, 0.5, 10);
    await expect(decide(h)).rejects.toMatchObject({ reason: "quota" });
    const sent = h.fetch.mock.calls.length;
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "quota" });
    expect(await h.runtime.status()).toMatchObject({ state: "fallback", fallbackReason: "quota" });
    await expect(decide(h)).rejects.toMatchObject({ reason: "quota" });
    expect(h.fetch).toHaveBeenCalledTimes(sent);

    // A saved key clears it.
    await h.runtime.saveKey("sk-proj-another-valid-key-0123456789");
    provider = works;
    expect(await h.runtime.resolve()).toEqual({ use: "decisions" });

    // The next day clears it.
    provider = exhausted;
    await expect(decide(h)).rejects.toMatchObject({ reason: "quota" });
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "quota" });
    clock = new Date("2026-10-22T10:00:00.000Z");
    expect(await h.runtime.resolve()).toEqual({ use: "decisions" });

    // So does a key test that works.
    await expect(decide(h)).rejects.toMatchObject({ reason: "quota" });
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "quota" });
    provider = works;
    await h.runtime.testKey();
    expect(await h.runtime.resolve()).toEqual({ use: "decisions" });
  });

  it("falls back at once while a rate limit pauses the lane for longer than a request waits", async () => {
    const h = harness();
    await decide(h);
    const lane = "remote:openai-decisions";
    // A short pause is waited out by the requests themselves ...
    h.scheduler.observeRateLimit(lane, performance.now() + limits.retry.maxInlineRetryAfterMs / 2);
    expect(await h.runtime.resolve()).toEqual({ use: "decisions" });
    // ... a long one sends later notes to the local ranker instead of queueing behind it.
    h.scheduler.observeRateLimit(lane, performance.now() + limits.retry.maxInlineRetryAfterMs * 3);
    expect(await h.runtime.resolve()).toEqual({ use: "local", reason: "breaker_open" });
    const sent = h.fetch.mock.calls.length;
    await expect(decide(h)).rejects.toMatchObject({ reason: "breaker_open" });
    expect(h.fetch).toHaveBeenCalledTimes(sent);
  });
});

describe("the calibration of the status", () => {
  const frozen = frozenRelationCalibrations.find(
    (entry) => entry.identity.runtimeKind === "remote"
  )!;

  it("is calibrated by the shipped entry: T58 froze the request design the product sends", async () => {
    const h = harness();
    expect(await h.runtime.status()).toMatchObject({ calibrated: true });
    // The identity the catalog's instruction and the typed limits compute is the frozen one, request
    // design included (the online requests, replayed and re-frozen; not the bake-off's dense design).
    const { identity, calibration } = decisionsDesign({
      instruction: relationDecisionsInstruction(),
      config: relationsConfig
    });
    expect(identity).toEqual(frozen.identity);
    expect(calibration).toEqual(frozen);
  });

  it("is calibrated once an entry names the identity of the requests it sends", async () => {
    const { identity } = decisionsDesign({
      instruction: relationDecisionsInstruction(),
      config: relationsConfig
    });
    const config = RelationsConfigSchema.parse({
      calibrations: [
        ...frozenRelationCalibrations.filter((entry) => entry.identity.runtimeKind !== "remote"),
        {
          ...frozen,
          identity,
          parity: { requestDesignSha256: identity.requestDesignSha256 }
        }
      ]
    });
    expect(await harness({ config }).runtime.status()).toMatchObject({ calibrated: true });
  });

  it("is uncalibrated once the instruction, the model or the design is another identity", async () => {
    const { identity: product } = decisionsDesign({
      instruction: relationDecisionsInstruction(),
      config: relationsConfig
    });
    const edited = (change: Partial<typeof product>) => {
      const identity = { ...product, ...change };
      return RelationsConfigSchema.parse({
        calibrations: [
          ...frozenRelationCalibrations.filter((entry) => entry.identity.runtimeKind !== "remote"),
          {
            ...frozen,
            identity,
            parity: { requestDesignSha256: identity.requestDesignSha256 }
          }
        ]
      });
    };
    // Each is calibrated by an entry of exactly the product's identity ...
    expect(await harness({ config: edited({}) }).runtime.status()).toMatchObject({
      calibrated: true
    });
    // ... and by no other.
    for (const change of [
      { instructionSha256: "c".repeat(64) },
      { requestDesignSha256: "d".repeat(64) },
      { model: "gpt-6-terra" }
    ])
      expect(await harness({ config: edited(change) }).runtime.status()).toMatchObject({
        calibrated: false
      });
    // No entry at all: uncalibrated.
    expect(
      await harness({ config: RelationsConfigSchema.parse({}) }).runtime.status()
    ).toMatchObject({
      calibrated: false
    });
  });
});

describe("the RemoteBudget (F4 D14)", () => {
  /** A budget that records what it was asked and refuses when told to. */
  function fakeBudget(refuse = false) {
    const opened: Array<Record<string, unknown>> = [];
    const settledAfterRuns: number[] = [];
    const budget = {
      open: vi.fn(async (call: Record<string, unknown>) => {
        opened.push(call);
        let reserved = 0;
        return {
          metered: true,
          get estimateUsd() {
            return reserved;
          },
          admitAttempt: async () => {
            if (refuse) throw new RemoteBudgetRefusal("money_100", null);
            reserved += 0.001;
          },
          settle: async () => {
            settledAfterRuns.push(store.runs.length);
          }
        };
      })
    };
    return {
      budget: budget as unknown as DecisionsRuntimeOptions["remoteBudget"],
      opened,
      settledAfterRuns
    };
  }

  it("admits each background request's attempts and audits its class, job and estimate", async () => {
    const { budget, opened, settledAfterRuns } = fakeBudget();
    const h = harness({ remoteBudget: budget });
    const result = await decide(h, { budgetClass: "background", jobId: "job-1" });
    expect(opened).toHaveLength(result.calls);
    for (const call of opened)
      expect(call).toMatchObject({
        lane: "remote:openai-decisions",
        provider: "openai-decisions",
        modelId: "gpt-6-luna",
        budgetClass: "background",
        priority: 2,
        estimate: { inputTokens: expect.any(Number), outputTokens: 0 }
      });
    for (const run of store.runs)
      expect(run).toMatchObject({
        budgetClass: "background",
        jobId: "job-1",
        budgetEstimateUsd: 0.001
      });
    // Each request settles once its own audit row was written.
    expect(settledAfterRuns).toHaveLength(result.calls);
    settledAfterRuns.forEach((runs, index) => expect(runs).toBeGreaterThanOrEqual(index + 1));
  });

  it("sends nothing when the budget refuses, and the matcher falls back to the local ranker", async () => {
    const { budget } = fakeBudget(true);
    const h = harness({ remoteBudget: budget });
    await expect(decide(h, { budgetClass: "background" })).rejects.toBeInstanceOf(
      DecisionsUnavailableError
    );
    expect(h.fetch).not.toHaveBeenCalled();
    expect(store.runs.length).toBeGreaterThan(0);
    expect(store.runs.every((run) => run.status === "failed")).toBe(true);
  });
});
