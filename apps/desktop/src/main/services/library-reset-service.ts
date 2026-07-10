import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { PgPool } from "@app/db";
import type { StorageSettings } from "../../shared/ipc.js";

interface AssetPathRow {
  storage_base: string;
  relative_path: string;
}

interface SyncPathRow {
  relative_path: string;
}

export interface LibraryResetResult {
  deletedSources: number;
  deletedAtomicNotes: number;
  deletedFiles: number;
  failedFiles: number;
}

export class LibraryResetService {
  public constructor(private readonly options: {
    getPool: () => PgPool | null;
    getStorageSettings: () => Promise<StorageSettings>;
    userDataPath: string;
  }) {}

  public async reset(): Promise<LibraryResetResult> {
    const pool = this.requirePool();
    const settings = await this.options.getStorageSettings();
    const [assets, syncFiles, sourceCount, noteCount] = await Promise.all([
      pool.query<AssetPathRow>("select storage_base, relative_path from document_assets"),
      pool.query<SyncPathRow>("select relative_path from obsidian_sync_files"),
      pool.query<{ count: string }>("select count(*)::text as count from source_items"),
      pool.query<{ count: string }>("select count(*)::text as count from atomic_notes")
    ]);

    await pool.query(`truncate table
      similarity_debug_results, similarity_debug_runs,
      atomic_note_review_events, atomic_note_relations, atomic_note_entity_links, atomic_note_source_links, atomic_notes,
      claim_entity_links, claims, entity_relations, entity_mentions, entities,
      source_summaries, embeddings_256, embeddings_768, embeddings_1024, chunks, source_spans,
      document_assets, documents, source_item_bibliographic_links, bibliographic_instances,
      bibliographic_works, obsidian_sync_files, ingestion_runs, ai_task_runs, source_items, jobs
      restart identity cascade`);

    const fileTargets = new Set<string>();
    for (const asset of assets.rows) {
      const basePath = asset.storage_base === "app_internal"
        ? join(this.options.userDataPath, "assets")
        : asset.storage_base === "uploaded_files"
          ? settings.uploadCopiesFolderPath
          : null;
      if (basePath) fileTargets.add(resolveInside(basePath, asset.relative_path));
    }
    if (settings.obsidianVaultPath) {
      const vaultPath = resolve(settings.obsidianVaultPath);
      const managedPath = resolveInside(vaultPath, settings.managedRoot);
      for (const file of syncFiles.rows) {
        const target = resolveInside(vaultPath, file.relative_path);
        if (isInside(managedPath, target)) fileTargets.add(target);
      }
    }

    const results = await Promise.allSettled([...fileTargets].map((path) => rm(path, { force: true })));
    await Promise.all([
      rm(join(this.options.userDataPath, "assets"), { recursive: true, force: true }),
      rm(join(this.options.userDataPath, "tmp", "conversion"), { recursive: true, force: true })
    ]);
    await mkdir(join(this.options.userDataPath, "assets"), { recursive: true });

    return {
      deletedSources: Number(sourceCount.rows[0]?.count ?? 0),
      deletedAtomicNotes: Number(noteCount.rows[0]?.count ?? 0),
      deletedFiles: results.filter((result) => result.status === "fulfilled").length,
      failedFiles: results.filter((result) => result.status === "rejected").length
    };
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function resolveInside(basePath: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) throw new Error("errors.common.validationFailed");
  const base = resolve(basePath);
  const target = resolve(base, relativePath);
  if (!isInside(base, target)) throw new Error("errors.common.permissionDenied");
  return target;
}

function isInside(basePath: string, targetPath: string): boolean {
  const fromBase = relative(basePath, targetPath);
  return fromBase !== "" && fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !fromBase.startsWith(sep);
}
