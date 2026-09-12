import { inspectMirrorAssets, projectMirrorAssets } from './obsidian-asset-projection.js';
import { createObsidianLayoutRepository } from '@app/db';
import { buildObsidianMirror } from './obsidian-mirror.js';
import { obsidianLayoutConfigSchema, type ObsidianLayoutConfig } from '@app/integration-contracts';
import { jobTaskPayload } from "../job-task-payload.js";
import { createSourceItemRepository } from "@app/db";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { createDocumentRepository, createJobRepository, createObsidianSyncRepository, createObsidianWikiRepository, createWikiRepository, createSettingsRepository, type PgPool, type JobRecord, type ProjectionDelivery } from "@app/db";
import { WikiPageSchema, type WikiPage } from "@app/domain";
import { translate, type MessageKey } from "@app/i18n";
import { markdownHeading, normalizeProjectionText, parseObsidianMarkdown, parseWikiRegions, serializeManagedFrontmatter, sectionStart, sectionEnd, wikiGeneratedStart, wikiGeneratedEnd, wikiLink, safeWikiLabel, type ObsidianManagedFrontmatter } from "@app/integration-contracts";
import type { StorageSettings } from "../../shared/ipc.js";
import { collisionFileName, slugify } from "./obsidian-projection.js";
import { safeVaultPath } from "../workers/obsidian-sync.worker.js";
export { obsidianWikiScopeSchema as ObsidianWikiScopeSchema } from "../../shared/ipc.js";
import { obsidianWikiScopeSchema as ObsidianWikiScopeSchema } from "../../shared/ipc.js";
export type ObsidianWikiScope = z.infer<typeof ObsidianWikiScopeSchema>;
const INDEX = '7cfe90b4-11fb-447d-9673-849b6a3dc000', CATALOG = '7cfe90b4-11fb-447d-9673-849b6a3dc001', RELATIONS = '7cfe90b4-11fb-447d-9673-849b6a3dc002';
export const projectionHash = (text: string) => createHash('sha256').update(normalizeProjectionText(text)).digest('hex');
const active = (s: StorageSettings) => s.obsidianSyncEnabled && !s.obsidianSyncPaused && Boolean(s.obsidianVaultPath);
export interface WikiProjectionOptions {
    getPool: () => PgPool | null;
    getStorageSettings: () => Promise<StorageSettings>;
    getLocale?: () => Promise<string>;
    assetRoots?:()=>Promise<Record<string,string>>;
    projectSource: (id: string, allowedNoteIds?: Set<string>, admittedBinding?:string) => Promise<{
        projected: number;
    }>;
    write: (input: {
        vaultPath: string;
        relativePath: string;
        content: string;
        expectedHash: string | null;
        recoveryId: string;
        managedRoot: string;
    }) => Promise<{
        mtimeMs: number;
    }>;
}
interface Target {
    id: string;
    type: ObsidianManagedFrontmatter['memoraType'];
    revision: string;
    title: string;
    path: string;
    editorial: string;
    generated: string;
    sourceId?: string;
    documentId?: string;
    layout?: ObsidianLayoutConfig;
    linkMap?:Array<{rendered:string;canonical:string}>;
    rootSourceId?:string;divisionId?:string;documentRevisionId?:string;
}
export class ObsidianWikiProjection {
    constructor(private readonly options: WikiProjectionOptions) { }
    private pool() { const pool = this.options.getPool(); if (!pool)
        throw new Error('errors.database.notReady'); return pool; }
    async layout(): Promise<ObsidianLayoutConfig|null> { const value=await createSettingsRepository(this.pool()).get('obsidian.layout'); return value && (value as {version?:number}).version!==1?obsidianLayoutConfigSchema.parse(value):null; }
    async ensureLayout(){const existing=await this.layout();if(existing)return existing;const s=await this.options.getStorageSettings();if(active(s)&&!await createSettingsRepository(this.pool()).get('obsidian.layout')&&!(await createObsidianSyncRepository(this.pool()).list(1)).length){const config=obsidianLayoutConfigSchema.parse({version:2,language:await this.options.getLocale?.()??'en',attachments:'omit'});await createSettingsRepository(this.pool()).set('obsidian.layout',config);return config;}return null;}
    async assets(config:ObsidianLayoutConfig,migrate=false){const s=await this.options.getStorageSettings(),scope=await this.scope(),sources=await createObsidianWikiRepository(this.pool()).sources(scope.sourceIds,scope.includeDescendants);return inspectMirrorAssets(this.pool(),s,sources.map(r=>String(r.id)),config,await this.options.assetRoots?.()??{},migrate);}
    async mirror(config:ObsidianLayoutConfig,migrate=false,excluded?:Set<string>) { const s=await this.options.getStorageSettings(); const assets=await this.assets(config,migrate);for(const asset of assets)if(excluded?.has(asset.id)){const old=await createObsidianSyncRepository(this.pool()).findByMemoraId(asset.id);if(old)asset.path=old.relativePath;}return buildObsidianMirror(this.pool(),s.managedRoot,await this.scope(),config,{migrate,assets,...(excluded?{excluded}:{})}); }
    async scope() { return ObsidianWikiScopeSchema.parse(await createSettingsRepository(this.pool()).get('obsidian.wiki.scope') ?? {}); }
    async saveScope(input: unknown) { const scope = ObsidianWikiScopeSchema.parse(input); await createSettingsRepository(this.pool()).set('obsidian.wiki.scope', scope); return scope; }
    private vaultBinding(settings: StorageSettings) { return projectionHash(JSON.stringify([settings.obsidianVaultPath, settings.managedRoot])); }
    private async binding(settings: StorageSettings) { return projectionHash(JSON.stringify([settings.obsidianVaultPath, settings.managedRoot, await this.scope()])); }
    async sourceAdmission(settings:StorageSettings,admittedBinding?:string){const binding=admittedBinding??await this.binding(settings);await this.assertBinding(settings,binding);return binding;}
    async assertSourceExport(settings:StorageSettings,binding:string,sourceId:string,noteIds:string[]=[]){
        await this.assertBinding(settings,binding);
        const scope=await this.scope();
        if(!await createObsidianWikiRepository(this.pool()).exportEligible(sourceId,noteIds,scope.sourceIds,scope.includeDescendants))throw new Error('obsidianWiki.errors.binding');
        await this.assertBinding(settings,binding);
    }
    async enqueue(force = false) { const settings = await this.options.getStorageSettings(); if (!active(settings))
        return null; return createObsidianWikiRepository(this.pool()).enqueue(await this.binding(settings), force); }
    async status() { const settings = await this.options.getStorageSettings(), repository = createObsidianWikiRepository(this.pool()); const job = await createJobRepository(this.pool()).latestByType('obsidian-wiki'); return { active: active(settings), job: job ? { status: job.status, error: job.error } : null, scope: await this.scope(), conflicts: await repository.conflicts(this.vaultBinding(settings)) }; }
    async diff(id: string) { const row = await createObsidianWikiRepository(this.pool()).getDelivery(id), settings = await this.options.getStorageSettings(); if (!row || row.binding_hash !== this.vaultBinding(settings))
        throw new Error('obsidianWiki.errors.binding'); const path = await safeVaultPath(settings.obsidianVaultPath!, row.relative_path); const local = await readOptional(path); return { id, relativePath: row.relative_path, base: row.before_content ?? '', local: local ?? '', proposed: row.content, localHash: local === null ? null : projectionHash(local) }; }
    async recover(id: string, expectedHash: string | null) {
        const repository = createObsidianWikiRepository(this.pool()), row = await repository.getDelivery(id);
        if (!row)
            throw new Error('obsidianWiki.errors.binding');
        const latest = await repository.latest(row.memora_id, row.binding_hash);
        if (latest?.id !== row.id)
            throw new Error('obsidianWiki.errors.conflict');
        const canonical = await createWikiRepository(this.pool()).get(row.memora_id);
        if (canonical && canonical.revisionId !== row.revision_id)
            throw new Error('obsidianWiki.errors.conflict');
        const settings = await this.options.getStorageSettings();
        if (row.binding_hash !== this.vaultBinding(settings))
            throw new Error("obsidianWiki.errors.binding");
        await this.assertBinding(settings, await this.binding(settings));
        const scope=await this.scope(),eligible=await repository.sources(scope.sourceIds,scope.includeDescendants),frame=parseObsidianMarkdown(row.content)?.frontmatter;
        if(frame?.memoraType==='source_item'){
          if(!eligible.some(s=>s.id===row.memora_id)||!frame.memoraDocumentId)throw new Error('obsidianWiki.errors.binding');
          const document=await createDocumentRepository(this.pool()).findById(frame.memoraDocumentId);if(!document||projectionHash(normalizeProjectionText(document.canonicalMarkdown))!==row.editable_hash)throw new Error('obsidianWiki.errors.conflict');
        }else{
          const plan=await this.plan(settings,scope,eligible,await repository.notes(eligible.map(s=>String(s.id)))),current=plan.find(t=>t.id===row.memora_id);
          if(!current||current.revision!==row.revision_id||projectionHash(current.editorial)!==row.editable_hash||projectionHash(current.generated)!==row.generated_hash)throw new Error('obsidianWiki.errors.conflict');
        }
        const local = await readOptional(await safeVaultPath(settings.obsidianVaultPath!, row.relative_path));
        if ((local === null ? null : projectionHash(local)) !== expectedHash)
            throw new Error('obsidianWiki.errors.conflict');
        // Explicit user recovery preserves the local file in the managed recovery directory and history.
        const replacement = await repository.prepare({ ...row, before_content: local, base_hash: expectedHash });
        await this.deliver(replacement, settings, await this.binding(settings));
        return this.status();
    }
    async execute(job: JobRecord, signal?: AbortSignal) {
        const payload = z.object({ binding: z.string(), generation: z.string() }).strict().parse(jobTaskPayload(job.payload));
        const settings = await this.options.getStorageSettings();
        await this.assertBinding(settings, payload.binding);
        const repository = createObsidianWikiRepository(this.pool()), scope = await this.scope();
        const sources = await repository.sources(scope.sourceIds, scope.includeDescendants);
        if (sources.length > 1000)
            throw new Error('obsidianWiki.errors.limit');
        const ids = sources.map(s => String(s.id)), notes = await repository.notes(ids);
        if (notes.length > 2000)
            throw new Error('obsidianWiki.errors.limit');
        const allowedNotes = new Set(notes.map(n => String(n.id)));
        let projected = 0, conflicts = 0;
        let layout=await this.layout();
        if(!layout && !await createSettingsRepository(this.pool()).get('obsidian.layout') && !(await createObsidianSyncRepository(this.pool()).list(1)).length){layout=obsidianLayoutConfigSchema.parse({version:2,language:await this.options.getLocale?.()??'en',attachments:'omit'});await createSettingsRepository(this.pool()).set('obsidian.layout',layout);}
        for (const source of layout?[]:sources) {
            if (signal?.aborted)
                throw new Error('obsidianWiki.errors.paused');
            await this.assertBinding(settings, payload.binding);
            if (!source.catalogOnly) {
                try {
                    projected += (await this.options.projectSource(String(source.id), allowedNotes,payload.binding)).projected;
                }
                catch (error) {
                    if (String(error).includes('conflict'))
                        conflicts++;
                    else
                        throw error;
                }
            }
        }
        if(layout)await projectMirrorAssets(this.pool(),settings,await this.assets(layout),await this.options.assetRoots?.()??{},()=>this.assertBinding(settings,payload.binding));
        const targets = layout ? await this.mirror(layout) : await this.plan(settings, scope, sources, notes);
        if (targets.reduce((n, t) => n + t.editorial.length + t.generated.length, 0) > 20000000)
            throw new Error('obsidianWiki.errors.limit');
        for (const target of targets) {
            if (signal?.aborted)
                throw new Error('obsidianWiki.errors.paused');
            await this.assertBinding(settings, payload.binding);
            try {
                projected += await this.project(target, settings, payload.binding);
            }
            catch (error) {
                if (/conflict|format|write|limit/.test(String(error)))
                    conflicts++;
                else
                    throw error;
            }
        }
        return { projected, conflicts, targets: targets.length };
    }
    private async assertBinding(settings: StorageSettings, binding: string) { if(await createObsidianLayoutRepository(this.pool()).active(this.vaultBinding(settings)))throw new Error("obsidianWiki.errors.paused"); const current = await this.options.getStorageSettings(); if (!active(current))
        throw new Error('obsidianWiki.errors.paused'); if (settings.obsidianVaultPath !== current.obsidianVaultPath || settings.managedRoot !== current.managedRoot || await this.binding(current) !== binding)
        throw new Error('obsidianWiki.errors.binding'); }
    private async plan(settings: StorageSettings, scope: ObsidianWikiScope, sources: Record<string, any>[], notes: Record<string, any>[]): Promise<Target[]> {
        const pool = this.pool(), repo = createObsidianWikiRepository(pool), sync = createObsidianSyncRepository(pool), wiki = createWikiRepository(pool), locale = await this.options.getLocale?.() ?? 'en';
        const t = (key: MessageKey) => translate(locale, key);
        const relationStatus = (status: string) => t(("sourceRelations." + status) as MessageKey);
        const bibliography = (source: Record<string, any>) => [source.metadata, ...source.bibliography ?? []].flatMap(item => { const creators = Array.isArray(item.creators) ? item.creators.map((c: any) => typeof c === 'string' ? c : c.name ?? c.displayName ?? [c.givenName, c.familyName].filter(Boolean).join(' ')).filter(Boolean).join(', ') : ''; return [creators, ...['publicationDate', 'publisher', 'edition', 'doi', 'isbn', 'issn'].filter(key => item[key]).map(key => `${key === 'isbn' || key === 'issn' ? key.toUpperCase() : t(('import.metadataFields.' + key) as MessageKey)}: ${safeWikiLabel(String(item[key]))}`), ...Object.entries(item.identifiers ?? {}).map(([key, value]) => `${safeWikiLabel(key)}: ${safeWikiLabel(String(value))}`)].filter(Boolean); }).join('\n\n');
        const pageIds = await repo.pages(scope.pageIds);
        if (pageIds.length > 1000)
            throw new Error('obsidianWiki.errors.limit');
        const allowed = new Set(sources.map(s => String(s.id)));
        const pages: WikiPage[] = [];
        let pageBytes=0;
        for (const id of pageIds) {
            if (scope.pageIds.length && !scope.pageIds.includes(id))
                continue;
            const bytes=await repo.pageBytes(id);pageBytes+=bytes;if(bytes>2_000_000||pageBytes>20_000_000)throw new Error('obsidianWiki.errors.limit');
            const p = WikiPageSchema.parse(await wiki.get(id));
            if ((!scope.sourceIds.length || p.evidence.every(e => allowed.has(e.sourceItemId))) && (!p.archived || await sync.findByMemoraId(p.id)))
                pages.push(p);
        }
        const relations = await repo.relations([...allowed]);
        if (relations.length > 1000 || relations.some(r => r.evidence.length > 100))
            throw new Error('obsidianWiki.errors.limit');
        if(sources.some(source=>(source.bibliography??[]).length>20))throw new Error('obsidianWiki.errors.limit');
        const paths = new Map<string, string>(), used = new Set<string>(), missing = new Set<string>();
        const targets: Target[] = [];
        const reserve = async (id: string, type: Target['type'], title: string, directory: string, base: string, sourceId?: string) => { const old = await sync.findByMemoraId(id); if(old?.metadata.editorialTombstone||old?.status==='deleted')missing.add(id); let path = old?.relativePath; if (path && !path.startsWith(`${settings.managedRoot}/`))
            throw new Error('obsidianWiki.errors.binding'); if (!path) {
            for (let attempt = 0; attempt <= 100; attempt++) {
                const candidate = posix.join(directory, collisionFileName(base, new Date(), attempt, id));
                if (!used.has(candidate) && !await sync.findByRelativePath(candidate) && await readOptional(await safeVaultPath(settings.obsidianVaultPath!, candidate)) === null) {
                    path = candidate;
                    break;
                }
            }
        } if (!path)
            throw new Error('obsidianWiki.errors.limit'); paths.set(id, path); used.add(path); if (!old)
            await sync.create({ memoraId: id, entityId: id, entityType: type, memoraType: type, ...(sourceId ? { sourceItemId: sourceId } : {}), relativePath: path, frontmatterHash: projectionHash(''), contentHash: projectionHash(''), mtimeMs: 0, status: 'pending', metadata: { projectionFormat: 1, bindingHash: this.vaultBinding(settings) } }); return path; };
        for (const source of sources) {
            const old = await sync.findByMemoraId(source.id);
            if(old?.metadata.editorialTombstone||old?.status==='deleted')missing.add(source.id);
            if (old)
                paths.set(source.id, old.relativePath);
            if (source.catalogOnly)
                await reserve(source.id, 'source_reference', source.title, posix.join(settings.managedRoot, 'Sources', 'References'), `${slugify(source.title)}.md`, source.id);
        }
        for (const note of notes) {
            const file = await sync.findByMemoraId(note.id);
            if(file?.metadata.editorialTombstone||file?.status==='deleted')missing.add(note.id);
            if (file)
                paths.set(note.id, file.relativePath);
        }
        await reserve(INDEX, 'wiki_index', t('wiki.title'), posix.join(settings.managedRoot, 'Wiki'), 'index.md');
        await reserve(CATALOG, 'wiki_index', t('obsidianWiki.catalog'), posix.join(settings.managedRoot, 'Wiki', 'Sources'), 'index.md');
        await reserve(RELATIONS, 'wiki_index', t('obsidianWiki.connections'), posix.join(settings.managedRoot, 'Wiki', 'Connections'), 'index.md');
        const groups = { topic: 'Topics', entity: 'Entities', collection: 'Collections', synthesis: 'Syntheses' };
        const place = async (page: WikiPage, seen = new Set<string>()): Promise<string> => { if (paths.has(page.id))
            return paths.get(page.id)!; if (seen.has(page.id))
            throw new Error('wiki.errors.cycle'); seen.add(page.id); const parent = pages.find(p => p.id === page.parentId); let directory = posix.join(settings.managedRoot, 'Wiki', groups[page.kind]); if (parent) {
            const parentPath = await place(parent, seen);
            directory = parentPath.endsWith('/index.md') ? posix.dirname(parentPath) : parentPath.replace(/\.md$/, '');
        } const owns = pages.some(p => p.parentId === page.id); return reserve(page.id, 'wiki_page', page.title, owns ? posix.join(directory, slugify(page.title)) : directory, owns ? 'index.md' : `${slugify(page.title)}.md`); };
        for (const p of pages)
            await place(p);
        for (const r of relations)
            await reserve(r.id, 'source_relation', `${r.sourceTitle} ${r.targetTitle}`, posix.join(settings.managedRoot, 'Wiki', 'Connections'), `${slugify(r.sourceTitle)}--${slugify(r.targetTitle)}.md`);
        const link = (id: string, title: string, kind = 'source') => {if(!missing.has(id))return wikiLink(paths.get(id),title,id,kind);const note=notes.find(n=>n.id===id),relation=relations.find(r=>r.id===id);return (relation?`[${safeWikiLabel(title)}](memora://open/source/${relation.source_item_id}?relation=${id})`:wikiLink(undefined,title,note?note.sourceId:id,note?'source':kind))+' · '+t('obsidianEditing.deleted');};
        const list = (items: Record<string, any>[], kind = 'wiki') => items.map(p => `- ${link(p.id, p.title, kind)}`).join('\n');
        const add = (id: string, type: Target['type'], revision: string, title: string, editorial: string, generated: string, sourceId?: string) => { targets.push({ id, type, revision, title, path: paths.get(id)!, editorial, generated, ...(sourceId ? { sourceId } : {}) }); };
        const sourceReferences=(text:string)=>text.replace(/<source-ref\b[^>]*\bid=["']([^"']+)["'][^>]*\/?>(?:<\/source-ref>)?/g,(_m,id:string)=>{const source=sources.find(s=>s.id===id);return source?link(id,source.title):t('obsidianWiki.unavailable');}).replace(/<\/?source-ref[^>]*>/g,t('obsidianWiki.unavailable'));
        const quote = (text: string) => text.split('\n').map(line => `> ${line.replace(/<!--\s*memora:/g, '&lt;!-- memora:')}`).join('\n');
        for (const source of sources.filter(s => s.catalogOnly)) {
            const children = sources.filter(s => s.parentId === source.id);
            add(source.id, 'source_reference', projectionHash(JSON.stringify(source)), source.title, `# ${safeWikiLabel(source.title)}\n\n`, `${t('obsidianWiki.catalogOnly')}\n\n${t(("import.sourceTypes." + source.type) as MessageKey)}\n\n${bibliography(source)}\n\n${safeWikiLabel(source.subtitle ?? '')}\n\n${safeWikiLabel(source.sourceUri ?? '')}\n\n${list(children, 'source')}\n\n${link(CATALOG, t('obsidianWiki.catalog'), 'wiki')}`, source.id);
        }
        for (const page of pages) {
            const editorial = `# ${markdownHeading(page.title)}\n\n` + page.sections.map(s => { return `${sectionStart(s.id)}\n## ${markdownHeading(s.title)}\n\n${sourceReferences(s.markdown)}\n${sectionEnd(s.id)}\n\n^memora-section-${s.id}\n`; }).join('\n') + '\n';
            const pageSources = new Set(page.evidence.map(e => e.sourceItemId));
            const citations = page.evidence.map(e => `### ${e.id}\n\n${link(e.sourceItemId, e.sourceTitle)} · ${e.documentId} · ${safeWikiLabel(e.locator ?? '')} · ${e.current ? t('obsidianWiki.current') : t('obsidianWiki.historical')}\n\n${quote(e.excerpt)}\n\n^memora-evidence-${e.id}\n\n[${t('obsidianWiki.openApp')}](memora://open/wiki/${page.id}?revision=${page.revisionId}&evidence=${e.id})`).join('\n\n');
            const sectionEvidence = page.sections.map(s => `- [[#^memora-section-${s.id}|${safeWikiLabel(s.title)}]] · ${t(("wiki.provenanceTypes." + s.provenance) as MessageKey)} · ${s.evidenceReview === 'needs_review' ? t('wiki.needsEvidenceReview') : t('wiki.reviewed')}${s.protected ? ' · ' + t('obsidianWiki.protected') : ''}: ${s.evidenceIds.map(e => `[[#^memora-evidence-${e}|${page.evidence.findIndex(x => x.id === e) + 1}]]`).join(', ')}`).join('\n');
            const children = pages.filter(p => !p.archived && (p.parentId === page.id || p.collectionIds.includes(page.id)));
            const parent = pages.find(p => p.id === page.parentId);
            const generated = [t('obsidianWiki.readOnly'), `${page.archived ? t("maintenance.archivedRecoverable") : t(("wiki." + page.review) as MessageKey)} · ${page.revisionId}`, page.aliases.map(safeWikiLabel).join(', '), link(INDEX, t('wiki.title'), 'wiki'), parent ? link(parent.id, parent.title, 'wiki') : '', list(children), list(pages.filter(p => page.collectionIds.includes(p.id))), sectionEvidence, citations, list(notes.filter(n => pageSources.has(n.sourceId) && paths.has(n.id)), 'note'), list(relations.filter(r => pageSources.has(r.source_item_id) && pageSources.has(r.target_source_item_id)).map(r => ({ id: r.id, title: `${r.sourceTitle} → ${r.targetTitle}` }))), '[ ' + t('obsidianWiki.openApp') + ` ](memora://open/wiki/${page.id})`].filter(Boolean).join('\n\n');
            add(page.id, 'wiki_page', page.revisionId, page.title, editorial, generated);
        }
        for (const r of relations) {
            const replace = (text: string) => text.replace(/<source-ref\b[^>]*\bid=["']([^"']+)["'][^>]*\/?>(?:<\/source-ref>)?/g, (_m, id: string) => id === r.source_item_id ? link(id, r.sourceTitle) : id === r.target_source_item_id ? link(id, r.targetTitle) : t('obsidianWiki.unavailable')).replace(/<\/?source-ref[^>]*>/g, t('obsidianWiki.unavailable'));
            const evidence = r.evidence.map((e: Record<string, any>) => `### ${e.id} · ${e.origin === 'atomic_notes' ? t('sourceRelations.atomicNotes') : t('sourceRelations.sourceAnalysis')} · ${e.current ? t('obsidianWiki.current') : t('obsidianWiki.historical')}\n\n${link(r.source_item_id, r.sourceTitle)} · ${e.sourceDocumentId ?? e.snapshot.sourceId} · ${safeWikiLabel(e.sourceLocator ?? '')}\n\n${quote(e.snapshot.sourceExcerpt ?? '')}\n\n${link(r.target_source_item_id, r.targetTitle)} · ${e.targetDocumentId ?? e.snapshot.targetId} · ${safeWikiLabel(e.targetLocator ?? '')}\n\n${quote(e.snapshot.targetExcerpt ?? '')}`).join('\n\n');
            add(r.id, 'source_relation', projectionHash(JSON.stringify(r)), `${r.sourceTitle} → ${r.targetTitle}`, `# ${safeWikiLabel(r.sourceTitle)} → ${safeWikiLabel(r.targetTitle)}\n\n`, `${t('obsidianWiki.readOnly')}\n\n${r.id} · ${t(("knowledge.relations.types." + r.relation_type) as MessageKey)} · ${relationStatus(r.status)} · ${r.current ? t('obsidianWiki.current') : t('obsidianWiki.historical')}\n\n${link(r.source_item_id, r.sourceTitle)} → ${link(r.target_source_item_id, r.targetTitle)}\n\n${replace(r.source_idea)}\n\n${replace(r.target_idea)}\n\n${replace(r.explanation)}\n\n${evidence}\n\n[${t('obsidianWiki.openApp')}](memora://open/source/${r.source_item_id}?relation=${r.id})`);
        }
        add(INDEX, 'wiki_index', projectionHash(JSON.stringify(pages.map(p => [p.id, p.revisionId]))), t('wiki.title'), `# ${t('wiki.title')}\n\n`, [list(pages.filter(p => !p.archived && !pages.some(parent => parent.id === p.parentId && !parent.archived))), link(CATALOG, t('obsidianWiki.catalog'), 'wiki'), link(RELATIONS, t('obsidianWiki.connections'), 'wiki')].join('\n\n'));
        add(CATALOG, 'wiki_index', projectionHash(JSON.stringify(sources)), t('obsidianWiki.catalog'), `# ${t('obsidianWiki.catalog')}\n\n`, sources.map(s => `- ${link(s.id, s.title)}${s.parentId && allowed.has(s.parentId) ? ' ← ' + link(s.parentId, sources.find(p => p.id === s.parentId)!.title) : ''}${s.catalogOnly ? ' · ' + t('obsidianWiki.catalogOnly') : ''}`).join('\n'));
        add(RELATIONS, 'wiki_index', projectionHash(JSON.stringify(relations)), t('obsidianWiki.connections'), `# ${t('obsidianWiki.connections')}\n\n`, list(relations.map(r => ({ id: r.id, title: `${r.sourceTitle} → ${r.targetTitle} · ${relationStatus(r.status)}` }))));
        return targets;
    }
    async projectDocument(id:string,documentId:string,title:string,markdown:string,admittedBinding:string){const settings=await this.options.getStorageSettings(),file=await createObsidianSyncRepository(this.pool()).findByMemoraId(id);if(!file)throw new Error('obsidianWiki.errors.binding');const body=normalizeProjectionText(markdown);return this.project({id,type:'source_item',sourceId:id,documentId,title,revision:projectionHash(body),path:file.relativePath,editorial:body,generated:''},settings,admittedBinding);}
    async acknowledgeDocument(id:string){const settings=await this.options.getStorageSettings(),sync=createObsidianSyncRepository(this.pool()),file=await sync.findByMemoraId(id);if(!file||file.metadata.projectionFormat!==1)return;const raw=await readOptional(await safeVaultPath(settings.obsidianVaultPath!,file.relativePath)),parsed=raw?parseObsidianMarkdown(raw):null;if(!raw||!parsed||parsed.frontmatter.memoraType!=='source_item'||parsed.frontmatter.memoraId!==id||projectionHash(normalizeProjectionText(parsed.bodyMarkdown))!==file.contentHash)throw new Error('obsidianWiki.errors.conflict');const repo=createObsidianWikiRepository(this.pool()),base=await repo.base(id,this.vaultBinding(settings));const row=await repo.prepare({memora_id:id,revision_id:file.contentHash,binding_hash:this.vaultBinding(settings),relative_path:file.relativePath,content:raw,editable_hash:file.contentHash,generated_hash:projectionHash(''),rendered_hash:projectionHash(raw),base_hash:base?.rendered_hash??null,before_content:base?.content??null});await this.receipt(row,settings);}
    private async project(target: Target, settings: StorageSettings, jobBinding: string): Promise<number> {
        const binding = this.vaultBinding(settings);
        const repo = createObsidianWikiRepository(this.pool()), sync = createObsidianSyncRepository(this.pool());
        let latest = await repo.latest(target.id, binding);
        if(!await sync.findByMemoraId(target.id))await sync.create({memoraId:target.id,entityId:target.id,entityType:target.type,memoraType:target.type,...(target.sourceId?{sourceItemId:target.sourceId}:{}),...(target.documentId?{documentId:target.documentId}:{}),relativePath:target.path,contentHash:projectionHash(''),frontmatterHash:projectionHash(''),mtimeMs:0,status:'pending',metadata:{projectionFormat:target.layout?2:1,bindingHash:binding}});
        let file = await sync.findByMemoraId(target.id);
        if(file?.metadata.editorialPending || file?.metadata.editorialTombstone || target.layout&&file?.metadata.layoutExcluded)return 0;
        const path = await safeVaultPath(settings.obsidianVaultPath!, target.path), local = await readOptional(path);
        const localHash = local === null ? null : projectionHash(local);
        if (latest && latest.status !== 'written' && localHash === latest.rendered_hash) {
            await this.receipt(latest, settings);
            file=await sync.findByMemoraId(target.id);
            latest = await repo.latest(target.id, binding);
        }
        const actualBase = await repo.base(target.id, binding);
        const parsed = local === null ? null : parseObsidianMarkdown(local);
        const adoptLegacy = target.type === 'source_reference' && !actualBase && parsed?.frontmatter.memoraId === target.id && parsed.frontmatter.memoraType === 'source_item' && parsed.frontmatter.memoraSyncVersion === file?.syncVersion && projectionHash(normalizeProjectionText(parsed.bodyMarkdown)) === file.contentHash;
        const body = target.type==='source_item'&&!target.layout?target.editorial:target.editorial + wikiGeneratedStart + '\n\n' + target.generated + '\n\n' + wikiGeneratedEnd + '\n';
        const fm: ObsidianManagedFrontmatter = { ...(target.linkMap?.length?{memoraLinkMap:target.linkMap}:{}), ...(target.rootSourceId?{memoraRootSourceId:target.rootSourceId}:{}),...(target.divisionId?{memoraDivisionId:target.divisionId}:{}),...(target.documentRevisionId?{memoraDocumentRevisionId:target.documentRevisionId}:{}), memoraId: target.id, memoraType: target.type, memoraManaged: true, memoraSyncVersion: (file?.syncVersion ?? 0) + (actualBase?.revision_id === target.revision ? 0 : 1), memoraContentHash: projectionHash(target.editorial), ...(target.layout?{memoraLayout:2,memoraLayoutLanguage:target.layout.language,memoraWikiSchema:2,memoraRevisionId:target.revision,...(target.documentId?{memoraDocumentId:target.documentId}:{})}:target.type==='source_item'?{memoraDocumentId:target.documentId}:{memoraWikiSchema: 1, memoraRevisionId: target.revision}), ...(target.sourceId ? { memoraSourceId: target.sourceId } : {}) };
        let content = serializeManagedFrontmatter(fm, parsed?.userFrontmatter ?? '') + '\n' + body, renderedHash = projectionHash(content);
        if(actualBase&&renderedHash!==actualBase.rendered_hash&&fm.memoraSyncVersion<=(file?.syncVersion??0)){fm.memoraSyncVersion=(file?.syncVersion??0)+1;content=serializeManagedFrontmatter(fm,parsed?.userFrontmatter??'')+'\n'+body;renderedHash=projectionHash(content);}
        if (actualBase && localHash === actualBase.rendered_hash && renderedHash === actualBase.rendered_hash)
            return 0;
        if (latest && ['conflict', 'error'].includes(latest.status) && latest.rendered_hash === renderedHash)
            throw new Error('obsidianWiki.errors.conflict');
        const delivery = await repo.prepare({ memora_id: target.id, revision_id: target.revision, binding_hash: binding, relative_path: target.path, content, editable_hash: projectionHash(target.editorial), generated_hash: projectionHash(target.generated), rendered_hash: renderedHash, base_hash: actualBase?.rendered_hash ?? (adoptLegacy ? localHash : null), before_content: actualBase?.content ?? (adoptLegacy ? local : null) });
        if (target.type!=='source_item'&&!parseWikiRegions(body)) {
            await repo.finish(delivery.id, 'error', 'obsidianWiki.errors.format');
            throw new Error('obsidianWiki.errors.format');
        }
        // Missing registered files are also pending edits. Never infer deletion or silently recreate them.
        if ((actualBase && localHash !== actualBase.rendered_hash) || (!actualBase && local !== null && !adoptLegacy) || (!actualBase && file?.metadata.bindingHash && file.metadata.bindingHash !== binding)) {
            await repo.finish(delivery.id, 'conflict', 'obsidianWiki.errors.conflict');
            await sync.update(file!.id, { status: 'conflict' });
            throw new Error('obsidianWiki.errors.conflict');
        }
        await this.deliver(delivery, settings, jobBinding);
        return 1;
    }
    private async deliver(row: ProjectionDelivery, settings: StorageSettings, jobBinding: string) { const repo = createObsidianWikiRepository(this.pool()); return repo.withTargetLock(row.memora_id, async () => { try {
        await this.assertBinding(settings, jobBinding);
        const targetFrame=parseObsidianMarkdown(row.content)?.frontmatter;
        if(targetFrame?.memoraType==='source_item')await this.assertSourceExport(settings,jobBinding,row.memora_id);
        const registry=createObsidianSyncRepository(this.pool()),registered=await registry.findByMemoraId(row.memora_id);if(registered)await registry.update(registered.id,{metadata:{...registered.metadata,projectionWrite:{renderedHash:row.rendered_hash,deliveryId:row.id}}});
        await this.assertBinding(settings,jobBinding);
        await this.options.write({ vaultPath: settings.obsidianVaultPath!, relativePath: row.relative_path, content: row.content, expectedHash: row.base_hash, recoveryId: row.id, managedRoot: settings.managedRoot });
        await this.receipt(row, settings);
    }
    catch (error) {
        const reason = String(error).includes('conflict') ? 'obsidianWiki.errors.conflict' : 'obsidianWiki.errors.write';
        await repo.finish(row.id, reason.endsWith('conflict') ? 'conflict' : 'error', reason);
        const file = await createObsidianSyncRepository(this.pool()).findByMemoraId(row.memora_id);
        if (file)
            await createObsidianSyncRepository(this.pool()).update(file.id, { status: 'conflict' });
        throw error;
    } }); }
    private async receipt(row: ProjectionDelivery, settings: StorageSettings) { const parsed = parseObsidianMarkdown(row.content); if (!parsed || (parsed.frontmatter.memoraType!=='source_item'&&!parseWikiRegions(parsed.bodyMarkdown)))
        throw new Error('obsidianWiki.errors.format'); const sync = createObsidianSyncRepository(this.pool()), file = await sync.findByMemoraId(row.memora_id); if (!file)
        throw new Error('obsidianWiki.errors.binding'); const {projectionWrite:_pending,...metadata}=file.metadata; await sync.update(file.id, { contentHash: parsed.frontmatter.memoraType==='source_item'&&!parsed.frontmatter.memoraLayout?projectionHash(normalizeProjectionText(parsed.bodyMarkdown)):parsed.frontmatter.memoraContentHash, frontmatterHash: projectionHash(serializeManagedFrontmatter(parsed.frontmatter)), syncVersion: parsed.frontmatter.memoraSyncVersion, mtimeMs: Math.trunc((await stat(await safeVaultPath(settings.obsidianVaultPath!, row.relative_path))).mtimeMs), memoraType: parsed.frontmatter.memoraType, ...(parsed.frontmatter.memoraType === 'source_reference' ? { documentId: null } : parsed.frontmatter.memoraDocumentId?{documentId:parsed.frontmatter.memoraDocumentId}:{}), status: 'synced', metadata: { ...metadata, bindingHash: row.binding_hash, projectionFormat: parsed.frontmatter.memoraLayout??1, ...(metadata.editorialBase?{editorialBase:{content:row.content,revision:parsed.frontmatter.memoraType==='source_item'?(await createSourceItemRepository(this.pool()).findById(row.memora_id))!.updatedAt.toISOString():row.revision_id,version:parsed.frontmatter.memoraSyncVersion,hash:row.rendered_hash},editorialBinding:row.binding_hash}:{}) }, lastSyncedAt: new Date() }); await createObsidianWikiRepository(this.pool()).finish(row.id, 'written'); }
}
async function readOptional(path: string): Promise<string | null> { try {
    const file = await stat(path);
    if (file.size > 2000000)
        throw new Error('obsidianWiki.errors.limit');
    return await readFile(path, 'utf8');
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null;
    throw error;
} }
