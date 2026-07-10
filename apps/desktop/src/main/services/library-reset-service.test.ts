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
      writeFile(obsidianFile, "managed"),
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
    await expect(access(localModel)).resolves.toBeUndefined();
    expect(pool.queries.some((query) => query.includes("truncate table"))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});

class ResetPool {
  readonly queries: string[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    let rows: QueryResultRow[] = [];
    if (text.includes("from document_assets")) {
      rows = [
        { storage_base: "app_internal", relative_path: "sha256/aa/bb/internal.pdf" },
        { storage_base: "uploaded_files", relative_path: "sha256/cc/dd/copy.pdf" }
      ];
    } else if (text.includes("from obsidian_sync_files")) {
      rows = [{ relative_path: "Memora/Sources/note.md" }];
    } else if (text.includes("from source_items")) {
      rows = [{ count: "2" }];
    } else if (text.includes("from atomic_notes")) {
      rows = [{ count: "3" }];
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
