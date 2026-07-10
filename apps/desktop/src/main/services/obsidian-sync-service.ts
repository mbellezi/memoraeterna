import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createAtomicNoteRepository,
  createDocumentRepository,
  createIngestionRunRepository,
  createJobRepository,
  createObsidianSyncRepository,
  createSourceItemRepository,
  type AtomicNoteRecord,
  type DocumentRecord,
  type ObsidianSyncFileRecord,
  type PgPool,
  type SourceItemRecord
} from "@app/db";
import { createTextBlocks, normalizeMarkdown, sha256 } from "@app/conversion";
import type {
  ImportObsidianNoteRequest,
  IntegrationCommandResult,
  ObsidianFileChangedEvent,
  ObsidianFileDeletedEvent,
  ObsidianFileMovedEvent,
  ObsidianReconciliationRequest,
  ObsidianManagedFrontmatter
} from "@app/integration-contracts";
import type { StorageSettings } from "../../shared/ipc.js";

import {
  collisionFileName,
  parseManagedMarkdown,
  renderObsidianProjection
} from "./obsidian-projection.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

export interface ObsidianSyncServiceOptions {
  getPool: () => PgPool | null;
  getStorageSettings: () => Promise<StorageSettings>;
  writeProjection?: (input: {
    vaultPath: string;
    relativePath: string;
    content: string;
  }) => Promise<{ mtimeMs: number }>;
}

export class ObsidianSyncService {
  private readonly workers = new WorkerSupervisor();

  public constructor(private readonly options: ObsidianSyncServiceOptions) {}

  public async shutdown(): Promise<void> {
    await this.workers.shutdown();
  }

  public async projectSource(sourceItemId: string): Promise<{ projected: number }> {
    const settings = await this.options.getStorageSettings();
    if (!isSyncActive(settings)) return { projected: 0 };
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    if (!source) throw new Error("source_item_not_found");
    const document = (await createDocumentRepository(pool).listBySourceItem(sourceItemId))[0];
    if (!document) throw new Error("document_not_found");
    let projected = await this.projectEntity(settings, source, document);
    const notes = await createAtomicNoteRepository(pool).listBySourceItem(sourceItemId);
    for (const note of notes) projected += await this.projectAtomicNote(settings, source, document, note);
    return { projected };
  }

  public async importNote(
    input: ImportObsidianNoteRequest & { frontmatter: ObsidianManagedFrontmatter }
  ): Promise<IntegrationCommandResult> {
    const pool = this.requirePool();
    const syncFiles = createObsidianSyncRepository(pool);
    const existing = await syncFiles.findByMemoraId(input.frontmatter.memoraId);
    if (existing && input.frontmatter.memoraSyncVersion !== existing.syncVersion
        && input.contentHash !== existing.contentHash) {
      await syncFiles.update(existing.id, {
        status: "conflict",
        metadata: { ...existing.metadata, conflictDetectedAt: new Date().toISOString() }
      });
      return { requestId: input.requestId, accepted: false, syncStatus: "conflict" };
    }
    const body = normalizeMarkdown(input.markdown);
    const contentHash = sha256(body);
    if (contentHash !== stripHashPrefix(input.contentHash)) throw new Error("obsidian_content_hash_mismatch");
    if (existing?.contentHash === contentHash) {
      await syncFiles.update(existing.id, {
        relativePath: normalizeRelativePath(input.relativePath),
        mtimeMs: input.mtimeMs,
        status: "synced",
        lastSyncedAt: new Date()
      });
      return { requestId: input.requestId, accepted: true, syncStatus: "synced" };
    }
    const sourceItemId = input.frontmatter.memoraSourceId
      ?? (input.frontmatter.memoraType === "source_item" ? input.frontmatter.memoraId : existing?.sourceItemId)
      ?? null;
    const documentId = input.frontmatter.memoraDocumentId ?? existing?.documentId ?? null;
    if (input.frontmatter.memoraType === "source_item") {
      if (!sourceItemId || !documentId) throw new Error("obsidian_source_identity_missing");
      await this.updateSourceDocument(sourceItemId, documentId, body, contentHash);
    } else {
      const notes = createAtomicNoteRepository(pool);
      const note = await notes.findById(input.frontmatter.memoraId);
      if (!note) throw new Error("atomic_note_not_found");
      await notes.review({ id: note.id, action: "edit", bodyMarkdown: stripProjectedTitle(body, note.title) });
    }
    const recordInput = {
      memoraId: input.frontmatter.memoraId,
      entityType: input.frontmatter.memoraType,
      entityId: input.frontmatter.memoraId,
      sourceItemId,
      documentId,
      memoraType: input.frontmatter.memoraType,
      relativePath: normalizeRelativePath(input.relativePath),
      frontmatterHash: sha256(JSON.stringify(input.frontmatter)),
      contentHash,
      mtimeMs: input.mtimeMs,
      syncVersion: existing?.syncVersion ?? input.frontmatter.memoraSyncVersion,
      status: "synced" as const,
      lastSyncedAt: new Date(),
      metadata: existing?.metadata ?? {}
    };
    if (existing) {
      await syncFiles.update(existing.id, recordInput);
    } else {
      await syncFiles.create(recordInput);
    }
    return {
      requestId: input.requestId,
      accepted: true,
      ...(sourceItemId ? { sourceItemId } : {}),
      ...(documentId ? { documentId } : {}),
      syncStatus: "synced"
    };
  }

