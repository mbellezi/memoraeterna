import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StatementBudgetError, type PgPool } from "@app/db";
import { ConsultationInputSchema, ConsultationResultSchema } from "@app/domain";

import { ActiveDeadline, AiProviderError } from "@app/ai";
import {
  askRateLimitWait,
  askTimeoutMs,
  ConsultationService,
  rateLimitWaitMs
} from "./consultation-service.js";
import { consultationSnapshot } from "./consultation-fixture.js";

const mocks = vi.hoisted(() => ({
  retrieval: { candidates: vi.fn(), vector: vi.fn() },
  grounding: {
    scope: vi.fn(),
    topicMembers: vi.fn(),
    contexts: vi.fn(),
    relations: vi.fn(),
    relationDependencies: vi.fn(),
    validate: vi.fn()
  },
  /** Every wiki, organization, curator or investigation repository the database package offers. */
  legacy: { names: [] as string[], calls: [] as string[] },
  /** What the service handed the retrieval repository to run its statements on. */
  retrievalDb: null as { query(text: string): Promise<unknown> } | null
}));
vi.mock("@app/db", async (original) => {
  const db = await original<typeof import("@app/db")>();
  const legacy = Object.entries(db).filter(
    ([name, value]) =>
      /^create\w*(wiki|organization|curator|investigation)\w*$/i.test(name) &&
      typeof value === "function"
  );
  mocks.legacy.names = legacy.map(([name]) => name);
  return {
    ...db,
    ...Object.fromEntries(
      legacy.map(([name, factory]) => [
        name,
        (...args: unknown[]) => {
          mocks.legacy.calls.push(name);
          return (factory as (...a: unknown[]) => unknown)(...args);
        }
      ])
    ),
    createConsultationRepository: (db: typeof mocks.retrievalDb) => {
      mocks.retrievalDb = db;
      return mocks.retrieval;
    },
    createKnowledgeConsultationRepository: () => mocks.grounding
  };
});

const profile = consultationSnapshot().profile,
  sourceId = "00000000-0000-4000-8000-00000000000a",
  answer = {
    paragraphs: [
      { markdown: "Practice improved recall [e1].", citations: ["e1"], contextIds: [] as string[] }
    ],
    gaps: ["Long-term effects are not covered."]
  };
const row = (n: number) => ({
  chunkId: randomUUID(),
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
});
const modelAnswer = () => ({
  output: JSON.stringify(answer),
  aiTaskRunId: randomUUID(),
  inputTokens: 120,
  outputTokens: 30,
  costEstimate: 0.01
});
type ModelCall = (
  profile: unknown,
  prompt: string,
  context: unknown,
  signal: AbortSignal
) => Promise<unknown>;
function service(
  runOrganizationTask: Mock<ModelCall> = vi.fn(async () => modelAnswer()),
  pool = {} as PgPool
) {
  const ai = {
    pinOrganizationProfile: vi.fn(async () => profile),
    runOrganizationTask,
    runConsultationEmbedding: vi.fn(async () => null)
  };
  return {
    ai,
    service: new ConsultationService({
      getPool: () => pool,
      ai: ai as never,
      contentLanguage: async () => "en"
    })
  };
}
const request = (overrides: Record<string, unknown> = {}) =>
  ({
    requestId: randomUUID(),
    question: "Does retrieval practice help?",
    ...overrides
  }) as never;
