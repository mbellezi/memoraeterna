import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import {
  AiProviderError,
  OpenAiCompatibleAdapter,
  type AiRuntimeConfigInput,
  type AiTaskRequest
} from "@app/ai";
import type { QuestionAnswerInput } from "@app/domain";

import { AppEventSchema, type AppEvent, type AppEventOf } from "../../shared/app-events.js";
import { AppEventBus } from "./app-events.js";
import { consultationSnapshot } from "./consultation-fixture.js";
import { ConsultationService } from "./consultation-service.js";
import {
  devFakeAnswerModelId,
  devFakeApiKey,
  openAiCompatibleKind
} from "./dev/fake-remote-provider.js";
import { FakeProviderServer, fixedLatency } from "./dev/fake-remote-core.js";
import { MemoryEventSink } from "./dev/soak-records.js";
import { QuestionsService, type QuestionStore } from "./questions-service.js";

const mocks = vi.hoisted(() => ({
  retrieval: { candidates: vi.fn(), vector: vi.fn() },
  grounding: {
    scope: vi.fn(),
    topicMembers: vi.fn(),
    contexts: vi.fn(),
    relations: vi.fn(),
    relationDependencies: vi.fn(),
    validate: vi.fn()
  }
}));
vi.mock("@app/db", async (original) => {
  const db = await original<typeof import("@app/db")>();
  return {
    ...db,
    createConsultationRepository: () => mocks.retrieval,
    createKnowledgeConsultationRepository: () => mocks.grounding
  };
});

const sourceId = "00000000-0000-4000-8000-00000000000a";
const profile = consultationSnapshot().profile;
const chunkIds: string[] = [];
const row = (n: number) => {
  const chunkId = randomUUID();
  chunkIds.push(chunkId);
  return {
    chunkId,
    sourceItemId: sourceId,
    rootId: sourceId,
    documentId: randomUUID(),
    sourceSpanId: null,
    contentHash: `hash-${n}`,
    excerpt: `Retrieval practice improved delayed recall (${n}).`,
    sourceTitle: "A study",
    chunkIndex: n,
    documentCreatedAt: "2026-01-01T00:00:00.000Z",
    locator: null,
    total: 2,
    text: 1 / n,
    title: 0,
    concept: 0,
    note: 0,
    entity: 0,
    relation: 0
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  chunkIds.length = 0;
  mocks.grounding.scope.mockResolvedValue([sourceId]);
  mocks.grounding.contexts.mockResolvedValue([]);
  mocks.grounding.relations.mockResolvedValue([]);
  mocks.grounding.validate.mockResolvedValue(undefined);
  mocks.retrieval.candidates.mockImplementation(async () => [row(1), row(2)]);
  mocks.retrieval.vector.mockResolvedValue([]);
});

/** What the test's store saw, in order, beside the events: the order is what the tests assert. */
function harness(options: { failEnd?: boolean; deleteWhileRunning?: boolean } = {}) {
  const log: string[] = [];
  const answers: Array<{ questionId: string; answer: QuestionAnswerInput }> = [];
  const statuses: Array<{ id: string; status: string; errorKey: string | null | undefined }> = [];
  const questions = new Map<string, Record<string, unknown>>();
  const store: QuestionStore = {
    create: async (input) => {
      log.push("store:create");
      const created = {
        language: "und",
        scope: { kind: "library" },
        mode: "text",
        ...input,
        id: input.id ?? randomUUID(),
        status: "running",
        errorKey: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        answers: []
      };
      questions.set(created.id, created);
      return created as never;
    },
    appendAnswer: async (questionId, answer) => {
      log.push(`store:answer:${answer.status}`);
      if (options.failEnd) throw new Error("the database went away");
      if (options.deleteWhileRunning) questions.delete(questionId);
      if (!questions.has(questionId)) return null;
      answers.push({ questionId, answer });
      return { answerId: randomUUID(), version: answers.length, missingTargets: 0 };
    },
    setStatus: async (id, status, errorKey) => {
      log.push(`store:status:${status}`);
      statuses.push({ id, status, errorKey });
      return questions.has(id);
    }
  };
  const sent: AppEvent[] = [];
  const bus = new AppEventBus({ send: (event) => sent.push(event) });
  const raw: AppEvent[] = [];
  const publish = (event: AppEvent) => {
    log.push(`event:${event.type}${"stage" in event ? `:${event.stage}` : ""}`);
    raw.push(event);
    bus.publish(event);
  };
  return { log, answers, statuses, questions, store, sent, raw, bus, publish };
}

