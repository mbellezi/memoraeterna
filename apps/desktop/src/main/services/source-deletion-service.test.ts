import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { SourceDeletionService } from "./source-deletion-service.js";

const rootSourceId = "11111111-1111-4111-8111-111111111111";
const childSourceId = "22222222-2222-4222-8222-222222222222";
const sectionSourceId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const noteId = "55555555-5555-4555-8555-555555555555";
const chunkId = "66666666-6666-4666-8666-666666666666";

describe("SourceDeletionService", () => {
  it("deletes a complete source tree and its owned application and Obsidian files", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-source-delete-"));
    const uploads = join(root, "uploads");
    const vault = join(root, "vault");
    const internalAsset = join(root, "assets", "sha256", "aa", "internal.pdf");
    const uploadedAsset = join(uploads, "sha256", "bb", "uploaded.pdf");
    const sourceProjection = join(vault, "Memora", "Sources", "source.md");
    const noteProjection = join(vault, "Memora", "Notes", "note.md");
    const unrelatedProjection = join(vault, "Memora", "Sources", "unrelated.md");
    await Promise.all([
      mkdir(join(internalAsset, ".."), { recursive: true }),
      mkdir(join(uploadedAsset, ".."), { recursive: true }),
      mkdir(join(sourceProjection, ".."), { recursive: true }),
      mkdir(join(noteProjection, ".."), { recursive: true })
    ]);
    await Promise.all([
      writeFile(internalAsset, "internal"),
      writeFile(uploadedAsset, "uploaded"),
      writeFile(sourceProjection, managedMarkdown(rootSourceId)),
      writeFile(noteProjection, managedMarkdown(noteId)),
      writeFile(unrelatedProjection, managedMarkdown("77777777-7777-4777-8777-777777777777"))
    ]);

    const pool = new DeletionPool();
    let projectedIds: string[] = [];
    let projectedEntityIds: string[] = [];
    const service = new SourceDeletionService({
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
      userDataPath: root,
      removeGraphProjections: async (sourceItemIds, entityIds) => {
        projectedIds = sourceItemIds;
        projectedEntityIds = entityIds;
      }
    });

    const result = await service.delete(rootSourceId);

    expect(result).toEqual({
      deletedSources: 3,
      deletedAtomicNotes: 1,
      deletedFiles: 4,
      failedFiles: 0,
      graphCleanupFailed: false
    });
    expect(projectedIds).toEqual([rootSourceId, childSourceId, sectionSourceId]);
    expect(projectedEntityIds).toEqual(["ffffffff-ffff-4fff-8fff-ffffffffffff"]);
    await expect(access(internalAsset)).rejects.toThrow();
    await expect(access(uploadedAsset)).rejects.toThrow();
    await expect(access(sourceProjection)).rejects.toThrow();
    await expect(access(noteProjection)).rejects.toThrow();
    await expect(access(unrelatedProjection)).resolves.toBeUndefined();
    expect(pool.queries.filter((query) => query.includes("delete from embeddings_")).length).toBe(
      3
    );
    expect(pool.queries.some((query) => query.includes("delete from ingestion_runs"))).toBe(true);
    expect(pool.queries.some((query) => query.includes("delete from obsidian_sync_files"))).toBe(
      true
    );
    expect(pool.queries.some((query) => query.includes("from ai_task_run_sources"))).toBe(true);
    expect(
      pool.queries.some((query) => query.includes("not exists (select 1 from ai_task_run_sources"))
    ).toBe(true);
    expect(pool.queries.some((query) => query.includes("delete from source_items"))).toBe(true);
    // The view history keeps title snapshots without foreign keys: they go in the same transaction,
    // after the entities are known and before the commit.
    const historyIndex = pool.queries.findIndex((query) =>
      query.startsWith("delete from view_history")
    );
    expect(historyIndex).toBeGreaterThan(
      pool.queries.findIndex((query) => query.startsWith("delete from entities"))
    );
    expect(historyIndex).toBe(pool.queries.length - 2);
    expect(pool.values[historyIndex]).toEqual([
      [rootSourceId, childSourceId, sectionSourceId],
      [noteId],
      ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
      [
        `memora://source/${rootSourceId}`,
        `memora://source/${childSourceId}`,
        `memora://source/${sectionSourceId}`
      ]
    ]);
    expect(pool.queries.at(-1)).toBe("commit");
    await rm(root, { recursive: true, force: true });
  });

  it("repairs the topic tree in the deleting transaction, after the delete and before the commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-source-delete-topics-"));
    const pool = new DeletionPool();
    const repairs: Array<{ client: unknown }> = [];
    const service = new SourceDeletionService({
      getPool: () => pool as unknown as PgPool,
      getStorageSettings: async () => ({
        obsidianVaultPath: null,
        managedRoot: "Memora",
        obsidianSyncEnabled: false,
        obsidianSyncPaused: false,
        deletionPolicy: "tombstone",
        uploadCopiesEnabled: false,
        uploadCopiesFolderPath: null,
        updatedAt: new Date(0).toISOString()
      }),
      userDataPath: root,
      removeGraphProjections: async () => undefined,
      topicHooks: {
        notesChanged: async () => undefined,
        sourcesChanged: async () => undefined,
        itemsRemoved: async (options) => {
          repairs.push({ client: options?.client });
          // The caller's statements and the hook's share one transaction: the hook's go through
          // the client it was given.
          await options?.client?.query("-- topic repair");
        }
      }
    });

    await service.delete(rootSourceId);

    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.client).toBeDefined();
    const repairIndex = pool.queries.indexOf("-- topic repair");
    expect(repairIndex).toBeGreaterThan(
      pool.queries.findIndex((query) => query.startsWith("delete from source_items"))
    );
    expect(repairIndex).toBe(pool.queries.length - 2);
    expect(pool.queries.at(-1)).toBe("commit");
    await rm(root, { recursive: true, force: true });
  });

  it("does not repair the tree when the source does not exist", async () => {
    const pool = new DeletionPool();
    pool.noSources = true;
    const itemsRemoved = vi.fn(async () => undefined);
    const service = new SourceDeletionService({
      getPool: () => pool as unknown as PgPool,
      getStorageSettings: async () => ({}) as never,
      userDataPath: tmpdir(),
      topicHooks: { notesChanged: vi.fn(), sourcesChanged: vi.fn(), itemsRemoved }
    });
    await expect(service.delete(rootSourceId)).resolves.toMatchObject({ deletedSources: 0 });
    expect(itemsRemoved).not.toHaveBeenCalled();
  });
});

