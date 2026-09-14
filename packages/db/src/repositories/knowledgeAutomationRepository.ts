import { createAutomaticMaintenanceRepository } from './automaticMaintenanceRepository.js';
import { taskHistoryVisibleSql } from './taskHistory.js';
import { WikiPageContentSchema, wikiAreaIds } from '@app/domain';
import type { PgPool } from '../client.js';
import { createWikiRepository } from './wikiRepository.js';

export function createKnowledgeAutomationRepository(pool: PgPool) {
  return {
    async acknowledgeNavigationImpacts(){
      await pool.query("update knowledge_impact_deliveries d set status='acknowledged',receipt=jsonb_build_object('kind','excluded','reason','navigation_only'),updated_at=now() from knowledge_impact_events e where e.id=d.event_id and d.status<>'acknowledged' and e.input_id=any($1::uuid[]) and e.source_ids='[]'::jsonb",[Object.values(wikiAreaIds)]);
    },
    async initializeAreas(titles: Record<keyof typeof wikiAreaIds, string>) {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        const marker = await db.query("select 1 from settings where key='knowledge.wiki-areas.v1'");
        if (marker.rows.length) { await db.query('commit'); return; }
        const wiki = createWikiRepository(pool);
        for (const [key, id] of Object.entries(wikiAreaIds)) {
          if ((await db.query('select 1 from wiki_pages where id=$1', [id])).rows.length) continue;
          await wiki.save({ id, expectedRevisionId: null, evidenceChunkIds: [], content: WikiPageContentSchema.parse({
            title: titles[key as keyof typeof titles], kind: 'collection', position: Object.keys(wikiAreaIds).indexOf(key), parentId: ['people','organizations','places','works'].includes(key) ? wikiAreaIds.entities : null,
            automatic: { version: 'automatic-wiki-v1', management: 'human_managed', role: { kind: 'collection', role: 'map', owner: null }, purpose: '', placementProtected: true, links: [], groups: [], memberships: [] }
          }) }, { transaction: db, origin: 'organization', allocatedTarget: true, humanApproved: false });
        }
        // One-time placement of existing roots. Current content and all earlier revisions survive.
        const roots = (await db.query('select p.id,p.current_revision_id,r.content from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where p.parent_id is null and not p.id=any($1::uuid[]) order by p.id', [Object.values(wikiAreaIds)])).rows;
        for (const row of roots) {
          const content = WikiPageContentSchema.parse(row.content);
          content.parentId = content.kind === 'topic' ? wikiAreaIds.themes : content.kind === 'entity' ? wikiAreaIds.entities : content.kind === 'synthesis' ? content.automatic?.role.role === 'investigation' ? wikiAreaIds.investigations : wikiAreaIds.syntheses : wikiAreaIds.maps;
          await wiki.save({ id: row.id, expectedRevisionId: row.current_revision_id, content, evidenceChunkIds: [] }, { transaction: db, origin: 'organization', allocatedTarget: false, humanApproved: true });
        }
        await db.query("insert into settings(key,value) values('knowledge.wiki-areas.v1','true')");
        await db.query('commit');
      } catch (error) { await db.query('rollback'); throw error; } finally { db.release(); }
    },
    async tasks(offset: number, attention: boolean) {
      const cte = `with tasks as (
        select id::text,'organization' kind,coalesce(snapshot->>'title',snapshot->'baseContent'->>'title',checkpoint->'proposal'->'targets'->0->>'title',snapshot->>'version') title,status,
          case when checkpoint->'supportAssessment'->'verdict'->>'supported'='false' then 'organization.errors.unsupported' else checkpoint->>'error' end reason,updated_at,snapshot->'policy'->>'id' policy_id,coalesce(snapshot->'sourceIds','[]') source_ids,snapshot->>'version' version,1 detail_count,snapshot->'policy'->>'revisionId' policy_revision_id from organization_runs
        union all select i.id::text,'organization',s.title,coalesce(i.stages_checkpoint->'organizeKnowledge'->>'status','pending'),i.stages_checkpoint->'organizeKnowledge'->'metadata'->>'deferredReason',i.updated_at,null,jsonb_build_array(s.id),'processing-batch',1,null from ingestion_runs i join source_items s on s.id=i.source_item_id where i.effective_stages ? 'organizeKnowledge' and i.stages_checkpoint->'organizeKnowledge'->'metadata'->>'organizationRunId' is null
        union all select id::text,'maintenance',coalesce(snapshot->'policy'->>'name',snapshot->'policy'->>'kind','maintenance'),status,coalesce(checkpoint->>'reason',checkpoint->>'error'),updated_at,snapshot->'policy'->>'policyId','[]',snapshot->>'version',1,snapshot->>'policyRevisionId' from maintenance_runs
        union all select id::text,'schedule',coalesce(policy->>'name',policy->>'kind'),case when retired_at is not null then 'retired' when (policy->>'enabled')::boolean then 'scheduled' else 'paused' end,last_error,next_at,policy->>'policyId','[]',policy->>'version',1,policy->>'policyRevisionId' from maintenance_schedules
        union all select min(d.id::text),'delivery',coalesce(max(s.title),'delivery'),case when bool_and(d.consumer='curator' and right(d.input_generation,36) is distinct from (select revision_id::text from wiki_policy_activations where policy_id::text=d.consumer_key order by created_at desc,id desc limit 1)) then 'superseded' when bool_or(d.status='deferred') then 'deferred' else 'pending' end,min(coalesce(case when c.checkpoint->'supportAssessment'->'verdict'->>'supported'='false' then 'organization.errors.unsupported' end,d.checkpoint->>'blockedReason',d.receipt->>'reason')),max(d.updated_at),d.consumer_key,e.source_ids,'impact',count(*)::int,right(d.input_generation,36) from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id left join source_items s on s.id::text=e.source_ids->>0 left join organization_runs c on c.id::text=d.checkpoint->>'childRunId' where d.status<>'acknowledged' or d.receipt->>'kind'='attention' group by d.consumer_key,e.source_ids,right(d.input_generation,36)
        union all select memora_id::text,'sync',relative_path,status::text,null,updated_at,null,case when source_item_id is null then '[]'::jsonb else jsonb_build_array(source_item_id) end,'obsidian',1,null from obsidian_sync_files where status::text in ('conflict','pending','local_modified','error')
      ), filtered as(select * from tasks where ${taskHistoryVisibleSql('status','updated_at')} and (not $1 or status not in('retired','applied','canceled','rejected','acknowledged') and coalesce(reason,'') not in('maintenance.errors.retainedDecision','maintenance.errors.wait','maintenance.errors.idle','maintenance.errors.busy','maintenance.errors.sync') and (reason is not null or status in ('awaiting_review','failed','conflict','local_modified'))))`;
      const rows = (await pool.query(`${cte} select *,count(*) over()::int total from filtered order by case when status in('applied','no_change','succeeded','canceled','rejected','retired') then 3 when kind='schedule' and updated_at>now() then 2 else 0 end,case when kind='schedule' then updated_at end asc,updated_at desc,id limit 51 offset $2`, [attention, offset])).rows;
      return { total: rows[0]?.total ?? 0, next: rows.length > 50 ? offset + 50 : null, tasks: await Promise.all(rows.slice(0, 50).map(async r => {const attention=r.kind==='maintenance'&&r.version==='automatic-maintenance-v1'&&r.status==='awaiting_review'?await createAutomaticMaintenanceRepository(pool).attention(r.id):null;return { id: r.id, kind: r.kind, title: r.title ?? r.kind, status: attention?.kind==='blocked'?'blocked':r.status, reason: attention?.reason??r.reason, updatedAt: new Date(r.updated_at).toISOString(), policyId: r.policy_id, sourceIds: r.source_ids, version: r.version,detailCount:r.detail_count,policyRevisionId:r.policy_revision_id };})) };
    },
    async coverage(policyId: string) {
      const r = (await pool.query("select count(*)::int total,count(*) filter(where c.status='integrated')::int integrated from source_items s left join wiki_source_coverage c on c.source_id=s.id and c.policy_id=$1", [policyId])).rows[0]!;
      return { ...r, pending: r.total - r.integrated };
    },
    async sources(policyId:string,offset:number){
      const rows=(await pool.query(`select s.id,s.title,coalesce(r.status::text,'imported') processing,
        case when c.updated_at<s.updated_at then 'stale' else coalesce(c.status,'awaiting') end wiki,
        case when not coalesce((select obsidian_sync_enabled from storage_settings limit 1),false) then 'disabled'
        when (select obsidian_vault_path from storage_settings limit 1) is null then 'unconfigured'
        when coalesce((select obsidian_sync_paused from storage_settings limit 1),false) then 'paused'
        when f.status::text in('conflict','local_modified','error') then f.status::text when f.last_synced_at>=s.updated_at then 'synced' else 'pending' end obsidian
        from source_items s left join lateral(select status from ingestion_runs where source_item_id=s.id order by created_at desc limit 1) r on true
        left join wiki_source_coverage c on c.source_id=s.id and c.policy_id=$1
        left join obsidian_sync_files f on f.memora_id=s.id
        order by s.created_at desc,s.id limit 51 offset $2`,[policyId,offset])).rows;
      return {items:rows.slice(0,50),next:rows.length>50?offset+50:null};
    },
    async assets(offset:number){const rows=(await pool.query('select a.id,a.original_file_name title,a.source_item_id as "sourceId",s.title as "sourceTitle",a.size_bytes::float bytes from document_assets a left join source_items s on s.id=a.source_item_id order by a.created_at desc,a.id limit 51 offset $1',[offset])).rows;return {items:rows.slice(0,50),next:rows.length>50?offset+50:null};},
    async deliveries(policyId:string,sourceIds:string[],offset:number,revisionId:string|null=null){const rows=(await pool.query("select d.id,e.kind title,d.status,coalesce(case when c.checkpoint->'supportAssessment'->'verdict'->>'supported'='false' then 'organization.errors.unsupported' end,d.checkpoint->>'blockedReason',d.receipt->>'reason') reason,d.updated_at,c.id related_run_id,c.snapshot->>'version' related_run_version from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id left join organization_runs c on c.id::text=d.checkpoint->>'childRunId' where d.consumer_key=$1 and e.source_ids=$2::jsonb and ($4::text is null or right(d.input_generation,36)=$4) order by d.updated_at desc,d.id limit 51 offset $3",[policyId,JSON.stringify(sourceIds),offset,revisionId])).rows;return {items:rows.slice(0,50).map(r=>({id:r.id,kind:'delivery',title:r.title,status:r.status,reason:r.reason,updatedAt:new Date(r.updated_at).toISOString(),policyId,sourceIds,version:'impact',detailCount:1,relatedRunId:r.related_run_id,relatedRunVersion:r.related_run_version})),next:rows.length>50?offset+50:null};},
    async requestInitialCoverage(policyId: string) {
      await pool.query("update maintenance_schedules set next_at=now() where policy->>'policyId'=$1 and policy->>'kind'='daily' and (policy->>'enabled')::boolean", [policyId]);
      // Stop new legacy admissions without erasing old schedules or revoking retained reviews.
      await pool.query("update maintenance_schedules set retired_at=coalesce(retired_at,now()) where policy->>'version' is distinct from 'automatic-maintenance-v1'");
    }
  };
}
