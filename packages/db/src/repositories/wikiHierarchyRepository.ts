import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  hierarchyMoveReviews,resolveHierarchyRouteParent,HierarchyChangeSetSchema, HierarchySnapshotSchema, HierarchySupportAssessmentSchema,
  HierarchyRouteContinuationSchema, HierarchyPlacementInventorySchema, HierarchyPolicySchema,
  WikiPageContentSchema, countHierarchyChanges, hasCompleteHierarchySupport, validateHierarchyAdmission,
  hierarchyResourceDecision, promptDefinition, type HierarchyChangeSet, type HierarchySnapshot, type HierarchyPolicy,
  type HierarchyPlacementInventory, type HierarchyPageTarget, type HierarchyParent
} from '@app/domain';
import type { PgPool, PgClient } from '../client.js';
import { curatorHash, validateCuratorOriginals } from './wikiCuratorRepository.js';
import { persistCuratorTargets } from './wikiCuratorPersistence.js';
import { canonicalEntityPage } from './wikiHierarchyCanonical.js';
import { readHierarchyPlacementInventory, type HierarchyInventoryRequest } from './wikiHierarchyInventory.js';
import { addWikiDependency } from './wikiContextRepository.js';
import { applyNoteEvolution } from './knowledgeEvolution.js';
import { validateAutomaticAuthority, validateAutomaticReviewAuthority } from './automaticMaintenanceRepository.js';


