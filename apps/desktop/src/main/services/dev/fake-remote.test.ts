import { relationExplanationOrder } from "@app/domain";
import {
  AiProviderError,
  OpenAiCodexAdapter,
  OpenAiCompatibleAdapter,
  type AiRuntimeConfigInput,
  type AiTaskRequest
} from "@app/ai";
import { afterEach, describe, expect, it } from "vitest";

import { consultationEvidence, consultationSnapshot } from "../consultation-fixture.js";
import { consultationPrompt, parseConsultationAnswer } from "../consultation-service.js";
import { defaultPromptPin, withPromptPin } from "../prompt-runtime.js";
import {
  acceptRelationExplanation,
  buildRelationExplanationPrompt,
  isNotRelatedAnswer,
  parseRelationExplanation
} from "../relation-explanation.js";
import {
  codexWireBasePath,
  codexWireKind,
  devCodexCredential,
  devFakeCodexModelId
} from "./fake-codex-provider.js";
import {
  FakeProviderServer,
  fixedLatency,
  quantileLatency,
  type FakeProviderKind,
  type ReplyScript
} from "./fake-remote-core.js";
import {
  devFakeAnswerModelId,
  devFakeApiKey,
  openAiCompatibleKind
} from "./fake-remote-provider.js";
import {
  FaultSchedule,
  faultPlanSchema,
  withFaults,
  type FaultPlanInput
} from "./fault-decorator.js";
import { MemoryEventSink, type ExchangeRecord } from "./soak-records.js";

/**
 * The fake remote providers of the soak (F3 R6, T62), driven by the real adapters: faults end the
 * way the remote deadlines say, the flag `treatAsRemote` is what arms those deadlines on loopback,
 * and the Codex-wire fake round-trips through the real Codex adapter.
 */

const seed = 20261021;
const running: FakeProviderServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

async function startFake(kind: FakeProviderKind, plan: FaultPlanInput = {}, name = kind.provider) {
  const sink = new MemoryEventSink();
  const schedule = new FaultSchedule(faultPlanSchema.parse(plan), seed, name);
  const server = new FakeProviderServer({
    kind: withFaults(kind, schedule),
    sink,
    windows: schedule.windows()
  });
  await server.start();
  running.push(server);
  return { server, sink };
}

const exchanges = (sink: MemoryEventSink): ExchangeRecord[] =>
  sink.events.filter((event): event is ExchangeRecord => event.type === "exchange");

/** Short bounds, so the faults of 25 s and 35 s play in a few hundred milliseconds. */
const fast: AiRuntimeConfigInput = {
  deadlines: { connectMs: 1_000, firstByteMs: 300, stallMs: 150, answerStartMs: 5_000 },
  retry: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10, maxInlineRetryAfterMs: 1_000 }
};

const compatible = (
  origin: string,
  options: { treatAsRemote?: boolean; runtime?: AiRuntimeConfigInput } = {}
) =>
  new OpenAiCompatibleAdapter({
    baseUrl: `${origin}/v1`,
    apiKey: devFakeApiKey,
    modelId: devFakeAnswerModelId,
    capabilities: ["text-generation", "structured-output"],
    runtime: options.runtime ?? fast,
    random: () => 0,
    ...(options.treatAsRemote ? { treatAsRemote: true } : {})
  });
const codex = (
  origin: string,
  runtime: AiRuntimeConfigInput = fast,
  accessToken: string = devCodexCredential.access
) =>
  new OpenAiCodexAdapter({
    accessToken,
    accountId: devCodexCredential.accountId,
    modelId: devFakeCodexModelId,
    capabilities: ["text-generation"],
    baseUrl: `${origin}${codexWireBasePath}`,
    runtime,
    random: () => 0
  });

const askRequest = (prompt: string): AiTaskRequest => ({
  taskType: "structured-output",
  input: prompt,
  requiredCapabilities: [],
  parameters: {},
  metadata: {},
  workloadClass: "answer"
});
const explainRequest = (prompt: string): AiTaskRequest => ({
  taskType: "text-generation",
  input: prompt,
  requiredCapabilities: [],
  parameters: {},
  metadata: {},
  workloadClass: "write-fast",
  operation: "relation_explanation"
});

