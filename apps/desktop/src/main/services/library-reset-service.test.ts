import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    const recovery = join(vault, "Memora", ".memora-recovery", "recovery.before.md");
    const partial = join(root, "local-models", "installed", "model.gguf.partial");
    const transient = join(root, "tmp", "download.bin");
    const localModel = join(root, "local-models", "installed", "model.gguf");
    await Promise.all([
      mkdir(join(internalAsset, ".."), { recursive: true }),
      mkdir(join(uploadedAsset, ".."), { recursive: true }),
      mkdir(join(obsidianFile, ".."), { recursive: true }),
      mkdir(join(localModel, ".."), { recursive: true }),
      mkdir(join(recovery, ".."), { recursive: true }),
      mkdir(join(transient, ".."), { recursive: true })
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
      writeFile(localModel, "model"),
      writeFile(recovery, "Registered recovery without valid frontmatter"),
      writeFile(partial, "incomplete"),
      writeFile(transient, "download")
    ]);

    const legacyRecovery = join(vault, "Memora", ".memora-recovery", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.before.md.captured");
    const personalRecovery = join(vault, "Memora", ".memora-recovery", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.before.md");
    await writeFile(legacyRecovery, await readFile(obsidianFile));
    await writeFile(personalRecovery, "Unmanaged personal text");
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

    expect(result).toEqual({ deletedSources: 2, deletedAtomicNotes: 3, deletedFiles: 5, failedFiles: 0 });
    await expect(access(internalAsset)).rejects.toThrow();
    await expect(access(uploadedAsset)).rejects.toThrow();
    await expect(access(obsidianFile)).rejects.toThrow();
    await expect(access(unrelatedObsidianFile)).resolves.toBeUndefined();
    await expect(access(localModel)).resolves.toBeUndefined();
    for (const path of [recovery, legacyRecovery, partial, transient]) await expect(access(path)).rejects.toThrow();
    await expect(access(personalRecovery)).resolves.toBeUndefined();
    expect(pool.queries.some((query) => query.includes("truncate table"))).toBe(true);
    const truncate = pool.queries.find(query => query.includes("truncate table"))!;
    for (const table of ["wiki_pages", "wiki_evidence", "organization_settings_revisions", "maintenance_schedules", "local_model_downloads", "settings", "storage_settings", "integration_clients", "embeddings_256", "embeddings_768", "embeddings_1024"]) expect(truncate).toContain(`public."${table}"`);
    for (const table of ["ai_profile_sets", "ai_profile_tasks", "ai_provider_configs", "ai_task_profile_routes", "local_models", "local_model_files"]) expect(truncate).not.toContain(`public."${table}"`);
    expect(truncate).not.toContain("cascade");
    expect(pool.queries.some((query) => query.includes("drop_graph"))).toBe(true);
    expect(pool.queries.findIndex((query) => query.includes("drop_graph")))
      .toBeLessThan(pool.queries.findIndex((query) => query.includes("truncate table")));
    await rm(root, { recursive: true, force: true });
  });

  it("refuses symlinked managed storage before deleting files or database rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-reset-symlink-"));
    const pool = new ResetPool();
    try {
      await mkdir(join(root, "personal"));
      await writeFile(join(root, "personal", "keep.txt"), "personal");
      await symlink(join(root, "personal"), join(root, "assets"));
      const service = new LibraryResetService({ getPool: () => pool as unknown as PgPool,
        userDataPath: root, getStorageSettings: async () => ({ obsidianVaultPath: null,
          managedRoot: "Memora", obsidianSyncEnabled: false, obsidianSyncPaused: false,
          deletionPolicy: "tombstone", uploadCopiesEnabled: false,
          uploadCopiesFolderPath: null, updatedAt: new Date(0).toISOString() }) });
      await expect(service.reset()).rejects.toThrow("errors.common.permissionDenied");
      await expect(access(join(root, "personal", "keep.txt"))).resolves.toBeUndefined();
      expect(pool.queries.some(query => query.includes("truncate") || query.includes("drop_graph"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
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
        { memora_id: "33333333-3333-4333-8333-333333333333", relative_path: "Memora/.memora-recovery/recovery.before.md", expected_content: "Registered recovery without valid frontmatter" },
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
