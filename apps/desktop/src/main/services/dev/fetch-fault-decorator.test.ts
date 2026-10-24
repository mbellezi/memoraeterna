import { OpenAiCodexAdapter, remoteCallReport, type AiTaskRequest } from "@app/ai";
import { describe, expect, it } from "vitest";

import {
  FetchFaultInjector,
  FetchFaultSchedule,
  codexProviderName
} from "./fetch-fault-decorator.js";
import { withSoakCallContext } from "./soak-call-context.js";
import { fetchFaultPlanSchema, type FetchFaultPlan } from "./soak-plan-f4.js";
import { MemoryEventSink, injectedTag, type ExchangeRecord } from "./soak-records.js";

// The fetch layer against the real Codex adapter at the scale of tens of milliseconds: the 30 s
// first-byte bound and the 20 s stall bound become 150 and 100 ms, the injected delays 450 and 400.
const runtime = {
  deadlines: { connectMs: 300, firstByteMs: 150, stallMs: 100 },
  retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxInlineRetryAfterMs: 5_000 }
};

const plan = (overrides: Partial<FetchFaultPlan> = {}): FetchFaultPlan =>
  fetchFaultPlanSchema.parse({
    retryAfterSeconds: [0, 0],
    stallMs: 400,
    lateFirstByteMs: 450,
    ...overrides
  });

const request: AiTaskRequest = {
  taskType: "text-generation",
  input: "Say hello",
  requiredCapabilities: [],
  parameters: {},
  metadata: {}
};

const events = [
  { type: "response.created" },
  { type: "response.output_text.delta", delta: "hello " },
  { type: "response.output_text.delta", delta: "again " },
  { type: "response.output_text.delta", delta: "world" },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 120, output_tokens: 30 } }
  }
];

/** The provider: every event is its own chunk, so a stall can fall between two pieces of text. */
function provider() {
  const seen: Array<{ url: string; bytes: number }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), bytes: String(init?.body ?? "").length });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          controller.close();
        }
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  return { fetchStub, seen };
}

function layer(overrides: Partial<FetchFaultPlan> = {}) {
  const sink = new MemoryEventSink();
  const upstream = provider();
  const injector = new FetchFaultInjector({
    plan: plan(overrides),
    seed: 20261028,
    sink,
    fetch: upstream.fetchStub
  });
  const adapter = new OpenAiCodexAdapter({
    accessToken: "oauth-access",
    accountId: "account-1",
    modelId: "gpt-5.6-luna",
    capabilities: ["text-generation", "streaming"],
    fetch: injector.fetch,
    runtime,
    random: () => 0
  });
  const exchanges = () =>
    sink.events.filter((event): event is ExchangeRecord => event.type === "exchange");
  return { injector, adapter, upstream, exchanges };
}