/** Backend-owned exact structural admission. These entrypoints do not admit jobs or invoke AI. */
export function createWikiHierarchyRepository(pool: PgPool) {
  return {
    async validatePlacement(snapshot:HierarchySnapshot,db:Pick<PgPool,'query'>=pool){snapshot=HierarchySnapshotSchema.parse(snapshot);const current=await currentInventory(db,snapshot);if(current.fingerprint!==snapshot.placement.fingerprint||!isDeepStrictEqual(current.pages,snapshot.placement.pages))throw new Error('organization.errors.conflict');},
    inventory(policy: HierarchyPolicy, request: HierarchyInventoryRequest) { return readHierarchyPlacementInventory(pool, policy, request); },
    canonicalEntityPage(entityId: string) { return canonicalEntityPage(pool, entityId); },
    async apply(runId: string, human: boolean, validate: (snapshot: HierarchySnapshot, proposal: HierarchyChangeSet) => void, authorize: () => Promise<void>) {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        const preliminary = (await db.query('select snapshot from organization_runs where id=$1', [runId])).rows[0];
        if (!preliminary) throw new Error('organization.errors.invalid');
        const snapshot = HierarchySnapshotSchema.parse(preliminary.snapshot);
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['wiki-policy:' + snapshot.policy.id]);
        // Placement serializes group applications; sorted row locks also coordinate parent pauses.
        const runRows = (await db.query('select * from organization_runs where id=any($1::uuid[]) order by id for update', [[runId, ...(snapshot.parentBootstrapId ? [snapshot.parentBootstrapId] : [])]])).rows;
        const run = runRows.find(r => r.id === runId)!;
        const receipt = (await db.query('select targets from wiki_group_receipts where run_id=$1 and group_id=$2', [runId, snapshot.groupId])).rows[0];
        if (receipt) { await db.query('commit'); return receipt.targets as Array<{ pageId: string; revisionId: string }>; }
        const parent = runRows.find(r => r.id === snapshot.parentBootstrapId);
        if (snapshot.parentBootstrapId && (!parent || parent.status === 'canceled' || !human && parent.checkpoint.state !== 'running')) throw new Error('organization.errors.policy');
        const job = (await db.query('select cancel_requested_at from jobs where id=$1 for update', [run.job_id])).rows[0];
        if (run.status !== 'awaiting_review' || job?.cancel_requested_at) throw new Error('organization.errors.canceled');
        if (!human && Date.now() >= Date.parse(snapshot.maintenanceRunId ? run.checkpoint.executionAdmittedAt ?? snapshot.admittedAt : snapshot.admittedAt) + snapshot.limits.deadlineMs) throw new Error('organization.errors.deadline');
        const policyRow = (await db.query(`select r.policy,a.state from wiki_policy_activations a join wiki_policy_revisions r on r.id=a.revision_id and r.policy_id=a.policy_id where a.policy_id=$1 order by a.created_at desc,a.id desc limit 1`, [snapshot.policy.id])).rows[0];
        const policy = policyRow ? HierarchyPolicySchema.parse({ ...policyRow.policy, state: policyRow.state }) : null;
        if (!policy || policy.state !== 'enabled' || !isDeepStrictEqual(policy, snapshot.policy)) throw new Error('organization.errors.policy');
        if (snapshot.maintenanceRunId) {
          if (human) await validateAutomaticReviewAuthority(db, snapshot.maintenanceRunId, policy.id, policy.revisionId, true);
          else await validateAutomaticAuthority(db, snapshot.maintenanceRunId, policy.id, true);
        }
        const proposal = HierarchyChangeSetSchema.parse((await db.query('select proposal from organization_proposals where run_id=$1', [runId])).rows[0]?.proposal);
        if (proposal.groupId !== snapshot.groupId || proposal.policyRevisionId !== policy.revisionId) throw new Error('organization.errors.scope');
        if (countHierarchyChanges(proposal).workTargets > snapshot.limits.targets || hierarchyResourceDecision(proposal, snapshot.resources.maxProposalBytes).decision !== 'fits') throw new Error('organization.errors.scopeLimit');
        if ((proposal.moves.length || proposal.noteEvolution) && !human) throw new Error('organization.errors.review');
        const parsedSupport = HierarchySupportAssessmentSchema.safeParse(run.checkpoint.supportAssessment);
        if(!parsedSupport.success)throw new Error('organization.errors.evidence');
        const support=parsedSupport.data, proposalHash = curatorHash(proposal);
        if (support.proposalHash !== proposalHash || !hasCompleteHierarchySupport(proposal, support.verdict)) throw new Error('organization.errors.evidence');
        const supportPromptId = snapshot.intent ? 'organization.evolution.support' : 'organization.curator.support';
        const pin = snapshot.promptPin.entries.find(p => p.id === supportPromptId);
        if (!pin) throw new Error('organization.errors.evidence');
        const promptIds=new Set<string>();
        const collect=(id:string)=>{if(promptIds.has(id))return;promptIds.add(id);promptDefinition(id).fragmentIds.forEach(collect);};
        collect(supportPromptId);
        const expectedRevisions=[...promptIds].flatMap(id=>snapshot.promptPin.entries.find(p=>p.id===id)?.revisions??[{id,revisionId:'shipped-'+promptDefinition(id).defaultVersion}]);
        const audit = (await db.query(`select a.prompt_compositions from organization_steps s join ai_task_runs a on a.id=s.ai_task_run_id
          where s.run_id=$1 and s.ai_task_run_id=$2 and a.status='succeeded' and s.artifact->>'proposalHash'=$3 and s.artifact->'support'=$4::jsonb`, [runId, support.aiTaskRunId, proposalHash, JSON.stringify(support.verdict)])).rows[0];
        if (!audit?.prompt_compositions?.some((p: { promptId: string; revisions: unknown; compositionHash:string }) => p.promptId === supportPromptId && p.compositionHash===snapshot.supportCompositionHash && isDeepStrictEqual(p.revisions, expectedRevisions))) throw new Error('organization.errors.evidence');
        await db.query('select id from wiki_pages where id=any($1::uuid[]) order by id for update', [snapshot.placement.pages.map(p => p.pageId)]);
        await validateCuratorOriginals(db, snapshot, policy, true);
        await db.query('lock table atomic_note_evidence in share mode');
        if((await db.query('select 1 from atomic_note_evidence where note_id=any($1::uuid[]) and not(source_id=any($2::uuid[])) limit 1',[snapshot.references.filter(r=>r.kind==='atomic_note').map(r=>r.id),snapshot.sourceIds])).rows.length)throw new Error('organization.errors.scope');
        if (!snapshot.evidence.length || snapshot.evidence.some(e => !snapshot.sourceIds.includes(e.sourceItemId))) throw new Error('organization.errors.scope');
        const placement = await currentInventory(db, snapshot);
        if (!isDeepStrictEqual(placement.pages, snapshot.placement.pages) || placement.fingerprint !== snapshot.placement.fingerprint) throw new Error('organization.errors.conflict');
        for(const ref of snapshot.references.filter(r=>r.kind==='page')){const p=placement.pages.find(p=>p.pageId===ref.id);if(!p||!([p.revisionId,p.fingerprint].includes(ref.fingerprint)))throw new Error('organization.errors.conflict');}
        for (const page of snapshot.pages) {
          if (!placement.pages.some(p => p.pageId === page.id && p.canEdit)) throw new Error('organization.errors.scope');
          const current = (await db.query('select content from wiki_page_revisions where id=$1 and page_id=$2', [page.revisionId, page.id])).rows[0];
          if (!current || !isDeepStrictEqual(WikiPageContentSchema.strip().parse(page), WikiPageContentSchema.parse(current.content))) throw new Error('organization.errors.conflict');
        }
        let route = null;
        if (snapshot.continuationRoute || proposal.continuation) {
          // A model proof or child snapshot alone cannot grant prefix-only authority.
          if (!parent || !snapshot.continuationRoute) throw new Error('organization.errors.scope');
          route = HierarchyRouteContinuationSchema.parse(parent.checkpoint.hierarchy?.routes?.find((r: { routeId: string }) => r.routeId === snapshot.continuationRoute!.routeId));
          if (!route.reason || route.currentChildRunId !== runId || !isDeepStrictEqual(route, snapshot.continuationRoute)) throw new Error('organization.errors.conflict');
          for (const prefix of route.resolvedPrefix) {
            const current = placement.pages.find(p => p.pageId === prefix.pageId);
            if (!current || current.revisionId !== prefix.revisionId || current.fingerprint !== prefix.fingerprint) throw new Error('organization.errors.conflict');
          }
        }
        if(route){
          if(route.fingerprint.branchFingerprint!==placement.fingerprint||route.fingerprint.scopeFingerprint!==placement.scopeFingerprint||route.fingerprint.policyRevisionId!==policy.revisionId)throw new Error('organization.errors.conflict');
          if(!proposal.continuation)validateRouteCompletion(proposal,route);
        }
        // Review is computed from the pinned base; exact footprint equality above rejects concurrent inbound links as well.
        const admission = validateHierarchyAdmission(proposal, policy, placement, snapshot.references, route);
        if (!admission.valid) throw new Error('organization.errors.scope');
        hierarchyMoveReviews(snapshot.placement,proposal);
        validateContent(snapshot, proposal);
        validate(snapshot, proposal);
        await db.query('select id from ai_profile_sets where id=$1 for share', [snapshot.profile.profileId]);
        await db.query('select id from ai_profile_tasks where profile_id=$1 order by id for share', [snapshot.profile.profileId]);
        if (snapshot.profile.localModelId) await db.query('select id from local_models where id=$1 for share', [snapshot.profile.localModelId]);
        if (snapshot.profile.providerConfigId) await db.query('select id from ai_provider_configs where id=$1 for share', [snapshot.profile.providerConfigId]);
        await authorize();
        await db.query("select set_config('memora.causal_run_id',$1,true),set_config('memora.causal_group_id',$2,true)", [snapshot.causalRunId ?? runId, snapshot.causalGroupId ?? snapshot.groupId]);
        const targets: HierarchyPageTarget[] = [...proposal.ancestors.map(a => ({ ...a, pageId: null, expectedRevisionId: null, sections: [], tocGroups: [], links: [] })), ...proposal.targets];
        for (const move of proposal.moves) if (!targets.some(t => t.pageId === move.pageId)) {
          const page = snapshot.pages.find(p => p.id === move.pageId);
          if (!page) throw new Error('organization.errors.scope');
          const role = page.automatic?.role??placement.pages.find(p=>p.pageId===page.id)!.role;
          targets.push({ handle: move.handle, pageId: move.pageId, expectedRevisionId: move.expectedRevisionId, initialParent: null, title: page.title, purpose: page.automatic?.purpose||'Existing page placement', role: role.kind === 'collection' ? { ...role, owner: role.owner ? { reference: 'existing', target: role.owner, fingerprint: snapshot.references.find(r => r.kind === role.owner!.kind && r.id === role.owner!.id)?.fingerprint ?? '' } : null } : role, sections: [], tocGroups: [], links: (page.automatic?.links??[]).map(link => ({ reference: 'existing', target: link, fingerprint: snapshot.references.find(r => r.kind === link.kind && r.id === link.id)?.fingerprint ?? '' })) });
        }
        // Allocate once; new parent IDs are available to both moves and target saves.
        const allocation = new Map(targets.map(t => [t.handle, t.pageId ?? randomUUID()]));
        const resolveParent = (ref: HierarchyParent | null) => !ref ? null : ref.reference === 'existing' ? ref.target.id : allocation.get(ref.handle)!;
        const parents = new Map(proposal.moves.map(m => [m.pageId, resolveParent(m.toParent)]));
        const persistenceSnapshot={...snapshot,references:[...snapshot.references,...placement.pages.filter(p=>!snapshot.references.some(r=>r.kind==='page'&&r.id===p.pageId)).map(p=>({kind:'page' as const,id:p.pageId,title:p.title,fingerprint:p.revisionId,text:'',sourceIds:p.sourceIds,chunkIds:[]}))]};
        const persisted = await persistCuratorTargets(db, pool, persistenceSnapshot, { targets }, human, support.aiTaskRunId, { parents, explicitParent: true, allocation, placementOnlyIds: new Set(proposal.moves.filter(m => !proposal.targets.some(t => t.pageId === m.pageId)).map(m => m.pageId)) });
        // Category evidence is metadata lineage, never a synthetic authored section.
        // Prefix-only authority has no children yet: its canonical route and complete support
        // bind the same admitted originals used for the pending path.
        for (const ancestor of proposal.ancestors) {
          const pageId = persisted.ids.get(ancestor.handle)!, revisionId = persisted.targets.find(t => t.pageId === pageId)!.revisionId;
          if (route) for (const original of snapshot.evidence.filter(e=>route!.remainingPath.find(p=>p.key===ancestor.handle)!.chunkIds.includes(e.chunkId))) for (const [kind, id] of [['source', original.sourceItemId], ['document', original.documentId], ['chunk', original.chunkId]]) await addWikiDependency(db, revisionId, pageId, { kind: kind!, id: id!, fingerprint: original.contentHash }, { hierarchyRouteId: route.routeId, ...original });
        }
        const evolution = await applyNoteEvolution(db, pool, runId, snapshot, proposal, persisted.targets.map(t => t.pageId));
        if (evolution.repairs.some(r => !persisted.targets.some(t => t.pageId === r.pageId))) throw new Error('organization.errors.scope');
        for (const repair of evolution.repairs) persisted.targets[persisted.targets.findIndex(t => t.pageId === repair.pageId)] = repair;
        const changedIds = persisted.targets.map(t => t.pageId);
        const after = await completeInventory(db, policy, [...placement.pages.map(p => p.pageId), ...changedIds], snapshot.pages.map(p => p.id), snapshot.resources.maxInventoryBytes);
        if (changedIds.some(id => !after.pages.some(p => p.pageId === id))) throw new Error('organization.errors.scope');
        if (route) {
          const prefix = proposal.ancestors.map(a => { const page = after.pages.find(p => p.pageId === persisted.ids.get(a.handle))!; return { key: a.handle, pageId: page.pageId, revisionId: page.revisionId, fingerprint: page.fingerprint }; });
          const complete=!proposal.continuation;
          const refreshParent=(parent:HierarchyParent|null):HierarchyParent|null=>parent?.reference==='existing'?{...parent,fingerprint:after.pages.find(p=>p.pageId===parent.target.id)!.fingerprint}:parent;
          const updated = HierarchyRouteContinuationSchema.parse({ ...route, state: complete?'complete':'partial', reason: complete?null:route.reason, intendedTargets:route.intendedTargets.map(t=>({...t,initialParent:refreshParent(t.initialParent),resolvedPageId:complete?persisted.ids.get(t.key)!:t.resolvedPageId})), remainingPath: route.remainingPath.slice(prefix.length).map(p=>({...p,initialParent:refreshParent(p.initialParent)})), resolvedPrefix: [...route.resolvedPrefix.map(p => ({ ...p, fingerprint: after.pages.find(a => a.pageId === p.pageId)!.fingerprint })), ...prefix], completedGroupIds: [...route.completedGroupIds, snapshot.groupId], currentChildRunId: null, fingerprint: { ...route.fingerprint, branchFingerprint: after.fingerprint } });
          const checkpoint = structuredClone(parent!.checkpoint);
          checkpoint.hierarchy.routes = checkpoint.hierarchy.routes.map((r: { routeId: string }) => r.routeId === route!.routeId ? updated : r);
          const previousCounts=checkpoint.hierarchy.counts??{workTargets:0,structuralAncestors:0,changedPages:0};
          checkpoint.hierarchy.counts={workTargets:previousCounts.workTargets+admission.counts.workTargets,structuralAncestors:previousCounts.structuralAncestors+admission.counts.structuralAncestors,changedPages:previousCounts.changedPages+admission.counts.changedPages};
          checkpoint.hierarchy.appliedGroupIds=[...new Set([...(checkpoint.hierarchy.appliedGroupIds??[]),snapshot.groupId])];
          checkpoint.hierarchy.outcome = checkpoint.hierarchy.routes.every((r:{state:string})=>r.state==='complete')?'complete':'partial';
          await db.query('update organization_runs set checkpoint=$2,updated_at=now() where id=$1', [parent!.id, checkpoint]);
          if(complete&&route.planningRunId)await db.query("update organization_runs set checkpoint=jsonb_set(checkpoint,'{continuationComplete}','true'::jsonb),updated_at=clock_timestamp() where id=$1 and checkpoint->>'continuedByRouteId'=$2",[route.planningRunId,route.routeId]);
        }
        const changes = persisted.targets.map(target => ({ ...target, proposalHash, beforeParentId: placement.pages.find(p => p.pageId === target.pageId)?.parentId ?? null, afterParentId: after.pages.find(p => p.pageId === target.pageId)!.parentId }));
        await db.query('insert into wiki_group_receipts(run_id,group_id,input_fingerprint,targets) values($1,$2,$3,$4)', [runId, snapshot.groupId, snapshot.inputFingerprint, JSON.stringify(changes)]);
        await db.query('update organization_proposals set decision=$2,decided_at=now() where run_id=$1', [runId, human ? 'accept' : 'policy']);
        await db.query("update organization_runs set status='applied',updated_at=now() where id=$1", [runId]);
        await db.query('commit'); return changes;
      } catch (error) { await db.query('rollback'); throw error; } finally { db.release(); }
    }
  };
}

