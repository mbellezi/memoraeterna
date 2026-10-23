import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { uuidAssignments } from "./__fixtures__/uuid-assignments.js";
import type { AiService } from "./ai-service.js";
import { KnowledgeService, serializeNote } from "./knowledge-service.js";
import { atomicNoteViewSchema } from "../../shared/ipc.js";

describe("hierarchical aggregate summaries", () => {
  it("adds the configured embedding to library queries for composite ranking", async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      }
    } as unknown as PgPool;
    const embedding = Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0));
    const runDefaultTask = vi.fn(async () => ({ output: embedding, modelId: "source-model" }));
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: { runDefaultTask } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await service.browseLibrary({
      query: "semantic memory",
      sourceTypes: [],
      offset: 0,
      limit: 48
    });

    expect(queries[0]?.text).toContain("source_embedding.target_type = 'source_item'");
    expect(queries[0]?.values?.[2]).toBe("semantic memory");
    expect(queries[0]?.values?.[8]).toBe("source-model");
    expect(runDefaultTask).toHaveBeenCalledWith("embedding", "semantic memory", {
      stage: "library_search",
      embeddingInputType: "query",
      workloadClass: "embed",
      priority: "P0",
      budgetClass: "interactive"
    });
  });

  it("includes descendants of any hierarchical source type when finding completed subpart summaries", async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      }
    } as unknown as PgPool;
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: {} as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await service.summarizeHierarchiesForBatch("batch-id");

    expect(queries[0]?.text).toContain("with recursive hierarchy");
    expect(queries[0]?.text).toContain("child.parent_source_item_id = root.id");
    expect(queries[0]?.text).toContain("child.parent_source_item_id = hierarchy.child_id");
    expect(queries[0]?.text).toContain(
      "join source_items child on child.parent_source_item_id = aggregate_roots.root_id"
    );
    // Roots and subparts never fall back to ID order before a content key.
    expect(queries[0]?.text).toContain(
      "order by aggregate_roots.maximum_depth, aggregate_roots.root_title, aggregate_roots.root_id"
    );
    expect(queries[0]?.text).toContain(
      "canonical_order.position nulls last, child.created_at, child.title, child.id"
    );
    expect(queries[0]?.text).not.toContain("root.type in");
    expect(queries[0]?.text).toContain("hierarchy.root_id = $2::uuid");
    expect(queries[0]?.text).toContain(
      "run.source_item_id in (hierarchy.root_id, hierarchy.child_id)"
    );
    expect(queries[0]?.values).toEqual(["batch-id", null]);
  });

  it("recognizes a root by its descendants rather than by its source type", async () => {
    const pool = {
      query: async () => ({ rows: [{ exists: true }] })
    } as unknown as PgPool;
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: {} as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await expect(service.isHierarchicalRoot("paper-id")).resolves.toBe(true);
  });

  it("reports missing subpart summaries instead of silently retaining the previous root summary", async () => {
    const pool = {
      query: async (text: string) =>
        text.includes("with recursive hierarchy")
          ? {
              rows: [
                {
                  rootId: "paper-id",
                  rootType: "AcademicPaper",
                  rootTitle: "Paper",
                  rootLanguage: "pt-BR",
                  documentId: "document-id",
                  documentHash: "document-hash",
                  childId: "section-id",
                  childTitle: "Section",
                  summaryId: null,
                  summary: null,
                  summaryHash: null
                }
              ]
            }
          : { rows: [] }
    } as unknown as PgPool;
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: {} as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await expect(
      service.summarizeHierarchiesForBatch(null, undefined, {}, "paper-id", true)
    ).resolves.toEqual({
      generatedCount: 0,
      reusedCount: 0,
      blockedRoots: [{ sourceItemId: "paper-id", missingSummaryCount: 1, totalSubparts: 1 }],
      // The summary it held was cleared: the header chunk built with it follows (T53h).
      changedRootIds: ["paper-id"]
    });
  });

  it("aggregates available direct-child summaries without waiting for empty subparts", async () => {
    const runDefaultTask = vi.fn(async (_taskType: string, _prompt: string) => null);
    const pool = {
      query: async (text: string) => {
        if (text.includes("with recursive hierarchy")) {
          return {
            rows: [
              {
                rootId: "paper-id",
                rootType: "AcademicPaper",
                rootTitle: "Paper",
                rootLanguage: "pt-BR",
                documentId: "document-id",
                documentHash: "document-hash",
                childId: "content-id",
                childTitle: "Content",
                summaryId: "summary-id",
                summary: "A substantive section summary.",
                summaryHash: "summary-hash"
              },
              {
                rootId: "paper-id",
                rootType: "AcademicPaper",
                rootTitle: "Paper",
                rootLanguage: "pt-BR",
                documentId: "document-id",
                documentHash: "document-hash",
                childId: "title-id",
                childTitle: "Title",
                summaryId: null,
                summary: null,
                summaryHash: null
              }
            ]
          };
        }
        if (text.includes("from source_summaries")) return { rows: [] };
        throw new Error(`Unexpected query: ${text}`);
      }
    } as unknown as PgPool;
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: { runDefaultTask } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await expect(service.summarizeHierarchiesForBatch("batch-id")).resolves.toEqual({
      generatedCount: 0,
      reusedCount: 0,
      blockedRoots: [],
      changedRootIds: []
    });
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    const prompt = runDefaultTask.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("A substantive section summary.");
    expect(prompt).not.toContain("[Subpart 2: Title]");
    expect(prompt).toContain('do not output "# Aggregate summary" or "# Resumo agregado"');
  });

  describe("a book's summary sized by the active writer (plan decision 28)", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "__fixtures__/recorded-aggregate-summary-request.json"),
        "utf8"
      )
    ) as { requests: Array<{ name: string; input: string }> };
    const recordedInput = fixture.requests.find((request) => request.name === "aggregate")!.input;
    const subparts = [...recordedInput.matchAll(/\[Subpart \d+: ([^\]\n]*)\]\n([^\n]*)/gu)].map(
      (match) => ({ title: match[1]!, summary: match[2]! })
    );
    const serviceOver = (
      aiService: Record<string, unknown>,
      children: Array<{ title: string; summary: string }> = subparts
    ) =>
      new KnowledgeService({
        getPool: () =>
          ({
            query: async (text: string) =>
              text.includes("with recursive hierarchy")
                ? {
                    rows: children.map((child, index) => ({
                      rootId: "book-id",
                      rootType: "Book",
                      rootTitle: "O Alienista",
                      rootLanguage: "pt-BR",
                      documentId: "document-id",
                      documentHash: "document-hash",
                      childId: `chapter-${index}`,
                      childTitle: child.title,
                      summaryId: `summary-${index}`,
                      summary: child.summary,
                      summaryHash: `hash-${index}`
                    }))
                  }
                : { rows: [] }
          }) as unknown as PgPool,
        aiService: aiService as unknown as AiService,
        userDataPath: "/tmp/memora-test",
        getStorageSettings: async () => ({}) as never,
        getUploadedFilesBasePath: async () => null
      });
    const codex = {
      contextWindow: 128_000,
      source: "planning",
      maxOutputTokens: 16_384,
      local: false
    };

    it("sends the request the golden library recorded, byte for byte, on the Codex route", async () => {
      const taskRouteCapacity = vi.fn(async () => codex);
      const runDefaultTask = vi.fn<
        (task: string, prompt: string, context?: object) => Promise<null>
      >(async () => null);
      await serviceOver({ taskRouteCapacity, runDefaultTask }).summarizeHierarchiesForBatch(
        "batch-id"
      );
      expect(taskRouteCapacity).toHaveBeenCalledWith("summarization", {
        operation: "hierarchy_summary",
        workloadClass: "write-fast"
      });
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
      // The application's language header goes before the prompt; the prompt is the recorded one.
      expect(recordedInput.endsWith(runDefaultTask.mock.calls[0]![1])).toBe(true);
      expect(
        recordedInput.slice(0, recordedInput.indexOf("\n\n") + 2) + runDefaultTask.mock.calls[0]![1]
      ).toBe(recordedInput);
      // Its call context is the one it always was: no batch is named for a single call.
      expect(runDefaultTask.mock.calls[0]![2]).not.toHaveProperty("batchIndex");
    });

    it("sends the same request whether or not the AI service can state the writer's capacity", async () => {
      const prompts: string[] = [];
      for (const aiService of [
        { runDefaultTask: async (_task: string, prompt: string) => (prompts.push(prompt), null) },
        {
          taskRouteCapacity: async () => {
            throw new Error("database_not_ready");
          },
          runDefaultTask: async (_task: string, prompt: string) => (prompts.push(prompt), null)
        }
      ])
        await serviceOver(aiService).summarizeHierarchiesForBatch("batch-id");
      expect(prompts).toHaveLength(2);
      expect(new Set(prompts).size).toBe(1);
      expect(recordedInput.endsWith(prompts[0]!)).toBe(true);
    });

    it("combines the chapters in consecutive batches when the writer's window is small", async () => {
      const taskRouteCapacity = vi.fn(async () => ({
        contextWindow: 4_096,
        source: "profile",
        maxOutputTokens: 1_024,
        local: true
      }));
      const prompts: string[] = [];
      // The first call has no answer, so the book stays unsummarized and nothing is stored: the
      // calls to look at are the ones asked for before it.
      const runDefaultTask = vi.fn<
        (task: string, prompt: string, context?: object) => Promise<null>
      >(async (...call) => {
        prompts.push(call[1]);
        return null;
      });
      const chapters = Array.from({ length: 6 }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        summary: `Chapter ${index + 1}. ${"It argues the point at length. ".repeat(40)}`
      }));
      await serviceOver(
        { taskRouteCapacity, runDefaultTask },
        chapters
      ).summarizeHierarchiesForBatch("batch-id");
      // The first batch is a pair of chapters, not the book: the window takes no more.
      expect(prompts).toHaveLength(1);
      expect([...prompts[0]!.matchAll(/\[Subpart \d+:/gu)]).toHaveLength(2);
      expect(prompts[0]).toContain("[Subpart 1: Chapter 1]");
      expect(prompts[0]).toContain("[Subpart 2: Chapter 2]");
      expect(runDefaultTask.mock.calls[0]![2]).toMatchObject({
        operation: "hierarchy_summary",
        batchIndex: 0
      });
    });
  });

  it("builds the same aggregate prompt for the same subparts under any UUID assignment", async () => {
    const prompts: string[] = [];
    for (const [rootId, firstId, secondId] of uuidAssignments(3).map(
      (ids) => ids as [string, string, string]
    )) {
      const runDefaultTask = vi.fn(async (_taskType: string, prompt: string) => {
        prompts.push(prompt);
        return null;
      });
      const row = (childId: string, title: string) => ({
        rootId,
        rootType: "Book",
        rootTitle: "Learning mechanisms",
        rootLanguage: "en",
        documentId: `document-${rootId}`,
        documentHash: "document-hash",
        childId,
        childTitle: title,
        summaryId: `summary-${childId}`,
        summary: `Summary of ${title}.`,
        summaryHash: `hash-${title}`
      });
      const pool = {
        query: async (text: string) =>
          text.includes("with recursive hierarchy")
            ? { rows: [row(firstId, "Retrieval"), row(secondId, "Spacing")] }
            : { rows: [] }
      } as unknown as PgPool;
      const service = new KnowledgeService({
        getPool: () => pool,
        aiService: { runDefaultTask } as unknown as AiService,
        userDataPath: "/tmp/memora-test",
        getStorageSettings: async () => ({}) as never,
        getUploadedFilesBasePath: async () => null
      });
      await service.summarizeHierarchiesForBatch("batch-id");
    }
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(prompts[0]!.indexOf("[Subpart 1: Retrieval]")).toBeGreaterThan(-1);
    expect(prompts[0]!.indexOf("[Subpart 2: Spacing]")).toBeGreaterThan(
      prompts[0]!.indexOf("[Subpart 1: Retrieval]")
    );
  });
});

describe("note views", () => {
  const record = (metadata: Record<string, unknown>) =>
    ({
      id: "00000000-0000-4000-8000-000000000001",
      title: "Title",
      bodyMarkdown: "Body",
      ideaStatement: "Idea",
      language: "en",
      status: "active",
      ownership: "source",
      supersessionStatus: "current",
      createdFromSourceItemId: "00000000-0000-4000-8000-000000000002",
      sourceSpanId: null,
      evidenceChunkId: "00000000-0000-4000-8000-000000000003",
      generationModel: "model",
      generationPromptVersion: "atomic-note-v4",
      metadata,
      createdAt: new Date("2026-10-14T10:00:00.000Z"),
      updatedAt: new Date("2026-10-14T10:00:00.000Z")
    }) as unknown as Parameters<typeof serializeNote>[0];

  it("tells lists whether a person edited the note", () => {
    expect(serializeNote(record({ humanProtected: true })).humanProtected).toBe(true);
    for (const metadata of [{}, { humanProtected: "true" }, { humanProtected: false }])
      expect(serializeNote(record(metadata)).humanProtected).toBe(false);
    expect(atomicNoteViewSchema.parse(serializeNote(record({})))).toEqual(
      serializeNote(record({}))
    );
  });
});
