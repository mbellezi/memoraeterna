import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runsStreaming, type AiModelAdapter, type AiTaskRequest } from "./contracts.js";
import { GoogleGeminiAdapter } from "./google.js";
import { OpenAiCodexAdapter } from "./openai-codex.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { remoteCallReport, type AiRuntimeConfigInput } from "./remote-execution.js";

const encoder = new TextEncoder();
const request = (parameters: Record<string, unknown> = {}): AiTaskRequest => ({
  taskType: "text-generation",
  input: "hello",
  requiredCapabilities: [],
  parameters,
  metadata: {}
});
const events = (...payloads: unknown[]) =>
  payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
const streamHeaders = { "content-type": "text/event-stream" };
const sse = (body: string) => new Response(body, { status: 200, headers: streamHeaders });

/**
 * A stream that delivers each chunk at its time (fake timers) and then, unless `endAt` is given,
 * neither ends nor fails.
 */
function scheduled(chunks: Array<[atMs: number, body: string]>, endAt?: number): Response {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const [at, body] of chunks)
          timers.push(setTimeout(() => controller.enqueue(encoder.encode(body)), at));
        if (endAt !== undefined) timers.push(setTimeout(() => controller.close(), endAt));
      },
      // The adapter cancels a stalled stream; nothing may be delivered to it afterwards.
      cancel() {
        for (const timer of timers) clearTimeout(timer);
      }
    }),
    { status: 200, headers: streamHeaders }
  );
}

const runtime = (input: AiRuntimeConfigInput = {}): AiRuntimeConfigInput => ({
  ...input,
  retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400, ...input.retry }
});
const codex = (fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) =>
  new OpenAiCodexAdapter({
    accessToken: "oauth-access-token",
    accountId: "account-1",
    modelId: "gpt-test",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
const google = (fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) =>
  new GoogleGeminiAdapter({
    apiKey: "google-secret-key",
    modelId: "gemini-test",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
const openAi = (fetch: typeof globalThis.fetch, baseUrl: string, config?: AiRuntimeConfigInput) =>
  new OpenAiCompatibleAdapter({
    baseUrl,
    apiKey: "secret-key",
    modelId: "model",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;

describe("remote generation always streams", () => {
  const adapter = (
    providerId: string,
    runtimeKind: "remote" | "local",
    capabilities: string[],
    streams = true
  ): AiModelAdapter =>
    ({
      describe: () => ({ providerId, modelId: "m", runtime: runtimeKind, capabilities }),
      canHandle: () => true,
      run: async () => ({}),
      ...(streams ? { runStreaming: async () => ({}) } : {})
    }) as unknown as AiModelAdapter;

  it("streams every remote generation, whatever capabilities are stored for the model", () => {
    for (const taskType of ["summarization", "reranking", "structured-output"] as const)
      expect(runsStreaming(adapter("google", "remote", ["text-generation"]), taskType)).toBe(true);
    expect(runsStreaming(adapter("google", "remote", ["embedding"]), "embedding")).toBe(false);
  });

  it("leaves local adapters to their declared capabilities and needs a streaming method", () => {
    expect(runsStreaming(adapter("mlx", "local", ["text-generation"]), "summarization")).toBe(
      false
    );
    expect(runsStreaming(adapter("mlx", "local", ["streaming"]), "summarization")).toBe(true);
    expect(runsStreaming(adapter("x", "remote", [], false), "summarization")).toBe(false);
  });

  it("is what the real remote adapters offer", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const created of [openAi(fetch, "https://a.example.test/v1"), google(fetch), codex(fetch)])
      expect(runsStreaming(created, "summarization")).toBe(true);
  });
});

describe("watchdogs of streamed calls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const created = events({ type: "response.created" });
  const answer = events(
    { type: "response.output_text.delta", delta: "done" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
  );

  it("lets a high-reasoning ChatGPT/Codex call think in silence after its first lifecycle event", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      scheduled(
        [
          [0, created],
          [60_000, answer]
        ],
        60_000
      )
    );
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "high" })
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(result).resolves.toMatchObject({ output: "done", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stalls a high-reasoning call that stays silent beyond the reasoning window", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => scheduled([[0, created]]));
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "high" })
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "stalled",
      message: "AI provider stream stalled for 120000 ms."
    });
    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("still stalls an ordinary ChatGPT/Codex call after the short window", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => scheduled([[0, created]]));
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "low" })
    );
    const settled = expect(result).rejects.toMatchObject({ kind: "stalled" });
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
  });

  it("applies the short window to a high-reasoning call once its answer started", async () => {
    const first = events({ type: "response.output_text.delta", delta: "par" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      scheduled([
        [0, created],
        [50_000, first]
      ])
    );
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "high" })
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "stalled",
      message: "AI provider stream stalled for 20000 ms."
    });
    await vi.advanceTimersByTimeAsync(70_000);
    await settled;
  });
});

