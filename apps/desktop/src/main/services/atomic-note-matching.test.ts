import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicNoteMatchingSettingsSchema } from "@app/domain";
import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import { KnowledgeService } from "./knowledge-service.js";
import { atomicNoteDecisionContentHash } from "./knowledge-processing.js";
import type { AiService } from "./ai-service.js";
import type { PgPool } from "@app/db";

const mocks = vi.hoisted(() => ({
  notes: {
    findById: vi.fn(),
    findTextMatchingCandidates: vi.fn(),
    findVectorMatchingCandidates: vi.fn(),
    scoreMatchingCandidates: vi.fn()
  },
  relations: { pairStatuses: vi.fn(), upsert: vi.fn() },
  decisions: { findVerdicts: vi.fn(), findReverseVerdicts: vi.fn(), record: vi.fn() },
  aiConfig: { getDefaultTask: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn(), listAtomicNoteElements: vi.fn() },
  embedding: { upsert: vi.fn(), findCurrentNoteVectors: vi.fn() },
  run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createAtomicNoteRelationRepository: () => mocks.relations,
  createRelationDecisionRepository: () => mocks.decisions,
  createAiConfigRepository: () => mocks.aiConfig,
  createKnowledgeGraphRepository: () => mocks.graph,
  createEmbeddingRepository: () => mocks.embedding
}));
const note = (id: string) => ({
  id,
  title: id,
  ideaStatement: `Idea ${id}`,
  bodyMarkdown: `Body ${id}`,
  metadata: {},
  createdFromSourceItemId: `source-${id}`,
  status: "pending_review"
});
const execution = (output: unknown, aiTaskRunId = "run") => ({
  output,
  profileId: "profile",
  modelId: "model",
  providerId: "provider",
  runtime: "remote",
  aiTaskRunId
});
const route = (modelId = "model") => ({
  profileId: "profile",
  provider: "provider",
  baseUrl: null,
  modelId,
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null,
  localModelId: null,
  requiredCapabilities: ["text-generation", "structured-output"],
  parameters: {},
  modelDefaultParameters: {}
});
/** One item of the decide-only contract: the candidate's number, a score 0-100 and the type. */
const result = (alias: number, score: number, relationType: string) => [alias, score, relationType];
function service(settings: unknown = {}) {
  return new KnowledgeService({
    getPool: () => ({}) as PgPool,
    aiService: { runDefaultTask: mocks.run } as unknown as AiService,
    userDataPath: "/tmp/test",
    getStorageSettings: async () => ({}) as never,
    getUploadedFilesBasePath: async () => null,
    getAtomicNoteMatchingSettings: async () => AtomicNoteMatchingSettingsSchema.parse(settings),
    relationThreshold: 0.6
  });
}
const rerankCalls = () => mocks.run.mock.calls.filter(([task]) => task === "reranking");
const respond = (...outputs: unknown[]) => {
  const queue = [...outputs];
  mocks.run.mockImplementation(async (task) =>
    task === "embedding"
      ? execution(Array.from({ length: 256 }, () => 0.1))
      : execution(queue.shift(), `run-${outputs.length - queue.length}`)
  );
};
const defaultVerdicts = {
  results: [result(1, 10, "supports"), result(2, 70, "supports"), result(3, 95, "extends")]
};
const embeddingResult = () => execution(Array.from({ length: 256 }, () => 0.1));
beforeEach(() => {
  vi.resetAllMocks();
  const candidates = ["a", "b", "c"].map((id) => ({
    note: note(id),
    textScore: 1,
    vectorScore: 1
  }));
  mocks.notes.findById.mockResolvedValue(note("source"));
  mocks.notes.findTextMatchingCandidates.mockResolvedValue(candidates);
  mocks.notes.findVectorMatchingCandidates.mockResolvedValue(candidates);
  mocks.notes.scoreMatchingCandidates.mockResolvedValue(candidates);
  mocks.graph.findAtomicNoteCandidates.mockResolvedValue([]);
  mocks.graph.listAtomicNoteElements.mockResolvedValue(new Map());
  mocks.relations.pairStatuses.mockResolvedValue(new Map());
  mocks.decisions.findVerdicts.mockResolvedValue(new Map());
  mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map());
  mocks.embedding.findCurrentNoteVectors.mockResolvedValue(new Map());
  mocks.aiConfig.getDefaultTask.mockResolvedValue(route());
  respond(defaultVerdicts);
});

