import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { PgPool } from "@app/db";

import { IngestionService } from "./ingestion-service.js";

describe("IngestionService containers", () => {
  it("persists a typed book and bibliographic data without creating a document or run", async () => {
    const pool = new ContainerPool();
    const service = new IngestionService({
      getPool: () => pool as unknown as PgPool,
      getStorageSettings: async () => ({
        obsidianVaultPath: null, managedRoot: "Memora", obsidianSyncEnabled: false,
        obsidianSyncPaused: false, deletionPolicy: "delete", uploadCopiesEnabled: false,
        uploadCopiesFolderPath: null, updatedAt: new Date(0).toISOString()
      }),
      userDataPath: "/tmp/memora-ingestion-test",
      resourcesPath: "/tmp/resources",
      workspaceRoot: "/tmp/workspace",
      isPackaged: false
    });

    const result = await service.createContainerSource({
      descriptor: {
        type: "Book", title: "The Dispossessed", language: "en",
        creators: [{ name: "Ursula K. Le Guin", role: "author" }], tags: [], subjects: [],
        isbn13: "9780061054884", publisher: "Harper", pageCount: 400,
        provenance: { title: { source: "manual" } }
      },
      duplicatePolicy: "ignore"
    });

    expect(result).toMatchObject({ documentId: null, ingestionRunId: null, duplicate: false });
    expect(pool.queries.some((query) => query.includes("insert into source_items"))).toBe(true);
    expect(pool.queries.some((query) => query.includes("insert into bibliographic_works"))).toBe(true);
    expect(pool.queries.some((query) => query.includes("documents") || query.includes("ingestion_runs"))).toBe(false);
  });
});

class ContainerPool {
  readonly queries: string[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    const now = new Date(0);
    const rows = text.includes("insert into source_items") ? [{
      id: "00000000-0000-4000-8000-000000000001", type: "Book", title: "The Dispossessed",
      subtitle: null, sourceOrigin: "manual", sourceUri: null, externalId: null,
      parentSourceItemId: null, contentHash: null, language: "en", summary: null,
      summaryGeneratedAt: null, metadata: {}, createdAt: now, updatedAt: now
    }] : text.includes("insert into bibliographic_works") ? [{
      id: "00000000-0000-4000-8000-000000000002", type: "book", title: "The Dispossessed",
      subtitle: null, canonicalTitle: null, language: "en", creators: [], identifiers: {},
      metadata: {}, createdAt: now, updatedAt: now
    }] : text.includes("insert into bibliographic_instances")
      ? [{ id: "00000000-0000-4000-8000-000000000003" }]
      : [];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as T[] };
  }
}
