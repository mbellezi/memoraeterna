import { LibraryResetService } from '../apps/desktop/src/main/services/library-reset-service.js';
import { PromptService } from '../apps/desktop/src/main/services/prompt-service.js';
import { WikiCurator } from '../apps/desktop/src/main/services/wiki-curator.js';
import { buildObsidianMirror } from "../apps/desktop/src/main/services/obsidian-mirror.js";
import { curatorSampleSnapshot,curatorSampleCheckpoint } from "../apps/desktop/src/main/services/prompt-samples.js";
import { defaultPromptPin } from "../apps/desktop/src/main/services/prompt-runtime.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAiConfigRepository, createJobRepository, createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations, createWikiRepository, createAutomaticMaintenanceRepository, createSettingsRepository, createKnowledgeAutomationRepository,createOrganizationRepository,createWikiCuratorRepository } from '../packages/db/src/index.js';
import { SourceJourneySchema, CuratorChangeSetSchema, CuratorPreviewSchema, AutomaticWikiPolicySchema, WikiPageContentSchema, wikiAreaIds, knowledgeAutomationPolicyKey } from '@app/domain';
import { KnowledgeAutomation } from '../apps/desktop/src/main/services/knowledge-automation.js';
import { AutomaticMaintenance } from '../apps/desktop/src/main/services/automatic-maintenance.js';
import { createWikiCollectionRepository } from '../packages/db/src/repositories/wikiCollectionRepository.js';
import { createWikiImpactReconciliationRepository } from '../packages/db/src/repositories/wikiImpactReconciliationRepository.js';

