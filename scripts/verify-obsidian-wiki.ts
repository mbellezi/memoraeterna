import { PromptService } from '../apps/desktop/src/main/services/prompt-service.js';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PromptPinSchema, WikiPageSchema, WikiPageContentSchema } from "@app/domain";
import { createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations, createSourceItemRepository, createDocumentRepository, createChunkRepository, createWikiRepository, createSourceRelationRepository, createObsidianWikiRepository, createObsidianSyncRepository, createJobRepository, type PgPool } from "../packages/db/src/index.js";
import { ObsidianSyncService } from "../apps/desktop/src/main/services/obsidian-sync-service.js";
import { runObsidianSync } from "../apps/desktop/src/main/workers/obsidian-sync.worker.js";
import { projectionHash } from "../apps/desktop/src/main/services/obsidian-wiki-projection.js";
import { parseObsidianMarkdown, parseWikiRegions } from "@app/integration-contracts";
const root = resolve(import.meta.dirname, '..'), work = await mkdtemp(join(tmpdir(), 'memora-obsidian-wiki-')), migrations = join(root, 'packages/db/drizzle'), seedFolder = join(root, 'packages/db/seed');
const paths = resolvePostgresSidecarPaths({ cwd: root, env: process.env }), manager = new PostgresSidecarManager({ binDir: paths.binDir, dataDir: join(work, 'data'), database: 'obsidian_wiki_test', user: 'test', password: randomUUID(), startupTimeoutMs: 30000, shutdownTimeoutMs: 10000 });
let pool: PgPool | undefined, emptyPool: PgPool | undefined;
try {
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 5 });
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')), prior = journal.entries.filter((e: {
        idx: number;
    }) => e.idx < 28), old = join(work, 'old');
    await mkdir(join(old, 'meta'), { recursive: true });
    await writeFile(join(old, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prior }));
    for (const entry of prior)
        await copyFile(join(migrations, entry.tag + '.sql'), join(old, entry.tag + '.sql'));
    await runMigrations(pool, old);
    const sources = createSourceItemRepository(pool), documents = createDocumentRepository(pool), wiki = createWikiRepository(pool), book = await sources.create({ type: 'Book', title: 'Metadata-only book' }), a = await sources.create({ type: 'BookChapter', title: 'Memória 日本語' }), b = await sources.create({ type: 'AcademicPaper', title: 'Different evidence' });
    await pool.query('update source_items set parent_source_item_id=$1 where id=$2', [book.id, a.id]);
    const passage = async (source: typeof a, content: string) => { const document = await documents.create({ sourceItemId: source.id, title: source.title, canonicalMarkdown: '# ' + source.title + '\n\n' + content, contentHash: projectionHash(content) }); const id = randomUUID(), spanId = randomUUID(); await createChunkRepository(pool!).replaceDocumentChunks(document.id, source.id, [{ id, sourceSpanId: spanId, chunkIndex: 0, content, contentHash: projectionHash(content), span: { id: spanId, startOffset: 0, endOffset: content.length } }]); return { id, sourceItemId: source.id, documentId: document.id, sourceSpanId: spanId, content, contentHash: projectionHash(content), title: source.title, summary: null, rootId: source.id === a.id ? book.id : source.id }; };
    const ac = await passage(a, 'Original learning evidence.  \nHard break.'), bc = await passage(b, 'Counterevidence with conditions.');
    const content = WikiPageContentSchema.parse({ title: 'Mémoire 日本語', kind: 'topic', sections: [{ id: randomUUID(), title: 'Evidence', markdown: 'Thoughts.  \nA hard break.\n\n```markdown\n<!-- memora:generated:start -->\n```', evidenceIds: [ac.id, bc.id] }] });
    const pageId = await wiki.save({ expectedRevisionId: null, content, evidenceChunkIds: [ac.id, bc.id] });
    const collection = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Reading', kind: 'collection' }), evidenceChunkIds: [] });
    const child = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Mémoire 日本語', kind: 'topic', parentId: pageId, collectionIds: [collection] }), evidenceChunkIds: [] });
    await createSourceRelationRepository(pool).commitDecision('m4', book.id, b.id, [{ existingId: null, sourceItemId: a.id, targetSourceItemId: b.id, relationType: 'contrasts', sourceIdea: `<source-ref id="${a.id}" /> supports retrieval.`, targetIdea: `<source-ref id="${b.id}" /> adds conditions.`, explanation: `<source-ref id="${a.id}" /> differs from <source-ref id="${b.id}" />.`, importance: 0.9, confidence: 0.9, evidence: [{ source: ac, target: bc, note: null }] }], {});
    assert.equal((await runMigrations(pool, migrations, { seedFolder })).seed.applied, false);
    await new PromptService({getPool:()=>pool!}).initialize();
    const previousClock = (await pool.query('select generation from obsidian_projection_clock where id=1')).rows[0].generation;
    await pool.query('delete from obsidian_projection_clock where id=1');
    const admission = createObsidianWikiRepository(pool);
    const repaired = await Promise.all([admission.enqueue('missing-clock-regression'), admission.enqueue('missing-clock-regression')]);
    assert.equal(repaired[0], repaired[1], 'Concurrent missing-clock recovery deduplicates the projection job');
    assert.equal(Number((await pool.query('select generation from obsidian_projection_clock where id=1')).rows[0].generation), 0);
    await pool.query('update obsidian_projection_clock set generation=$1 where id=1', [previousClock]);
    await admission.enqueue('missing-clock-regression');
    assert.equal((await pool.query('select generation from obsidian_projection_clock where id=1')).rows[0].generation, previousClock, 'Admission preserves existing generations');
    await pool.query("delete from jobs where payload->>'binding'='missing-clock-regression'");
    assert.equal((await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, journal.entries.length);
    assert.equal((await pool.query("select count(*)::int as n from pg_indexes where tablename='obsidian_projection_revisions'")).rows[0].n, 3);
    assert.equal((await pool.query("select count(*)::int as n from pg_trigger where tgname='obsidian_projection_dirty'")).rows[0].n, 15);
    const vault = join(work, 'vault');
    await mkdir(vault);
    let settings = { obsidianVaultPath: vault, managedRoot: 'Memora', obsidianSyncEnabled: false, obsidianSyncPaused: false, deletionPolicy: 'delete' as const, uploadCopiesEnabled: false, uploadCopiesFolderPath: null, updatedAt: new Date().toISOString() };
    let writes = 0, afterWriteFailure = false,eventChecks=0;
    let failAfterWriteId:string|undefined;
    const service = new ObsidianSyncService({ getPool: () => pool!, getStorageSettings: async () => settings, writeProjection: async (input) => { writes++;
      const own=parseObsidianMarkdown(input.content)!;
      if(own.frontmatter.memoraType==='source_item'||own.frontmatter.memoraType==='atomic_note'){
        const deleted=await service.handleDeleted({eventId:randomUUID(),occurredAt:new Date().toISOString(),memoraId:own.frontmatter.memoraId,relativePath:input.relativePath,syncVersion:own.frontmatter.memoraSyncVersion});assert.equal(deleted.syncStatus,'ignored','Projection deletion event cannot delete canonical source');
        const changed=await service.handleChanged({eventId:randomUUID(),kind:'modified',occurredAt:new Date().toISOString(),note:{requestId:randomUUID(),relativePath:input.relativePath,frontmatter:own.frontmatter,markdown:own.bodyMarkdown,contentHash:own.frontmatter.memoraContentHash,mtimeMs:1}});assert.equal(changed.syncStatus,'ignored','Own in-flight projection is not imported');eventChecks++;
      }
      const output = await runObsidianSync({ action: 'write', ...input }); if (afterWriteFailure&&(!failAfterWriteId||own.frontmatter.memoraId===failAfterWriteId)) {
            afterWriteFailure = false;failAfterWriteId=undefined;
            throw new Error('simulated receipt loss');
        } return { mtimeMs: Number(output.mtimeMs) }; } });
    assert.equal(await service.wiki.enqueue(), null);
    assert.equal(writes, 0);
    settings = { ...settings, obsidianSyncEnabled: true };
    let firstProjectionJobId:string|null=null;
    const run = async () => { const jobId = (await service.wiki.enqueue(true))!, jobs = createJobRepository(pool!); let job = await jobs.findById(jobId); assert.ok(job);PromptPinSchema.parse(job.payload.promptPin);firstProjectionJobId??=job.id; await jobs.update(jobId, { status: 'running' }); try {
        const result = await service.wiki.execute(job);
        await jobs.update(jobId, { status: 'succeeded', result });
        return result;
    }
    catch (error) {
        await jobs.update(jobId, { status: 'failed', error: String(error) });
        throw error;
    } };
    const first = await run();
    // The catalog trigger applies to non-AI jobs too. Execute a persisted retry with the supervisor's envelope intact.
    const retryJobs=createJobRepository(pool),firstJob=(await retryJobs.findById(firstProjectionJobId!))!,admittedPin=structuredClone(firstJob.payload.promptPin);
    await retryJobs.update(firstJob.id,{status:'queued',payload:{...firstJob.payload,errorHistory:[{message:'Synthetic previous failure',stage:'obsidian-wiki',attempt:1,occurredAt:new Date().toISOString()}],dashboardDismissedAt:new Date().toISOString()}});
    const retry=(await retryJobs.findById(firstJob.id))!;await service.wiki.execute(retry);await retryJobs.update(retry.id,{status:'succeeded'});
    assert.deepEqual((await retryJobs.findById(retry.id))!.payload.promptPin,admittedPin,'Task extraction preserves persisted admission provenance on retry');
    await assert.rejects(service.wiki.execute({...retry,payload:{...retry.payload,unknownTaskAuthority:true}}),/unrecognized_keys/,'Unknown task fields remain rejected');
    const writeJob=await retryJobs.create({type:'obsidian-sync',payload:{action:'write',vaultPath:vault,relativePath:'Memora/Envelope-check.md',content:'Synthetic non-AI worker fixture',expectedHash:null}});PromptPinSchema.parse(writeJob.payload.promptPin);
    await runObsidianSync(writeJob.payload);assert.equal(await readFile(join(vault,'Memora/Envelope-check.md'),'utf8'),'Synthetic non-AI worker fixture');
    await assert.rejects(runObsidianSync({...writeJob.payload,unknownTaskAuthority:true}),/unrecognized_keys/);
    await retryJobs.update(writeJob.id,{status:'succeeded'});
    assert.equal((await pool.query('select count(*)::int n from ai_task_runs')).rows[0].n,0,'Projection and task-envelope compatibility never perform inference');
    assert.ok(first.projected >= 9);assert.ok(eventChecks>=2);assert.equal((await pool.query("select count(*)::int as n from source_items")).rows[0].n,3);
    const sync = createObsidianSyncRepository(pool), pageFile = (await sync.findByMemoraId(pageId))!, catalogFile = (await sync.findByMemoraId(book.id))!, childFile = (await sync.findByMemoraId(child))!;
    assert.ok(pageFile.relativePath.endsWith('/index.md'));
    assert.ok(!childFile.relativePath.endsWith('/index.md'));
    assert.equal(catalogFile.memoraType, 'source_reference');
    assert.equal(catalogFile.documentId, null);
    assert.equal((await documents.listBySourceItem(book.id)).length, 0);
    let raw = await readFile(join(vault, pageFile.relativePath), 'utf8');
    assert.ok(raw.includes(ac.content.split('\n')[0]!));
    assert.ok(raw.includes('memora-section-' + content.sections[0]!.id));
    assert.ok(parseWikiRegions(parseObsidianMarkdown(raw)!.bodyMarkdown));
    const rel = (await pool.query('select id from source_relations')).rows[0].id, relFile = (await sync.findByMemoraId(rel))!, relRaw = await readFile(join(vault, relFile.relativePath), 'utf8');
    assert.ok(!relRaw.includes('<source-ref'));
    assert.ok(relRaw.includes(bc.content));
    assert.ok(relRaw.indexOf('supports retrieval') < relRaw.indexOf('adds conditions'));
    assert.ok(relRaw.includes('AI suggestion'));
    assert.equal((await run()).projected, 0, 'Unchanged runs have no filesystem writes');
    // No plugin: body, frontmatter, generated regions, missing files all stay divergent.
    const original = raw;
    await writeFile(join(vault, pageFile.relativePath), raw.replace('Thoughts.', 'Offline human thoughts.').replace('\n---\n', '\ncustom_field: "keep me"\n---\n'));
    const modified = await readFile(join(vault, pageFile.relativePath), 'utf8');
    let page = WikiPageSchema.parse(await wiki.get(pageId));
    await wiki.save({ id: pageId, expectedRevisionId: page.revisionId, content: { ...WikiPageContentSchema.strip().parse(page), title: 'Application rename' }, evidenceChunkIds: [] });
    assert.ok((await run()).conflicts > 0);
    assert.equal(await readFile(join(vault, pageFile.relativePath), 'utf8'), modified);
    let status = await service.wiki.status(), conflict = status.conflicts.find(c => c.memora_id === pageId)!;
    let diff = await service.wiki.diff(conflict.id);
    assert.equal(diff.base, original);
    assert.equal(diff.local, modified);
    assert.ok(diff.proposed.includes('custom_field: "keep me"'));
    await assert.rejects(service.wiki.recover(conflict.id, '0'.repeat(64)), /conflict/);
    await service.wiki.recover(conflict.id, diff.localHash);
    raw = await readFile(join(vault, pageFile.relativePath), 'utf8');
    assert.ok(raw.includes('custom_field: "keep me"'));
    assert.ok(raw.includes('# Application rename'));
    assert.ok((await readdir(join(vault, 'Memora', '.memora-recovery'))).some(p => p.endsWith('.before.md')));
    const beforeGenerated = raw;
    await writeFile(join(vault, pageFile.relativePath), raw.replace('<!-- memora:generated:start -->', '<!-- memora:generated:start -->\nTampered navigation'));
    assert.ok((await run()).conflicts > 0);
    assert.equal((await service.wiki.diff((await service.wiki.status()).conflicts.find(c => c.memora_id === pageId)!.id)).base, beforeGenerated);
    // Stage one never imports wiki edits or deletes canonical pages through plugin/scanner events.
    const note = parseObsidianMarkdown(raw)!;
    assert.equal((await service.importNote({ requestId: randomUUID(), relativePath: pageFile.relativePath, frontmatter: note.frontmatter, markdown: 'Forged edit', contentHash: 'a'.repeat(64), mtimeMs: 1 })).accepted, false);
    assert.equal((await service.handleDeleted({ eventId: randomUUID(), occurredAt: new Date().toISOString(), memoraId: pageId, relativePath: pageFile.relativePath, syncVersion: 1 })).accepted, false);
    const beforeCount = (await pool.query('select count(*)::int as n from wiki_page_revisions')).rows[0].n;
    await service.reconcileVault();
    assert.equal((await pool.query('select count(*)::int as n from wiki_page_revisions')).rows[0].n, beforeCount);
    // Reset divergent target deliberately; archive and restore keep path/identity/history.
    conflict = (await service.wiki.status()).conflicts.find(c => c.memora_id === pageId)!;
    diff = await service.wiki.diff(conflict.id);
    await service.wiki.recover(conflict.id, diff.localHash);
    page = WikiPageSchema.parse(await wiki.get(pageId));
    await wiki.save({ id: pageId, expectedRevisionId: page.revisionId, content: { ...WikiPageContentSchema.strip().parse(page), archived: true }, evidenceChunkIds: [] });
    await run();
    assert.ok((await readFile(join(vault, pageFile.relativePath), 'utf8')).includes('Archived'));
    assert.equal((await sync.findByMemoraId(pageId))!.relativePath, pageFile.relativePath);
    page = WikiPageSchema.parse(await wiki.get(pageId));
    await wiki.save({ id: pageId, expectedRevisionId: page.revisionId, content: { ...WikiPageContentSchema.strip().parse(page), archived: false }, evidenceChunkIds: [] });
    afterWriteFailure = true;failAfterWriteId=pageId;
    await assert.rejects(run(), /simulated/);
    const observedWikiVersion=parseObsidianMarkdown(await readFile(join(vault,pageFile.relativePath),'utf8'))!.frontmatter.memoraSyncVersion;
    await run();
    assert.equal((await sync.findByMemoraId(pageId))!.status, 'synced');
    assert.equal((await sync.findByMemoraId(pageId))!.syncVersion,observedWikiVersion,'Wiki receipt recovery must not regress an already-written version');
    page=WikiPageSchema.parse(await wiki.get(pageId));await wiki.save({id:pageId,expectedRevisionId:page.revisionId,content:{...WikiPageContentSchema.strip().parse(page),sections:page.sections.map((section,index)=>index?section:{...section,markdown:section.markdown+'\nWiki version two.'})},evidenceChunkIds:[]});
    afterWriteFailure=true;failAfterWriteId=pageId;await assert.rejects(run(),/simulated/);
    const lostWikiVersion=parseObsidianMarkdown(await readFile(join(vault,pageFile.relativePath),'utf8'))!.frontmatter.memoraSyncVersion;
    page=WikiPageSchema.parse(await wiki.get(pageId));await wiki.save({id:pageId,expectedRevisionId:page.revisionId,content:{...WikiPageContentSchema.strip().parse(page),sections:page.sections.map((section,index)=>index?section:{...section,markdown:section.markdown+'\nWiki version three.'})},evidenceChunkIds:[]});await run();
    assert.equal((await sync.findByMemoraId(pageId))!.syncVersion,lostWikiVersion+1,'New wiki content after a lost receipt receives the next version');
    // Historical exact excerpt survives changed original source; both relation sides are historical.
    await pool.query("update documents set metadata=jsonb_build_object('supersededByDocumentId',$2::text) where id=$1", [ac.documentId, randomUUID()]);
    await run();
    raw = await readFile(join(vault, pageFile.relativePath), 'utf8');
    assert.ok(raw.includes('Historical evidence'));
    assert.ok(raw.includes('Original learning evidence.'));
    assert.ok((await readFile(join(vault, relFile.relativePath), 'utf8')).includes('Counterevidence with conditions.'));
    // Bound scope and pause are checked after job admission. Narrowing does not duplicate projections.
    const queued = (await service.wiki.enqueue(true))!, job = (await createJobRepository(pool).findById(queued))!;
    settings = { ...settings, obsidianSyncPaused: true };
    await assert.rejects(service.wiki.execute(job), /paused/);
    settings = { ...settings, obsidianSyncPaused: false };
    await service.wiki.saveScope({ sourceIds: [a.id], pageIds: [], includeDescendants: false });
    await assert.rejects(service.wiki.execute(job), /binding/);
    await createJobRepository(pool).update(job.id, { status: 'canceled' });
    const excludedBefore = await readFile(join(vault, pageFile.relativePath), 'utf8');
    await run();
    assert.equal(await readFile(join(vault, pageFile.relativePath), 'utf8'), excludedBefore, 'Mixed-scope page not exported');
    await service.wiki.saveScope({ sourceIds: [], pageIds: [], includeDescendants: true });
    await run();
    assert.equal((await sync.findByMemoraId(pageId))!.relativePath, pageFile.relativePath);
    // Optional ingestion progression keeps the same registered source reference path.
    let bookDocument=await documents.create({sourceItemId:book.id,title:book.title,canonicalMarkdown:'# Book\n\nNow there is substantive source text.',contentHash:projectionHash('Now there is substantive source text.')});
    await run();let promoted=(await sync.findByMemoraId(book.id))!;assert.equal(promoted.relativePath,catalogFile.relativePath);assert.equal(promoted.memoraType,'source_item');assert.equal(promoted.documentId,bookDocument.id);
    let promotedRaw=await readFile(join(vault,promoted.relativePath),'utf8');const parsedPromoted=parseObsidianMarkdown(promotedRaw)!;const importedBody=parsedPromoted.bodyMarkdown.replace('substantive source text','human source edit');await writeFile(join(vault,promoted.relativePath),promotedRaw.replace(parsedPromoted.bodyMarkdown,importedBody));
    const priorBookDocument=bookDocument;const {normalizeMarkdown}=await import('@app/conversion');await service.importNote({requestId:randomUUID(),relativePath:promoted.relativePath,frontmatter:parsedPromoted.frontmatter,markdown:importedBody,contentHash:projectionHash(normalizeMarkdown(importedBody)),mtimeMs:1});bookDocument=(await documents.listBySourceItem(book.id))[0]!;assert.notEqual(bookDocument.id,priorBookDocument.id);assert.equal((await documents.findById(priorBookDocument.id))!.canonicalMarkdown,priorBookDocument.canonicalMarkdown);await run();assert.ok(bookDocument.canonicalMarkdown.includes('human source edit'));assert.equal((await sync.findByMemoraId(book.id))!.status,'synced');
    promotedRaw=await readFile(join(vault,promoted.relativePath),'utf8');await writeFile(join(vault,promoted.relativePath),promotedRaw+'\nlocal tail');await pool.query("update documents set metadata=jsonb_build_object('processingMode','catalog_metadata') where id=$1",[bookDocument.id]);assert.ok((await run()).conflicts>0);assert.ok((await readFile(join(vault,promoted.relativePath),'utf8')).includes('local tail'));const sourceConflict=(await service.wiki.status()).conflicts.find(c=>c.memora_id===book.id)!;const sourceDiff=await service.wiki.diff(sourceConflict.id);await service.wiki.recover(sourceConflict.id,sourceDiff.localHash);assert.equal((await sync.findByMemoraId(book.id))!.memoraType,'source_reference');assert.equal((await sync.findByMemoraId(book.id))!.documentId,null);
    const legacyBefore=(await sync.findByMemoraId(b.id))!;await documents.update(bc.documentId,{canonicalMarkdown:'Source version two',contentHash:projectionHash('Source version two')});afterWriteFailure=true;await assert.rejects(run(),/simulated/);await documents.update(bc.documentId,{canonicalMarkdown:'Source version three',contentHash:projectionHash('Source version three')});await run();const legacyAfter=(await sync.findByMemoraId(b.id))!;assert.equal(legacyAfter.syncVersion,legacyBefore.syncVersion+2,'Lost receipt is reconciled before assigning newer source version');assert.ok((await readFile(join(vault,legacyAfter.relativePath),'utf8')).includes('Source version three'));
    // Revoke scope inside awaited source reads and between source/note writes.
    let readHook:((sql:string,args:unknown[])=>Promise<void>)|null=null,raceWrites=0;
    let afterRaceWrite:(()=>Promise<void>)|null=null;
    const racePool=new Proxy(pool,{get(target,key){if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(readHook&&typeof args[0]==='string')await readHook(args[0],args);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as PgPool;
    const raceService=new ObsidianSyncService({getPool:()=>racePool,getStorageSettings:async()=>settings,writeProjection:async input=>{raceWrites++;const result=await runObsidianSync({action:'write',...input});if(afterRaceWrite){const hook=afterRaceWrite;afterRaceWrite=null;await hook();}return {mtimeMs:Number(result.mtimeMs)};}});
    const onlyB={sourceIds:[b.id],pageIds:[],includeDescendants:false},onlyA={sourceIds:[a.id],pageIds:[],includeDescendants:false};
    await service.wiki.saveScope(onlyB);await documents.update(bc.documentId,{canonicalMarkdown:'Excluded source must not be exported.',contentHash:projectionHash('Excluded source must not be exported.')});const bBefore=await readFile(join(vault,legacyAfter.relativePath),'utf8');
    readHook=async sql=>{if(sql.includes('select id from document_revisions')){readHook=null;await service.wiki.saveScope(onlyA);}};
    await assert.rejects(raceService.projectSource(b.id),/binding/);assert.equal(raceWrites,0);assert.equal(await readFile(join(vault,legacyAfter.relativePath),'utf8'),bBefore);
    await service.wiki.saveScope({sourceIds:[book.id],pageIds:[],includeDescendants:false});await pool.query("update documents set metadata='{}'::jsonb where id=$1",[bookDocument.id]);const referenceBefore=await readFile(join(vault,catalogFile.relativePath),'utf8');
    readHook=async(sql,args)=>{if(sql.includes('from obsidian_sync_files where memora_id')&&(args[1] as string[])[0]===book.id){readHook=null;await service.wiki.saveScope(onlyA);}};
    await assert.rejects(raceService.projectSource(book.id),/binding/);assert.equal(raceWrites,0);assert.equal(await readFile(join(vault,catalogFile.relativePath),'utf8'),referenceBefore,'Reference promotion keeps the original admitted scope');
    await pool.query("update documents set metadata=jsonb_build_object('processingMode','catalog_metadata') where id=$1",[bookDocument.id]);
    const scopeNote=randomUUID();await pool.query(`insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key)
      values($1,'Scope race note','Scope race note','This note must not escape the revoked scope.',$2,$3,'approved','test','test','local','test',$1::uuid::text)`,[scopeNote,b.id,bc.id]);
    await service.wiki.saveScope(onlyB);afterRaceWrite=()=>service.wiki.saveScope(onlyA).then(()=>undefined);
    await assert.rejects(raceService.projectSource(b.id),/binding/);assert.equal(raceWrites,1,'Only the source admitted before revocation was written');assert.equal(await sync.findByMemoraId(scopeNote),null,'No note file is registered/written after revocation');
    // Changing note evidence ownership is checked even when the saved scope is unchanged.
    await service.wiki.saveScope(onlyB);await pool.query('insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)',[scopeNote,a.id,ac.id]);
    const fixedBinding=await service.wiki.sourceAdmission(settings);await assert.rejects(raceService.wiki.assertSourceExport(settings,fixedBinding,b.id,[scopeNote]),/binding/);
    await raceService.shutdown();await service.wiki.saveScope({sourceIds:[],pageIds:[],includeDescendants:true});
    // Legacy pre-write reads obey the same size and containment boundary as the writer.
    const legacyPath=join(vault,legacyAfter.relativePath),legacyBytes=await readFile(legacyPath,'utf8');
    await writeFile(legacyPath,'x'.repeat(2_000_001));
    await assert.rejects(service.projectSource(b.id),/limit/);
    await writeFile(legacyPath,legacyBytes);
    const externalFile=join(work,'external-source.md');await writeFile(externalFile,legacyBytes);
    await rm(legacyPath);await symlink(externalFile,legacyPath);
    await assert.rejects(service.projectSource(b.id),/symlink/);
    assert.equal(await readFile(externalFile,'utf8'),legacyBytes);
    await rm(legacyPath);await writeFile(legacyPath,legacyBytes);
    const generation = Number((await pool.query('select generation from obsidian_projection_clock')).rows[0].generation);
    const db = await pool.connect();
    await db.query('begin');
    await db.query('update wiki_pages set title=title where id=$1', [pageId]);
    await db.query('rollback');
    db.release();
    assert.equal(Number((await pool.query('select generation from obsidian_projection_clock')).rows[0].generation), generation, 'Canonical rollback does not publish invalidation');
    const outside = join(work, 'outside');
    await mkdir(outside);
    await symlink(outside, join(vault, 'Memora', 'escape'));
    await assert.rejects(runObsidianSync({ action: 'write', vaultPath: vault, relativePath: 'Memora/escape/file.md', content: 'must not escape', expectedHash: null }), /symlink/);
    await pool.query('create database obsidian_wiki_empty');
    const url = new URL(connection.connectionString);
    url.pathname = '/obsidian_wiki_empty';
    emptyPool = createPgPool({ connectionString: url.toString(), max: 2 });
    assert.equal((await runMigrations(emptyPool, migrations, { seedFolder })).seed.applied, true);
    assert.equal((await emptyPool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, journal.entries.length);
    // A2's conservative wiki-management backfill advances the existing statement-level projection clock once.
    assert.equal((await emptyPool.query('select generation from obsidian_projection_clock')).rows[0].generation, '3');
    await service.shutdown();
    console.log('M4 verified: real PostgreSQL populated upgrade and empty baseline; trigger rollback, bounded queued projection with catalog admission/retry envelopes, strict worker payloads, canonical catalog-only reference, Unicode/collisions/hierarchy, exact evidence, source links, independent local conflicts/recovery, shared fenced format, archive/restore, lost receipt, pause/scope changes, no wiki writeback, symlink containment. No model, real DEV or user vault used.');
}
finally {
    if (emptyPool)
        await closePgPool(emptyPool);
    if (pool)
        await closePgPool(pool);
    await manager.stop();
    await rm(work, { recursive: true, force: true });
}