/** A model call that never answers: it ends when its signal does. */
const hanging = (_profile: unknown, _prompt: unknown, _context: unknown, signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason))
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.grounding.scope.mockResolvedValue([sourceId]);
  mocks.grounding.contexts.mockResolvedValue([]);
  mocks.grounding.relations.mockResolvedValue([]);
  mocks.grounding.validate.mockResolvedValue(undefined);
  mocks.retrieval.candidates.mockResolvedValue([row(1), row(2)]);
  mocks.retrieval.vector.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("asking a question over notes and original passages", () => {
  it("answers with cited passages, discloses coverage and usage, and validates what it cites", async () => {
    const { ai, service: ask } = service();
    const input = request({ sourceIds: [sourceId], includeDescendants: true });
    const result = await ask.ask(input);
    expect(ConsultationResultSchema.safeParse(result).success).toBe(true);
    expect(result.id).toBe((input as { requestId: string }).requestId);
    expect(result.answer).toEqual(answer);
    expect(result.evidence.map((e) => e.handle)).toEqual(["e1", "e2"]);
    expect(result.scope).toEqual({
      sourceIds: [sourceId],
      includeDescendants: true,
      reviewedOnly: false
    });
    expect(result.coverage).toMatchObject({
      retrieved: 2,
      selected: 2,
      sourceCount: 1,
      limited: false,
      vector: "disabled",
      stale: false,
      signals: ["text"]
    });
    expect(result).toMatchObject({ inputTokens: 120, outputTokens: 30, costEstimate: 0.01 });
    expect(result.promptFingerprint).toMatch(/^[0-9a-f]{16,}$/);
    expect(mocks.grounding.scope).toHaveBeenCalledWith({
      sourceIds: [sourceId],
      includeDescendants: true
    });
    expect(mocks.grounding.validate).toHaveBeenCalled();
    const [, , context] = ai.runOrganizationTask.mock.calls[0]! as unknown as [
      unknown,
      unknown,
      Record<string, unknown>
    ];
    expect(context).toMatchObject({
      origin: "consultation",
      sourceItemIds: [sourceId],
      attempt: 1,
      promptVersion: "knowledge-consultation-v2"
    });
  });
  it("flags the answer as stale when its material changed while the model answered", async () => {
    const { service: ask } = service();
    mocks.grounding.validate.mockResolvedValueOnce(undefined);
    mocks.grounding.validate.mockRejectedValue(new Error("consultation.errors.evidence"));
    const result = await ask.ask(request());
    expect(result.coverage.stale).toBe(true);
    expect(result.answer).toEqual(answer);
  });
  it("asks again once after an answer that fails validation, and audits the second call as a repair (D35)", async () => {
    // JSON cut off in the middle, as the soak's malformed fault delivers it.
    const cutOff = { ...modelAnswer(), output: '{"paragraphs": [{"markdown": "The first passage' };
    const second = modelAnswer();
    const runOrganizationTask = vi.fn<ModelCall>().mockResolvedValueOnce(cutOff);
    runOrganizationTask.mockResolvedValueOnce(second);
    const { service: ask } = service(runOrganizationTask);
    const result = await ask.ask(request());
    expect(result.answer).toEqual(answer);
    expect(runOrganizationTask).toHaveBeenCalledTimes(2);
    const [first, repair] = runOrganizationTask.mock.calls.map(
      ([, , context]) => context as Record<string, unknown>
    );
    // The first call is no repair; the second is, whatever the audit's retry index says of an Ask.
    expect(first).toMatchObject({ attempt: 1, isRepair: false });
    expect(repair).toMatchObject({ attempt: 2, isRepair: true, origin: "consultation" });
    expect(runOrganizationTask.mock.calls[1]![1]).not.toBe(runOrganizationTask.mock.calls[0]![1]);
  });
  it("gives up with the invalid-answer error after one repair", async () => {
    const cutOff = () => ({ ...modelAnswer(), output: "not json at all" });
    const runOrganizationTask = vi.fn<ModelCall>(async () => cutOff());
    const { service: ask } = service(runOrganizationTask);
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.invalid");
    expect(runOrganizationTask).toHaveBeenCalledTimes(2);
  });
  it("sends the optional context and the relation between two cited passages to the model", async () => {
    const a = row(1),
      b = row(2);
    mocks.retrieval.candidates.mockResolvedValue([a, b]);
    const noteId = randomUUID();
    mocks.grounding.contexts.mockResolvedValue([
      {
        id: noteId,
        kind: "atomic_note",
        sourceItemId: sourceId,
        text: "Practice helps.",
        review: "active",
        fingerprint: "note",
        chunkIds: [a.chunkId],
        dependencies: [{ kind: "atomic_note", id: noteId, fingerprint: "note" }]
      }
    ]);
    const relationId = randomUUID();
    mocks.grounding.relations.mockResolvedValue([
      {
        id: relationId,
        evidenceId: randomUUID(),
        fingerprint: "relation",
        sourceItemId: sourceId,
        targetSourceItemId: sourceId,
        review: "accepted",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sourceIdea: "Practice",
        targetIdea: "Recall",
        explanation: "Practice supports recall.",
        sourceChunkId: a.chunkId,
        targetChunkId: b.chunkId
      }
    ]);
    mocks.grounding.relationDependencies.mockResolvedValue([
      { kind: "source_relation", id: relationId, fingerprint: "relation" }
    ]);
    const { ai, service: ask } = service();
    const result = await ask.ask(request());
    expect(result.contexts.map((c) => [c.id, c.handles])).toEqual([[noteId, ["e1"]]]);
    const prompt = ai.runOrganizationTask.mock.calls[0]![1] as unknown as string;
    expect(prompt).toContain("Practice helps.");
    expect(prompt).toContain("Practice supports recall.");
    expect(mocks.grounding.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        relations: [
          expect.objectContaining({ id: relationId, sourceHandle: "e1", targetHandle: "e2" })
        ]
      })
    );
  });
  it("answers from text alone when the semantic query embedding is unavailable", async () => {
    const { ai, service: ask } = service();
    ai.runConsultationEmbedding.mockRejectedValue(new Error("no embedding model"));
    const result = await ask.ask(request({ mode: "hybrid" }));
    expect(result.coverage.vector).toBe("unavailable");
    expect(result.answer).toEqual(answer);
  });
  it("names the reason when nothing relevant can be selected, without calling a model", async () => {
    const { ai, service: ask } = service();
    mocks.grounding.scope.mockResolvedValue([]);
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.noRelevantEvidence");
    mocks.grounding.scope.mockResolvedValue([sourceId]);
    mocks.retrieval.candidates.mockResolvedValue([{ ...row(1), text: 0 }]);
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.noRelevantEvidence");
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
  });
  it("reports the Ask error for an unavailable database and a missing model", async () => {
    const closed = new ConsultationService({
      getPool: () => null,
      ai: {} as never,
      contentLanguage: async () => "en"
    });
    await expect(closed.ask(request())).rejects.toThrow("consultation.errors.unavailable");
    const { ai, service: ask } = service();
    ai.pinOrganizationProfile.mockRejectedValue(new Error("organization.errors.model"));
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.model");
  });
  it("refuses a page or domain scope and a version it does not support", async () => {
    const { service: ask } = service();
    for (const scope of [{ pageId: randomUUID() }, { domainId: randomUUID() }, { version: "x" }])
      await expect(ask.ask(request(scope))).rejects.toThrow();
    expect(mocks.grounding.scope).not.toHaveBeenCalled();
  });
});

