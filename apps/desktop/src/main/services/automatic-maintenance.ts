import {createAutomaticMaintenanceRepository,createWikiCuratorRepository,createWikiCollectionRepository,createOrganizationRepository,createInvestigationRepository,type PgPool,type JobRecord} from '@app/db';
import {AutomaticMaintenanceCommandSchema,AutomaticMaintenanceDashboardSchema,automaticClock,type AutomaticMaintenanceRun,type AutomaticRoutinePolicy,type AutomaticMaintenanceCommandSchema as CommandSchema} from '@app/domain';
import type {z} from 'zod';
import {capturePromptPin,withPromptPin} from './prompt-runtime.js';
import {WikiCollection} from './wiki-collection.js';
import type {WikiCurator} from './wiki-curator.js';
type Options=ConstructorParameters<typeof WikiCurator>[0]&{idleSeconds?:()=>number;aiBusy?:()=>boolean;investigations?:{tick:(r:AutomaticMaintenanceRun)=>Promise<void>}};
/** Versioned automatic branch of MaintenanceService; the supervisor remains the sole dispatcher. */
export class AutomaticMaintenance {
 constructor(private options:Options){}
 private pool(){const pool=this.options.getPool();if(!pool)throw new Error('wiki.errors.unavailable');return pool;}
 private now(){return new Date((this.options.now??Date.now)());}
 private repo(){return createAutomaticMaintenanceRepository(this.pool());}
 async command(raw:z.input<typeof CommandSchema>){const c=AutomaticMaintenanceCommandSchema.parse(raw),repo=this.repo();
  if(c.command==='automaticRetireLegacy')return repo.retireLegacy(c.scheduleIds);
  if(c.command==='automaticDashboard'){const month=this.now().toISOString().slice(0,7);return AutomaticMaintenanceDashboardSchema.parse({policyState:(await createWikiCuratorRepository(this.pool()).policy(c.policyId))?.state??'draft',schedules:await repo.schedules(c.policyId),runs:await repo.history(c.policyId),month,reserved:await repo.monthly(c.policyId,month)});}
  if(c.command==='automaticCancel'){for(const id of await repo.cancel(c.runId)??[])await this.options.cancelJob(id);return null;}
  if(c.command==='automaticSave'){const saved=await repo.save(c.scheduleId,c.expectedRevision,c.policy,this.now());for(const id of await repo.canceledChildren(c.scheduleId))await this.options.cancelJob(id);return saved;}
  const s=(await repo.schedules()).find(s=>s.id===c.scheduleId);if(!s)throw new Error('maintenance.errors.scope');const result=await repo.admit([s],this.now(),true,c.requestId,await this.context(s.policy));await this.tick();this.options.wake();return result?repo.get(result.id):null;
 }
 private async context(p:AutomaticRoutinePolicy){const unfinished=(await createWikiCollectionRepository(this.pool()).list(p.policyId)).find(b=>b.snapshot.policy.revisionId===p.policyRevisionId&&['running','attention'].includes(b.checkpoint.state));if(unfinished)return {profile:unfinished.snapshot.profile,promptPin:unfinished.snapshot.promptPin,contentLanguage:unfinished.snapshot.contentLanguage};let profile=null;try{profile=await this.options.ai.pinOrganizationProfile((await createWikiCuratorRepository(this.pool()).policy(p.policyId))?.profileOverrideId??undefined,'allow_remote');}catch{}return {profile,promptPin:capturePromptPin(null),contentLanguage:await this.options.contentLanguage()};}
 private async blocker(r:AutomaticMaintenanceRun){const p=r.snapshot.policy,policy=await createWikiCuratorRepository(this.pool()).policy(p.policyId);if(policy?.state!=='enabled'||policy.revisionId!==r.snapshot.policyRevisionId||!p.enabled)return 'organization.errors.policy';if(!r.snapshot.profile)return 'organization.errors.model';if(!r.snapshot.manual&&!r.checkpoint.manualRequested&&(this.options.idleSeconds?.()??Infinity)<p.idleSeconds)return 'maintenance.errors.idle';if(this.options.aiBusy?.())return 'maintenance.errors.busy';return this.repo().blocker(p.policyId);}
 async tick(){const repo=this.repo(),now=this.now(),curator=createWikiCuratorRepository(this.pool());
  for(const p of await curator.policies())if(await repo.installed(p.id))await createWikiCollectionRepository(this.pool()).reconcileDeliveries(p);
  const groups=new Map<string,Awaited<ReturnType<typeof repo.schedules>>>();
  for(const s of await repo.schedules()){if(!s.policy.enabled||new Date(s.nextAt)>now)continue;const policy=await curator.policy(s.policy.policyId);if(policy?.state!=='enabled'||policy.revisionId!==s.policy.policyRevisionId)continue;if(s.policy.kind==='incremental'){const changed=await repo.changedAt(s.policy.policyId);if(!changed||now.getTime()-Date.parse(changed)<s.policy.cadence.debounceMs)continue;}
   const key=s.id;groups.set(key,[...groups.get(key)??[],s]);}
  for(const schedules of groups.values()){try{await repo.admit(schedules,now,false,undefined,await this.context(schedules[0]!.policy));}catch{/* A concurrent policy edit is observed on the next bounded poll. */}}
  const owners=new Set<string>();for(const r of (await repo.active()).toSorted((a,b)=>Number(!!b.checkpoint.startedAt)-Number(!!a.checkpoint.startedAt))){
   const waiting=owners.has(r.snapshot.policy.policyId);owners.add(r.snapshot.policy.policyId);
   // Resolve review/recovery state before clock accrual or granting inference authority.
   const existing=r.checkpoint.bootstrapId?await createWikiCollectionRepository(this.pool()).get(r.checkpoint.bootstrapId):null;
   const child=existing?.checkpoint.childRunId?await createOrganizationRepository(this.pool()).get(existing.checkpoint.childRunId):null;
   const childBlocked=child&&['awaiting_review','failed','canceled','rejected'].includes(child.status)?String(child.checkpoint.error??'organization.errors.review'):null;
   const bootstrapBlocked=existing&&['attention','paused','canceled'].includes(existing.checkpoint.state)?existing.checkpoint.error??'organization.errors.review':null;
   const deliveryAttention=await repo.deliveryAttention(r.snapshot.policy.policyId,r.id);
   const retainedAttention=!r.checkpoint.impactDeliveryId&&r.status==='awaiting_review'&&r.checkpoint.incomplete&&(!existing||existing.checkpoint.state!=='running')?r.checkpoint.reason??'organization.errors.review':null;
   const attention=childBlocked??bootstrapBlocked??deliveryAttention?.reason??retainedAttention;
   if(deliveryAttention)r.checkpoint.impactDeliveryId=deliveryAttention.id;else if(r.checkpoint.impactDeliveryId){r.checkpoint.impactDeliveryId=null;r.checkpoint.incomplete=false;}
   const reason=attention??(waiting?'maintenance.errors.wait':await this.blocker(r));r.checkpoint=automaticClock(r.checkpoint,now,!reason,reason);r.updatedAt=now.toISOString();
   if(attention){r.status=deliveryAttention?.exhaustible||/maintenance.errors.(budget|period)|organization.errors.deadline/.test(attention)&&existing&&!existing.checkpoint.childRunId?'failed':'awaiting_review';r.checkpoint.incomplete=true;if(existing){r.checkpoint.completedGroups=existing.checkpoint.completedGroups;r.checkpoint.completedSources=existing.checkpoint.completedSources;r.checkpoint.catalogedSources=existing.checkpoint.catalogedSources;}await repo.checkpoint(r);continue;}
   if(reason){if(reason==='organization.errors.model'){r.status='failed';r.checkpoint.incomplete=true;}await repo.checkpoint(r);continue;}
   if(r.checkpoint.executionMs>=r.snapshot.policy.executionMs){r.status='failed';r.checkpoint.reason='organization.errors.deadline';r.checkpoint.incomplete=true;await repo.checkpoint(r);continue;}
   r.checkpoint.startedAt??=now.toISOString();r.status='inspecting';await repo.checkpoint(r);
   // Existing delivery cursors repair exact stale consumers before broad coverage.
   const pending=await repo.pending(r.snapshot.policy.policyId);
   if(!pending){
   await this.options.investigations?.tick(r);
   const investigationAttention=this.options.investigations?await createInvestigationRepository(this.pool()).attention(r.snapshot.policy.policyId):null;if(investigationAttention){r.status=/^(maintenance.errors.(budget|period)|organization.errors.deadline)$/.test(investigationAttention)?"failed":"awaiting_review";r.checkpoint.reason=investigationAttention;r.checkpoint.incomplete=true;await repo.checkpoint(r);continue;}
   }
   if(existing){r.checkpoint.completedGroups=existing.checkpoint.completedGroups;r.checkpoint.completedSources=existing.checkpoint.completedSources;r.checkpoint.catalogedSources=existing.checkpoint.catalogedSources;if(existing.checkpoint.state==='complete'&&!pending){r.status=r.reservation.calls?'applied':'no_change';r.checkpoint.phase='complete';}else if(['attention','canceled','paused'].includes(existing.checkpoint.state)){r.status=/maintenance.errors.(budget|period)|organization.errors.deadline/.test(existing.checkpoint.error??'')&&!existing.checkpoint.childRunId?'failed':'awaiting_review';r.checkpoint.reason=existing.checkpoint.error??'organization.errors.review';r.checkpoint.incomplete=true;}await repo.checkpoint(r);continue;}
   if(pending)continue;
   if(r.snapshot.policy.kind==='incremental'){r.status=r.reservation.calls?'applied':'no_change';r.checkpoint.phase='complete';await repo.checkpoint(r);continue;}
   try{const policy=await curator.policy(r.snapshot.policy.policyId);const unfinished=(await createWikiCollectionRepository(this.pool()).list(policy!.id)).find(b=>b.snapshot.policy.revisionId===policy!.revisionId&&(b.checkpoint.state==='running'||b.checkpoint.state==='attention'&&!b.checkpoint.childRunId&&/maintenance.errors.(budget|period)|organization.errors.deadline/.test(b.checkpoint.error??'')));if(unfinished?.checkpoint.state==='attention')await new WikiCollection(this.options).command({command:'bootstrapResume',id:unfinished.id});const bootstrap=unfinished??await withPromptPin(r.snapshot.promptPin,async()=>new WikiCollection(this.options).command({command:'bootstrap',input:{policyId:policy!.id,policyRevisionId:policy!.revisionId,noteIds:['weekly','monthly'].includes(r.snapshot.policy.kind)?await curator.noteIds(await curator.allowed(policy!)):[]}})) as Awaited<ReturnType<ReturnType<typeof createWikiCollectionRepository>['get']>>;r.checkpoint.bootstrapId=bootstrap!.id;r.checkpoint.phase='coverage';await repo.checkpoint(r);}catch(error){r.checkpoint.reason=String(error).match(/(?:organization|maintenance)\.errors\.[A-Za-z]+/)?.[0]??'maintenance.errors.failed';r.checkpoint.incomplete=true;r.status='awaiting_review';await repo.checkpoint(r);}
  }
 }
 async isAutomatic(job:JobRecord){if(!this.options.getPool())return false;return !!await this.repo().get(String(job.payload.maintenanceRunId));}
}
