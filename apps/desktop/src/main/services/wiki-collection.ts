import {organizationAiFailure} from './ai-task-parameters.js';
import {createAutomaticMaintenanceRepository} from '@app/db';
import {createWikiCollectionRepository,createWikiCuratorRepository,createOrganizationRepository,curatorHash,type PgPool} from '@app/db';
import {WikiCollectionCommandSchema,type WikiBootstrap} from '@app/domain';
import type {z} from 'zod';
import {WikiCurator} from './wiki-curator.js';
import {capturePromptPin,promptFingerprint,withPromptPin} from './prompt-runtime.js';
const ticks=new WeakMap<PgPool,Promise<void>>();
export const collectionGenerationHash=(value:unknown):string=>{const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).toSorted(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):v;return curatorHash(canonical(value));};
type Options=ConstructorParameters<typeof WikiCurator>[0];
/** A source cursor and child receipts live in the existing organization checkpoint owner. */
export class WikiCollection {
 constructor(private options:Options){}
 private pool(){const pool=this.options.getPool();if(!pool)throw new Error('wiki.errors.unavailable');return pool;}
 async command(raw:z.input<typeof WikiCollectionCommandSchema>,participation:import('@app/domain').CuratorSnapshot['participation']=null){const c=WikiCollectionCommandSchema.parse(raw),repo=createWikiCollectionRepository(this.pool()),curator=createWikiCuratorRepository(this.pool());
  if(c.command==='assessment'){const policy=await curator.policy(c.input.policyId);if(!policy)throw new Error('organization.errors.policy');let profile;try{profile=await this.options.ai.pinOrganizationProfile(policy.profileOverrideId??undefined,'allow_remote');}catch{profile=null;}const result=await repo.assessment(policy,c.input.after,c.input.limit,[],profile?this.generation({policy,profile,promptPin:capturePromptPin(policy.scope.domainId),contentLanguage:await this.options.contentLanguage()}):'unconfigured');for(const source of result.sources.slice(0,3)){const evidence=await curator.evidencePage([source.id],null,6);if(!evidence.items.length)continue;const discovery=await curator.discover(policy,[source.id],evidence.items.map(e=>e.excerpt).join(' '));for(const conflict of discovery.excluded)if(!result.scopeConflicts.some(c=>c.pageId===conflict.id))result.scopeConflicts.push({pageId:conflict.id,title:conflict.title,excludedSources:await curator.sourceMetadata(conflict.sourceIds)});}return result;}

  if(c.command==='bootstraps')return repo.list(c.policyId,c.after);
  if(c.command==='drainImpacts'){await this.tick();return null;}
  if(c.command==='bootstrap'){
   const policy=await curator.policy(c.input.policyId);if(policy?.state!=='enabled'||policy.revisionId!==c.input.policyRevisionId)throw new Error('organization.errors.policy');
   const sourceIds=c.input.sourceIds.length?await curator.scope(policy,c.input.sourceIds):[];
   const maintenanceRepo=createAutomaticMaintenanceRepository(this.pool()),existingMaintenance=await maintenanceRepo.authority(policy.id),maintenance=await maintenanceRepo.installed(policy.id)&&!existingMaintenance?await maintenanceRepo.manualAuthority(policy.id,new Date(),{profile:await this.options.ai.pinOrganizationProfile(policy.profileOverrideId??undefined,'allow_remote'),promptPin:capturePromptPin(policy.scope.domainId),contentLanguage:await this.options.contentLanguage()},'daily'):existingMaintenance,profile=maintenance?.snapshot.profile??await this.options.ai.pinOrganizationProfile(policy.profileOverrideId??undefined,'allow_remote');
   const id=await repo.bootstrap({version:'wiki-bootstrap-v1',participation,noteIds:c.input.noteIds,policy,sourceIds,profile,promptPin:maintenance?.snapshot.promptPin??capturePromptPin(policy.scope.domainId),contentLanguage:maintenance?.snapshot.contentLanguage??await this.options.contentLanguage(),admittedAt:new Date().toISOString()});if(maintenance){maintenance.checkpoint.bootstrapId=id;maintenance.checkpoint.phase='coverage';await maintenanceRepo.checkpoint(maintenance);}this.options.wake();return repo.get(id);
  }
  const run=await repo.get(c.id);if(!run)throw new Error('organization.errors.invalid');
  if(c.command==='bootstrapGet')return run;
  if(c.command==='bootstrapCancel'){run.checkpoint.state='canceled';if(run.checkpoint.childRunId)await new WikiCurator(this.options).command({command:'cancel',id:run.checkpoint.childRunId});}
  if(c.command==='bootstrapPause')run.checkpoint.state='paused';
  if(c.command==='bootstrapResume'){
   const policy=await curator.policy(run.snapshot.policy.id);if(policy?.state!=='enabled'||policy.revisionId!==run.snapshot.policy.revisionId)throw new Error('organization.errors.policy');
   if(run.checkpoint.state==='canceled'||run.checkpoint.state==='complete')throw new Error('organization.errors.canceled');
   run.checkpoint.state='running';run.checkpoint.error=null;
   await repo.checkpoint(run);
   if(run.checkpoint.childRunId){const child=await new WikiCurator(this.options).get(run.checkpoint.childRunId);if(child?.status==='failed')await new WikiCurator(this.options).command({command:'retry',id:child.id});}
  }
  await repo.checkpoint(run);this.options.wake();return repo.get(run.id);
 }
 tick(){const pool=this.pool(),active=ticks.get(pool);if(active)return active;const task=this.drain().finally(()=>ticks.delete(pool));ticks.set(pool,task);return task;}
 private async drain(){const repo=createWikiCollectionRepository(this.pool()),curator=createWikiCuratorRepository(this.pool());
  // One bounded step per active bootstrap and one delivery per policy per supervisor pass.
  for(const run of await repo.active()){const maintenance=createAutomaticMaintenanceRepository(this.pool());if(await maintenance.installed(run.snapshot.policy.id)&&!await maintenance.authority(run.snapshot.policy.id))continue;run.checkpoint.lastTickAt=new Date().toISOString();try{await repo.checkpoint(run);await this.advance(run);}catch(error){if(!String(error).includes('organization.errors.conflict'))throw error;}}
  for(const policy of await curator.policies())if(policy.triggers.includes('input_changed')){
   await repo.reconcileDeliveries(policy);if(policy.state!=='enabled')continue;const maintenance=createAutomaticMaintenanceRepository(this.pool());const installed=await maintenance.installed(policy.id),authority=await maintenance.authority(policy.id);if(installed&&!authority)continue;
   const event=await repo.claimDelivery(policy.id);if(!event)continue;
   if(event.operation!=='delete'&&!await repo.currentWikiEvent(event.kind,event.input_id,event.fingerprint)){await repo.delivery(event.id,event.checkpoint,{kind:'excluded',reason:'superseded_revision'});continue;}
   if(!event.input_generation.endsWith(':'+policy.revisionId)){await repo.delivery(event.id,event.checkpoint,{kind:'excluded',reason:'policy_revised'});continue;}
   type Work={after:string|null;visited:string[];bootstrapId:string|null;discovery:boolean;childRunId:string|null;pageId:string|null;blockedReason:string|null;blockedMaintenanceRunId:string|null;outcomes:Array<{pageId:string;runId:string|null;status:string}>};
   const work:Work={after:null,visited:[],bootstrapId:null,discovery:false,childRunId:null,pageId:null,blockedReason:null,blockedMaintenanceRunId:null,outcomes:[],...event.checkpoint};
   if(work.childRunId){const child=await new WikiCurator(this.options).get(work.childRunId);if(child&&['queued','analyzing','awaiting_review','failed','canceled','rejected'].includes(child.status)){work.blockedReason=['queued','analyzing'].includes(child.status)?null:child.checkpoint.error??'organization.errors.review';await repo.delivery(event.id,work,null,child.status==='failed'?60000:2000);continue;}work.blockedReason=null;work.outcomes.push({pageId:work.pageId!,runId:work.childRunId,status:child?.status??'missing'});work.after=work.pageId;work.childRunId=null;work.pageId=null;await repo.delivery(event.id,work,null,0);continue;}
   const unresolved=work.outcomes.some(outcome=>!['applied','causal_output_already_applied','scope_decision'].includes(outcome.status));
   if(work.bootstrapId&&unresolved){work.blockedReason??='organization.errors.review';await repo.delivery(event.id,work,null);continue;}
   if(work.bootstrapId){const run=await repo.get(work.bootstrapId);if(run&&['complete','attention','canceled'].includes(run.checkpoint.state)){await repo.delivery(event.id,work,{kind:run.checkpoint.state,runId:run.id,outcomes:work.outcomes});}else await repo.delivery(event.id,work,null);continue;}
   const allowed=await curator.allowed(policy),dependent=(await repo.dependents(event.kind,event.input_id,work.after,1))[0];
   if(dependent){
    const key=dependent.id+':'+dependent.revision_id;
    if(work.visited.length>=100){await repo.delivery(event.id,work,{kind:'attention',reason:'propagation_limit',remainingAfter:work.after,outcomes:work.outcomes});continue;}
    if(!work.visited.includes(key))work.visited.push(key);work.pageId=dependent.id;
    const skip=async(reason:string)=>{work.outcomes.push({pageId:dependent.id,runId:null,status:reason});work.after=dependent.id;work.pageId=null;await repo.delivery(event.id,work,null,0);};
    if(dependent.source_ids.some((id:string)=>!allowed.includes(id))){await skip('scope_decision');continue;}
    if(event.causal_run_id&&await repo.causalApplied(event.causal_run_id,dependent.id)){await skip('causal_output_already_applied');continue;}
    if(await repo.sourceBusy(dependent.source_ids)){await repo.delivery(event.id,work,null);continue;}
    try{
     const pages=await curator.exactPages(policy,[dependent.id]),page=pages[0]!;let chunkIds=[...new Set(page.evidence.filter(e=>e.current).map(e=>e.chunkId))];if(page.evidence.some(e=>!e.current)){const replacement=await curator.evidencePage(dependent.source_ids,null,policy.limits.originalPassages);if(replacement.next)throw new Error('organization.errors.scopeLimit');chunkIds=[...new Set([...chunkIds,...replacement.items.map(e=>e.chunkId)])];}
     // Required target groups keep complete originals; oversize targets remain explicit attention.
     if(!chunkIds.length||chunkIds.length>policy.limits.originalPassages)throw new Error('organization.errors.scopeLimit');
     const generation=await repo.inputGeneration(dependent.source_ids,event.kind==='wiki_section'||event.kind==='wiki_page'?event.fingerprint:null);
     const child=await new WikiCurator(this.options).start({policyId:policy.id,policyRevisionId:policy.revisionId,sourceIds:dependent.source_ids,noteIds:[],evidenceChunkIds:chunkIds},null,{targetPageId:dependent.id,inputGeneration:generation,causalRunId:event.causal_run_id??null,causalGroupId:event.causal_group_id??null});
     work.blockedReason=null;work.blockedMaintenanceRunId=null;work.childRunId=child!.id;await repo.delivery(event.id,work,null,0);
    }catch(error){work.blockedReason=organizationAiFailure(error,'organization.errors.failed');work.blockedMaintenanceRunId=authority?.id??null;if(!installed&&['organization.errors.scopeLimit','organization.errors.scopeDecision'].includes(work.blockedReason)){work.outcomes.push({pageId:dependent.id,runId:null,status:work.blockedReason});work.after=dependent.id;work.pageId=null;work.blockedReason=null;}await repo.delivery(event.id,work,null,2000);}
    continue;
   }
   if(unresolved){work.blockedReason??='organization.errors.review';await repo.delivery(event.id,work,null);continue;}
   // New material has no dependents: a separate once-per-current-generation discovery path.
   if(event.causal_run_id||work.discovery||event.kind.startsWith('wiki_')){await repo.delivery(event.id,work,{kind:'inspected',outcomes:work.outcomes});continue;}
   const enabledAt=await repo.enabledAt(policy.id,policy.revisionId);if(enabledAt&&new Date(event.event_created_at).getTime()<enabledAt.getTime()){await repo.delivery(event.id,work,{kind:'inspected',reason:'initial_collection_requires_bootstrap',outcomes:work.outcomes});continue;}
   const sources=[...new Set<string>(event.source_ids.filter((id:unknown):id is string=>typeof id==='string'))].filter(id=>allowed.includes(id));
   if(!sources.length){await repo.delivery(event.id,work,{kind:'excluded',reason:'outside_scope_or_deleted',outcomes:work.outcomes});continue;}
   if(await repo.sourceBusy(sources)){await repo.delivery(event.id,work,null);continue;}
   try{const started=await this.command({command:'bootstrap',input:{policyId:policy.id,policyRevisionId:policy.revisionId,sourceIds:sources}}) as WikiBootstrap;work.discovery=true;work.bootstrapId=started.id;await repo.delivery(event.id,work,null,0);}catch(error){await repo.delivery(event.id,work,{kind:'attention',reason:organizationAiFailure(error,'organization.errors.failed'),outcomes:work.outcomes});}

  }
 }
 private generation(snapshot:Pick<WikiBootstrap['snapshot'],'policy'|'profile'|'promptPin'|'contentLanguage'>){return collectionGenerationHash({policy:snapshot.policy.revisionId,profile:snapshot.profile.identityHash,parameters:snapshot.profile.parameters,language:snapshot.contentLanguage,prompts:promptFingerprint(['organization.curator','organization.curator.repair','organization.curator.support'],snapshot.promptPin,snapshot.profile.provider)});}
 private async advance(run:WikiBootstrap){const repo=createWikiCollectionRepository(this.pool()),curator=createWikiCuratorRepository(this.pool()),checkpoint=run.checkpoint;
  const policy=await curator.policy(run.snapshot.policy.id);if(policy?.state!=='enabled'||policy.revisionId!==run.snapshot.policy.revisionId){checkpoint.state='paused';checkpoint.error='organization.errors.policy';await repo.checkpoint(run);return;}
  try{
   const profile=await this.options.ai.pinOrganizationProfile(run.snapshot.policy.profileOverrideId??undefined,run.snapshot.profile.privacy);
   if(profile.identityHash!==run.snapshot.profile.identityHash)throw new Error('organization.errors.modelChanged');
   if(checkpoint.childRunId){
    const child=await new WikiCurator(this.options).get(checkpoint.childRunId);if(!child)throw new Error('organization.errors.invalid');
    if(['queued','analyzing'].includes(child.status))return;
    if(child.status!=='applied'){checkpoint.state='attention';checkpoint.error=child.checkpoint.error??'organization.errors.review';if(checkpoint.sourceId)await repo.coverage(policy.id,checkpoint.sourceId,checkpoint.sourceFingerprint!,'attention',checkpoint.sourceCovered,run.id);await repo.checkpoint(run);return;}
    if(checkpoint.phase==='notes'){checkpoint.noteCursor+=child.snapshot.references.filter(r=>r.kind==='atomic_note').length||1;checkpoint.completedGroups++;checkpoint.childRunId=null;await repo.checkpoint(run);return;}
    checkpoint.sourceCovered+=checkpoint.pendingOriginals;checkpoint.completedGroups++;checkpoint.childRunId=null;checkpoint.afterChunk=checkpoint.nextChunk;
    await repo.coverage(policy.id,checkpoint.sourceId!,checkpoint.sourceFingerprint!,checkpoint.nextChunk||run.snapshot.noteIds.length?'partial':'integrated',checkpoint.sourceCovered,run.id);
    if(!checkpoint.nextChunk){checkpoint.completedSources++;checkpoint.afterSource=checkpoint.sourceId;checkpoint.sourceId=null;checkpoint.sourceCovered=0;checkpoint.afterChunk=null;checkpoint.sourceFingerprint=null;}
    await repo.checkpoint(run);return;
   }
   if(!checkpoint.sourceId){
    const assessment=await repo.assessment(policy,checkpoint.afterSource,1,run.snapshot.sourceIds,this.generation(run.snapshot)),source=assessment.sources[0];
    if(!source){if(checkpoint.noteCursor<run.snapshot.noteIds.length){checkpoint.phase='notes';const selectedNotes=run.snapshot.noteIds.slice(checkpoint.noteCursor,checkpoint.noteCursor+(policy.operations.includes('evolve_notes')?6:1));const note=await curator.noteOriginals(selectedNotes[0]!);for(const id of selectedNotes.slice(1)){const next=await curator.noteOriginals(id);if(new Set([...note.chunk_ids,...next.chunk_ids]).size>policy.limits.originalPassages){selectedNotes.splice(selectedNotes.indexOf(id));break;}note.chunk_ids=[...new Set([...note.chunk_ids,...next.chunk_ids])];note.source_ids=[...new Set([...note.source_ids,...next.source_ids])];}if(note.chunk_ids.length>policy.limits.originalPassages)throw new Error('organization.errors.scopeLimit');const child=await withPromptPin(run.snapshot.promptPin,()=>new WikiCurator(this.options).start({policyId:policy.id,policyRevisionId:policy.revisionId,sourceIds:note.source_ids,noteIds:selectedNotes,...(policy.operations.includes('evolve_notes')?{intent:'consolidation' as const}:{}),evidenceChunkIds:note.chunk_ids},null,{parentBootstrapId:run.id}));checkpoint.childRunId=child!.id;await repo.checkpoint(run);return;}await repo.finishCoverage(run.id);checkpoint.state='complete';await repo.checkpoint(run);return;}
    if(source.coverage==='integrated'||!source.originals){await repo.coverage(policy.id,source.id,source.fingerprint,source.originals?'integrated':'cataloged',source.originals,run.id);checkpoint.afterSource=source.id;checkpoint.completedSources++;if(!source.originals)checkpoint.catalogedSources++;await repo.checkpoint(run);return;}
    checkpoint.sourceId=source.id;checkpoint.sourceFingerprint=source.fingerprint;checkpoint.sourceCovered=0;await repo.checkpoint(run);
   }
   if(await repo.sourceBusy([checkpoint.sourceId!]))return;
   const originals=await curator.evidencePage([checkpoint.sourceId!],checkpoint.afterChunk,Math.min(6,policy.limits.originalPassages));
   if(!originals.items.length){checkpoint.afterSource=checkpoint.sourceId;checkpoint.sourceId=null;checkpoint.afterChunk=null;await repo.checkpoint(run);return;}
   let selected=originals.items,child:Awaited<ReturnType<WikiCurator['start']>>=null,next=originals.next;
   while(!child){try{child=await withPromptPin(run.snapshot.promptPin,()=>new WikiCurator(this.options).start({policyId:policy.id,policyRevisionId:policy.revisionId,sourceIds:[checkpoint.sourceId!],noteIds:[],evidenceChunkIds:selected.map(e=>e.chunkId)},null,{parentBootstrapId:run.id}));}catch(error){if(selected.length<=1||!String(error).match(/organization.errors.(context|scopeLimit)/))throw error;selected=selected.slice(0,Math.max(1,Math.floor(selected.length/2)));next=selected.at(-1)!.chunkId;}}
   checkpoint.childRunId=child.id;checkpoint.pendingOriginals=selected.length;checkpoint.nextChunk=next;await repo.coverage(policy.id,checkpoint.sourceId!,checkpoint.sourceFingerprint!,'analyzing',checkpoint.sourceCovered,run.id);await repo.checkpoint(run);

  }catch(error){checkpoint.state='attention';checkpoint.error=organizationAiFailure(error,'organization.errors.failed');checkpoint.attentionSources++;if(checkpoint.sourceId)await repo.coverage(policy.id,checkpoint.sourceId,checkpoint.sourceFingerprint!,'attention',checkpoint.sourceCovered,run.id);await repo.checkpoint(run);}
 }
}