describe("asking about a topic", () => {
  const topicId = "00000000-0000-4000-8000-0000000000b1";
  beforeEach(() => {
    mocks.legacy.calls.length = 0;
    mocks.grounding.topicMembers.mockImplementation(async (_topic, items) => items);
  });
  it("limits the sources, passages, semantic hits and notes to the topic and reads no wiki repository", async () => {
    const a = row(1),
      b = row(2),
      noteId = randomUUID();
    mocks.retrieval.candidates.mockResolvedValue([a, b]);
    mocks.retrieval.vector.mockResolvedValue([{ id: a.chunkId, score: 0.9 }]);
    mocks.grounding.contexts.mockResolvedValue([
      {
        id: noteId,
        kind: "atomic_note",
        sourceItemId: sourceId,
        text: "Practice helps.",
        review: "active",
        fingerprint: "note",
        chunkIds: [a.chunkId],
        dependencies: [{ kind: "atomic_note", id: noteId, fingerprint: "note" }]
      }
    ]);
    const { ai, service: ask } = service();
    ai.runConsultationEmbedding.mockResolvedValue({
      output: [0.1, 0.2],
      modelId: "embedding-model",
      providerId: "embedding-provider",
      runtime: "test",
      embeddingSpaceKey: "space"
    } as never);
    const question = "Does retrieval practice help?";
    const result = await ask.ask(request({ topicId, mode: "hybrid" }));
    expect(result.scope).toEqual({
      sourceIds: [],
      topicId,
      includeDescendants: false,
      reviewedOnly: false
    });
    expect(result.coverage.vector).toBe("available");
    expect(result.evidence.map((e) => e.chunkId)).toEqual([a.chunkId, b.chunkId]);
    expect(result.contexts.map((c) => c.id)).toEqual([noteId]);
    expect(mocks.grounding.scope).toHaveBeenCalledWith(expect.objectContaining({ topicId }));
    expect(mocks.retrieval.vector).toHaveBeenCalledWith(
      [sourceId],
      expect.objectContaining({ spaceKey: "space" }),
      topicId
    );
    expect(mocks.retrieval.candidates).toHaveBeenCalledWith(
      [sourceId],
      question,
      false,
      [a.chunkId],
      topicId
    );
    expect(mocks.grounding.contexts).toHaveBeenCalledWith(
      [sourceId],
      [a.chunkId, b.chunkId],
      false,
      topicId
    );
    // What the answer cites is checked against the topic before the model runs and after it.
    expect(mocks.grounding.topicMembers).toHaveBeenCalledWith(topicId, {
      chunkIds: [a.chunkId, b.chunkId],
      noteIds: [noteId]
    });
    // The topic scope is not the source scope: the source check does not run for it.
    expect(mocks.grounding.scope).toHaveBeenCalledTimes(1);
    expect(mocks.legacy.names.length, "the spy covers the wiki repositories").toBeGreaterThan(0);
    expect(mocks.legacy.calls).toEqual([]);
  });
  it("leaves a library question on the source scope, without any topic check", async () => {
    const { service: ask } = service();
    await ask.ask(request());
    expect(mocks.grounding.topicMembers).not.toHaveBeenCalled();
    expect(mocks.retrieval.candidates.mock.calls[0]![4]).toBeNull();
    expect(mocks.grounding.contexts.mock.calls[0]![3]).toBeNull();
  });
  it("refuses an answer that would rest on a passage outside the topic, without calling a model", async () => {
    const { ai, service: ask } = service();
    mocks.grounding.topicMembers.mockResolvedValue({ chunkIds: [], noteIds: [] });
    await expect(ask.ask(request({ topicId }))).rejects.toThrow("consultation.errors.scope");
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
    expect(mocks.legacy.calls).toEqual([]);
  });
  it("flags the answer as stale when a note left the topic while the model answered", async () => {
    const { service: ask } = service();
    mocks.grounding.topicMembers.mockImplementationOnce(async (_topic, items) => items);
    mocks.grounding.topicMembers.mockResolvedValue({ chunkIds: [], noteIds: [] });
    const result = await ask.ask(request({ topicId }));
    expect(result.coverage.stale).toBe(true);
    expect(result.answer).toEqual(answer);
  });
  it("says the topic has nothing to answer from, without calling a model", async () => {
    const { ai, service: ask } = service();
    mocks.grounding.scope.mockResolvedValue([]);
    await expect(ask.ask(request({ topicId }))).rejects.toThrow(
      "consultation.errors.noTopicEvidence"
    );
    expect(mocks.retrieval.candidates).not.toHaveBeenCalled();
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
  });
  it("refuses a topic together with chosen sources", async () => {
    const { service: ask } = service();
    await expect(ask.ask(request({ topicId, sourceIds: [sourceId] }))).rejects.toThrow();
    expect(mocks.grounding.scope).not.toHaveBeenCalled();
  });
});

