import {defaultPromptPin,promptFingerprint} from '../apps/desktop/src/main/services/prompt-runtime.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createWikiRepository, createWikiCuratorRepository, createOrganizationRepository, createAiConfigRepository,
  createSourceItemRepository, createDocumentRepository, createChunkRepository, createKnowledgeAutomationRepository, curatorHash, type PgPool
} from '../packages/db/src/index.js';
import {
  HierarchyPolicySchema, HierarchySnapshotSchema, HierarchyChangeSetSchema, HierarchyCuratorCheckpointSchema,
  HierarchyPageTargetSchema, HierarchyRouteContinuationSchema, WikiPageSchema, WikiPageContentSchema,
  hierarchyChangedHandles, initialHierarchyLimits, promptDefinition, wikiAreaIds, type HierarchySnapshot, type HierarchyChangeSet,
  type HierarchyParent, type HierarchyPolicy
} from '@app/domain';

const root = resolve(import.meta.dirname, '..'), dir = await mkdtemp(join(tmpdir(), 'memora-wiki-hierarchy-'));
const paths = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({ binDir: paths.binDir, dataDir: join(dir, 'data'), database: 'hierarchy_test', user: 'hierarchy_test', password: randomUUID() });
let pool: PgPool | undefined;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
  const db = pool;
  const migrations = await runMigrations(db, join(root, 'packages/db/drizzle'), { seedFolder: join(root, 'packages/db/seed') });
  assert.equal(migrations.seed.applied, true, 'Fresh baseline only; never touch the user database');
  const repo = createWikiCuratorRepository(db), hierarchy = repo.hierarchy, wiki = createWikiRepository(db), runs = createOrganizationRepository(db);
  const areaTitles={themes:'Themes',entities:'Entities',syntheses:'Syntheses',investigations:'Investigations',maps:'Maps',people:'People',organizations:'Organizations',places:'Places',works:'Works'};
  await createKnowledgeAutomationRepository(db).initializeAreas(areaTitles);
  assert.equal((await wiki.list()).length,Object.keys(wikiAreaIds).length);
  const source = await createSourceItemRepository(db).create({ type: 'PersonalNote', title: 'Synthetic genetics notebook' });
  const outside = await createSourceItemRepository(db).create({ type: 'PersonalNote', title: 'Excluded notebook' });
  async function original(sourceId: string, text: string) {
    const document = await createDocumentRepository(db).create({ sourceItemId: sourceId, title: 'Original', canonicalMarkdown: text, contentHash: text });
    const id = randomUUID(), span = randomUUID();
    await createChunkRepository(db).replaceDocumentChunks(document.id, sourceId, [{ id, sourceSpanId: span, chunkIndex: 0, content: text, contentHash: text, span: { id: span, startOffset: 0, endOffset: text.length } }]);
    return id;
  }
  const chunk = await original(source.id, 'Gene regulation belongs to molecular genetics within genetics, biology and science. Multiple original observations support the reading categories.');
  const excludedChunk = await original(outside.id, 'Private excluded findings.');
  const profile = { profileId: randomUUID(), providerConfigId: null, localModelId: null, provider: 'synthetic', modelId: 'fixture', runtime: 'test', revision: '1', privacy: 'offline_only', parameters: {}, identityHash: 'fixture', contextWindow: 65536 };
  const promptId = 'organization.curator.support';
  const promptPin=defaultPromptPin();
  const promptIds=new Set<string>();const collect=(id:string)=>{if(promptIds.has(id))return;promptIds.add(id);promptDefinition(id).fragmentIds.forEach(collect);};collect(promptId);
  const revisions=[...promptIds].flatMap(id=>promptPin.entries.find(p=>p.id===id)!.revisions);
  const supportCompositionHash=promptFingerprint([promptId],promptPin,false);
  const resources = { maxInventoryBytes: 1_000_000, maxProposalBytes: 1_000_000 };
  async function policy(targets = 3) {
    const policy = HierarchyPolicySchema.parse({ version: 'automatic-wiki-v1', id: randomUUID(), revisionId: randomUUID(), state: 'enabled', scope: { wholeLibrary: false, sourceIds: [source.id], includeDescendants: false, excludedSourceIds: [outside.id], domainId: null }, triggers: ['input_changed'], operations: ['create_grounded', 'initial_placement', 'update_unprotected', 'repair_navigation', 'reviewed_reparent', 'use_scoped_destinations'], profileOverrideId: null, limits: { ...initialHierarchyLimits, targets, deadlineMs: 600000 }, allowancePreset: null });
    await db.query("insert into wiki_policy_revisions(id,policy_id,policy,preview,preview_hash) values($1,$2,$3,'{}','fixture')", [policy.revisionId, policy.id, policy]);
    await db.query("insert into wiki_policy_activations(policy_id,revision_id,state) values($1,$2,'enabled')", [policy.id, policy.revisionId]);
    return policy;
  }
  const mainPolicy = await policy();
  const topic = (handle: string, title = handle) => HierarchyPageTargetSchema.parse({ handle, title, purpose: 'Place current genetics findings', pageId: null, expectedRevisionId: null, initialParent: null, role: { kind: 'topic', role: 'topic' }, sections: [{ sectionId: null, expectedSectionRevisionId: null, title: 'Finding', markdown: 'Original genetics observation [e1]', originalHandles: ['e1'] }], tocGroups: [], links: [] });
  const proposed = (handle: string): HierarchyParent => ({ reference: 'proposed', handle });
  const parentRef = (snapshot: HierarchySnapshot, id: string): HierarchyParent => { const p = snapshot.placement.pages.find(p => p.pageId === id)!; return { reference: 'existing', target: { kind: 'page', id }, fingerprint: p.fingerprint, expectedRevisionId: p.revisionId }; };
  const checkpoint = () => HierarchyCuratorCheckpointSchema.parse({ version: 'wiki-curator-v2', calls: 0, tools: 0, repairs: 0, startedAt: new Date().toISOString(), callPending: false, waitingForModel: false, proposal: null, previousOutput: '', error: null, reportedInputTokens: 0, reportedOutputTokens: 0, costEstimate: 0, usageCounts: { input: 0, output: 0, cost: 0 }, usageIncomplete: true, hierarchy: null });
  async function snapshot(policy = mainPolicy, pageIds: string[] = [], editablePageIds: string[] = [], noteIds:string[] = []) {
    const evidence = (await repo.evidencePage([source.id], null, 12)).items;
    const references = await repo.references([source.id], noteIds, [chunk]);
    const pages = await Promise.all(editablePageIds.map(async id => WikiPageSchema.parse(await wiki.get(id))));
    const placement = await hierarchy.inventory(policy, { pageIds, editablePageIds, limit: 300, maxBytes: resources.maxInventoryBytes });
    for (const page of pages) references.push({ kind: 'page', id: page.id, title: page.title, text: '', fingerprint: page.revisionId, sourceIds: placement.pages.find(p => p.pageId === page.id)!.sourceIds, chunkIds: page.evidence.map(e => e.chunkId) });
    return HierarchySnapshotSchema.parse({ version: 'wiki-curator-v2', policy, sourceIds: [source.id], profile, promptPin, supportCompositionHash, contentLanguage: 'en', evidence, references, pages, placement, resources, inputFingerprint: randomUUID(), groupId: randomUUID(), outputTokens: 4096, limits: policy.limits, admittedAt: new Date().toISOString() });
  }
  function change(s: HierarchySnapshot, patch: Partial<HierarchyChangeSet> = {}) { return HierarchyChangeSetSchema.parse({ version: 'automatic-wiki-v1', groupId: s.groupId, policyRevisionId: s.policy.revisionId, explanation: 'Organize supported findings', targets: [topic('new_leaf')], ancestors: [], moves: [], ...patch }); }
  async function pending(s: HierarchySnapshot, proposal: HierarchyChangeSet, certify = true) {
    const id = await runs.create(s, checkpoint());
    if (!certify) return id;
    const verdict = { supported: true, checkedTargets: hierarchyChangedHandles(proposal), issues: [] };
    const aiTaskRunId = await createAiConfigRepository(db).recordTaskRun({ organizationRunId: id, organizationStep: 1, taskType: 'structured-output', provider: 'synthetic', modelId: 'fixture', runtime: 'test', durationMs: 1, status: 'succeeded', promptCompositions: [{ version: 'prompt-catalog-v1', promptId, revisions, compositionHash: supportCompositionHash, templateLanguage: 'en', origin: 'default', outputContractVersion: 'fixture', embeddingStrategyIdentity: null }] });
    const cp = { ...checkpoint(), calls: 1, proposal, supportAssessment: { proposalHash: curatorHash(proposal), aiTaskRunId, verdict } };
    await runs.step(id, 1, cp, { proposalHash: curatorHash(proposal), support: verdict }, aiTaskRunId);
    await runs.propose(id, proposal, cp, false);
    return id;
  }
  const apply = (id: string, human = false) => hierarchy.apply(id, human, () => {}, async () => {});
  const countPages = async () => (await db.query('select count(*)::int n from wiki_pages')).rows[0].n as number;
  // Deep path + two counted work targets in one canonical transaction/receipt.
  const emptyAreas=await hierarchy.inventory(mainPolicy,{pageIds:[wikiAreaIds.themes,wikiAreaIds.organizations],editablePageIds:Object.values(wikiAreaIds)});
  assert.deepEqual(new Set(emptyAreas.pages.map(p=>p.pageId)),new Set([wikiAreaIds.themes,wikiAreaIds.entities,wikiAreaIds.organizations]));
  assert.ok(emptyAreas.pages.every(p=>p.canReceiveChildren&&!p.canEdit&&p.sourceIds.length===0));
  const arbitrary=await wiki.save({expectedRevisionId:null,content:WikiPageContentSchema.parse({title:'Unbound human container',kind:'collection'}),evidenceChunkIds:[]});
  assert.ok(!(await hierarchy.inventory(mainPolicy,{pageIds:[arbitrary],editablePageIds:[arbitrary]})).pages.some(p=>p.pageId===arbitrary));
  const first = await snapshot(mainPolicy,[wikiAreaIds.themes]);
  const ancestors = ['Science', 'Biology', 'Genetics', 'Molecular genetics'].map((title, i) => ({ handle: `new_path_${i}`, title, purpose: 'Required path for current findings', role: { kind: 'topic' as const, role: 'topic' as const }, initialParent: i ? proposed(`new_path_${i - 1}`) : parentRef(first,wikiAreaIds.themes) }));
  const leaf = { ...topic('new_leaf', 'Gene regulation'), initialParent: proposed('new_path_3') };
  const toc = { ...topic('new_toc', 'Gene regulation reading'), initialParent: proposed('new_leaf'), role: { kind: 'collection' as const, role: 'topic_toc' as const, owner: proposed('new_leaf') }, sections: [], tocGroups: [{ handle: 'new_reading', id: null, expectedRevisionId: null, title: 'Original source', explanation: null, originalHandles: [], memberships: [{ id: null, target: { reference: 'existing' as const, target: { kind: 'source' as const, id: source.id }, fingerprint: first.references.find(r => r.kind === 'source')!.fingerprint }, purpose: 'source' as const, order: 0 }] }] };
  const proposal = change(first, { targets: [leaf, toc], ancestors });
  const firstRun = await pending(first, proposal), before = await countPages();
  const receipt = await apply(firstRun);
  assert.equal(receipt.length, 6); assert.equal(await countPages(), before + 6);
  assert.deepEqual(await apply(firstRun), receipt, 'Lost acknowledgment reuses committed receipt');
  const all = await wiki.list(), leafPage = all.find(p => p.title === 'Gene regulation')!;
  const science = all.find(p => p.title === 'Science')!, molecular = all.find(p => p.title === 'Molecular genetics')!;
  for (const title of ancestors.map(a => a.title)) assert.equal((await wiki.get(all.find(p => p.title === title)!.id))!.sections.length, 0);
  const inventory = await hierarchy.inventory(mainPolicy, { pageIds: [leafPage.id], editablePageIds: [leafPage.id] });
  assert.equal(inventory.pages.length, 6); assert.equal(inventory.pages.find(p => p.pageId === science.id)!.descendantCount, 5);
  assert.ok(inventory.pages.find(p => p.pageId === molecular.id)!.canReceiveChildren); assert.equal(inventory.pages.find(p => p.pageId === molecular.id)!.canEdit, false);
  assert.ok(!JSON.stringify(inventory).includes('Original genetics observation'));
  let cursor: string | null = null; const seen: string[] = [];
  do { const part = await hierarchy.inventory(mainPolicy, { pageIds: [leafPage.id], limit: 2, after: cursor }); seen.push(...part.pages.map(p => p.pageId)); cursor = part.nextCursor; } while (cursor);
  assert.equal(new Set(seen).size, 6, 'Bounded cursor reaches complete ancestry');
  // Actual initialized entity destinations accept the first canonical entity path.
  const placedEntity=randomUUID();
  await db.query("insert into entities(id,canonical_name,type,normalized_name,confidence) values($1,'Genetics institute','organization','genetics institute',1)",[placedEntity]);
  await db.query("insert into entity_mentions(entity_id,source_item_id,chunk_id,surface_text,confidence) values($1,$2,$3,'Genetics institute',1)",[placedEntity,source.id,chunk]);
  const entitySnapshot=await snapshot(mainPolicy,[wikiAreaIds.organizations]);
  assert.equal(entitySnapshot.placement.pages.find(p=>p.pageId===wikiAreaIds.organizations)!.parentId,wikiAreaIds.entities);
  const entityProposal=change(entitySnapshot,{ancestors:[{handle:'new_institutes',title:'Institutes',purpose:'Required canonical organization category',role:{kind:'collection',role:'map',owner:null},initialParent:parentRef(entitySnapshot,wikiAreaIds.organizations)}],targets:[{...topic('new_canonical_org','Genetics institute'),role:{kind:'entity',role:'entity',entityId:placedEntity},initialParent:proposed('new_institutes')}]});
  const entityReceipt=await apply(await pending(entitySnapshot,entityProposal));
  assert.equal(entityReceipt.length,2);
  const canonicalEntity=WikiPageSchema.parse(await wiki.get((await hierarchy.canonicalEntityPage(placedEntity))!));
  const institutes=WikiPageSchema.parse(await wiki.get(canonicalEntity.parentId!));
  assert.equal(institutes.parentId,wikiAreaIds.organizations);
  const initialized=(await wiki.list()).filter(p=>Object.values(wikiAreaIds).some(id=>id===p.id));
  assert.equal(initialized.length,9);assert.equal(initialized.filter(p=>p.title==='Entities').length,1);assert.equal(initialized.filter(p=>p.title==='Themes').length,1);
  const areaMoveSnapshot=await snapshot(mainPolicy,[wikiAreaIds.themes,wikiAreaIds.entities],[wikiAreaIds.entities]);
  const areaPage=areaMoveSnapshot.pages[0]!;
  const areaMove=change(areaMoveSnapshot,{targets:[],moves:[{handle:'new_forbidden_area_move',operation:'reviewed_reparent',pageId:areaPage.id,expectedRevisionId:areaPage.revisionId,fromParent:null,toParent:parentRef(areaMoveSnapshot,wikiAreaIds.themes),reason:'Destination access must not grant move access'}]});
  await assert.rejects(apply(await pending(areaMoveSnapshot,areaMove),true),/scope/);
  assert.equal((await wiki.get(wikiAreaIds.entities))!.revisionId,areaPage.revisionId);
  // Six ordinary targets fit a six-target policy and share existing ancestry.
  const sixPolicy = await policy(6), six = await snapshot(sixPolicy, [molecular.id]);
  const sixProposal = change(six, { targets: Array.from({ length: 6 }, (_, i) => ({ ...topic(`new_six_${i}`), initialParent: parentRef(six, molecular.id) })) });
  assert.equal((await apply(await pending(six, sixProposal))).length, 6);
  const capped = await snapshot(mainPolicy), over = change(capped, { targets: Array.from({ length: 4 }, (_, i) => topic(`new_over_${i}`)) });
  await assert.rejects(apply(await pending(capped, over)), /scopeLimit/);
  // A failed target rolls back already allocated ancestors and every target.
  const invalid = await snapshot(), broken = change(invalid, { targets: [{ ...topic('new_invalid'), sections: [{ ...topic('new_template').sections[0]!, originalHandles: ['e2'] }] }] });
  const n = await countPages(); await assert.rejects(apply(await pending(invalid, broken)), /evidence/); assert.equal(await countPages(), n);
  // Canonical support must cover ancestors exactly, use the exact proposal and admitted pin.
  const noSupport = await snapshot(), noSupportProposal = change(noSupport), noSupportRun = await pending(noSupport, noSupportProposal);
  await db.query("update organization_runs set checkpoint=jsonb_set(checkpoint,'{supportAssessment,verdict,checkedTargets}','[]') where id=$1", [noSupportRun]);
  await assert.rejects(apply(noSupportRun), /evidence|ZodError/);
  const changedSupport = await snapshot(), changedRun = await pending(changedSupport, change(changedSupport));
  await db.query("update organization_proposals set proposal=jsonb_set(proposal,'{explanation}','\"different\"') where run_id=$1", [changedRun]);
  await assert.rejects(apply(changedRun), /evidence/);
  const wrongComposition=await snapshot(),wrongCompositionRun=await pending(wrongComposition,change(wrongComposition));
  await db.query("update ai_task_runs set prompt_compositions=jsonb_set(prompt_compositions,'{0,compositionHash}',to_jsonb($2::text)) where id in(select ai_task_run_id from organization_steps where run_id=$1)",[wrongCompositionRun,'b'.repeat(64)]);
  await assert.rejects(apply(wrongCompositionRun),/evidence/);
  // Reviewed placement preserves exact prose revisions, support and protected memberships.
  const loaded = WikiPageSchema.parse(await wiki.get(leafPage.id));
  await wiki.save({ version: 2, id: loaded.id, expectedRevisionId: loaded.revisionId, content: { ...WikiPageContentSchema.strip().parse(loaded), sections: loaded.sections.map(s => ({ ...s, protected: true })) }, evidenceChunkIds: [] });
  const moving = await snapshot(mainPolicy, [leafPage.id, science.id], [leafPage.id]);
  const from = moving.pages[0]!, beforeSections = structuredClone(from.sections), beforeEvidence = structuredClone(from.evidence);
  const move = { handle: 'new_move', operation: 'reviewed_reparent' as const, pageId: from.id, expectedRevisionId: from.revisionId, fromParent: parentRef(moving, from.parentId!) as Extract<HierarchyParent, { reference: 'existing' }>, toParent: parentRef(moving, science.id), reason: 'Reviewed broader category' };
  const moveRun = await pending(moving, change(moving, { targets: [], moves: [move] }));
  await assert.rejects(apply(moveRun), /review/); await apply(moveRun, true);
  const moved = WikiPageSchema.parse(await wiki.get(from.id));
  assert.equal(moved.parentId, science.id); assert.deepEqual(moved.sections, beforeSections); assert.deepEqual(moved.evidence, beforeEvidence);
  assert.deepEqual(await apply(moveRun, true), await apply(moveRun, true));
  // Current destination metadata and source parent are exact, not a title-based guess.
  const stale = await snapshot(mainPolicy, [science.id]), staleProposal = change(stale, { targets: [{ ...topic('new_stale'), initialParent: parentRef(stale, science.id) }] }), staleRun = await pending(stale, staleProposal);
  const currentScience = WikiPageSchema.parse(await wiki.get(science.id));
  await wiki.save({ version: 2, id: science.id, expectedRevisionId: currentScience.revisionId, content: { ...WikiPageContentSchema.strip().parse(currentScience), pinned: true }, evidenceChunkIds: [] });
  await assert.rejects(apply(staleRun), /conflict/);
  const cyclic = await snapshot(mainPolicy, [science.id, molecular.id], [science.id]);
  const sciencePage = cyclic.pages[0]!;
  await assert.rejects(apply(await pending(cyclic, change(cyclic, { targets: [], moves: [{ handle: 'new_cycle', operation: 'reviewed_reparent', pageId: science.id, expectedRevisionId: sciencePage.revisionId, fromParent: parentRef(cyclic,wikiAreaIds.themes) as Extract<HierarchyParent,{reference:'existing'}>, toParent: parentRef(cyclic, molecular.id), reason: 'Invalid descendant destination' }] })), true), /scope/);
  const mixed = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Mixed excluded lineage', kind: 'topic', sections: [{ id: randomUUID(), title: 'Both', markdown: 'mixed', evidenceIds: [chunk, excludedChunk] }] }), evidenceChunkIds: [chunk, excludedChunk] });
  assert.equal((await hierarchy.inventory(mainPolicy, { pageIds: [mixed], editablePageIds: [mixed] })).pages.length, 0);
  // Canonical save itself rejects duplicate entity identity, but homonyms remain distinct.
  const entityA = randomUUID(), entityB = randomUUID();
  for (const id of [entityA, entityB]) await db.query("insert into entities(id,canonical_name,type,normalized_name,confidence) values($1,'Shared name','organization','shared name',1)", [id]);
  const entityPage = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Shared name', kind: 'entity', entityId: entityA }), evidenceChunkIds: [] });
  assert.equal(await hierarchy.canonicalEntityPage(entityA), entityPage);
  await assert.rejects(wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Other name', kind: 'entity', entityId: entityA }), evidenceChunkIds: [] }), /conflict/);
  await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Shared name', kind: 'entity', entityId: entityB }), evidenceChunkIds: [] });
  const archived = await wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Archived', kind: 'topic', archived: true }), evidenceChunkIds: [] });
  await assert.rejects(wiki.save({ expectedRevisionId: null, content: WikiPageContentSchema.parse({ title: 'Invalid child', kind: 'topic', parentId: archived }), evidenceChunkIds: [] }), /cycle/);
  // Composed nested TOC descent includes current and same-group links.
  const nested = await snapshot();
  const mapTarget = (handle: string) => ({ ...topic(handle), role: { kind: 'collection' as const, role: 'map' as const, owner: null } });
  const nestedA = { ...mapTarget('new_nested_a'), tocGroups: [{ handle: 'new_nested_group', id: null, expectedRevisionId: null, title: 'Subtopic path', explanation: null, originalHandles: [], memberships: [{ id: null, target: { reference: 'proposed' as const, handle: 'new_nested_b' }, purpose: 'subtopic' as const, order: 0 }] }] };
  const nestedReceipt = await apply(await pending(nested, change(nested, { targets: [nestedA, mapTarget('new_nested_b')] })));
  const nestedPages = await Promise.all(nestedReceipt.map(r => wiki.get(r.pageId)));
  const nestedPageA = WikiPageSchema.parse(nestedPages.find(p => p!.title === 'new_nested_a'));
  const nestedPageB = WikiPageSchema.parse(nestedPages.find(p => p!.title === 'new_nested_b'));
  const nestedSnapshot = await snapshot(mainPolicy, [nestedPageA.id, nestedPageB.id], [nestedPageB.id]);
  const cycleTarget = { ...mapTarget('new_nested_update'), title: nestedPageB.title, pageId: nestedPageB.id, expectedRevisionId: nestedPageB.revisionId, sections: [], tocGroups: [{ ...nestedA.tocGroups[0]!, handle: 'new_nested_reverse', memberships: [{ id: null, target: { reference: 'existing' as const, target: { kind: 'page' as const, id: nestedPageA.id }, fingerprint: nestedSnapshot.placement.pages.find(p => p.pageId === nestedPageA.id)!.fingerprint }, purpose: 'subtopic' as const, order: 0 }] }] };
  await assert.rejects(apply(await pending(nestedSnapshot, change(nestedSnapshot, { targets: [cycleTarget] }))), /scope/);
  // The canonical save guard protects other save callers too.
  const cycleDb = await db.connect();
  try {
    await cycleDb.query('begin');
    const content = WikiPageContentSchema.strip().parse(nestedPageB), groupId = randomUUID(), memberId = randomUUID();
    content.automatic!.groups.push({ version: 'automatic-wiki-v1', id: groupId, collectionId: nestedPageB.id, title: 'Reverse path', explanation: null, explanationEvidenceIds: [], membershipIds: [memberId], orderProtected: false, origin: 'generated' });
    content.automatic!.memberships.push({ version: 'automatic-wiki-v1', id: memberId, pageId: nestedPageB.id, groupId, target: { kind: 'page', id: nestedPageA.id }, purpose: 'subtopic', order: 0, origin: 'generated', placementProtected: false, expectedPageRevisionId: nestedPageB.revisionId, targetFingerprint: nestedPageA.revisionId });
    await assert.rejects(wiki.save({ id: nestedPageB.id, expectedRevisionId: nestedPageB.revisionId, content, evidenceChunkIds: [] }, { transaction: cycleDb, origin: 'organization', humanApproved: true, allocatedTarget: false }), /cycle/);
  } finally { await cycleDb.query('rollback'); cycleDb.release(); }
  const ungrounded = await snapshot(), ungroundedCount = await countPages();
  await assert.rejects(apply(await pending(ungrounded, change(ungrounded, { targets: [topic('new_rollback_first'), { ...topic('new_rollback_unbound'), sections: [] }] }))), /scope/);
  assert.equal(await countPages(), ungroundedCount, 'Late scope failure rolls back both saved revisions and allocated rows');
  // A real pending note participates in both levels of a reading TOC with one identity.
  const sharedNote=randomUUID();
  await db.query("insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,'Regulation note','Original observation','Original genetics observation',$2,$3,'pending_review','synthetic','fixture','test','fixture',$1::text)",[sharedNote,source.id,chunk]);
  await db.query('insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)',[sharedNote,source.id,chunk]);
  const noteSnapshot=await snapshot(mainPolicy,[],[],[sharedNote]), noteRef=noteSnapshot.references.find(r=>r.kind==='atomic_note'&&r.id===sharedNote)!;
  const noteTarget={reference:'existing' as const,target:{kind:'atomic_note' as const,id:sharedNote},fingerprint:noteRef.fingerprint};
  const noteIndex=(handle:string,child:string|null)=>({...mapTarget(handle),sections:[],tocGroups:[{handle:handle+'_group',id:null,expectedRevisionId:null,title:'Shared original note',explanation:null,originalHandles:[],memberships:[{id:null,target:noteTarget,purpose:'reading' as const,order:0},...(child?[{id:null,target:{reference:'proposed' as const,handle:child},purpose:'subtopic' as const,order:1}]:[])]}]});
  const noteReceipt=await apply(await pending(noteSnapshot,change(noteSnapshot,{targets:[noteIndex('new_note_index_parent','new_note_index_child'),noteIndex('new_note_index_child',null)]})));
  const memberships=(await db.query("select id,page_id,target_id from wiki_memberships where target_kind='atomic_note' and target_id=$1 order by id",[sharedNote])).rows;
  assert.equal(memberships.length,2);assert.equal(new Set(memberships.map(m=>m.page_id)).size,2);
  assert.equal((await db.query('select count(*)::int n from atomic_notes')).rows[0].n,1);
  assert.equal((await db.query('select status from atomic_notes where id=$1',[sharedNote])).rows[0].status,'pending_review');
  const notePages=await Promise.all(noteReceipt.map(r=>wiki.get(r.pageId))), noteParent=notePages.find(p=>p!.title==='new_note_index_parent')!;
  const noteInventory=await hierarchy.inventory(mainPolicy,{pageIds:[noteParent.id]});assert.equal(noteInventory.pages.length,2);assert.ok(noteInventory.pages.every(p=>p.sourceIds.length===1&&p.sourceIds[0]===source.id));
  const staleNoteSnapshot=await snapshot(mainPolicy,[],[],[sharedNote]), staleNoteRun=await pending(staleNoteSnapshot,change(staleNoteSnapshot,{targets:[noteIndex('new_note_after_admission',null)]}));
  const notePageCount=await countPages();
  await db.query('insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)',[sharedNote,outside.id,excludedChunk]);
  await assert.rejects(apply(staleNoteRun),/scope|evidence/);assert.equal(await countPages(),notePageCount);
  assert.equal((await hierarchy.inventory(mainPolicy,{pageIds:[noteParent.id]})).pages.length,0,'Secondary source lineage excludes both nested indexes');
  await db.query("insert into atomic_note_evidence(note_id,chunk_id,source_id,snapshot) select $1,id,source_item_id,jsonb_build_object('contentHash',content_hash,'excerpt',content) from chunks where id=$2",[sharedNote,excludedChunk]);
  await db.query('delete from atomic_note_source_links where atomic_note_id=$1 and chunk_id=$2',[sharedNote,excludedChunk]);
  const retainedOriginals=await repo.noteOriginals(sharedNote);assert.ok(retainedOriginals.source_ids.includes(outside.id)&&retainedOriginals.chunk_ids.includes(excludedChunk));
  await assert.rejects(repo.references([source.id],[sharedNote],[chunk]),/scope/);
  await assert.rejects(apply(staleNoteRun),/scope|evidence/);
  assert.equal((await hierarchy.inventory(mainPolicy,{pageIds:[noteParent.id]})).pages.length,0,'Retained original lineage cannot disappear with a removed live link');
  assert.deepEqual((await db.query("select id,page_id,target_id from wiki_memberships where target_kind='atomic_note' and target_id=$1 order by id",[sharedNote])).rows,memberships);
  // Both requests wait behind the same placement lock before racing; no timing guess.
  async function contend<T>(actions:Array<()=>Promise<T>>){
    const blocker=await db.connect();await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
    const pending=actions.map(action=>action().then(value=>({ok:true as const,value}),error=>({ok:false as const,error})));
    try{let waiting=0;for(let attempt=0;attempt<200&&waiting<actions.length;attempt++){waiting=(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%wiki-placement%'")).rows[0].n;if(waiting<actions.length)await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(waiting,actions.length,'Both independent transactions reached the serialization lock');}
    finally{await blocker.query('commit');blocker.release();}
    return Promise.all(pending);
  }
  const racingEntity=randomUUID();await db.query("insert into entities(id,canonical_name,type,normalized_name,confidence) values($1,'Concurrent identity','organization','concurrent identity',1)",[racingEntity]);
  const raceBindings=await contend([0,1].map(i=>()=>wiki.save({expectedRevisionId:null,content:WikiPageContentSchema.parse({title:'Concurrent entity '+i,kind:'entity',entityId:racingEntity}),evidenceChunkIds:[]})));
  assert.equal(raceBindings.filter(r=>r.ok).length,1);assert.match(String(raceBindings.find(r=>!r.ok)!.error),/conflict/);
  assert.equal((await db.query("select count(*)::int n from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where r.content->>'entityId'=$1",[racingEntity])).rows[0].n,1);
  const reciprocalBase=await snapshot(), reciprocalReceipt=await apply(await pending(reciprocalBase,change(reciprocalBase,{targets:[topic('new_reciprocal_a'),topic('new_reciprocal_b')]})));
  const [reciprocalA,reciprocalB]=reciprocalReceipt.map(r=>r.pageId) as [string,string];
  const moveSnapshots=await Promise.all([snapshot(mainPolicy,[reciprocalA,reciprocalB],[reciprocalA]),snapshot(mainPolicy,[reciprocalA,reciprocalB],[reciprocalB])]);
  const moveRuns=await Promise.all(moveSnapshots.map((s,index)=>pending(s,change(s,{targets:[],moves:[{handle:'new_reciprocal_move',operation:'reviewed_reparent',pageId:s.pages[0]!.id,expectedRevisionId:s.pages[0]!.revisionId,fromParent:null,toParent:parentRef(s,index?reciprocalA:reciprocalB),reason:'Explicit reviewed concurrent move'}]}))));
  const reciprocal=await contend(moveRuns.map(id=>()=>apply(id,true)));
  assert.equal(reciprocal.filter(r=>r.ok).length,1);assert.match(String(reciprocal.find(r=>!r.ok)!.error),/conflict|scope/);
  const finalMoves=await Promise.all([wiki.get(reciprocalA),wiki.get(reciprocalB)]);
  assert.equal(finalMoves.filter(p=>p!.parentId!==null).length,1);
  assert.equal((await db.query('select count(*)::int n from wiki_group_receipts where run_id=any($1::uuid[])',[moveRuns])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from wiki_page_revisions where page_id=any($1::uuid[])',[ [reciprocalA,reciprocalB] ])).rows[0].n,3,'Losing move has no partial revision');
  // Reserved identity never exempts authored excluded prose from scope.
  const changedArea=WikiPageSchema.parse(await wiki.get(wikiAreaIds.investigations));
  await wiki.save({version:2,id:changedArea.id,expectedRevisionId:changedArea.revisionId,content:{...WikiPageContentSchema.strip().parse(changedArea),sections:[{id:randomUUID(),title:'Excluded human section',markdown:'Private excluded findings',kind:'prose',provenance:'personal',protected:true,evidenceReview:'needs_review',evidenceIds:[excludedChunk]}]},evidenceChunkIds:[excludedChunk]});
  assert.equal((await hierarchy.inventory(mainPolicy,{pageIds:[changedArea.id],editablePageIds:[changedArea.id]})).pages.length,0);
  // An ancestor-only proof is never self-authorizing; exact owner checkpoint + restart is required.
  const prefixSnapshot = await snapshot();
  const ownerId = await runs.create({ version: 'fixture-owner' }, { state: 'running', hierarchy: { routes: [], outcome: 'pending' } });
  const route = HierarchyRouteContinuationSchema.parse({ version: 'automatic-wiki-v1', routeId: randomUUID(), fingerprint: { version: 'automatic-wiki-v1', branchFingerprint: prefixSnapshot.placement.fingerprint, scopeFingerprint: prefixSnapshot.placement.scopeFingerprint, policyRevisionId: mainPolicy.revisionId, promptFingerprint: curatorHash(promptPin), modelFingerprint: profile.identityHash }, state: 'pending', intendedTargets: [{ key: 'new_final_leaf', title: 'Later findings', purpose: 'Complete supported route', role: { kind: 'topic', role: 'topic' }, resolvedPageId: null }], remainingPath: Array.from({ length: 4 }, (_, i) => ({ key: `new_prefix_${i}`, title: `Continuation ${i}`, purpose: 'Required continuation route', role: { kind: 'topic', role: 'topic' } })), resolvedPrefix: [], destination: null, reason: 'context', completedGroupIds: [], currentChildRunId: null });
  function prefixChange(s: HierarchySnapshot, route: typeof s.continuationRoute, length: number) {
    const r = route!; return change(s, { targets: [], ancestors: r.remainingPath.slice(0, length).map((p, i) => ({ handle: p.key, title: p.title, purpose: p.purpose, role: p.role, initialParent: i ? proposed(r.remainingPath[i - 1]!.key) : r.resolvedPrefix.length ? { reference: 'existing', target: { kind: 'page', id: r.resolvedPrefix.at(-1)!.pageId }, expectedRevisionId: r.resolvedPrefix.at(-1)!.revisionId, fingerprint: r.resolvedPrefix.at(-1)!.fingerprint } : r.destination })), continuation: { routeId: r.routeId, fingerprint: r.fingerprint, intendedTargetKeys: r.intendedTargets.map(t => t.key), nextParent: { reference: 'proposed', handle: r.remainingPath[length - 1]!.key } } });
  }
  async function admitPrefix(s: HierarchySnapshot, r: typeof route, length: number) {
    const proposal = prefixChange(s, r, length), runId = await pending({ ...s, parentBootstrapId: ownerId, continuationRoute: r }, proposal);
    const bound = { ...r, currentChildRunId: runId };
    await db.query('update organization_runs set snapshot=$2 where id=$1', [runId, { ...s, parentBootstrapId: ownerId, continuationRoute: bound }]);
    await db.query('update organization_runs set checkpoint=$2 where id=$1', [ownerId, { state: 'running', hierarchy: { routes: [bound], outcome: 'pending' } }]);
    return runId;
  }
  const prefixRun = await admitPrefix(prefixSnapshot, route, 2);
  assert.equal((await apply(prefixRun)).length, 2);
  const afterPrefix = (await runs.get(ownerId))!.checkpoint.hierarchy.routes[0];
  assert.equal(afterPrefix.state, 'partial'); assert.equal(afterPrefix.remainingPath.length, 2); assert.equal(afterPrefix.resolvedPrefix.length, 2);
  assert.deepEqual(await apply(prefixRun), await apply(prefixRun));
  const resumeSnapshot = await snapshot(mainPolicy, afterPrefix.resolvedPrefix.map((p: { pageId: string }) => p.pageId));
  assert.equal(resumeSnapshot.placement.fingerprint, afterPrefix.fingerprint.branchFingerprint);
  const resumedRun = await admitPrefix(resumeSnapshot, afterPrefix, 2);
  assert.equal((await apply(resumedRun)).length, 2);
  const afterResume = (await runs.get(ownerId))!.checkpoint.hierarchy.routes[0];
  assert.equal(afterResume.remainingPath.length, 0); assert.equal(afterResume.state, 'partial', 'Prefix completion cannot claim the unresolved leaf');
  const finishSnapshot=await snapshot(mainPolicy,afterResume.resolvedPrefix.map((p:{pageId:string})=>p.pageId));
  const finalTarget={...topic('new_final_leaf','Later findings'),purpose:'Complete supported route',initialParent:parentRef(finishSnapshot,afterResume.resolvedPrefix.at(-1).pageId)};
  const finishProposal=change(finishSnapshot,{targets:[finalTarget]});
  const finishRun=await pending({...finishSnapshot,parentBootstrapId:ownerId,continuationRoute:afterResume},finishProposal);
  const finishRoute={...afterResume,currentChildRunId:finishRun};
  await db.query('update organization_runs set snapshot=$2 where id=$1',[finishRun,{...finishSnapshot,parentBootstrapId:ownerId,continuationRoute:finishRoute}]);
  await db.query('update organization_runs set checkpoint=$2 where id=$1',[ownerId,{state:'running',hierarchy:{routes:[finishRoute],outcome:'partial'}}]);
  const finalReceipt=await apply(finishRun);
  const finished=(await runs.get(ownerId))!.checkpoint.hierarchy;
  assert.equal(finished.outcome,'complete');assert.equal(finished.routes[0].intendedTargets[0].resolvedPageId,finalReceipt[0]!.pageId);
  const forged = await snapshot(), forgedProposal = prefixChange(forged, route, 1), forgedRun = await pending({ ...forged, continuationRoute: route }, forgedProposal);
  await assert.rejects(apply(forgedRun), /scope/);
  const pause = await snapshot(), pauseRun = await pending(pause, change(pause));
  await db.query("insert into wiki_policy_activations(policy_id,revision_id,state,created_at) values($1,$2,'paused',clock_timestamp())", [mainPolicy.id, mainPolicy.revisionId]);
  await assert.rejects(apply(pauseRun, true), /policy/);
  console.log('Hierarchy fresh PostgreSQL: actual initialized area destinations with immutable reserved ownership, shared pending note across nested TOCs with retained excluded-secondary-lineage rejection, serialized entity-binding and reciprocal-move races, deep 4-ancestor + 2-target transaction, six-target cap, scoped inventory/cursors, shared reuse, protected reviewed move with unchanged section/support/evidence, exact support and stale guards, canonical entity uniqueness/homonyms, archived/cyclic parents, nested TOC cycles, late rollback, excluded lineage, atomic route prefixes/restart/final leaf/replay and pause passed. Synthetic audits only; no inference or user database accessed.');
} finally { if (pool) await closePgPool(pool); await manager.stop(); await rm(dir, { recursive: true, force: true }); }