const stagesOf = (events: AppEvent[]) =>
  events
    .filter(
      (event): event is AppEventOf<"consultation.status"> => event.type === "consultation.status"
    )
    .map((event) => event.stage);
const deltasOf = (events: AppEvent[]) =>
  events.filter(
    (event): event is AppEventOf<"consultation.delta"> => event.type === "consultation.delta"
  );

/** Waits for a condition on real timers, as the Ask runs in the background. */
async function until(done: () => boolean, ms = 8_000) {
  const stop = Date.now() + ms;
  while (!done() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}

/** A rate limit (429) the adapter did not retry because its reset is past what it waits inline. */
const rateLimit = (retryAfterMs: number) =>
  new AiProviderError("AI provider request failed (429).", {
    kind: "http",
    transient: true,
    status: 429,
    retryAfterMs
  });

describe("Ask with a stored Question over the DEV fake remote (F5 D14)", () => {
  const running: FakeProviderServer[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.stop()));
  });

  const fast: AiRuntimeConfigInput = {
    deadlines: { connectMs: 1_000, firstByteMs: 5_000, stallMs: 5_000, answerStartMs: 5_000 },
    retry: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10, maxInlineRetryAfterMs: 1_000 }
  };

  /** The real adapter against the fake: its text pieces reach the Ask's hook as a runtime's do. */
  type Context = { onTextDelta?: (event: { kind: "text"; delta: string }) => void };
  type Step = "answer" | Error | ((context: Context) => Promise<unknown>);
  async function viaFake(script: Step[] = ["answer"]) {
    const server = new FakeProviderServer({
      kind: openAiCompatibleKind({ seed: 7, latency: fixedLatency(60) }),
      sink: new MemoryEventSink()
    });
    await server.start();
    running.push(server);
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: `${server.origin}/v1`,
      apiKey: devFakeApiKey,
      modelId: devFakeAnswerModelId,
      capabilities: ["text-generation", "structured-output"],
      runtime: fast,
      random: () => 0,
      treatAsRemote: true
    });
    const call = vi.fn(
      async (_profile: unknown, prompt: string, context: Context, signal: AbortSignal) => {
        const next = script.shift() ?? "answer";
        if (next instanceof Error) throw next;
        if (typeof next === "function") return next(context);
        const request: AiTaskRequest = {
          taskType: "structured-output",
          input: prompt,
          requiredCapabilities: [],
          parameters: {},
          metadata: {},
          workloadClass: "answer"
        };
        const result = await adapter.runStreaming(request, signal, (event) => {
          if (event.kind === "text") context.onTextDelta?.(event);
        });
        return {
          output: result.output,
          aiTaskRunId: randomUUID(),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens
        };
      }
    );
    const consultation = new ConsultationService({
      getPool: () => ({}) as PgPool,
      ai: {
        pinOrganizationProfile: vi.fn(async () => profile),
        runOrganizationTask: call,
        runConsultationEmbedding: vi.fn(async () => null)
      } as never,
      contentLanguage: async () => "en"
    });
    return { consultation, call };
  }

  const make = (
    h: ReturnType<typeof harness>,
    consultation: Pick<ConsultationService, "ask" | "cancel">
  ) =>
    new QuestionsService({
      getPool: () => ({}) as PgPool,
      consultation,
      contentLanguage: async () => "en",
      publish: h.publish,
      repository: () => h.store
    });

  it("inserts the row before the first delta, streams cumulative deltas and stores the last one", async () => {
    const h = harness();
    const { consultation } = await viaFake();
    const service = make(h, consultation);
    const { questionId, requestId } = await service.ask({ text: "Does retrieval practice help?" });
    // The Question exists, and its creation is published, before anything is retrieved.
    expect(h.questions.has(questionId)).toBe(true);
    await service.idle();
    h.bus.flush();

    const firstDelta = h.log.findIndex((entry) => entry === "event:consultation.delta");
    expect(h.log.indexOf("store:create")).toBe(0);
    expect(h.log.indexOf("event:object.changed")).toBeLessThan(firstDelta);
    expect(h.log.indexOf("event:consultation.status:retrieving")).toBeLessThan(firstDelta);

    // Every delta is the paragraphs so far, whole: each one extends the one before it.
    const deltas = deltasOf(h.raw);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    for (const [index, delta] of deltas.entries()) {
      expect(delta).toMatchObject({ requestId, questionId, restart: false });
      if (index === 0) continue;
      const previous = deltas[index - 1]!.paragraphs;
      expect(delta.paragraphs.slice(0, previous.length)).toEqual(previous);
      expect(delta.paragraphs.length).toBeGreaterThanOrEqual(previous.length);
    }

    // The stored answer is the last delta: same Markdown, same citations (ordinal and address).
    expect(h.answers).toHaveLength(1);
    const { answer } = h.answers[0]!;
    const last = deltas.at(-1)!.paragraphs;
    expect(last).toHaveLength(3);
    expect(answer.paragraphs).toEqual(
      last.map((paragraph) => ({
        markdown: paragraph.markdown,
        citations: paragraph.citations.map((citation) => citation.ordinal)
      }))
    );
    for (const paragraph of last)
      for (const citation of paragraph.citations)
        expect(citation.address).toBe(`memora://source/${sourceId}`);
    expect(answer.status).toBe("complete");
    expect(answer.citations.map((citation) => citation.kind)).toEqual(["chunk", "chunk"]);
    expect(answer.citations.every((citation) => chunkIds.includes(citation.targetId))).toBe(true);
    expect(answer.provenance).toMatchObject({
      route: "class:answer",
      provider: profile.provider,
      model: profile.modelId
    });
    // The bus received the same events: a status never overtakes the text before it.
    for (const event of h.sent) expect(AppEventSchema.parse(event)).toEqual(event);
    expect(stagesOf(h.sent)).toEqual(["retrieving", "answering", "done"]);
    const lastDeltaAt = h.sent.map((event) => event.type).lastIndexOf("consultation.delta");
    expect(lastDeltaAt).toBeLessThan(
      h.sent.findIndex((event) => event.type === "consultation.status" && event.stage === "done")
    );
    expect(h.log.at(-1)).toBe("event:consultation.status:done");
  });

  it("yields at least two deltas under the bus's 50 ms window", async () => {
    const h = harness();
    const { consultation } = await viaFake();
    const service = make(h, consultation);
    await service.ask({ text: "Does retrieval practice help?" });
    await service.idle();
    h.bus.flush();
    h.bus.dispose();
    const sent = deltasOf(h.sent);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1)!.paragraphs).toHaveLength(3);
    // The paragraphs the person saw only ever grew.
    const counts = sent.map((delta) => delta.paragraphs.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("cancels: the paragraphs written so far are stored as a canceled version", async () => {
    const h = harness();
    const { consultation } = await viaFake();
    const service = make(h, consultation);
    const { questionId, requestId } = await service.ask({ text: "Does retrieval practice help?" });
    await until(() => deltasOf(h.raw).length >= 1);
    await service.cancel({ requestId });
    await service.idle();
    h.bus.flush();
    expect(h.answers).toHaveLength(1);
    const { answer, questionId: storedFor } = h.answers[0]!;
    expect(storedFor).toBe(questionId);
    expect(answer.status).toBe("canceled");
    const shown = deltasOf(h.raw).at(-1)!.paragraphs;
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.length).toBeLessThan(3);
    expect(answer.paragraphs).toEqual(
      shown.map((paragraph) => ({
        markdown: paragraph.markdown,
        citations: paragraph.citations.map((citation) => citation.ordinal)
      }))
    );
    expect(stagesOf(h.sent).at(-1)).toBe("canceled");
    expect(stagesOf(h.sent)).not.toContain("done");
    expect(h.log).not.toContain("store:status:failed");
  });

  it("restarts the stream when the repair call writes the answer again", async () => {
    const h = harness();
    // The first call writes one paragraph and then an answer the parser refuses; the second call
    // (the repair) streams the real answer.
    const { consultation } = await viaFake([
      async (context) => {
        context.onTextDelta?.({
          kind: "text",
          delta: '{"paragraphs":[{"markdown":"A start [e1].","citations":["e1"]}'
        });
        return { output: "not json", aiTaskRunId: randomUUID(), inputTokens: 1, outputTokens: 1 };
      },
      "answer"
    ]);
    const service = make(h, consultation);
    await service.ask({ text: "Does retrieval practice help?" });
    await service.idle();
    const deltas = deltasOf(h.raw);
    const restart = deltas.findIndex((delta) => delta.restart);
    // The false start showed one paragraph; the restart voids it and the real answer follows.
    expect(restart).toBeGreaterThan(0);
    expect(deltas[restart - 1]!.paragraphs).toHaveLength(1);
    expect(deltas[restart]).toMatchObject({ paragraphs: [], restart: true });
    expect(deltas.slice(restart + 1).every((delta) => !delta.restart)).toBe(true);
    expect(deltas.at(-1)!.paragraphs).toHaveLength(3);
    expect(h.answers[0]!.answer.paragraphs).toHaveLength(3);
    // On the bus a restart is never folded away by the delta that follows it.
    h.bus.flush();
    expect(deltasOf(h.sent).some((delta) => delta.restart)).toBe(true);
  });

  it("passes waitingForProvider through at once, between the other stages", async () => {
    const h = harness();
    const { consultation } = await viaFake([rateLimit(5), "answer"]);
    const service = make(h, consultation);
    await service.ask({ text: "Does retrieval practice help?" });
    await until(() =>
      h.raw.some((event) => event.type === "consultation.status" && event.stage === "done")
    );
    // Without a flush: a status leaves at once, never held in a window.
    expect(stagesOf(h.sent)).toEqual([
      "retrieving",
      "answering",
      "waitingForProvider",
      "answering",
      "done"
    ]);
    await service.idle();
    h.bus.dispose();
  });
});