const snapshot = consultationSnapshot({
  evidence: [consultationEvidence(1), consultationEvidence(2)]
});
const askPrompt = consultationPrompt(snapshot, "What improves delayed recall?");

function explanationPrompt(): string {
  const note = (title: string, idea: string) => ({
    id: title,
    title,
    ideaStatement: idea,
    passage: idea
  });
  const order = relationExplanationOrder({
    type: "supports",
    semanticSourceId: null,
    a: note("00000000-0000-4000-8000-0000000000aa", "Retrieval with feedback improved recall."),
    b: note("00000000-0000-4000-8000-0000000000bb", "Spaced practice strengthens memory.")
  });
  return withPromptPin(defaultPromptPin(), () =>
    buildRelationExplanationPrompt({
      type: "supports",
      direction: order.direction,
      first: order.first,
      second: order.second
    })
  );
}
const ids = {
  first: "00000000-0000-4000-8000-0000000000aa",
  second: "00000000-0000-4000-8000-0000000000bb"
};

describe("the fault schedule", () => {
  const plan = faultPlanSchema.parse({
    rates: {
      rateLimit: 0.05,
      unavailable: 0.02,
      stall: 0.01,
      lateFirstByte: 0.01,
      malformed: 0.005
    }
  });

  it("is deterministic per seed, provider and request number", () => {
    const first = new FaultSchedule(plan, seed, "codex-wire").preview(2_000);
    const again = new FaultSchedule(plan, seed, "codex-wire").preview(2_000);
    expect(again).toEqual(first);
    // Another seed or another provider draws other faults.
    expect(new FaultSchedule(plan, seed + 1, "codex-wire").preview(2_000)).not.toEqual(first);
    expect(new FaultSchedule(plan, seed, "openai-compatible").preview(2_000)).not.toEqual(first);
  });

  it("draws the planned shares of each fault kind and a Retry-After in range", () => {
    const faults = new FaultSchedule(plan, seed, "codex-wire").preview(20_000);
    const share = (kind: string) =>
      faults.filter((fault) => fault?.kind === kind).length / faults.length;
    expect(share("rate_limit")).toBeCloseTo(0.05, 1);
    expect(share("unavailable")).toBeCloseTo(0.02, 1);
    expect(share("stall") + share("late_first_byte")).toBeCloseTo(0.02, 1);
    expect(share("malformed")).toBeLessThan(0.012);
    const waits = faults.flatMap((fault) =>
      fault?.retryAfterSeconds ? [fault.retryAfterSeconds] : []
    );
    expect(Math.min(...waits)).toBe(1);
    expect(Math.max(...waits)).toBe(10);
  });

  it("does not depend on when or how often it is asked", () => {
    const schedule = new FaultSchedule(plan, seed, "codex-wire");
    const late = schedule.requestFault(7, 5_000_000);
    expect(new FaultSchedule(plan, seed, "codex-wire").requestFault(7, 0)).toEqual(late);
  });

  it("forces a burst of one kind once its minute has passed, then goes back to the random draw", () => {
    const forced = new FaultSchedule(
      faultPlanSchema.parse({ forced: [{ kind: "stall", afterMinute: 10, count: 3 }] }),
      seed,
      "codex-wire"
    );
    expect(forced.requestFault(1, 9 * 60_000)).toBeNull();
    expect(forced.requestFault(2, 10 * 60_000)).toMatchObject({ kind: "stall", forced: true });
    expect(forced.requestFault(3, 10 * 60_000 + 1)?.kind).toBe("stall");
    expect(forced.requestFault(4, 11 * 60_000)?.kind).toBe("stall");
    expect(forced.requestFault(5, 12 * 60_000)).toBeNull();
  });

  it("stretches answers inside a slow window only", () => {
    const slow = new FaultSchedule(
      faultPlanSchema.parse({
        windows: [{ kind: "slow", startMinute: 1, durationMinutes: 2, factor: 10 }]
      }),
      seed,
      "openai-compatible"
    );
    expect([
      slow.slowFactor(30_000),
      slow.slowFactor(60_000),
      slow.slowFactor(179_999),
      slow.slowFactor(180_000)
    ]).toEqual([1, 10, 10, 1]);
  });
});

