import { describe, expect, it } from "vitest";
import type { PgPool } from "@app/db";

import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";

describe("hierarchical aggregate summaries", () => {
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
      query: async () => ({
        rows: [{
          rootId: "paper-id", rootType: "AcademicPaper", rootTitle: "Paper", rootLanguage: "pt-BR",
          documentId: "document-id", documentHash: "document-hash", childId: "section-id",
          childTitle: "Section", summaryId: null, summary: null, summaryHash: null
        }]
      })
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
});