describe("Ask with a stored Question: its edges", () => {
  /** A consultation whose Ask is scripted: it runs `behavior` and ends as that does. */
  const scripted = (
    behavior: (input: unknown, hooks: Parameters<ConsultationService["ask"]>[1]) => Promise<never>
  ) => ({
    ask: vi.fn(behavior) as unknown as ConsultationService["ask"],
    cancel: vi.fn(async () => null) as unknown as ConsultationService["cancel"]
  });
  const make = (h: ReturnType<typeof harness>, consultation: ReturnType<typeof scripted>) =>
    new QuestionsService({
      getPool: () => ({}) as PgPool,
      consultation,
      contentLanguage: async () => "en",
      publish: h.publish,
      repository: () => h.store
    });

  it("refuses a question the pipeline would refuse before any row exists", async () => {
    const h = harness();
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("unreachable")))
    );
    await expect(service.ask({ text: "hi" })).rejects.toThrow();
    await expect(service.ask({ text: "x".repeat(1001) })).rejects.toThrow();
    await expect(
      service.ask({ text: "A fine question", scope: { kind: "sources", sourceIds: [] } })
    ).rejects.toThrow();
    expect(h.log).toEqual([]);
  });

  it("maps the scope, privacy and mode into the consultation input, library and offline by default", async () => {
    const h = harness();
    const consultation = scripted(async () =>
      Promise.reject(new Error("consultation.errors.deadline"))
    );
    const service = make(h, consultation);
    const topicId = randomUUID();
    const sourceIds = [randomUUID(), randomUUID()];
    const first = await service.ask({ text: "About the library" });
    await service.ask({
      text: "About a topic",
      scope: { kind: "topic", topicId },
      privacy: "allow_remote",
      mode: "hybrid"
    });
    await service.ask({ text: "About sources", scope: { kind: "sources", sourceIds } });
    await service.idle();
    const inputs = (
      consultation.ask as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }
    ).mock.calls.map(([input]) => input);
    expect(inputs[0]).toMatchObject({
      requestId: first.requestId,
      question: "About the library",
      privacy: "offline_only",
      mode: "text"
    });
    expect(inputs[0]).not.toHaveProperty("topicId");
    expect(inputs[0]).toMatchObject({ sourceIds: [] });
    expect(inputs[1]).toMatchObject({ topicId, privacy: "allow_remote", mode: "hybrid" });
    expect(inputs[2]).toMatchObject({ sourceIds });
    const created = [...h.questions.values()];
    expect(created.map((question) => question.scope)).toEqual([
      { kind: "library" },
      { kind: "topic", topicId },
      { kind: "sources", sourceIds }
    ]);
  });

  it("fails with the failure's message key and stores no answer version", async () => {
    const h = harness();
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("consultation.errors.noRelevantEvidence")))
    );
    const { questionId } = await service.ask({ text: "Nothing matches this" });
    await service.idle();
    h.bus.flush();
    expect(h.answers).toEqual([]);
    expect(h.statuses).toEqual([
      { id: questionId, status: "failed", errorKey: "consultation.errors.noRelevantEvidence" }
    ]);
    expect(h.sent.filter((event) => event.type === "consultation.status").at(-1)).toMatchObject({
      stage: "failed",
      questionId,
      error: "consultation.errors.noRelevantEvidence"
    });
  });

  it("never lets raw error text reach a window or the database", async () => {
    const h = harness();
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1 key=sk-secret")))
    );
    await service.ask({ text: "A question that fails" });
    await service.idle();
    expect(h.statuses[0]!.errorKey).toBe("consultation.errors.failed");
    expect(JSON.stringify(h.raw)).not.toContain("sk-secret");
  });

  it("stores a canceled version with no paragraphs when the cancel comes before any text", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const consultation = scripted(
      () =>
        new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error("consultation.errors.canceled"));
        })
    );
    (consultation.cancel as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      release();
      return null;
    });
    const service = make(h, consultation);
    const { requestId } = await service.ask({ text: "Cancel me quickly" });
    await expect(service.cancel({ requestId })).resolves.toBeNull();
    await service.idle();
    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.answer).toMatchObject({
      status: "canceled",
      paragraphs: [],
      citations: []
    });
    expect(stagesOf(h.raw)).toEqual(["canceled"]);
  });

  it("answers null to a cancel of an Ask that is not running, and refuses a malformed one", async () => {
    const h = harness();
    const consultation = scripted(async () =>
      Promise.reject(new Error("consultation.errors.deadline"))
    );
    const service = make(h, consultation);
    await expect(service.cancel({ requestId: randomUUID() })).resolves.toBeNull();
    expect(consultation.cancel).not.toHaveBeenCalled();
    await expect(service.cancel({ requestId: "nope" } as never)).rejects.toThrow();
  });

  it("drops the end of a Question the owner deleted while it ran, and says canceled", async () => {
    const h = harness({ deleteWhileRunning: true });
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("consultation.errors.canceled")))
    );
    await service.ask({ text: "Deleted while running" });
    await service.idle();
    expect(stagesOf(h.raw)).toEqual(["canceled"]);
    expect(h.raw.filter((event) => event.type === "object.changed")).toHaveLength(1);
  });

  it("still reports the end when the store fails, and never throws into the caller", async () => {
    const h = harness({ failEnd: true });
    const warn = vi.fn();
    const service = new QuestionsService({
      getPool: () => ({}) as PgPool,
      consultation: scripted(async () => Promise.reject(new Error("consultation.errors.canceled"))),
      contentLanguage: async () => "en",
      publish: h.publish,
      repository: () => h.store,
      logger: { warn }
    });
    await expect(service.ask({ text: "The store fails" })).resolves.toMatchObject({
      questionId: expect.any(String)
    });
    await service.idle();
    expect(stagesOf(h.raw)).toEqual(["canceled"]);
    expect(warn).toHaveBeenCalled();
  });

  it("refuses to ask while the database is not ready", async () => {
    const service = new QuestionsService({
      getPool: () => null,
      consultation: scripted(async () => Promise.reject(new Error("x"))),
      contentLanguage: async () => "en"
    });
    await expect(service.ask({ text: "Is the database ready?" })).rejects.toThrow(
      "consultation.errors.unavailable"
    );
  });
});