  public async handleChanged(event: ObsidianFileChangedEvent): Promise<IntegrationCommandResult> {
    return this.importNote(event.note);
  }

  public async handleMoved(event: ObsidianFileMovedEvent): Promise<IntegrationCommandResult> {
    const repository = createObsidianSyncRepository(this.requirePool());
    const record = await repository.findByMemoraId(event.memoraId)
      ?? await repository.findByRelativePath(normalizeRelativePath(event.previousRelativePath));
    if (!record) return { requestId: event.eventId, accepted: false, syncStatus: "ignored" };
    if (event.syncVersion !== record.syncVersion) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    const collision = await repository.findByRelativePath(normalizeRelativePath(event.relativePath));
    if (collision && collision.id !== record.id) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    await repository.update(record.id, {
      relativePath: normalizeRelativePath(event.relativePath),
      mtimeMs: event.mtimeMs,
      status: "synced",
      lastSyncedAt: new Date()
    });
    return { requestId: event.eventId, accepted: true, syncStatus: "synced" };
  }

  public async handleDeleted(event: ObsidianFileDeletedEvent): Promise<IntegrationCommandResult> {
    const pool = this.requirePool();
    const repository = createObsidianSyncRepository(pool);
    const record = await repository.findByMemoraId(event.memoraId)
      ?? await repository.findByRelativePath(normalizeRelativePath(event.relativePath));
    if (!record) return { requestId: event.eventId, accepted: false, syncStatus: "ignored" };
    if (event.syncVersion !== record.syncVersion) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    const settings = await this.options.getStorageSettings();
    const deletedAt = new Date();
    await repository.update(record.id, {
      status: "deleted",
      deletedAt,
      metadata: { ...record.metadata, deletePolicy: settings.deletionPolicy, tombstonedAt: deletedAt.toISOString() }
    });
    if (record.memoraType === "atomic_note") {
      const notes = createAtomicNoteRepository(pool);
      if (settings.deletionPolicy === "delete") await notes.review({ id: record.entityId, action: "discard" });
      if (settings.deletionPolicy === "archive") await notes.setStatus(record.entityId, "archived");
    } else if (record.sourceItemId) {
      const sources = createSourceItemRepository(pool);
      const source = await sources.findById(record.sourceItemId);
      if (source && settings.deletionPolicy === "delete") {
        await sources.remove(source.id);
      } else if (source && settings.deletionPolicy === "archive") {
        await sources.update(source.id, {
          metadata: { ...source.metadata, obsidianArchivedAt: deletedAt.toISOString() }
        });
      } else if (source) {
        await sources.update(source.id, {
          metadata: { ...source.metadata, obsidianTombstonedAt: deletedAt.toISOString() }
        });
      }
    }
    return { requestId: event.eventId, accepted: true, syncStatus: "deleted" };
  }