const root=resolve(import.meta.dirname,'..'),work=await mkdtemp(join(tmpdir(),'memora-automation-'));
const paths=resolvePostgresSidecarPaths({cwd:root,env:process.env});
const manager=new PostgresSidecarManager({binDir:paths.binDir,dataDir:join(work,'data'),database:'automation',user:'automation',password:randomUUID()});
let db:ReturnType<typeof createPgPool>|undefined;
try {
  const connection=await manager.start();db=createPgPool({connectionString:connection.connectionString,max:8});
  await runMigrations(db,join(root,'packages/db/drizzle'),{seedFolder:join(root,'packages/db/seed')});
  const wiki=createWikiRepository(db),section={id:randomUUID(),title:'Human text',markdown:'Keep this exact human statement.',protected:true};
  const old=await wiki.save({expectedRevisionId:null,evidenceChunkIds:[],content:WikiPageContentSchema.parse({title:'Existing topic',kind:'topic',sections:[section]})});
  const before=await wiki.get(old);
  let configured=false;
  const ai={pinOrganizationProfile:async()=>{if(configured)return curatorSampleSnapshot(defaultPromptPin()).profile;throw new Error('organization.errors.model');},runOrganizationTask:async()=>{throw new Error('Unexpected inference');}};
  const options={getPool:()=>db!,ai,contentLanguage:async()=>'pt-BR',wake:()=>{},cancelJob:async()=>{}};
  const automation=new KnowledgeAutomation(options);
  const id=await automation.initialize();
  assert.deepEqual(await createSettingsRepository(db).get(knowledgeAutomationPolicyKey),{policyId:id});
  const after=await wiki.get(old);assert.equal(after!.parentId,wikiAreaIds.themes);assert.deepEqual(after!.sections,before!.sections);
  assert.equal((await wiki.history(old)).length,2);
  assert.equal((await wiki.get(wikiAreaIds.themes))!.title,'Temas');
  assert.equal((await createAutomaticMaintenanceRepository(db).schedules(id)).filter(s=>s.policy.enabled).length,4);
  const revision=after!.revisionId;
  assert.equal(await automation.initialize(),id);assert.equal((await wiki.get(old))!.revisionId,revision);
  await new AutomaticMaintenance(options).tick();
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,0);
  const dashboard=await automation.dashboard(0,'all');assert.equal(dashboard.ready,false);assert.ok(dashboard.tasks.some(t=>t.kind==='schedule'&&t.reason==='organization.errors.model'));
  const mirror=await buildObsidianMirror(db,'Memora',{sourceIds:[],pageIds:[],includeDescendants:true},{version:2,language:'pt-BR',attachments:'omit'});
  assert.equal(mirror.find(target=>target.id===wikiAreaIds.themes)!.path,'Memora/Wiki/Temas/Índice.md');
  assert.ok(mirror.find(target=>target.id===old)!.path.startsWith('Memora/Wiki/Temas/'));
  assert.ok(mirror.find(target=>target.id===old)!.editorial.includes(section.markdown));
  const fresh=await wiki.save({expectedRevisionId:null,evidenceChunkIds:[],content:WikiPageContentSchema.parse({title:'Later topic',kind:'topic'})});
  assert.equal((await wiki.get(fresh))!.parentId,wikiAreaIds.themes);
  // Multi-target curators allocate page rows before writing the first revision.
  const allocated=randomUUID(),writer=await db.connect();
  try{await writer.query('begin');await writer.query("insert into wiki_pages(id,title,kind) values($1,'Allocated topic','topic')",[allocated]);
    await wiki.save({id:allocated,expectedRevisionId:null,evidenceChunkIds:[],content:WikiPageContentSchema.parse({title:'Allocated topic',kind:'topic'})},{transaction:writer,origin:'organization',allocatedTarget:true,humanApproved:false});await writer.query('commit');
  }catch(error){await writer.query('rollback');throw error;}finally{writer.release();}
  assert.equal((await wiki.get(allocated))!.parentId,wikiAreaIds.themes);
  // Query paging must not hide older blocked work behind terminal history.
  await db.query("insert into knowledge_impact_events(kind,input_id,fingerprint,source_ids,operation) select 'wiki_page',gen_random_uuid(),'fixture','[]','updated' from generate_series(1,65)");
  await db.query("insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,checkpoint) select id,'curator',$1,id::text||':'||$2,'deferred','{\"blockedReason\":\"maintenance.errors.budget\"}' from knowledge_impact_events where fingerprint='fixture'",[id,(await createWikiCuratorRepository(db).policy(id))!.revisionId]);
  const tasks=createKnowledgeAutomationRepository(db);const grouped=await tasks.tasks(0,true);assert.ok(grouped.tasks.some(t=>t.kind==='delivery'&&t.detailCount>=65));const page1=await tasks.deliveries(id,[],0),page2=await tasks.deliveries(id,[],page1.next!);
  assert.equal(page1.items.length,50);assert.ok(page2.items.length>=15);assert.equal(new Set([...page1.items,...page2.items].map(t=>t.kind+t.id)).size,page1.items.length+page2.items.length);
  configured=true;
  await new AutomaticMaintenance(options).tick();
  const scheduled=await createAutomaticMaintenanceRepository(db).schedules(id);
  assert.ok(scheduled.some(s=>s.lastRunId!==null));
  const admitted=(await createAutomaticMaintenanceRepository(db).active(id))[0]!;
  assert.ok(admitted.snapshot.profile);
  await createAutomaticMaintenanceRepository(db).capacity(admitted.id,10000,10000000);
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,0);
  const org=createOrganizationRepository(db),currentPolicy=await createWikiCuratorRepository(db).policy(id);
  const sample={...curatorSampleSnapshot(defaultPromptPin()),policy:currentPolicy!,maintenanceRunId:admitted.id};
  const admissions=await Promise.allSettled(['first','second'].map(inputFingerprint=>org.create({...sample,inputFingerprint},curatorSampleCheckpoint())));
  assert.equal(admissions.filter(result=>result.status==='fulfilled').length,1);
  const denied=admissions.find(result=>result.status==='rejected');assert.ok(denied?.status==='rejected'&&String(denied.reason).includes('maintenance.errors.wait'));
  const index=admissions.findIndex(result=>result.status==='fulfilled'),winner=admissions[index]!;
  assert.equal(await org.create({...sample,inputFingerprint:['first','second'][index]},curatorSampleCheckpoint()),winner.status==='fulfilled'?winner.value:null);
  // Shared ceiling edits keep the same ledger and admitted snapshots, even during work.
  const maintenance=createAutomaticMaintenanceRepository(db);
  const expected=(await maintenance.schedules(id)).map(({id,revision})=>({id,revision}));
  const admittedSnapshot=(await maintenance.get(admitted.id))!.snapshot;
  const oldSchedules=await maintenance.schedules(id);
  await new AutomaticMaintenance(options).command({command:'automaticBudgetSave',policyId:id,expectedSchedules:expected,allowance:{calls:1,tokens:3000}});
  assert.ok((await maintenance.schedules(id)).every(s=>s.policy.monthAllowance.calls===1));
  assert.deepEqual((await maintenance.schedules(id)).map(s=>[s.id,s.nextAt,s.policy.enabled]),oldSchedules.map(s=>[s.id,s.nextAt,s.policy.enabled]));
  await assert.rejects(maintenance.saveMonthly(id,expected,{calls:9,tokens:9000}),/maintenance.errors.conflict/);
  admitted.status='inspecting';admitted.checkpoint.reason=null;admitted.checkpoint.lastTickAt=new Date().toISOString();admitted.updatedAt=new Date().toISOString();await maintenance.checkpoint(admitted);
  const childId=winner.status==='fulfilled'?winner.value:'';
  await maintenance.reserve(admitted.id,childId,1,1000);
  await maintenance.reserve(admitted.id,childId,1,1000);
  const month=new Date().toISOString().slice(0,7);
  assert.deepEqual(await maintenance.monthly(id,month),{calls:1,tokens:1000,spend:null});
  await maintenance.capacity(admitted.id,1000,10000000);
  const record=async(sequence:number,inputTokens:number)=>createAiConfigRepository(db!).recordTaskRun({organizationRunId:childId,organizationStep:sequence,taskType:'structured-output',provider:'synthetic',modelId:'fixture',runtime:'test',parameters:{},durationMs:1,status:'succeeded',inputTokens,outputTokens:0});
  assert.deepEqual(await maintenance.measured(id,month),{calls:0,tokens:0,spend:null,incomplete:false});
  await record(1,3000);
  await maintenance.capacity(admitted.id,1000,10000000); // Exactly at the limit still permits a call.
  await maintenance.reserve(admitted.id,childId,2,1000);
  await record(2,1); // This completed call crosses the limit; only the next call is blocked.
  assert.deepEqual(await maintenance.measured(id,month),{calls:2,tokens:3001,spend:null,incomplete:false});
  await assert.rejects(maintenance.reserve(admitted.id,childId,3,1),/maintenance.errors.period/);
  const revised=(await maintenance.schedules(id)).map(({id,revision})=>({id,revision}));
  const simultaneous=await Promise.allSettled([3,4].map(calls=>maintenance.saveMonthly(id,revised,{calls,tokens:5000})));
  assert.equal(simultaneous.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(simultaneous.some(r=>r.status==='rejected'&&String(r.reason).includes('maintenance.errors.conflict')));
  await maintenance.capacity(admitted.id,1,1000);await maintenance.reserve(admitted.id,childId,2,1000);
  assert.deepEqual(await maintenance.monthly(id,month),{calls:2,tokens:2000,spend:null});
  assert.deepEqual((await maintenance.get(admitted.id))!.snapshot,admittedSnapshot);
  const shared=(await maintenance.schedules(id))[0]!.policy.monthAllowance;
  const changedScope={...currentPolicy!,revisionId:randomUUID(),scope:{...currentPolicy!.scope,wholeLibrary:false,sourceIds:[randomUUID()]}};
  const nextPreview=await maintenance.preview(changedScope,'Europe/London');
  assert.ok(nextPreview.routines.every(r=>r.policy.monthAllowance.calls===shared.calls));
  await maintenance.saveMonthly(id,(await maintenance.schedules(id)).map(({id,revision})=>({id,revision})),{calls:0,tokens:0});
  await assert.rejects(maintenance.capacity(admitted.id,1,1),/maintenance.errors.period/);
  assert.deepEqual(await maintenance.monthly(id,month),{calls:2,tokens:2000,spend:null});
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,2);
  // A curator edit preserves a paused policy and cannot undo a newer monthly edit.
  await createWikiCuratorRepository(db).pause(id);
  const curator=new WikiCurator(options),input={policyId:id,wholeLibrary:true,sourceIds:[],limits:{...currentPolicy!.limits,modelCalls:4,repairs:1},timezone:'Europe/London'};
  const stale=CuratorPreviewSchema.parse(await curator.command({command:'preview',input}));
  await maintenance.saveMonthly(id,(await maintenance.schedules(id)).map(({id,revision})=>({id,revision})),{calls:5,tokens:9000});
  await assert.rejects(curator.command({command:'activate',policyId:id,revisionId:stale.policy.revisionId,previewHash:stale.previewHash,state:'paused'}),/maintenance.errors.conflict/);
  const edited=CuratorPreviewSchema.parse(await curator.command({command:'preview',input}));
  const activated=AutomaticWikiPolicySchema.parse(await curator.command({command:'activate',policyId:id,revisionId:edited.policy.revisionId,previewHash:edited.previewHash,state:'paused'}));
  assert.equal(activated.state,'paused');assert.equal(activated.limits.modelCalls,4);
  assert.ok((await maintenance.schedules(id)).every(s=>s.policy.monthAllowance.calls===5));
  assert.deepEqual(await maintenance.monthly(id,month),{calls:2,tokens:2000,spend:null});
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,2);
  // Project historical waiting states into actual human review versus a blocked analysis.
  const issue={path:'targets.0.sections.0.markdown',message:'The source does not identify students.'};
  const candidate=CuratorChangeSetSchema.parse({version:'automatic-wiki-v1',groupId:randomUUID(),policyRevisionId:activated.revisionId,explanation:'Fixture',targets:[{handle:'new_fixture',pageId:null,expectedRevisionId:null,title:'Fixture',purpose:'Fixture',role:{kind:'topic',role:'topic'},initialParent:null,sections:[{sectionId:null,expectedSectionRevisionId:null,title:'Fixture',markdown:'Original statement.',originalHandles:['e1']}],links:[],tocGroups:[]}]});
  await db.query("update organization_runs set status='failed',checkpoint=$2,updated_at=clock_timestamp() where id=$1",[childId,{...curatorSampleCheckpoint(),proposal:candidate,error:'organization.errors.evidence',validationIssues:[issue],supportAssessment:{proposalHash:'fixture',aiTaskRunId:randomUUID(),verdict:{supported:false,checkedTargets:['new_fixture'],issues:[issue]}}}]);
  await db.query("update maintenance_runs set status='awaiting_review',checkpoint=jsonb_set(jsonb_set(checkpoint,'{reviewChildId}',to_jsonb($2::text)),'{reason}','\"organization.errors.evidence\"'),updated_at=clock_timestamp() where id=$1",[admitted.id,childId]);
  const blocked=await maintenance.attention(admitted.id);assert.equal(blocked!.kind,'blocked');assert.equal(blocked!.childRunId,childId);assert.equal(blocked!.reason,'organization.errors.unsupported');assert.deepEqual(blocked!.issues,[issue]);
  assert.ok((await tasks.tasks(0,true)).tasks.some(t=>t.id===admitted.id&&t.status==='blocked'));
  await db.query("update organization_runs set status='awaiting_review',checkpoint=$2 where id=$1",[childId,{...curatorSampleCheckpoint(),proposal:candidate,supportAssessment:{proposalHash:'fixture',aiTaskRunId:randomUUID(),verdict:{supported:true,checkedTargets:['new_fixture'],issues:[]}}}]);
  assert.equal((await maintenance.attention(admitted.id))!.kind,'review');
  // A legacy attention receipt can point to a childless bootstrap whose previous
  // occurrence ran out of capacity. This is not a human-review proposal and must
  // not block a later authorized occurrence with its own allowance.
  const budgetBootstrap=randomUUID();
  await db.query("insert into organization_runs(id,status,snapshot,checkpoint) values($1,'failed',$2,$3)",[budgetBootstrap,{version:'wiki-bootstrap-v1'}, {state:'attention',error:'maintenance.errors.budget',childRunId:null}]);
  const copyOccurrence=async(status:string,checkpoint:unknown)=>(await db!.query(`with j as(insert into jobs(type,payload) values('maintenance','{}') returning id) insert into maintenance_runs(job_id,scope_key,period,schedule_ids,snapshot,checkpoint,reservation,status)
    select (select id from j),scope_key,period,'[]',jsonb_set(snapshot,'{policyRevisionId}',to_jsonb($2::text)),$3,'{"calls":0,"tokens":0,"spend":null}',$4 from maintenance_runs where id=$1 returning id`,[admitted.id,activated.revisionId,checkpoint,status])).rows[0].id as string;
  const budgetOwner=await copyOccurrence('failed',{bootstrapId:budgetBootstrap,reason:'maintenance.errors.budget'});
  const budgetEvent=(await db.query("insert into knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids) values('source',$1,'insert','budget-fixture','[]') returning id",[randomUUID()])).rows[0].id;
  const budgetDelivery=(await db.query(`insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,checkpoint,receipt)
    values($1,'curator',$2,$3,'acknowledged',$4,$5) on conflict(event_id,consumer,consumer_key,input_generation) do update set status=excluded.status,checkpoint=excluded.checkpoint,receipt=excluded.receipt returning id`,[budgetEvent,id,'budget-fixture:'+activated.revisionId,{bootstrapId:budgetBootstrap},{kind:'attention',runId:budgetBootstrap}])).rows[0].id;
  const successor=await copyOccurrence('awaiting_review',{impactDeliveryId:budgetDelivery,reason:'organization.errors.review'});
  assert.equal((await maintenance.attention(successor))!.kind,'blocked');assert.equal((await maintenance.attention(successor))!.reason,'maintenance.errors.budget');
  assert.equal((await maintenance.deliveryAttention(id,budgetOwner))!.reason,'maintenance.errors.budget');
  assert.equal((await maintenance.deliveryAttention(id,budgetOwner))!.exhaustible,true);
  assert.equal(await maintenance.deliveryAttention(id,successor),null);
  await db.query("update maintenance_runs set status='canceled' where id=any($1::uuid[])",[[budgetOwner,successor]]);
  await db.query("update knowledge_impact_deliveries set receipt=$2 where id=$1",[budgetDelivery,{kind:'fixture_checked'}]);
  // A dispatcher job can be complete while the canonical proposal is still pending.
  await db.query("update jobs set status='succeeded' where id in(select job_id from organization_runs where id=$1 union select job_id from maintenance_runs where id=$2)",[childId,admitted.id]);
  const terminalIds=[];
  for(const status of ['applied','failed','canceled']){
    const job=(await db.query("insert into jobs(type,status,payload) values('organization','succeeded','{}') returning id")).rows[0].id;
    const runId=randomUUID();terminalIds.push(runId);
    await db.query('insert into organization_runs(id,job_id,status,snapshot,checkpoint) values($1,$2,$3,$4,$5)',[runId,job,status,{...sample,inputFingerprint:runId},curatorSampleCheckpoint()]);
  }
  const pendingJob=(await db.query("insert into jobs(type,status,payload) values('organization','queued','{}') returning id")).rows[0].id;
  const canceledJob=(await db.query("insert into jobs(type,status,payload) values('organization','canceled','{}') returning id")).rows[0].id;
  const counts=(await db.query('select (select count(*) from organization_runs) organization,(select count(*) from maintenance_runs) maintenance,(select count(*) from automatic_routine_calls) reservations')).rows[0];
  await createJobRepository(db).clearCompletedOrFailed();
  const afterClear=await tasks.tasks(0,false);
  assert.ok(terminalIds.every(id=>!afterClear.tasks.some(t=>t.id===id)));
  assert.ok(afterClear.tasks.some(t=>t.id===childId&&t.status==='awaiting_review'));
  assert.ok(afterClear.tasks.some(t=>t.id===admitted.id&&t.status==='awaiting_review'));
  const visibleJobs=await createJobRepository(db).list();assert.ok(visibleJobs.some(j=>j.id===pendingJob));assert.ok(!visibleJobs.some(j=>j.id===canceledJob));
  assert.deepEqual((await db.query('select (select count(*) from organization_runs) organization,(select count(*) from maintenance_runs) maintenance,(select count(*) from automatic_routine_calls) reservations')).rows[0],counts);
  assert.deepEqual(await maintenance.monthly(id,month),{calls:2,tokens:2000,spend:null});
  assert.ok(await org.get(terminalIds[0]!));
  // A later completed state must reappear instead of being hidden by an earlier cleanup.
  await db.query("update organization_runs set status='failed',updated_at=clock_timestamp() where id=$1",[terminalIds[0]]);
  assert.ok((await tasks.tasks(0,false)).tasks.some(t=>t.id===terminalIds[0]));
  // Execute the source journey SQL against actual PostgreSQL enum columns.
  assert.deepEqual(SourceJourneySchema.parse(await tasks.sources(id,0)),{items:[],next:null});
  const unprocessed=randomUUID(),processed=randomUUID();
  await db.query("insert into source_items(id,type,title) values($1,'GenericDocument','Imported fixture'),($2,'GenericDocument','Processed fixture')",[unprocessed,processed]);
  await db.query("insert into ingestion_runs(source_item_id,status) values($1,'succeeded')",[processed]);
  const journeys=SourceJourneySchema.parse(await tasks.sources(id,0));
  assert.equal(journeys.items.find(s=>s.id===unprocessed)!.processing,'imported');
  assert.equal(journeys.items.find(s=>s.id===processed)!.processing,'succeeded');
  assert.ok(journeys.items.every(s=>s.wiki==='awaiting'&&s.obsidian==='disabled'));
  // A proposal can be applied after its collection stored an attention receipt.
  // Reconcile the exact result without inference, and preserve cancellation/pause.
  const collection=createWikiCollectionRepository(db),activePolicy=await createWikiCuratorRepository(db).resume(id);
  const recovered=await collection.bootstrap({version:'wiki-bootstrap-v1',policy:activePolicy,profile:sample.profile,promptPin:sample.promptPin,contentLanguage:'pt-BR',admittedAt:new Date().toISOString(),sourceIds:[unprocessed],noteIds:[],includeExistingNotes:true,participation:null});
  const appliedChild=randomUUID();
  await db.query("insert into organization_runs(id,status,snapshot,checkpoint) values($1,'awaiting_review',$2,$3)",[appliedChild,{...sample,policy:activePolicy,parentBootstrapId:recovered,maintenanceRunId:null,inputFingerprint:'recovery-fixture'},{...curatorSampleCheckpoint(),proposal:candidate,supportAssessment:{proposalHash:'fixture',aiTaskRunId:randomUUID(),verdict:{supported:true,checkedTargets:['new_fixture'],issues:[]}}}]);
  await db.query("update organization_runs set status='failed',checkpoint=checkpoint||$2::jsonb where id=$1",[recovered,{state:'attention',childRunId:appliedChild,error:'organization.errors.review'}]);
  const recoveryEvent=(await db.query("insert into knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids) values('source',$1,'insert','recovery-fixture',$2) returning id",[unprocessed,JSON.stringify([unprocessed])])).rows[0].id;
  const recoveryDelivery=(await db.query("insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,checkpoint,receipt) values($1,'curator',$2,$3,'acknowledged',$4,$5) on conflict(event_id,consumer,consumer_key,input_generation) do update set status=excluded.status,checkpoint=excluded.checkpoint,receipt=excluded.receipt returning id",[recoveryEvent,id,'recovery-fixture:'+activePolicy.revisionId,{bootstrapId:recovered},{kind:'attention',runId:recovered,reason:'organization.errors.review'}])).rows[0].id;
  assert.equal((await tasks.tasks(0,true)).tasks.find(t=>t.id===recovered)!.status,'awaiting_review');
  const reviewImpact=(await tasks.deliveries(id,[unprocessed],0)).items.find(r=>r.id===recoveryDelivery)!;
  assert.equal(reviewImpact.relatedRunId,appliedChild);assert.equal(reviewImpact.status,'blocked');
  assert.equal(reviewImpact.event.targetTitle,'Imported fixture');assert.equal(reviewImpact.event.operation,'insert');
  const dependentOwner=await copyOccurrence('awaiting_review',{impactDeliveryId:recoveryDelivery,reason:'organization.errors.review'});
  assert.equal((await maintenance.attention(dependentOwner))!.kind,'review');assert.equal((await maintenance.attention(dependentOwner))!.childRunId,appliedChild);
  await db.query("update maintenance_runs set status='canceled' where id=$1",[dependentOwner]);
  assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[]);
  await db.query("update organization_runs set status='applied' where id=$1",[appliedChild]);
  assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[]); // No canonical receipt yet.
  await db.query("insert into wiki_group_receipts(run_id,group_id,input_fingerprint,targets) values($1,$2,'recovery-fixture','[]')",[appliedChild,randomUUID()]);
  const projected=(await tasks.tasks(0,false)).tasks.find(t=>t.id===recovered)!;
  assert.equal(projected.status,'reconciling');assert.equal(projected.reason,null);assert.equal(projected.relatedRunId,appliedChild);
  assert.equal((await tasks.deliveries(id,[unprocessed],0)).items.find(r=>r.id===recoveryDelivery)!.reason,null);
  await createWikiCuratorRepository(db).pause(id);assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[]);
  await createWikiCuratorRepository(db).resume(id);
  for(const state of ['paused','canceled']){await db.query("update organization_runs set checkpoint=jsonb_set(checkpoint,'{state}',to_jsonb($2::text)) where id=$1",[recovered,state]);assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[]);}
  await db.query("update organization_runs set checkpoint=jsonb_set(checkpoint,'{state}','\"attention\"') where id=$1",[recovered]);
  await db.query("update organization_runs set snapshot=jsonb_set(snapshot,'{maintenanceRunId}',to_jsonb($2::text)) where id=$1",[appliedChild,budgetOwner]);
  assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[]); // Canceled owner is not restarted.
  await db.query("update organization_runs set snapshot=jsonb_set(snapshot,'{maintenanceRunId}','null') where id=$1",[appliedChild]);
  const recoveryAudits=(await db.query('select count(*)::int n from ai_task_runs')).rows[0].n;
  assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[recovered]);
  assert.deepEqual(await collection.reconcileAppliedChildren(activePolicy),[]);
  const restoredBootstrap=(await collection.get(recovered))!;assert.equal(restoredBootstrap.checkpoint.state,'running');assert.equal(restoredBootstrap.checkpoint.childRunId,appliedChild);assert.equal(restoredBootstrap.checkpoint.completedGroups,0);
  const restoredDelivery=(await db.query('select status,receipt,checkpoint from knowledge_impact_deliveries where id=$1',[recoveryDelivery])).rows[0];assert.equal(restoredDelivery.status,'deferred');assert.equal(restoredDelivery.receipt,null);assert.equal(restoredDelivery.checkpoint.bootstrapId,recovered);
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,recoveryAudits);
  // Empty historical checks collapse by exact scope; every record remains paged.
  const inspectionIds=(await db.query("insert into organization_runs(status,snapshot,checkpoint) select 'applied',$1,$2 from generate_series(1,65) returning id",[restoredBootstrap.snapshot,{...restoredBootstrap.checkpoint,state:'complete',phase:'structure',contentComplete:true,notesComplete:true,sourceId:null,childRunId:null,completedGroups:0,hierarchy:{version:'automatic-wiki-v1',fingerprint:{version:'automatic-wiki-v1',branchFingerprint:'fixture',scopeFingerprint:'fixture',policyRevisionId:restoredBootstrap.snapshot.policy.revisionId,promptFingerprint:'fixture',modelFingerprint:'fixture'},afterPageId:null,inspectedPages:0,outcome:'no_change',routes:[],counts:{workTargets:0,structuralAncestors:0,changedPages:0},appliedGroupIds:[],decisions:[]}}])).rows.map(r=>r.id);
  const inspectionTasks=(await tasks.tasks(0,false)).tasks;
  assert.equal(inspectionTasks.filter(t=>t.kind==='inspection'&&t.sourceIds.includes(unprocessed)).length,1);
  assert.equal(inspectionTasks.find(t=>t.kind==='inspection'&&t.sourceIds.includes(unprocessed))!.detailCount,65);
  assert.ok(!inspectionTasks.some(t=>t.kind==='organization'&&inspectionIds.includes(t.id)));
  const inspections1=await tasks.inspections(id,[unprocessed],0,activePolicy.revisionId),inspections2=await tasks.inspections(id,[unprocessed],inspections1.next!,activePolicy.revisionId);
  assert.equal(inspections1.items.length,50);assert.equal(inspections2.items.length,15);
  assert.equal(new Set([...inspections1.items,...inspections2.items].map(t=>t.id)).size,65);
  await createJobRepository(db).clearCompletedOrFailed();
  assert.ok(!(await tasks.tasks(0,false)).tasks.some(t=>t.kind==='inspection'&&t.sourceIds.includes(unprocessed)));
  assert.equal((await db.query('select count(*)::int n from organization_runs where id=any($1::uuid[])',[inspectionIds])).rows[0].n,65);
  // Legacy review-only events retain their proposal/audits, but require no decision.
  const reviewPage=await wiki.save({expectedRevisionId:null,content:WikiPageContentSchema.parse({title:'Legacy reviewed index',kind:'collection'}),evidenceChunkIds:[]}),reviewBefore=(await wiki.get(reviewPage))!;
  await wiki.save({version:2,id:reviewPage,expectedRevisionId:reviewBefore.revisionId,content:{...WikiPageContentSchema.strip().parse(reviewBefore),review:'reviewed'},evidenceChunkIds:[]});
  const reviewRevision=(await wiki.get(reviewPage))!.revisionId;
  const legacyEvent=(await db.query(`insert into knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,created_at)
    select 'wiki_page',page_id,'update',md5((content-'pinned'-'position'-'parentId')::text),$2,created_at from wiki_page_revisions where id=$1 returning id`,[reviewRevision,JSON.stringify([unprocessed])])).rows[0].id;
  const obsoleteChild=randomUUID(),obsoleteOwner=await copyOccurrence('awaiting_review',{...admitted.checkpoint,reason:'organization.errors.review',reviewChildId:obsoleteChild,executionMs:321});
  await db.query("insert into organization_runs(id,status,snapshot,checkpoint) values($1,'analyzing',$2,$3)",[obsoleteChild,{...sample,policy:activePolicy,parentBootstrapId:null,maintenanceRunId:obsoleteOwner,requiredPageIds:[reviewPage]},{...curatorSampleCheckpoint(),proposal:candidate,callPending:true}]);
  await db.query('insert into organization_proposals(run_id,proposal) values($1,$2)',[obsoleteChild,candidate]);
  const legacyDelivery=(await db.query("update knowledge_impact_deliveries set status='deferred',checkpoint=$2 where event_id=$1 and consumer_key=$3 returning id",[legacyEvent,{childRunId:obsoleteChild,blockedReason:'organization.errors.review'},id])).rows[0].id;
  await db.query("update maintenance_runs set checkpoint=jsonb_set(checkpoint,'{impactDeliveryId}',to_jsonb($2::text)) where id=$1",[obsoleteOwner,legacyDelivery]);
  const reconciler=createWikiImpactReconciliationRepository(db);
  assert.ok(!(await reconciler.editorial(activePolicy)).includes(legacyDelivery),'Active provider calls survive');
  await db.query("update organization_runs set status='awaiting_review',checkpoint=jsonb_set(checkpoint,'{callPending}','false') where id=$1",[obsoleteChild]);
  await createWikiCuratorRepository(db).pause(id);assert.deepEqual(await reconciler.editorial(activePolicy),[]);await createWikiCuratorRepository(db).resume(id);
  const retainedCandidate=JSON.stringify((await db.query('select proposal,decision from organization_proposals where run_id=$1',[obsoleteChild])).rows[0]);
  const budgetBeforeReconcile=JSON.stringify((await db.query('select reservation from maintenance_runs where id=$1',[obsoleteOwner])).rows[0]);
  assert.ok((await reconciler.editorial(activePolicy)).includes(legacyDelivery));
  assert.equal((await db.query('select status from organization_runs where id=$1',[obsoleteChild])).rows[0].status,'canceled');
  assert.equal(JSON.stringify((await db.query('select proposal,decision from organization_proposals where run_id=$1',[obsoleteChild])).rows[0]),retainedCandidate);
  assert.equal((await wiki.get(reviewPage))!.revisionId,reviewRevision);
  assert.equal((await db.query('select checkpoint from maintenance_runs where id=$1',[obsoleteOwner])).rows[0].checkpoint.executionMs,321);
  assert.equal(JSON.stringify((await db.query('select reservation from maintenance_runs where id=$1',[obsoleteOwner])).rows[0]),budgetBeforeReconcile);
  assert.equal(await maintenance.reviewChild(obsoleteOwner),null);assert.deepEqual(await reconciler.editorial(activePolicy),[]);
  const reviewedPage=(await wiki.get(reviewPage))!;
  await wiki.save({version:2,id:reviewPage,expectedRevisionId:reviewedPage.revisionId,content:{...WikiPageContentSchema.strip().parse(reviewedPage),review:'draft',title:'Substantive new title'},evidenceChunkIds:[]});
  const genuine=(await db.query("select d.id from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id where e.input_id=$1 and d.status='pending' order by e.created_at desc limit 1",[reviewPage])).rows[0].id;
  assert.ok(!(await reconciler.editorial(activePolicy)).includes(genuine));
  // A complete reset must reinstall defaults before its response, without inference.
  configured=false;
  const reset=new LibraryResetService({getPool:()=>db!,getStorageSettings:async()=>({obsidianVaultPath:null,managedRoot:'Memora',obsidianSyncEnabled:false,obsidianSyncPaused:false,deletionPolicy:'tombstone',uploadCopiesEnabled:false,uploadCopiesFolderPath:null,updatedAt:new Date().toISOString()}),userDataPath:join(work,'reset-user-data'),restoreDefaults:async()=>{await new PromptService({getPool:()=>db!}).initialize();await automation.initialize();}});
  const modelConfig=createAiConfigRepository(db);
  await modelConfig.upsertProvider({provider:'openai-compatible',displayName:'Reset preservation fixture',defaultParameters:{temperature:0.2}});
  const preservedProfile=await modelConfig.createProfile({name:'Reset preservation profile'});
  await modelConfig.setProfileTask({profileId:preservedProfile.id,task:'structured-output',parameters:{maxTokens:2048}});
  await modelConfig.setTaskRoute('structured-output',preservedProfile.id);
  const modelSnapshot=async()=>Promise.all([modelConfig.listProviders(),modelConfig.listProfiles(),modelConfig.listProfileTasks(),modelConfig.listTaskRoutes()]);
  const preservedModels=await modelSnapshot();
  await db.query("create extension if not exists age");
  const ageClient=await db.connect();try{await ageClient.query('begin');await ageClient.query("load 'age'");await ageClient.query('set local search_path = ag_catalog, "$user", public');await ageClient.query("select ag_catalog.create_graph('memora_knowledge')");await ageClient.query('commit');}catch(error){await ageClient.query('rollback');throw error;}finally{ageClient.release();}
  assert.equal((await db.query("select count(*)::int n from ag_catalog.ag_graph where name='memora_knowledge'")).rows[0].n,1);
  await reset.reset();
  assert.equal((await db.query("select count(*)::int n from ag_catalog.ag_graph where name='memora_knowledge'")).rows[0].n,0);
  assert.deepEqual(await modelSnapshot(),preservedModels);
  const restoredId=(await createSettingsRepository(db).get<{policyId:string}>(knowledgeAutomationPolicyKey))!.policyId;
  const restored=await createAutomaticMaintenanceRepository(db).schedules(restoredId);
  assert.deepEqual(restored.map(s=>s.policy.kind).sort(),['daily','incremental','monthly','weekly']);assert.ok(restored.every(s=>s.policy.enabled));
  for(const area of Object.values(wikiAreaIds))assert.ok(await wiki.get(area));
  assert.equal((await automation.dashboard(0,'all')).ready,false);
  assert.equal((await db.query('select count(*)::int n from source_items')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,0);
  assert.equal(await automation.initialize(),restoredId);assert.equal((await createAutomaticMaintenanceRepository(db).schedules(restoredId)).length,4);
  // Optional AGE is absent in a normal empty installation until graph use.
  await db.query("drop extension age cascade");
  assert.equal((await db.query("select to_regclass('ag_catalog.ag_graph') as catalog")).rows[0].catalog,null);
  await db.query("insert into source_items(type,title) values('PersonalNote','Missing AGE reset fixture')");
  await reset.reset();
  const noAgePolicy=(await createSettingsRepository(db).get<{policyId:string}>(knowledgeAutomationPolicyKey))!.policyId;
  const noAgeRoutines=await createAutomaticMaintenanceRepository(db).schedules(noAgePolicy);
  assert.deepEqual(noAgeRoutines.map(s=>s.policy.kind).sort(),['daily','incremental','monthly','weekly']);assert.ok(noAgeRoutines.every(s=>s.policy.enabled));
  for(const area of Object.values(wikiAreaIds))assert.ok(await wiki.get(area));
  assert.equal((await db.query('select count(*)::int n from source_items')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from ai_task_runs')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from obsidian_projection_clock where id=1')).rows[0].n,1);
  assert.equal((await db.query("select to_regclass('ag_catalog.ag_graph') as catalog")).rows[0].catalog,null);
  assert.deepEqual(await modelSnapshot(),preservedModels);
  await reset.reset();assert.deepEqual(await modelSnapshot(),preservedModels);
  console.log(JSON.stringify({ok:true,checks:['existing-content-preservation','idempotent-startup','default-routines-without-model','no-inference','new-page-placement','visible-blocked-task-pagination','automatic-admission-after-model-configuration','estimates-do-not-block','serialized-idempotent-curator-admission','portable-mirror-areas-and-preserved-prose','atomic-shared-monthly-budget','stale-budget-save-rejected','recorded-usage-strict-limit-before-next-call','budget-save-preserves-snapshots-and-ledger','new-scope-inherits-budget','curator-limit-save-preserves-pause','stale-preview-cannot-reset-budget','blocked-versus-review-projection','linked-failure-diagnostics','terminal-history-cleanup-preserves-pending','history-cleanup-retains-audits-and-budget','later-completions-remain-visible','source-journey-empty-imported-and-processed-enum-status','reset-restores-four-enabled-routines-and-wiki-areas','reset-without-model-is-idempotent-and-no-inference','reset-existing-age-graph-removed','reset-without-age-restores-defaults-and-preserves-model-configuration'],actualModel:false}));
} finally {if(db)await closePgPool(db);await manager.stop();await rm(work,{recursive:true,force:true});}
