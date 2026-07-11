import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { PgPool } from "@app/db";

import { LibraryResetService } from "./library-reset-service.js";

describe("LibraryResetService", () => {
  it("removes managed knowledge files while preserving downloaded local models", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-library-reset-"));
    const uploads = join(root, "uploads");
    const vault = join(root, "vault");
    const internalAsset = join(root, "assets", "sha256", "aa", "bb", "internal.pdf");
    const uploadedAsset = join(uploads, "sha256", "cc", "dd", "copy.pdf");
    const obsidianFile = join(vault, "Memora", "Sources", "note.md");
    const unrelatedObsidianFile = join(vault, "Memora", "Sources", "unrelated.md");
    const localModel = join(root, "local-models", "installed", "model.gguf");
    await Promise.all([
      mkdir(join(internalAsset, ".."), { recursive: true }),
      mkdir(join(uploadedAsset, ".."), { recursive: true }),
      mkdir(join(obsidianFile, ".."), { recursive: true }),
      mkdir(join(localModel, ".."), { recursive: true })
    ]);
    await Promise.all([
      writeFile(internalAsset, "internal"),
      writeFile(uploadedAsset, "copy"),
      writeFile(obsidianFile, `---
memora_id: 11111111-1111-4111-8111-111111111111
memora_type: source_item
memora_managed: true
memora_sync_version: 1
memora_content_hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
---
managed`),
      writeFile(unrelatedObsidianFile, "# Personal note that is not managed by Memora"),
      writeFile(localModel, "model")
    ]);

    const pool = new ResetPool();
    const service = new LibraryResetService({
      getPool: () => pool as unknown as PgPool,
      getStorageSettings: async () => ({
        obsidianVaultPath: vault,
        managedRoot: "Memora",
        obsidianSyncEnabled: true,
        obsidianSyncPaused: false,
        deletionPolicy: "tombstone",
        uploadCopiesEnabled: true,
        uploadCopiesFolderPath: uploads,
        updatedAt: new Date(0).toISOString()
      }),
      userDataPath: root
    });

    const result = await service.reset();

    expect(result).toEqual({ deletedSources: 2, deletedAtomicNotes: 3, deletedFiles: 3, failedFiles: 0 });
    await expect(access(internalAsset)).rejects.toThrow();
    await expect(access(uploadedAsset)).rejects.toThrow();
    await expect(access(obsidianFile)).rejects.toThrow();
    await expect(access(unrelatedObsidianFile)).resolves.toBeUndefined();
    await expect(access(localModel)).resolves.toBeUndefined();
    expect(pool.queries.some((query) => query.includes("truncate table"))).toBe(true);
    expect(pool.queries.some((query) => query.includes("drop_graph"))).toBe(true);
    expect(pool.queries.findIndex((query) => query.includes("drop_graph")))
      .toBeLessThan(pool.queries.findIndex((query) => query.includes("truncate table")));
    await rm(root, { recursive: true, force: true });
  });
});

class ResetPool {
  readonly queries: string[] = [];

  async connect() {
    return {
      query: this.query.bind(this),
      release() {}
    };
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    let rows: QueryResultRow[] = [];
    if (text.includes("from document_assets")) {
      rows = [
        { storage_base: "app_internal", relative_path: "sha256/aa/bb/internal.pdf" },
        { storage_base: "uploaded_files", relative_path: "sha256/cc/dd/copy.pdf" }
      ];
    } else if (text.includes("from obsidian_sync_files")) {
      rows = [
        { memora_id: "11111111-1111-4111-8111-111111111111", relative_path: "Memora/Sources/note.md" },
        { memora_id: "22222222-2222-4222-8222-222222222222", relative_path: "Memora/Sources/unrelated.md" }
      ];
    } else if (text.includes("from source_items")) {
      rows = [{ count: "2" }];
    } else if (text.includes("from atomic_notes")) {
      rows = [{ count: "3" }];
    } else if (text.includes("from ag_catalog.ag_graph")) {
      rows = [{ exists: 1 }];
    }
    return {
      command: text.includes("truncate table") ? "TRUNCATE" : "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: rows as T[]
    };
  }
}
