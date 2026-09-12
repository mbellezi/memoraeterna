import { sourceOriginal, replaceSourceOriginal, obsidianLayoutCapability } from '@app/integration-contracts';
import { createObsidianLayoutRepository } from '@app/db';
import { WikiPageContentSchema } from '@app/domain';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createAtomicNoteRepository, createIntegrationClientRepository, createDocumentRepository, createObsidianEditorialRepository, createObsidianSyncRepository, createObsidianWikiRepository, createSourceItemRepository, createWikiRepository, type ObsidianSyncFileRecord, type PgClient, type PgPool } from '@app/db';
import { sha256 } from '@app/conversion';
import { atomicEditorial, normalizeProjectionText, obsidianBindingSchema, obsidianEditOperationSchema, obsidianEditReceiptSchema, obsidianManifestSchema, parseObsidianMarkdown, parseWikiRegions, wikiGeneratedStart, wikiGeneratedEnd, serializeManagedFrontmatter, type ObsidianEditOperation, type ObsidianEditReceipt } from '@app/integration-contracts';
import type { StorageSettings } from '../../shared/ipc.js';
import { safeVaultPath } from '../workers/obsidian-sync.worker.js';
import { SourceEditorialService } from './source-editorial-service.js';
import { renderWikiCurrent, validateEditorialChange, wikiSections, wikiTitle } from './obsidian-editorial-content.js';
import type { ObsidianWikiProjection } from './obsidian-wiki-projection.js';
export interface EditorialBase {
    content: string;
    revision: string;
    version: number;
    hash: string;
}
export class ObsidianEditorialService {
    private edits: Promise<void> = Promise.resolve();
    constructor(private readonly options: {
        getPool: () => PgPool | null;
        getStorageSettings: () => Promise<StorageSettings>;
        wiki: ObsidianWikiProjection;
        write: (input: {
            vaultPath: string;
            relativePath: string;
            content: string;
            expectedHash: string | null;
            recoveryId: string;
            managedRoot: string;
        }) => Promise<unknown>;
    }) { }
    private pool() { const pool = this.options.getPool(); if (!pool)
        throw new Error('errors.database.notReady'); return pool; }
    private async settings() { const s = await this.options.getStorageSettings(); if (!s.obsidianSyncEnabled || s.obsidianSyncPaused)
        throw new Error('obsidianEditing.paused'); if (!s.obsidianVaultPath)
        throw new Error('obsidianWiki.errors.binding'); return s; }
    private binding(s: StorageSettings) { return sha256(JSON.stringify([s.obsidianVaultPath, s.managedRoot])); }
    async bind(clientId: string, vaultId: string) {
        const grant = await createIntegrationClientRepository(this.pool()).findById(clientId);
        if (!grant || grant.status !== 'paired' || !grant.scopes.includes('obsidian-editorial-v1'))
            throw new Error('obsidianWiki.errors.binding');
        const s = await this.settings(), value = obsidianBindingSchema.parse({ vaultId, binding: this.binding(s), managedRoot: s.managedRoot });
        const old = obsidianBindingSchema.parse(await createObsidianEditorialRepository(this.pool()).bindClient(clientId, value));
        if (old.vaultId !== value.vaultId || old.binding !== value.binding)
            throw new Error('obsidianWiki.errors.binding');
        return value;
    }
    private async allowed(file: ObsidianSyncFileRecord, s: StorageSettings) {
        if (!file.relativePath.startsWith(s.managedRoot + '/'))
            throw new Error('obsidianWiki.errors.binding');
        const scope = await this.options.wiki.scope(), repo = createObsidianWikiRepository(this.pool());
        if (file.memoraType === 'wiki_page') {
            if (scope.pageIds.length && !scope.pageIds.includes(file.memoraId))
                throw new Error('obsidianWiki.errors.binding');
            const page = await createWikiRepository(this.pool()).get(file.memoraId);
            const sources = new Set((await repo.sources(scope.sourceIds, scope.includeDescendants)).map(s => String(s.id)));
            if (!page || page.evidence.some((e: {
                sourceItemId: string;
            }) => !sources.has(e.sourceItemId)))
                throw new Error('obsidianWiki.errors.binding');
        }
        else if (file.sourceItemId) {
            if (!await repo.exportEligible(file.sourceItemId, file.memoraType === 'atomic_note' ? [file.memoraId] : [], scope.sourceIds, scope.includeDescendants))
                throw new Error('obsidianWiki.errors.binding');
        }
        else if (file.memoraType === 'source_relation') {
            const ids = (await repo.sources(scope.sourceIds, scope.includeDescendants)).map(s => String(s.id));
            if (!await createObsidianEditorialRepository(this.pool()).relationAllowed(file.memoraId, ids))
                throw new Error('obsidianWiki.errors.binding');
        }
        else
            throw new Error('obsidianWiki.errors.binding');
    }
    async manifest(clientId: string, vaultId: string, cursor = 0, pendingOperationIds?: string[], supportsLayout=false) {
        const binding = await this.bind(clientId, vaultId), s = await this.settings(), repo = createObsidianEditorialRepository(this.pool());
        const ids = await repo.list(cursor), files = [];
        for (const id of ids) {
            const file = await createObsidianSyncRepository(this.pool()).findByMemoraId(id);
            if (!file || file.status === 'deleted' || file.metadata.layoutMigration || file.metadata.projectionFormat===2&&!supportsLayout)
                continue;
            try {
                await this.allowed(file, s);
                const base = await this.base(file, s);
                if (!base)
                    continue;
                files.push({ targetId: id, targetType: file.memoraType, relativePath: file.relativePath, revision: base.revision, syncVersion: base.version, contentHash: base.hash, content: base.content });
            }
            catch { /* One unavailable/out-of-scope target must not hide other registered files. */ }
        }
        const resolutionRows = await repo.resolutions(clientId, binding.binding, cursor, pendingOperationIds), resolutions = [];
        for (const row of resolutionRows) {
            const { acknowledgedBase: _base, ...operation } = row.request;
            const file = await createObsidianSyncRepository(this.pool()).findByMemoraId(operation.targetId);
            if (!file)
                continue;
            try {
                await this.allowed(file, s);
                resolutions.push({ originalOperationId: operation.resolution.operationId, operation, receipt: row.receipt, supersededOperationIds: row.superseded_operation_ids });
            }
            catch { }
        }
        return obsidianManifestSchema.parse({ resolutions, binding, cursor: ids.length === 25 || resolutionRows.length === 25 ? cursor + 25 : null, files });
    }
    private async current(file: ObsidianSyncFileRecord, base: EditorialBase, client?: PgClient) {
        const db = client ?? this.pool(), frame = parseObsidianMarkdown(base.content);
        if (!frame)
            throw new Error('obsidianWiki.errors.format');
        let body = frame.bodyMarkdown, revision = base.revision;
        if (file.memoraType === 'wiki_page') {
            const page = client ? await createObsidianEditorialRepository(this.pool()).page(client, file.memoraId) : await createWikiRepository(this.pool()).get(file.memoraId);
            if (!page)
                throw new Error('obsidianWiki.errors.conflict');
            const content = client ? page.content : page;
            revision = client ? page.revision : page.revisionId;
            frame.frontmatter.memoraRevisionId=revision;
            if (revision !== base.revision)
                body = renderWikiCurrent(body, {...content,sections:content.sections.map((section:{id:string;title:string;markdown:string})=>({...section,markdown:(frame.frontmatter.memoraLinkMap??[]).reduce((text,map)=>text.replaceAll(map.canonical,map.rendered),section.markdown)}))});
        }
        else if (file.memoraType === 'atomic_note') {
            const note = await createAtomicNoteRepository(db).findById(file.memoraId);
            if (!note)
                throw new Error('obsidianWiki.errors.conflict');
            revision = note.updatedAt.toISOString();
            if (revision !== base.revision)
                body = `# ${note.title}\n\n${note.bodyMarkdown}\n\n` + (frame.frontmatter.memoraLayout===2?parseWikiRegions(body)?.generated??'':atomicEditorial(body)?.generated ?? '');
        }
        else if (file.sourceItemId) {
            const source = await createSourceItemRepository(db).findById(file.sourceItemId);
            if (!source)
                throw new Error('obsidianWiki.errors.conflict');
            revision = source.updatedAt.toISOString();
            if (file.memoraType === 'source_item') {const document=(await createDocumentRepository(db).listBySourceItem(source.id))[0];if(document){body=frame.frontmatter.memoraLayout===2?replaceSourceOriginal(body,sourceOriginal(body)?.original===''? '':document.canonicalMarkdown):document.canonicalMarkdown;frame.frontmatter.memoraDocumentId=document.id;const documentRevision=await createObsidianEditorialRepository(this.pool()).documentRevision(db,document.id);if(documentRevision)frame.frontmatter.memoraDocumentRevisionId=documentRevision;else delete frame.frontmatter.memoraDocumentRevisionId;}}
        }
        const content=serializeManagedFrontmatter(frame.frontmatter,frame.userFrontmatter)+'\n'+body;
        if(Buffer.byteLength(content)>2_000_000)throw new Error('obsidianWiki.errors.limit');
        return {revision,content};
    }
    private async base(file: ObsidianSyncFileRecord, s: StorageSettings): Promise<EditorialBase | null> {
        const saved = file.metadata.editorialBase as EditorialBase | undefined;
        if (saved && file.metadata.editorialBinding === this.binding(s))
            return saved;
        const written = await createObsidianWikiRepository(this.pool()).base(file.memoraId, this.binding(s));
        if (written) {
            const fm = parseObsidianMarkdown(written.content)?.frontmatter;
            if (!fm)
                return null;
            const base = { content: written.content, revision: written.revision_id, version: fm.memoraSyncVersion, hash: written.rendered_hash };
            if (file.memoraType === 'source_item')
                base.revision = 'projection:' + base.version;
            await createObsidianSyncRepository(this.pool()).update(file.id, { metadata: { ...file.metadata, editorialBase: base, editorialBinding: this.binding(s) } });
            return base;
        }
        // Legacy source/note adoption requires an exact registry body, never arbitrary local prose.
        const path = await safeVaultPath(s.obsidianVaultPath!, file.relativePath);
        if ((await stat(path)).size > 2000000)
            return null;
        const content = normalizeProjectionText(await readFile(path, 'utf8')), frame = parseObsidianMarkdown(content);
        if (!frame || frame.frontmatter.memoraId !== file.memoraId || sha256(frame.bodyMarkdown) !== file.contentHash)
            return null;
        const revision = file.memoraType === 'atomic_note' ? (await createAtomicNoteRepository(this.pool()).findById(file.memoraId))?.updatedAt.toISOString() : (await createSourceItemRepository(this.pool()).findById(file.sourceItemId!))?.updatedAt.toISOString();
        if (!revision)
            return null;
        const base = { content, revision: 'projection:' + file.syncVersion, version: file.syncVersion, hash: sha256(content) };
        await createObsidianSyncRepository(this.pool()).update(file.id, { metadata: { ...file.metadata, editorialBase: base, editorialBinding: this.binding(s) } });
        return base;
    }
    apply(clientId: string, value: unknown, supportsLayout=false): Promise<ObsidianEditReceipt> { const next = this.edits.then(() => this.applyOperation(clientId, value, supportsLayout)); this.edits = next.then(() => undefined, () => undefined); return next; }
    private async applyOperation(clientId: string, value: unknown, supportsLayout=false): Promise<ObsidianEditReceipt> {
        const input = obsidianEditOperationSchema.parse(value), s = await this.settings();
        if(!input.relativePath.startsWith(s.managedRoot+'/'))throw new Error('obsidianWiki.errors.binding');
        if(Buffer.byteLength(input.content)>2_000_000)throw new Error('obsidianWiki.errors.limit');
        const binding = await this.bind(clientId, input.vaultId);
        if (input.binding !== binding.binding)
            throw new Error('obsidianWiki.errors.binding');
        const repo = createObsidianEditorialRepository(this.pool()), hash = sha256(JSON.stringify(input));
        const file = await createObsidianSyncRepository(this.pool()).findByMemoraId(input.targetId);
        if (!file)
            throw new Error('obsidianWiki.errors.binding');
        if(file.metadata.projectionFormat===2){const grant=await createIntegrationClientRepository(this.pool()).findById(clientId);if(!supportsLayout||!grant?.scopes.includes(obsidianLayoutCapability))throw new Error('obsidianWiki.errors.format');}
        if(await createObsidianLayoutRepository(this.pool()).active(this.binding(s)))throw new Error('obsidianWiki.errors.paused');
        await this.allowed(file, s);
        const admitted = await this.options.wiki.sourceAdmission(s);
        let initialBase = await this.base(file, s);
        if (initialBase?.hash !== input.baseHash) {
            const retained = await repo.retainedBase(input.targetId, input.baseHash, input.binding);
            if (retained) {
                const fm = parseObsidianMarkdown(retained.content)?.frontmatter;
                if (fm)
                    initialBase = { ...retained, version: fm.memoraSyncVersion };
            }
        }
        if (!initialBase)
            throw new Error('obsidianWiki.errors.conflict');
        return createObsidianWikiRepository(this.pool()).withTargetLock(input.targetId, () => repo.transaction(input.targetId, input.operationId, async (client) => {
            await repo.lockClient(client, clientId);
            const old = await repo.receipt(client, input.operationId);
            if (old) {
                if (old.client_id !== clientId || old.request_hash !== hash)
                    throw new Error('obsidianWiki.errors.binding');
                return obsidianEditReceiptSchema.parse(old.receipt);
            }
            const locked = await repo.lockFile(client, input.targetId);
            if (!locked || locked.memoraType !== input.targetType)
                throw new Error('obsidianWiki.errors.binding');
            await repo.lockCanonical(client, input.targetType, input.targetId);
            const base = initialBase;
            const current = await this.current(locked, base, client);
            const receipt: ObsidianEditReceipt = { operationId: input.operationId, targetId: input.targetId, status: 'conflict', revision: current.revision, syncVersion: locked.syncVersion, contentHash: sha256(current.content), projection: 'conflict', content: current.content, reason: null, comparison: { base: base.content, local: input.content, app: current.content } };
            const expectedPath = input.kind === 'move' ? input.previousRelativePath : input.relativePath;
            let reason = locked.metadata.projectionWrite ? 'busy' : expectedPath !== locked.relativePath ? 'path' : input.baseRevision !== base.revision || input.baseVersion !== base.version || input.baseHash !== base.hash ? 'base' : null;
            let force = false;
            if (input.resolution) {
                const conflict = await repo.receipt(client, input.resolution.operationId);
                if (!conflict || conflict.client_id !== clientId || conflict.target_id !== input.targetId || !['conflict', 'deleted'].includes(conflict.receipt.status) || current.revision !== input.resolution.currentRevision)
                    reason = 'stale_resolution';
                else if (!reason || reason === 'base') {
                    force = true;
                    reason = null;
                }
            }
            if (input.kind === 'detach' && input.resolution) {
                const conflict = await repo.receipt(client, input.resolution.operationId);
                if (!conflict || conflict.client_id !== clientId || conflict.target_id !== input.targetId || !['path', 'duplicate'].includes(conflict.receipt.reason) || conflict.request.relativePath !== input.relativePath || input.relativePath === locked.relativePath)
                    throw new Error('obsidianWiki.errors.binding');
                try {
                    const path = await safeVaultPath(s.obsidianVaultPath!, input.relativePath);
                    if ((await stat(path)).size > 2000000 || parseObsidianMarkdown(await readFile(path, 'utf8')))
                        throw new Error('obsidianWiki.errors.conflict');
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
                reason = null;
                receipt.status = 'ignored';
                receipt.projection = 'synced';
                receipt.comparison = null;
            }
            if (!reason && input.kind === 'edit') {
                const body = validateEditorialChange(base.content, input.content, current.content, locked.memoraType, force);
                if (input.resolution?.choice === 'app' && force) {
                    receipt.status = 'synced';
                    receipt.projection = 'pending';
                }
                else if (body === null || !['wiki_page', 'source_item', 'source_reference', 'atomic_note'].includes(locked.memoraType))
                    reason = 'structure';
                else {
                    if (body !== parseObsidianMarkdown(current.content)?.bodyMarkdown) {
                        if (locked.memoraType === 'wiki_page') {
                            const page = await repo.page(client, locked.memoraId), edited = wikiSections(body);
                            for(const section of edited.sections)section.markdown=(parseObsidianMarkdown(input.content)?.frontmatter.memoraLinkMap??[]).reduce((text,map)=>text.replaceAll(map.rendered,map.canonical),section.markdown);
                            const content = { ...page!.content, title: edited.title, sections: edited.sections.map(edit => { const section = page!.content.sections.find((s: {
                                    id: string;
                                }) => s.id === edit.id); return section ? { ...section, ...edit, ...((edit.markdown !== section.markdown || edit.title !== section.title) ? { provenance: 'personal', protected: true, evidenceReview: 'needs_review' } : {}) } : { ...edit, kind: 'prose', provenance: 'personal', protected: true, evidenceReview: 'needs_review', evidenceIds: [] }; }) };
                            await createWikiRepository(this.pool()).save({ ...(parseObsidianMarkdown(input.content)?.frontmatter.memoraLayout===2?{version:2 as const}:{}), id: locked.memoraId, expectedRevisionId: page!.revision, content: WikiPageContentSchema.parse(content), evidenceChunkIds: [] }, { transaction: client, origin: 'human', allocatedTarget: false, humanApproved: true });
                        }
                        else if (locked.memoraType === 'source_item' || locked.memoraType === 'source_reference') {
                            const saved = await new SourceEditorialService(this.pool()).saveProjected(locked.sourceItemId!, current.revision, parseObsidianMarkdown(current.content)?.frontmatter.memoraLayout===2?sourceOriginal(body)!.original:body, client);
                            await createObsidianSyncRepository(client).update(locked.id, { documentId: saved.documentId, ...(locked.memoraType === 'source_reference' ? { memoraType: 'source_item', entityType: 'source_item' } : {}) });
                        }
                        else {
                            const editorial = (parseObsidianMarkdown(current.content)?.frontmatter.memoraLayout===2?parseWikiRegions(body)!:atomicEditorial(body)!).editorial, match = /^# ([^\n]+)\n\n([\s\S]*)$/.exec(editorial);
                            if (!match)
                                throw new Error('obsidianWiki.errors.format');
                            await createAtomicNoteRepository(client).review({ id: locked.memoraId, action: 'edit', title: wikiTitle(editorial), bodyMarkdown: match[2]!.endsWith('\n\n') ? match[2]!.slice(0, -2) : match[2]!, expectedUpdatedAt: current.revision }, client);
                        }
                    }
                    const next = await this.current(locked, { ...base, revision: '' }, client), localFrame = parseObsidianMarkdown(input.content)!;
                    receipt.revision = next.revision;
                    receipt.content = serializeManagedFrontmatter(localFrame.frontmatter, localFrame.userFrontmatter) + '\n' + body;
                    receipt.status = 'synced';
                    receipt.projection = 'pending';
                }
            }
            else if (!reason && input.kind === 'move') {
                try {
                    await stat(await safeVaultPath(s.obsidianVaultPath!, locked.relativePath));
                    reason = 'duplicate';
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
                if (parseObsidianMarkdown(input.content)?.bodyMarkdown !== parseObsidianMarkdown(base.content)?.bodyMarkdown)
                    reason = 'unsaved_edit';
                if (!input.relativePath.startsWith(s.managedRoot + '/'))
                    throw new Error('obsidianWiki.errors.binding');
                const collision = await createObsidianSyncRepository(client).findByRelativePath(input.relativePath);
                if (collision && collision.id !== locked.id)
                    reason = 'duplicate';
                else if (!reason)
                    await createObsidianSyncRepository(client).update(locked.id, { relativePath: input.relativePath });
                if (!reason) {
                    receipt.status = 'synced';
                    receipt.projection = 'synced';
                    receipt.content = current.content;
                }
            }
            else if (!reason && input.kind === 'delete') {
                try {
                    await stat(await safeVaultPath(s.obsidianVaultPath!, locked.relativePath));
                    reason = 'present';
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
                if (reason) {
                    receipt.reason = reason;
                }
                else {
                    await createObsidianSyncRepository(client).update(locked.id, { status: 'deleted', deletedAt: new Date(), metadata: { ...locked.metadata, editorialTombstone: { operationId: input.operationId, content: input.content } } });
                    receipt.status = 'deleted';
                    receipt.projection = 'tombstoned';
                    receipt.content = input.content;
                }
            }
            receipt.reason = reason;
            if (receipt.status === 'synced') {
                const frame = parseObsidianMarkdown(receipt.content)!;
                receipt.syncVersion = locked.syncVersion + 1;
                frame.frontmatter.memoraSyncVersion = receipt.syncVersion;
                frame.frontmatter.memoraContentHash = sha256(parseWikiRegions(frame.bodyMarkdown)?.editorial ?? frame.bodyMarkdown);
                if (locked.memoraType === 'wiki_page'||frame.frontmatter.memoraLayout===2)
                    frame.frontmatter.memoraRevisionId = receipt.revision;
                const latest = await createObsidianSyncRepository(client).findByMemoraId(locked.memoraId);
                if (latest?.documentId)
                    frame.frontmatter.memoraDocumentId = latest.documentId;
                if(latest?.documentId&&latest.memoraType==='source_item'){const revision=await repo.documentRevision(client,latest.documentId);if(revision)frame.frontmatter.memoraDocumentRevisionId=revision;else delete frame.frontmatter.memoraDocumentRevisionId;}
                if (latest?.memoraType === 'source_item' && frame.frontmatter.memoraType === 'source_reference') {
                    frame.frontmatter.memoraType = 'source_item';
                    if(!frame.frontmatter.memoraLayout)delete frame.frontmatter.memoraWikiSchema;
                    if(!frame.frontmatter.memoraLayout)delete frame.frontmatter.memoraRevisionId;
                }
                receipt.content = serializeManagedFrontmatter(frame.frontmatter, frame.userFrontmatter) + '\n' + frame.bodyMarkdown;
                receipt.contentHash = sha256(receipt.content);
                receipt.comparison = null;
                const nextBase = { content: receipt.content, revision: receipt.revision, version: receipt.syncVersion, hash: receipt.contentHash };
                const { editorialTombstone: _tombstone, ...settledMetadata } = latest!.metadata;
                await createObsidianSyncRepository(client).update(locked.id, { syncVersion: receipt.syncVersion, contentHash: frame.frontmatter.memoraContentHash, status: 'pending', deletedAt: null, metadata: { ...settledMetadata, editorialBase: nextBase, editorialBinding: this.binding(s), editorialPending: { operationId: input.operationId, expectedHash: sha256(input.content), content: receipt.content } } });
            }
            else if (receipt.status === 'conflict')
                await createObsidianSyncRepository(client).update(locked.id, { status: 'conflict' });
            if(receipt.status==='synced'||receipt.status==='deleted')await repo.invalidate(client);
            await this.options.wiki.sourceAdmission(s, admitted);
            if (this.binding(await this.settings()) !== input.binding)
                throw new Error('obsidianWiki.errors.binding');
            await repo.record(client, { id: input.operationId, clientId, vaultId: input.vaultId, binding: input.binding, targetId: input.targetId, requestHash: hash, request: { ...input, acknowledgedBase: base }, receipt });
            return obsidianEditReceiptSchema.parse(receipt);
        }));
    }
    async acknowledge(clientId: string, operationId: string, vaultId: string) {
        const s = await this.settings(), binding = await this.bind(clientId, vaultId), repo = createObsidianEditorialRepository(this.pool());
        return repo.transaction(operationId, operationId, async (client) => {
            await repo.lockClient(client, clientId);
            const operation = await repo.receipt(client, operationId);
            if (!operation || operation.client_id !== clientId || operation.binding_hash !== binding.binding)
                throw new Error('obsidianWiki.errors.binding');
            const receipt = obsidianEditReceiptSchema.parse(operation.receipt), file = await repo.lockFile(client, receipt.targetId);
            if (!file)
                throw new Error('obsidianWiki.errors.binding');
            const path = await safeVaultPath(s.obsidianVaultPath!, file.relativePath);
            try {
                if ((await stat(path)).size > 2000000)
                    throw new Error('obsidianWiki.errors.limit');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return receipt;
                throw error;
            }
            if (sha256(normalizeProjectionText(await readFile(path, 'utf8'))) !== receipt.contentHash)
                return receipt;
            if (file.syncVersion !== receipt.syncVersion)
                return receipt;
            if (file.metadata.editorialAcknowledgedOperationId === operationId)
                return { ...receipt, projection: 'synced' as const };
            if ((file.metadata.editorialPending as {
                operationId?: string;
            } | undefined)?.operationId === operationId) {
                const { editorialPending: _pending, ...metadata } = file.metadata;
                await createObsidianSyncRepository(client).update(file.id, { metadata: { ...metadata, editorialAcknowledgedOperationId: operationId }, status: 'synced' });
            }
            const outbox = createObsidianWikiRepository(this.pool()), parsed = parseObsidianMarkdown(receipt.content)!;
            const delivered = await outbox.prepare({ memora_id: receipt.targetId, revision_id: receipt.revision, binding_hash: binding.binding, relative_path: file.relativePath, content: receipt.content, editable_hash: parsed.frontmatter.memoraContentHash, generated_hash: sha256(parseWikiRegions(parsed.bodyMarkdown)?.generated.slice(wikiGeneratedStart.length+2,-(wikiGeneratedEnd.length+3)) ?? atomicEditorial(parsed.bodyMarkdown)?.generated ?? ''), rendered_hash: receipt.contentHash, base_hash: null, before_content: null });
            await outbox.finish(delivered.id, 'written');
            return { ...receipt, projection: 'synced' as const };
        });
    }
    async conflicts() { const s = await this.options.getStorageSettings(); const rows = await createObsidianEditorialRepository(this.pool()).conflicts(this.binding(s)); return rows.map(row => ({ id: row.id, path: row.request.relativePath, receipt: obsidianEditReceiptSchema.parse(row.receipt) })); }
    async resolveDesktop(input: {
        id: string;
        choice: 'local' | 'app' | 'manual';
        content: string;
        currentRevision: string;
        expectedLocal: string | null;
    }) {
        const s = await this.settings(), repo = createObsidianEditorialRepository(this.pool()), row = (await repo.conflicts(this.binding(s))).find(r => r.id === input.id);
        if (!row)
            throw new Error('obsidianWiki.errors.conflict');
        const { acknowledgedBase: _base, ...request } = row.request;
        const path = await safeVaultPath(s.obsidianVaultPath!, request.relativePath);
        let local: string | null = null;
        try {
            local = normalizeProjectionText(await readFile(path, 'utf8'));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || row.receipt.status !== 'deleted')
                throw error;
        }
        if (local !== input.expectedLocal)
            throw new Error('obsidianWiki.errors.conflict');
        const receipt = await this.apply(row.client_id, { ...request, kind: 'edit', operationId: randomUUID(), occurredAt: new Date().toISOString(), content: input.choice === 'manual' ? input.content : input.choice === 'local' ? local ?? request.content : request.content, resolution: { operationId: request.resolution?.operationId ?? input.id, currentRevision: input.currentRevision, choice: input.choice, observedLocal: local } },true);
        if (receipt.status !== 'synced')
            throw new Error('obsidianWiki.errors.conflict');
        await this.options.write({ vaultPath: s.obsidianVaultPath!, relativePath: request.relativePath, content: receipt.content, expectedHash: local === null ? null : sha256(local), recoveryId: randomUUID(), managedRoot: s.managedRoot });
        await this.acknowledge(row.client_id, receipt.operationId, request.vaultId);
        return receipt;
    }
    async compare(clientId: string, id: string, localContent?: string) {
        const s = await this.settings(), repo = createObsidianEditorialRepository(this.pool()), row = (await repo.conflicts(this.binding(s))).find(r => r.id === id && r.client_id === clientId);
        if (!row)
            throw new Error('obsidianWiki.errors.conflict');
        await this.bind(clientId, row.request.vaultId);
        const file = await createObsidianSyncRepository(this.pool()).findByMemoraId(row.request.targetId);
        if (!file)
            throw new Error('obsidianWiki.errors.binding');
        await this.allowed(file, s);
        const base = row.request.acknowledgedBase as EditorialBase, current = await this.current(file, base);
        let local = localContent;
        if (local === undefined) {
            try {
                const path = await safeVaultPath(s.obsidianVaultPath!, row.request.relativePath);
                if ((await stat(path)).size > 2000000)
                    throw new Error('obsidianWiki.errors.limit');
                local = normalizeProjectionText(await readFile(path, 'utf8'));
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || row.receipt.status !== 'deleted')
                    throw error;
                local = row.receipt.comparison.local;
            }
        }
        return obsidianEditReceiptSchema.parse({ ...row.receipt, revision: current.revision, content: current.content, contentHash: sha256(current.content), comparison: { base: base.content, local, app: current.content } });
    }
    async compareDesktop(id: string) { const s = await this.settings(), row = (await createObsidianEditorialRepository(this.pool()).conflicts(this.binding(s))).find(r => r.id === id); if (!row)
        throw new Error('obsidianWiki.errors.conflict'); return this.compare(row.client_id, id); }
}