describe("canceling and the time limit", () => {
  it("cancels a running question and lets the same request be asked again", async () => {
    const task = vi.fn(async () => modelAnswer()).mockImplementationOnce(hanging as never);
    const { service: ask } = service(task);
    const input = request(),
      id = (input as { requestId: string }).requestId;
    const settled = expect(ask.ask(input)).rejects.toThrow("consultation.errors.canceled");
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    ask.cancel(id);
    await settled;
    await expect(ask.ask(input)).resolves.toMatchObject({ id });
  });
  it("refuses a second question with the id of one still running", async () => {
    const task = vi.fn(hanging);
    const { service: ask } = service(task);
    const input = request();
    const settled = expect(ask.ask(input)).rejects.toThrow("consultation.errors.canceled");
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    await expect(ask.ask(input)).rejects.toThrow("consultation.errors.wait");
    ask.cancel((input as { requestId: string }).requestId);
    await settled;
  });
  it("ends a question that works past its limit with the deadline error", async () => {
    vi.useFakeTimers();
    const task = vi.fn(hanging);
    const { service: ask } = service(task);
    const running = expect(ask.ask(request())).rejects.toThrow("consultation.errors.deadline");
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(askTimeoutMs + 1000);
    await running;
  });
  it("counts the time it works, not the time it waits behind other AI work", async () => {
    vi.useFakeTimers();
    const runOrganizationTask = vi.fn(
      async (_profile: unknown, _prompt: unknown, _context: unknown, signal: AbortSignal) => {
        // The call waits in the AI queue for longer than the limit before it runs.
        const deadline = ActiveDeadline.of(signal);
        expect(deadline, "the signal belongs to an active deadline").toBeDefined();
        deadline!.pause();
        await vi.advanceTimersByTimeAsync(askTimeoutMs * 3);
        expect(signal.aborted).toBe(false);
        deadline!.resume();
        return modelAnswer();
      }
    );
    const { service: ask } = service(runOrganizationTask);
    const result = await ask.ask(request());
    expect(result.answer).toEqual(answer);
    expect(runOrganizationTask).toHaveBeenCalledOnce();
  });
  it("stops preparing at the next step once the local work used the time up, and calls no model", async () => {
    vi.useFakeTimers();
    // The candidate search takes longer than the whole limit (a statement that ran on).
    mocks.retrieval.candidates.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(askTimeoutMs + 1000);
      return [row(1), row(2)];
    });
    const { ai, service: ask } = service();
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.deadline");
    expect(mocks.grounding.contexts).not.toHaveBeenCalled();
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
  });
  it("ends with the deadline error when the remaining time stopped a statement", async () => {
    mocks.retrieval.candidates.mockRejectedValue(new StatementBudgetError());
    const { ai, service: ask } = service();
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.deadline");
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
  });
  it("ends with the deadline error, not a stale answer, when the check after the answer ran out of time", async () => {
    const { ai, service: ask } = service();
    // The check before the model call passes; the one after the answer is stopped by the budget.
    mocks.grounding.validate.mockResolvedValueOnce(undefined);
    mocks.grounding.validate.mockRejectedValue(new StatementBudgetError());
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.deadline");
    expect(ai.runOrganizationTask).toHaveBeenCalledOnce();
    expect(mocks.grounding.validate).toHaveBeenCalledTimes(2);
  });
  it("ends with the deadline error when the semantic search ran out of time, and calls no model", async () => {
    const { ai, service: ask } = service();
    ai.runConsultationEmbedding.mockResolvedValue({
      output: [0.1, 0.2],
      modelId: "embedding-model",
      providerId: "embedding-provider",
      runtime: "test",
      embeddingSpaceKey: "space"
    } as never);
    mocks.retrieval.vector.mockRejectedValue(new StatementBudgetError());
    await expect(ask.ask(request({ mode: "hybrid" }))).rejects.toThrow(
      "consultation.errors.deadline"
    );
    expect(mocks.retrieval.vector).toHaveBeenCalledOnce();
    expect(mocks.retrieval.candidates).not.toHaveBeenCalled();
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
    // Any other failure of the semantic search only leaves the Ask on its text signals.
    mocks.retrieval.vector.mockRejectedValue(new Error("relation embeddings_768 does not exist"));
    const result = await ask.ask(request({ mode: "hybrid" }));
    expect(result.coverage.vector).toBe("unavailable");
    expect(ai.runOrganizationTask).toHaveBeenCalledOnce();
  });
  it("bounds each statement it prepares with by what is left of its time", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          sent.push(text);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      })
    } as unknown as PgPool;
    mocks.retrieval.candidates.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await mocks.retrievalDb!.query("select 'a candidate statement'");
      return [row(1), row(2)];
    });
    const { service: ask } = service(undefined, pool);
    const input = request();
    await ask.ask(input);
    // Each statement starts with the Ask's marker, which a cancel finds among the active backends.
    expect(sent).toEqual([
      `begin; set local statement_timeout = ${askTimeoutMs - 30_000}`,
      `/* ask:${(input as { requestId: string }).requestId} */ select 'a candidate statement'`,
      "commit"
    ]);
  });
  it("starts the budget of a preparation outside an Ask when its queries are built, not at the full limit", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          sent.push(text);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      })
    } as unknown as PgPool;
    let late: Promise<unknown> | undefined;
    mocks.retrieval.candidates.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
      await mocks.retrievalDb!.query("select 'a statement after 45 s'");
      await vi.advanceTimersByTimeAsync(askTimeoutMs);
      late = mocks.retrievalDb!.query("select 'a statement after the limit'");
      await late.catch(() => undefined);
      return [row(1), row(2)];
    });
    const { service: ask } = service(undefined, pool);
    // A plain signal: no active deadline stands behind it, so the service keeps the time itself.
    const prepared = ask.prepare(
      ConsultationInputSchema.parse({ requestId: randomUUID(), question: "Does practice help?" }),
      new AbortController().signal
    );
    await expect(prepared).resolves.toBeDefined();
    expect(sent).toEqual([
      `begin; set local statement_timeout = ${askTimeoutMs - 45_000}`,
      "select 'a statement after 45 s'",
      "commit"
    ]);
    // Once the limit passed, no statement starts at all.
    await expect(late).rejects.toBeInstanceOf(StatementBudgetError);
  });
  it("keeps the error of any other provider failure", async () => {
    const unavailable = new AiProviderError("AI provider request failed (503).", {
      kind: "http",
      transient: true,
      status: 503
    });
    const task = vi.fn<ModelCall>().mockRejectedValue(unavailable);
    const { service: ask } = service(task);
    await expect(ask.ask(request())).rejects.toBe(unavailable);
    expect(task).toHaveBeenCalledOnce();
  });
});

