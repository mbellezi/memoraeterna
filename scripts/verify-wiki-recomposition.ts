import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createPgPool,closePgPool,PostgresSidecarManager,resolvePostgresSidecarPaths,runMigrations,createWikiRepository,createWikiRemovalRepository,createWikiCuratorRepository,createWikiCollectionRepository,createOrganizationRepository,createJobRepository,createAiConfigRepository,createSourceItemRepository,createDocumentRepository,createChunkRepository,type PgPool} from '../packages/db/src/index.js';
import {WikiPageContentSchema,AutomaticWikiPolicySchema,WikiBootstrapSchema,initialCuratorLimits,type OrganizationProfile,type CuratorSnapshot} from '@app/domain';
import {WikiCurator} from '../apps/desktop/src/main/services/wiki-curator.js';
import {WikiCollection,collectionGenerationHash} from '../apps/desktop/src/main/services/wiki-collection.js';
import {promptAudit,promptFingerprint} from '../apps/desktop/src/main/services/prompt-runtime.js';

const root=resolve(import.meta.dirname,'..'),dir=await mkdtemp(join(tmpdir(),'memora-wiki-recomposition-')),paths=resolvePostgresSidecarPaths({cwd:root,env:process.env});
const manager=new PostgresSidecarManager({binDir:paths.binDir,dataDir:join(dir,'data'),database:'wiki_recomposition',user:'wiki_recomposition',password:randomUUID()});let pool:PgPool|undefined;
async function source(db:PgPool,title:string,texts:string[],parentId:string|null=null){const item=await createSourceItemRepository(db).create({type:'GenericDocument',title,parentSourceItemId:parentId});let documentId:string|null=null;const ids:string[]=[];if(texts.length){const doc=await createDocumentRepository(db).create({sourceItemId:item.id,title,canonicalMarkdown:texts.join('\n\n'),contentHash:texts.join('|')});documentId=doc.id;await createChunkRepository(db).replaceDocumentChunks(doc.id,item.id,texts.map((text,index)=>{const id=randomUUID(),span=randomUUID();ids.push(id);return{id,sourceSpanId:span,chunkIndex:index,content:text,contentHash:text,span:{id:span,startOffset:index*100,endOffset:index*100+text.length}};}));}return{id:item.id,ids:ids.toSorted(),documentId};}

