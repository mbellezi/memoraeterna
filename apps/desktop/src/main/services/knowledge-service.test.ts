import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";

describe("hierarchical aggregate summaries", () => {
  it("adds the configured embedding to library queries for composite ranking", async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      }
    } as unknown as PgPool;
    const embedding = Array.from({ length: 256 }, (_, index) => index === 0 ? 1 : 0);
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: { runDefaultTask: vi.fn(async () => ({ output: embedding, modelId: "source-model" })) } as unknown as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await service.browseLibrary({ query: "semantic memory", sourceTypes: [], offset: 0, limit: 48 });

    expect(queries[0]?.text).toContain("source_embedding.target_type = 'source_item'");
    expect(queries[0]?.values?.[2]).toBe("semantic memory");
    expect(queries[0]?.values?.[8]).toBe("source-model");
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
    expect(queries[0]?.text).toContain("join source_items child on child.parent_source_item_id = aggregate_roots.root_id");
    expect(queries[0]?.text).toContain("order by aggregate_roots.maximum_depth");
    expect(queries[0]?.text).not.toContain("root.type in");
    expect(queries[0]?.text).toContain("hierarchy.root_id = $2::uuid");
    expect(queries[0]?.text).toContain("run.source_item_id in (hierarchy.root_id, hierarchy.child_id)");
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
      query: async (text: string) => text.includes("with recursive hierarchy")
        ? ({ rows: [{
            rootId: "paper-id", rootType: "AcademicPaper", rootTitle: "Paper", rootLanguage: "pt-BR",
            documentId: "document-id", documentHash: "document-hash", childId: "section-id",
            childTitle: "Section", summaryId: null, summary: null, summaryHash: null
          }] })
        : ({ rows: [] })
    } as unknown as PgPool;
    const service = new KnowledgeService({
      getPool: () => pool,
      aiService: {} as AiService,
      userDataPath: "/tmp/memora-test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null
    });

    await expect(service.summarizeHierarchiesForBatch(null, undefined, {}, "paper-id", true)).resolves.toEqual({
      generatedCount: 0,
      reusedCount: 0,
      blockedRoots: [{ sourceItemId: "paper-id", missingSummaryCount: 1, totalSubparts: 1 }]
    });
  });

  it("aggregates available direct-child summaries without waiting for empty subparts", async () => {
    const runDefaultTask = vi.fn(async (_taskType: string, _prompt: string) => null);
    const pool = {
      query: async (text: string) => {
        if (text.includes("with recursive hierarchy")) {
          return { rows: [
            {
              rootId: "paper-id", rootType: "AcademicPaper", rootTitle: "Paper", rootLanguage: "pt-BR",
              documentId: "document-id", documentHash: "document-hash", childId: "content-id",
              childTitle: "Content", summaryId: "summary-id", summary: "A substantive section summary.",
              summaryHash: "summary-hash"
            },
            {
              rootId: "paper-id", rootType: "AcademicPaper", rootTitle: "Paper", rootLanguage: "pt-BR",
              documentId: "document-id", documentHash: "document-hash", childId: "title-id",
              childTitle: "Title", summaryId: null, summary: null, summaryHash: null
            }
          ] };
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
      blockedRoots: []
    });
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    const prompt = runDefaultTask.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("A substantive section summary.");
    expect(prompt).not.toContain("[Subpart 2: Title]");
    expect(prompt).toContain('do not output "# Aggregate summary" or "# Resumo agregado"');
  });
});
