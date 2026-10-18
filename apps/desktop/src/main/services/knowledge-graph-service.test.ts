import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import type { AiService } from "./ai-service.js";
import { setExtractionPin } from "./extraction-pin.js";
import { KnowledgeService } from "./knowledge-service.js";

const mocks = vi.hoisted(() => ({
  sources: { findById: vi.fn() },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  notes: { listGraphInputsBySourceItem: vi.fn() },
  graph: { replaceSourceExtraction: vi.fn(), projectSource: vi.fn() },
  hierarchy: { ensureCurrentDocumentRevision: vi.fn() }
}));
// Identity and relation-type resolution are covered by their own tests; here they pass through.
vi.mock("./entity-identity-resolution.js", () => ({
  createEntityIdentityResolver: () => async (batch: unknown) => batch
}));
vi.mock("./relation-type-resolution.js", async (original) => ({
  ...(await original<typeof import("./relation-type-resolution.js")>()),
  createRelationTypeResolver: () => async (batch: unknown) => batch
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createSourceItemRepository: () => mocks.sources,
  createDocumentRepository: () => mocks.documents,
  createChunkRepository: () => mocks.chunks,
  createAtomicNoteRepository: () => mocks.notes,
  createKnowledgeGraphRepository: () => mocks.graph,
  createHierarchicalIngestionRepository: () => mocks.hierarchy,
  createRelationTypeRepository: () => ({ findExact: async () => new Map() }),
  createEntityIdentityRepository: () => ({})
}));

const sourceItemId = "source-1";
const documentId = "document-1";
const excerpts = ["The curve falls fast.", "Spacing flattens it.", "Review resets it."];
const entity = (key: string, alias: string) => ({
  key,
  type: "Concept",
  canonicalName: key,
  identityDescription: "A concept defined in the supplied evidence.",
  aliases: [],
  confidence: 0.9,
  evidenceChunkIds: [alias]
});

afterEach(() => setExtractionPin(false));

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
    contentHash: "document-hash"
  });
  mocks.notes.listGraphInputsBySourceItem.mockResolvedValue([]);
  mocks.hierarchy.ensureCurrentDocumentRevision.mockResolvedValue("revision-1");
  mocks.graph.replaceSourceExtraction.mockResolvedValue({ entityCount: 1 });
});

