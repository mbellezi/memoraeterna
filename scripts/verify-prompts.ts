import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations, createSourceItemRepository, createDocumentRepository, createChunkRepository, createJobRepository, createOrganizationRepository, createPromptRepository, createAiConfigRepository, createSettingsRepository, createIngestionRunRepository, createEmbeddingRepository, createSearchRepository, createLibraryRepository, createAtomicNoteRepository, createHierarchicalIngestionRepository, createSourceSummaryRepository, createKnowledgeGraphRepository, type PgPool } from '../packages/db/src/index.js';
import { PromptOverviewSchema, PromptDetailSchema, PromptPreviewSchema, PromptPinSchema, PromptSampleProgressSchema, promptDefinition, resolveOrganizationInstructions, OrganizationConfigurationSchema } from '@app/domain';
import { OrganizationService } from '../apps/desktop/src/main/services/organization-service.js';
import { PromptService } from '../apps/desktop/src/main/services/prompt-service.js';
import { capturePromptPin, defaultPromptPin, withPromptPin, renderPrompt, promptAudit, promptFingerprint, embeddingPromptIdentity, stagePromptFingerprints, legacyStagePromptFingerprints } from '../apps/desktop/src/main/services/prompt-runtime.js';
const root = resolve(import.meta.dirname, '..'), dir = await mkdtemp(join(tmpdir(), 'memora-prompts-'));
const migrations = join(root, 'packages/db/drizzle'), seedFolder = join(root, 'packages/db/seed'), paths = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({ binDir: paths.binDir, dataDir: join(dir, 'data'), database: 'prompts_test', user: 'prompts_test', password: randomUUID(), startupTimeoutMs: 30000, shutdownTimeoutMs: 10000 });
let pool: PgPool | undefined, empty: PgPool | undefined;
try {
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')), prior = journal.entries.filter((e: {
        idx: number;
    }) => e.idx < 30), old = join(dir, 'old');
    await mkdir(join(old, 'meta'), { recursive: true });
    await writeFile(join(old, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prior }));
    for (const e of prior)
        await copyFile(join(migrations, e.tag + '.sql'), join(old, e.tag + '.sql'));
    await runMigrations(pool, old);
    const source = await createSourceItemRepository(pool).create({ type: 'AcademicPaper', title: 'Synthetic prompt test' }), text = 'Fictional retrieval practice evidence with feedback.';
    const document = await createDocumentRepository(pool).create({ sourceItemId: source.id, title: source.title, canonicalMarkdown: text, contentHash: 'fixture' }), chunkId = randomUUID();
    await createChunkRepository(pool).replaceDocumentChunks(document.id, source.id, [{ id: chunkId, chunkIndex: 0, content: text, contentHash: 'fixture', span: { id: randomUUID(), startOffset: 0, endOffset: text.length } }]);
    const jobs = createJobRepository(pool), legacyJob = await jobs.create({ type: 'ingestion', payload: { sourceItemId: source.id, documentId: document.id } }), org = createOrganizationRepository(pool), removedDomain = randomUUID();
    const first = OrganizationConfigurationSchema.parse({ functionsVersion: 3, global: { guidance: 'Use 50% for {{title}} in {{language}}.' }, pageSynthesis: { advanced: 'First explicit {{title}}.' }, domains: [{ id: removedDomain, name: 'Removed domain', sourceIds: [source.id], pageIds: [], slots: { guidance: 'Old domain' }, pageSynthesis: {} }] });
    const firstId = await org.saveDraft(first);
    await org.activate(firstId, null, []);
    const second = OrganizationConfigurationSchema.parse({ functionsVersion: 3, global: {}, pageSynthesis: {}, domains: [] }), secondId = await org.saveDraft(second);
    await org.activate(secondId, firstId, []);
    const ambiguousId = await org.saveDraft({ ...second, pageSynthesis: { advanced: 'Ambiguous {{unknown}} and 50%' } });
    const oldJobBytes = JSON.stringify(legacyJob.payload), before = JSON.stringify((await pool.query('select id,title,metadata from source_items order by id')).rows);
    await runMigrations(pool, migrations, { seedFolder });
    assert.equal((await pool.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_name like 'prompt_%'")).rows[0].n, 3);
    assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_name='ai_task_runs' and column_name='prompt_compositions' and data_type='jsonb'")).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int n from pg_indexes where tablename like 'prompt_%'")).rows[0].n, 7);
    assert.equal((await pool.query("select count(*)::int n from pg_constraint where conrelid in ('prompt_activations'::regclass,'prompt_validations'::regclass) and contype='f'")).rows[0].n, 2);
    assert.equal((await pool.query("select count(*)::int n from pg_trigger where tgname='jobs_pin_prompt_catalog' and not tgisinternal")).rows[0].n, 1);
    const sampleContexts: Array<Array<{
        domainId: string | null;
        ids: string[];
    }>> = [];
    const service = () => new PromptService({ getPool: () => pool!, sample: async (contexts, options) => {
            // Storage verifier only: deterministic receipts. Actual runtime caller/sample behavior is exercised in Vitest.
            sampleContexts.push(contexts.map(c => ({ domainId: c.pin.domainId, ids: c.ids })));
            const progress = PromptSampleProgressSchema.parse(options.progress);
            progress.requiredKeys = contexts.map(c => promptFingerprint(c.ids, c.pin));
            for (const key of progress.requiredKeys)
                if (!progress.completedKeys.includes(key)) {
                    progress.calls++;
                    progress.completedKeys.push(key);
                    progress.auditIds.push(await createAiConfigRepository(pool!).recordTaskRun({ taskType: 'structured-output', provider: 'fixture', modelId: 'fixture', runtime: 'fixture', durationMs: 1, status: 'succeeded', promptCompositions: [{ compositionHash: key }] }));
                    await options.onProgress(progress);
                }
            return progress;
        } });
    let prompts = service();
    await prompts.initialize();
    const repo = createPromptRepository(pool);
    assert.equal(JSON.stringify((await jobs.findById(legacyJob.id))!.payload), oldJobBytes, 'Migration leaves legacy queued snapshots untouched');
    assert.equal(renderPrompt('organization.guidance', { page_title: 'Title', content_language: 'en' }), resolveOrganizationInstructions(second, null, 'Title', 'en').slots.guidance, 'A later empty configuration clears earlier overrides');
    const legacyHistory = await repo.revisions('organization.advanced');
    assert.ok(legacyHistory.some(r => r.legacy?.revisionId === ambiguousId && r.legacy?.text === 'Ambiguous {{unknown}} and 50%'), 'Ambiguous draft remains recoverable');
    assert.ok((await repo.active()).some(r => r.scope.domainId === removedDomain && r.origin === 'reset'), 'Removed domain receives reset history');
    const revisionCount = (await repo.revisions()).length;
    await prompts.initialize();
    assert.equal((await repo.revisions()).length, revisionCount, 'Migration is idempotent');
    assert.equal(JSON.stringify((await pool.query('select id,title,metadata from source_items order by id')).rows), before, 'Catalog migration changes no library content');
    assert.equal((await pool.query('select count(*)::int n from wiki_pages')).rows[0].n, 0);
    const saved = await prompts.command({ command: 'save', promptId: 'summary.short', scope: { level: 'function', domainId: null }, fields: { body: promptDefinition('summary.short').fields[0]!.template + '\nCUSTOM A1' } }) as string;
    const validated = PromptPreviewSchema.parse(await prompts.command({ command: 'validate', revisionId: saved, sample: false }));
    assert.equal(validated.errors.length, 0);
    await assert.rejects(prompts.command({ command: 'activate', revisionId: saved, expectedActiveId: null }), /prompts.errors.sample/);
    const missing = new PromptService({ getPool: () => pool! });
    await missing.initialize();
    await assert.rejects(missing.command({ command: 'validate', revisionId: saved, sample: true }), /prompts.errors.model/);
    assert.ok((await repo.revisions()).some(r => r.id === saved), 'Missing model preserves the draft');
    const bad = await prompts.command({ command: 'save', promptId: 'notes.extract', scope: { level: 'function', domainId: null }, fields: { body: 'Omit contract %unknown%' } }) as string;
    assert.ok(PromptPreviewSchema.parse(await prompts.command({ command: 'validate', revisionId: bad, sample: false })).errors.length);
    await assert.rejects(prompts.command({ command: 'activate', revisionId: bad, expectedActiveId: null }));
    await prompts.command({ command: 'validate', revisionId: saved, sample: true });
    await prompts.command({ command: 'activate', revisionId: saved, expectedActiveId: null });
    const admitted = await jobs.create({ type: 'ingestion', payload: { sourceItemId: source.id, documentId: document.id } }), pin = PromptPinSchema.parse(admitted.payload.promptPin);
    assert.ok(pin.entries.find(e => e.id === 'summary.short')!.fields.body!.endsWith('CUSTOM A1'));
    const childRun = await createIngestionRunRepository(pool).create({ sourceItemId: source.id, jobId: admitted.id, effectiveStages: ['summarization'] });
    const secondDraft = await prompts.command({ command: 'save', promptId: 'summary.short', scope: { level: 'function', domainId: null }, fields: { body: promptDefinition('summary.short').fields[0]!.template + '\nSECOND A1' } }) as string;
    await prompts.command({ command: 'validate', revisionId: secondDraft, sample: true });
    await prompts.command({ command: 'activate', revisionId: secondDraft, expectedActiveId: saved });
    const stateAfterReplacement = PromptOverviewSchema.parse(await prompts.command({ command: 'list' })).states.find(s => s.id === 'summary.short');
    assert.equal(stateAfterReplacement?.draft, false, 'Previously activated history is not a saved draft');
    const child = await jobs.create({ type: 'atomic-note-generation', payload: { ingestionRunId: childRun.id } });
    assert.deepEqual(child.payload.promptPin, admitted.payload.promptPin, 'Pipeline child inherits the first admission');
    assert.ok(withPromptPin(pin, () => renderPrompt('summary.short', { chunks: 'Synthetic' })).endsWith('CUSTOM A1'), 'Old admitted templates survive activation');
    prompts = service();
    await prompts.initialize();
    assert.ok(renderPrompt('summary.short', { chunks: 'Synthetic' }).endsWith('SECOND A1'), 'Active revision survives restart');
    const revisionWithSample = (await repo.revisions()).find(r => r.id === secondDraft)!;
    await prompts.command({ command: 'validate', revisionId: secondDraft, sample: false });
    assert.equal((await repo.revisions()).find(r => r.id === secondDraft)!.samplePassed, true);
    assert.equal(revisionWithSample.samplePassed, true);
    const domain = randomUUID();
    await org.saveDomains([{ id: domain, name: 'Science', sourceIds: [source.id], pageIds: [] }]);
    assert.ok(PromptOverviewSchema.parse(await prompts.command({ command: 'list' })).domains.some(d => d.id === domain && d.name === 'Science'), 'Domains without overrides remain editable');
    const domainDraft = await prompts.command({ command: 'save', promptId: 'organization.advanced', scope: { level: 'domain_function', domainId: domain }, fields: { body: 'Review %page_title% in %content_language% with scientific caution.' } }) as string;
    await prompts.command({ command: 'validate', revisionId: domainDraft, sample: true });
    await prompts.command({ command: 'activate', revisionId: domainDraft, expectedActiveId: null });
    const shared = await prompts.command({ command: 'save', promptId: 'shared.output_language', scope: { level: 'function', domainId: null }, fields: { body: promptDefinition('shared.output_language').fields[0]!.template + ' Keep qualifications.' } }) as string;
    await prompts.command({ command: 'validate', revisionId: shared, sample: true });
    assert.ok(sampleContexts.at(-1)!.some(c => c.domainId === domain) && sampleContexts.at(-1)!.some(c => c.domainId === null), 'Shared validation covers distinct domains');
    const stale = await prompts.command({ command: 'save', promptId: 'summary.short', scope: { level: 'function', domainId: null }, fields: { body: promptDefinition('summary.short').fields[0]!.template + ' STALE' } }) as string;
    await prompts.command({ command: 'validate', revisionId: stale, sample: true });
    await prompts.command({ command: 'activate', revisionId: shared, expectedActiveId: null });
    await assert.rejects(prompts.command({ command: 'activate', revisionId: stale, expectedActiveId: secondDraft }), /prompts.errors.sample/, 'Atomic activation rechecks changed shared composition');
    const reset = await prompts.command({ command: 'reset', promptId: 'summary.short', scope: { level: 'function', domainId: null }, expectedActiveId: secondDraft }) as string;
    await prompts.command({ command: 'validate', revisionId: reset, sample: true });
    await prompts.command({ command: 'activate', revisionId: reset, expectedActiveId: secondDraft });
    assert.equal(renderPrompt('summary.short', { chunks: 'Synthetic' }), withPromptPin(defaultPromptPin(), () => renderPrompt('summary.short', { chunks: 'Synthetic' })));
    const restored = await prompts.command({ command: 'restore', revisionId: saved }) as string;
    assert.notEqual(restored, saved);
    assert.ok((await repo.revisions()).some(r => r.id === saved));
    assert.equal(embeddingPromptIdentity(), null, 'Generative-only edits preserve the A0 embedding format');
    const embeddingDraft = await prompts.command({ command: 'save', promptId: 'embedding.query_instruction', scope: { level: 'function', domainId: null }, fields: { body: 'Instruct: Retrieve exact evidence.\nQuery: %query%' } }) as string;
    await prompts.command({ command: 'validate', revisionId: embeddingDraft, sample: false });
    await prompts.command({ command: 'activate', revisionId: embeddingDraft, expectedActiveId: null });
    assert.ok(embeddingPromptIdentity());
    // No vector rows are regenerated, re-keyed or removed by a prompt activation.
    const vector = Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0), embeddings = createEmbeddingRepository(pool), common = { provider: 'fixture', model: 'fixture', runtime: 'fixture', contentHash: 'fixture', embedding: vector };
    const noteId = (await pool.query("insert into atomic_notes(title,body_markdown,idea_statement,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values('Fixture note',$1,'Fictional retrieval',$2,$3,'fixture','fixture','fixture','legacy','fixture') returning id", [text, source.id, chunkId])).rows[0].id;
    await embeddings.upsert({ ...common, targetType: 'chunk', targetId: chunkId, chunkId, strategy: 'native-v2:old-space' });
    await embeddings.upsert({ ...common, targetType: 'atomic_note', targetId: noteId, strategy: 'native-v2:old-space' });
    await embeddings.upsert({ ...common, targetType: 'source_item', targetId: source.id, strategy: 'source-composite-centroid-v2:old-space' });
    const search = createSearchRepository(pool), identity = { embedding: vector, embeddingModel: 'fixture', embeddingSpaceKey: 'new-space', embeddingProvider: 'fixture', embeddingRuntime: 'fixture' };
    assert.equal((await search.searchVector(identity)).length, 0);
    assert.equal((await search.searchNotesVector(identity)).length, 0);
    assert.ok((await search.searchText({ text: 'retrieval' })).length);
    const library = await createLibraryRepository(pool).listSources({ query: 'Synthetic', queryEmbedding: vector, embeddingModel: 'fixture', embeddingSpaceKey: 'new-space', embeddingProvider: 'fixture', embeddingRuntime: 'fixture' });
    assert.equal(library[0]?.embeddingNeedsRefresh, true);
    assert.equal((await createAtomicNoteRepository(pool).findVectorMatchingCandidates({ ...identity, noteId: randomUUID() })).length, 0);
    await embeddings.upsert({ ...common, targetType: 'chunk', targetId: chunkId, chunkId, strategy: 'native-v2:new-space' });
    assert.equal((await search.searchVector(identity)).length, 1);
    assert.equal((await search.searchVector({ ...identity, embeddingProvider: 'different' })).length, 0);
    // A failed new generation cannot bless the current older summary; unrelated run updates cannot reorder actual stage completion.
    const hierarchy = createHierarchicalIngestionRepository(pool), docRevision = await hierarchy.ensureCurrentDocumentRevision(document.id, 'fixture'), oldGen = await hierarchy.createKnowledgeGeneration({ sourceItemId: source.id, documentRevisionId: docRevision, stage: 'summarization', metadata: { promptFingerprint: 'old-fingerprint' } });
    await createSourceSummaryRepository(pool).create({ sourceItemId: source.id, generationId: oldGen, summary: 'Old valid summary', provider: 'fixture', model: 'fixture', runtime: 'fixture', promptVersion: 'legacy', inputHash: 'fixture', outputHash: 'fixture' });
    await hierarchy.createKnowledgeGeneration({ sourceItemId: source.id, documentRevisionId: docRevision, stage: 'summarization', metadata: { promptFingerprint: 'new-fingerprint' } });
    const state = await hierarchy.getArtifactState(source.id, document.id, { current: { summarization: 'new-fingerprint' }, shipped: { summarization: 'old-fingerprint' } });
    assert.equal(state.summarization, false, 'Only the current summary owner proves compatibility');
    assert.equal((await hierarchy.getArtifactState(source.id, document.id, { current: { summarization: 'old-fingerprint' }, shipped: { summarization: 'old-fingerprint' } })).summarization, true);
    // Zero-output ownership orders the completed stage itself, not a later unrelated update of its run.
    await createSourceSummaryRepository(pool).clearCurrent(source.id);
    const runRepo = createIngestionRunRepository(pool);
    const olderZero = await runRepo.create({ sourceItemId: source.id, inputDocumentRevisionId: docRevision, inputHashes: { contentHash: 'fixture', promptFingerprints: { summarization: 'zero-old' } }, effectiveStages: ['summarization'], stagesCheckpoint: { summarization: { status: 'completed', completedAt: '2026-01-01T00:00:00.000Z', metadata: { configured: true, generated: false, skippedReason: 'non_content' } } } });
    await runRepo.create({ sourceItemId: source.id, inputDocumentRevisionId: docRevision, inputHashes: { contentHash: 'fixture', promptFingerprints: { summarization: 'zero-new' } }, effectiveStages: ['summarization'], stagesCheckpoint: { summarization: { status: 'completed', completedAt: '2026-02-01T00:00:00.000Z', metadata: { configured: true, generated: false, skippedReason: 'non_content' } } } });
    await pool.query("update ingestion_runs set updated_at='2030-01-01' where id=$1", [olderZero.id]);
    assert.equal((await hierarchy.getArtifactState(source.id, document.id, { current: { summarization: 'zero-new' }, shipped: { summarization: 'legacy' } })).summarization, true, 'Unrelated run updates do not supersede newer completed-stage receipts');
    // A partial note write cannot borrow an older complete generation; an orphan attempt cannot invalidate untouched old notes.
    const oldNoteGen = await hierarchy.createKnowledgeGeneration({ sourceItemId: source.id, documentRevisionId: docRevision, stage: 'atomicNotes', metadata: { promptFingerprint: 'notes-old', promptComplete: true } });
    await pool.query('update atomic_notes set generation_id=$2 where id=$1', [noteId, oldNoteGen]);
    const failedNoteGen = await hierarchy.createKnowledgeGeneration({ sourceItemId: source.id, documentRevisionId: docRevision, stage: 'atomicNotes', metadata: { promptFingerprint: 'notes-new', promptComplete: false } });
    assert.equal((await hierarchy.getArtifactState(source.id, document.id, { current: { atomicNotes: 'notes-old' }, shipped: { atomicNotes: 'legacy' } })).atomicNotes, true, 'No-write attempts do not invalidate owned old notes');
    await pool.query('update atomic_notes set generation_id=$2 where id=$1', [noteId, failedNoteGen]);
    for (const fingerprint of ['notes-old', 'notes-new'])
        assert.equal((await hierarchy.getArtifactState(source.id, document.id, { current: { atomicNotes: fingerprint }, shipped: { atomicNotes: 'legacy' } })).atomicNotes, false, 'Partial note replacement is not a complete artifact');
    // Canonical graph replacement and its generation receipt share one SQL transaction, including empty output.
    const graph = createKnowledgeGraphRepository(pool), graphMetadata = { graphModes: ['source_chunks'], promptFingerprint: 'graph-old' };
    await graph.replaceSourceExtraction({ sourceItemId: source.id, language: 'en', batches: [], generation: {}, generationReceipt: { documentRevisionId: docRevision, metadata: graphMetadata } });
    const claim = (await pool.query("insert into claims(source_item_id,evidence_chunk_id,text,content_hash,confidence) values($1,$2,'Retained original claim','old-claim',0.9) returning id", [source.id, chunkId])).rows[0].id;
    await assert.rejects(graph.replaceSourceExtraction({ sourceItemId: source.id, language: 'en', batches: [], generation: {}, generationReceipt: { documentRevisionId: randomUUID(), metadata: { ...graphMetadata, promptFingerprint: 'graph-new' } } }));
    assert.equal((await pool.query('select count(*)::int n from claims where id=$1', [claim])).rows[0].n, 1, 'Receipt failure rolls back canonical graph replacement');
    assert.equal((await hierarchy.getArtifactState(source.id, document.id, { current: { knowledgeGraph: 'graph-old' }, shipped: { knowledgeGraph: 'legacy' } })).knowledgeGraph, true);
    await graph.replaceSourceExtraction({ sourceItemId: source.id, language: 'en', batches: [], generation: {}, generationReceipt: { documentRevisionId: docRevision, metadata: { ...graphMetadata, promptFingerprint: 'graph-new' } } });
    assert.equal((await pool.query('select count(*)::int n from claims where id=$1', [claim])).rows[0].n, 0);
    assert.equal((await hierarchy.getArtifactState(source.id, document.id, { current: { knowledgeGraph: 'graph-new' }, shipped: { knowledgeGraph: 'legacy' } })).knowledgeGraph, true, 'Zero-output graph receipt belongs to the committed replacement');
    const audit = withPromptPin(pin, () => { const input = renderPrompt('summary.short', { chunks: 'Synthetic' }); return promptAudit(input); });
    const auditId = await createAiConfigRepository(pool).recordTaskRun({ taskType: 'summarization', provider: 'fixture', modelId: 'fixture', runtime: 'fixture', durationMs: 1, status: 'canceled', promptCompositions: audit });
    assert.deepEqual((await pool.query('select prompt_compositions from ai_task_runs where id=$1', [auditId])).rows[0].prompt_compositions, audit);
    await pool.query('create database prompts_empty');
    const url = new URL(connection.connectionString);
    url.pathname = '/prompts_empty';
    empty = createPgPool({ connectionString: url.toString(), max: 2 });
    assert.equal((await runMigrations(empty, migrations, { seedFolder })).seed.applied, true);
    const blank = new PromptService({ getPool: () => empty! });
    await blank.initialize();
    assert.equal((await empty.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0].n, journal.entries.length);
    assert.equal(PromptOverviewSchema.parse(await blank.command({ command: 'list' })).definitions.length, PromptOverviewSchema.parse(await prompts.command({ command: 'list' })).definitions.length);
    assert.equal((await empty.query('select count(*)::int n from source_items')).rows[0].n, 0);
    // Separate seeded database checks an explicit rollback pointer without changing the tested user-style upgrade.
    await empty.query('create database prompts_rollback');
    const rollbackUrl = new URL(connection.connectionString);
    rollbackUrl.pathname = '/prompts_rollback';
    const rollback = createPgPool({ connectionString: rollbackUrl.toString(), max: 2 });
    try {
        await runMigrations(rollback, migrations, { seedFolder });
        const orgRollback = createOrganizationRepository(rollback), oldConfiguration = OrganizationConfigurationSchema.parse({ functionsVersion: 3, global: { guidance: 'Original 50% {{title}}' }, pageSynthesis: {}, domains: [] });
        const older = await orgRollback.saveDraft({ ...oldConfiguration, pageSynthesis: { advanced: 'Older explicit guidance A' } });
        await orgRollback.activate(older, null, []);
        oldConfiguration.pageSynthesis.advanced = 'Keep {{unknown}} literal for {{title}} with 50% scope.';
        const original = await orgRollback.saveDraft(oldConfiguration);
        await orgRollback.activate(original, older, []);
        const newer = await orgRollback.saveDraft({ ...oldConfiguration, global: { guidance: 'Newer guidance' } });
        await orgRollback.activate(newer, original, []);
        await createSettingsRepository(rollback).set('organization.active', { revisionId: original });
        const migrated = new PromptService({ getPool: () => rollback });
        await migrated.initialize();await new OrganizationService({getPool:()=>rollback,ai:{} as never,contentLanguage:async()=>'en',wake:()=>{},cancelJob:async()=>null}).settings();
        assert.equal(renderPrompt('organization.guidance', { page_title: 'Recall', content_language: 'en' }), 'Original 50% Recall', 'Explicit active rollback pointer wins over newer activation history');
        assert.equal(renderPrompt('organization.advanced', { page_title: 'Recall', content_language: 'en' }), 'Keep {{unknown}} literal for Recall with 50% scope.', 'Active ambiguous prose retains the versioned literal-compatible behavior instead of resurrecting an older override');
    }
    finally {
        await closePgPool(rollback);
    }
    console.log('Prompt catalog verified on disposable real PostgreSQL: populated upgrade and empty baseline; tables, indexes, FKs, JSON audit column and admission trigger; legacy resets/removed domains/ambiguous drafts/history/idempotency; persisted job and child pins; draft/sample/activation/CAS/restart/reset/restore; all-domain shared validation; unchanged library/no automatic vector work; strict chunk/note/library vector spaces and text fallback; current-artifact generation ownership. All sample receipts use deterministic fixtures; no real inference or user database/vault was used.');
}
finally {
    if (empty)
        await closePgPool(empty);
    if (pool)
        await closePgPool(pool);
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
}