describe("a stream is alive only while it makes progress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The same chunk every `every` ms from 0 up to `until`. */
  const repeated = (body: string, every = 5_000, until = 120_000): Array<[number, string]> =>
    Array.from({ length: Math.floor(until / every) + 1 }, (_, i) => [i * every, body]);
  const lifecycle = [
    events({ type: "response.created" }),
    events({ type: "response.in_progress" }),
    events({ type: "response.output_item.added", item: { type: "message" } }),
    events({ type: "response.content_part.added" }),
    ": keep-alive\n\n",
    "data:\n\n"
  ];
  /** Lifecycle events, keep-alive comments and empty data lines in turn, every five seconds. */
  const heartbeats = (until = 120_000): Array<[number, string]> =>
    Array.from({ length: Math.floor(until / 5_000) + 1 }, (_, i) => [
      i * 5_000,
      lifecycle[i % lifecycle.length]!
    ]);
  const reasoningText = (delta: string) =>
    events({ type: "response.reasoning_summary_text.delta", delta });
  const answerText = (delta: string) => events({ type: "response.output_text.delta", delta });
  const completed = events({
    type: "response.completed",
    response: { usage: { input_tokens: 1, output_tokens: 1 } }
  });
  const decide: AiTaskRequest = { ...request(), taskType: "reranking" };

  describe("ChatGPT/Codex", () => {
    it("stalls at the stall window when only lifecycle events and keep-alives arrive, and retries", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => scheduled(heartbeats()))
        .mockImplementation(async () => sse(answerText("done") + completed));
      const result = codex(fetch).run(request({ reasoningLevel: "low" }));
      await vi.advanceTimersByTimeAsync(19_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      // random 0.5: the retry starts 50 ms after the stall at 20 s.
      await vi.advanceTimersByTimeAsync(51);
      expect(fetch).toHaveBeenCalledTimes(2);
      await expect(result).resolves.toMatchObject({ output: "done", attempts: 2 });
    });

    it("keeps stalling a stream that only sends lifecycle events on every attempt", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => scheduled(heartbeats()));
      const result = codex(fetch, { retry: { maxAttempts: 2 } }).run(request());
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        transient: true,
        message: "AI provider stream stalled for 20000 ms."
      });
      await vi.advanceTimersByTimeAsync(40_200);
      await settled;
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("lets steady reasoning-summary text and then answer text keep the call alive", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
        scheduled(
          [
            [0, lifecycle[0]!],
            [10_000, reasoningText("Looking")],
            [20_000, reasoningText(" at it")],
            [28_000, answerText("par")],
            [40_000, answerText("tial") + completed]
          ],
          40_000
        )
      );
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
        request({ reasoningLevel: "low" })
      );
      await vi.advanceTimersByTimeAsync(40_001);
      await expect(result).resolves.toMatchObject({ output: "partial", attempts: 1 });
    });

    it("bounds the time to the first answer text of an ordinary request, however much it reasons", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => scheduled(repeated(reasoningText("Hmm"))))
        .mockImplementation(async () => sse(answerText("done") + completed));
      const result = codex(fetch).run(request({ reasoningLevel: "medium" }));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(51);
      expect(fetch).toHaveBeenCalledTimes(2);
      await expect(result).resolves.toMatchObject({ output: "done", attempts: 2 });
    });

    it("reports a call that never answers as a stall with the no-answer message", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => scheduled(repeated(reasoningText("Hmm"))));
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(request());
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        transient: true,
        message: "AI provider produced no answer text within 30000 ms."
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
    });

    it("lets a high-reasoning call reason for longer than the no-answer bound while its text keeps coming", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
        scheduled(
          [
            [0, lifecycle[0]!],
            [50_000, reasoningText("Step one")],
            [100_000, reasoningText("Step two")],
            [110_000, answerText("done") + completed]
          ],
          110_000
        )
      );
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
        request({ reasoningLevel: "high" })
      );
      await vi.advanceTimersByTimeAsync(110_001);
      await expect(result).resolves.toMatchObject({ output: "done", attempts: 1 });
    });

    it("ends a decide call at its 45 s total deadline when no attempt makes progress", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => scheduled(heartbeats(60_000)));
      const result = codex(fetch).run(decide);
      const settled = expect(result).rejects.toMatchObject({
        kind: "timeout",
        transient: true,
        message: "AI provider request exceeded its 45000 ms deadline."
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await settled;
      // A decide call is silent while it thinks: it stalls at the 30 s answer-start bound, not at the
      // 20 s stall window, and the second attempt is cut by the total deadline.
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("ChatGPT/Codex reasoning that streams no text (live probe of 2026-11-11)", () => {
    type ProbeEvent = [atMs: number, kind: string, itemType?: string];
    interface ProbeRun {
      label: string;
      run: number;
      reasoningTokens: number;
      firstChunkMs: number;
      firstAnswerTextMs: number;
      preAnswer: ProbeEvent[];
      answerDeltasMs: number[];
      afterAnswer: ProbeEvent[];
    }
    const probe = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "test-fixtures", "codex-reasoning-probe-2026-11-11.json"),
        "utf8"
      )
    ) as { runs: ProbeRun[] };
    const probeRun = (label: string, run: number) =>
      probe.runs.find((entry) => entry.label.startsWith(label) && entry.run === run)!;
    // The recorded request: a graph batch (class write-quality) with no reasoning level, so the
    // backend gets no reasoning object and streams no reasoning text.
    const graph: AiTaskRequest = {
      ...request({ contextWindow: 128_000 }),
      taskType: "knowledge-graph-generation"
    };
    /** The run's events with their recorded times: kinds and item types, as the probe saw them. */
    const timelineOf = (run: ProbeRun): ProbeEvent[] => [
      ...run.preAnswer,
      ...run.answerDeltasMs.map((at): ProbeEvent => [at, "response.output_text.delta"]),
      ...run.afterAnswer
    ];
    /** Keep-alive comments every five seconds from `from` to `until`. */
    const keepAlives = (from: number, until = 200_000): ProbeEvent[] =>
      Array.from({ length: Math.floor((until - from) / 5_000) + 1 }, (_, i) => [
        from + i * 5_000,
        "comment"
      ]);
    /**
     * The stream of a timeline. Items get ids and indexes in the order they start, as the backend's
     * do; a `done` closes the item started last.
     */
    const replay = (timeline: ProbeEvent[], endAt?: number) => {
      const items: string[] = [];
      const chunks = timeline.map(([at, kind, itemType]): [number, string] => {
        if (kind === "comment") return [at, ": keep-alive\n\n"];
        if (kind === "response.output_text.delta") return [at, answerText("x")];
        if (kind === "response.completed") return [at, completed];
        if (kind === "response.output_item.added" || kind === "response.output_item.done") {
          if (kind === "response.output_item.added")
            items.push(`${itemType === "reasoning" ? "rs" : "msg"}_${items.length}`);
          const index = items.length - 1;
          return [
            at,
            events({ type: kind, output_index: index, item: { id: items[index], type: itemType } })
          ];
        }
        return [at, events({ type: kind })];
      });
      return scheduled(chunks, endAt);
    };
    const settledAt = async (result: Promise<unknown>, at: number) => {
      let ended = false;
      void result.catch(() => {
        ended = true;
      });
      await vi.advanceTimersByTimeAsync(at - 1);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toBe(true);
    };

    it.each(probe.runs.map((run) => [`${run.label} #${run.run}`, run] as const))(
      "answers the recorded run %s, kept alive before its answer by its reasoning steps",
      async (_name, run) => {
        const timeline = timelineOf(run);
        const endAt = timeline.at(-1)![0];
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async () => replay(timeline, endAt));
        const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(graph);
        await vi.advanceTimersByTimeAsync(endAt + 1);
        await expect(result).resolves.toMatchObject({
          output: "x".repeat(run.answerDeltasMs.length),
          attempts: 1
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    );

    it("answers the run that reasoned 2,368 tokens: steps every 9.3 s, keep-alives every 5 s, answer at 43.8 s", async () => {
      const run = probeRun("stalled-f9e5", 4);
      expect(run.firstAnswerTextMs).toBe(43_800);
      const steps = run.preAnswer.filter(([, , item]) => item === "reasoning").map(([at]) => at);
      const keepAliveCount = run.preAnswer.filter(([, kind]) => kind === "comment").length;
      expect({ steps: steps.length, keepAliveCount }).toEqual({ steps: 10, keepAliveCount: 5 });
      const timeline = timelineOf(run);
      const endAt = timeline.at(-1)![0];
      const fetch = vi.fn<typeof globalThis.fetch>(async () => replay(timeline, endAt));
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(graph);
      // Past the old cut points: the 20 s stall (20.7 s) and the 30 s answer-start bound (30.7 s).
      await vi.advanceTimersByTimeAsync(run.firstChunkMs + 30_001);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(endAt);
      await expect(result).resolves.toMatchObject({ attempts: 1 });
    });

    it("still stalls a stream of keep-alives and lifecycle events at 20 s from its first chunk, as before", async () => {
      // The same run with its reasoning steps taken out: what a stream that only pings sends.
      const run = probeRun("stalled-f9e5", 4);
      const pings = run.preAnswer.filter(([, , item]) => item !== "reasoning");
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        replay([...pings, ...keepAlives(run.firstAnswerTextMs + 5_000)])
      );
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(graph);
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        transient: true,
        message: "AI provider stream stalled for 20000 ms."
      });
      await settledAt(result, run.firstChunkMs + 20_000);
      await settled;
    });

    it("stalls one stall window after the last reasoning step when the steps stop", async () => {
      const run = probeRun("stalled-f9e5", 4);
      // Keep the events up to the step at 29.0 s; afterwards only keep-alives arrive.
      const lastStep = 29_006;
      const before = run.preAnswer.filter(([at]) => at <= lastStep);
      expect(before.at(-1)).toEqual([lastStep, "response.output_item.added", "reasoning"]);
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        replay([...before, ...keepAlives(lastStep + 5_000)])
      );
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(graph);
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 20000 ms."
      });
      await settledAt(result, lastStep + 20_000);
      await settled;
    });

    /** Reasoning steps every 9.3 s, as the probe saw them, and keep-alives between them; no answer. */
    const endlessReasoning = (): ProbeEvent[] => {
      const timeline: ProbeEvent[] = [
        [700, "response.created"],
        [700, "response.in_progress"]
      ];
      for (let at = 10_000; at < 200_000; at += 9_300)
        timeline.push(
          [at, "response.output_item.done", "reasoning"],
          [at, "response.output_item.added", "reasoning"],
          [at + 5_000, "comment"]
        );
      // The first step has no item to close yet.
      return timeline.filter((_, index) => index !== 2);
    };

    it.each([
      ["a graph batch (write-quality)", "knowledge-graph-generation", 90_000],
      ["an Ask answer (answer)", "text-generation", 30_000],
      ["a summary (write-fast)", "summarization", 30_000],
      ["a decide call", "reranking", 30_000]
    ] as const)(
      "bounds the reasoning before the answer of %s at its class's bound",
      async (_name, taskType, bound) => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () => replay(endlessReasoning()));
        const result = codex(fetch, { retry: { maxAttempts: 1 } }).run({ ...graph, taskType });
        const settled = expect(result).rejects.toMatchObject({
          kind: "stalled",
          transient: true,
          message: `AI provider produced no answer text within ${bound} ms.`
        });
        await settledAt(result, 700 + bound);
        await settled;
      }
    );

    it("keeps the 20 s stall once the answer started, and reasoning steps after it are not progress", async () => {
      const run = probeRun("stalled-f9e5", 4);
      const [, second] = run.answerDeltasMs;
      const timeline: ProbeEvent[] = [
        ...run.preAnswer,
        [run.firstAnswerTextMs, "response.output_text.delta"],
        [second!, "response.output_text.delta"],
        // The answer pauses (the soak's R6 shape); a reasoning item in the pause does not count.
        [second! + 10_000, "response.output_item.added", "reasoning"],
        ...keepAlives(second! + 5_000)
      ];
      const fetch = vi.fn<typeof globalThis.fetch>(async () => replay(timeline));
      const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(graph);
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 20000 ms."
      });
      await settledAt(result, second! + 20_000);
      await settled;
    });

    describe("which events show progress before the answer", () => {
      const reasoningItem = (type: string, id = "rs_1") =>
        events({ type, output_index: 0, item: { id, type: "reasoning" } });
      /** A graph call whose stream sends `body` at 15 s after its first event at 0. */
      const at15 = (body: string, earlier: Array<[number, string]> = []) => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
          scheduled([[0, lifecycle[0]!], ...earlier, [15_000, body]])
        );
        return codex(fetch, { retry: { maxAttempts: 1 } }).run(graph);
      };

      it.each([
        ["a reasoning item that starts", reasoningItem("response.output_item.added")],
        ["a reasoning item that ends", reasoningItem("response.output_item.done")],
        ["reasoning-summary text", reasoningText("Weighing")],
        ["reasoning text", events({ type: "response.reasoning_text.delta", delta: "Weighing" })]
      ])("counts %s, which re-arms the stall window", async (_name, body) => {
        const result = at15(body);
        const settled = expect(result).rejects.toMatchObject({
          message: "AI provider stream stalled for 20000 ms."
        });
        await settledAt(result, 35_000);
        await settled;
      });

      const notProgress: Array<[name: string, body: string]> = [
        ["a keep-alive comment", ": keep-alive\n\n"],
        ["an empty data line", "data:\n\n"],
        ["response.in_progress", events({ type: "response.in_progress" })],
        [
          "a message item that starts",
          events({ type: "response.output_item.added", item: { id: "msg_1", type: "message" } })
        ],
        [
          "a message item that ends",
          events({ type: "response.output_item.done", item: { id: "msg_1", type: "message" } })
        ],
        ["a content part", events({ type: "response.content_part.added" })],
        ["a reasoning-summary part", events({ type: "response.reasoning_summary_part.added" })],
        ["empty reasoning-summary text", reasoningText("")]
      ];
      it.each(notProgress)("does not count %s", async (_name, body) => {
        const result = at15(body);
        const settled = expect(result).rejects.toMatchObject({
          message: "AI provider stream stalled for 20000 ms."
        });
        await settledAt(result, 20_000);
        await settled;
      });

      it("does not count the same reasoning item reported again", async () => {
        const started = reasoningItem("response.output_item.added");
        const result = at15(started, [[5_000, started]]);
        const settled = expect(result).rejects.toMatchObject({
          message: "AI provider stream stalled for 20000 ms."
        });
        // Only its first report, at 5 s, re-armed the window.
        await settledAt(result, 25_000);
        await settled;
      });
    });
  });

  describe("OpenAI-compatible", () => {
    const baseUrl = "https://progress.example.test/v1";
    const roleOnly = events({ choices: [{ delta: { role: "assistant", content: "" } }] });
    const delta = (field: string, text: string) =>
      events({ choices: [{ delta: { [field]: text } }] });
    const run = (fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) =>
      openAi(fetch, baseUrl, config).runStreaming(request(), undefined, () => undefined);

    it("stalls at the stall window when only empty deltas and keep-alives arrive, and retries", async () => {
      const beats: Array<[number, string]> = Array.from({ length: 25 }, (_, i) => [
        i * 5_000,
        i % 2 === 0 ? roleOnly : ": keep-alive\n\n"
      ]);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => scheduled(beats))
        .mockImplementation(async () => sse(delta("content", "done") + "data: [DONE]\n\n"));
      const result = run(fetch);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(51);
      await expect(result).resolves.toMatchObject({ output: "done", attempts: 2 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("counts reasoning text from either field as progress until the answer, then answer text", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
        scheduled(
          [
            [0, roleOnly],
            [10_000, delta("reasoning_content", "Thinking")],
            [20_000, delta("reasoning", "More")],
            [28_000, delta("content", "par")],
            [40_000, delta("content", "tial") + "data: [DONE]\n\n"]
          ],
          40_000
        )
      );
      const result = run(fetch, { retry: { maxAttempts: 1 } });
      await vi.advanceTimersByTimeAsync(40_001);
      await expect(result).resolves.toMatchObject({ output: "partial", attempts: 1 });
    });

    it("bounds the time to the first answer text however much reasoning text arrives", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => scheduled(repeated(delta("reasoning_content", "Hmm"))));
      const result = run(fetch, { retry: { maxAttempts: 1 } });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider produced no answer text within 30000 ms."
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
    });

    it("gives a write-quality request its class's answer-start bound, as every remote lane does", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () =>
          scheduled(repeated(delta("reasoning_content", "Hmm"), 5_000, 200_000))
        );
      const result = openAi(fetch, baseUrl, { retry: { maxAttempts: 1 } }).runStreaming(
        { ...request(), taskType: "knowledge-graph-generation" },
        undefined,
        () => undefined
      );
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider produced no answer text within 90000 ms."
      });
      await vi.advanceTimersByTimeAsync(89_999);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
    });
  });

  describe("Gemini", () => {
    const usageOnly = events({
      candidates: [{ content: { role: "model" } }],
      usageMetadata: { promptTokenCount: 5 }
    });
    const thought = (text: string) =>
      events({ candidates: [{ content: { parts: [{ text, thought: true }] } }] });
    const text = (value: string) =>
      events({ candidates: [{ content: { parts: [{ text: value }] } }] });
    const run = (fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) =>
      google(fetch, config).runStreaming(request(), undefined, () => undefined);

    it("stalls at the stall window when chunks carry no text, and retries", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => scheduled(repeated(usageOnly)))
        .mockImplementation(async () => sse(text("done")));
      const result = run(fetch);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(51);
      await expect(result).resolves.toMatchObject({ output: "done", attempts: 2 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("counts thought summaries as progress before the answer without adding them to it", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
        scheduled(
          [
            [0, usageOnly],
            [10_000, thought("Weighing")],
            [20_000, thought("Choosing")],
            [28_000, text("par")],
            [40_000, text("tial")]
          ],
          40_000
        )
      );
      const result = run(fetch, { retry: { maxAttempts: 1 } });
      await vi.advanceTimersByTimeAsync(40_001);
      await expect(result).resolves.toMatchObject({ output: "partial", attempts: 1 });
    });

    it("bounds the time to the first answer text however many thought summaries arrive", async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => scheduled(repeated(thought("Hmm"))));
      const result = run(fetch, { retry: { maxAttempts: 1 } });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider produced no answer text within 30000 ms."
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
    });
  });
});

