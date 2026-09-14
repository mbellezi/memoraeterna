import { randomUUID } from 'node:crypto';
import { WikiPageContentSchema, type AutomaticWikiPolicy, type WikiPageContent } from '@app/domain';
import type { PgPool } from '../client.js';
import { createWikiCuratorRepository } from './wikiCuratorRepository.js';
import { createWikiRepository } from './wikiRepository.js';

type Dependency = { section_id: string; kind: string; input_id: string; fingerprint: string; snapshot: unknown; stale_reason: string | null; changed_at: Date | null };
const key = (kind: string, id: string) => `${kind === 'wiki_page' ? 'page' : kind}:${id}`;

/** Removal is a subtraction of known inputs, never a new model support verdict. */
export function recomposeRemovedInputs(content: WikiPageContent, consumers: Set<string>, missing: Set<string>, referencesTitle: string) {
  const next = structuredClone(content), resetGroups = new Set<string>();
  const protectedPage = content.review === 'reviewed' || content.automatic?.management === 'human_managed';
  next.sections = next.sections.filter(s => !consumers.has(s.id) || protectedPage || s.protected || s.provenance !== 'generated' || !!s.interpretations?.length);
  if (next.automatic) {
    const automatic = next.automatic;
    automatic.links = automatic.links.filter(t => !missing.has(key(t.kind, t.id)));
    automatic.memberships = automatic.memberships.filter(m => !missing.has(key(m.target.kind, m.target.id)));
    automatic.groups = automatic.groups.filter(g => {
      const members = automatic.memberships.filter(m => m.groupId === g.id);
      const removedMember = content.automatic!.memberships.some(m => m.groupId === g.id && missing.has(key(m.target.kind, m.target.id)));
      if (!consumers.has(g.id) && !removedMember) return true;
      g.membershipIds = members.map(m => m.id);
      if (!protectedPage && g.origin !== 'human' && !g.orderProtected) {
        resetGroups.add(g.id);
        g.title = referencesTitle; g.explanation = null; g.explanationEvidenceIds = []; g.origin = 'deterministic';
        return members.length > 0;
      }
      return true;
    });
    automatic.memberships = automatic.memberships.filter(m => automatic.groups.some(g => g.id === m.groupId));
    if (automatic.role.kind === 'collection' && automatic.role.owner && missing.has(key(automatic.role.owner.kind, automatic.role.owner.id))) {
      automatic.role = { kind: 'collection', role: 'map', owner: null };
    }
  }
  return { content: WikiPageContentSchema.parse(next), resetGroups };
}

