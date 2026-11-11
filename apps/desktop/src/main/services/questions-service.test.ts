import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import {
  AiProviderError,
  OpenAiCompatibleAdapter,
  type AiRuntimeConfigInput,
  type AiTaskRequest
} from "@app/ai";
import { QuestionAnswerInputSchema, type QuestionAnswerInput } from "@app/domain";

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
import { interruptedErrorKey, QuestionsService, type QuestionsStore } from "./questions-service.js";

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
function harness(
  options: {
    failEnd?: boolean;
    deleteWhileRunning?: boolean;
    listError?: Error;
    nextCursor?: string;
  } = {}
) {
  const log: string[] = [];
  const answers: Array<{ questionId: string; answer: QuestionAnswerInput }> = [];
  const statuses: Array<{ id: string; status: string; errorKey: string | null | undefined }> = [];
  const questions = new Map<string, Record<string, unknown>>();
  const store: QuestionsStore = {
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
      const question = questions.get(id);
      if (question) question.status = status;
      return questions.has(id);
    },
    get: async (id) => (questions.get(id) as never) ?? null,
    list: async (input) => {
      if (options.listError) throw options.listError;
      const items = [...questions.values()].map((question) => ({ ...question, answerCount: 0 }));
      return {
        items: items.slice(0, input?.limit ?? 25),
        nextCursor: options.nextCursor ?? null
      } as never;
    },
    delete: async (id) => {
      log.push("store:delete");
      return questions.delete(id);
    },
    clear: async () => {
      log.push("store:clear");
      const count = questions.size;
      questions.clear();
      return count;
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

  /** An Ask that streams the given answer text, then waits for the cancel the test sends. */
  const streamsThenWaits = (text: string) => {
    let release: () => void = () => undefined;
    let streamed: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      streamed = resolve;
    });
    const consultation = scripted(
      (_input, hooks) =>
        new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error("consultation.errors.canceled"));
          hooks?.onText?.({ kind: "text", delta: text });
          streamed();
        })
    );
    (consultation.cancel as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      release();
      return null;
    });
    return { consultation, written };
  };
  const answerText = (paragraphs: string[]) =>
    JSON.stringify({
      paragraphs: paragraphs.map((markdown) => ({ markdown, citations: [], contextIds: [] })),
      gaps: []
    });

  it("cuts a canceled answer to the stored limits so the canceled version is kept", async () => {
    const h = harness();
    const text = answerText([
      "x".repeat(7000),
      ...Array.from({ length: 12 }, (_unused, index) => `Paragraph ${index + 2}.`)
    ]);
    const { consultation, written } = streamsThenWaits(text);
    const service = make(h, consultation);
    const { requestId } = await service.ask({ text: "Cancel a long answer" });
    await written;
    await service.cancel({ requestId });
    await service.idle();
    expect(h.answers).toHaveLength(1);
    const { answer } = h.answers[0]!;
    expect(answer.status).toBe("canceled");
    expect(answer.paragraphs).toHaveLength(12);
    expect(answer.paragraphs[0]!.markdown).toHaveLength(6000);
    // What is stored passes the schema the repository applies.
    expect(() => QuestionAnswerInputSchema.parse(answer)).not.toThrow();
  });

  it("marks the Question canceled when the answer cannot be stored, instead of leaving it running", async () => {
    const h = harness({ failEnd: true });
    const warn = vi.fn();
    const { consultation, written } = streamsThenWaits(answerText(["One paragraph."]));
    const service = new QuestionsService({
      getPool: () => ({}) as PgPool,
      consultation,
      contentLanguage: async () => "en",
      publish: h.publish,
      repository: () => h.store,
      logger: { warn }
    });
    const { questionId, requestId } = await service.ask({ text: "Cancel with a failing store" });
    await written;
    await service.cancel({ requestId });
    await service.idle();
    expect(h.statuses).toEqual([
      { id: questionId, status: "canceled", errorKey: "consultation.errors.canceled" }
    ]);
    expect(stagesOf(h.raw).at(-1)).toBe("canceled");
  });

  it("logs both store errors and still reports the failure when the status cannot be stored twice", async () => {
    const h = harness();
    const warn = vi.fn();
    const failing: QuestionStore = {
      ...h.store,
      setStatus: async () => {
        throw new Error("the database went away");
      }
    };
    const service = new QuestionsService({
      getPool: () => ({}) as PgPool,
      consultation: scripted(async () => Promise.reject(new Error("consultation.errors.deadline"))),
      contentLanguage: async () => "en",
      publish: h.publish,
      repository: () => failing,
      logger: { warn }
    });
    await service.ask({ text: "Nothing can be stored" });
    await service.idle();
    expect(stagesOf(h.raw)).toEqual(["failed"]);
    expect(warn).toHaveBeenCalledTimes(2);
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

describe("Ask persistence reads (F5 T129)", () => {
  const scripted = (
    behavior: (input: unknown, hooks: Parameters<ConsultationService["ask"]>[1]) => Promise<never>
  ) => ({
    ask: vi.fn(behavior) as unknown as ConsultationService["ask"],
    cancel: vi.fn(async () => null) as unknown as ConsultationService["cancel"]
  });
  /** An Ask that never ends until `release` is called, then fails as canceled. */
  const held = () => {
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
    return { consultation, release: () => release() };
  };
  const make = (h: ReturnType<typeof harness>, consultation: ReturnType<typeof scripted>) =>
    new QuestionsService({
      getPool: () => ({}) as PgPool,
      consultation,
      contentLanguage: async () => "en",
      publish: h.publish,
      repository: () => h.store
    });

  const target = randomUUID();
  const storedQuestion = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    text: "What helps memory?",
    language: "en",
    scope: { kind: "library" },
    privacy: "offline_only",
    mode: "text",
    status: "complete",
    errorKey: null,
    createdAt: new Date("2026-11-11T10:00:00.000Z"),
    updatedAt: new Date("2026-11-11T10:00:05.000Z"),
    answers: [
      {
        id: randomUUID(),
        version: 1,
        paragraphs: [
          { markdown: "Retrieval practice helps [e1].", citations: [1] },
          { markdown: "Spacing helps [e2] and [e1].", citations: [2, 1] },
          { markdown: "A plain closing.", citations: [] }
        ],
        provenance: { route: "class:answer", model: "m" },
        status: "complete",
        startedAt: new Date("2026-11-11T10:00:01.000Z"),
        completedAt: new Date("2026-11-11T10:00:05.000Z"),
        stale: true,
        citations: [
          {
            ordinal: 1,
            address: `memora://source/${target}`,
            anchor: { passage: randomUUID() },
            unavailable: false,
            stale: false
          },
          { ordinal: 2, address: null, unavailable: true, stale: true }
        ]
      }
    ],
    ...overrides
  });

  it("reads one Question with its answer versions, citations in paragraph order and staleness", async () => {
    const h = harness();
    const question = storedQuestion();
    h.questions.set(question.id, question);
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("x")))
    );
    const view = await service.get({ id: question.id });
    expect(view).toMatchObject({
      id: question.id,
      text: "What helps memory?",
      status: "complete",
      createdAt: "2026-11-11T10:00:00.000Z",
      scope: { kind: "library" }
    });
    expect(view).not.toHaveProperty("errorKey");
    const [answer] = view!.answers;
    expect(answer).toMatchObject({
      version: 1,
      status: "complete",
      stale: true,
      completedAt: "2026-11-11T10:00:05.000Z",
      model: { route: "class:answer", model: "m" }
    });
    expect(
      answer!.paragraphs.map((paragraph) => paragraph.citations.map((c) => c.ordinal))
    ).toEqual([[1], [2, 1], []]);
    // A citation whose target is gone says so: no address, unavailable and stale.
    expect(answer!.paragraphs[1]!.citations[0]).toEqual({
      ordinal: 2,
      address: null,
      unavailable: true,
      stale: true
    });
    expect(await service.get({ id: randomUUID() })).toBeNull();
    await expect(service.get({ id: "nope" })).rejects.toThrow();
  });

  it("reads a Question the store holds as running, with no Ask writing it, as failed", async () => {
    const h = harness();
    const orphan = storedQuestion({ status: "running", answers: [] });
    h.questions.set(orphan.id, orphan);
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("x")))
    );
    expect(await service.get({ id: orphan.id })).toMatchObject({
      status: "failed",
      errorKey: interruptedErrorKey
    });
    const page = await service.list({});
    expect(page.items.map((item) => item.status)).toEqual(["failed"]);
  });

  it("keeps a running Question running while its Ask writes it", async () => {
    const h = harness();
    const { consultation, release } = held();
    const service = make(h, consultation);
    const { questionId } = await service.ask({ text: "Still being answered" });
    expect((await service.get({ id: questionId }))?.status).toBe("running");
    expect((await service.list({})).items[0]?.status).toBe("running");
    release();
    await service.idle();
  });

  it("lists as the store pages: items as strings, an optional next, and a refused cursor by key", async () => {
    const h = harness({ nextCursor: "next-page" });
    const first = storedQuestion();
    h.questions.set(first.id, first);
    const service = make(
      h,
      scripted(async () => Promise.reject(new Error("x")))
    );
    const page = await service.list({ limit: 10, query: "memory" });
    expect(page).toEqual({
      items: [
        {
          id: first.id,
          text: "What helps memory?",
          language: "en",
          scope: { kind: "library" },
          status: "complete",
          createdAt: "2026-11-11T10:00:00.000Z",
          updatedAt: "2026-11-11T10:00:05.000Z",
          answerCount: 0
        }
      ],
      next: "next-page"
    });
    expect(
      await make(
        harness(),
        scripted(async () => Promise.reject(new Error("x")))
      ).list({})
    ).toEqual({
      items: []
    });
    await expect(service.list({ limit: 51 })).rejects.toThrow();
    for (const error of [
      new Error("errors.questions.cursor"),
      Object.assign(new Error('invalid input syntax for type timestamp with time zone: "1"'), {
        code: "22007"
      }),
      Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: "22P02" })
    ])
      await expect(
        make(
          harness({ listError: error }),
          scripted(async () => Promise.reject(new Error("x")))
        ).list({
          cursor: "tampered"
        })
      ).rejects.toThrow("questions.errors.cursor");
    // Any other failure is not taken for a cursor.
    await expect(
      make(
        harness({ listError: new Error("connection lost") }),
        scripted(async () => Promise.reject(new Error("x")))
      ).list({})
    ).rejects.toThrow("connection lost");
  });

  it("deletes one Question, says so, and cancels the Ask still writing it", async () => {
    const h = harness();
    const { consultation, release } = held();
    const service = make(h, consultation);
    const { questionId, requestId } = await service.ask({ text: "To be deleted while running" });
    await expect(service.delete({ id: questionId })).resolves.toEqual({ deleted: true });
    expect(consultation.cancel).toHaveBeenCalledWith(requestId);
    release();
    await service.idle();
    expect(h.raw).toContainEqual({
      type: "object.changed",
      refs: [{ kind: "question", id: questionId, change: "deleted" }]
    });
    expect(h.answers).toEqual([]);
    expect(stagesOf(h.raw).at(-1)).toBe("canceled");
    // Nothing is left to delete the second time, and nothing is published for it.
    const before = h.raw.length;
    await expect(service.delete({ id: questionId })).resolves.toEqual({ deleted: false });
    expect(h.raw).toHaveLength(before);
    await expect(service.delete({ id: "nope" })).rejects.toThrow();
  });

  it("clears every Question in one call with one overflow event, canceling running Asks", async () => {
    const h = harness();
    const { consultation, release } = held();
    const service = make(h, consultation);
    const old = storedQuestion();
    h.questions.set(old.id, old);
    await service.ask({ text: "Running when cleared" });
    await expect(service.clear()).resolves.toEqual({ deleted: 2 });
    release();
    await service.idle();
    expect(h.log.filter((entry) => entry === "store:clear")).toHaveLength(1);
    const overflow = h.raw.filter(
      (event) => event.type === "object.changed" && "overflow" in event
    );
    expect(overflow).toEqual([{ type: "object.changed", overflow: true, kinds: ["question"] }]);
    for (const event of overflow) expect(AppEventSchema.parse(event)).toEqual(event);
    expect(h.questions.size).toBe(0);
    // Clearing nothing publishes nothing.
    const before = h.raw.length;
    await expect(service.clear()).resolves.toEqual({ deleted: 0 });
    expect(h.raw).toHaveLength(before);
  });

  it("asks again with the stored words, scope, privacy and mode, as a new request on the same Question", async () => {
    const h = harness();
    const topicId = randomUUID();
    const consultation = scripted(async () =>
      Promise.reject(new Error("consultation.errors.deadline"))
    );
    const service = make(h, consultation);
    const question = storedQuestion({
      scope: { kind: "topic", topicId },
      privacy: "allow_remote",
      mode: "hybrid"
    });
    h.questions.set(question.id, question);
    const { requestId } = await service.askAgain({ id: question.id });
    await service.idle();
    expect(requestId).toEqual(expect.any(String));
    const [input] = (consultation.ask as unknown as { mock: { calls: Array<[unknown]> } }).mock
      .calls[0]!;
    expect(input).toMatchObject({
      requestId,
      question: "What helps memory?",
      topicId,
      privacy: "allow_remote",
      mode: "hybrid"
    });
    // The Question goes back to running before the Ask starts, and a new row is never inserted.
    expect(h.log.indexOf("store:status:running")).toBeLessThan(
      h.log.indexOf("event:object.changed")
    );
    expect(h.log).not.toContain("store:create");
    expect(h.raw[0]).toEqual({
      type: "object.changed",
      refs: [{ kind: "question", id: question.id, change: "updated" }]
    });
    // This Ask failed, so the Question ends failed with the failure's key.
    expect(h.statuses.at(-1)).toMatchObject({ id: question.id, status: "failed" });
  });

  it("stores the new answer as the next version of the same Question", async () => {
    const h = harness();
    const { consultation, release } = held();
    const service = make(h, consultation);
    const question = storedQuestion();
    h.questions.set(question.id, question);
    const { requestId } = await service.askAgain({ id: question.id });
    await service.cancel({ requestId });
    release();
    await service.idle();
    expect(h.answers.map((entry) => entry.questionId)).toEqual([question.id]);
    expect(h.answers[0]!.answer.status).toBe("canceled");
  });

  it("refuses to ask again while an Ask writes the Question, at once or twice at the same time", async () => {
    const h = harness();
    const { consultation, release } = held();
    const service = make(h, consultation);
    const { questionId } = await service.ask({ text: "Being answered right now" });
    await expect(service.askAgain({ id: questionId })).rejects.toThrow("questions.errors.running");
    release();
    await service.idle();

    const done = storedQuestion();
    h.questions.set(done.id, done);
    const second = held();
    const again = make(h, second.consultation);
    const results = await Promise.allSettled([
      again.askAgain({ id: done.id }),
      again.askAgain({ id: done.id })
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    second.release();
    await again.idle();
  });

  it("refuses to ask again for a Question that does not exist or an id that is not one", async () => {
    const h = harness();
    const consultation = scripted(async () => Promise.reject(new Error("x")));
    const service = make(h, consultation);
    await expect(service.askAgain({ id: randomUUID() })).rejects.toThrow(
      "questions.errors.notFound"
    );
    await expect(service.askAgain({ id: "nope" })).rejects.toThrow();
    expect(consultation.ask).not.toHaveBeenCalled();
    expect(h.raw).toEqual([]);
  });
});
