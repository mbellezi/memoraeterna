import { SourceEditorialService } from "./source-editorial-service.js";
import { ObsidianEditorialService } from "./obsidian-editorial-service.js";
import { safeVaultPath } from "../workers/obsidian-sync.worker.js";
import { isOutwardProjection, parseObsidianMarkdown, serializeManagedFrontmatter, normalizeProjectionText } from "@app/integration-contracts";
import { ObsidianWikiProjection } from "./obsidian-wiki-projection.js";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentRepository,
  createObsidianSyncRepository,
  createSourceItemRepository,
  type AtomicNoteRecord,
  type AtomicNoteRelationRecord,
  type DocumentRecord,
  type ObsidianSyncFileRecord,
  type PgPool,
  type SourceItemRecord
} from "@app/db";
import { normalizeMarkdown as normalizeLegacyMarkdown, sha256 } from "@app/conversion";
import type {
  ImportObsidianNoteRequest,
  IntegrationCommandResult,
  ObsidianFileChangedEvent,
  ObsidianFileDeletedEvent,
  ObsidianFileMovedEvent,
  ObsidianReconciliationRequest,
  ObsidianManagedFrontmatter
} from "@app/integration-contracts";
import type { ObsidianSyncStatus, StorageSettings } from "../../shared/ipc.js";

import {
  appendObsidianRelations,
  collisionFileName,
  parseManagedMarkdown,
  renderObsidianProjection,
  slugify,
  stripObsidianRelations,
  type ObsidianRelatedNote
} from "./obsidian-projection.js";
import { WorkerSupervisor } from "./worker-supervisor.js";

export interface ObsidianSyncServiceOptions {
  getPool: () => PgPool | null;
  getStorageSettings: () => Promise<StorageSettings>;
  getLocale?: () => Promise<string>;
  writeProjection?: (input: {
    vaultPath: string;
    relativePath: string;
    content: string;
    expectedHash?: string | null; recoveryId?: string; managedRoot?: string;
  }) => Promise<{ mtimeMs: number }>;
}

export class ObsidianSyncService {
  private readonly workers = new WorkerSupervisor();
  private synchronizationPromise: Promise<void> | null = null;
  private synchronizationStatus: ObsidianSyncStatus = createIdleSynchronizationStatus();

  public readonly wiki: ObsidianWikiProjection;
  public readonly editorial: ObsidianEditorialService;
  public constructor(private readonly options: ObsidianSyncServiceOptions) {
    this.wiki = new ObsidianWikiProjection({...options, projectSource:(id,notes,binding)=>this.projectSource(id,notes,binding),write:(input)=>this.writeProjection(input)});
    this.editorial = new ObsidianEditorialService({...options,wiki:this.wiki,write:input=>this.writeProjection(input)});
  }

  public async shutdown(): Promise<void> {
    await this.workers.shutdown();
  }

  public async projectSource(sourceItemId: string, allowedNoteIds?: Set<string>, admittedBinding?:string): Promise<{ projected: number }> {
    const settings = await this.options.getStorageSettings();
    if (!isSyncActive(settings)) return { projected: 0 };
    const binding=await this.wiki.sourceAdmission(settings,admittedBinding);
    const pool = this.requirePool();
    if(!allowedNoteIds){
      const scope = await this.wiki.scope();
      const projectionRepository = (await import("@app/db")).createObsidianWikiRepository(pool);
      const eligibleSources = await projectionRepository.sources(scope.sourceIds,scope.includeDescendants);
      if(!eligibleSources.some(s=>s.id===sourceItemId))return {projected:0};
      allowedNoteIds=new Set((await projectionRepository.notes(eligibleSources.map(s=>String(s.id)))).map(n=>String(n.id)));
    }
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    if (!source) throw new Error("source_item_not_found");
    const document = (await createDocumentRepository(pool).listBySourceItem(sourceItemId))[0];
    if (!document || document.metadata.processingMode === "catalog_metadata") return { projected: 0 };
    let projected = await this.projectEntity(settings, source, document,binding);
    const notes = await createAtomicNoteRepository(pool).listBySourceItem(sourceItemId);
    const relations = await createAtomicNoteRelationRepository(pool).listBySourceItem(sourceItemId);
    for (const note of notes) {
      if (allowedNoteIds && !allowedNoteIds.has(note.id)) continue;
      const relatedNotes = await this.resolveRelatedNotes(note.id, relations, allowedNoteIds);
      projected += await this.projectAtomicNote(settings, source, document, note, relatedNotes,binding);
    }
    return { projected };
  }