describe("knowledge graph generation for a stored source", () => {
  const noteInputs = [
    {
      id: "note-0",
      title: "Note",
      ideaStatement: "Idea",
      bodyMarkdown: "Body",
      evidenceChunkIds: ["chunk-0"]
    }
  ];
  const serviceWith = (runDefaultTask: ReturnType<typeof vi.fn>) =>
    new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: { runDefaultTask } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });
  const answer = () => ({
    taskType: "knowledge-graph-generation",
    output: JSON.stringify({ entities: [], relations: [] }),
    providerId: "test",
    modelId: "mock",
    runtime: "remote",
    durationMs: 1,
    aiTaskRunId: "run-1",
    profileId: "profile-1",
    outputLanguage: "en"
  });

  it("makes one graph pass over the chunks and none over the notes unless asked", async () => {
    mocks.chunks.listByDocument.mockResolvedValue(
      excerpts.map((content, index) => ({
        id: `chunk-${index}`,
        chunkIndex: index,
        content,
        sourceSpanId: null
      }))
    );
    mocks.notes.listGraphInputsBySourceItem.mockResolvedValue(noteInputs);
    const passes = async (context?: { includeAtomicNotesGraph?: boolean }) => {
      const runDefaultTask = vi.fn<
        (task: string, prompt: string) => Promise<ReturnType<typeof answer>>
      >(async () => answer());
      await serviceWith(runDefaultTask).generateKnowledgeGraph(sourceItemId, documentId, context);
      return runDefaultTask.mock.calls.map(([, prompt]) =>
        String(prompt).includes("Atomic notes:") ? "notes" : "chunks"
      );
    };
    // The default context (what the processing plans produce) never reads the notes.
    expect(await passes()).toEqual(["chunks"]);
    expect(mocks.notes.listGraphInputsBySourceItem).not.toHaveBeenCalled();
    expect(await passes({ includeAtomicNotesGraph: false })).toEqual(["chunks"]);
    // An explicit opt-in keeps the second pass available.
    expect(await passes({ includeAtomicNotesGraph: true })).toEqual(["chunks", "notes"]);
  });

  it("builds the same prompt and resolves aliases to the same chunks whatever the chunk UUIDs", async () => {
    const prompts: string[] = [];
    for (const ids of uuidAssignments(excerpts.length)) {
      // The database lists the chunks by position; their UUIDs are unrelated to that order.
      mocks.chunks.listByDocument.mockResolvedValue(
        excerpts.map((content, index) => ({
          id: ids[index]!,
          chunkIndex: index,
          content,
          sourceSpanId: null
        }))
      );
      const runDefaultTask = vi.fn(async (_task: string, prompt: string) => {
        prompts.push(prompt);
        return {
          taskType: "knowledge-graph-generation",
          // A model that still returns claims is ignored; entities cite the alias of chunk 2.
          output: JSON.stringify({
            entities: [entity("spacing", "c2")],
            claims: [
              {
                text: "Spacing flattens the forgetting curve.",
                confidence: 0.9,
                evidenceChunkIds: ["c2"],
                relatedEntityKeys: []
              }
            ],
            relations: []
          }),
          providerId: "test",
          modelId: "mock",
          runtime: "remote",
          durationMs: 1,
          aiTaskRunId: "run-1",
          profileId: "profile-1",
          outputLanguage: "en"
        };
      });
      const service = new KnowledgeService({
        getPool: () => ({}) as PgPool,
        aiService: { runDefaultTask } as unknown as AiService,
        userDataPath: "/tmp/memora-test",
        getStorageSettings: async () => ({}) as never,
        getUploadedFilesBasePath: async () => null
      });

      await service.generateKnowledgeGraph(sourceItemId, documentId);

      const stored = mocks.graph.replaceSourceExtraction.mock.calls.at(-1)![0];
      expect(stored.batches[0].entities[0].evidenceChunkIds).toEqual([ids[1]]);
      expect(stored.batches[0]).not.toHaveProperty("claims");
    }
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toContain("[s1; evidence=c1]\nTitle: Forgetting curve — excerpt 1");
    expect(prompts[0]).toContain("[s2; evidence=c2]\nTitle: Forgetting curve — excerpt 2");
    expect(prompts[0]).toContain("[s3; evidence=c3]\nTitle: Forgetting curve — excerpt 3");
  });

  it("numbers the evidence aliases of atomic-note inputs by chunk position", async () => {
    const prompts: string[] = [];
    for (const ids of uuidAssignments(excerpts.length)) {
      mocks.chunks.listByDocument.mockResolvedValue(
        excerpts.map((content, index) => ({
          id: ids[index]!,
          chunkIndex: index,
          content,
          sourceSpanId: null
        }))
      );
      // The first note cites the document's last chunk and the second note its middle chunk.
      mocks.notes.listGraphInputsBySourceItem.mockResolvedValue(
        [2, 1].map((position, index) => ({
          id: `note-${index}`,
          title: `Note ${index + 1}`,
          ideaStatement: "Idea",
          bodyMarkdown: "Body",
          evidenceChunkIds: [ids[position]!]
        }))
      );
      const runDefaultTask = vi.fn(async (_task: string, prompt: string) => {
        prompts.push(prompt);
        const atomic = prompt.includes("Atomic notes:");
        return {
          taskType: "knowledge-graph-generation",
          output: JSON.stringify({
            entities: atomic ? [entity("middle", "c1")] : [],
            relations: []
          }),
          providerId: "test",
          modelId: "mock",
          runtime: "remote",
          durationMs: 1,
          aiTaskRunId: "run-1",
          profileId: "profile-1",
          outputLanguage: "en"
        };
      });
      const service = new KnowledgeService({
        getPool: () => ({}) as PgPool,
        aiService: { runDefaultTask } as unknown as AiService,
        userDataPath: "/tmp/memora-test",
        getStorageSettings: async () => ({}) as never,
        getUploadedFilesBasePath: async () => null
      });

      await service.generateKnowledgeGraph(sourceItemId, documentId, {
        includeAtomicNotesGraph: true
      });

      // The middle chunk is the first cited in document order, so the note pass calls it c1.
      const stored = mocks.graph.replaceSourceExtraction.mock.calls.at(-1)![0];
      expect(stored.batches.at(-1).entities[0].evidenceChunkIds).toEqual([ids[1]]);
    }
    // One source-chunks call and one atomic-notes call per assignment.
    const atomic = prompts.filter((prompt) => prompt.includes("Atomic notes:"));
    expect(atomic).toHaveLength(4);
    expect(new Set(atomic).size).toBe(1);
    expect(atomic[0]).toContain("[n1; evidence=c2]");
    expect(atomic[0]).toContain("[n2; evidence=c1]");
  });
});

