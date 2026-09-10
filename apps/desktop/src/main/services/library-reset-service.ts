import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { createLibraryResetRepository, type PgPool } from "@app/db";
import type { StorageSettings } from "../../shared/ipc.js";
import { parseManagedMarkdown } from "./obsidian-projection.js";

interface AssetPathRow {
  storage_base: string;
  relative_path: string;
}

interface SyncPathRow {
  memora_id: string;
  expected_content: string | null;
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
      pool.query<SyncPathRow>(`select memora_id,relative_path,null::text expected_content from obsidian_sync_files union all select p.memora_id,$1::text || '/.memora-recovery/' || p.id::text || suffix,case when suffix='.after.md' then p.content else p.before_content end from obsidian_projection_revisions p cross join unnest(array['.before.md','.after.md','.before.md.captured']) suffix`,[settings.managedRoot]),
      pool.query<{ count: string }>("select count(*)::text as count from source_items"),
      pool.query<{ count: string }>("select count(*)::text as count from atomic_notes")
    ]);

    const fileTargets = new Set<string>();
    for (const asset of assets.rows) {
      const basePath = asset.storage_base === "app_internal"
        ? join(this.options.userDataPath, "assets")
        : asset.storage_base === "uploaded_files"
          ? settings.uploadCopiesFolderPath
          : null;
      if (basePath) {
        const target = resolveInside(basePath, asset.relative_path);
        await rejectSymlinks(basePath, target);
        fileTargets.add(target);
      }
    }
    if (settings.obsidianVaultPath) {
      const vaultPath = resolve(settings.obsidianVaultPath);
      const managedPath = resolveInside(vaultPath, settings.managedRoot);
      for (const file of syncFiles.rows) {
        const target = resolveInside(vaultPath, file.relative_path);
        await rejectSymlinks(vaultPath, target);
        if (isInside(managedPath, target) && await isOwnedManagedFile(target, file.memora_id, file.expected_content)) {
          fileTargets.add(target);
        }
      }
      // Older worker deliveries used independent recovery IDs. Their filenames
      // are not in the projection outbox, but their managed target still is.
      const recoveryPath = resolveInside(managedPath, ".memora-recovery");
      await rejectSymlinks(vaultPath, recoveryPath);
      const knownIds = new Set(syncFiles.rows.map(file => file.memora_id));
      for (const name of await readDirectoryIfPresent(recoveryPath)) {
        if (!/^[0-9a-f-]{36}\.(before|after)\.md(?:\.captured)?$/i.test(name)) continue;
        const target = resolveInside(recoveryPath, name);
        await rejectSymlinks(vaultPath, target);
        const parsed = parseManagedMarkdown(await readFile(target, "utf8"));
        if (parsed && knownIds.has(parsed.frontmatter.memoraId)) fileTargets.add(target);
      }
    }

    // Delete before clearing the registry: failures retain ownership for retry.
    const results = await Promise.allSettled([...fileTargets].map((path) => rm(path, { force: true })));
    if (results.some(result => result.status === "rejected")) throw new Error("errors.common.permissionDenied");
    for (const name of ["assets", "tmp", "metadata-enrichment-cache.json"]) {
      const target = join(this.options.userDataPath, name);
      await rejectSymlinks(this.options.userDataPath, target);
      await rm(target, { recursive: true, force: true });
    }
    await rejectSymlinks(this.options.userDataPath, join(this.options.userDataPath, "local-models"));
    await removePartialDownloads(join(this.options.userDataPath, "local-models"));
    await createLibraryResetRepository(pool).reset();
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

async function readDirectoryIfPresent(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function isOwnedManagedFile(path: string, memoraId: string, expectedContent: string | null): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    if (expectedContent != null && content === expectedContent) return true;
    const parsed = parseManagedMarkdown(content);
    return parsed?.frontmatter.memoraId === memoraId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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

async function rejectSymlinks(base: string, target: string): Promise<void> {
  const parts = relative(resolve(base), target).split(sep);
  let current = resolve(base);
  for (const part of ["", ...parts]) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("errors.common.permissionDenied");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function removePartialDownloads(directory: string): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removePartialDownloads(path);
    else if (entry.isFile() && /\.(partial|part|tmp)$/.test(entry.name)) await rm(path);
  }
}