  public async assertUnmanagedImport(relativePath:string):Promise<void>{if(await createObsidianSyncRepository(this.requirePool()).findByRelativePath(normalizeRelativePath(relativePath)))throw new Error('obsidianWiki.errors.format');}

  public async importNote(
    input: ImportObsidianNoteRequest & { frontmatter: ObsidianManagedFrontmatter }
  ): Promise<IntegrationCommandResult> {
    const settings = await this.options.getStorageSettings();
    if (!isSyncActive(settings)) throw new Error("obsidian_sync_not_configured");
    if (isOutwardProjection(input.frontmatter.memoraType)) return {requestId:input.requestId,accepted:false,syncStatus:"ignored"};
    const relativePath = validateManagedRelativePath(settings, input.relativePath);
    const pool = this.requirePool();
    const syncFiles = createObsidianSyncRepository(pool);
    const existing = await syncFiles.findByMemoraId(input.frontmatter.memoraId);
    if(existing?.metadata.projectionWrite)return {requestId:input.requestId,accepted:false,syncStatus:"ignored"};
    if(!existing || existing.memoraType!==input.frontmatter.memoraType || input.frontmatter.memoraSourceId!==existing.sourceItemId || input.frontmatter.memoraDocumentId!==existing.documentId)throw new Error('obsidianWiki.errors.binding');
    const admitted=await this.wiki.sourceAdmission(settings);
    await this.wiki.assertSourceExport(settings,admitted,existing.sourceItemId!,existing.memoraType==='atomic_note'?[existing.memoraId]:[]);
    if (existing?.metadata.editorialBase || existing?.metadata.editorialPending) return {requestId:input.requestId,accepted:false,syncStatus:"ignored"};
    if (existing?.metadata.projectionWrite) return {requestId:input.requestId,accepted:false,syncStatus:"ignored"};
    if (existing && isOutwardProjection(existing.memoraType)) return {requestId:input.requestId,accepted:false,syncStatus:"ignored"};
    if (existing && existing.relativePath !== relativePath) {
      await syncFiles.update(existing.id, { status: "conflict" });
      return { requestId: input.requestId, accepted: false, syncStatus: "conflict" };
    }
    if (existing && input.frontmatter.memoraSyncVersion !== existing.syncVersion
        && input.contentHash !== existing.contentHash) {
      await syncFiles.update(existing.id, {
        status: "conflict",
        metadata: { ...existing.metadata, conflictDetectedAt: new Date().toISOString() }
      });
      return { requestId: input.requestId, accepted: false, syncStatus: "conflict" };
    }
    const body = normalizeProjectionText(input.markdown);
    const contentHash = sha256(body);
    if (contentHash !== stripHashPrefix(input.contentHash) && sha256(normalizeLegacyMarkdown(body)) !== stripHashPrefix(input.contentHash)) throw new Error("obsidian_content_hash_mismatch");
    if (existing?.contentHash === contentHash) {
      await syncFiles.update(existing.id, {
        relativePath,
        mtimeMs: input.mtimeMs,
        status: "synced",
        lastSyncedAt: new Date()
      });
      return { requestId: input.requestId, accepted: true, syncStatus: "synced" };
    }
    const sourceItemId = input.frontmatter.memoraSourceId
      ?? (input.frontmatter.memoraType === "source_item" ? input.frontmatter.memoraId : existing?.sourceItemId)
      ?? null;
    let documentId = input.frontmatter.memoraDocumentId ?? existing?.documentId ?? null;
    if (input.frontmatter.memoraType === "source_item") {
      if (!sourceItemId || !documentId) throw new Error("obsidian_source_identity_missing");
      documentId = await this.updateSourceDocument(sourceItemId, documentId, body);
    } else {
      const notes = createAtomicNoteRepository(pool);
      const note = await notes.findById(input.frontmatter.memoraId);
      if (!note) throw new Error("atomic_note_not_found");
      if(existing.lastSyncedAt && note.updatedAt>existing.lastSyncedAt)return {requestId:input.requestId,accepted:false,syncStatus:"conflict"};
      await notes.review({
        id: note.id,
        action: "edit",
        expectedUpdatedAt: note.updatedAt.toISOString(),
        bodyMarkdown: stripProjectedTitle(stripObsidianRelations(body), note.title)
      });
    }
    const recordInput = {
      memoraId: input.frontmatter.memoraId,
      entityType: input.frontmatter.memoraType,
      entityId: input.frontmatter.memoraId,
      sourceItemId,
      documentId,
      memoraType: input.frontmatter.memoraType,
      relativePath,
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
    if(input.frontmatter.memoraType==="source_item"&&existing?.metadata.projectionFormat===1)await this.wiki.acknowledgeDocument(input.frontmatter.memoraId);
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
    const settings = await this.options.getStorageSettings();
    const previousRelativePath = validateManagedRelativePath(settings, event.previousRelativePath);
    const relativePath = validateManagedRelativePath(settings, event.relativePath);
    const vaultPath = settings.obsidianVaultPath;
    if (!vaultPath || !await pathExists(vaultPath)) throw new Error("obsidian_vault_unavailable");
    const repository = createObsidianSyncRepository(this.requirePool());
    const record = await repository.findByMemoraId(event.memoraId);
    if (!isSyncActive(settings) || !record || record.metadata.editorialBase || record.metadata.editorialPending || record.metadata.projectionWrite || isOutwardProjection(record.memoraType)) return { requestId: event.eventId, accepted: false, syncStatus: "ignored" };
    if (record.relativePath !== previousRelativePath || event.syncVersion !== record.syncVersion) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    const collision = await repository.findByRelativePath(relativePath);
    if (collision && collision.id !== record.id) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    const previousPath = resolve(vaultPath, previousRelativePath);
    const targetPath = resolve(vaultPath, relativePath);
    if (await pathExists(previousPath) || !await pathExists(targetPath)) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    const movedFile = parseManagedMarkdown(await readFile(targetPath, "utf8"));
    if (movedFile?.frontmatter.memoraId !== event.memoraId) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    await repository.update(record.id, {
      relativePath,
      mtimeMs: event.mtimeMs,
      status: "synced",
      lastSyncedAt: new Date()
    });
    return { requestId: event.eventId, accepted: true, syncStatus: "synced" };
  }

  public async handleDeleted(event: ObsidianFileDeletedEvent): Promise<IntegrationCommandResult> {
    const settings = await this.options.getStorageSettings();
    const relativePath = validateManagedRelativePath(settings, event.relativePath);
    const vaultPath = settings.obsidianVaultPath;
    if (!vaultPath || !await pathExists(vaultPath)) throw new Error("obsidian_vault_unavailable");
    const pool = this.requirePool();
    const repository = createObsidianSyncRepository(pool);
    const record = await repository.findByMemoraId(event.memoraId);
    if (!record || record.metadata.projectionWrite || isOutwardProjection(record.memoraType)) return { requestId: event.eventId, accepted: false, syncStatus: "ignored" };
    if (record.relativePath !== relativePath || event.syncVersion !== record.syncVersion) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    if (await pathExists(resolve(vaultPath, relativePath))) {
      await repository.update(record.id, { status: "conflict" });
      return { requestId: event.eventId, accepted: false, syncStatus: "conflict" };
    }
    const deletedAt = new Date();
    await repository.update(record.id, {
      status: "deleted",
      deletedAt,
      metadata: { ...record.metadata, deletePolicy: settings.deletionPolicy, tombstonedAt: deletedAt.toISOString() }
    });
    return { requestId: event.eventId, accepted: true, syncStatus: "deleted" };
  }

  public async reconcileSnapshot(input: ObsidianReconciliationRequest): Promise<{ synced: number; conflicts: number; deleted: number }> {
    const settings = await this.options.getStorageSettings();
    const repository = createObsidianSyncRepository(this.requirePool());
    const seen = new Set<string>();
    let synced = 0;
    let conflicts = 0;
    for (const file of input.files) {
      if (isOutwardProjection(file.frontmatter.memoraType)) continue;
      validateManagedRelativePath(settings, file.relativePath);
      if (seen.has(file.frontmatter.memoraId)) {
        const duplicate = await repository.findByMemoraId(file.frontmatter.memoraId);
        if (duplicate) await repository.update(duplicate.id, { status: "conflict" });
        conflicts += 1;
        continue;
      }
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
        if (moved.syncStatus === "conflict") {
          conflicts += 1;
          continue;
        }
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
    return { synced, conflicts, deleted: 0 };
  }

  public async reconcileVault(
    onScanProgress?: (processed: number, total: number) => void
  ): Promise<{ synced: number; conflicts: number; deleted: number }> {
    const settings = await this.options.getStorageSettings();
    if (!isSyncActive(settings)) return { synced: 0, conflicts: 0, deleted: 0 };
    const vaultPath = settings.obsidianVaultPath!;
    if (!await pathExists(vaultPath)) throw new Error("obsidian_vault_unavailable");
    const managedPath = resolve(vaultPath, settings.managedRoot);
    if (!isInside(resolve(vaultPath), managedPath)) throw new Error("unsafe_obsidian_root");
    if (!await pathExists(managedPath)) return { synced: 0, conflicts: 0, deleted: 0 };
    const files = await listMarkdownFiles(managedPath);
    onScanProgress?.(0, files.length);
    const snapshots: ObsidianReconciliationRequest["files"] = [];
    for (const [index, fullPath] of files.entries()) {
      const raw = await readFile(fullPath, "utf8");
      const parsed = parseManagedMarkdown(raw);
      if (parsed) {
        const file = await stat(fullPath);
        snapshots.push({
          relativePath: relative(vaultPath, fullPath).split(sep).join("/"),
          frontmatter: parsed.frontmatter,
          contentHash: sha256(normalizeProjectionText(parsed.bodyMarkdown)),
          mtimeMs: Math.trunc(file.mtimeMs),
          markdown: parsed.bodyMarkdown
        });
      }
      onScanProgress?.(index + 1, files.length);
    }
    return this.reconcileSnapshot({ requestId: randomUUID(), scannedAt: new Date().toISOString(), files: snapshots });
  }

  public startSynchronization(): ObsidianSyncStatus {
    if (this.synchronizationPromise) return this.getSynchronizationStatus();
    this.synchronizationStatus = {
      state: "running",
      stage: "reconciling",
      progress: 0,
      processed: 0,
      total: 0,
      synced: 0,
      conflicts: 0,
      projected: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null
    };
    this.synchronizationPromise = this.runSynchronization()
      .catch((error: unknown) => {
        this.synchronizationStatus = {
          ...this.synchronizationStatus,
          state: "failed",
          stage: "failed",
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        };
      })
      .finally(() => {
        this.synchronizationPromise = null;
      });
    return this.getSynchronizationStatus();
  }

  public getSynchronizationStatus(): ObsidianSyncStatus {
    return { ...this.synchronizationStatus };
  }

  public async waitForSynchronization(): Promise<void> {
    await this.synchronizationPromise;
  }

  private async runSynchronization(): Promise<void> {
    const settings = await this.options.getStorageSettings();
    if (!isSyncActive(settings)) throw new Error("obsidian_sync_not_configured");
    const reconciliation = await this.reconcileVault((processed, total) => {
      this.synchronizationStatus = {
        ...this.synchronizationStatus,
        progress: total === 0 ? 0.2 : (0.2 * processed) / total
      };
    });
    const scope = await this.wiki.scope();
    const allowed = new Set((await (await import("@app/db")).createObsidianWikiRepository(this.requirePool()).sources(scope.sourceIds,scope.includeDescendants)).map(s=>s.id));
    const sources = (await createSourceItemRepository(this.requirePool()).list()).filter(s=>allowed.has(s.id));
    this.synchronizationStatus = {
      ...this.synchronizationStatus,
      stage: "projecting",
      progress: sources.length === 0 ? 1 : 0.2,
      total: sources.length,
      synced: reconciliation.synced,
      conflicts: reconciliation.conflicts
    };
    let projected = 0;
    for (const [index, source] of sources.entries()) {
      projected += (await this.projectSource(source.id)).projected;
      this.synchronizationStatus = {
        ...this.synchronizationStatus,
        processed: index + 1,
        projected,
        progress: 0.2 + (0.8 * (index + 1)) / sources.length
      };
    }
    await this.wiki.enqueue(true);
    this.synchronizationStatus = {
      ...this.synchronizationStatus,
      state: "completed",
      stage: "completed",
      progress: 1,
      finishedAt: new Date().toISOString()
    };
  }

  private async projectEntity(settings: StorageSettings, source: SourceItemRecord, document: DocumentRecord,admittedBinding:string): Promise<number> {
    const registered=await createObsidianSyncRepository(this.requirePool()).findByMemoraId(source.id);
    if(registered&&(registered.memoraType==="source_reference"||registered.metadata.projectionFormat===1))return this.wiki.projectDocument(source.id,document.id,source.title,document.canonicalMarkdown,admittedBinding);
    const hierarchy = await this.resolveProjectionHierarchy(source);
    const revision = await this.requirePool().query<{ id: string }>(
      "select id from document_revisions where document_id = $1 and is_current = true limit 1", [document.id]
    );
    return this.writeEntity(settings, {
      admittedBinding,
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
      rootSourceItemId: hierarchy.root.id,
      rootTitle: hierarchy.root.title,
      ...(typeof source.metadata.divisionId === "string" ? { divisionId: source.metadata.divisionId } : {}),
      ...(revision.rows[0]?.id ? { documentRevisionId: revision.rows[0].id } : {}),
      isHierarchyRoot: hierarchy.root.id === source.id && ["Book", "PeriodicalIssue", "AcademicPaper"].includes(source.type),
      date: source.updatedAt
    });
  }

  private async projectAtomicNote(
    settings: StorageSettings,
    source: SourceItemRecord,
    document: DocumentRecord,
    note: AtomicNoteRecord,
    relatedNotes: ObsidianRelatedNote[],
    admittedBinding:string
  ): Promise<number> {
    const evidenceChunk=await createChunkRepository(this.requirePool()).findById(note.evidenceChunkId);
    if(!evidenceChunk)throw new Error('obsidianWiki.errors.binding');
    return this.writeEntity(settings, {
      admittedBinding,
      exportNoteIds:[note.id,...relatedNotes.flatMap(r=>r.noteId?[r.noteId]:[])],
      memoraId: note.id,
      memoraType: "atomic_note",
      entityType: "atomic_note",
      entityId: note.id,
      sourceItemId: source.id,
      documentId: evidenceChunk.documentId,
      title: note.title,
      bodyMarkdown: appendObsidianRelations(
        `# ${note.title}\n\n${note.bodyMarkdown}`,
        note.language,
        relatedNotes
      ),
      date: note.updatedAt
    });
  }

  private async resolveRelatedNotes(
    noteId: string,
    relations: Array<AtomicNoteRelationRecord & {
      sourceTitle: string;
      targetTitle: string;
    }>,
    allowedNoteIds?: Set<string>
  ): Promise<ObsidianRelatedNote[]> {
    const repository = createObsidianSyncRepository(this.requirePool());
    const relatedNotes: ObsidianRelatedNote[] = [];
    for (const relation of relations) {
      if (relation.status === "rejected") continue;
      const isSource = relation.sourceAtomicNoteId === noteId;
      const isTarget = relation.targetAtomicNoteId === noteId;
      if (!isSource && !isTarget) continue;
      const relatedId = isSource ? relation.targetAtomicNoteId : relation.sourceAtomicNoteId;
      if (allowedNoteIds && !allowedNoteIds.has(relatedId)) continue;
      const title = isSource ? relation.targetTitle : relation.sourceTitle;
      const syncFile = await repository.findByMemoraId(relatedId);
      if (!syncFile?.relativePath) continue;
      const target = syncFile.relativePath
        ? normalizeRelativePath(syncFile.relativePath).replace(/\.md$/i, "")
        : slugify(title).replace(/\.md$/i, "");
      relatedNotes.push({ relationType: relation.relationType, title, target,noteId:relatedId,...((syncFile.metadata.editorialTombstone||syncFile.status==='deleted')&&syncFile.sourceItemId?{appSourceId:syncFile.sourceItemId}:{}) });
    }
    return relatedNotes;
  }

  private async writeEntity(settings:StorageSettings,input:Parameters<ObsidianSyncService['writeEntityUnlocked']>[1]):Promise<number>{return (await import('@app/db')).createObsidianWikiRepository(this.requirePool()).withTargetLock(input.memoraId,()=>this.writeEntityUnlocked(settings,input));}

  private async writeEntityUnlocked(settings: StorageSettings, input: {
    admittedBinding:string;
    exportNoteIds?:string[];
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
    rootSourceItemId?: string;
    rootTitle?: string;
    divisionId?: string;
    documentRevisionId?: string;
    isHierarchyRoot?: boolean;
    date: Date;
  }): Promise<number> {
    const pool = this.requirePool();
    const repository = createObsidianSyncRepository(pool);
    let existing = await repository.findByMemoraId(input.memoraId);
    if(existing?.metadata.editorialTombstone || existing?.metadata.editorialPending) return 0;
    if(existing?.metadata.projectionWrite){
      const pending=existing.metadata.projectionWrite as {renderedHash?:string;contentHash?:string;syncVersion?:number};
      const target=await safeVaultPath(settings.obsidianVaultPath!,validateManagedRelativePath(settings,existing.relativePath));
      if(await pathExists(target)){
        if((await stat(target)).size>2_000_000)throw new Error('obsidianWiki.errors.limit');
        const raw=await readFile(target,'utf8'),parsed=parseManagedMarkdown(raw),actual=parsed?sha256(normalizeProjectionText(parsed.bodyMarkdown)):null;
        const written=sha256(normalizeProjectionText(raw))===pending.renderedHash&&actual===pending.contentHash&&parsed?.frontmatter.memoraSyncVersion===pending.syncVersion;
        if(!parsed||parsed.frontmatter.memoraId!==input.memoraId||(!written&&actual!==existing.contentHash))throw new Error('obsidian_projection_target_conflict');
        const {projectionWrite:_pending,...metadata}=existing.metadata;
        existing=(await repository.update(existing.id,{...(written?{contentHash:actual!,syncVersion:pending.syncVersion!}:{}),metadata,status:'synced',lastSyncedAt:new Date()}))!;
      }
    }
    const bodyMarkdown = normalizeProjectionText(input.bodyMarkdown);
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
      ...(input.rootSourceItemId ? { rootSourceItemId: input.rootSourceItemId } : {}),
      ...(input.rootTitle ? { rootTitle: input.rootTitle } : {}),
      ...(input.divisionId ? { divisionId: input.divisionId } : {}),
      ...(input.documentRevisionId ? { documentRevisionId: input.documentRevisionId } : {}),
      ...(input.isHierarchyRoot !== undefined ? { isHierarchyRoot: input.isHierarchyRoot } : {}),
      date: input.date
    });
    let relativePath = existing?.relativePath;
    const vaultPath = settings.obsidianVaultPath!;
    if (relativePath) relativePath = validateManagedRelativePath(settings, relativePath);
    if (!relativePath) relativePath = await this.selectAvailablePath(
      repository,
      vaultPath,
      rendered.relativeDirectory,
      rendered.baseFileName,
      input.date,
      input.memoraId
    );
    let expectedFileHash: string | null = null;
    if (existing && await pathExists(resolve(vaultPath, relativePath))) {
      const existingPath = await safeVaultPath(vaultPath, relativePath);
      if ((await stat(existingPath)).size > 2_000_000) throw new Error("obsidianWiki.errors.limit");
      const raw = await readFile(existingPath, "utf8");
      expectedFileHash = sha256(normalizeProjectionText(raw));
      const fullParsed = parseObsidianMarkdown(raw);
      if(fullParsed?.userFrontmatter) rendered.markdown=serializeManagedFrontmatter(rendered.frontmatter,fullParsed.userFrontmatter)+"\n"+bodyMarkdown;
      const parsed = parseManagedMarkdown(raw);
      const actualContentHash = parsed ? sha256(normalizeProjectionText(parsed.bodyMarkdown)) : null;
      if (!parsed || parsed.frontmatter.memoraId !== input.memoraId || actualContentHash !== existing.contentHash) {
        await repository.update(existing.id, {
          status: "conflict",
          metadata: { ...existing.metadata, conflictDetectedAt: new Date().toISOString() }
        });
        throw new Error("obsidian_projection_target_conflict");
      }
      if (existing.contentHash === contentHash) return 0;
    }
    const activeSettings=await this.options.getStorageSettings();
    if(!isSyncActive(activeSettings)||activeSettings.obsidianVaultPath!==vaultPath||activeSettings.managedRoot!==settings.managedRoot)throw new Error("obsidian_sync_not_configured");
    await this.wiki.assertSourceExport(settings,input.admittedBinding,input.sourceItemId,input.exportNoteIds??[]);
    const pendingMetadata={...(existing?.metadata??{}),projectionWrite:{renderedHash:sha256(normalizeProjectionText(rendered.markdown)),contentHash,syncVersion}};
    if(existing)await repository.update(existing.id,{metadata:pendingMetadata});
    else existing=await repository.create({memoraId:input.memoraId,entityType:input.entityType,entityId:input.entityId,sourceItemId:input.sourceItemId,documentId:input.documentId,memoraType:input.memoraType,relativePath,frontmatterHash:sha256(rendered.frontmatterText),contentHash,mtimeMs:0,syncVersion,status:'pending',metadata:pendingMetadata});
    await this.wiki.sourceAdmission(settings,input.admittedBinding);
    const output = await this.writeProjection({ vaultPath, relativePath, content: rendered.markdown,expectedHash:expectedFileHash,recoveryId:randomUUID(),managedRoot:settings.managedRoot });
    const {projectionWrite:_pending,...settledMetadata}=existing.metadata;
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
      metadata: {...settledMetadata,...(settledMetadata.editorialBase?{editorialBase:{content:rendered.markdown,revision:input.date.toISOString(),version:syncVersion,hash:sha256(rendered.markdown)},editorialBinding:sha256(JSON.stringify([vaultPath,settings.managedRoot]))}:{})}
    };
    if (existing) await repository.update(existing.id, persistence);
    else await repository.create(persistence);
    return 1;
  }

  private async resolveProjectionHierarchy(source: SourceItemRecord): Promise<{ root: SourceItemRecord }> {
    const sources = createSourceItemRepository(this.requirePool());
    let root = source;
    const seen = new Set<string>([source.id]);
    while (root.parentSourceItemId && !seen.has(root.parentSourceItemId)) {
      seen.add(root.parentSourceItemId);
      const parent = await sources.findById(root.parentSourceItemId);
      if (!parent) break;
      root = parent;
    }
    return { root };
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

  private async writeProjection(input: { vaultPath: string; relativePath: string; content: string; expectedHash?: string | null; recoveryId?: string; managedRoot?: string }): Promise<{ mtimeMs: number }> {
    if (this.options.writeProjection) return this.options.writeProjection(input);
    const result = await this.workers.execute("obsidian-sync", { action: "write", ...input });
    if (typeof result.mtimeMs !== "number") throw new Error("obsidian_worker_invalid_result");
    return { mtimeMs: result.mtimeMs };
  }

  private async updateSourceDocument(sourceItemId: string, documentId: string, markdown: string): Promise<string> {
    const pool = this.requirePool();
    const sources = createSourceItemRepository(pool);
    const documents = createDocumentRepository(pool);
    const source = await sources.findById(sourceItemId);
    const document = await documents.findById(documentId);
    if (!source || !document || document.sourceItemId !== sourceItemId) throw new Error("obsidian_source_not_found");
    if(document.metadata.supersededByDocumentId)throw new Error('sourceWorkspace.conflict');
    const result=await new SourceEditorialService(pool).saveProjected(sourceItemId, source.updatedAt.toISOString(), markdown);
    if(!result.documentId)throw new Error("sourceWorkspace.conflict");
    return result.documentId;
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

function validateManagedRelativePath(settings: StorageSettings, path: string): string {
  const normalized = normalizeRelativePath(path);
  const managedRoot = normalizeRelativePath(settings.managedRoot).replace(/\/$/, "");
  if (!managedRoot || normalized === managedRoot || !normalized.startsWith(`${managedRoot}/`)) {
    throw new Error("unsafe_obsidian_managed_path");
  }
  return normalized;
}

function createIdleSynchronizationStatus(): ObsidianSyncStatus {
  return {
    state: "idle",
    stage: "idle",
    progress: 0,
    processed: 0,
    total: 0,
    synced: 0,
    conflicts: 0,
    projected: 0,
    startedAt: null,
    finishedAt: null,
    error: null
  };
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
    if (entry.name === ".memora-recovery") continue;
    if (entry.isDirectory()) files.push(...await listMarkdownFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
  }
  return files;
}

function stripProjectedTitle(markdown: string, title: string): string {
  const heading = `# ${title}`;
  return markdown.startsWith(`${heading}\n`) ? markdown.slice(heading.length).trimStart() : markdown;
}
