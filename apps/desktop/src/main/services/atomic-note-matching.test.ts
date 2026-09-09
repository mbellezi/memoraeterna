import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicNoteMatchingSettingsSchema } from "@app/domain";
import { KnowledgeService } from "./knowledge-service.js";
import type { AiService } from "./ai-service.js";
import type { PgPool } from "@app/db";

const mocks = vi.hoisted(() => ({
  notes: { findById: vi.fn(), findTextMatchingCandidates: vi.fn(), findVectorMatchingCandidates: vi.fn(), scoreMatchingCandidates: vi.fn() },
  relations: { existingTargets: vi.fn(), upsert: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn(), listAtomicNoteElements: vi.fn() },
  embedding: { upsert: vi.fn() }, run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({ ...await original<typeof import("@app/db")>(),
  createAtomicNoteRepository: () => mocks.notes, createAtomicNoteRelationRepository: () => mocks.relations,
  createKnowledgeGraphRepository: () => mocks.graph, createEmbeddingRepository: () => mocks.embedding
}));
const note = (id: string) => ({ id, title: id, ideaStatement: `Idea ${id}`, bodyMarkdown: `Body ${id}`, metadata: {}, createdFromSourceItemId: `source-${id}`, status: "pending_review" });
const execution = (output: unknown) => ({ output, profileId: "profile", modelId: "model", providerId: "provider", runtime: "remote", aiTaskRunId: "run" });
function service(settings: unknown = {}) {
  return new KnowledgeService({ getPool: () => ({}) as PgPool, aiService: { runDefaultTask: mocks.run } as unknown as AiService,
    userDataPath: "/tmp/test", getStorageSettings: async () => ({}) as never, getUploadedFilesBasePath: async () => null,
    getAtomicNoteMatchingSettings: async () => AtomicNoteMatchingSettingsSchema.parse(settings), relationThreshold: 0.6 });
}
beforeEach(() => {
  vi.resetAllMocks();
  const candidates = ["a", "b", "c"].map((id) => ({ note: note(id), textScore: 1, vectorScore: 1 }));
  mocks.notes.findById.mockResolvedValue(note("source"));
  mocks.notes.findTextMatchingCandidates.mockResolvedValue(candidates);
  mocks.notes.findVectorMatchingCandidates.mockResolvedValue(candidates);
  mocks.notes.scoreMatchingCandidates.mockResolvedValue(candidates);
  mocks.graph.findAtomicNoteCandidates.mockResolvedValue([]);
  mocks.graph.listAtomicNoteElements.mockResolvedValue(new Map());
  mocks.relations.existingTargets.mockResolvedValue(new Set());
  mocks.run.mockImplementation(async (task) => task === "embedding" ? execution(Array.from({ length: 256 }, () => 0.1)) : execution({ results: [
    { candidateAlias: "c1", score: 0.1, relationType: "supports", explanation: "The candidate supplies only weak support for the source idea." },
    { candidateAlias: "c2", score: 0.7, relationType: "supports", explanation: "The candidate reinforces the central claim of the source idea." },
    { candidateAlias: "c3", score: 0.95, relationType: "extends", explanation: "The candidate adds a further condition to the source idea." }
  ] }));
});

describe("atomic note matching execution", () => {
  it("propagates candidate/output controls, blocks rejected pairs and caps by final score", async () => {
    const result = await service({ textCandidateLimit: 9, vectorCandidateLimit: 8, graphCandidateLimit: 0, maxRelationsPerNote: 1, maxRerankOutputTokens: 1024 }).matchAtomicNotes(["source"]);
    expect(mocks.notes.findTextMatchingCandidates).toHaveBeenCalledWith({ noteId: "source", limit: 9 });
    expect(mocks.notes.findVectorMatchingCandidates.mock.calls[0]![0].limit).toBe(8);
    expect(mocks.graph.findAtomicNoteCandidates).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.find(([task]) => task === "reranking")?.[4]).toEqual({ maxOutputTokens: 1024 });
    expect(result.persistedCount).toBe(1);
    expect(mocks.relations.upsert).toHaveBeenCalledWith(expect.objectContaining({ targetAtomicNoteId: "c", relationType: "extends" }));
  });
  it("fails visibly on invalid validation without creating fallback links", async () => {
    mocks.run.mockImplementation(async (task) => task === "embedding" ? null : execution({ results: [] }));
    await expect(service().matchAtomicNotes(["source"])).rejects.toThrow("errors.matching.rerankingFailed");
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
  });
  it("excludes saved pairs before AI and leaves them unchanged", async () => {
    mocks.relations.existingTargets.mockResolvedValue(new Set(["a", "b", "c"]));
    expect((await service().matchAtomicNotes(["source"])).persistedCount).toBe(0);
    expect(mocks.run.mock.calls.some(([task]) => task === "reranking")).toBe(false);
    expect(mocks.relations.upsert).not.toHaveBeenCalled();
  });
});