describe("the latency model", () => {
  it("interpolates a recorded distribution and clamps it", () => {
    const model = quantileLatency([1_000, 2_000, 4_000, 10_000], { minMs: 1_500, maxMs: 8_000 });
    expect(model.sample(0)).toBe(1_500);
    expect(model.sample(0.5)).toBe(3_000);
    expect(model.sample(0.999)).toBe(8_000);
    expect(fixedLatency(40).sample(0.7)).toBe(40);
  });
});

describe("the OpenAI-compatible fake through the real adapter", () => {
  const kind = () => openAiCompatibleKind({ seed, latency: fixedLatency(60) });

  it("lists its model and answers Ask with a valid answer that cites the first passage", async () => {
    const { server, sink } = await startFake(kind());
    const adapter = compatible(server.origin, { treatAsRemote: true });
    expect((await adapter.listModels()).map((model) => model.modelId)).toEqual([
      devFakeAnswerModelId
    ]);

    const deltas: string[] = [];
    const result = await adapter.runStreaming(askRequest(askPrompt), undefined, (event) => {
      if (event.kind === "text") deltas.push(event.delta);
    });
    const answer = parseConsultationAnswer(result.output, snapshot);
    expect(answer.paragraphs[0]!.citations).toEqual(["e1"]);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.join("")).toBe(result.output);
    expect(result).toMatchObject({
      providerId: "openai-compatible",
      inputTokens: expect.any(Number)
    });
    await waitUntil(() => exchanges(sink).length === 1);
    expect(exchanges(sink)[0]).toMatchObject({
      provider: "openai-compatible",
      kind: "none",
      injected: false,
      status: 200,
      outcome: "completed"
    });
  });

  it("refuses a request that does not carry the DEV key", async () => {
    const { server } = await startFake(kind());
    const wrong = new OpenAiCompatibleAdapter({
      baseUrl: `${server.origin}/v1`,
      apiKey: "a-real-looking-key",
      modelId: devFakeAnswerModelId,
      capabilities: ["text-generation"],
      runtime: fast
    });
    await expect(wrong.testConnection()).rejects.toMatchObject({ status: 401, transient: false });
  });

  it("with treatAsRemote a first byte at 35 s ends at the first-byte bound; without it the bound is not armed", async () => {
    const plan: FaultPlanInput = {
      lateFirstByteMs: 450,
      forced: [{ kind: "late_first_byte", afterMinute: 0, count: 2 }]
    };
    const remote = await startFake(kind(), plan);
    const error = await compatible(remote.server.origin, { treatAsRemote: true })
      .runStreaming(askRequest(askPrompt), undefined, () => undefined)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ kind: "timeout", transient: true });
    await waitUntil(() => exchanges(remote.sink).length === 1);
    const [late] = exchanges(remote.sink);
    expect(late).toMatchObject({
      kind: "late_first_byte",
      injected: true,
      outcome: "client_closed"
    });
    // The client left at its 300 ms first-byte bound, long before the 450 ms the fake waited.
    expect(late!.closedAfterMs).toBeGreaterThanOrEqual(280);
    expect(late!.closedAfterMs).toBeLessThan(440);

    // The same fault with the flag ignored: loopback is local, so no first-byte bound is armed.
    const unflagged = await compatible(remote.server.origin).runStreaming(
      askRequest(askPrompt),
      undefined,
      () => undefined
    );
    expect(String(unflagged.output).length).toBeGreaterThan(0);
  });

  it("ends a 25 s stall at the stall bound, after the first text", async () => {
    const { server, sink } = await startFake(kind(), {
      stallMs: 600,
      forced: [{ kind: "stall", afterMinute: 0, count: 1 }]
    });
    const error = await compatible(server.origin, { treatAsRemote: true })
      .runStreaming(askRequest(askPrompt), undefined, () => undefined)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "stalled", transient: true });
    await waitUntil(() => exchanges(sink).length === 1);
    const [stalled] = exchanges(sink);
    expect(stalled).toMatchObject({ kind: "stall", outcome: "client_closed" });
    expect(stalled!.closedAfterLastWriteMs).toBeGreaterThanOrEqual(130);
    expect(stalled!.closedAfterLastWriteMs).toBeLessThan(500);
  });

  it("answers a 429 with Retry-After and a 503, which the adapter retries", async () => {
    const { server, sink } = await startFake(kind(), {
      retryAfterSeconds: [0, 0],
      forced: [
        { kind: "rate_limit", afterMinute: 0, count: 1 },
        { kind: "unavailable", afterMinute: 0, count: 1 }
      ]
    });
    const retrying: AiRuntimeConfigInput = {
      ...fast,
      retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10, maxInlineRetryAfterMs: 1_000 }
    };
    const result = await compatible(server.origin, {
      treatAsRemote: true,
      runtime: retrying
    }).runStreaming(askRequest(askPrompt), undefined, () => undefined);
    expect(result.attempts).toBe(3);
    await waitUntil(() => exchanges(sink).length === 3);
    expect(exchanges(sink).map((exchange) => [exchange.kind, exchange.status])).toEqual([
      ["rate_limit", 429],
      ["unavailable", 503],
      ["none", 200]
    ]);
    expect(exchanges(sink)[0]!.retryAfterSeconds).toBe(0);
  });

  it("answers a malformed Ask that the consultation parser refuses", async () => {
    const { server } = await startFake(kind(), {
      forced: [{ kind: "malformed", afterMinute: 0, count: 1 }]
    });
    const result = await compatible(server.origin, { treatAsRemote: true }).runStreaming(
      askRequest(askPrompt),
      undefined,
      () => undefined
    );
    expect(() => parseConsultationAnswer(result.output, snapshot)).toThrow();
  });

  it("refuses connections during an outage and answers again after it", async () => {
    const { server, sink } = await startFake(kind(), {
      windows: [{ kind: "outage", startMinute: 0.001, durationMinutes: 0.004 }]
    });
    const adapter = compatible(server.origin, { treatAsRemote: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const error = await adapter
      .runStreaming(askRequest(askPrompt), undefined, () => undefined)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "network", transient: true });
    await waitUntil(() => sink.events.some((event) => event.type === "window"), 2_000);
    expect(sink.events.find((event) => event.type === "window")).toMatchObject({
      kind: "outage",
      provider: "openai-compatible"
    });
    const after = await adapter.runStreaming(askRequest(askPrompt), undefined, () => undefined);
    expect(String(after.output).length).toBeGreaterThan(0);
  });

  it("stretches the answer inside a slow window and says so in its record", async () => {
    const { server, sink } = await startFake(kind(), {
      windows: [{ kind: "slow", startMinute: 0, durationMinutes: 1, factor: 5 }]
    });
    await compatible(server.origin, { treatAsRemote: true, runtime: {} }).runStreaming(
      askRequest(askPrompt),
      undefined,
      () => undefined
    );
    await waitUntil(() => exchanges(sink).length === 1);
    expect(exchanges(sink)[0]).toMatchObject({ kind: "slow", injected: true });
    expect(exchanges(sink)[0]!.plannedMs).toBeGreaterThanOrEqual(290);
  });
});