  public async reconcileSnapshot(input: ObsidianReconciliationRequest): Promise<{ synced: number; conflicts: number; deleted: number }> {
    const repository = createObsidianSyncRepository(this.requirePool());
    const seen = new Set<string>();
    let synced = 0;
    let conflicts = 0;
    for (const file of input.files) {
      seen.add(file.frontmatter.memoraId);
      const existing = await repository.findByMemoraId(file.frontmatter.memoraId);
      if (existing && existing.relativePath !== normalizeRelativePath(file.relativePath)) {
        const moved = await this.handleMoved({
          eventId: randomUUID(),
          occurredAt: input.scannedAt,
          memoraId: file.frontmatter.memoraId,
          previousRelativePath: existing.relativePath,
          relativePath: file.relativePath,
          syncVersion: file.frontmatter.memoraSyncVersion,
          mtimeMs: file.mtimeMs
        });
        if (moved.syncStatus === "conflict") conflicts += 1;
      }
      if (!existing || existing.contentHash !== stripHashPrefix(file.contentHash) || existing.mtimeMs !== file.mtimeMs) {
        if (file.markdown === undefined) continue;
        const result = await this.importNote({
          requestId: randomUUID(),
          relativePath: file.relativePath,
          markdown: file.markdown,
          frontmatter: file.frontmatter,
          contentHash: file.contentHash,
          mtimeMs: file.mtimeMs
        });
        if (result.syncStatus === "conflict") conflicts += 1;
        else if (result.syncStatus === "synced") synced += 1;
      }
    }
    let deleted = 0;
    for (const record of await repository.list()) {
      if (record.status === "deleted" || seen.has(record.memoraId)) continue;
      await this.handleDeleted({
        eventId: randomUUID(),
        occurredAt: input.scannedAt,
        memoraId: record.memoraId,
        relativePath: record.relativePath,
        syncVersion: record.syncVersion
      });
      deleted += 1;
    }
    return { synced, conflicts, deleted };
  }

  public async reconcileVault(): Promise<{ synced: number; conflicts: number; deleted: number }> {
    const settings = await this.options.getStorageSettings();
    if (!isSyncActive(settings)) return { synced: 0, conflicts: 0, deleted: 0 };
    const vaultPath = settings.obsidianVaultPath!;
    if (!await pathExists(vaultPath)) throw new Error("obsidian_vault_unavailable");
    const managedPath = resolve(vaultPath, settings.managedRoot);
    if (!isInside(resolve(vaultPath), managedPath)) throw new Error("unsafe_obsidian_root");
    if (!await pathExists(managedPath)) return { synced: 0, conflicts: 0, deleted: 0 };
    const files = await listMarkdownFiles(managedPath);
    const snapshots: ObsidianReconciliationRequest["files"] = [];
    for (const fullPath of files) {
      const raw = await readFile(fullPath, "utf8");
      const parsed = parseManagedMarkdown(raw);
      if (!parsed) continue;
      const file = await stat(fullPath);
      snapshots.push({
        relativePath: relative(vaultPath, fullPath).split(sep).join("/"),
        frontmatter: parsed.frontmatter,
        contentHash: sha256(normalizeMarkdown(parsed.bodyMarkdown)),
        mtimeMs: Math.trunc(file.mtimeMs),
        markdown: parsed.bodyMarkdown
      });
    }
    return this.reconcileSnapshot({ requestId: randomUUID(), scannedAt: new Date().toISOString(), files: snapshots });
  }

  private async projectEntity(settings: StorageSettings, source: SourceItemRecord, document: DocumentRecord): Promise<number> {
    return this.writeEntity(settings, {
      memoraId: source.id,
      memoraType: "source_item",
      entityType: "source_item",
      entityId: source.id,
      sourceItemId: source.id,
      documentId: document.id,
      title: source.title,
      bodyMarkdown: document.canonicalMarkdown,
      sourceType: source.type,
      sourceUri: source.sourceUri,
      date: source.updatedAt
    });
  }

  private async projectAtomicNote(
    settings: StorageSettings,
    source: SourceItemRecord,
    document: DocumentRecord,
    note: AtomicNoteRecord
  ): Promise<number> {
    return this.writeEntity(settings, {
      memoraId: note.id,
      memoraType: "atomic_note",
      entityType: "atomic_note",
      entityId: note.id,
      sourceItemId: source.id,
      documentId: document.id,
      title: note.title,
      bodyMarkdown: `# ${note.title}\n\n${note.bodyMarkdown}`,
      date: note.updatedAt
    });
  }

