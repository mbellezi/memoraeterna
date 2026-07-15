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
});