describe("the per-request faults, against the real Codex adapter", () => {
  it("answers a 429 with its Retry-After itself, forwards nothing, and the call retries to success", async () => {
    const { adapter, upstream, exchanges } = layer({
      forced: [{ kind: "rate_limit", afterMinute: 0, count: 1 }]
    });
    const result = await adapter.run(request);
    expect(result).toMatchObject({
      output: "hello again world",
      inputTokens: 120,
      outputTokens: 30
    });
    expect(result.attempts).toBe(2);
    expect(upstream.seen).toHaveLength(1);
    const [injected, served] = exchanges();
    expect(injected).toMatchObject({
      provider: codexProviderName,
      kind: "rate_limit",
      injected: true,
      status: 429,
      retryAfterSeconds: 0,
      forwardedBytes: 0,
      synthetic: true,
      tag: injectedTag
    });
    expect(served).toMatchObject({ kind: "none", injected: false, status: 200 });
    expect(served!.forwardedBytes).toBeGreaterThan(0);
  });

  it("answers a 503 itself and the call retries", async () => {
    const { adapter, upstream, exchanges } = layer({
      forced: [{ kind: "unavailable", afterMinute: 0, count: 2 }]
    });
    const result = await adapter.run(request);
    expect(result.attempts).toBe(3);
    expect(upstream.seen).toHaveLength(1);
    expect(exchanges().filter((entry) => entry.kind === "unavailable")).toHaveLength(2);
  });

  it("fails a call permanently on a synthesized 401 or a 400 context overflow, forwarding nothing", async () => {
    for (const [kind, status, pattern] of [
      ["unauthorized", 401, /soak-injected/u],
      ["context_overflow", 400, /context window/u]
    ] as const) {
      const { adapter, upstream, exchanges } = layer({
        forced: [{ kind, afterMinute: 0, count: 1 }]
      });
      const failure = await adapter.run(request).catch((error: unknown) => error);
      expect(failure).toMatchObject({ transient: false, status });
      expect((failure as Error).message).toMatch(pattern);
      expect(upstream.seen).toHaveLength(0);
      expect(exchanges()).toEqual([
        expect.objectContaining({ kind, injected: true, forwardedBytes: 0, status })
      ]);
    }
  });

  it("gives the parser a malformed event and forwards nothing", async () => {
    const { adapter, upstream, exchanges } = layer({
      forced: [{ kind: "malformed", afterMinute: 0, count: 1 }]
    });
    await expect(adapter.run(request)).rejects.toThrow(SyntaxError);
    expect(upstream.seen).toHaveLength(0);
    expect(exchanges()[0]).toMatchObject({ kind: "malformed", injected: true, forwardedBytes: 0 });
  });

  it("holds the first byte past the first-byte bound: the client leaves at the bound, nothing is forwarded, the retry succeeds", async () => {
    const { adapter, upstream, exchanges } = layer({
      forced: [{ kind: "late_first_byte", afterMinute: 0, count: 1 }]
    });
    const result = await adapter.run(request);
    expect(result.output).toBe("hello again world");
    expect(upstream.seen).toHaveLength(1);
    const late = exchanges().find((entry) => entry.kind === "late_first_byte")!;
    expect(late).toMatchObject({
      injected: true,
      outcome: "client_closed",
      forwardedBytes: 0,
      synthetic: true
    });
    expect(late.closedAfterMs).toBeGreaterThanOrEqual(140);
    expect(late.closedAfterMs).toBeLessThan(400);
  });

  it("stalls after real deltas: the request is forwarded, the client leaves at the stall bound, tokens are billed", async () => {
    const { adapter, upstream, exchanges } = layer({
      forced: [{ kind: "stall", afterMinute: 0, count: 1 }]
    });
    const result = await adapter.run(request);
    expect(result.output).toBe("hello again world");
    // The stalled attempt reached the provider, and so did its retry.
    expect(upstream.seen).toHaveLength(2);
    const stall = exchanges().find((entry) => entry.kind === "stall")!;
    expect(stall).toMatchObject({ injected: true, outcome: "client_closed", tag: injectedTag });
    expect(stall.forwardedBytes).toBeGreaterThan(0);
    expect(stall.closedAfterLastWriteMs).toBeGreaterThanOrEqual(90);
    expect(stall.closedAfterLastWriteMs).toBeLessThan(380);
    expect(exchanges().find((entry) => entry.kind === "none")).toBeDefined();
  });

  it("records a stall that never took effect (an answer of one piece of text) as a plain exchange", async () => {
    // The provider answers with a single piece of text: there is nothing to stall after.
    const sink = new MemoryEventSink();
    const single = new FetchFaultInjector({
      plan: plan({ forced: [{ kind: "stall", afterMinute: 0, count: 1 }] }),
      seed: 1,
      sink,
      fetch: async () =>
        new Response(
          [
            events[1],
            {
              type: "response.completed",
              response: { usage: { input_tokens: 1, output_tokens: 1 } }
            }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } }
        )
    });
    const response = await single.fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: "{}"
    });
    await response.text();
    expect(single.injectedCounts()).toEqual({});
    expect(sink.events).toEqual([
      expect.objectContaining({ type: "exchange", kind: "none", injected: false })
    ]);
  });

  it("is a function of the seed: the same seed gives the same faults on the same requests", () => {
    const rates = {
      rateLimit: 0.02,
      unavailable: 0.01,
      lateFirstByte: 0.005,
      stall: 0.002,
      malformed: 0.003,
      unauthorized: 0.001,
      contextOverflow: 0.001
    };
    const schedule = (seed: number) =>
      new FetchFaultSchedule(plan({ rates }), seed, codexProviderName);
    const draw = (seed: number) => schedule(seed).preview(5_000);
    expect(draw(20261028)).toEqual(draw(20261028));
    expect(draw(20261029)).not.toEqual(draw(20261028));
    const faulted = draw(20261028).filter((fault) => fault !== null);
    const share = faulted.length / 5_000;
    // The plan's rates add up to 4.2 %.
    expect(share).toBeGreaterThan(0.03);
    expect(share).toBeLessThan(0.055);
    expect(new Set(faulted.map((fault) => fault!.kind)).size).toBeGreaterThanOrEqual(5);
  });

  it("passes a server on this machine through untouched and unrecorded", async () => {
    const { injector, upstream, exchanges } = layer({
      forced: [{ kind: "unavailable", afterMinute: 0, count: 5 }]
    });
    const response = await injector.fetch("http://127.0.0.1:41001/backend-api/codex/responses", {
      method: "POST",
      body: "{}"
    });
    await response.text();
    expect(upstream.seen).toHaveLength(1);
    expect(exchanges()).toHaveLength(0);
  });
});