async function currentInventory(db: Pick<PgPool,'query'>, snapshot: HierarchySnapshot) {
  return completeInventory(db, snapshot.policy, snapshot.placement.pages.map(p => p.pageId), snapshot.placement.pages.filter(p => p.canEdit).map(p => p.pageId), snapshot.resources.maxInventoryBytes);
}
async function completeInventory(db: Pick<PgPool,'query'>, policy: HierarchyPolicy, pageIds: string[], editablePageIds: string[], maxBytes: number): Promise<HierarchyPlacementInventory> {
  // Merge bounded pages without truncating deep canonical ancestry. A byte overflow is explicit.
  const pages: HierarchyPlacementInventory['pages'] = [];
  for(let offset=0;offset<Math.max(1,pageIds.length);offset+=300){
  let after: string | null = null;
  do {
    const part = await readHierarchyPlacementInventory(db, policy, { pageIds:pageIds.slice(offset,offset+300), editablePageIds, after, limit: 300, maxBytes });
    pages.push(...part.pages.filter(p=>!pages.some(existing=>existing.pageId===p.pageId))); after = part.nextCursor;
    if (hierarchyResourceDecision(pages, maxBytes).decision !== 'fits') throw new Error('organization.errors.scopeLimit');
  } while (after);
  }
  pages.sort((a,b)=>a.pageId.localeCompare(b.pageId));
  const scopeFingerprint = curatorHash(policy.scope);
  return HierarchyPlacementInventorySchema.parse({ version: 'automatic-wiki-v1', pages, scopeFingerprint, fingerprint: curatorHash({ scopeFingerprint, pages }), nextCursor: null });
}