describe("atomic note matching execution", () => {
  it("propagates candidate/output controls, blocks rejected pairs and caps by final score", async () => {
    const result = await service({
      textCandidateLimit: 9,
      vectorCandidateLimit: 8,
      graphCandidateLimit: 0,
      maxRelationsPerNote: 1,
      maxRerankOutputTokens: 1024
    }).matchAtomicNotes(["source"]);
    expect(mocks.notes.findTextMatchingCandidates).toHaveBeenCalledWith({
      noteId: "source",
      limit: 9
    });
    expect(mocks.notes.findVectorMatchingCandidates.mock.calls[0]![0].limit).toBe(8);
    expect(mocks.graph.findAtomicNoteCandidates).not.toHaveBeenCalled();
    expect(rerankCalls()).toHaveLength(1);
    expect(rerankCalls()[0]?.[4]).toEqual({ maxOutputTokens: 1024 });
    expect(result.persistedCount).toBe(1);
    expect(mocks.relations.upsert).toHaveBeenCalledOnce();
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        relationType: "extends",
        rerankScore: 0.95,
        // The decider writes no prose: the explanation is written later, on demand.
        explanation: "knowledge.relations.explanations.reranked"
      })
    );
  });

  it("records every model verdict per direction with the content hashes and decider", async () => {
    const completed: Array<[string, number]> = [];
    await service({ maxRelationsPerNote: 1 }).matchAtomicNotes(
      ["source"],
      undefined,
      undefined,
      {},
      { onNoteCompleted: (noteId, persisted) => void completed.push([noteId, persisted]) }
    );
    expect(mocks.decisions.findVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAtomicNoteId: "source",
        sourceContentHash: atomicNoteDecisionContentHash(note("source")),
        targets: ["a", "b", "c"].map((id) => ({
          atomicNoteId: id,
          contentHash: atomicNoteDecisionContentHash(note(id))
        }))
      })
    );
    const records = mocks.decisions.record.mock.calls.map(([record]) => record);
    expect(records.map((r) => [r.targetAtomicNoteId, r.score, r.relationType, r.accepted])).toEqual(
      [
        ["c", 0.95, "extends", true],
        // Qualifies but exceeds the per-note limit: recorded as not accepted.
        ["b", 0.7, "supports", false],
        ["a", 0.1, "supports", false]
      ]
    );
    expect(new Set(records.map((r) => r.deciderKey)).size).toBe(1);
    expect(
      records.every((r) => r.sourceAtomicNoteId === "source" && r.aiTaskRunId === "run-1")
    ).toBe(true);
    // Relations are written before the decisions that would let a retry skip them.
    expect(mocks.relations.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.decisions.record.mock.invocationCallOrder[0]!
    );
    expect(completed).toEqual([["source", 1]]);
  });

  it("builds the same rerank and repair prompts for the same notes under any UUID assignment", async () => {
    const rerankPrompts: string[] = [];
    const repairPrompts: string[] = [];
    for (const [alphaId, betaId, gammaId] of uuidAssignments(3).map(
      (ids) => ids as [string, string, string]
    )) {
      const alpha = { ...note(alphaId), title: "Alpha", ideaStatement: "Alpha idea" };
      const beta = { ...note(betaId), title: "Beta", ideaStatement: "Beta idea" };
      const gamma = { ...note(gammaId), title: "Gamma", ideaStatement: "Gamma idea" };
      const candidate = (n: typeof alpha, textScore: number, vectorScore: number) => ({
        note: n,
        textScore,
        vectorScore
      });
      // Beta and Alpha swap ranks between the text and vector lists, so their fused scores tie,
      // and the graph list holds Gamma. Only the note content can order the tie.
      mocks.notes.findTextMatchingCandidates.mockResolvedValue([
        candidate(beta, 1, 0),
        candidate(alpha, 1, 0)
      ]);
      mocks.notes.findVectorMatchingCandidates.mockResolvedValue([
        candidate(alpha, 0, 1),
        candidate(beta, 0, 1)
      ]);
      mocks.graph.findAtomicNoteCandidates.mockResolvedValue([
        {
          noteId: gamma.id,
          graphScore: 0.5,
          pathType: "shared_entity",
          contentKey: "Gamma\0Gamma idea"
        }
      ]);
      mocks.notes.scoreMatchingCandidates.mockImplementation(
        async ({ candidateIds }: { candidateIds: string[] }) =>
          candidateIds.map((id) => ({
            note: [alpha, beta, gamma].find((n) => n.id === id)!,
            textScore: 1,
            vectorScore: 1
          }))
      );
      mocks.run.mockImplementation(async (task, prompt: string) => {
        if (task === "embedding") return execution(Array.from({ length: 256 }, () => 0.1));
        if (!prompt.includes("Title: Alpha")) {
          repairPrompts.push(prompt);
          return execution({ results: [result(2, 10, "supports")] });
        }
        rerankPrompts.push(prompt);
        // c2 is missing, so a repair asks for it alone.
        return execution({ results: [1, 3].map((alias) => result(alias, 10, "supports")) });
      });
      await service({ graphCandidateLimit: 5 }).matchAtomicNotes(["source"]);
    }
    expect(rerankPrompts).toHaveLength(4);
    expect(new Set(rerankPrompts).size).toBe(1);
    const prompt = rerankPrompts[0]!;
    expect(prompt.indexOf("[1]\nTitle: Alpha")).toBeGreaterThan(-1);
    expect(prompt.indexOf("[2]\nTitle: Beta")).toBeGreaterThan(prompt.indexOf("[1]"));
    expect(prompt.indexOf("[3]\nTitle: Gamma")).toBeGreaterThan(prompt.indexOf("[2]"));
    expect(repairPrompts).toHaveLength(4);
    expect(new Set(repairPrompts).size).toBe(1);
    expect(repairPrompts[0]).toContain("[2]\nTitle: Beta");
    expect(repairPrompts[0]).not.toContain("Title: Alpha");
  });

  it("keeps valid items and asks once again only for the missing ones", async () => {
    respond(
      {
        results: [result(1, 10, "related"), result(3, 95, "extends")]
      },
      { results: [result(2, 70, "supports")] }
    );
    const matched = await service().matchAtomicNotes(["source"]);
    const [first, repair] = rerankCalls();
    expect(rerankCalls()).toHaveLength(2);
    expect(repair?.[1]).toContain("[2]\nTitle: b");
    expect(repair?.[1]).not.toContain("[1]");
    expect(repair?.[1]).not.toContain("[3]");
    expect(first?.[2]).toMatchObject({ operation: "note_matching_reranking", attempt: 0 });
    expect(repair?.[2]).toMatchObject({ operation: "note_matching_reranking_repair", attempt: 1 });
    expect(matched.persistedCount).toBe(2);
    expect(mocks.relations.upsert.mock.calls.map(([input]) => input.explanation)).toEqual([
      "knowledge.relations.explanations.reranked",
      "knowledge.relations.explanations.reranked"
    ]);
    expect(
      mocks.decisions.record.mock.calls.map(([r]) => [r.targetAtomicNoteId, r.aiTaskRunId])
    ).toEqual([
      ["c", "run-1"],
      ["b", "run-2"],
      ["a", "run-1"]
    ]);
  });

  it("treats an item that carries prose as malformed and asks for it once more", async () => {
    respond(
      {
        results: [
          result(1, 10, "related"),
          result(2, 20, "related"),
          [3, 95, "extends", "3 adds a further condition to the source."]
        ]
      },
      { results: [result(3, 90, "extends")] }
    );
    await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(2);
    expect(rerankCalls()[1]![1]).toContain("[3]\nTitle: c");
    expect(rerankCalls()[1]![1]).not.toContain("Title: a");
    expect(mocks.relations.upsert).toHaveBeenCalledOnce();
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        rerankScore: 0.9,
        explanation: "knowledge.relations.explanations.reranked"
      })
    );
  });

  it("leaves candidates undecided, unlinked and unrecorded when the output and its repair are invalid and reranking is optional", async () => {
    respond({ results: [] }, "not json");
    const completed: string[] = [];
    const matched = await service({
      requireReranking: false,
      // An undecided pair has the weak type "related".
      includeWeakTypes: true
    }).matchAtomicNotes(
      ["source"],
      undefined,
      undefined,
      {},
      {
        onNoteCompleted: (noteId) => void completed.push(noteId)
      }
    );
    expect(rerankCalls()).toHaveLength(2);
    // Without a required decider the hybrid score stands in, and nothing is recorded as decided.
    expect(matched.persistedCount).toBe(3);
    expect(
      mocks.relations.upsert.mock.calls.map(([input]) => input.metadata.decisionSource)
    ).toEqual(["undecided", "undecided", "undecided"]);
    expect(mocks.relations.upsert.mock.calls.map(([input]) => input.matchingModel)).toEqual([
      null,
      null,
      null
    ]);
    expect(mocks.decisions.record).not.toHaveBeenCalled();
    expect(completed).toEqual(["source"]);
  });

  it("fails visibly, before the checkpoint, when a required decision has two invalid outputs", async () => {
    const completed: string[] = [];
    const onNoteCompleted = (noteId: string) => void completed.push(noteId);
    for (const outputs of [
      [{ results: [] }, "not json"],
      ["not json", { results: [] }]
    ]) {
      respond(...outputs);
      const failure = await service()
        .matchAtomicNotes(["source"], undefined, undefined, {}, { onNoteCompleted })
        .catch((error: unknown) => error);
      expect((failure as Error).message).toBe("errors.matching.rerankingFailed");
      expect(rerankCalls()).toHaveLength(2);
      mocks.run.mockClear();
    }
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
    expect(mocks.decisions.record).not.toHaveBeenCalled();
    expect(completed).toEqual([]);
  });

  it("fails visibly, before the checkpoint, when the repair of a required decision throws or returns nothing", async () => {
    const completed: string[] = [];
    const onNoteCompleted = (noteId: string) => void completed.push(noteId);
    // c2 is missing from the first answer, so a repair asks for it alone.
    const firstAnswer = {
      results: [result(1, 10, "related"), result(3, 95, "extends")]
    };
    const timeout = new Error("provider_timeout");
    for (const [repairOutcome, cause] of [
      [() => Promise.reject(timeout), timeout],
      [() => Promise.resolve(null), undefined]
    ] as const) {
      mocks.run.mockImplementation(async (task, _prompt, context: { attempt?: number }) =>
        task === "embedding"
          ? embeddingResult()
          : context.attempt === 1
            ? repairOutcome()
            : execution(firstAnswer)
      );
      const failure = await service()
        .matchAtomicNotes(["source"], undefined, undefined, {}, { onNoteCompleted })
        .catch((error: unknown) => error);
      expect((failure as Error).message).toBe("errors.matching.rerankingFailed");
      // The repair error stays the cause, so the supervisor can still classify it as transient.
      expect((failure as Error).cause).toBe(cause);
      expect(rerankCalls()).toHaveLength(2);
      mocks.run.mockClear();
    }
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
    expect(mocks.decisions.record).not.toHaveBeenCalled();
    expect(completed).toEqual([]);
  });

  it("keeps the decided items when nothing needs a repair, or a failed repair with optional reranking", async () => {
    const throwingRepair = (firstAnswer: unknown) =>
      mocks.run.mockImplementation(async (task, _prompt, context: { attempt?: number }) => {
        if (task === "embedding") return embeddingResult();
        if (context.attempt === 1) throw new Error("provider_timeout");
        return execution(firstAnswer);
      });
    // Every item is valid: nothing is repaired, and the accepted pair keeps the fallback text.
    throwingRepair({
      results: [result(1, 10, "related"), result(2, 20, "related"), result(3, 95, "extends")]
    });
    const matched = await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(1);
    expect(matched.persistedCount).toBe(1);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        explanation: "knowledge.relations.explanations.reranked"
      })
    );

    // With optional reranking an undecided item stays undecided and the decided ones are kept.
    vi.clearAllMocks();
    throwingRepair({
      results: [result(1, 10, "related"), result(3, 95, "extends")]
    });
    const optional = await service({
      requireReranking: false,
      includeWeakTypes: true
    }).matchAtomicNotes(["source"]);
    expect(optional.persistedCount).toBe(2);
    expect(
      mocks.relations.upsert.mock.calls.map(([input]) => [
        input.targetAtomicNoteId,
        input.metadata.decisionSource
      ])
    ).toEqual([
      ["c", "model"],
      ["b", "undecided"]
    ]);
    expect(mocks.decisions.record.mock.calls.map(([r]) => r.targetAtomicNoteId).sort()).toEqual([
      "a",
      "c"
    ]);
  });

  it("asks for no repair of a valid verdict, whatever its score or type", async () => {
    for (const settings of [{}, { includeWeakTypes: true }]) {
      vi.clearAllMocks();
      respond({
        results: [result(1, 10, "related"), result(2, 20, "related"), result(3, 90, "mentions")]
      });
      await service(settings).matchAtomicNotes(["source"]);
      expect(rerankCalls()).toHaveLength(1);
      expect(mocks.decisions.record).toHaveBeenCalledTimes(3);
    }
    // A weak type is refused with the default settings, whatever the score.
    vi.clearAllMocks();
    respond({
      results: [result(1, 10, "related"), result(2, 20, "related"), result(3, 90, "mentions")]
    });
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
  });

  it("keeps the prompt and the decider key independent of the relation calibration", async () => {
    const prompts: string[] = [];
    const keys: string[] = [];
    for (const minRerankScore of [0.4, 0.65, 0.9]) {
      mocks.run.mockClear();
      mocks.decisions.findVerdicts.mockClear();
      respond(defaultVerdicts);
      await service({ minRerankScore }).matchAtomicNotes(["source"]);
      prompts.push(rerankCalls()[0]![1] as string);
      keys.push(mocks.decisions.findVerdicts.mock.calls[0]![0].deciderKey);
    }
    expect(new Set(prompts).size).toBe(1);
    expect(new Set(keys).size).toBe(1);
    expect(prompts[0]).toContain("The score is an integer from 0 to 100");
    expect(prompts[0]).not.toContain("explanation_min_score");
  });

  it("runs the decision with reasoning off by default and identifies the decider by that", async () => {
    const run = async (parameters: Record<string, unknown>) => {
      mocks.aiConfig.getDefaultTask.mockResolvedValue({ ...route(), parameters });
      mocks.run.mockClear();
      mocks.decisions.findVerdicts.mockClear();
      respond(defaultVerdicts);
      await service().matchAtomicNotes(["source"]);
      expect(rerankCalls()[0]![2]).toMatchObject({ operation: "note_matching_reranking" });
      return mocks.decisions.findVerdicts.mock.calls[0]![0].deciderKey as string;
    };
    const byDefault = await run({});
    // The default is part of the effective parameters, so spelling it out changes nothing...
    expect(await run({ reasoningLevel: "off" })).toBe(byDefault);
    // ...and asking for more reasoning is another decider.
    expect(await run({ reasoningLevel: "high" })).not.toBe(byDefault);
  });

  it("fails visibly when the required reranking call itself fails or has no model", async () => {
    mocks.run.mockImplementation(async (task) => {
      if (task === "embedding") return null;
      throw new Error("provider_unavailable");
    });
    const failure = await service()
      .matchAtomicNotes(["source"])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("errors.matching.rerankingFailed");
    // The provider error stays as the cause, so the supervisor can still classify it as transient.
    expect(((failure as Error).cause as Error).message).toBe("provider_unavailable");
    mocks.run.mockResolvedValue(null);
    await expect(service().matchAtomicNotes(["source"])).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
  });

  it("drops infeasible candidates before the call and skips a call with nothing left", async () => {
    const weak = (id: string) => ({ note: note(id), textScore: 0, vectorScore: 0 });
    mocks.notes.scoreMatchingCandidates.mockResolvedValue([
      weak("a"),
      { note: note("b"), textScore: 1, vectorScore: 1 },
      weak("c")
    ]);
    await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(1);
    const prompt = rerankCalls()[0]![1] as string;
    expect(prompt).toContain("[1]\nTitle: b");
    expect(prompt).not.toContain("[2]");
    expect(mocks.decisions.findVerdicts.mock.calls[0]![0].targets).toEqual([
      { atomicNoteId: "b", contentHash: atomicNoteDecisionContentHash(note("b")) }
    ]);

    vi.clearAllMocks();
    mocks.notes.scoreMatchingCandidates.mockResolvedValue(["a", "b", "c"].map(weak));
    // Nothing can qualify: no call, and requireReranking has nothing to fail on.
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(rerankCalls()).toHaveLength(0);
    expect(mocks.decisions.findVerdicts).not.toHaveBeenCalled();
  });

  it("answers cached directions from the decision cache and asks only for the rest", async () => {
    mocks.decisions.findVerdicts.mockResolvedValue(
      new Map([["c", { score: 0.95, relationType: "extends" }]])
    );
    respond({
      results: [result(1, 10, "related"), result(2, 20, "related"), result(3, 100, "supports")]
    });
    const matched = await service().matchAtomicNotes(["source"]);
    const prompt = rerankCalls()[0]![1] as string;
    expect(prompt).toContain("[1]\nTitle: a");
    expect(prompt).toContain("[2]\nTitle: b");
    expect(prompt).not.toContain("Title: c");
    expect(matched.persistedCount).toBe(1);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        relationType: "extends",
        rerankScore: 0.95,
        explanation: "knowledge.relations.explanations.reranked",
        matchingModel: "model",
        metadata: expect.objectContaining({ decisionSource: "cache" })
      })
    );
    expect(mocks.decisions.record.mock.calls.map(([r]) => r.targetAtomicNoteId).sort()).toEqual([
      "a",
      "b"
    ]);
  });

  it("makes no call when every feasible direction is cached", async () => {
    mocks.decisions.findVerdicts.mockResolvedValue(
      new Map(["a", "b", "c"].map((id) => [id, { score: 0.1, relationType: "related" }]))
    );
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(rerankCalls()).toHaveLength(0);
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });

  it("never asks about human-reviewed pairs and leaves existing relations unchanged", async () => {
    mocks.relations.pairStatuses.mockResolvedValue(
      new Map([
        ["a", "accepted"],
        ["b", "rejected"],
        ["c", "rejected"]
      ])
    );
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(rerankCalls()).toHaveLength(0);
    expect(mocks.relations.upsert).not.toHaveBeenCalled();

    // An automatic relation in the other direction does not stop this direction's decision.
    vi.clearAllMocks();
    mocks.relations.pairStatuses.mockResolvedValue(new Map([["c", "pending_review"]]));
    const matched = await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(1);
    expect(rerankCalls()[0]![1]).toContain("Title: c");
    expect(matched.persistedCount).toBe(1);
    expect(mocks.relations.upsert.mock.calls.map(([input]) => input.targetAtomicNoteId)).toEqual([
      "b"
    ]);
    expect(
      mocks.decisions.record.mock.calls.find(([r]) => r.targetAtomicNoteId === "c")?.[0]
    ).toMatchObject({ accepted: true, score: 0.95 });
  });

  it("records nothing when the reranking route changes during the call", async () => {
    mocks.aiConfig.getDefaultTask
      .mockResolvedValueOnce(route("model"))
      .mockResolvedValueOnce(route("another-model"));
    await service().matchAtomicNotes(["source"]);
    expect(mocks.relations.upsert).toHaveBeenCalled();
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });

  it("keeps the provenance of cached verdicts when the route changes during the call", async () => {
    mocks.aiConfig.getDefaultTask
      .mockResolvedValueOnce(route("model"))
      .mockResolvedValueOnce(route("another-model"));
    mocks.decisions.findVerdicts.mockResolvedValue(
      new Map([["c", { score: 0.95, relationType: "extends" }]])
    );
    respond({ results: [result(1, 10, "related"), result(2, 20, "related")] });
    await service().matchAtomicNotes(["source"]);
    // The cached verdict belongs to the decider it was looked up under, not to the new route.
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        matchingModel: "model",
        metadata: expect.objectContaining({ decisionSource: "cache" })
      })
    );
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });

  it("resolves the decider again for every note, so a route that appears later is used from then on", async () => {
    // The first note finds no route (it is seeded by its own call); the second finds it.
    mocks.aiConfig.getDefaultTask
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(route());
    respond(defaultVerdicts, defaultVerdicts);
    await service().matchAtomicNotes(["source", "second"]);
    expect(rerankCalls()).toHaveLength(2);
    expect(mocks.decisions.findVerdicts).toHaveBeenCalledOnce();
    expect(mocks.decisions.record).toHaveBeenCalledTimes(3);
  });

  it("matches without the cache when no decider identity can be resolved", async () => {
    mocks.aiConfig.getDefaultTask.mockRejectedValue(new Error("database_unavailable"));
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(2);
    expect(mocks.decisions.findVerdicts).not.toHaveBeenCalled();
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });
});