describe("the Codex-wire fake through the real Codex adapter", () => {
  const kind = (rate = 0) =>
    codexWireKind({ seed, latency: fixedLatency(60), notRelatedRate: rate });

  it("round-trips an explanation through the Codex adapter and its DEV OAuth stub", async () => {
    const { server, sink } = await startFake(kind());
    const adapter = codex(server.origin);
    expect((await adapter.listModels()).map((model) => model.modelId)).toEqual([
      devFakeCodexModelId
    ]);
    const deltas: string[] = [];
    const result = await adapter.runStreaming(
      explainRequest(explanationPrompt()),
      undefined,
      (event) => {
        if (event.kind === "text") deltas.push(event.delta);
      }
    );
    expect(result).toMatchObject({ providerId: "openai-codex", runtime: "remote" });
    const accepted = acceptRelationExplanation(result.output, ids);
    expect(accepted).toContain("<note-ref");
    expect(parseRelationExplanation(result.output)).not.toBeNull();
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.join("")).toBe(result.output);
    await waitUntil(() => exchanges(sink).length === 1);
    expect(exchanges(sink)[0]).toMatchObject({
      provider: "codex-wire",
      kind: "none",
      outcome: "completed"
    });
  });

  it("answers the sentinel at the planned rate and never for another prompt", async () => {
    const { server } = await startFake(kind(1));
    const adapter = codex(server.origin);
    const related = await adapter.run(explainRequest(explanationPrompt()));
    expect(isNotRelatedAnswer(related.output)).toBe(true);
    const other = await adapter.run(explainRequest("Say OK."));
    expect(other.output).toBe("OK");
  });

  it("answers about 2 % of explanations with the sentinel, repeatably", async () => {
    const outputs = async () => {
      const { server } = await startFake(codexWireKind({ seed, latency: fixedLatency(0) }));
      const adapter = codex(server.origin);
      const prompt = explanationPrompt();
      const sentinels: number[] = [];
      for (let index = 0; index < 200; index++) {
        const result = await adapter.run(explainRequest(prompt));
        if (isNotRelatedAnswer(result.output)) sentinels.push(index);
      }
      return sentinels;
    };
    const first = await outputs();
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first.length).toBeLessThanOrEqual(10);
    expect(await outputs()).toEqual(first);
  });

  it("refuses a request without the DEV token, as a permanent failure", async () => {
    const { server } = await startFake(kind());
    const error = await codex(server.origin, fast, "a-real-looking-token")
      .run(explainRequest(explanationPrompt()))
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 401, transient: false });
  });

  it("is always a remote call: a first byte at 35 s ends at the first-byte bound, a stall at the stall bound", async () => {
    const { server, sink } = await startFake(kind(), {
      lateFirstByteMs: 450,
      stallMs: 600,
      forced: [
        { kind: "late_first_byte", afterMinute: 0, count: 1 },
        { kind: "stall", afterMinute: 0, count: 1 }
      ]
    });
    const adapter = codex(server.origin);
    const first = await adapter
      .run(explainRequest(explanationPrompt()))
      .catch((reason: unknown) => reason);
    const second = await adapter
      .run(explainRequest(explanationPrompt()))
      .catch((reason: unknown) => reason);
    expect(first).toMatchObject({ kind: "timeout" });
    expect(second).toMatchObject({ kind: "stalled" });
    await waitUntil(() => exchanges(sink).length === 2);
    expect(exchanges(sink).map((exchange) => exchange.kind)).toEqual(["late_first_byte", "stall"]);
  });

  it("answers a malformed explanation that the writer refuses", async () => {
    const { server } = await startFake(kind(), {
      forced: [{ kind: "malformed", afterMinute: 0, count: 1 }]
    });
    const result = await codex(server.origin).run(explainRequest(explanationPrompt()));
    expect(parseRelationExplanation(result.output)).toBeNull();
  });
});

