import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";

const mocks = vi.hoisted(() => ({
  sources: { findById: vi.fn() },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  notes: { listGraphInputsBySourceItem: vi.fn() },
  graph: { replaceSourceExtraction: vi.fn(), projectSource: vi.fn() },
  hierarchy: { ensureCurrentDocumentRevision: vi.fn() }
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
          output: JSON.stringify({
            entities: [],
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
      expect(stored.batches[0].claims[0].evidenceChunkIds).toEqual([ids[1]]);
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
            entities: [],
            claims: atomic
              ? [
                  {
                    text: "The middle chunk is the first cited in document order.",
                    confidence: 0.9,
                    evidenceChunkIds: ["c1"],
                    relatedEntityKeys: []
                  }
                ]
              : [],
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

      const stored = mocks.graph.replaceSourceExtraction.mock.calls.at(-1)![0];
      expect(stored.batches.at(-1).claims[0].evidenceChunkIds).toEqual([ids[1]]);
    }
    // One source-chunks call and one atomic-notes call per assignment.
    const atomic = prompts.filter((prompt) => prompt.includes("Atomic notes:"));
    expect(atomic).toHaveLength(4);
    expect(new Set(atomic).size).toBe(1);
    expect(atomic[0]).toContain("[n1; evidence=c2]");
    expect(atomic[0]).toContain("[n2; evidence=c1]");
  });
});
