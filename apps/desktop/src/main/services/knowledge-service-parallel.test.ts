import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";

/**
 * The knowledge service lets a source's batches reach the writer's lane together (F5 D22): the
 * summary map and the graph extraction take the lane limit of the route their operation resolves,
 * and what they store keeps batch order whatever order the calls finish in. The cumulative graph
 * budget and its option are gone: every call states the same caps.
 */

const mocks = vi.hoisted(() => ({
  sources: { findById: vi.fn(), update: vi.fn() },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  notes: { listGraphInputsBySourceItem: vi.fn() },
  graph: { replaceSourceExtraction: vi.fn(), projectSource: vi.fn() },
  hierarchy: { ensureCurrentDocumentRevision: vi.fn(), createKnowledgeGeneration: vi.fn() },
  summaries: { create: vi.fn(), clearCurrent: vi.fn() },
  identity: { resolve: vi.fn() }
}));
vi.mock("./entity-identity-resolution.js", () => ({
  createEntityIdentityResolver: () => mocks.identity.resolve
}));
vi.mock("./relation-type-resolution.js", async (original) => ({
  ...(await original<typeof import("./relation-type-resolution.js")>()),
  createRelationTypeResolver: () => async (batches: unknown) => batches
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createSourceItemRepository: () => mocks.sources,
  createDocumentRepository: () => mocks.documents,
  createChunkRepository: () => mocks.chunks,
  createAtomicNoteRepository: () => mocks.notes,
  createKnowledgeGraphRepository: () => mocks.graph,
  createHierarchicalIngestionRepository: () => mocks.hierarchy,
  createSourceSummaryRepository: () => mocks.summaries,
  createRelationTypeRepository: () => ({ findExact: async () => new Map() }),
  createEntityIdentityRepository: () => ({})
}));

const sourceItemId = "source-1";
const documentId = "document-1";
/** Six excerpts of about 1,400 characters: three graph batches of 3,500, six summary groups of 2,000. */
const chunks = Array.from({ length: 6 }, (_unused, index) => ({
  id: `chunk-${index}`,
  chunkIndex: index,
  content: `Excerpt ${index}: ${"The curve falls fast. ".repeat(63)}`,
  sourceSpanId: null
}));
const firstExcerpt = (prompt: string) => /Excerpt (\d+):/u.exec(prompt)?.[1] ?? "?";

/**
 * A writer whose calls wait until the test lets the newest one answer, so calls finish in the
 * reverse of the order they started in, and that records its peak of calls in flight.
 */
function gatedWriter(answer: (prompt: string, context: { operation?: string }) => unknown) {
  const waiting: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  const runDefaultTask = vi.fn(
    async (_task: string, prompt: string, context: { operation?: string }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => waiting.push(resolve));
      running -= 1;
      return {
        taskType: "text-generation",
        output: answer(prompt, context),
        providerId: "test",
        modelId: "mock",
        runtime: "remote",
        durationMs: 1,
        aiTaskRunId: `run-${firstExcerpt(prompt)}`,
        profileId: "profile-1",
        outputLanguage: "en"
      };
    }
  );
  const drain = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    const settled = work.finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      waiting.pop()?.();
    }
    return settled;
  };
  return { runDefaultTask, peak: () => peak, drain };
}

const traceOperation = async (_operation: string, _context: unknown, task: () => unknown) => task();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sources.findById.mockResolvedValue({
    id: sourceItemId,
    title: "Forgetting curve",
    language: "en"
  });
  mocks.documents.findById.mockResolvedValue({
    id: documentId,
    sourceItemId,
    contentHash: "document-hash",
    canonicalMarkdown: chunks.map((chunk) => chunk.content).join("\n\n"),
    metadata: {}
  });
  mocks.chunks.listByDocument.mockResolvedValue(chunks);
  mocks.notes.listGraphInputsBySourceItem.mockResolvedValue([]);
  mocks.hierarchy.ensureCurrentDocumentRevision.mockResolvedValue("revision-1");
  mocks.hierarchy.createKnowledgeGeneration.mockResolvedValue("generation-1");
  mocks.graph.replaceSourceExtraction.mockResolvedValue({ entityCount: 3 });
  mocks.summaries.create.mockResolvedValue({ id: "summary-1", generatedAt: new Date(0) });
  mocks.identity.resolve.mockImplementation(async (batches: unknown) => batches);
});