class DeletionPool {
  /** The source tree query finds nothing: the source is already gone. */
  noSources = false;
  readonly queries: string[] = [];
  /** The parameters of each query, in the same order as `queries`. */
  readonly values: Array<readonly unknown[] | undefined> = [];

  async connect() {
    return {
      query: this.query.bind(this),
      release() {}
    };
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>> {
    const normalized = text.trim();
    this.queries.push(normalized);
    this.values.push(values);
    let rows: QueryResultRow[] = [];
    if (normalized.startsWith("with recursive source_tree")) {
      rows = this.noSources
        ? []
        : [{ id: rootSourceId }, { id: childSourceId }, { id: sectionSourceId }];
    } else if (normalized.startsWith("select id from documents")) {
      rows = [{ id: documentId }];
    } else if (normalized.startsWith("select id from atomic_notes")) {
      rows = [{ id: noteId }];
    } else if (normalized.startsWith("select id from chunks")) {
      rows = [{ id: chunkId }];
    } else if (normalized.startsWith("select distinct asset.storage_base")) {
      rows = [
        { storageBase: "app_internal", relativePath: "sha256/aa/internal.pdf" },
        { storageBase: "uploaded_files", relativePath: "sha256/bb/uploaded.pdf" }
      ];
    } else if (normalized.startsWith("select memora_id")) {
      rows = [
        { memoraId: rootSourceId, relativePath: "Memora/Sources/source.md" },
        { memoraId: noteId, relativePath: "Memora/Notes/note.md" },
        { memoraId: rootSourceId, relativePath: "Memora/Sources/unrelated.md" }
      ];
    } else if (normalized.startsWith("select id, job_id")) {
      rows = [
        {
          id: "88888888-8888-4888-8888-888888888888",
          jobId: "99999999-9999-4999-8999-999999999999",
          batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        }
      ];
    } else if (normalized.startsWith("select id from jobs")) {
      rows = [{ id: "99999999-9999-4999-8999-999999999999" }];
    } else if (normalized.startsWith("select ai_task_run_id")) {
      rows = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }];
    } else if (normalized.startsWith("select distinct work_id")) {
      rows = [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }];
    } else if (normalized.startsWith("select distinct instance_id")) {
      rows = [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }];
    } else if (normalized.startsWith("select distinct run.id")) {
      rows = [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }];
    } else if (normalized.startsWith("select entity_id as id")) {
      rows = [{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }];
    } else if (normalized.startsWith("delete from entities")) {
      rows = [{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }];
    }
    const isSourceDelete = normalized.startsWith("delete from source_items");
    return {
      command:
        normalized === "begin" || normalized === "commit" || normalized === "rollback"
          ? normalized.toUpperCase()
          : normalized.startsWith("delete")
            ? "DELETE"
            : "SELECT",
      rowCount: isSourceDelete ? 3 : rows.length,
      oid: 0,
      fields: [],
      rows: rows as T[]
    };
  }
}

function managedMarkdown(memoraId: string): string {
  return `---
memora_id: ${memoraId}
memora_type: source_item
memora_managed: true
memora_sync_version: 1
memora_content_hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
---
managed`;
}