async function exercise(db:PgPool){
 const repo=createWikiCuratorRepository(db),collectionRepo=createWikiCollectionRepository(db),runs=createOrganizationRepository(db),jobs=createJobRepository(db),wiki=createWikiRepository(db);
 const profile:OrganizationProfile={profileId:randomUUID(),providerConfigId:null,localModelId:randomUUID(),provider:'synthetic',modelId:'fixture',runtime:'test',revision:'1',privacy:'offline_only',parameters:{maxTokens:4096},identityHash:'fixture-a3',contextWindow:65536};let calls=0;
 const draft=(snapshot:CuratorSnapshot)=>{const handle=(kind:string,id:string)=>'r'+(snapshot.references.findIndex(r=>r.kind===kind&&r.id===id)+1),topic=snapshot.pages.find(p=>p.kind==='topic'),index=snapshot.pages.find(p=>p.kind==='collection'),topicHandle=topic?handle('page',topic.id):'new_topic';return{explanation:'Integrate the admitted original classroom evidence.',topics:[{handle:topicHandle,title:topic?.title??'Recuperação e retenção',purpose:topic?.automatic?.purpose??'Compare classroom retrieval and spacing evidence.',sections:[{id:topic?.sections[0]?.id??null,title:'Classroom evidence',markdown:snapshot.evidence.map(e=>e.excerpt+' ['+e.handle+']').join('\n\n'),originalHandles:snapshot.evidence.map(e=>e.handle)}],links:[]}],indexes:[{handle:index?handle('page',index.id):'new_index',title:index?.title??(topic?'Reading '+topic.title:'Reading the classroom evidence'),purpose:index?.automatic?.purpose??'Navigate the original classroom evidence.',owner:{topic:topicHandle},groups:[{id:index?.automatic?.groups[0]?.id??null,title:'Original evidence',explanation:null,originalHandles:[],targets:snapshot.references.filter(r=>r.kind==='source'||r.kind==='atomic_note').map(r=>handle(r.kind,r.id))}]}]};};
 const ai={pinOrganizationProfile:async()=>profile,runOrganizationTask:async(_profile:any,prompt:string,context:any,signal:AbortSignal,_max:number,guard?:()=>Promise<void>)=>{await guard?.();signal.throwIfAborted();calls++;const run=(await runs.get(context.organizationRunId))!;const output=context.stage==='support'?{supported:true,checkedTargets:run.checkpoint.proposal.targets.map((t:any)=>t.handle),issues:[]}:draft(run.snapshot);const aiTaskRunId=await createAiConfigRepository(db).recordTaskRun({...context,promptCompositions:promptAudit(prompt),taskType:'structured-output',provider:'synthetic',modelId:'fixture',runtime:'test',durationMs:1,status:'succeeded',inputTokens:100,outputTokens:50});return{output,aiTaskRunId,inputTokens:100,outputTokens:50,providerId:'synthetic',modelId:'fixture',runtime:'test',durationMs:1,taskType:'structured-output' as const};}};
 const options={getPool:()=>db,ai,contentLanguage:async()=> 'en',wake:()=>{},cancelJob:(id:string)=>jobs.requestCancel(id)};
 const curator=()=>new WikiCurator(options),collection=()=>new WikiCollection(options);

 let policy=AutomaticWikiPolicySchema.parse({version:'automatic-wiki-v1',id:randomUUID(),revisionId:randomUUID(),state:'enabled',scope:{wholeLibrary:true,sourceIds:[],includeDescendants:true,excludedSourceIds:[],domainId:null},triggers:[],operations:['repair_navigation','create_grounded','update_unprotected','initial_placement'],profileOverrideId:null,limits:initialCuratorLimits,allowancePreset:null});
 await repo.draft(policy,{},'fixture');await repo.activate(policy.id,policy.revisionId,'fixture');
 const a=await source(db,'Source A',['A reports improved recall after practice.']),b=await source(db,'Source B',['B reports spacing improves later recall.']);
 const noteIds=(await db.query("insert into atomic_notes(created_from_source_item_id,evidence_chunk_id,title,idea_statement,body_markdown,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) select $1,$2,'Note '||i,'Practice finding '||i,'A reports improved recall after practice.','pending_review','synthetic','fixture','test','fixture-v1',md5(i::text) from generate_series(1,8) i returning id",[a.id,a.ids[0]])).rows.map(r=>r.id);
 const rejected=(await db.query("insert into atomic_notes(created_from_source_item_id,evidence_chunk_id,title,idea_statement,body_markdown,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1,$2,'Rejected','Rejected','Rejected','rejected','synthetic','fixture','test','fixture-v1','rejected') returning id",[a.id,a.ids[0]])).rows[0].id;
 const execute=async(id:string)=>{const run=(await runs.get(id))!;if(run.status==='queued')await curator().execute({id:run.jobId!,type:'organization',payload:{organizationRunId:id}} as any,new AbortController().signal);};
 const bootstrap=WikiBootstrapSchema.parse(await collection().command({command:'bootstrap',input:{policyId:policy.id,policyRevisionId:policy.revisionId,sourceIds:[a.id,b.id],includeExistingNotes:true}}));
 // No direct note selection: ordinary automatic coverage must discover all pending notes.
 let reconciledApplied=false;
 for(let i=0;i<80;i++){await collection().tick();const run=(await collectionRepo.get(bootstrap.id))!;if(run.checkpoint.childRunId){await execute(run.checkpoint.childRunId);if(!reconciledApplied){const waiting=(await collectionRepo.get(bootstrap.id))!;waiting.checkpoint.state='attention';waiting.checkpoint.error='organization.errors.review';await collectionRepo.checkpoint(waiting);const beforeResume=calls;await collection().tick();const resumed=(await collectionRepo.get(bootstrap.id))!;assert.equal(resumed.checkpoint.state,'running');assert.equal(resumed.checkpoint.childRunId,null);assert.equal(resumed.checkpoint.completedGroups,waiting.checkpoint.completedGroups+1);assert.equal(calls,beforeResume,'Consume the applied result without another provider call');reconciledApplied=true;}}if(run.checkpoint.state==='complete')break;assert.equal(run.checkpoint.state,'running',run.checkpoint.error??'bootstrap failed');}
 assert.equal(reconciledApplied,true);
 assert.equal((await collectionRepo.get(bootstrap.id))!.checkpoint.state,'complete');
 assert.equal((await db.query("select count(distinct target_id)::int n from wiki_memberships where target_kind='atomic_note' and target_id=any($1::uuid[])",[noteIds])).rows[0].n,8);
 assert.equal((await db.query("select count(*)::int n from wiki_memberships where target_id=$1",[rejected])).rows[0].n,0);
 assert.equal((await db.query("select count(*)::int n from atomic_notes where id=any($1::uuid[]) and status='pending_review'",[noteIds])).rows[0].n,8);
 const again=WikiBootstrapSchema.parse(await collection().command({command:'bootstrap',input:{policyId:policy.id,policyRevisionId:policy.revisionId,sourceIds:[a.id,b.id],includeExistingNotes:true}})),before=calls;
 for(let i=0;i<5;i++)await collection().tick();assert.equal((await collectionRepo.get(again.id))!.checkpoint.state,'complete');assert.equal(calls,before);
 const generation=collectionGenerationHash({policy:policy.revisionId,profile:profile.identityHash,parameters:profile.parameters,language:'en',prompts:promptFingerprint(['organization.curator','organization.curator.repair','organization.curator.support'],again.snapshot.promptPin,profile.provider)});
 assert.equal(await collectionRepo.discoveryCovered(policy,[a.id,b.id],generation),true);
 assert.equal(await collectionRepo.discoveryCovered(policy,[a.id],generation+'changed-profile'),false);
 assert.equal(await collectionRepo.discoveryCovered({...policy,scope:{...policy.scope,excludedSourceIds:[a.id]}},[a.id],generation),false);
 // A retained burst already reflected in current coverage creates no empty runs.
 await db.query("update wiki_policy_revisions set policy=jsonb_set(policy,'{triggers}','[\"input_changed\"]') where id=$1",[policy.revisionId]);
 await db.query("insert into knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids) select 'entity_mention',gen_random_uuid(),'update','settled-burst-'||i,$1 from generate_series(1,40) i",[JSON.stringify([a.id])]);
 await collectionRepo.reconcileDeliveries(policy);
 await db.query("update wiki_source_coverage set status='integrated' where policy_id=$1 and source_id=$2",[policy.id,a.id]);
 await db.query("update knowledge_impact_deliveries d set status='acknowledged',receipt='{\"kind\":\"fixture_settled\"}' from knowledge_impact_events e where e.id=d.event_id and e.fingerprint not like 'settled-burst-%'");
 const runsBeforeBurst=(await db.query('select count(*)::int n from organization_runs')).rows[0].n;
 for(let i=0;i<45;i++)await collection().tick();
 assert.equal((await db.query("select count(*)::int n from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id where e.fingerprint like 'settled-burst-%' and d.receipt->>'reason'='coverage_current'")).rows[0].n,40);
 assert.equal((await db.query('select count(*)::int n from organization_runs')).rows[0].n,runsBeforeBurst);assert.equal(calls,before);
 await db.query("update wiki_policy_revisions set policy=jsonb_set(policy,'{triggers}','[]') where id=$1",[policy.revisionId]);
 // An old exhausted occurrence cannot block inputs integrated by a later pass.
 const exhaustedId=await collectionRepo.bootstrap({...again.snapshot,sourceIds:[a.id]}),exhausted=(await collectionRepo.get(exhaustedId))!;
 exhausted.checkpoint.state='attention';exhausted.checkpoint.error='maintenance.errors.budget';await collectionRepo.checkpoint(exhausted);
 const exhaustedEvent=(await db.query("insert into knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids) values('document',$1,'insert','exhausted-fixture',$2) returning id",[a.documentId,JSON.stringify([a.id])])).rows[0].id;
 const exhaustedReceipt={kind:'attention',runId:exhausted.id};
 const exhaustedDelivery=(await db.query("insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,checkpoint,receipt) values($1,'curator',$2,$3,'acknowledged',$4,$5) returning id",[exhaustedEvent,policy.id,'exhausted-fixture:'+policy.revisionId,{bootstrapId:exhausted.id},exhaustedReceipt])).rows[0].id;
 await db.query("update wiki_source_coverage set status='integrated' where policy_id=$1 and source_id=$2",[policy.id,a.id]);
 await collection().reconcile(policy);
 const settled=(await db.query('select receipt from knowledge_impact_deliveries where id=$1',[exhaustedDelivery])).rows[0].receipt;
 assert.equal(settled.kind,'inspected');assert.deepEqual(settled.previousAttention,exhaustedReceipt);
 assert.equal((await collectionRepo.get(exhausted.id))!.checkpoint.state,'attention');assert.equal(calls,before);
 // Keyset selection crosses the old 101-note boundary, and does not require approval.
 const many=(await db.query("insert into atomic_notes(created_from_source_item_id,evidence_chunk_id,title,idea_statement,body_markdown,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) select $1,$2,'Extra '||i,'Extra '||i,'A reports improved recall after practice.','pending_review','synthetic','fixture','test','fixture-v1',md5('extra'||i) from generate_series(1,105) i returning id",[a.id,a.ids[0]])).rows.map(r=>r.id);
 assert.equal(await collectionRepo.discoveryCovered(policy,[a.id],generation),false,'New unreviewed notes still require integration');
 let after:string|null=null;const seen:string[]=[];for(;;){const page=await repo.unplacedNotes([a.id],after);if(!page.length)break;seen.push(...page);after=page.at(-1)!;}assert.equal(seen.length,105);await db.query('delete from atomic_notes where id=any($1::uuid[])',[many]);
 const topic=(await wiki.list()).find(p=>p.kind==='topic'&&p.automatic)!,index=(await wiki.list()).find(p=>p.kind==='collection'&&p.automatic)!;
 const oldIndex=(await wiki.get(index.id))!,oldHistory=JSON.stringify(await wiki.history(index.id));
 // An archived note is removed from navigation; the retained revision still names it.
 await db.query("update atomic_notes set status='archived' where id=$1",[noteIds[0]]);
 const removal=createWikiRemovalRepository(db);
 const narrow=AutomaticWikiPolicySchema.parse({...policy,id:randomUUID(),revisionId:randomUUID(),scope:{...policy.scope,wholeLibrary:false,sourceIds:[a.id],excludedSourceIds:[b.id]}});await repo.draft(narrow,{},'scope');await repo.activate(narrow.id,narrow.revisionId,'scope');
 await assert.rejects(removal.repair(narrow,index.id,oldIndex.revisionId,'References'),/scopeDecision/);assert.equal((await wiki.get(index.id))!.revisionId,oldIndex.revisionId);await repo.pause(narrow.id);
 await assert.rejects(removal.repair(policy,index.id,randomUUID(),'References'),/conflict/);
 const first=await removal.repair(policy,index.id,oldIndex.revisionId,'References');assert.ok(first?.changed);
 assert.ok(!(await wiki.get(index.id))!.automatic!.memberships.some(m=>m.target.id===noteIds[0]));
 assert.ok((await wiki.get(index.id,oldIndex.revisionId))!.automatic!.memberships.some(m=>m.target.id===noteIds[0]));
 const stable=(await wiki.get(index.id))!;await removal.repair(policy,index.id,stable.revisionId,'References');assert.equal((await wiki.get(index.id))!.revisionId,stable.revisionId);
 // Protected human prose survives unavailable evidence, without blocking adjacent repairs.
 const humanId=randomUUID(),humanPage=await wiki.save({expectedRevisionId:null,content:WikiPageContentSchema.parse({title:'Personal interpretation',kind:'topic',sections:[{id:humanId,title:'Human interpretation',markdown:'My original interpretation.',protected:true,provenance:'personal',evidenceReview:'needs_review',evidenceIds:[a.ids[0]!]}]}),evidenceChunkIds:[a.ids[0]!]});
 policy=AutomaticWikiPolicySchema.parse({...policy,revisionId:randomUUID(),triggers:['input_changed']});await repo.draft(policy,{},'removal');await repo.activate(policy.id,policy.revisionId,'removal');for(let i=0;i<10;i++)await collectionRepo.reconcileDeliveries(policy);
 // Process deletion through the actual impact delivery loop. Existing source exclusions remain authoritative.
 await db.query("update knowledge_impact_deliveries set status='acknowledged',receipt=$1",[{kind:'fixture_settled'}]);
 await db.query('delete from source_items where id=$1',[a.id]);
 for(let i=0;i<150;i++){await db.query("update knowledge_impact_deliveries set defer_until=clock_timestamp() where consumer_key=$1 and status='deferred'",[policy.id]);await collection().tick();const queued=(await db.query("select id from organization_runs where status='queued' and snapshot->>'version'='wiki-curator-v2'")).rows;for(const r of queued)await execute(r.id);const pending=(await db.query("select count(*)::int n from knowledge_impact_deliveries where consumer='curator' and consumer_key=$1 and status not in('acknowledged','excluded')",[policy.id])).rows[0].n;if(!pending)break;if(i===149){throw Error(JSON.stringify((await db.query("select status,checkpoint->>'blockedReason' reason,checkpoint->'removalRepair' repair from knowledge_impact_deliveries where consumer='curator' and status not in('acknowledged','excluded') order by updated_at desc limit 6")).rows));}}
 const repairedTopic=(await wiki.get(topic.id))!,repairedIndex=(await wiki.get(index.id))!;
 assert.equal((await wiki.get(humanPage))!.sections.find(s=>s.id===humanId)!.markdown,'My original interpretation.');
 assert.ok((await wiki.get(humanPage))!.impacts.some(i=>i.reason.includes('delete')));assert.ok(repairedTopic.sections.every(s=>!s.markdown.includes('A reports')));assert.ok(repairedTopic.sections.some(s=>s.markdown.includes('B reports')));
 assert.ok(repairedIndex.automatic!.memberships.every(m=>m.target.id!==a.id&&!noteIds.includes(m.target.id)));
 assert.ok(repairedIndex.automatic!.memberships.some(m=>m.target.id===b.id));
 assert.deepEqual((await wiki.history(index.id)).filter(r=>r.id===oldIndex.revisionId),JSON.parse(oldHistory).filter((r:any)=>r.id===oldIndex.revisionId));
 // Removing the last source archives an empty generated index, preserving historical evidence and groups.
 await db.query('delete from source_items where id=$1',[b.id]);const last=(await wiki.get(index.id))!;await removal.repair(policy,index.id,last.revisionId,'References');
 assert.equal((await wiki.get(index.id))!.archived,true);assert.equal((await db.query('select count(*)::int n from wiki_toc_groups where page_id=$1',[index.id])).rows[0].n,0);
 assert.ok((await wiki.get(index.id,oldIndex.revisionId))!.automatic!.groups.length);
 console.log('Passed: pending notes after ingestion, stable repeated coverage, >101-note pagination, rejected-note exclusion, archived-note TOC cleanup, deletion impact delivery, human prose/history preservation, surviving memberships and last-source archive. Model calls used deterministic doubles only.');
}
try{const connection=await manager.start();pool=createPgPool({connectionString:connection.connectionString,max:8});await runMigrations(pool,join(root,'packages/db/drizzle'),{seedFolder:join(root,'packages/db/seed')});await exercise(pool);}finally{if(pool)await closePgPool(pool);await manager.stop();await rm(dir,{recursive:true,force:true});}