describe("graph extraction batches in parallel (F5 D22)", () => {
  const extraction = (prompt: string) =>
    JSON.stringify({
      entities: [
        {
          key: "e1",
          type: "Concept",
          canonicalName: `Excerpt ${firstExcerpt(prompt)}`,
          identityDescription: "A concept defined in the supplied evidence.",
          aliases: [],
          confidence: 0.9,
          evidenceChunkIds: ["c1"]
        }
      ],
      relations: []
    });
  const serviceWith = (aiService: Record<string, unknown>) =>
    new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: { traceOperation, ...aiService } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      // Deprecated and ignored: no budget spans a source's batches any more.
      getKnowledgeGraphLimits: async () => ({ maxEntities: 1, maxRelations: 1 })
    });

  it("runs the batches up to the route's lane limit and stores them in batch order", async () => {
    const writer = gatedWriter(extraction);
    const taskRouteConcurrency = vi.fn(async () => 2);
    const onBatchCompleted = vi.fn(async () => undefined);
    const service = serviceWith({
      runDefaultTask: writer.runDefaultTask,
      taskRouteConcurrency,
      taskRouteLocality: async () => "remote"
    });
    await writer.drain(
      service.generateKnowledgeGraph(sourceItemId, documentId, { onBatchCompleted })
    );
    expect(taskRouteConcurrency).toHaveBeenCalledWith("knowledge-graph-generation", {
      operation: "graph_source_chunks",
      workloadClass: "write-quality"
    });
    expect(writer.peak()).toBe(2);
    expect(writer.runDefaultTask).toHaveBeenCalledTimes(3);
    for (const [, prompt] of writer.runDefaultTask.mock.calls)
      expect(prompt).toContain("at most 12 entities and 12 relations");
    const resolved = mocks.identity.resolve.mock.calls[0]![0] as Array<{
      entities: Array<{ canonicalName: string }>;
    }>;
    expect(resolved.map((batch) => batch.entities[0]?.canonicalName)).toEqual([
      "Excerpt 0",
      "Excerpt 2",
      "Excerpt 4"
    ]);
    expect(onBatchCompleted).toHaveBeenCalledTimes(3);
    const stored = mocks.graph.replaceSourceExtraction.mock.calls[0]![0] as {
      generationReceipt: { metadata: Record<string, unknown> };
      generation: Record<string, unknown>;
    };
    expect(stored.generationReceipt.metadata).toMatchObject({
      batchLimits: { maxEntities: 12, maxRelations: 12 }
    });
    expect(stored.generationReceipt.metadata).not.toHaveProperty("extractionLimits");
    expect(stored.generation).not.toHaveProperty("extractionLimits");
  });

  it("runs one batch at a time when the AI service cannot say its lane limit", async () => {
    const writer = gatedWriter(extraction);
    await writer.drain(
      serviceWith({ runDefaultTask: writer.runDefaultTask }).generateKnowledgeGraph(
        sourceItemId,
        documentId
      )
    );
    expect(writer.peak()).toBe(1);
    expect(writer.runDefaultTask).toHaveBeenCalledTimes(3);
  });
});

describe("the summary map in parallel (F5 D22)", () => {
  it("runs the map up to the route's lane limit and reduces the partials in chunk order", async () => {
    const writer = gatedWriter((prompt, context) =>
      context.operation === "summary_map" ? `Partial ${firstExcerpt(prompt)}.` : "Reduced."
    );
    const taskRouteConcurrency = vi.fn(async () => 3);
    const service = new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: {
        runDefaultTask: writer.runDefaultTask,
        taskRouteConcurrency
      } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      getSummaryMinimumWordCount: async () => 0,
      summaryMaxInputCharacters: 2_000
    });
    const result = await writer.drain(service.summarizeSource(sourceItemId, documentId));
    expect(result).toMatchObject({ generated: true, mapReduce: true });
    expect(taskRouteConcurrency).toHaveBeenCalledWith("summarization", {
      operation: "summary_map",
      workloadClass: "write-fast"
    });
    expect(writer.peak()).toBe(3);
    const calls = writer.runDefaultTask.mock.calls;
    expect(calls).toHaveLength(chunks.length + 1);
    const reduction = String(calls.at(-1)![1]);
    const positions = chunks.map((_chunk, index) => reduction.indexOf(`Partial ${index}.`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(mocks.summaries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Reduced.",
        metadata: expect.objectContaining({
          aiTaskRunIds: [...chunks.map((_chunk, index) => `run-${index}`), "run-?"]
        })
      })
    );
  });
});