function validateContent(snapshot: HierarchySnapshot, proposal: HierarchyChangeSet) {
  if(snapshot.structuralIntent?.kind==='missing_toc'&&(proposal.moves.length||proposal.targets.length!==snapshot.structuralIntent.owners.length||!snapshot.structuralIntent.owners.every(owner=>proposal.targets.some(t=>!t.pageId&&t.role.kind==='collection'&&t.role.role==='topic_toc'&&t.role.owner?.reference==='existing'&&t.role.owner.target.id===owner.pageId&&t.tocGroups.some(g=>g.memberships.length)))))throw new Error('organization.errors.scope');
  if(snapshot.structuralIntent?.kind==='unplaced'&&(proposal.targets.some(t=>t.pageId)||!proposal.moves.some(m=>m.pageId===snapshot.structuralIntent!.owners[0]!.pageId)))throw new Error('organization.errors.scope');
  const originals = (handles: string[], markdown: string) => {
    if (handles.some(h => !snapshot.evidence.some(e => e.handle === h))) throw new Error('organization.errors.evidence');
    for (const [, h] of markdown.matchAll(/\[(e[1-9][0-9]{0,3})\]/g)) if (!handles.includes(h!)) throw new Error('organization.errors.evidence');
  };
  if (snapshot.requiredPageIds.some(id => !proposal.targets.some(t => t.pageId === id) && !proposal.moves.some(m => m.pageId === id))) throw new Error('organization.errors.scope');
  if (!proposal.continuation) for (const note of snapshot.references.filter(r => r.kind === 'atomic_note')) {
    const proposed=proposal.targets.some(t => t.tocGroups.some(g => g.memberships.some(m => m.target.reference === 'existing' && m.target.target.kind === 'atomic_note' && m.target.target.id === note.id)));
    const retained=snapshot.pages.some(p=>(proposal.targets.some(t=>t.pageId===p.id)||proposal.moves.some(m=>m.pageId===p.id))&&p.automatic?.memberships.some(m=>m.target.kind==='atomic_note'&&m.target.id===note.id));
    if(!proposed&&!retained)throw new Error('organization.errors.scope');
  }
  for (const target of proposal.targets) {
    const old = snapshot.pages.find(p => p.id === target.pageId);
    if (target.pageId && (!old || old.revisionId !== target.expectedRevisionId || old.kind !== target.role.kind)) throw new Error('organization.errors.conflict');
    if (target.sections.length > snapshot.limits.sectionPatchesPerPage) throw new Error('organization.errors.scopeLimit');
    for (const section of target.sections) {
      const prior = old?.sections.find(s => s.id === section.sectionId);
      if (section.sectionId && (!prior || prior.sectionRevisionId !== section.expectedSectionRevisionId)) throw new Error('organization.errors.conflict');
      originals(section.originalHandles, section.markdown);
      if (section.interpretation) {
        const interpretation = section.interpretation;
        if (!snapshot.policy.operations.includes('interpret_memory') || !['temporal', 'procedure'].includes(snapshot.intent ?? '')) throw new Error('organization.errors.policy');
        originals(interpretation.originalHandles, interpretation.statement);
        if (interpretation.originalHandles.some(h => !section.originalHandles.includes(h)) || interpretation.relationships.some(r => !prior?.interpretations?.some(p => p.revisionId === r.revisionId))) throw new Error('organization.errors.evidence');
        if ((interpretation.perspective === 'user_statement' || interpretation.procedure) && interpretation.originalHandles.some(h => !snapshot.personalSourceIds?.includes(snapshot.evidence.find(e => e.handle === h)!.sourceItemId))) throw new Error('organization.errors.evidence');
      }
    }
    for (const group of target.tocGroups) {
      const prior = old?.automatic?.groups.find(g => g.id === group.id);
      if (group.id && (!prior || group.expectedRevisionId !== old?.revisionId)) throw new Error('organization.errors.conflict');
      originals(group.originalHandles, group.explanation ?? '');
      const retained = old?.automatic?.memberships.filter(m => m.groupId === group.id && !group.memberships.some(n => n.target.reference === 'existing' && n.target.target.kind === m.target.kind && n.target.target.id === m.target.id)) ?? [];
      if (retained.length && prior && (prior.title !== group.title || prior.explanation !== group.explanation)) throw new Error('organization.errors.evidence');
      for (const member of group.memberships) if (member.id && !old?.automatic?.memberships.some(m => m.id === member.id && m.groupId === group.id && member.target.reference === 'existing' && m.target.kind === member.target.target.kind && m.target.id === member.target.target.id)) throw new Error('organization.errors.scope');
    }
  }
  const evolution = proposal.noteEvolution;
  if (evolution) {
    if (!snapshot.intent || !['merge', 'split', 'cross_source', 'consolidation'].includes(snapshot.intent) || snapshot.intent !== 'consolidation' && snapshot.intent !== evolution.kind || !snapshot.policy.operations.includes('evolve_notes')) throw new Error('organization.errors.policy');
    const notes = snapshot.references.filter(r => r.kind === 'atomic_note');
    if (notes.length !== evolution.noteIds.length || notes.some(n => !evolution.noteIds.includes(n.id))) throw new Error('organization.errors.scope');
    const used = evolution.notes.flatMap(n => n.originalHandles.map(h => snapshot.evidence.find(e => e.handle === h)?.chunkId));
    if (notes.flatMap(n => n.chunkIds).some(id => !used.includes(id))) throw new Error('organization.errors.evidence');
    for (const note of evolution.notes) originals(note.originalHandles, note.bodyMarkdown);
    if (evolution.kind === 'cross_source' && new Set(evolution.notes.flatMap(n => n.originalHandles.map(h => snapshot.evidence.find(e => e.handle === h)!.sourceItemId))).size < 2) throw new Error('organization.errors.evidence');
  } else if (snapshot.intent && ['merge', 'split', 'cross_source'].includes(snapshot.intent)) throw new Error('organization.errors.invalid');
}