describe("note embeddings in matching", () => {
  const vector = (seed = 0.1) => Array.from({ length: 256 }, () => seed);
  const storedVector = (embedding = vector(0.2)) => ({
    embedding,
    model: "stored-model",
    provider: "stored-provider",
    runtime: "local",
    strategy: "native-v2:stored-space"
  });
  const embeddingCalls = () => mocks.run.mock.calls.filter(([task]) => task === "embedding");
  const embeddedNoteIds = () =>
    embeddingCalls().map(([, , context]) => (context as { atomicNoteId: string }).atomicNoteId);

  it("embeds every note of the batch that has no vector before the first retrieval, one call each", async () => {
    mocks.notes.findById.mockImplementation(async (id: string) => note(id));
    respond(defaultVerdicts, defaultVerdicts, defaultVerdicts);
    await service().matchAtomicNotes(["n1", "n2", "n3"]);
    expect(embeddedNoteIds()).toEqual(["n1", "n2", "n3"]);
    expect(
      embeddingCalls().every(
        ([, , context]) =>
          (context as { operation: string }).operation === "note_matching_embedding"
      )
    ).toBe(true);
    // One lookup for the whole batch, and all the embedding is done before any note is retrieved:
    // no note is matched while a later note of the batch is still without a vector.
    expect(mocks.embedding.findCurrentNoteVectors).toHaveBeenCalledOnce();
    expect(
      mocks.embedding.findCurrentNoteVectors.mock.calls[0]![0].map((n: { id: string }) => n.id)
    ).toEqual(["n1", "n2", "n3"]);
    const lastEmbedding = Math.max(
      ...mocks.run.mock.calls.flatMap(([task], index) =>
        task === "embedding" ? [mocks.run.mock.invocationCallOrder[index]!] : []
      )
    );
    expect(lastEmbedding).toBeLessThan(
      mocks.notes.findTextMatchingCandidates.mock.invocationCallOrder[0]!
    );
    expect(mocks.embedding.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.embedding.upsert.mock.calls[0]![0]).toMatchObject({
      targetType: "atomic_note",
      targetId: "n1",
      usage: "matching"
    });
  });

  it("reuses the stored vector of a note instead of embedding it again, and retrieves in its space", async () => {
    mocks.embedding.findCurrentNoteVectors.mockResolvedValue(
      new Map([["source", { targetId: "source", ...storedVector() }]])
    );
    await service().matchAtomicNotes(["source"]);
    expect(embeddingCalls()).toHaveLength(0);
    expect(mocks.embedding.upsert).not.toHaveBeenCalled();
    const space = {
      embedding: vector(0.2),
      embeddingModel: "stored-model",
      embeddingSpaceKey: "stored-space",
      embeddingProvider: "stored-provider",
      embeddingRuntime: "local"
    };
    expect(mocks.notes.findVectorMatchingCandidates).toHaveBeenCalledWith(
      expect.objectContaining(space)
    );
    expect(mocks.notes.scoreMatchingCandidates).toHaveBeenCalledWith(
      expect.objectContaining(space)
    );
    expect(rerankCalls()).toHaveLength(1);
  });

  it("embeds a candidate that has no vector before scoring it, so a later note is retrieved and feasible", async () => {
    const withVector = (id: string) => ({
      note: note(id),
      textScore: 1,
      vectorScore: 1,
      hasVector: true
    });
    // "c" is a note created after "source" was matched: text finds it, the vector join does not.
    let scorings = 0;
    mocks.notes.scoreMatchingCandidates.mockImplementation(async () => {
      scorings += 1;
      return [
        withVector("a"),
        withVector("b"),
        scorings === 1
          ? { note: note("c"), textScore: 0.5, vectorScore: 0, hasVector: false }
          : { note: note("c"), textScore: 0.5, vectorScore: 0.9, hasVector: true }
      ];
    });
    respond({
      results: [result(1, 10, "related"), result(2, 10, "related"), result(3, 90, "extends")]
    });
    const matched = await service().matchAtomicNotes(["source"]);
    expect(scorings).toBe(2);
    expect(embeddedNoteIds()).toEqual(["source", "c"]);
    expect(rerankCalls()[0]![1]).toContain("Title: c");
    expect(matched.persistedCount).toBe(1);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        vectorScore: 0.9,
        metadata: expect.objectContaining({ decisionSource: "model" })
      })
    );
  });

  it("never scores a candidate that still has no vector as a vector score of 0", async () => {
    // Text 0.9 and no vector. As a vector score of 0 under the vector weights its best case is
    // 0.562 < 0.6, so it would be dropped before the decider; without vector weights it is not.
    mocks.notes.scoreMatchingCandidates.mockResolvedValue([
      { note: note("c"), textScore: 0.9, vectorScore: 0, hasVector: false }
    ]);
    mocks.run.mockImplementation(async (task, _prompt, context: { atomicNoteId?: string }) =>
      task === "embedding"
        ? context.atomicNoteId === "c"
          ? null
          : embeddingResult()
        : execution({ results: [result(1, 90, "extends")] })
    );
    const matched = await service().matchAtomicNotes(["source", "second"]);
    expect(rerankCalls()).toHaveLength(2);
    expect(rerankCalls()[0]![1]).toContain("Title: c");
    expect(matched.persistedCount).toBe(2);
    // textAndMetadata weights: base 0.7 * 0.9 = 0.63, final 0.63 * 0.6 + 0.9 * 0.4.
    expect(mocks.relations.upsert.mock.calls[0]![0].finalScore).toBeCloseTo(0.738, 3);
    // Nothing could embed it, and it is tried once per run, not once per note.
    expect(embeddedNoteIds().filter((id) => id === "c")).toEqual(["c"]);
    expect(mocks.notes.scoreMatchingCandidates).toHaveBeenCalledTimes(2);
  });

  it("leaves a low real vector score alone: only an unknown vector score changes the weights", async () => {
    mocks.notes.scoreMatchingCandidates.mockResolvedValue(
      ["a", "b", "c"].map((id) => ({
        note: note(id),
        textScore: 0.42,
        vectorScore: 0.42,
        hasVector: true
      }))
    );
    respond({ results: [1, 2, 3].map((alias) => result(alias, 90, "supports")) });
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(rerankCalls()).toHaveLength(1);
    expect(embeddedNoteIds()).toEqual(["source"]);
  });
});