  private async writeEntity(settings: StorageSettings, input: {
    memoraId: string;
    memoraType: "source_item" | "atomic_note";
    entityType: string;
    entityId: string;
    sourceItemId: string;
    documentId: string;
    title: string;
    bodyMarkdown: string;
    sourceType?: string;
    sourceUri?: string | null;
    date: Date;
  }): Promise<number> {
    const pool = this.requirePool();
    const repository = createObsidianSyncRepository(pool);
    const existing = await repository.findByMemoraId(input.memoraId);
    const bodyMarkdown = normalizeMarkdown(input.bodyMarkdown);
    const contentHash = sha256(bodyMarkdown);
    const syncVersion = existing ? existing.syncVersion + (existing.contentHash === contentHash ? 0 : 1) : 1;
    const rendered = renderObsidianProjection({
      managedRoot: settings.managedRoot,
      memoraId: input.memoraId,
      memoraType: input.memoraType,
      sourceItemId: input.sourceItemId,
      documentId: input.documentId,
      title: input.title,
      bodyMarkdown,
      contentHash,
      syncVersion,
      ...(input.sourceType ? { sourceType: input.sourceType } : {}),
      ...(input.sourceUri !== undefined ? { sourceUri: input.sourceUri } : {}),
      date: input.date
    });
    let relativePath = existing?.relativePath;
    const vaultPath = settings.obsidianVaultPath!;
    if (!relativePath) relativePath = await this.selectAvailablePath(
      repository,
      vaultPath,
      rendered.relativeDirectory,
      rendered.baseFileName,
      input.date,
      input.memoraId
    );
    if (existing?.contentHash === contentHash && await pathExists(resolve(vaultPath, relativePath))) return 0;
    const output = await this.writeProjection({ vaultPath, relativePath, content: rendered.markdown });
    const persistence = {
      memoraId: input.memoraId,
      entityType: input.entityType,
      entityId: input.entityId,
      sourceItemId: input.sourceItemId,
      documentId: input.documentId,
      memoraType: input.memoraType,
      relativePath,
      frontmatterHash: sha256(rendered.frontmatterText),
      contentHash,
      mtimeMs: output.mtimeMs,
      syncVersion,
      status: "synced" as const,
      lastSyncedAt: new Date(),
      deletedAt: null,
      metadata: existing?.metadata ?? {}
    };
    if (existing) await repository.update(existing.id, persistence);
    else await repository.create(persistence);
    return 1;
  }

  private async selectAvailablePath(
    repository: ReturnType<typeof createObsidianSyncRepository>,
    vaultPath: string,
    directory: string,
    baseName: string,
    date: Date,
    memoraId: string
  ): Promise<string> {
    for (let attempt = 0; attempt <= 100; attempt += 1) {
      const candidate = posix.join(directory, collisionFileName(baseName, date, attempt, memoraId));
      if (!await repository.findByRelativePath(candidate) && !await pathExists(resolve(vaultPath, candidate))) return candidate;
    }
    throw new Error("obsidian_path_collision_exhausted");
  }

  private async writeProjection(input: { vaultPath: string; relativePath: string; content: string }): Promise<{ mtimeMs: number }> {
    if (this.options.writeProjection) return this.options.writeProjection(input);
    const result = await this.workers.execute("obsidian-sync", { action: "write", ...input });
    if (typeof result.mtimeMs !== "number") throw new Error("obsidian_worker_invalid_result");
    return { mtimeMs: result.mtimeMs };
  }

  private async updateSourceDocument(sourceItemId: string, documentId: string, markdown: string, contentHash: string): Promise<void> {
    const pool = this.requirePool();
    const sources = createSourceItemRepository(pool);
    const documents = createDocumentRepository(pool);
    const source = await sources.findById(sourceItemId);
    const document = await documents.findById(documentId);
    if (!source || !document || document.sourceItemId !== sourceItemId) throw new Error("obsidian_source_not_found");
    await documents.update(documentId, { canonicalMarkdown: markdown, contentHash });
    await sources.update(sourceItemId, { contentHash });
    const run = await createIngestionRunRepository(pool).create({
      sourceItemId,
      currentStage: "chunking",
      stagesCheckpoint: {
        conversion: { status: "completed", completedAt: new Date().toISOString(), metadata: { engine: "obsidian" } }
      }
    });
    const job = await createJobRepository(pool).create({
      type: "ingestion",
      payload: {
        ingestionRunId: run.id,
        sourceItemId,
        documentId,
        markdown,
        blocks: createTextBlocks(markdown)
      }
    });
    await createIngestionRunRepository(pool).update(run.id, { jobId: job.id });
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function isSyncActive(settings: StorageSettings): boolean {
  return settings.obsidianSyncEnabled && !settings.obsidianSyncPaused && Boolean(settings.obsidianVaultPath);
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.split("/").includes("..")) throw new Error("unsafe_obsidian_path");
  return normalized;
}

function stripHashPrefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice(7) : hash;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listMarkdownFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files;
}

function stripProjectedTitle(markdown: string, title: string): string {
  const heading = `# ${title}`;
  return markdown.startsWith(`${heading}\n`) ? markdown.slice(heading.length).trimStart() : markdown;
}