describe("knowledge graph batches by writer and the extraction pin (F3 D5, D36)", () => {
  const longChunks = Array.from({ length: 6 }, (_unused, index) => ({
    id: `chunk-${index}`,
    chunkIndex: index,
    content: `Excerpt ${index}: ${"The curve falls fast. ".repeat(65)}`,
    sourceSpanId: null
  }));
  const answer = (output: unknown) => ({
    taskType: "knowledge-graph-generation",
    output: JSON.stringify(output),
    providerId: "test",
    modelId: "mock",
    runtime: "remote",
    durationMs: 1,
    aiTaskRunId: "run-1",
    profileId: "profile-1",
    outputLanguage: "en"
  });
  const run = async (
    locality: "local" | "remote" | null,
    options: { knowledgeGraphMaxInputCharacters?: number } = {},
    output: unknown = { entities: [], relations: [] }
  ) => {
    mocks.chunks.listByDocument.mockResolvedValue(longChunks);
    const runDefaultTask = vi.fn<
      (task: string, prompt: string) => Promise<ReturnType<typeof answer>>
    >(async () => answer(output));
    const taskRouteLocality = vi.fn(async () => locality);
    const traces: Array<{ operation: string; details: Record<string, unknown> }> = [];
    const traceOperation = vi.fn(
      async (
        operation: string,
        _context: unknown,
        task: () => Promise<unknown>,
        details: Record<string, unknown> = {}
      ) => {
        traces.push({ operation, details });
        return task();
      }
    );
    const service = new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: { runDefaultTask, taskRouteLocality, traceOperation } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      ...options
    });
    await service.generateKnowledgeGraph(sourceItemId, documentId);
    return {
      prompts: runDefaultTask.mock.calls.map((call) => String(call[1])),
      taskRouteLocality,
      traces
    };
  };

  it("asks which locality the graph writer has, with the operation and class a real call states", async () => {
    const { taskRouteLocality } = await run("remote");
    expect(taskRouteLocality).toHaveBeenCalledWith("knowledge-graph-generation", {
      operation: "graph_source_chunks",
      workloadClass: "write-quality"
    });
  });

  it("keeps a remote writer on 3,500 characters and 12/12 caps too (X7's yield, Q8)", async () => {
    const { prompts } = await run("remote");
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("at most 12 entities and 12 relations");
  });

  it("keeps a local writer, or an unknown one, on 3,500 characters and 12/12 caps", async () => {
    for (const locality of ["local", null] as const) {
      const { prompts } = await run(locality);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toContain("at most 12 entities and 12 relations");
    }
  });

  it("pins a remote writer to the recorded batch", async () => {
    setExtractionPin(true);
    const { prompts } = await run("remote");
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("at most 12 entities and 12 relations");
  });

  it("lets an explicit batch size override the writer's", async () => {
    const { prompts } = await run("remote", { knowledgeGraphMaxInputCharacters: 7_000 });
    expect(prompts).toHaveLength(2);
  });

  it("records the items it dropped with no call as salvaged_items", async () => {
    const bad = {
      entities: [entity("e1", "c1"), entity("e2", "c1")],
      relations: [
        {
          subjectEntityKey: "e1",
          predicate: "relates_to",
          displayLabel: "Relates to",
          definition: "The subject relates to the object.",
          objectEntityKey: "nobody",
          confidence: 0.9,
          evidenceChunkIds: ["c1"]
        }
      ]
    };
    const { prompts, traces } = await run(
      "remote",
      { knowledgeGraphMaxInputCharacters: 7_000 },
      bad
    );
    // Two batches, one dropped relation each, no repair call.
    expect(prompts).toHaveLength(2);
    expect(traces.find((trace) => trace.operation === "graph_salvage")?.details).toEqual({
      salvaged_items: 2,
      normalized: 0,
      dropped: { unknown_entity_key: 2 }
    });
  });

  it("records nothing for a pinned run, which repairs instead of salvaging", async () => {
    setExtractionPin(true);
    const bad = {
      entities: [entity("e1", "c1")],
      relations: [
        {
          subjectEntityKey: "e1",
          predicate: "relates_to",
          displayLabel: "Relates to",
          definition: "The subject relates to the object.",
          objectEntityKey: "nobody",
          confidence: 0.9,
          evidenceChunkIds: ["c1"]
        }
      ]
    };
    mocks.chunks.listByDocument.mockResolvedValue(longChunks.slice(0, 1));
    const good = { entities: [entity("e1", "c1")], relations: [] };
    const runDefaultTask = vi
      .fn()
      .mockResolvedValueOnce(answer(bad))
      .mockResolvedValueOnce(answer(good));
    const traceOperation = vi.fn(
      async (_op: string, _context: unknown, task: () => Promise<unknown>) => task()
    );
    const service = new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: { runDefaultTask, traceOperation } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });
    await service.generateKnowledgeGraph(sourceItemId, documentId);
    expect(runDefaultTask).toHaveBeenCalledTimes(2);
    expect(traceOperation.mock.calls.map((call) => call[0])).not.toContain("graph_salvage");
  });
});
