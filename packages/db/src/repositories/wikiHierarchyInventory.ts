import { z } from 'zod';
import { HierarchyPolicySchema, HierarchyPlacementInventorySchema, HierarchyPlacementEntrySchema, wikiAreaIds, type HierarchyPolicy, type HierarchyPlacementInventory } from '@app/domain';
import type { PgPool } from '../client.js';
import { curatorHash } from './wikiCuratorRepository.js';
type Db = Pick<PgPool, 'query'>;
export const HierarchyInventoryRequestSchema = z.object({
  pageIds: z.array(z.string().uuid()).max(300).default([]),
  editablePageIds: z.array(z.string().uuid()).max(100).default([]),
  sourceIds: z.array(z.string().uuid()).default([]),
  after: z.string().uuid().nullable().default(null),
  limit: z.number().int().min(1).max(300).default(100),
  maxBytes: z.number().int().min(1024).max(2_000_000).default(256_000)
}).strict();
export type HierarchyInventoryRequest = z.input<typeof HierarchyInventoryRequestSchema>;
export async function hierarchyAllowedSources(db: Db, policy: HierarchyPolicy): Promise<string[]> {
  return (await db.query(`with recursive excluded as(select id from source_items where id=any($4::uuid[]) union select s.id from source_items s join excluded e on s.parent_source_item_id=e.id),
    allowed as(select id from source_items where ($1 or id=any($2::uuid[])) and id not in(select id from excluded) union select s.id from source_items s join allowed a on s.parent_source_item_id=a.id where $3 and s.id not in(select id from excluded)) select id from allowed order by id`, [policy.scope.wholeLibrary, policy.scope.sourceIds, policy.scope.includeDescendants, policy.scope.excludedSourceIds])).rows.map(r => r.id as string);
}

/** Metadata discovery only. Reissue with nextCursor, merge pages, then revalidate admission.
 * Recursive UNION reaches complete ancestry and designated TOC descent without a depth cap.
 * The response count and bytes are calibrated transport bounds, never depth/target limits.
 */