describe("a third remote kind", () => {
  it("is covered by the same faults, ledger and windows once wrapped", async () => {
    // A stand-in for the Decisions API (plan decision 30): the faults need no change to cover it.
    const decisions: FakeProviderKind = {
      provider: "decisions-api",
      authorize: () => true,
      isGeneration: (request) => request.path === "/decide",
      reply: (): ReplyScript => ({
        status: 200,
        headers: { "content-type": "application/json" },
        parts: [{ delayMs: 0, data: '{"verdict":"accept"}', text: true }]
      }),
      replyWithText: (): ReplyScript => ({
        status: 200,
        headers: {},
        parts: [{ delayMs: 0, data: "{", text: true }]
      }),
      malformedText: () => "{",
      rateLimited: (): ReplyScript => ({ status: 429, headers: { "retry-after": "1" }, parts: [] }),
      unavailable: (): ReplyScript => ({ status: 503, headers: {}, parts: [] })
    };
    const { server, sink } = await startFake(decisions, {
      forced: [{ kind: "unavailable", afterMinute: 0, count: 1 }]
    });
    expect((await fetch(`${server.origin}/decide`, { method: "POST", body: "{}" })).status).toBe(
      503
    );
    expect((await fetch(`${server.origin}/decide`, { method: "POST", body: "{}" })).status).toBe(
      200
    );
    await waitUntil(() => exchanges(sink).length === 2);
    expect(exchanges(sink).map((exchange) => [exchange.provider, exchange.kind])).toEqual([
      ["decisions-api", "unavailable"],
      ["decisions-api", "none"]
    ]);
  });
});

/** Polls until the condition holds. */
async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
