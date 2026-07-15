import { describe, expect, it, vi } from "vitest";

import type { PgPool } from "../client.js";
import {
  createHierarchicalIngestionRepository,
  type DivisionPersistenceInput
} from "./hierarchicalIngestionRepository.js";

describe("hierarchical ingestion repository", () => {
  it("serializes division evidence arrays as JSON", async () => {
    const evidence = [{
      kind: "heading",
      source: "docling",
      score: 0.98,
      metadata: { blockType: "section_header", page: 1 }
    }];
    const division: DivisionPersistenceInput = {
      id: "division-1",
      parentId: null,
      kind: "chapter",
      title: "Chapter 1",
      level: 1,
      position: 0,
      startSelector: { blockIndex: 0 },
      endSelector: { blockIndex: 3 },
      startPage: 1,
      endPage: 3,
      confidence: 0.98,
      evidence,
      reviewStatus: "proposed",
      isProcessable: true,
      metadata: {}
    };
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("select status from document_structures")) {
        return { rows: [{ status: "in_review" }] };
      }
      if (text.includes("insert into document_divisions")) {
        return { rows: [{ id: "division-row-1" }] };
      }
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;
    const repository = createHierarchicalIngestionRepository(pool);
    repository.findById = vi.fn().mockResolvedValue(null);

    await repository.saveDraft("structure-1", [division]);

    const insert = clientQuery.mock.calls.find(([text]) => text.includes("insert into document_divisions"));
    expect(insert?.[1]?.[15]).toBe(JSON.stringify(evidence));
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("materializes reviewed creators, inherited metadata, and bibliographic pages", async () => {
    const now = new Date(0);
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("join documents document")) return { rows: [{
        rootSourceItemId: "00000000-0000-4000-8000-000000000001",
        rootDocumentId: "00000000-0000-4000-8000-000000000002",
        rootType: "Book", rootTitle: "Root book", sourceOrigin: "manual", language: "en",
        metadata: { descriptor: { type: "Book", title: "Root book", edition: "2", publisher: "Press", isbn13: "9780306406157" } },
        markdown: "# Chapter 1\n\nEvidence"
      }] };
      if (text.includes("from document_divisions division")) return { rows: [{
        id: "00000000-0000-4000-8000-000000000003", rowId: "00000000-0000-4000-8000-000000000004",
        structureId: "00000000-0000-4000-8000-000000000005", parentId: null,
        childSourceItemId: null, childDocumentId: null, kind: "chapter", title: "Chapter 1",
        level: 0, position: 0, startSelector: {}, endSelector: {}, startPage: 10, endPage: 20,
        markdownStart: 0, markdownEnd: 21, contentHash: null, confidence: 0.9, evidence: [],
        reviewStatus: "accepted", isProcessable: true,
        metadata: { creators: [{ name: "Chapter Author", role: "author" }] }, createdAt: now, updatedAt: now
      }] };
      if (text.includes("insert into source_items")) return { rows: [{ id: "00000000-0000-4000-8000-000000000006" }] };
      if (text.includes("insert into documents")) return { rows: [{ id: "00000000-0000-4000-8000-000000000007" }] };
      if (text.includes("coalesce(max(revision)")) return { rows: [{ revision: 1 }] };
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PgPool;

    const result = await createHierarchicalIngestionRepository(pool).materializeStructure(
      "00000000-0000-4000-8000-000000000005"
    );

    expect(result).toHaveLength(1);
    const sourceInsert = clientQuery.mock.calls.find(([text]) => text.includes("insert into source_items"));
    expect(sourceInsert?.[1]?.[2]).toBe("manual");
    expect(sourceInsert?.[1]?.[6]).toMatchObject({
      descriptor: { type: "BookChapter", creators: [{ name: "Chapter Author", role: "author" }] },
      inheritedBibliographic: { edition: "2", publisher: "Press", isbn13: "9780306406157" }
    });
    const bibliographicLink = clientQuery.mock.calls.find(([text]) => text.includes("insert into source_item_bibliographic_links"));
    expect(bibliographicLink?.[1]?.[3]).toBe("10-20");
  });
});