function validateRouteCompletion(proposal:HierarchyChangeSet,route:NonNullable<HierarchySnapshot['continuationRoute']>){
  const unresolved=route.intendedTargets.filter(t=>!t.resolvedPageId);
  if(proposal.moves.length||proposal.noteEvolution||proposal.ancestors.length!==route.remainingPath.length||proposal.targets.length!==unresolved.length)throw new Error('organization.errors.scope');
  for(const [index,ancestor]of proposal.ancestors.entries()){const segment=route.remainingPath[index]!;if(ancestor.handle!==segment.key||ancestor.title!==segment.title||ancestor.purpose!==segment.purpose||!isDeepStrictEqual(ancestor.role,segment.role)||!isDeepStrictEqual(ancestor.initialParent,resolveHierarchyRouteParent(segment.initialParent,route)))throw new Error('organization.errors.scope');}
  for(const target of proposal.targets){const intended=unresolved.find(t=>t.key===target.handle);if(!intended||target.title!==intended.title||target.purpose!==intended.purpose||!isDeepStrictEqual(target.role,resolveRouteRole(intended.role,route))||target.pageId||!isDeepStrictEqual(target.initialParent,resolveHierarchyRouteParent(intended.initialParent,route)))throw new Error('organization.errors.scope');}
}

function resolveRouteRole(role:HierarchyChangeSet['targets'][number]['role'],route:NonNullable<HierarchySnapshot['continuationRoute']>){
 if(role.kind!=='collection'||role.owner?.reference!=='proposed')return role;
 const prefix=route.resolvedPrefix.find(p=>p.key===(role.owner?.reference==='proposed'?role.owner.handle:''));
 return prefix?{...role,owner:{reference:'existing',target:{kind:'page',id:prefix.pageId},fingerprint:prefix.revisionId}}:role;
}
