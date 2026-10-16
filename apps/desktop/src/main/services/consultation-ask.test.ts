import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PgPool } from "@app/db";
import { ConsultationResultSchema } from "@app/domain";

import { ActiveDeadline } from "./ai-execution-queue.js";
import { askTimeoutMs, ConsultationService } from "./consultation-service.js";
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
  legacy: { names: [] as string[], calls: [] as string[] }
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
    createConsultationRepository: () => mocks.retrieval,
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
function service(runOrganizationTask: Mock<ModelCall> = vi.fn(async () => modelAnswer())) {
  const ai = {
    pinOrganizationProfile: vi.fn(async () => profile),
    runOrganizationTask,
    runConsultationEmbedding: vi.fn(async () => null)
  };
  return {
    ai,
    service: new ConsultationService({
      getPool: () => ({}) as PgPool,
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
});
