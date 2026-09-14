import { randomUUID } from 'node:crypto';
import { WikiBootstrapSchema, WikiAssessmentSchema,HierarchyRouteContinuationSchema,type CuratorRun, type WikiBootstrap, type AutomaticWikiPolicy } from '@app/domain';
import {isDeepStrictEqual} from 'node:util';
import type { PgPool, PgClient } from '../client.js';
import { createWikiCuratorRepository,curatorHash } from './wikiCuratorRepository.js';

export function createWikiCollectionRepository(pool:PgPool){
 const transaction=async<T>(fn:(db:PgClient)=>Promise<T>)=>{const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(error){await db.query('rollback');throw error;}finally{db.release();}};
 const api={
 async adoptHierarchyRoute(run:WikiBootstrap,planning:CuratorRun){return transaction(async db=>{
  const route=run.checkpoint.hierarchy!.routes.find(r=>r.planningRunId===planning.id)!;
  await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['wiki-policy:'+run.snapshot.policy.id]);
  const rows=(await db.query('select id,status,snapshot,checkpoint,updated_at::text updated from organization_runs where id=any($1::uuid[]) order by id for update',[[run.id,planning.id]])).rows;
  const parent=rows.find(r=>r.id===run.id),child=rows.find(r=>r.id===planning.id);
  if(!parent||parent.updated!==run.updatedAt||parent.checkpoint.state!=='running'||parent.checkpoint.childRunId!==planning.id||child?.status!=='failed'||child.checkpoint.callPending||!['organization.errors.scopeLimit','organization.errors.context'].includes(child.checkpoint.error)||child.checkpoint.continuedByRouteId||!isDeepStrictEqual(child.checkpoint.proposal,planning.checkpoint.proposal))throw new Error('organization.errors.conflict');
  await createWikiCuratorRepository(pool).validate(planning.snapshot,db,true);
  HierarchyRouteContinuationSchema.parse(route);
  await db.query('update organization_runs set checkpoint=$2,updated_at=clock_timestamp() where id=$1',[planning.id,{...child.checkpoint,continuedByRouteId:route.routeId}]);
  const saved=(await db.query('update organization_runs set checkpoint=$2,updated_at=clock_timestamp() where id=$1 returning updated_at::text updated',[run.id,run.checkpoint])).rows[0]!;run.updatedAt=saved.updated;
 });},
 async structuralCandidates(policy:AutomaticWikiPolicy,after:string|null,selected:string[]=[],limit=20,wide=false){
  const curator=createWikiCuratorRepository(pool),allowed=await curator.allowed(policy),sourceIds=selected.length?allowed.filter(id=>selected.includes(id)):allowed;
  const rows=(await pool.query(`select p.id,p.parent_id,p.kind,p.current_revision_id,
   exists(select 1 from jsonb_array_elements(r.content->'sections') s where length(trim(s->>'markdown'))>0) substantive,
   (select t.id from wiki_pages t where not t.archived and t.toc_owner_kind='page' and t.toc_owner_id=p.id) toc_id,
   (select t.current_revision_id from wiki_pages t where not t.archived and t.toc_owner_kind='page' and t.toc_owner_id=p.id) toc_revision_id
   from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id
   where not p.archived and p.role is distinct from 'investigation' and ($1::uuid is null or p.id>$1)
   and exists(select 1 from wiki_dependencies d where d.revision_id=p.current_revision_id and d.kind='source' and d.input_id=any($2::uuid[]))
   and ($4 or p.parent_id is null or p.kind='topic' and exists(select 1 from jsonb_array_elements(r.content->'sections') s where length(trim(s->>'markdown'))>0) and not exists(select 1 from wiki_pages t where not t.archived and t.toc_owner_kind='page' and t.toc_owner_id=p.id))
   order by p.id limit $3`,[after,sourceIds,Math.max(1,Math.min(100,limit)),wide])).rows;
  const items:Array<{pageId:string;fingerprint:string;kind:'missing_toc'|'unplaced'|'settled';sourceIds:string[];tocId:string|null}>=[];
  for(const row of rows){
   const inventory:{pages:CuratorRun['snapshot']['placement']['pages']}={pages:[]};let after:string|null=null;
   do{const part=await curator.hierarchy.inventory(policy,{pageIds:[row.id],after,limit:300,maxBytes:256000});inventory.pages.push(...part.pages);after=part.nextCursor;if(Buffer.byteLength(JSON.stringify(inventory.pages))>256000)throw new Error('organization.errors.scopeLimit');}while(after);
   const page=inventory.pages.find(p=>p.pageId===row.id);
   if(!page)continue;
   if(inventory.pages.some(p=>p.parentId&&!inventory.pages.some(a=>a.pageId===p.parentId)))throw new Error('organization.errors.scopeDecision');
   const kind=row.kind==='topic'&&row.substantive&&!row.toc_id?'missing_toc':!page.parentId?'unplaced':'settled';
   // Descendant lineage fingerprints are apply guards. Diagnostics use only this
   // branch's direct metadata, so a sibling write cannot invalidate every branch.
   const fingerprint=curatorHash({pageId:page.pageId,revisionId:page.revisionId,tocRevisionId:row.toc_revision_id,ancestry:inventory.pages.map(p=>({pageId:p.pageId,revisionId:p.revisionId,parentId:p.parentId,placementProtected:p.placementProtected,subtopicIds:p.subtopicIds})),kind});
   items.push({pageId:row.id,fingerprint,kind,sourceIds:page.sourceIds,tocId:row.toc_id??null});
  }
  return{items,after:rows.at(-1)?.id as string|null??after,done:rows.length<Math.max(1,Math.min(100,limit))};
 },
 async structuralDecision(policyId:string,pageId:string,fingerprint:string){
  return(await pool.query(`select d from organization_runs r cross join lateral jsonb_array_elements(coalesce(r.checkpoint->'hierarchy'->'decisions','[]')) d
   where r.snapshot->>'version'='wiki-bootstrap-v1' and r.snapshot->'policy'->>'id'=$1 and d->>'pageId'=$2 and d->>'fingerprint'=$3
   and d->>'outcome'<>'pending' order by r.updated_at desc limit 1`,[policyId,pageId,fingerprint])).rows[0]?.d as NonNullable<WikiBootstrap['checkpoint']['hierarchy']>['decisions'][number]|undefined;
 },
 async assessment(policy:AutomaticWikiPolicy,after:string|null,limit:number,selected:string[]=[],generation=''){
  const allowed=await createWikiCuratorRepository(pool).allowed(policy),scope=selected.length?allowed.filter(id=>selected.includes(id)):allowed;
  const cte=`with inventory as(select s.id,s.title,
   (select count(*)::int from chunks c join documents d on d.id=c.document_id where c.source_item_id=s.id and d.metadata->>'supersededByDocumentId' is null and c.chunking_version<>'catalog-metadata-v1' and c.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'processingMode' is distinct from 'catalog_metadata') originals,
   (select count(*)::int from atomic_notes n where n.created_from_source_item_id=s.id and n.supersession_status='current' and n.status not in('rejected','archived')) notes,
   (select count(*)::int from source_summaries x where x.source_item_id=s.id and x.is_current) summaries,
   (select count(*)::int from (select target_type,target_id,chunk_id from embeddings_256 union all select target_type,target_id,chunk_id from embeddings_768 union all select target_type,target_id,chunk_id from embeddings_1024) v left join chunks vc on vc.id=v.chunk_id where (v.target_type='source_item' and v.target_id=s.id or vc.source_item_id=s.id)) vectors,
   (select count(*)::int from source_relations r where (r.source_item_id=s.id or r.target_source_item_id=s.id) and r.status<>'rejected') relations,
   (select count(distinct p.id)::int from wiki_dependencies d join wiki_pages p on p.current_revision_id=d.revision_id where d.kind='source' and d.input_id=s.id and not p.archived) pages,
   (select count(distinct p.id)::int from wiki_dependencies d join wiki_pages p on p.current_revision_id=d.revision_id where d.kind='source' and d.input_id=s.id and not p.archived and p.management<>'ai_managed') "protectedPages",
   md5($3::text||(select id::text from wiki_policy_revisions where policy_id=$1 order by created_at desc limit 1)||s.title||coalesce(s.metadata->'descriptor','{}')::text||coalesce((select string_agg(c.id::text||c.content_hash,',' order by c.id) from chunks c join documents d on d.id=c.document_id where c.source_item_id=s.id and d.metadata->>'supersededByDocumentId' is null),'')||coalesce((select string_agg((to_jsonb(n)-'updated_at'-'created_at')::text||coalesce((select jsonb_agg(to_jsonb(l)-'created_at'-'updated_at' order by l.id)::text from atomic_note_source_links l where l.atomic_note_id=n.id),''),',' order by n.id) from atomic_notes n where n.created_from_source_item_id=s.id),'')) fingerprint,
   cv.input_fingerprint previous,cv.status,coalesce((cv.checkpoint->>'covered')::int,0) covered
   from source_items s left join wiki_source_coverage cv on cv.source_id=s.id and cv.policy_id=$1 where s.id=any($2::uuid[])), assessed as(select *,case when previous is not null and previous<>fingerprint then 'stale' when status is not null then status when originals=0 then 'cataloged' else 'awaiting' end coverage from inventory)`;
  const rows=(await pool.query(`${cte} select id,title,originals,notes,summaries,vectors,relations,pages,"protectedPages",fingerprint,coverage,covered from assessed where ($4::uuid is null or id>$4) order by id limit $5`,[policy.id,scope,generation,after,limit+1])).rows;
  const totals=(await pool.query(`${cte} select count(*)::int sources,coalesce(sum(originals),0)::int originals,count(*) filter(where coverage='cataloged')::int cataloged,count(*) filter(where coverage='integrated')::int integrated,count(*) filter(where coverage in('attention','stale'))::int attention from assessed`,[policy.id,scope,generation])).rows[0];
  return WikiAssessmentSchema.parse({policyId:policy.id,policyRevisionId:policy.revisionId,sources:rows.slice(0,limit),next:rows.length>limit?rows[limit-1]!.id:null,totals,groupOriginalLimit:Math.min(6,policy.limits.originalPassages),readOnly:true});
 },
 async bootstrap(snapshot:WikiBootstrap['snapshot']){return transaction(async db=>{await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['wiki-bootstrap:'+snapshot.policy.id]);const old=(await db.query("select id from organization_runs where snapshot->>'version'='wiki-bootstrap-v1' and snapshot->'policy'->>'id'=$1 and status in('queued','analyzing') and snapshot->'sourceIds'=$2::jsonb and snapshot->'profile'=$3::jsonb and snapshot->'promptPin'=$4::jsonb and snapshot->>'contentLanguage'=$5 and snapshot->'policy'->>'revisionId'=$6 and snapshot->'noteIds'=$7::jsonb and coalesce((snapshot->>'includeExistingNotes')::boolean,false)=$8 order by created_at desc limit 1",[snapshot.policy.id,JSON.stringify(snapshot.sourceIds),JSON.stringify(snapshot.profile),JSON.stringify(snapshot.promptPin),snapshot.contentLanguage,snapshot.policy.revisionId,JSON.stringify(snapshot.noteIds),snapshot.includeExistingNotes])).rows[0];if(old)return old.id as string;
  const id=randomUUID(),checkpoint:WikiBootstrap['checkpoint']={version:'wiki-bootstrap-v1',afterNote:null,nextNote:null,lastTickAt:null,phase:'originals',hierarchy:null,contentComplete:false,notesComplete:false,noteCursor:0,state:'running',afterSource:null,sourceId:null,sourceFingerprint:null,afterChunk:null,nextChunk:null,childRunId:null,pendingOriginals:0,sourceCovered:0,completedSources:0,catalogedSources:0,completedGroups:0,attentionSources:0,error:null};await db.query('insert into organization_runs(id,snapshot,checkpoint) values($1,$2,$3)',[id,snapshot,checkpoint]);return id;});},
 async discoveryCovered(policy:AutomaticWikiPolicy,sourceIds:string[],generation:string){
  if(!sourceIds.length)return false;
  const assessment=await api.assessment(policy,null,sourceIds.length,sourceIds,generation);
  if(assessment.totals.sources!==sourceIds.length||assessment.sources.some(s=>!['integrated','cataloged'].includes(s.coverage)))return false;
  // Unseen catalog sources still need their first persisted coverage record.
  const count=(await pool.query("select count(*)::int n from wiki_source_coverage where policy_id=$1 and source_id=any($2::uuid[]) and status in('integrated','cataloged')",[policy.id,sourceIds])).rows[0].n;
  const structure=await api.structuralCandidates(policy,null,sourceIds,20);
  return count===sourceIds.length&&!(await createWikiCuratorRepository(pool).unplacedNotes(sourceIds,null,1)).length&&structure.done&&!structure.items.length;
 },
 async settled(policy:AutomaticWikiPolicy,generation:string){
  const curator=createWikiCuratorRepository(pool),sourceIds=await curator.allowed(policy);
  if(!sourceIds.length)return true;
  const assessment=await api.assessment(policy,null,1,[],generation);
  if(assessment.totals.sources!==assessment.totals.integrated+assessment.totals.cataloged)return false;
  const persisted=(await pool.query("select count(*)::int n from wiki_source_coverage where policy_id=$1 and source_id=any($2::uuid[]) and status in('integrated','cataloged')",[policy.id,sourceIds])).rows[0]!.n;
  if(persisted!==sourceIds.length||(await curator.unplacedNotes(sourceIds,null,1)).length)return false;
  const structure=await api.structuralCandidates(policy,null,sourceIds,20);
  return structure.done&&!structure.items.length;
 },
 async exhaustedAttention(policy:AutomaticWikiPolicy){return(await pool.query(`select d.id,d.checkpoint,d.receipt,e.kind,e.input_id,e.source_ids,b.id bootstrap_id
  from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id
  join organization_runs b on b.id::text=coalesce(d.checkpoint->>'bootstrapId',d.receipt->>'runId')
  where d.consumer='curator' and d.consumer_key=$1 and right(d.input_generation,36)=$2 and d.receipt->>'kind'='attention'
  and b.snapshot->>'version'='wiki-bootstrap-v1' and b.snapshot->'sourceIds'=e.source_ids
  and b.checkpoint->>'state'='attention' and b.checkpoint->>'childRunId' is null
  and b.checkpoint->>'error' in('maintenance.errors.budget','maintenance.errors.period','organization.errors.deadline')
  order by d.created_at,d.id limit 20`,[policy.id,policy.revisionId])).rows;},
 async acknowledgeCoveredAttention(policy:AutomaticWikiPolicy,id:string,bootstrapId:string){return transaction(async db=>{
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['wiki-policy:'+policy.id]);
  const current=(await db.query('select state,revision_id from wiki_policy_activations where policy_id=$1 order by created_at desc,id desc limit 1',[policy.id])).rows[0];
  if(current?.state!=='enabled'||current.revision_id!==policy.revisionId)return;
  await db.query(`update knowledge_impact_deliveries d set status='acknowledged',lease_until=null,defer_until=null,
   receipt=jsonb_build_object('kind','inspected','reason','coverage_current','previousAttention',d.receipt,'runId',b.id),updated_at=clock_timestamp()
   from organization_runs b where d.id=$1 and b.id=$2 and d.consumer_key=$3 and d.receipt->>'kind'='attention'
   and coalesce(d.checkpoint->>'bootstrapId',d.receipt->>'runId')=b.id::text
   and b.checkpoint->>'state'='attention' and b.checkpoint->>'childRunId' is null
   and b.checkpoint->>'error' in('maintenance.errors.budget','maintenance.errors.period','organization.errors.deadline')`,[id,bootstrapId,policy.id]);
 });},
 async get(id:string){const row=(await pool.query("select id,status,snapshot,checkpoint,created_at as \"createdAt\",updated_at::text as \"updatedAt\" from organization_runs where id=$1 and snapshot->>'version'='wiki-bootstrap-v1'",[id])).rows[0];return row?WikiBootstrapSchema.parse({...row,createdAt:row.createdAt.toISOString(),updatedAt:typeof row.updatedAt==='string'?row.updatedAt:row.updatedAt.toISOString()}):null;},
 async list(policyId?:string,after?:string){const ids=(await pool.query("select r.id from organization_runs r where r.snapshot->>'version'='wiki-bootstrap-v1' and ($1::text is null or r.snapshot->'policy'->>'id'=$1) and ($2::uuid is null or (r.checkpoint->>'state' in('running','paused','attention'),r.created_at,r.id)<(select checkpoint->>'state' in('running','paused','attention'),created_at,id from organization_runs where id=$2)) order by (r.checkpoint->>'state' in('running','paused','attention')) desc,r.created_at desc,r.id desc limit 50",[policyId??null,after??null])).rows;return Promise.all(ids.map(async r=>(await api.get(r.id))!));},
 async active(){const ids=(await pool.query("select id from organization_runs where snapshot->>'version'='wiki-bootstrap-v1' and checkpoint->>'state'='running' order by (checkpoint->>'lastTickAt')::timestamptz nulls first,created_at,id limit 10")).rows;return Promise.all(ids.map(async r=>(await api.get(r.id))!));},
 async reconcileAppliedChildren(policy:AutomaticWikiPolicy){return transaction(async db=>{
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['wiki-policy:'+policy.id]);
  const activation=(await db.query('select state,revision_id from wiki_policy_activations where policy_id=$1 order by created_at desc,id desc limit 1',[policy.id])).rows[0];
  if(activation?.state!=='enabled'||activation.revision_id!==policy.revisionId)return [] as string[];
  // Applying a retained proposal can finish after the collection observed its
  // review state. Reopen only that exact wait; the normal cursor consumes the
  // existing receipt once, without repeating the completed model calls.
  const resumed=(await db.query(`update organization_runs b set status='analyzing',
   checkpoint=b.checkpoint||'{"state":"running","error":null}'::jsonb,updated_at=clock_timestamp()
   from organization_runs child where b.snapshot->>'version'='wiki-bootstrap-v1'
   and b.snapshot->'policy'->>'id'=$1 and b.snapshot->'policy'->>'revisionId'=$2
   and b.status in('analyzing','awaiting_review','failed') and b.checkpoint->>'state'='attention'
   and b.checkpoint->>'error'='organization.errors.review'
   and child.id::text=b.checkpoint->>'childRunId' and child.snapshot->>'parentBootstrapId'=b.id::text
   and child.snapshot->'policy'->>'revisionId'=$2 and child.status='applied'
   and exists(select 1 from wiki_group_receipts g where g.run_id=child.id)
   and (child.snapshot->>'maintenanceRunId' is null or exists(select 1 from maintenance_runs m
     where m.id::text=child.snapshot->>'maintenanceRunId' and m.status in('queued','inspecting','analyzing','awaiting_review')))
   returning b.id`,[policy.id,policy.revisionId])).rows.map(r=>r.id as string);
  if(resumed.length)await db.query(`update knowledge_impact_deliveries d set status='deferred',receipt=null,
   checkpoint=d.checkpoint||'{"blockedReason":null}'::jsonb,lease_until=null,defer_until=null,updated_at=clock_timestamp()
   where d.consumer='curator' and d.consumer_key=$1 and right(d.input_generation,36)=$2
   and coalesce(d.checkpoint->>'bootstrapId',d.receipt->>'runId')=any($3::text[])
   and d.receipt->>'kind'='attention' and coalesce(d.receipt->>'reason','organization.errors.review')='organization.errors.review'`,[policy.id,policy.revisionId,resumed]);
  return resumed;
 });},
 async checkpoint(run:WikiBootstrap){const row=(await pool.query("update organization_runs set checkpoint=$2,status=$3,updated_at=clock_timestamp() where id=$1 and status not in('canceled','rejected') and updated_at=$4::timestamptz returning updated_at::text as updated",[run.id,run.checkpoint,run.checkpoint.state==='complete'?'applied':run.checkpoint.state==='canceled'?'canceled':run.checkpoint.state==='rejected'?'rejected':run.checkpoint.state==='attention'?'failed':'analyzing',run.updatedAt])).rows[0];if(!row)throw new Error('organization.errors.conflict');run.updatedAt=row.updated;},
 async finishCoverage(runId:string){await pool.query("update wiki_source_coverage set status='integrated',updated_at=clock_timestamp() where run_id=$1 and status='partial'",[runId]);},
 async coverage(policyId:string,sourceId:string,fingerprint:string,status:string,covered:number,runId:string){await pool.query('insert into wiki_source_coverage(policy_id,source_id,input_fingerprint,status,checkpoint,run_id) values($1,$2,$3,$4,$5,$6) on conflict(policy_id,source_id) do update set input_fingerprint=excluded.input_fingerprint,status=excluded.status,checkpoint=excluded.checkpoint,run_id=excluded.run_id,updated_at=clock_timestamp()',[policyId,sourceId,fingerprint,status,{covered},runId]);},
 async reconcileDeliveries(policy:AutomaticWikiPolicy){
  // A bounded high-water reconciliation ignores the legacy global acknowledgment.
  await pool.query(`insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation) select e.id,'curator',$1,e.fingerprint||':'||$2 from knowledge_impact_events e where e.created_at<=clock_timestamp() and not exists(select 1 from knowledge_impact_deliveries d where d.event_id=e.id and d.consumer='curator' and d.consumer_key=$1 and d.input_generation=e.fingerprint||':'||$2) order by e.created_at,e.id limit 100 on conflict do nothing`,[policy.id,policy.revisionId]);
 },
 async claimDelivery(policyId:string){return transaction(async db=>{const row=(await db.query("select d.*,e.created_at as event_created_at,e.kind,e.operation,e.input_id,e.fingerprint,e.source_ids,e.causal_run_id,e.causal_group_id from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id where d.consumer='curator' and d.consumer_key=$1 and (d.status='pending' or d.status='deferred' and (d.defer_until is null or d.defer_until<=now()) or d.status='leased' and d.lease_until<now()) order by (d.checkpoint->>'blockedReason' is not null),e.created_at,e.id limit 1 for update of d skip locked",[policyId])).rows[0];if(!row)return null;await db.query("update knowledge_impact_deliveries set status='leased',lease_until=now()+interval '30 seconds',updated_at=now() where id=$1",[row.id]);return row;});},
 async delivery(id:string,checkpoint:unknown,receipt:unknown|null,deferMs=2000){await pool.query("update knowledge_impact_deliveries set checkpoint=$2,receipt=$3,status=case when $3::jsonb is null then 'deferred' else 'acknowledged' end,defer_until=now()+($4::int * interval '1 millisecond'),lease_until=null,updated_at=now() where id=$1",[id,checkpoint,receipt,deferMs]);},
 async dependents(kind:string,inputId:string,after:string|null,limit=20){return(await pool.query(`select p.id,p.current_revision_id as revision_id,array(select distinct s.input_id from wiki_dependencies s where s.revision_id=p.current_revision_id and s.kind='source') source_ids
  from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where not p.archived and p.role is distinct from 'investigation' and ($3::uuid is null or p.id>$3)
  and (exists(select 1 from wiki_dependencies d where d.revision_id=p.current_revision_id and d.kind=$1 and d.input_id=$2 and d.stale_reason is not null)
   or (($1='source' and not exists(select 1 from source_items where id=$2)
    or $1='atomic_note' and not exists(select 1 from atomic_notes where id=$2 and status not in('rejected','archived'))
    or $1='wiki_page' and not exists(select 1 from wiki_pages where id=$2 and not archived)
    or $1='entity' and not exists(select 1 from entities where id=$2)) and (exists(select 1 from wiki_memberships m where m.page_id=p.id and m.target_kind=case when $1='wiki_page' then 'page' else $1 end and m.target_id=$2)
   or exists(select 1 from jsonb_array_elements(coalesce(r.content->'automatic'->'links','[]')) l where l->>'kind'=case when $1='wiki_page' then 'page' else $1 end and l->>'id'=$2::text)
   or p.toc_owner_kind=case when $1='wiki_page' then 'page' else $1 end and p.toc_owner_id=$2)))
  order by p.id limit $4`,[kind,inputId,after,limit])).rows;},
 async removalPeers(pageId:string){return(await pool.query(`select id,current_revision_id revision_id from wiki_pages where not archived and id<>$1 and (toc_owner_kind='page' and toc_owner_id=$1 or id=(select toc_owner_id from wiki_pages where id=$1 and toc_owner_kind='page')) order by id limit 3`,[pageId])).rows;},
 async enabledAt(policyId:string,revisionId:string){return(await pool.query("select min(created_at) at from wiki_policy_activations where policy_id=$1 and revision_id=$2 and state='enabled'",[policyId,revisionId])).rows[0]?.at as Date|null;},
 async currentWikiEvent(kind:string,inputId:string,fingerprint:string){if(kind!=='wiki_section')return true;return(await pool.query("select exists(select 1 from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id cross join lateral jsonb_array_elements(r.content->'sections') sec where sec->>'id'=$1 and md5(sec::text)=$2) current",[inputId,fingerprint])).rows[0]!.current as boolean;},
 async causalApplied(causalRunId:string,pageId:string){return(await pool.query("select exists(select 1 from wiki_group_receipts g join organization_runs r on r.id=g.run_id where (r.id=$1 or r.snapshot->>'causalRunId'=$1::text) and g.targets @> jsonb_build_array(jsonb_build_object('pageId',$2::text))) applied",[causalRunId,pageId])).rows[0]!.applied as boolean;},
 async inputGeneration(sourceIds:string[],extra:string|null){return(await pool.query(`select md5(jsonb_build_object(
 'originals',(select jsonb_agg(jsonb_build_array(c.id,c.content_hash) order by c.id) from chunks c join documents d on d.id=c.document_id where c.source_item_id=any($1::uuid[]) and d.metadata->>'supersededByDocumentId' is null),
 'sources',(select jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'descriptor',s.metadata->'descriptor') order by s.id) from source_items s where s.id=any($1::uuid[])),
 'notes',(select jsonb_agg((to_jsonb(n)-'updated_at'-'created_at')||jsonb_build_object('links',(select jsonb_agg(to_jsonb(l)-'created_at'-'updated_at' order by l.id) from atomic_note_source_links l where l.atomic_note_id=n.id)) order by n.id) from atomic_notes n where n.created_from_source_item_id=any($1::uuid[])),
 'summaries',(select jsonb_agg(to_jsonb(s)-'updated_at'-'created_at' order by s.id) from source_summaries s where s.source_item_id=any($1::uuid[]) and s.is_current),
 'relations',(select jsonb_agg(to_jsonb(r)-'updated_at'-'created_at' order by r.id) from source_relations r where r.source_item_id=any($1::uuid[]) and r.target_source_item_id=any($1::uuid[])),
 'consumedWiki',$2::text)::text) generation`,[sourceIds,extra??''])).rows[0]!.generation as string;},
 async sourceBusy(sourceIds:string[]){return(await pool.query("select exists(select 1 from ingestion_runs r where r.source_item_id=any($1::uuid[]) and (r.status in('pending','running') or exists(select 1 from ingestion_run_stages s where s.ingestion_run_id=r.id and s.stage<>'organizeKnowledge' and s.status in('pending','running','waiting_for_review')))) busy",[sourceIds])).rows[0]!.busy as boolean;}
 };return api;
}