describe("one decision per unordered pair with a generative decider", () => {
  const reverse = { score: 0.95, relationType: "extends" };

  it("answers a direction from the verdict of the reverse direction and asks only for the rest", async () => {
    mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map([["c", reverse]]));
    respond({ results: [result(1, 10, "related"), result(2, 20, "related")] });
    const matched = await service().matchAtomicNotes(["source"]);
    const prompt = rerankCalls()[0]![1] as string;
    expect(prompt).toContain("[1]\nTitle: a");
    expect(prompt).toContain("[2]\nTitle: b");
    expect(prompt).not.toContain("Title: c");
    expect(mocks.decisions.findReverseVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAtomicNoteId: "source",
        sourceContentHash: atomicNoteDecisionContentHash(note("source")),
        deciderKey: mocks.decisions.findVerdicts.mock.calls[0]![0].deciderKey,
        targets: ["a", "b", "c"].map((id) => ({
          atomicNoteId: id,
          contentHash: atomicNoteDecisionContentHash(note(id))
        }))
      })
    );
    expect(matched.persistedCount).toBe(1);
    // The type belongs to the direction it was judged in: candidate -> this note.
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAtomicNoteId: "source",
        targetAtomicNoteId: "c",
        relationType: "extends",
        rerankScore: 0.95,
        explanation: "knowledge.relations.explanations.reranked",
        matchingModel: "model",
        metadata: expect.objectContaining({
          decisionSource: "reverse_cache",
          semanticSourceAtomicNoteId: "c",
          semanticTargetAtomicNoteId: "source"
        })
      })
    );
    // A reused verdict is not a judgment of this direction: no row is written for it.
    expect(mocks.decisions.record.mock.calls.map(([r]) => r.targetAtomicNoteId).sort()).toEqual([
      "a",
      "b"
    ]);
  });

  it("keeps the semantic direction of a verdict that was judged in this direction", async () => {
    await service().matchAtomicNotes(["source"]);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        metadata: expect.objectContaining({
          decisionSource: "model",
          semanticSourceAtomicNoteId: "source",
          semanticTargetAtomicNoteId: "c"
        })
      })
    );
  });

  it("prefers a verdict judged in this direction and does not look up the reverse of it", async () => {
    mocks.decisions.findVerdicts.mockResolvedValue(
      new Map([["c", { score: 0.9, relationType: "supports" }]])
    );
    mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map([["c", reverse]]));
    respond({ results: [result(1, 10, "related"), result(2, 20, "related")] });
    await service().matchAtomicNotes(["source"]);
    expect(
      mocks.decisions.findReverseVerdicts.mock.calls[0]![0].targets.map(
        (t: { atomicNoteId: string }) => t.atomicNoteId
      )
    ).toEqual(["a", "b"]);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAtomicNoteId: "c",
        relationType: "supports",
        metadata: expect.objectContaining({ decisionSource: "cache" })
      })
    );
  });

  it("makes no call when every feasible direction is answered by either direction", async () => {
    mocks.decisions.findVerdicts.mockResolvedValue(
      new Map([["a", { score: 0.1, relationType: "related" }]])
    );
    mocks.decisions.findReverseVerdicts.mockResolvedValue(
      new Map([
        ["b", { score: 0.2, relationType: "related" }],
        ["c", reverse]
      ])
    );
    const matched = await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(0);
    expect(matched.persistedCount).toBe(1);
    expect(mocks.decisions.record).not.toHaveBeenCalled();
  });

  it("ignores a reverse verdict whose type is not in the vocabulary", async () => {
    mocks.decisions.findReverseVerdicts.mockResolvedValue(
      new Map([["c", { score: 0.95, relationType: "invented" }]])
    );
    await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()[0]![1]).toContain("Title: c");
  });

  it("scores each direction itself when the decider is a dedicated reranker", async () => {
    mocks.aiConfig.getDefaultTask.mockResolvedValue({
      ...route(),
      requiredCapabilities: ["reranking"]
    });
    mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map([["c", reverse]]));
    await service().matchAtomicNotes(["source"]);
    expect(mocks.decisions.findReverseVerdicts).not.toHaveBeenCalled();
    expect(rerankCalls()[0]![1]).toContain("Title: c");
  });

  it("treats a generative model with a legacy reranking tag as a generative decider", async () => {
    mocks.aiConfig.getDefaultTask.mockResolvedValue({
      ...route(),
      requiredCapabilities: ["text-generation", "structured-output", "reranking"]
    });
    mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map([["c", reverse]]));
    await service().matchAtomicNotes(["source"]);
    expect(mocks.decisions.findReverseVerdicts).toHaveBeenCalled();
    expect(rerankCalls().every((call) => !String(call[1]).includes("Title: c"))).toBe(true);
  });

  it("does not reuse anything without a decider identity", async () => {
    mocks.aiConfig.getDefaultTask.mockRejectedValue(new Error("database_unavailable"));
    await service().matchAtomicNotes(["source"]);
    expect(mocks.decisions.findReverseVerdicts).not.toHaveBeenCalled();
  });

  it("judges a pair of one batch once: the second note reuses what the first one decided", async () => {
    type Verdict = { score: number; relationType: string };
    const judged = new Map<string, Verdict>();
    const related = new Set<string>();
    const pairOf = (left: string, right: string) => [left, right].sort().join(">");
    mocks.notes.findById.mockImplementation(async (id: string) => note(id));
    // Each note finds the other one and finds it feasible: before this, the later note was
    // invisible to the earlier one and nothing connected the two directions.
    const other = (id: string) => (id === "s1" ? "s2" : "s1");
    const candidateOf = ({ noteId }: { noteId: string }) => [
      { note: note(other(noteId)), textScore: 1, vectorScore: 1, hasVector: true }
    ];
    mocks.notes.findTextMatchingCandidates.mockImplementation(async (input) => candidateOf(input));
    mocks.notes.findVectorMatchingCandidates.mockImplementation(async (input) =>
      candidateOf(input)
    );
    mocks.notes.scoreMatchingCandidates.mockImplementation(async (input) => candidateOf(input));
    mocks.decisions.record.mockImplementation(
      async (r: { sourceAtomicNoteId: string; targetAtomicNoteId: string } & Verdict) => {
        judged.set(`${r.sourceAtomicNoteId}>${r.targetAtomicNoteId}`, {
          score: r.score,
          relationType: r.relationType
        });
      }
    );
    mocks.decisions.findReverseVerdicts.mockImplementation(
      async (input: { sourceAtomicNoteId: string; targets: Array<{ atomicNoteId: string }> }) =>
        new Map(
          input.targets.flatMap(({ atomicNoteId }) => {
            const verdict = judged.get(`${atomicNoteId}>${input.sourceAtomicNoteId}`);
            return verdict ? [[atomicNoteId, verdict] as const] : [];
          })
        )
    );
    mocks.relations.upsert.mockImplementation(
      async (r: { sourceAtomicNoteId: string; targetAtomicNoteId: string }) =>
        void related.add(pairOf(r.sourceAtomicNoteId, r.targetAtomicNoteId))
    );
    mocks.relations.pairStatuses.mockImplementation(
      async (noteId: string, ids: string[]) =>
        new Map(
          ids
            .filter((id) => related.has(pairOf(noteId, id)))
            .map((id) => [id, "pending_review"] as const)
        )
    );
    respond({ results: [result(1, 90, "supports")] });
    const matched = await service().matchAtomicNotes(["s1", "s2"]);
    expect(rerankCalls()).toHaveLength(1);
    expect(matched.persistedCount).toBe(1);
    expect([...judged.keys()]).toEqual(["s1>s2"]);
    // The second note found the relation the first one made and left it as it is.
    expect(mocks.relations.upsert).toHaveBeenCalledOnce();
  });
});