/** A rate limit (429) the adapter did not retry because its reset is past what it waits inline. */
const rateLimit = (retryAfterMs?: number) =>
  new AiProviderError("AI provider request failed (429).", {
    kind: "http",
    transient: true,
    status: 429,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  });

describe("the wait for a provider's rate limit (owner Q2)", () => {
  /** Lets the Ask run until `done` holds, without moving the fake clock. */
  async function until(done: () => boolean) {
    for (let step = 0; step < 500 && !done(); step++) await vi.advanceTimersByTimeAsync(0);
    expect(done()).toBe(true);
  }
  const statusesOf = () => {
    const seen: string[] = [];
    return { seen, onStatus: (status: string) => seen.push(status) };
  };

  it("waits once for a reset that fits, says so, and asks the provider again", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<ModelCall>()
      .mockRejectedValueOnce(rateLimit(8_000))
      .mockResolvedValue(modelAnswer());
    const { service: ask } = service(task);
    const { seen, onStatus } = statusesOf();
    const running = ask.ask(request(), { onStatus });
    await until(() => seen.length === 1);
    expect(seen).toEqual(["waitingForProvider"]);
    // It waits the whole reset and not a moment less.
    await vi.advanceTimersByTimeAsync(7_999);
    expect(task).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(result.answer).toEqual(answer);
    expect(seen).toEqual(["waitingForProvider", "answering"]);
    expect(task).toHaveBeenCalledTimes(2);
    // The failed call stays a failed call in the audit; the second is an ordinary call, no repair.
    const [first, second] = task.mock.calls.map(
      ([, , context]) => context as Record<string, unknown>
    );
    expect(first).toMatchObject({ attempt: 1, isRepair: false });
    expect(second).toMatchObject({ attempt: 1, isRepair: false, origin: "consultation" });
  });

  it("gives up with the rate-limit error when the second call is limited too", async () => {
    vi.useFakeTimers();
    const task = vi.fn<ModelCall>().mockRejectedValue(rateLimit(5_000));
    const { service: ask } = service(task);
    const { seen, onStatus } = statusesOf();
    const settled = expect(ask.ask(request(), { onStatus })).rejects.toThrow(
      "consultation.errors.rateLimited"
    );
    await until(() => seen.length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    // One wait for the whole Ask: no second wait, no third call.
    expect(task).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["waitingForProvider", "answering"]);
  });

  it("waits once for the whole Ask, even when an invalid answer asks for a repair", async () => {
    vi.useFakeTimers();
    const invalid = { ...modelAnswer(), output: "not json at all" };
    const task = vi
      .fn<ModelCall>()
      .mockRejectedValueOnce(rateLimit(2_000))
      .mockResolvedValueOnce(invalid)
      .mockRejectedValue(rateLimit(2_000));
    const { service: ask } = service(task);
    const { seen, onStatus } = statusesOf();
    const settled = expect(ask.ask(request(), { onStatus })).rejects.toThrow(
      "consultation.errors.rateLimited"
    );
    await until(() => seen.length === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(task).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["waitingForProvider", "answering"]);
    expect(task.mock.calls[2]![2]).toMatchObject({ attempt: 2, isRepair: true });
  });

  it("does not wait for a reset past 30 s, or for one the provider did not state", async () => {
    const task = vi.fn<ModelCall>().mockRejectedValue(rateLimit(askRateLimitWait.maxWaitMs + 1));
    const { service: ask } = service(task);
    const { seen, onStatus } = statusesOf();
    await expect(ask.ask(request(), { onStatus })).rejects.toThrow(
      "consultation.errors.rateLimited"
    );
    task.mockRejectedValue(rateLimit());
    await expect(ask.ask(request(), { onStatus })).rejects.toThrow(
      "consultation.errors.rateLimited"
    );
    expect(task).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([]);
  });

  it("waits for a reset of exactly 30 s while the Ask has time for it", async () => {
    vi.useFakeTimers();
    const task = vi
      .fn<ModelCall>()
      .mockRejectedValueOnce(rateLimit(askRateLimitWait.maxWaitMs))
      .mockResolvedValue(modelAnswer());
    const { service: ask } = service(task);
    const { seen, onStatus } = statusesOf();
    const running = ask.ask(request(), { onStatus });
    await until(() => seen.length === 1);
    await vi.advanceTimersByTimeAsync(askRateLimitWait.maxWaitMs);
    await expect(running).resolves.toMatchObject({ answer });
  });

  it("counts the wait in the Ask's time and keeps 15 s of it for the second call", async () => {
    vi.useFakeTimers();
    // The first call used `leftMs` less than the whole limit before the provider refused it.
    const refusedWithLeft = (leftMs: number) =>
      vi
        .fn<ModelCall>()
        .mockImplementationOnce(async () => {
          await vi.advanceTimersByTimeAsync(askTimeoutMs - leftMs);
          throw rateLimit(10_000);
        })
        .mockResolvedValue(modelAnswer());
    // 25 s left, 10 s to wait: exactly the 15 s reserve remain, so it waits.
    const fits = refusedWithLeft(25_000);
    const first = statusesOf();
    const running = service(fits).service.ask(request(), { onStatus: first.onStatus });
    await until(() => first.seen.length === 1);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(running).resolves.toMatchObject({ answer });
    expect(fits).toHaveBeenCalledTimes(2);
    // 24 s left, 10 s to wait: 14 s would remain, so the Ask ends at once as before.
    const tight = refusedWithLeft(24_000);
    const second = statusesOf();
    await expect(
      service(tight).service.ask(request(), { onStatus: second.onStatus })
    ).rejects.toThrow("consultation.errors.rateLimited");
    expect(tight).toHaveBeenCalledOnce();
    expect(second.seen).toEqual([]);
  });

  it("stops waiting the moment the person cancels", async () => {
    vi.useFakeTimers();
    const task = vi.fn<ModelCall>().mockRejectedValue(rateLimit(20_000));
    const { service: ask } = service(task);
    const { seen, onStatus } = statusesOf();
    const input = request();
    const settled = expect(ask.ask(input, { onStatus })).rejects.toThrow(
      "consultation.errors.canceled"
    );
    await until(() => seen.length === 1);
    await ask.cancel((input as { requestId: string }).requestId);
    await settled;
    expect(task).toHaveBeenCalledOnce();
    expect(seen).toEqual(["waitingForProvider"]);
  });

  it("decides from the failure and the time left alone", () => {
    const { maxWaitMs, reserveMs } = askRateLimitWait;
    expect(rateLimitWaitMs(rateLimit(8_000), 100_000)).toBe(8_000);
    expect(rateLimitWaitMs(rateLimit(0), 100_000)).toBe(0);
    expect(rateLimitWaitMs(rateLimit(maxWaitMs), 100_000)).toBe(maxWaitMs);
    expect(rateLimitWaitMs(rateLimit(maxWaitMs + 1), 100_000)).toBeNull();
    expect(rateLimitWaitMs(rateLimit(), 100_000)).toBeNull();
    // The wait must leave the reserve.
    expect(rateLimitWaitMs(rateLimit(10_000), 10_000 + reserveMs)).toBe(10_000);
    expect(rateLimitWaitMs(rateLimit(10_000), 10_000 + reserveMs - 1)).toBeNull();
    // An Ask without a clock of its own has no time to wait with.
    expect(rateLimitWaitMs(rateLimit(8_000), null)).toBeNull();
    // Not a rate limit: a server error, a plain error, an exhausted quota.
    const unavailable = new AiProviderError("AI provider request failed (503).", {
      kind: "http",
      transient: true,
      status: 503,
      retryAfterMs: 8_000
    });
    expect(rateLimitWaitMs(unavailable, 100_000)).toBeNull();
    expect(rateLimitWaitMs(new Error("boom"), 100_000)).toBeNull();
  });
});