describe("streaming usage for OpenAI-compatible servers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const deltas = (content: string) =>
    sse(events({ choices: [{ delta: { content } }] }) + "data: [DONE]\n\n");

  it("streams with usage, and falls back once to a stream without it when the server rejects stream_options", async () => {
    const baseUrl = "https://strict-server.example.test/v1";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, init) =>
        JSON.parse(String(init?.body)).stream_options
          ? new Response("Unknown parameter: 'stream_options'.", { status: 400 })
          : deltas("answer")
      );
    const result = await openAi(fetch, baseUrl).runStreaming(request(), undefined, () => undefined);
    expect(result.output).toBe("answer");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch.mock.calls[0])).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(bodyOf(fetch.mock.calls[1])).not.toHaveProperty("stream_options");
    expect(bodyOf(fetch.mock.calls[1])).toMatchObject({ stream: true });
    // The next call to the same server does not ask for usage again.
    await openAi(fetch, baseUrl).runStreaming(request(), undefined, () => undefined);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetch.mock.calls[2])).not.toHaveProperty("stream_options");
  });

  it("keeps stream_options for servers that accept it and reports their usage", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse(
          events(
            { choices: [{ delta: { content: "ok" } }] },
            { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }
          )
        )
      );
    const result = await openAi(fetch, "https://lenient-server.example.test/v1").runStreaming(
      request(),
      undefined,
      () => undefined
    );
    expect(result).toMatchObject({ output: "ok", inputTokens: 9, outputTokens: 2, attempts: 1 });
    expect(bodyOf(fetch.mock.calls[0])).toHaveProperty("stream_options");
  });

  it("does not take any other 400 for a stream_options rejection", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("model not found", { status: 400 }));
    await expect(
      openAi(fetch, "https://other-400.example.test/v1").runStreaming(
        request(),
        undefined,
        () => undefined
      )
    ).rejects.toMatchObject({ status: 400, transient: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("quota and plan limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const quota = (retryIn: string) =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: `You exceeded your current quota, please check your plan and billing details. Please retry in ${retryIn}.`
        }
      }),
      { status: 429 }
    );
  const answer = () => Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

  it("waits the few seconds a Gemini per-minute quota names and then succeeds", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(quota("3s"))
      .mockResolvedValue(answer());
    const result = google(fetch).run(request());
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ output: "ok", attempts: 2 });
  });

  it("hands a longer Gemini quota wait to the job instead of holding the execution slot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => quota("32.4s"));
    const error = await google(fetch)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, transient: true, retryAfterMs: 32_400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an exhausted billing quota at all", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
        {
          status: 429
        }
      )
    );
    const error = await openAi(fetch, "https://billing.example.test/v1")
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, transient: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves a ChatGPT plan limit to the job, which waits for the announced reset", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              message: "The usage limit has been reached",
              plan_type: "plus",
              resets_in_seconds: 1_200
            }
          }),
          { status: 429 }
        )
    );
    const error = await codex(fetch)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, transient: true, retryAfterMs: 1_200_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("what a streamed call cost when it was retried", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const chunk = (text: string, promptTokenCount: number, candidatesTokenCount: number) =>
    events({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount, candidatesTokenCount }
    });

  it("counts the attempts and the tokens a stalled attempt used", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(scheduled([[0, chunk("par", 120, 3)]]))
      .mockResolvedValue(sse(chunk("complete answer", 120, 10)));
    const result = google(fetch).runStreaming(request(), undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(20_100);
    await expect(result).resolves.toMatchObject({
      output: "complete answer",
      attempts: 2,
      // The answer's own 120 + 10 tokens plus the 120 + 3 the stalled attempt reported.
      inputTokens: 240,
      outputTokens: 13,
      tokenUsage: { inputTokens: 240, outputTokens: 13, totalTokens: 253 },
      retriedUsage: { inputTokens: 120, outputTokens: 3 }
    });
  });

  it("reports one attempt and no retried usage when the first attempt succeeds", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(chunk("ok", 5, 1)));
    const result = await google(fetch).runStreaming(request(), undefined, () => undefined);
    expect(result).toMatchObject({ attempts: 1, inputTokens: 5, outputTokens: 1 });
    expect(result).not.toHaveProperty("retriedUsage");
  });

  it("attaches attempts and billed tokens to the error of a call that never succeeded", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => scheduled([[0, chunk("par", 120, 3)]]));
    const result = google(fetch, { retry: { maxAttempts: 2 } }).runStreaming(
      request(),
      undefined,
      () => undefined
    );
    const settled = result.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(41_000);
    const error = await settled;
    expect(error).toMatchObject({ kind: "stalled" });
    expect(remoteCallReport(error)).toEqual({
      attempts: 2,
      failedUsage: { inputTokens: 240, outputTokens: 6 }
    });
  });

  it("counts the attempts of a call that was not streamed", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    const result = google(fetch).run(request());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ attempts: 2 });
  });
});

describe("a silent server over a real HTTP connection", () => {
  let server: Server;
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((incoming, outgoing) => handler(incoming, outgoing));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams a generation that the stored capabilities do not mark as streaming, so a stall is cut", async () => {
    let calls = 0;
    handler = (_incoming, outgoing) => {
      calls++;
      outgoing.writeHead(200, streamHeaders);
      outgoing.write(events({ choices: [{ delta: { content: "par" } }] }));
    };
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl,
      apiKey: "secret",
      modelId: "model",
      capabilities: ["text-generation"],
      runtime: { retry: { maxAttempts: 1 }, deadlines: { stallMs: 120 } }
    });
    expect(runsStreaming(adapter, "summarization")).toBe(true);
    await expect(adapter.runStreaming(request(), undefined, () => undefined)).rejects.toMatchObject(
      {
        kind: "stalled"
      }
    );
    expect(calls).toBe(1);
  });
});
