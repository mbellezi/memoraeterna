import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { renderPrompt } from "./prompt-runtime.js";

const mocks = vi.hoisted(() => ({
  notes: { findById: vi.fn() },
  embedding: { hasContentHash: vi.fn(), upsert: vi.fn() },
  run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createEmbeddingRepository: () => mocks.embedding
}));

const note = (status = "active") => ({
  id: "note-1",
  title: "Spacing flattens the curve",
  ideaStatement: "Spacing flattens forgetting.",
  bodyMarkdown: "Reviewing at spaced intervals flattens the forgetting curve.",
  metadata: { humanProtected: true },
  createdFromSourceItemId: "source-1",
  status
});
const text = (value: ReturnType<typeof note>) =>
  renderPrompt("embedding.content.note", {
    note_title: value.title,
    note_idea: value.ideaStatement,
    note_body: value.bodyMarkdown
  });
const vector = Array.from({ length: 256 }, (_, index) => index / 256);
const embedded = {
  output: vector,
  providerId: "local",
  modelId: "embedding-model",
  runtime: "mlx",
  embeddingSpaceKey: "space-1",
  profileId: "profile",
  aiTaskRunId: "run"
};
const service = () =>
  new KnowledgeService({
    getPool: () => ({}) as PgPool,
    aiService: { runDefaultTask: mocks.run } as unknown as AiService,
    userDataPath: "/tmp/test",
    getStorageSettings: async () => ({}) as never,
    getUploadedFilesBasePath: async () => null
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.notes.findById.mockResolvedValue(note());
  mocks.embedding.hasContentHash.mockResolvedValue(false);
  mocks.run.mockResolvedValue(embedded);
});

describe("rebuilding the embedding of an edited note", () => {
  it("embeds the current text with the embedding model only and stores the vector", async () => {
    const signal = new AbortController().signal;
    const result = await service().embedAtomicNote("note-1", signal, {
      jobId: "job-1",
      stage: "note_embedding"
    });
    expect(result).toEqual({ embedded: true });
    // The only AI call is one embedding: no generative task, whatever the edit was.
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledWith(
      "embedding",
      text(note()),
      expect.objectContaining({
        jobId: "job-1",
        atomicNoteId: "note-1",
        sourceItemId: "source-1",
        operation: "note_embedding"
      }),
      signal
    );
    expect(mocks.embedding.upsert).toHaveBeenCalledOnce();
    expect(mocks.embedding.upsert).toHaveBeenCalledWith({
      targetType: "atomic_note",
      targetId: "note-1",
      provider: "local",
      model: "embedding-model",
      runtime: "mlx",
      usage: "matching",
      strategy: "native-v2:space-1",
      contentHash: createHash("sha256").update(text(note())).digest("hex"),
      embedding: vector
    });
  });

  it("skips a note whose current text already has a vector", async () => {
    mocks.embedding.hasContentHash.mockResolvedValue(true);
    expect(await service().embedAtomicNote("note-1")).toEqual({
      embedded: false,
      reason: "unchanged"
    });
    expect(mocks.embedding.hasContentHash).toHaveBeenCalledWith(
      "atomic_note",
      "note-1",
      createHash("sha256").update(text(note())).digest("hex")
    );
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.embedding.upsert).not.toHaveBeenCalled();
  });

  it.each(["rejected", "archived"])("skips a %s note", async (status) => {
    mocks.notes.findById.mockResolvedValue(note(status));
    expect(await service().embedAtomicNote("note-1")).toEqual({
      embedded: false,
      reason: "note_not_current"
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("skips a note that no longer exists", async () => {
    mocks.notes.findById.mockResolvedValue(null);
    expect(await service().embedAtomicNote("gone")).toEqual({
      embedded: false,
      reason: "note_not_found"
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("stores nothing when no embedding model is configured", async () => {
    mocks.run.mockResolvedValue(null);
    expect(await service().embedAtomicNote("note-1")).toEqual({
      embedded: false,
      reason: "no_embedding"
    });
    expect(mocks.embedding.upsert).not.toHaveBeenCalled();
  });

  it("lets a provider failure through so the job is retried", async () => {
    mocks.run.mockRejectedValue(new Error("embedding model unavailable"));
    await expect(service().embedAtomicNote("note-1")).rejects.toThrow(
      "embedding model unavailable"
    );
    expect(mocks.embedding.upsert).not.toHaveBeenCalled();
  });
});
