import type { QueryResult, QueryResultRow } from "pg";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PgPool } from "@app/db";
import { ObsidianSyncService } from "./obsidian-sync-service.js";

const settings = {
  obsidianVaultPath: "/tmp/memora-test-vault",
  managedRoot: "Memora",
  obsidianSyncEnabled: true,
  obsidianSyncPaused: false,
  deletionPolicy: "delete" as const,
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null,
  updatedAt: new Date(0).toISOString()
};

describe("ObsidianSyncService safety", () => {
  it("does not infer deletion from files missing in a reconciliation snapshot", async () => {
    const service = new ObsidianSyncService({
      getPool: () => new EmptyPool() as unknown as PgPool,
      getStorageSettings: async () => settings
    });

    await expect(service.reconcileSnapshot({
      requestId: "00000000-0000-4000-8000-000000000001",
      scannedAt: new Date(0).toISOString(),
      files: []
    })).resolves.toEqual({ synced: 0, conflicts: 0, deleted: 0 });
  });

  it("rejects a deletion event while a file still exists at the managed path", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "memora-obsidian-delete-"));
    const relativePath = "Memora/Sources/note.md";
    await mkdir(join(vaultPath, "Memora", "Sources"), { recursive: true });
    await writeFile(join(vaultPath, relativePath), "# Do not delete");
    const pool = new SyncRecordPool(relativePath);
    const service = new ObsidianSyncService({
      getPool: () => pool as unknown as PgPool,
      getStorageSettings: async () => ({ ...settings, obsidianVaultPath: vaultPath })
    });

    await expect(service.handleDeleted({
      eventId: "00000000-0000-4000-8000-000000000002",
      occurredAt: new Date(0).toISOString(),
      memoraId: "11111111-1111-4111-8111-111111111111",
      relativePath,
      syncVersion: 1
    })).resolves.toMatchObject({ accepted: false, syncStatus: "conflict" });
    expect(pool.queries.some((query) => query.startsWith("delete from source_items"))).toBe(false);
    await rm(vaultPath, { recursive: true, force: true });
  });

  it("skips metadata-only containers during projection", async () => {
    const service = new ObsidianSyncService({
      getPool: () => new ContainerPool() as unknown as PgPool,
      getStorageSettings: async () => settings
    });
    await expect(service.projectSource("11111111-1111-4111-8111-111111111111")).resolves.toEqual({ projected: 0 });
  });
});

class EmptyPool {
  async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
    return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
  }
}

class SyncRecordPool {
  readonly queries: string[] = [];

  public constructor(private readonly relativePath: string) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    const row = {
      id: "22222222-2222-4222-8222-222222222222",
      memoraId: "11111111-1111-4111-8111-111111111111",
      entityType: "source_item",
      entityId: "11111111-1111-4111-8111-111111111111",
      sourceItemId: "11111111-1111-4111-8111-111111111111",
      documentId: "33333333-3333-4333-8333-333333333333",
      memoraType: "source_item",
      relativePath: this.relativePath,
      frontmatterHash: "a".repeat(64),
      contentHash: "b".repeat(64),
      mtimeMs: 1,
      syncVersion: 1,
      status: text.startsWith("update") ? "conflict" : "synced",
      lastSyncedAt: new Date(0),
      deletedAt: null,
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0)
    };
    const rows = text.includes("obsidian_sync_files") ? [row] : [];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as T[] };
  }
}

class ContainerPool {
  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    const rows = text.includes("from source_items") ? [{
      id: "11111111-1111-4111-8111-111111111111", type: "Book", title: "Container", subtitle: null,
      sourceOrigin: "manual", sourceUri: null, externalId: null, parentSourceItemId: null,
      contentHash: null, language: "en", summary: null, summaryGeneratedAt: null,
      metadata: {}, createdAt: new Date(0), updatedAt: new Date(0)
    }] : [];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as T[] };
  }
}
