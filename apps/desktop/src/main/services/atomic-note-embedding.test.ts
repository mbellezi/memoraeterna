import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { renderPrompt } from "./prompt-runtime.js";
import type { TopicChangeHooks } from "./topic-tree/topic-hooks.js";

const mocks = vi.hoisted(() => ({
  sources: { findById: vi.fn() },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  hierarchy: {
    ensureCurrentDocumentRevision: vi.fn(),
    createKnowledgeGeneration: vi.fn(),
    completeKnowledgeGeneration: vi.fn()
  },
  notes: { upsertGenerated: vi.fn() },
  embedding: { findCurrentNoteVectors: vi.fn(), upsert: vi.fn() },
  run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createSourceItemRepository: () => mocks.sources,
  createDocumentRepository: () => mocks.documents,
  createChunkRepository: () => mocks.chunks,
  createHierarchicalIngestionRepository: () => mocks.hierarchy,
  createAtomicNoteRepository: () => mocks.notes,
  createEmbeddingRepository: () => mocks.embedding
}));

const sourceId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const chunkId = "33333333-3333-4333-8333-333333333333";
const generatedNotes = ["Spacing", "Retrieval"].map((title) => ({
  title,
  ideaStatement: `${title} helps memory.`,
  bodyMarkdown: `${title} is practiced over time.`,
  language: "en",
  evidenceChunkIds: [chunkId]
}));
const vector = Array.from({ length: 256 }, (_, index) => index / 256);
const generation = {
  output: { notes: generatedNotes },
  providerId: "remote",
  modelId: "writer",
  runtime: "remote",
  profileId: "profile",
  aiTaskRunId: "generation-run",
  outputLanguage: "en"
};
const embedded = {
  output: vector,
  providerId: "local",
  modelId: "embedding-model",
  runtime: "mlx",
  embeddingSpaceKey: "space-1",
  profileId: "profile",
  aiTaskRunId: "embedding-run"
};
const embeddingCalls = () => mocks.run.mock.calls.filter(([task]) => task === "embedding");
const service = (logger?: Pick<Console, "error" | "warn">, topicHooks?: TopicChangeHooks) =>
  new KnowledgeService({
    getPool: () => ({}) as PgPool,
    aiService: { runDefaultTask: mocks.run } as unknown as AiService,
    userDataPath: "/tmp/test",
    getStorageSettings: async () => ({}) as never,
    getUploadedFilesBasePath: async () => null,
    ...(logger ? { logger } : {}),
    ...(topicHooks ? { topicHooks } : {})
  });
const textOf = (note: { title: string; ideaStatement: string; bodyMarkdown: string }) =>
  renderPrompt("embedding.content.note", {
    note_title: note.title,
    note_idea: note.ideaStatement,
    note_body: note.bodyMarkdown
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sources.findById.mockResolvedValue({
    id: sourceId,
    title: "Learning",
    language: "en",
    metadata: {}
  });
  mocks.documents.findById.mockResolvedValue({
    id: documentId,
    sourceItemId: sourceId,
    contentHash: "hash",
    canonicalMarkdown: "Spacing and retrieval."
  });
  mocks.chunks.listByDocument.mockResolvedValue([
    { id: chunkId, content: "Spacing and retrieval.", sourceSpanId: null }
  ]);
  mocks.hierarchy.ensureCurrentDocumentRevision.mockResolvedValue("revision");
  mocks.hierarchy.createKnowledgeGeneration.mockResolvedValue("generation");
  mocks.hierarchy.completeKnowledgeGeneration.mockResolvedValue(undefined);
  let created = 0;
  mocks.notes.upsertGenerated.mockImplementation(async (input) => ({
    id: `note-${(created += 1)}`,
    title: input.title,
    ideaStatement: input.ideaStatement,
    bodyMarkdown: input.bodyMarkdown,
    metadata: {},
    createdFromSourceItemId: input.sourceItemId,
    status: "active"
  }));
  mocks.embedding.findCurrentNoteVectors.mockResolvedValue(new Map());
  mocks.run.mockImplementation(async (task) => (task === "embedding" ? embedded : generation));
});