export async function readHierarchyPlacementInventory(db: Db, policyInput: HierarchyPolicy, input: HierarchyInventoryRequest): Promise<HierarchyPlacementInventory> {
  const policy = HierarchyPolicySchema.parse(policyInput), request = HierarchyInventoryRequestSchema.parse(input);
  const allowed = await hierarchyAllowedSources(db, policy);
  if (request.sourceIds.some(id => !allowed.includes(id))) throw new Error('organization.errors.scope');
  const rows = (await db.query(`with recursive
    seeds(id) as (select unnest($1::uuid[]) union select p.id from wiki_pages p where
      exists(select 1 from wiki_dependencies d where d.revision_id=p.current_revision_id and d.kind='source' and d.input_id=any($2::uuid[]))),
    discovery(id) as (select id from seeds union select edge.id from discovery d join lateral (
      select p.parent_id id from wiki_pages p where p.id=d.id and p.parent_id is not null
      union select m.target_id from wiki_memberships m where m.page_id=d.id and m.target_kind='page' and m.snapshot->>'purpose'='subtopic'
    ) edge on true),
    selected as (select p.id from wiki_pages p join discovery d on d.id=p.id where ($3::uuid is null or p.id>$3) order by p.id limit $4),
    edges(parent,child) as (
      select parent_id,id from wiki_pages where parent_id is not null and not archived
      union select page_id,target_id from wiki_memberships where target_kind='page'
      union select p.id,(l->>'id')::uuid from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(coalesce(r.content->'automatic'->'links','[]')) l where l->>'kind'='page'
      union select p.id,p.toc_owner_id from wiki_pages p where p.toc_owner_kind='page'
    ), reachable(root,id) as (select id,id from selected union select r.root,e.child from reachable r join edges e on e.parent=r.id where not r.root=any($5::uuid[])),
    descendants(root,id) as (select id,id from selected union select d.root,p.id from descendants d join wiki_pages p on p.parent_id=d.id where not p.archived and not d.root=any($5::uuid[])),
    typed_refs(page_id,kind,id) as (select page_id,target_kind,target_id from wiki_memberships
      union select p.id,l->>'kind',(l->>'id')::uuid from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(coalesce(r.content->'automatic'->'links','[]')) l),
    direct_sources(page_id,source_id) as (
      select p.id,d.input_id from wiki_pages p join wiki_dependencies d on d.revision_id=p.current_revision_id where d.kind='source'
      union select p.id,e.source_item_id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id join wiki_evidence e on e.page_id=p.id
        where exists(select 1 from jsonb_array_elements(r.content->'sections') s where s->'evidenceIds' ? e.id::text)
          or exists(select 1 from jsonb_array_elements(coalesce(r.content->'automatic'->'groups','[]')) g where g->'explanationEvidenceIds' ? e.id::text)
      union select id,toc_owner_id from wiki_pages where toc_owner_kind='source'
      union select m.page_id,m.target_id from wiki_memberships m where m.target_kind='source'
      union select p.id,(l->>'id')::uuid from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(coalesce(r.content->'automatic'->'links','[]')) l where l->>'kind'='source'
      union select q.page_id,n.created_from_source_item_id from typed_refs q join atomic_notes n on n.id=q.id where q.kind='atomic_note'
      union select q.page_id,e.source_id from typed_refs q join atomic_note_evidence e on e.note_id=q.id where q.kind='atomic_note'
      union select q.page_id,l.source_item_id from typed_refs q join atomic_note_source_links l on l.atomic_note_id=q.id where q.kind='atomic_note'
      union select p.id,m.source_item_id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id join entity_mentions m on m.entity_id=(r.content->>'entityId')::uuid
      union select q.page_id,m.source_item_id from typed_refs q join entity_mentions m on m.entity_id=q.id where q.kind='entity'
    ) select (p.id=any($5::uuid[]) and exists(select 1 from settings where key='knowledge.wiki-areas.v1' and value='true'::jsonb)
      and p.kind='collection' and p.parent_id is not distinct from case when p.id=any($6::uuid[]) then $7::uuid else null::uuid end
      and r.content->'sections'='[]'::jsonb and r.content->'entityId'='null'::jsonb
      and r.content->'automatic'=jsonb_build_object('version','automatic-wiki-v1','management','human_managed',
        'role',jsonb_build_object('kind','collection','role','map','owner',null),'purpose','','placementProtected',true,'links','[]'::jsonb,'groups','[]'::jsonb,'memberships','[]'::jsonb)
      and not exists(select 1 from direct_sources ds where ds.page_id=p.id)) as "navigationArea",
      p.id as "pageId",r.id as "revisionId",p.title,coalesce(r.content->'automatic'->>'purpose','') purpose,
      coalesce(r.content->'automatic'->'role',jsonb_build_object('kind',p.kind,'role',case when p.kind='collection' then 'map' else p.kind end)||case when p.kind='collection' then '{"owner":null}'::jsonb when p.kind='entity' then jsonb_build_object('entityId',r.content->>'entityId') else '{}'::jsonb end) role,
      p.parent_id as "parentId",p.archived,coalesce((r.content->'automatic'->>'placementProtected')::boolean,true) as "placementProtected",
      array(select distinct ds.source_id from reachable reach join direct_sources ds on ds.page_id=reach.id where reach.root=p.id order by ds.source_id) as "sourceIds",
      array(select distinct m.target_id from wiki_memberships m where m.page_id=p.id and m.target_kind='page' and m.snapshot->>'purpose'='subtopic' order by m.target_id) as "subtopicIds",
      (select count(*)::int-1 from descendants d where d.root=p.id) as "descendantCount",
      (select count(*)::int from wiki_memberships m where m.page_id=p.id) as "membershipCount",
      (select md5(string_agg(reach.id::text||':'||rp.current_revision_id::text,',' order by reach.id)) from reachable reach join wiki_pages rp on rp.id=reach.id where reach.root=p.id) lineage
    from selected s join wiki_pages p on p.id=s.id join wiki_page_revisions r on r.id=p.current_revision_id order by p.id`, [request.pageIds, request.sourceIds, request.after, request.limit + 1, Object.values(wikiAreaIds), [wikiAreaIds.people,wikiAreaIds.organizations,wikiAreaIds.places,wikiAreaIds.works],wikiAreaIds.entities])).rows;
  const pages: HierarchyPlacementInventory['pages'] = [];
  let bytes = 0, after = request.after, more = false;
  for (const row of rows) {
    if (pages.length === request.limit) { more = true; break; }
    const reserved=Object.values(wikiAreaIds).some(id=>id===row.pageId);
    const permitted = row.navigationArea || row.sourceIds.length > 0 && row.sourceIds.every((id: string) => allowed.includes(id));
    // Excluded metadata is not sent to the model. Missing ancestry is an explicit admission failure.
    if (!permitted) { after = row.pageId; continue; }
    const { lineage, navigationArea, ...rawMetadata } = row;
    // Reserved areas grant only their immutable destination identity, never descendant lineage.
    const metadata=navigationArea?{...rawMetadata,sourceIds:[],subtopicIds:[],descendantCount:0,membershipCount:0}:rawMetadata;
    const page = HierarchyPlacementEntrySchema.parse({ ...metadata, fingerprint: curatorHash({ ...metadata, lineage:navigationArea?row.revisionId:lineage }), canEdit: !reserved && !row.archived && request.editablePageIds.includes(row.pageId), canReceiveChildren: !row.archived && policy.operations.includes('use_scoped_destinations') });
    const size = Buffer.byteLength(JSON.stringify(page));
    if (bytes + size > request.maxBytes) { if (!pages.length) throw new Error('organization.errors.scopeLimit'); more = true; break; }
    pages.push(page); bytes += size; after = row.pageId;
  }
  if (rows.length > request.limit) more = true;
  const scopeFingerprint = curatorHash(policy.scope);
  return HierarchyPlacementInventorySchema.parse({ version: 'automatic-wiki-v1', pages, scopeFingerprint, fingerprint: curatorHash({ scopeFingerprint, pages }), nextCursor: more ? after : null });
}