describe("the windows", () => {
  it("answers every request with a usage limit whose reset is the window's remaining time, capped at an hour", async () => {
    let now = Date.parse("2026-10-29T06:00:00Z");
    const sink = new MemoryEventSink();
    const upstream = provider();
    const injector = new FetchFaultInjector({
      plan: plan(),
      seed: 1,
      sink,
      fetch: upstream.fetchStub,
      now: () => now
    });
    const adapter = new OpenAiCodexAdapter({
      accessToken: "t",
      accountId: "a",
      modelId: "gpt-5.6-luna",
      capabilities: ["text-generation"],
      fetch: injector.fetch,
      runtime,
      random: () => 0
    });
    injector.startWindow("w30", "usage_limit", 2 * 3_600_000);
    const failure = await adapter.run(request).catch((error: unknown) => error);
    // Two hours long, the parser's clamp reads a stated reset of 3,600 s.
    expect(failure).toMatchObject({ status: 429, transient: true, retryAfterMs: 3_600_000 });
    expect(String((failure as Error).message)).toContain("usage_limit_reached");
    // Later in the window the stated reset is what remains.
    now += 3_600_000 + 1_800_000;
    const later = await adapter.run(request).catch((error: unknown) => error);
    expect(later).toMatchObject({ status: 429, retryAfterMs: 1_800_000 });
    expect(upstream.seen).toHaveLength(0);
    const exchanges = sink.events.filter(
      (event): event is ExchangeRecord => event.type === "exchange"
    );
    expect(exchanges.length).toBeGreaterThan(0);
    expect(
      exchanges.every(
        (entry) =>
          entry.kind === "usage_limit" &&
          entry.window === "w30" &&
          entry.forwardedBytes === 0 &&
          entry.injected
      )
    ).toBe(true);
    // The window ends: the next call reaches the provider.
    injector.endWindow("w30");
    await expect(adapter.run(request)).resolves.toMatchObject({ output: "hello again world" });
    expect(upstream.seen).toHaveLength(1);
  });

  it("refuses the connection, and fails the host lookup, as undici does: transient transport errors with their codes", async () => {
    for (const [kind, code] of [
      ["refused", "ECONNREFUSED"],
      ["enotfound", "ENOTFOUND"]
    ] as const) {
      const { injector, adapter, upstream, exchanges } = layer();
      injector.startWindow("w", kind, 60_000);
      const failure = await adapter.run(request).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: "network", transient: true, code });
      // The adapter retried the transient failure to its limit.
      expect(remoteCallReport(failure)?.attempts).toBe(3);
      expect(upstream.seen).toHaveLength(0);
      expect(exchanges()).toHaveLength(3);
      expect(exchanges()[0]).toMatchObject({ kind, status: 0, injected: true, forwardedBytes: 0 });
    }
  });

  it("answers every request with a 401 while the sign-in window lasts, and recovers after it", async () => {
    const { injector, adapter, upstream } = layer();
    injector.startWindow("w102", "unauthorized", 60_000);
    await expect(adapter.run(request)).rejects.toMatchObject({ status: 401, transient: false });
    expect(upstream.seen).toHaveLength(0);
    injector.endWindow("w102");
    await expect(adapter.run(request)).resolves.toMatchObject({ output: "hello again world" });
  });

  it("applies to the probe too, and a window outranks the random faults", async () => {
    const { injector, adapter, exchanges } = layer({
      forced: [{ kind: "rate_limit", afterMinute: 0, count: 5 }]
    });
    injector.startWindow("w", "unauthorized", 60_000);
    await expect(adapter.listModels()).rejects.toMatchObject({ status: 401 });
    expect(exchanges().map((entry) => entry.kind)).toEqual(["unauthorized"]);
  });
});

describe("what the call's context is told", () => {
  it("counts the requests it forwarded and the ones it answered itself", async () => {
    const { adapter } = layer({
      forced: [{ kind: "unavailable", afterMinute: 0, count: 1 }]
    });
    const { context, outcome } = await withSoakCallContext(() => adapter.run(request));
    expect("value" in outcome).toBe(true);
    expect(context).toEqual({ forwardedRequests: 1, injectedRequests: 1 });
  });
});
