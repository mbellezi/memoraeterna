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
  decisions: { findVerdicts: vi.fn(), record: vi.fn() },
  aiConfig: { getDefaultTask: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn(), listAtomicNoteElements: vi.fn() },
  embedding: { upsert: vi.fn() },
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
  parameters: {},
  modelDefaultParameters: {}
});
const result = (
  candidateAlias: string,
  score: number,
  relationType: string,
  explanation?: string
) =>
  explanation === undefined
    ? { candidateAlias, score, relationType }
    : { candidateAlias, score, relationType, explanation };
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
  results: [
    // A rejected candidate's prose is ignored, even when it names another candidate.
    result("c1", 0.1, "supports", "Unlike c3, the candidate supplies only weak support."),
    result("c2", 0.7, "supports", "c2 reinforces the central claim of s1."),
    result("c3", 0.95, "extends", "c3 adds a further condition to s1.")
  ]
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
        explanation: '<note-ref id="c" /> adds a further condition to <note-ref id="source" />.'
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
          return execution({ results: [result("c2", 0.1, "supports")] });
        }
        rerankPrompts.push(prompt);
        // c2 is missing, so a repair asks for it alone.
        return execution({ results: ["c1", "c3"].map((alias) => result(alias, 0.1, "supports")) });
      });
      await service({ graphCandidateLimit: 5 }).matchAtomicNotes(["source"]);
    }
    expect(rerankPrompts).toHaveLength(4);
    expect(new Set(rerankPrompts).size).toBe(1);
    const prompt = rerankPrompts[0]!;
    expect(prompt.indexOf("[c1]\nTitle: Alpha")).toBeGreaterThan(-1);
    expect(prompt.indexOf("[c2]\nTitle: Beta")).toBeGreaterThan(prompt.indexOf("[c1]"));
    expect(prompt.indexOf("[c3]\nTitle: Gamma")).toBeGreaterThan(prompt.indexOf("[c2]"));
    expect(repairPrompts).toHaveLength(4);
    expect(new Set(repairPrompts).size).toBe(1);
    expect(repairPrompts[0]).toContain("[c2]\nTitle: Beta");
    expect(repairPrompts[0]).not.toContain("Title: Alpha");
  });

  it("keeps valid items and asks once again only for the missing ones", async () => {
    respond(
      {
        results: [
          result("c1", 0.1, "related", "Unlike c3, this is a different condition."),
          result("c3", 0.95, "extends", "c3 adds a further condition to s1.")
        ]
      },
      { results: [result("c2", 0.7, "supports", "s1 is reinforced by c2.")] }
    );
    const matched = await service().matchAtomicNotes(["source"]);
    const [first, repair] = rerankCalls();
    expect(rerankCalls()).toHaveLength(2);
    expect(repair?.[1]).toContain("[c2]\nTitle: b");
    expect(repair?.[1]).not.toContain("[c1]");
    expect(repair?.[1]).not.toContain("[c3]");
    expect(first?.[2]).toMatchObject({ operation: "note_matching_reranking", attempt: 0 });
    expect(repair?.[2]).toMatchObject({ operation: "note_matching_reranking_repair", attempt: 1 });
    expect(matched.persistedCount).toBe(2);
    expect(mocks.relations.upsert.mock.calls.map(([input]) => input.explanation)).toEqual([
      '<note-ref id="c" /> adds a further condition to <note-ref id="source" />.',
      '<note-ref id="source" /> is reinforced by <note-ref id="b" />.'
    ]);
    expect(
      mocks.decisions.record.mock.calls.map(([r]) => [r.targetAtomicNoteId, r.aiTaskRunId])
    ).toEqual([
      ["c", "run-1"],
      ["b", "run-2"],
      ["a", "run-1"]
    ]);
  });

  it("keeps an accepted verdict whose explanation stays unsafe, with the localized fallback", async () => {
    respond(
      {
        results: [
          result("c1", 0.1, "related"),
          result("c2", 0.2, "related"),
          result("c3", 0.95, "extends", "c2 and c3")
        ]
      },
      { results: [result("c3", 0.9, "extends", '<note-ref id="x" /> extends s1')] }
    );
    await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(2);
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
      results: [result("c1", 0.1, "related"), result("c3", 0.95, "extends", "c3 extends s1.")]
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

  it("keeps the decided items when a failed repair leaves nothing undecided or reranking is optional", async () => {
    const throwingRepair = (firstAnswer: unknown) =>
      mocks.run.mockImplementation(async (task, _prompt, context: { attempt?: number }) => {
        if (task === "embedding") return embeddingResult();
        if (context.attempt === 1) throw new Error("provider_timeout");
        return execution(firstAnswer);
      });
    // Only the explanation of an accepted pair is missing: the decision stands, with the fallback.
    throwingRepair({
      results: [
        result("c1", 0.1, "related"),
        result("c2", 0.2, "related"),
        result("c3", 0.95, "extends")
      ]
    });
    const matched = await service().matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(2);
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
      results: [result("c1", 0.1, "related"), result("c3", 0.95, "extends", "c3 extends s1.")]
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

  it("asks neither for an explanation nor for a repair of a verdict that can never be accepted", async () => {
    // A weak type is refused with the default settings, whatever the score.
    respond({
      results: [
        result("c1", 0.1, "related"),
        result("c2", 0.2, "related"),
        result("c3", 0.9, "mentions")
      ]
    });
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(rerankCalls()).toHaveLength(1);
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
    expect(mocks.decisions.record).toHaveBeenCalledTimes(3);

    // The same verdict is repaired when the settings could accept it.
    vi.clearAllMocks();
    respond(
      {
        results: [
          result("c1", 0.1, "related"),
          result("c2", 0.2, "related"),
          result("c3", 0.9, "mentions")
        ]
      },
      { results: [result("c3", 0.9, "mentions", "c3 only mentions s1.")] }
    );
    await service({ includeWeakTypes: true }).matchAtomicNotes(["source"]);
    expect(rerankCalls()).toHaveLength(2);

    // A final score under the threshold even with the verdict cannot qualify either.
    vi.clearAllMocks();
    const faint = ["a", "b", "c"].map((id) => ({
      note: note(id),
      textScore: 0.42,
      vectorScore: 0.42
    }));
    mocks.notes.scoreMatchingCandidates.mockResolvedValue(faint);
    respond({ results: ["c1", "c2", "c3"].map((alias) => result(alias, 0.9, "supports")) });
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(rerankCalls()).toHaveLength(1);
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
    expect(prompts[0]).toContain("Add explanation only when score is 0.5 or higher");
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
    expect(prompt).toContain("[c1]\nTitle: b");
    expect(prompt).not.toContain("[c2]");
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
      results: [
        result("c1", 0.1, "related"),
        result("c2", 0.2, "related"),
        result("c3", 1, "supports")
      ]
    });
    const matched = await service().matchAtomicNotes(["source"]);
    const prompt = rerankCalls()[0]![1] as string;
    expect(prompt).toContain("[c1]\nTitle: a");
    expect(prompt).toContain("[c2]\nTitle: b");
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
    respond({ results: [result("c1", 0.1, "related"), result("c2", 0.2, "related")] });
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