/**
 * A pool whose client hangs on a marked statement until `stop` ends it with SQLSTATE 57014, the way
 * PostgreSQL ends a statement it was asked to cancel; its own `query` is the cancel's control
 * connection, which records the cancel and stops the statement.
 */
function hangingStatementPool() {
  const sent: string[] = [];
  let stop: (() => void) | undefined;
  const cancels = vi.fn<(text: string, values: unknown[]) => Promise<unknown>>(async () => {
    stop?.();
    return { rows: [{ canceled: true }] };
  });
  const pool = {
    connect: async () => ({
      query: (text: string) => {
        sent.push(text);
        if (!text.startsWith("/* ask:")) return Promise.resolve({ rows: [], rowCount: 0 });
        return new Promise<never>((_resolve, reject) => {
          stop = () =>
            reject(
              Object.assign(new Error("canceling statement due to user request"), {
                code: "57014"
              })
            );
        });
      },
      release: () => undefined
    }),
    query: cancels
  } as unknown as PgPool;
  return { pool, sent, cancels, stop: () => stop?.() };
}

describe("canceling a running statement", () => {
  const idOf = (input: unknown) => (input as { requestId: string }).requestId;
  const slowCandidates = () =>
    mocks.retrieval.candidates.mockImplementation(async () => {
      await mocks.retrievalDb!.query("select pg_sleep(30)");
      return [row(1), row(2)];
    });

  it("stops the statement in flight and ends the Ask as canceled, not as a timeout", async () => {
    const { pool, sent, cancels } = hangingStatementPool();
    slowCandidates();
    const { ai, service: ask } = service(undefined, pool);
    const input = request(),
      id = idOf(input);
    const settled = expect(ask.ask(input)).rejects.toThrow("consultation.errors.canceled");
    await vi.waitFor(() => expect(sent).toContain(`/* ask:${id} */ select pg_sleep(30)`));
    await expect(ask.cancel(id)).resolves.toBeNull();
    await settled;
    expect(cancels).toHaveBeenCalledWith(expect.stringContaining("pg_cancel_backend"), [
      `/* ask:${id} */`
    ]);
    // The cancelled statement was rolled back, and the Ask went no further.
    expect(sent.at(-1)).toBe("rollback");
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
    // The same request id can be asked again.
    mocks.retrieval.candidates.mockResolvedValue([row(1), row(2)]);
    await expect(ask.ask(input)).resolves.toMatchObject({ id });
  });

  it("ends as the deadline when the time budget stopped the statement", async () => {
    // PostgreSQL stopped it for its statement_timeout: the same SQLSTATE, with the Ask still live.
    const sent: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          sent.push(text);
          if (text.startsWith("/* ask:"))
            throw Object.assign(new Error("canceling statement due to statement timeout"), {
              code: "57014"
            });
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      })
    } as unknown as PgPool;
    slowCandidates();
    const { ai, service: ask } = service(undefined, pool);
    await expect(ask.ask(request())).rejects.toThrow("consultation.errors.deadline");
    expect(sent.at(-1)).toBe("rollback");
    expect(ai.runOrganizationTask).not.toHaveBeenCalled();
  });

  it("asks the database for nothing when no statement of the request is running", async () => {
    const { pool, cancels } = hangingStatementPool();
    const { service: ask } = service(undefined, pool);
    await expect(ask.cancel(randomUUID())).resolves.toBeNull();
    expect(cancels).not.toHaveBeenCalled();
    // And nothing happens without a database.
    const closed = new ConsultationService({
      getPool: () => null,
      ai: {} as never,
      contentLanguage: async () => "en"
    });
    await expect(closed.cancel(randomUUID())).resolves.toBeNull();
  });

  it("still ends the Ask as canceled when the cancel itself fails", async () => {
    const { pool, sent, stop } = hangingStatementPool();
    slowCandidates();
    const cancelActive = vi.fn(async () => {
      throw new Error("the control connection is gone");
    });
    const ask = new ConsultationService({
      getPool: () => pool,
      ai: {
        pinOrganizationProfile: vi.fn(async () => profile),
        runOrganizationTask: vi.fn(),
        runConsultationEmbedding: vi.fn(async () => null)
      } as never,
      contentLanguage: async () => "en",
      statementCanceler: () => ({ cancelActive, close: async () => undefined })
    });
    const input = request(),
      id = idOf(input);
    const settled = expect(ask.ask(input)).rejects.toThrow("consultation.errors.canceled");
    await vi.waitFor(() => expect(sent).toContain(`/* ask:${id} */ select pg_sleep(30)`));
    await expect(ask.cancel(id)).resolves.toBeNull();
    expect(cancelActive).toHaveBeenCalledWith(id);
    // The statement was not stopped; PostgreSQL ends it later at its own time limit, and the Ask,
    // which the person already gave up on, reports the cancel.
    stop();
    await settled;
  });
});
