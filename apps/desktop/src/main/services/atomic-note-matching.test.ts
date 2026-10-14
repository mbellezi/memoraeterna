import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicNoteMatchingSettingsSchema } from "@app/domain";
import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import { KnowledgeService } from "./knowledge-service.js";
import type { AiService } from "./ai-service.js";
import type { PgPool } from "@app/db";

const mocks = vi.hoisted(() => ({
  notes: {
    findById: vi.fn(),
    findTextMatchingCandidates: vi.fn(),
    findVectorMatchingCandidates: vi.fn(),
    scoreMatchingCandidates: vi.fn()
  },
  relations: { existingTargets: vi.fn(), upsert: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn(), listAtomicNoteElements: vi.fn() },
  embedding: { upsert: vi.fn() },
  run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createAtomicNoteRelationRepository: () => mocks.relations,
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
const execution = (output: unknown) => ({
  output,
  profileId: "profile",
  modelId: "model",
  providerId: "provider",
  runtime: "remote",
  aiTaskRunId: "run"
});
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
  mocks.relations.existingTargets.mockResolvedValue(new Set());
  mocks.run.mockImplementation(async (task) =>
    task === "embedding"
      ? execution(Array.from({ length: 256 }, () => 0.1))
      : execution({
          results: [
            {
              candidateAlias: "c1",
              score: 0.1,
              relationType: "supports",
              explanation: "The candidate supplies only weak support for the source idea."
            },
            {
              candidateAlias: "c2",
              score: 0.7,
              relationType: "supports",
              explanation: "The candidate reinforces the central claim of the source idea."
            },
            {
              candidateAlias: "c3",
              score: 0.95,
              relationType: "extends",
              explanation: "The candidate adds a further condition to the source idea."
            }
          ]
        })
  );
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
    expect(mocks.run.mock.calls.find(([task]) => task === "reranking")?.[4]).toEqual({
      maxOutputTokens: 1024
    });
    expect(result.persistedCount).toBe(1);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ targetAtomicNoteId: "c", relationType: "extends" })
    );
  });
  it("builds the same rerank prompt for the same notes under any UUID assignment", async () => {
    const rerankPrompts: string[] = [];
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
        rerankPrompts.push(prompt);
        return execution({
          results: ["c1", "c2", "c3"].map((candidateAlias) => ({
            candidateAlias,
            score: 0.1,
            relationType: "supports",
            explanation: "The candidate supplies only weak support for the source idea."
          }))
        });
      });
      await service({ graphCandidateLimit: 5 }).matchAtomicNotes(["source"]);
    }
    expect(rerankPrompts).toHaveLength(4);
    expect(new Set(rerankPrompts).size).toBe(1);
    const prompt = rerankPrompts[0]!;
    expect(prompt.indexOf("[c1]\nTitle: Alpha")).toBeGreaterThan(-1);
    expect(prompt.indexOf("[c2]\nTitle: Beta")).toBeGreaterThan(prompt.indexOf("[c1]"));
    expect(prompt.indexOf("[c3]\nTitle: Gamma")).toBeGreaterThan(prompt.indexOf("[c2]"));
  });
  it("fails visibly on invalid validation without creating fallback links", async () => {
    mocks.run.mockImplementation(async (task) =>
      task === "embedding" ? null : execution({ results: [] })
    );
    await expect(service().matchAtomicNotes(["source"])).rejects.toThrow(
      "errors.matching.rerankingFailed"
    );
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
  });
  it("excludes saved pairs before AI and leaves them unchanged", async () => {
    mocks.relations.existingTargets.mockResolvedValue(new Set(["a", "b", "c"]));
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(mocks.run.mock.calls.some(([task]) => task === "reranking")).toBe(false);
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
  });
});