describe("embedding notes when they are created", () => {
  it("embeds each generated note right after it is persisted, with the embedding model only", async () => {
    const signal = new AbortController().signal;
    const result = await service().generateAtomicNotes(
      sourceId,
      documentId,
      { jobId: "job-1", ingestionRunId: "run-1" },
      signal
    );
    expect(result).toMatchObject({
      configured: true,
      generatedCount: 2,
      embeddedCount: 2,
      noteIds: ["note-1", "note-2"]
    });
    // One generative call, then one embedding call per note: nothing else asks a model.
    expect(mocks.run.mock.calls.map(([task]) => task)).toEqual([
      "atomic-note-generation",
      "embedding",
      "embedding"
    ]);
    expect(embeddingCalls().map(([, input]) => input)).toEqual(generatedNotes.map(textOf));
    expect(embeddingCalls()[0]![2]).toMatchObject({
      jobId: "job-1",
      ingestionRunId: "run-1",
      sourceItemId: sourceId,
      atomicNoteId: "note-1",
      stage: "atomic_note_embedding",
      operation: "note_creation_embedding"
    });
    expect(embeddingCalls()[0]![3]).toBe(signal);
    // Persisted before embedded, and stored with the hash of the text it was built from.
    const lastPersist = Math.max(...mocks.notes.upsertGenerated.mock.invocationCallOrder);
    const firstEmbedding = Math.min(
      ...mocks.run.mock.calls.flatMap(([task], index) =>
        task === "embedding" ? [mocks.run.mock.invocationCallOrder[index]!] : []
      )
    );
    expect(lastPersist).toBeLessThan(firstEmbedding);
    expect(mocks.embedding.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.embedding.upsert.mock.calls[0]![0]).toMatchObject({
      targetType: "atomic_note",
      targetId: "note-1",
      provider: "local",
      model: "embedding-model",
      runtime: "mlx",
      usage: "matching",
      strategy: "native-v2:space-1",
      contentHash: createHash("sha256").update(textOf(generatedNotes[0]!)).digest("hex")
    });
  });

  it("does not embed a note again when it already has a vector for its text", async () => {
    mocks.embedding.findCurrentNoteVectors.mockResolvedValue(
      new Map([
        [
          "note-1",
          {
            targetId: "note-1",
            embedding: vector,
            model: "embedding-model",
            provider: "local",
            runtime: "mlx",
            strategy: "native-v2:space-1"
          }
        ]
      ])
    );
    const result = await service().generateAtomicNotes(sourceId, documentId);
    expect(result).toMatchObject({ generatedCount: 2, embeddedCount: 1 });
    expect(embeddingCalls().map(([, , context]) => context.atomicNoteId)).toEqual(["note-2"]);
  });

  it("keeps the notes and does not fail the stage when a note cannot be embedded", async () => {
    mocks.run.mockImplementation(async (task) => {
      if (task === "embedding") throw new Error("provider_unavailable");
      return generation;
    });
    const result = await service().generateAtomicNotes(sourceId, documentId);
    // Matching embeds what is still missing; regenerating the notes would only repeat their cost.
    expect(result).toMatchObject({
      generatedCount: 2,
      embeddedCount: 0,
      noteIds: ["note-1", "note-2"]
    });
    expect(mocks.hierarchy.completeKnowledgeGeneration).toHaveBeenCalledOnce();
    expect(mocks.embedding.upsert).not.toHaveBeenCalled();
  });

  it("keeps the notes and logs when storing the vectors fails", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    mocks.embedding.findCurrentNoteVectors.mockRejectedValue(new Error("database_unavailable"));
    const result = await service(logger).generateAtomicNotes(sourceId, documentId);
    expect(result).toMatchObject({ generatedCount: 2, embeddedCount: 0 });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(JSON.parse(logger.error.mock.calls[0]![0] as string)).toMatchObject({
      event: "atomic_note_embedding_failed",
      sourceItemId: sourceId,
      stage: "embedding"
    });
  });

  it("stops when the stage is canceled while embedding", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async (task) => {
      if (task !== "embedding") return generation;
      controller.abort();
      throw new Error("canceled");
    });
    await expect(
      service().generateAtomicNotes(sourceId, documentId, {}, controller.signal)
    ).rejects.toThrow("canceled");
  });

  it("embeds nothing when the source has no chunks", async () => {
    mocks.chunks.listByDocument.mockResolvedValue([]);
    await expect(service().generateAtomicNotes(sourceId, documentId)).resolves.toEqual({
      configured: true,
      generatedCount: 0,
      noteIds: []
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("handing embedded notes to the topic tree", () => {
  const topicHooks = () => ({
    notesChanged: vi.fn(async () => undefined),
    sourcesChanged: vi.fn(async () => undefined),
    itemsRemoved: vi.fn(async () => undefined)
  });

  it("enqueues the notes it embedded in one call, after every vector is stored", async () => {
    const hooks = topicHooks();
    await service(undefined, hooks).generateAtomicNotes(sourceId, documentId);
    expect(hooks.notesChanged).toHaveBeenCalledOnce();
    expect(hooks.notesChanged).toHaveBeenCalledWith(["note-1", "note-2"]);
    expect(hooks.notesChanged.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...mocks.embedding.upsert.mock.invocationCallOrder)
    );
    expect(hooks.sourcesChanged).not.toHaveBeenCalled();
    expect(hooks.itemsRemoved).not.toHaveBeenCalled();
  });

  it("leaves out a note that already had its vector: it was handed over when it was embedded", async () => {
    mocks.embedding.findCurrentNoteVectors.mockResolvedValue(
      new Map([
        [
          "note-1",
          {
            targetId: "note-1",
            embedding: vector,
            model: "embedding-model",
            provider: "local",
            runtime: "mlx",
            strategy: "native-v2:space-1"
          }
        ]
      ])
    );
    const hooks = topicHooks();
    await service(undefined, hooks).generateAtomicNotes(sourceId, documentId);
    expect(hooks.notesChanged).toHaveBeenCalledOnce();
    expect(hooks.notesChanged).toHaveBeenCalledWith(["note-2"]);
  });

  it("enqueues nothing while no note has a vector", async () => {
    mocks.run.mockImplementation(async (task) => {
      if (task === "embedding") throw new Error("provider_unavailable");
      return generation;
    });
    const hooks = topicHooks();
    await service(undefined, hooks).generateAtomicNotes(sourceId, documentId);
    expect(hooks.notesChanged).not.toHaveBeenCalled();
  });
});
