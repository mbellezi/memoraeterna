import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { PgPool } from "../client.js";
import { createBibliographicRepository } from "./bibliographicRepository.js";
import { createChunkRepository } from "./chunkRepository.js";
import { createDocumentRepository } from "./documentRepository.js";
import { createHierarchicalIngestionRepository } from "./hierarchicalIngestionRepository.js";
import { createSourceEditingRepository } from "./sourceEditingRepository.js";
import { createSourceItemRepository } from "./sourceItemRepository.js";
import type { Queryable } from "./types.js";

/** The one character PostgreSQL text and jsonb parameters can never carry. */
const nul = "\0";

/** True when any query parameter holds U+0000, directly or inside (stringified) JSON. */
function carriesNul(values: readonly unknown[] | undefined): boolean {
  return JSON.stringify(values ?? []).includes("\\u0000");
}

class RecordingDb implements Queryable {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly row: QueryResultRow = {}) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    const rows = [this.row as T];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
  }

  get nulQueries() {
    return this.queries.filter((query) => carriesNul(query.values));
  }
}

describe("persistence guard for extracted text", () => {
  it("never sends U+0000 for document revisions, titles and metadata", async () => {
    const db = new RecordingDb({ id: "d1", metadata: {} });
    const documents = createDocumentRepository(db);
    await documents.create({
      sourceItemId: "s1",
      title: `Replication${nul} paper`,
      canonicalMarkdown: `Q ( t ) ${nul} a 1 and ${nul} b`,
      contentHash: "a".repeat(64),
      metadata: { engine: "docling", warnings: [`bad${nul}`], [`key${nul}`]: 1 }
    });
    await documents.update("d1", { canonicalMarkdown: `edited${nul}`, title: `t${nul}` });

    expect(db.queries).toHaveLength(2);
    expect(db.nulQueries).toEqual([]);
    expect(db.queries[0]?.values).toContain("Q ( t )  a 1 and  b");
    expect(db.queries[0]?.values).toContain("Replication paper");
    expect(db.queries[1]?.values).toContain("edited");
  });

  it("passes clean document text through as the identical string", async () => {
    const db = new RecordingDb({ id: "d1", metadata: {} });
    const markdown = "# Title\n\nCafé − 😀\r\n\ttabbed\n";
    await createDocumentRepository(db).create({
      sourceItemId: "s1",
      title: "Clean",
      canonicalMarkdown: markdown,
      contentHash: "b".repeat(64)
    });
    expect(db.queries[0]?.values).toContain(markdown);
  });

  it("never sends U+0000 for source item metadata", async () => {
    const db = new RecordingDb({ id: "s1", metadata: {} });
    const sources = createSourceItemRepository(db);
    await sources.create({
      type: "AcademicPaper",
      title: `Murre${nul} and Dros`,
      sourceOrigin: "file_upload",
      metadata: { descriptor: { creators: [{ name: `Jaap${nul} Murre`, role: "author" }] } }
    });
    await sources.update("s1", { title: `Retitled${nul}`, metadata: { note: `n${nul}` } });
    expect(db.nulQueries).toEqual([]);
  });

  it("never sends U+0000 for chunks and their source spans", async () => {
    const db = new RecordingDb({ id: "c1", chunkIndex: 0, tokenCount: null, metadata: {} });
    await createChunkRepository(db).replaceDocumentChunks("d1", "s1", [
      {
        id: "00000000-0000-4000-8000-000000000001",
        sourceSpanId: "00000000-0000-4000-8000-000000000002",
        chunkIndex: 0,
        content: `Q ( t ) ${nul} a`,
        contentHash: "c".repeat(64),
        metadata: { heading: `H${nul}` },
        span: {
          id: "00000000-0000-4000-8000-000000000002",
          startOffset: 0,
          endOffset: 10,
          label: `lab${nul}el`,
          selector: `sel${nul}`
        }
      }
    ]);
    const inserts = db.queries.filter((query) => query.text.includes("insert into"));
    expect(inserts).toHaveLength(2);
    expect(db.nulQueries).toEqual([]);
    expect(String(inserts[1]?.values[2])).toContain("Q ( t )  a");
  });

  it("never sends U+0000 for division titles, selectors and evidence", async () => {
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("select status from document_structures"))
        return { rows: [{ status: "in_review" }] };
      if (text.includes("insert into document_divisions")) return { rows: [{ id: "row-1" }] };
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client)
    } as unknown as PgPool;
    const repository = createHierarchicalIngestionRepository(pool);
    repository.findById = vi.fn().mockResolvedValue(null);

    await repository.saveDraft("structure-1", [
      {
        id: "division-1",
        parentId: null,
        kind: "chapter",
        title: `Intro${nul}duction`,
        level: 0,
        position: 0,
        startSelector: { format: "pdf", bookmark: `Intro${nul}duction` },
        endSelector: { format: "pdf" },
        confidence: 0.9,
        evidence: [
          { kind: "native-outline", source: "pdfjs-outline", metadata: { pageLabel: `i${nul}` } }
        ],
        reviewStatus: "proposed",
        isProcessable: true,
        metadata: { note: `n${nul}` }
      }
    ]);

    const insert = clientQuery.mock.calls.find(([text]) =>
      text.includes("insert into document_divisions")
    );
    expect(insert?.[1]?.[4]).toBe("Introduction");
    expect(carriesNul(insert?.[1] as unknown[])).toBe(false);
  });

  it("never sends U+0000 for bibliographic works, instances and links", async () => {
    const db = new RecordingDb({ id: "w1", creators: [], identifiers: {}, metadata: {} });
    const repository = createBibliographicRepository(db);
    await repository.createWork({
      type: "article",
      title: `Replication${nul}`,
      creators: [{ name: `Jaap${nul} Murre`, role: "author" }],
      identifiers: { doi: `10.1371/x${nul}` }
    });
    await repository.createInstance({
      workId: "w1",
      type: "article",
      publisher: `PLOS${nul}`,
      creators: [{ name: `Joeri${nul} Dros`, role: "author" }]
    });
    await repository.linkSource({ sourceItemId: "s1", workId: "w1", pages: `1${nul}-3` });
    expect(db.queries).toHaveLength(3);
    expect(db.nulQueries).toEqual([]);
  });

  it("never sends U+0000 when an editorial save writes a revision", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const sourceRow = {
      id: "s1",
      type: "AcademicPaper",
      title: "Old",
      metadata: {},
      parentSourceItemId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    };
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes("select updated_at")) return { rows: [{ updatedAt }] };
        if (text.includes("from ingestion_runs")) return { rows: [] };
        if (text.startsWith("insert into documents"))
          return { rows: [{ id: "d2", contentHash: "e".repeat(64), metadata: {} }] };
        if (text.includes("from source_items") || text.startsWith("update source_items"))
          return { rows: [sourceRow] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: client.query
    } as unknown as PgPool;

    await createSourceEditingRepository(pool).save({
      sourceItemId: "s1",
      expectedUpdatedAt: updatedAt.toISOString(),
      title: `New${nul} title`,
      subtitle: null,
      language: "en",
      sourceUri: null,
      descriptor: { creators: [{ name: `Ada${nul}`, role: "author" }], title: `New${nul}` },
      content: { documentId: null, markdown: `body ${nul} text`, hash: "e".repeat(64) }
    });

    expect(queries.some((query) => query.text.startsWith("insert into documents"))).toBe(true);
    expect(queries.filter((query) => carriesNul(query.values))).toEqual([]);
  });
});