export function createWikiRemovalRepository(pool: PgPool) {
  return {
    async repair(policy: AutomaticWikiPolicy, pageId: string, expectedRevisionId: string, referencesTitle: string, delivery?: { id: string; checkpoint: Record<string, unknown> }) {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['wiki-policy:' + policy.id]);
        // These repository reads share the transaction and never acquire another connection.
        const scoped = { query: db.query.bind(db) } as PgPool;
        const currentPolicy = await createWikiCuratorRepository(scoped).policy(policy.id);
        if (currentPolicy?.state !== 'enabled' || currentPolicy.revisionId !== policy.revisionId) throw new Error('organization.errors.policy');
        const row = (await db.query('select current_revision_id from wiki_pages where id=$1 for update', [pageId])).rows[0];
        if (row?.current_revision_id !== expectedRevisionId) throw new Error('organization.errors.conflict');
        const page = await createWikiRepository(scoped).get(pageId);
        const content = WikiPageContentSchema.strip().parse(page);
        const deps = (await db.query('select * from wiki_dependencies where revision_id=$1 order by kind,input_id', [expectedRevisionId])).rows as Dependency[];
        const targets = [...deps.map(d => ({ kind: d.kind, id: d.input_id })), ...(content.automatic?.links ?? []), ...(content.automatic?.memberships ?? []).map(m => m.target)];
        if (content.automatic?.role.kind === 'collection' && content.automatic.role.owner) targets.push(content.automatic.role.owner);
        const tables: Record<string, string> = { source: 'source_items', document: 'documents', chunk: 'chunks', atomic_note: 'atomic_notes', entity: 'entities', page: 'wiki_pages', wiki_page: 'wiki_pages' };
        const missing = new Set<string>();
        const uniqueTargets = [...new Map(targets.map(t => [key(t.kind, t.id), t])).values()];
        for (const target of uniqueTargets.toSorted((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)))) {
          const table = tables[target.kind]; if (!table) continue;
          const fields = target.kind === 'atomic_note' ? 'id,status' : ['page', 'wiki_page'].includes(target.kind) ? 'id,archived' : 'id';
          const current = (await db.query(`select ${fields} from ${table} where id=$1 for share`, [target.id])).rows[0];
          if (!current || target.kind === 'atomic_note' && ['rejected', 'archived'].includes(current.status) || ['page', 'wiki_page'].includes(target.kind) && current.archived) missing.add(key(target.kind, target.id));
        }
        if (!missing.size) { await db.query('commit'); return null; }
        const allowed = await createWikiCuratorRepository(scoped).allowed(policy);
        const sourceIds = [...new Set(targets.filter(t => t.kind === 'source').map(t => t.id))];
        if (!sourceIds.length && !policy.scope.wholeLibrary) throw new Error('organization.errors.scopeDecision');
        for (const id of sourceIds) {
          if (allowed.includes(id)) continue;
          // Missing inputs do not authorize reading any still-existing excluded source.
          if (!missing.has(key('source', id)) || policy.scope.excludedSourceIds.includes(id)) throw new Error('organization.errors.scopeDecision');
          if (!policy.scope.wholeLibrary && !policy.scope.sourceIds.includes(id)) {
            const admitted = (await db.query("select 1 from organization_runs where snapshot->'policy'->>'revisionId'=$1 and snapshot->'sourceIds' ? $2 limit 1", [policy.revisionId, id])).rows.length;
            if (!admitted) throw new Error('organization.errors.scopeDecision');
          }
        }
        const consumers = new Set(deps.filter(d => missing.has(key(d.kind, d.input_id))).map(d => d.section_id));
        const repair = recomposeRemovedInputs(content, consumers, missing, referencesTitle);
        if (!policy.operations.includes('update_unprotected') && JSON.stringify(content.sections) !== JSON.stringify(repair.content.sections) || !policy.operations.includes('repair_navigation') && JSON.stringify(content.automatic) !== JSON.stringify(repair.content.automatic)) throw new Error('organization.errors.policy');
        const remainingSources = sourceIds.filter(id => allowed.includes(id));
        if (!remainingSources.length && !repair.content.sections.length && !repair.content.automatic?.memberships.length && content.automatic?.management === 'ai_managed' && content.review !== 'reviewed' && !content.pinned && !content.automatic.placementProtected) repair.content.archived = true;
        const changed = JSON.stringify(content) !== JSON.stringify(repair.content);
        let revisionId = expectedRevisionId;
        if (changed) {
          revisionId = randomUUID();
          await createWikiRepository(scoped).save({ id: pageId, expectedRevisionId, content: repair.content, evidenceChunkIds: [] }, { transaction: db, origin: 'organization', allocatedTarget: false, humanApproved: false, revisionId });
          const role = repair.content.automatic?.role;
          if (role) await db.query('update wiki_pages set role=$2,toc_owner_kind=$3,toc_owner_id=$4 where id=$1', [pageId, role.role, role.kind === 'collection' ? role.owner?.kind ?? null : null, role.kind === 'collection' ? role.owner?.id ?? null : null]);
          // Unchanged protected prose retains its missing evidence. Rebuilt navigation drops
          // removed members' provenance and retains the exact lineage of surviving members.
          for (const groupId of repair.resetGroups) {
            await db.query('delete from wiki_dependencies where revision_id=$1 and section_id=$2', [revisionId, groupId]);
            const members = repair.content.automatic?.memberships.filter(m => m.groupId === groupId) ?? [];
            const references = deps.filter(d => d.section_id === groupId).map(d => d.snapshot as { kind?: string; id?: string; sourceIds?: string[]; chunkIds?: string[] }).filter(r => r && members.some(m => m.target.kind === r.kind && m.target.id === r.id));
            const sources = new Set(references.flatMap(r => r.sourceIds ?? [])), chunks = new Set(references.flatMap(r => r.chunkIds ?? []));
            for (const dep of deps.filter(d => d.section_id === groupId)) {
              if (!repair.content.automatic?.groups.some(g => g.id === groupId)) continue;
              const snapshot = dep.snapshot as { kind?: string; id?: string; chunkId?: string } | null;
              const keep = dep.kind === 'source' ? sources.has(dep.input_id) : dep.kind === 'chunk' ? chunks.has(dep.input_id) : dep.kind === 'document' ? !!snapshot?.chunkId && chunks.has(snapshot.chunkId) :
                members.some(m => key(m.target.kind, m.target.id) === key(dep.kind, dep.input_id)) || dep.kind === 'wiki_section' && members.some(m => snapshot?.kind === m.target.kind && snapshot?.id === m.target.id);
              if (!keep) continue;
              await db.query('insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot,stale_reason,changed_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing', [revisionId, groupId, dep.kind, dep.input_id, dep.fingerprint, dep.snapshot, dep.stale_reason, dep.changed_at]);
            }
          }
          // Keep a scoped target for the subsequent synthesis even if subtraction emptied it.
          for (const id of remainingSources) await db.query("insert into wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot) values($1,$2,'source',$3,'removal-recomposition',$4) on conflict do nothing", [revisionId, pageId, id, { removalRecomposition: true }]);
        }
        const currentDependencies = (await db.query('select kind,input_id from wiki_dependencies where revision_id=$1', [revisionId])).rows;
        const preservedMissing = currentDependencies.some(d => missing.has(key(d.kind, d.input_id)));
        const result = { pageId, revision_id: revisionId, source_ids: remainingSources, archived: repair.content.archived, changed, preservedMissing };
        if (delivery) await db.query('update knowledge_impact_deliveries set checkpoint=$2 where id=$1', [delivery.id, { ...delivery.checkpoint, removalRepair: result }]);
        await db.query('commit');
        return result;
      } catch (error) { await db.query('rollback'); throw error; }
      finally { db.release(); }
    }
  };
}
