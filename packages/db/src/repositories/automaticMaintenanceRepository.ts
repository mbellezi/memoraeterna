import {isDeepStrictEqual} from 'node:util';
import { randomUUID,createHash } from 'node:crypto';
import {AutomaticMaintenanceAttentionSchema,AutomaticAllowanceSchema,AutomaticMaintenanceRunSchema,AutomaticMaintenanceCheckpointSchema,AutomaticRoutineScheduleSchema,AutomaticMaintenancePreviewSchema,automaticRoutinePresets,automaticNext,type AutomaticWikiPolicy,type AutomaticRoutinePolicy,type AutomaticMaintenanceRun} from '@app/domain';
import { taskHistoryVisibleSql } from './taskHistory.js';
import { recordValidationRejection } from './knowledgeRejections.js';
import type {PgPool,PgClient} from '../client.js';
type Db=Pick<PgPool,'query'>;
const stamp=(v:unknown)=>new Date(v as string).toISOString();
const version='automatic-maintenance-v1';
const live="status in ('queued','inspecting','analyzing','awaiting_review')";
export const automaticScopeKey=(scope:AutomaticWikiPolicy['scope'])=>createHash('sha256').update(JSON.stringify({...scope,sourceIds:[...new Set(scope.sourceIds)].sort(),excludedSourceIds:[...new Set(scope.excludedSourceIds)].sort()})).digest('hex');
const schedule=(r:Record<string,any>)=>AutomaticRoutineScheduleSchema.parse({id:r.id,revision:r.revision,policy:r.policy,nextAt:stamp(r.next_at),lastRunId:r.last_run_id,lastError:r.last_error,updatedAt:stamp(r.updated_at)});
const run=(r:Record<string,any>)=>AutomaticMaintenanceRunSchema.parse({id:r.id,jobId:r.job_id,scheduleIds:r.schedule_ids,status:r.status,snapshot:r.snapshot,checkpoint:r.checkpoint,reservation:r.reservation,createdAt:stamp(r.created_at),updatedAt:stamp(r.updated_at)});
const policyLock=async(db:Db,id:string)=>{await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['wiki-policy:'+id]);};
/** Read the retained decision before creating an occurrence, even after its parent was canceled. */
async function retainedDeliveryBlock(db:Db,policyId:string,revisionId:string){
 let row=(await db.query(`select child.id,child.status,
   case when child.checkpoint->'supportAssessment'->'verdict'->>'supported'='false' then 'organization.errors.unsupported'
   else coalesce(child.checkpoint->>'error','organization.errors.review') end reason
   from knowledge_impact_deliveries d left join organization_runs b on b.id::text=d.checkpoint->>'bootstrapId'
   join organization_runs child on child.id::text=coalesce(d.checkpoint->>'childRunId',b.checkpoint->>'childRunId')
   where d.consumer='curator' and d.consumer_key=$1 and right(d.input_generation,36)=$2
   and (d.status not in('acknowledged','excluded') or d.receipt->>'kind'='attention'
     or d.receipt->>'kind'='rejected' and not exists(
       select 1 from knowledge_impact_deliveries next left join organization_runs next_bootstrap on next_bootstrap.id::text=next.checkpoint->>'bootstrapId'
       left join organization_runs next_child on next_child.id::text=coalesce(next.checkpoint->>'childRunId',next_bootstrap.checkpoint->>'childRunId')
       where next.consumer='curator' and next.consumer_key=$1 and right(next.input_generation,36)=$2
       and next.status not in('acknowledged','excluded') and (next_child.id is null or next_child.status in('queued','analyzing','applied'))))
   and child.snapshot->'policy'->>'id'=$1 and child.snapshot->'policy'->>'revisionId'=$2
   and child.status in('awaiting_review','failed','rejected','canceled')
   order by d.created_at,d.id limit 1`,[policyId,revisionId])).rows[0];
 // Initial collection work may have no impact delivery. Retain its negative
 // outcome too, while allowing a genuinely new input delivery to be inspected.
 if(!row)row=(await db.query(`select child.id,child.status,
   case when child.checkpoint->'supportAssessment'->'verdict'->>'supported'='false' then 'organization.errors.unsupported' else child.checkpoint->>'error' end reason
   from organization_runs child where child.snapshot->>'version'='wiki-curator-v2' and child.status='rejected'
   and child.snapshot->'policy'->>'id'=$1 and child.snapshot->'policy'->>'revisionId'=$2
   and child.snapshot->>'maintenanceRunId' is not null
   and not exists(select 1 from knowledge_impact_deliveries linked left join organization_runs b on b.id::text=linked.checkpoint->>'bootstrapId'
     where linked.consumer='curator' and linked.consumer_key=$1 and child.id::text=coalesce(linked.checkpoint->>'childRunId',b.checkpoint->>'childRunId'))
   and not exists(select 1 from knowledge_impact_deliveries next where next.consumer='curator' and next.consumer_key=$1
     and right(next.input_generation,36)=$2 and next.status<>'acknowledged')
   order by child.updated_at desc,child.id limit 1`,[policyId,revisionId])).rows[0];
 return row?{runId:row.id as string,reason:row.reason as string,status:row.status as string}:null;
}
/** The live parent ceiling is shared; admitted occurrence limits and ledgers stay immutable. */
async function monthlyAllowance(db:Db,policyId:string){
 const rows=(await db.query("select policy->'monthAllowance' allowance from maintenance_schedules where retired_at is null and policy->>'version'=$1 and policy->>'policyId'=$2 order by id",[version,policyId])).rows;
 if(!rows.length)return null;
 const allowance=AutomaticAllowanceSchema.parse(rows[0]!.allowance);
 if(rows.some(r=>!isDeepStrictEqual(AutomaticAllowanceSchema.parse(r.allowance),allowance)))throw new Error('maintenance.errors.conflict');
 return allowance;
}
async function recordedBudgetUsage(db:Db,policyId:string,period:string|null=null,runId:string|null=null){
 const row=(await db.query(`select count(a.id)::int calls,
  (coalesce(sum(a.input_tokens),0)+coalesce(sum(a.output_tokens),0))::float tokens,
  sum(a.cost_estimate)::float spend,
  count(a.id)<>count(a.input_tokens) or count(a.id)<>count(a.output_tokens) incomplete
  from automatic_routine_calls c join organization_steps s on s.run_id=c.organization_run_id and s.sequence=c.sequence
  join ai_task_runs a on a.id=s.ai_task_run_id
  where c.policy_id=$1 and ($2::uuid is null or c.run_id=$2)
  and ($3::text is null or to_char(a.started_at at time zone 'UTC','YYYY-MM')=$3)`,[policyId,runId,period])).rows[0];
 return row as {calls:number;tokens:number;spend:number|null;incomplete:boolean};
}
export function automaticBudgetExceeded(used:{calls:number;tokens:number;spend:number|null},limit:AutomaticRoutinePolicy['allowance']){
 return used.calls>limit.calls||used.tokens>limit.tokens||limit.spend!==null&&used.spend!==null&&used.spend>limit.spend;
}
async function checkRecordedBudget(db:Db,r:AutomaticMaintenanceRun,now:Date){
 const policyId=r.snapshot.policy.policyId,ceiling=await monthlyAllowance(db,policyId);
 if(!ceiling)throw new Error('maintenance.errors.revoked');
 if(automaticBudgetExceeded(await recordedBudgetUsage(db,policyId,null,r.id),r.snapshot.policy.allowance))throw new Error('maintenance.errors.budget');
 if(automaticBudgetExceeded(await recordedBudgetUsage(db,policyId,now.toISOString().slice(0,7)),ceiling))throw new Error('maintenance.errors.period');
}
/** Called inside the activation transaction, using the exact disclosed preview. */
export async function installAutomaticRoutines(db:Db,policy:AutomaticWikiPolicy,raw:unknown,now=new Date()){
 const preview=AutomaticMaintenancePreviewSchema.parse(raw);
 const currentMonth=await monthlyAllowance(db,policy.id);
 if(preview.routines.some(r=>!isDeepStrictEqual(r.policy.monthAllowance,preview.monthAllowance))||currentMonth&&!isDeepStrictEqual(currentMonth,preview.monthAllowance))throw new Error('maintenance.errors.conflict');
 for(const item of preview.routines){const p=item.policy;if(p.policyId!==policy.id||p.policyRevisionId!==policy.revisionId||p.scopeKey!==automaticScopeKey(policy.scope))throw new Error('organization.errors.conflict');
  const bound=(await db.query('select b.schedule_id,s.policy from automatic_routine_bindings b join maintenance_schedules s on s.id=b.schedule_id where b.policy_id=$1 and b.kind=$2 and b.scope_key=$3',[policy.id,p.kind,p.scopeKey])).rows[0];
  if(bound){if(item.scheduleId!==bound.schedule_id||!isDeepStrictEqual({...bound.policy,policyRevisionId:policy.revisionId,promptIds:p.promptIds},p))throw new Error('organization.errors.conflict');await db.query('update maintenance_schedules set policy=$2,revision=revision+1,updated_at=$3 where id=$1',[bound.schedule_id,p,now]);continue;}
  if(item.scheduleId)throw new Error('organization.errors.conflict');const id=randomUUID();await db.query('insert into maintenance_schedules(id,policy,next_at) values($1,$2,$3)',[id,p,automaticNext(p,now)]);await db.query('insert into automatic_routine_bindings(policy_id,kind,scope_key,preset_version,schedule_id) values($1,$2,$3,$4,$5)',[policy.id,p.kind,p.scopeKey,p.presetVersion,id]);
 }
 // A changed scope revokes old bindings, retaining their schedules and receipts.
 await db.query("update maintenance_schedules set retired_at=coalesce(retired_at,now()),policy=jsonb_set(policy,'{enabled}','false'),last_error='organization.errors.policy' where id in(select schedule_id from automatic_routine_bindings where policy_id=$1 and scope_key<>$2)",[policy.id,automaticScopeKey(policy.scope)]);
 await db.query(`update maintenance_runs set status='canceled',updated_at=$2 where snapshot->>'version'=$3 and snapshot->'policy'->>'policyId'=$1 and snapshot->>'policyRevisionId'<>$4 and ${live}`,[policy.id,now,version,policy.revisionId]);
}
export async function validateAutomaticAuthority(db:Db,runId:string,policyId:string,lock=false,now=new Date()){
 const row=(await db.query('select * from maintenance_runs where id=$1'+(lock?' for share':''),[runId])).rows[0];if(!row||!['inspecting','analyzing'].includes(row.status))throw new Error('maintenance.errors.revoked');const r=run(row);
 if(r.snapshot.policy.policyId!==policyId||r.checkpoint.reason||r.checkpoint.executionMs>=r.snapshot.policy.executionMs)throw new Error(r.checkpoint.reason??'organization.errors.deadline');
 if(r.checkpoint.lastTickAt&&r.checkpoint.executionMs+Math.max(0,now.getTime()-Date.parse(r.checkpoint.lastTickAt))>=r.snapshot.policy.executionMs)throw new Error('organization.errors.deadline');
 for(const id of r.scheduleIds){const s=(await db.query('select policy from maintenance_schedules where id=$1'+(lock?' for share':''),[id])).rows[0];if(!s?.policy.enabled||s.policy.policyRevisionId!==r.snapshot.policyRevisionId)throw new Error('maintenance.errors.revoked');}
 return r;
}
/** Human acceptance is a retained proposal action, never permission to restart inference. */
export async function validateAutomaticReviewAuthority(db:Db,runId:string,policyId:string,policyRevisionId:string,lock=false){
 const row=(await db.query('select * from maintenance_runs where id=$1'+(lock?' for share':''),[runId])).rows[0];if(!row)throw new Error('maintenance.errors.revoked');const r=run(row);
 if(r.snapshot.policy.policyId!==policyId||r.snapshot.policyRevisionId!==policyRevisionId)throw new Error('maintenance.errors.revoked');
 for(const id of r.scheduleIds){const schedule=(await db.query('select policy from maintenance_schedules where id=$1'+(lock?' for share':''),[id])).rows[0];if(!schedule?.policy.enabled||schedule.policy.policyRevisionId!==policyRevisionId)throw new Error('maintenance.errors.revoked');}
 return r;
}
export function createAutomaticMaintenanceRepository(pool:PgPool){
 const tx=async<T>(fn:(db:PgClient)=>Promise<T>)=>{const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(e){await db.query('rollback');throw e;}finally{db.release();}};
 const api={
 admissionBlock:(policyId:string,revisionId:string)=>retainedDeliveryBlock(pool,policyId,revisionId),
 async settleRejections(policyId:string,revisionId:string){return tx(async db=>{
  await policyLock(db,policyId);
  const failed=(await db.query("select id from organization_runs where snapshot->>'version'='wiki-curator-v2' and snapshot->'policy'->>'id'=$1 and status='failed' and checkpoint->>'error' in('organization.errors.evidence','organization.errors.invalid','organization.errors.unsupported') order by created_at,id limit 100",[policyId])).rows;
  for(const row of failed)await recordValidationRejection(db,row.id);
  // A terminal child is an outcome, not another request for human review. Receipts retain its identity.
  await db.query(`update knowledge_impact_deliveries d set status='acknowledged',lease_until=null,defer_until=null,updated_at=clock_timestamp(),
    receipt=jsonb_build_object('kind','rejected','runId',child.id,'reason',coalesce(child.checkpoint->>'error','organization.errors.canceled'),'inputFingerprint',child.snapshot->>'inputFingerprint')
    from organization_runs child where d.consumer='curator' and d.consumer_key=$1
    and (d.status<>'acknowledged' or d.receipt->>'kind'='attention')
    and (child.id::text=d.checkpoint->>'childRunId' or child.id::text=(select b.checkpoint->>'childRunId' from organization_runs b where b.id::text=d.checkpoint->>'bootstrapId'))
    and child.snapshot->'policy'->>'id'=$1 and (child.status in('rejected','canceled') or child.status='failed'
      and (coalesce((child.checkpoint->>'calls')::int,0)>0 or coalesce(child.checkpoint->>'error','') !~ '^(maintenance.errors.(budget|period|wait|busy)|organization.errors.(deadline|model|modelChanged))$'))`,[policyId]);
  await db.query(`update organization_runs b set status='rejected',checkpoint=jsonb_set(b.checkpoint,'{state}','"rejected"'),updated_at=clock_timestamp()
    from organization_runs child where b.snapshot->>'version'='wiki-bootstrap-v1' and b.snapshot->'policy'->>'id'=$1
    and b.status in('queued','analyzing','awaiting_review','failed') and child.id::text=b.checkpoint->>'childRunId' and child.status='rejected'`,[policyId]);
  await db.query(`update maintenance_runs r set status='rejected',updated_at=clock_timestamp(),
    checkpoint=jsonb_set(jsonb_set(r.checkpoint,'{incomplete}','true'),'{reason}',to_jsonb(coalesce(d.receipt->>'reason',r.checkpoint->>'reason','organization.errors.failed')))
    from knowledge_impact_deliveries d where r.snapshot->'policy'->>'policyId'=$1 and r.status='awaiting_review'
    and d.receipt->>'kind'='rejected' and (d.id::text=r.checkpoint->>'impactDeliveryId'
      or d.receipt->>'runId'=r.checkpoint->>'reviewChildId')
    and not exists(select 1 from organization_runs review where review.snapshot->>'maintenanceRunId'=r.id::text and review.status='awaiting_review')`,[policyId]);
  await db.query(`update maintenance_runs r set status='rejected',updated_at=clock_timestamp(),
    checkpoint=jsonb_set(jsonb_set(r.checkpoint,'{incomplete}','true'),'{reason}',to_jsonb(coalesce(child.checkpoint->>'error','organization.errors.rejected')))
    from organization_runs child where r.snapshot->'policy'->>'policyId'=$1 and r.status='awaiting_review' and child.status='rejected'
    and (child.snapshot->>'maintenanceRunId'=r.id::text or child.id::text=r.checkpoint->>'reviewChildId'
      or child.id::text=(select b.checkpoint->>'childRunId' from organization_runs b where b.id::text=r.checkpoint->>'bootstrapId'))
    and not exists(select 1 from organization_runs review where review.snapshot->>'maintenanceRunId'=r.id::text and review.status='awaiting_review')`,[policyId]);
  const block=await retainedDeliveryBlock(db,policyId,revisionId);
  await db.query("update maintenance_schedules set last_error=$3 where retired_at is null and policy->>'policyId'=$1 and policy->>'policyRevisionId'=$2 and ($3::text is not null or last_error='maintenance.errors.retainedDecision')",[policyId,revisionId,block?'maintenance.errors.retainedDecision':null]);
 });},
 async attention(id:string){
  const parent=(await pool.query('select status,checkpoint from maintenance_runs where id=$1',[id])).rows[0];
  if(!parent||!['awaiting_review','failed','rejected'].includes(parent.status))return null;
  const bootstrap=(await pool.query(`select b.checkpoint from maintenance_runs m
    left join knowledge_impact_deliveries d on d.id::text=m.checkpoint->>'impactDeliveryId'
    join organization_runs b on b.id::text=coalesce(m.checkpoint->>'bootstrapId',d.checkpoint->>'bootstrapId',d.receipt->>'runId')
    where m.id=$1 and b.snapshot->>'version'='wiki-bootstrap-v1'`,[id])).rows[0];
  const child=(await pool.query(`select c.id,c.status,c.snapshot->>'version' version,c.checkpoint,
    c.status='awaiting_review' and case when c.snapshot->>'version'='wiki-curator-v2' then c.checkpoint->'supportAssessment'->'verdict'->>'supported'='true' and c.checkpoint->'proposal'<>'null'::jsonb else exists(select 1 from organization_proposals p where p.run_id=c.id) end review_ready
    from maintenance_runs m left join knowledge_impact_deliveries d on d.id::text=m.checkpoint->>'impactDeliveryId'
    left join organization_runs b on b.id::text=coalesce(m.checkpoint->>'bootstrapId',d.checkpoint->>'bootstrapId',d.receipt->>'runId')
    join organization_runs c on c.id::text in(m.checkpoint->>'reviewChildId',b.checkpoint->>'childRunId',d.checkpoint->>'childRunId') or c.snapshot->>'maintenanceRunId'=m.id::text
    where m.id=$1 and c.status in('awaiting_review','failed','rejected','canceled')
    order by (c.status='awaiting_review') desc,c.updated_at desc,c.id limit 1`,[id])).rows[0];
  const reason=child?.checkpoint.supportAssessment?.verdict.supported===false?'organization.errors.unsupported':child?.checkpoint.error??bootstrap?.checkpoint.error??parent.checkpoint.reason??null;
  return AutomaticMaintenanceAttentionSchema.parse({kind:child?.review_ready?'review':'blocked',childRunId:child?.id??null,childVersion:child?.version??null,
    reason:!child?.review_ready&&reason==='organization.errors.review'?'maintenance.errors.failed':reason,
    issues:child?.checkpoint.validationIssues??[]});
 },
 async preview(policy:AutomaticWikiPolicy,timezone:string){const sharedMonth=await monthlyAllowance(pool,policy.id);const defaults=automaticRoutinePresets(policy.id,policy.revisionId,automaticScopeKey(policy.scope),timezone),routines=[];for(const p of defaults){const old=(await pool.query('select s.* from automatic_routine_bindings b join maintenance_schedules s on s.id=b.schedule_id where b.policy_id=$1 and b.kind=$2 and b.scope_key=$3',[policy.id,p.kind,p.scopeKey])).rows[0];routines.push({policy:{...(old?{...old.policy,policyRevisionId:policy.revisionId}:{...p,monthAllowance:sharedMonth??p.monthAllowance}),promptIds:[...p.promptIds,...(policy.operations.includes('interpret_memory')?['organization.temporal','organization.procedure']:[]),...(policy.operations.includes('evolve_notes')?['organization.consolidation']:[]),...(policy.operations.includes('interpret_memory')||policy.operations.includes('evolve_notes')?['organization.evolution.repair','organization.evolution.support']:[])]},scheduleId:old?.id??null,action:old?'preserve':'create'});}const legacy=(await pool.query("select id,policy from maintenance_schedules where retired_at is null and policy->>'version' is distinct from $1 order by id",[version])).rows.map(r=>({id:r.id,name:r.policy.name,enabled:r.policy.enabled,action:'retain_separate'}));return AutomaticMaintenancePreviewSchema.parse({version,routines,legacy,monthAllowance:routines[0]!.policy.monthAllowance});},
 async installed(policyId:string){return !!(await pool.query('select 1 from automatic_routine_bindings where policy_id=$1 limit 1',[policyId])).rows.length;},
 async schedules(policyId?:string){const rows=(await pool.query("select * from maintenance_schedules where retired_at is null and policy->>'version'=$1 and ($2::text is null or policy->>'policyId'=$2) order by next_at,id",[version,policyId??null])).rows;return Promise.all(rows.map(async row=>{const s=schedule(row);return {...s,admissionBlock:await retainedDeliveryBlock(pool,s.policy.policyId,s.policy.policyRevisionId)};}));},
 async get(id:string){const r=(await pool.query("select * from maintenance_runs where id=$1 and snapshot->>'version'=$2",[id,version])).rows[0];return r?{...run(r),usage:await api.usage(id),attention:await api.attention(id)}:null;},
 async active(policyId?:string){return(await pool.query(`select * from maintenance_runs where snapshot->>'version'=$1 and ($2::text is null or snapshot->'policy'->>'policyId'=$2) and ${live} order by created_at,id`,[version,policyId??null])).rows.map(run);},
 async history(policyId:string){return Promise.all((await pool.query(`select * from maintenance_runs where snapshot->>'version'=$1 and snapshot->'policy'->>'policyId'=$2 and ${taskHistoryVisibleSql('status','updated_at')} order by created_at desc,id desc limit 50`,[version,policyId])).rows.map(async r=>({...run(r),usage:await api.usage(r.id),attention:await api.attention(r.id)})));},
 async usage(id:string){return(await pool.query("select sum(a.input_tokens)::float as \"inputTokens\",sum(a.output_tokens)::float as \"outputTokens\",sum(a.cost_estimate)::float cost,count(a.id)::int calls,count(a.input_tokens)::int as \"knownInput\",count(a.output_tokens)::int as \"knownOutput\",count(a.cost_estimate)::int as \"knownCost\" from automatic_routine_calls c left join organization_steps s on s.run_id=c.organization_run_id and s.sequence=c.sequence left join ai_task_runs a on a.id=s.ai_task_run_id where c.run_id=$1",[id])).rows[0] as AutomaticMaintenanceRun['usage'];},
 async monthly(policyId:string,period:string){const rows=(await pool.query('select reservation from maintenance_budget_reservations where scope_key=$1 and period=$2',['automatic-policy:'+policyId,period])).rows;return {calls:rows.reduce((n,r)=>n+(r.reservation.calls??0),0),tokens:rows.reduce((n,r)=>n+(r.reservation.tokens??0),0),spend:null};},
 async saveMonthly(policyId:string,expected:{id:string;revision:number}[],value:{calls:number;tokens:number},now=new Date()){
  const parsed=AutomaticAllowanceSchema.pick({calls:true,tokens:true}).parse(value);
  return tx(async db=>{
   await policyLock(db,policyId);
   const rows=(await db.query("select * from maintenance_schedules where retired_at is null and policy->>'version'=$1 and policy->>'policyId'=$2 order by id for update",[version,policyId])).rows;
   if(!rows.length||rows.length!==expected.length||new Set(expected.map(s=>s.id)).size!==expected.length||rows.some(r=>!expected.some(s=>s.id===r.id&&s.revision===r.revision)))throw new Error('maintenance.errors.conflict');
   const current=await monthlyAllowance(db,policyId);
   // Monetary authority is not edited by this calls/tokens form.
   const allowance={...current!,...parsed};
   await db.query("update maintenance_schedules set policy=jsonb_set(policy,'{monthAllowance}',$2::jsonb),revision=revision+1,updated_at=$3 where id=any($1::uuid[])",[rows.map(r=>r.id),JSON.stringify(allowance),now]);
  });
 },
 async scheduleStatus(ids:string[],reason:string|null){await pool.query('update maintenance_schedules set last_error=$2 where id=any($1::uuid[])',[ids,reason]);},
 async measured(policyId:string,period:string){return recordedBudgetUsage(pool,policyId,period);},
 async capacity(runId:string,_calls=0,_tokens=0,now=new Date()){
  const r=await api.get(runId);if(!r)throw new Error('maintenance.errors.revoked');
  await checkRecordedBudget(pool,r,now);
 },
 async heartbeat(id:string,now:Date,elapsed:number,unobserved=0){const row=(await pool.query("update maintenance_runs set checkpoint=jsonb_set(jsonb_set(jsonb_set(checkpoint,'{closedMs}',to_jsonb(coalesce((checkpoint->>'closedMs')::float,0)+$4::float)),'{executionMs}',to_jsonb((checkpoint->>'executionMs')::float+$3::float)),'{lastTickAt}',to_jsonb($2::text)) where id=$1 and status in('inspecting','analyzing') and checkpoint->>'reason' is null returning snapshot,checkpoint",[id,now.toISOString(),Math.max(0,elapsed),Math.max(0,unobserved)])).rows[0];if(!row)throw new Error('maintenance.errors.revoked');return row.snapshot.policy.executionMs-row.checkpoint.executionMs;},
 async blocker(policyId:string){const row=(await pool.query("select exists(select 1 from jobs j where j.status in('queued','running') and j.type<>'maintenance' and not (j.type='organization' and exists(select 1 from organization_runs r where r.job_id=j.id and r.snapshot->'policy'->>'id'=$1))) busy",[policyId])).rows[0]!;return row.busy?'maintenance.errors.busy':null;},
 async pending(policyId:string){return Number((await pool.query("select count(*) n from knowledge_impact_deliveries where consumer='curator' and consumer_key=$1 and status not in ('acknowledged','excluded')",[policyId])).rows[0]!.n);},
 // Admission failures retain their delivery cursor. Only unstarted budget deferrals may move to a new occurrence.
 async reviewChild(runId:string){const row=(await pool.query("select id,status,checkpoint->>'error' error from organization_runs where snapshot->>'maintenanceRunId'=$1 and status in('awaiting_review','failed','canceled','rejected') and not(status='canceled' and coalesce(checkpoint->>'error','')='organization.errors.supersededTrigger') order by created_at,id limit 1",[runId])).rows[0];return row?{id:row.id as string,reason:row.error??'organization.errors.review'}:null;},
 async deliveryAttention(policyId:string,runId:string){const row=(await pool.query(`with attention as (
 select d.id,d.updated_at,d.status,d.receipt,d.input_generation,d.checkpoint,
 coalesce(child.status,'') child_status,child.id child_id,
 case when child.status in('awaiting_review','failed','canceled','rejected') then coalesce(child.checkpoint->>'error','organization.errors.review')
 else coalesce(bootstrap.checkpoint->>'error',d.checkpoint->>'blockedReason',d.receipt->>'reason','organization.errors.review') end reason,
 bootstrap.id bootstrap_id,bootstrap.checkpoint->>'childRunId' bootstrap_child,
 owner.id owner_id
 from knowledge_impact_deliveries d
 left join organization_runs bootstrap on bootstrap.id::text=coalesce(d.checkpoint->>'bootstrapId',d.receipt->>'runId') and bootstrap.snapshot->>'version'='wiki-bootstrap-v1'
 left join organization_runs child on child.id::text=coalesce(d.checkpoint->>'childRunId',bootstrap.checkpoint->>'childRunId')
 left join lateral(select m.id from maintenance_runs m where m.checkpoint->>'bootstrapId'=bootstrap.id::text order by m.created_at desc,m.id limit 1) owner on true
 where d.consumer='curator' and d.consumer_key=$1
 and d.input_generation like '%:'||(select snapshot->>'policyRevisionId' from maintenance_runs where id=$2::uuid)
 ) select id,reason,child_id is null and reason ~ '^(maintenance.errors.(budget|period)|organization.errors.deadline)$' exhaustible
 from attention where (status not in('acknowledged','excluded') or receipt->>'kind'='attention')
 and (child_status in('awaiting_review','failed','canceled','rejected')
 or child_id is null and checkpoint->>'blockedReason' is not null and checkpoint->>'blockedReason' !~ '^maintenance.errors.(wait|idle|busy|sync)$'
 or receipt->>'kind'='attention')
 -- An exhausted childless group belongs to its original occurrence. A later
 -- authorized occurrence may continue its cursor; it must not inherit a review.
 and not (child_id is null and reason ~ '^(maintenance.errors.(budget|period)|organization.errors.deadline)$'
   and case when bootstrap_id is not null then owner_id is distinct from $2::uuid else (checkpoint->>'blockedMaintenanceRunId') is distinct from $2::text end)
 order by updated_at,id limit 1`,[policyId,runId])).rows[0];return row?{id:row.id as string,reason:row.reason as string,exhaustible:row.exhaustible as boolean}:null;},
 async changedAt(policyId:string){const r=(await pool.query("select max(e.created_at) at from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id where (d.consumer='curator' and d.consumer_key=$1 or d.consumer='investigation' and d.consumer_key in(select id::text from wiki_investigations where policy_id=$1::uuid and state in('followed','awaiting_evidence'))) and d.receipt is null",[policyId])).rows[0];return r?.at?stamp(r.at):null;},
 async admit(schedules:zSchedule[],now:Date,manual=false,requestId?:string,context?:Pick<AutomaticMaintenanceRun['snapshot'],'promptPin'|'profile'|'contentLanguage'>){return tx(async db=>{const p=schedules[0]!.policy;await policyLock(db,p.policyId);const current=(await db.query("select a.state,a.revision_id from wiki_policy_activations a where policy_id=$1 order by created_at desc,id desc limit 1",[p.policyId])).rows[0];if(current?.state!=='enabled'||current.revision_id!==p.policyRevisionId)throw new Error('organization.errors.policy');
  let old=(await db.query(`select * from maintenance_runs where snapshot->>'version'=$1 and snapshot->'policy'->>'policyId'=$2 and snapshot->'policy'->>'kind'=$3 and ${live} order by created_at limit 1 for update`,[version,p.policyId,p.kind])).rows[0];
  for(const s of schedules){const current=(await db.query('select revision,policy from maintenance_schedules where id=$1 for update',[s.id])).rows[0];if(current?.revision!==s.revision||!current.policy.enabled)throw new Error('maintenance.errors.revoked');const key=manual?'manual:'+requestId:s.revision+':'+s.nextAt;const prior=(await db.query('select run_id from maintenance_occurrences where schedule_id=$1 and occurrence_key=$2',[s.id,key])).rows[0];if(prior)return api.get(prior.run_id);}
  const retained=await retainedDeliveryBlock(db,p.policyId,p.policyRevisionId);
  if(retained){await db.query("update maintenance_schedules set last_error='maintenance.errors.retainedDecision' where id=any($1::uuid[])",[schedules.map(s=>s.id)]);return null;}
  if(!old){const id=randomUUID(),job=(await db.query("insert into jobs(type,payload,max_attempts) values('maintenance',$1,1) returning id",[{maintenanceRunId:id,automaticMaintenance:true}])).rows[0]!.id;const snapshot={...context,version,policy:p,policyRevisionId:p.policyRevisionId,dueAt:manual?now.toISOString():schedules.map(s=>s.nextAt).sort()[0],manual,cutoff:now.toISOString()},checkpoint=AutomaticMaintenanceCheckpointSchema.parse({lastTickAt:now.toISOString()}),reservation={calls:0,tokens:0,spend:null};old=(await db.query('insert into maintenance_runs(id,job_id,scope_key,period,schedule_ids,snapshot,checkpoint,reservation) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[id,job,'automatic-policy:'+p.policyId,now.toISOString().slice(0,7),JSON.stringify([]),snapshot,checkpoint,reservation])).rows[0];}
  for(const s of schedules){const key=manual?'manual:'+requestId:s.revision+':'+s.nextAt;await db.query('insert into maintenance_occurrences(schedule_id,occurrence_key,due_from,due_until,run_id) values($1,$2,$3,$4,$5)',[s.id,key,manual?now:s.nextAt,now,old!.id]);await db.query('update maintenance_schedules set last_run_id=$2,next_at=case when $4 then next_at else $3 end where id=$1',[s.id,old!.id,automaticNext(s.policy,now),manual]);}
  if(manual){await db.query("update maintenance_runs set checkpoint=jsonb_set(checkpoint,'{manualRequested}','true') where id=$1",[old!.id]);}
  const ids=[...new Set([...old!.schedule_ids,...schedules.map(s=>s.id)])];old=(await db.query('update maintenance_runs set schedule_ids=$2 where id=$1 returning *',[old!.id,JSON.stringify(ids)])).rows[0];return run(old!);
 });},
 async checkpoint(r:AutomaticMaintenanceRun){await pool.query(`update maintenance_runs set status=$2,checkpoint=$3::jsonb||jsonb_build_object('executionMs',greatest((checkpoint->>'executionMs')::float,($3::jsonb->>'executionMs')::float),'lastTickAt',greatest(checkpoint->>'lastTickAt',$3::jsonb->>'lastTickAt'),'calls',(reservation->>'calls')::int,'reservedTokens',(reservation->>'tokens')::int),updated_at=$4 where id=$1 and ${live}`,[r.id,r.status,r.checkpoint,new Date(r.updatedAt)]);},
 async cancel(id:string){return tx(async db=>{const row=await api.get(id);if(!row)return;await policyLock(db,row.snapshot.policy.policyId);await db.query("update maintenance_runs set status='canceled',updated_at=now() where id=$1 and status not in('applied','no_change','rejected')",[id]);await db.query("update organization_runs set status='canceled',checkpoint=jsonb_set(checkpoint,'{state}','\"canceled\"') where id=$1 and status not in('applied','canceled','rejected')",[row.checkpoint.bootstrapId]);const jobs=(await db.query("update jobs set cancel_requested_at=now(),status=case when status='queued' then 'canceled' else status end where id in(select job_id from organization_runs where snapshot->>'maintenanceRunId'=$1) and status in('queued','running') returning id",[id])).rows;return jobs.map(j=>j.id as string);});},
 async retireLegacy(ids:string[]){return tx(async db=>{await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-maintenance',0))");for(const id of ids){const s=(await db.query('select policy from maintenance_schedules where id=$1 for update',[id])).rows[0];if(!s||s.policy.version===version)throw new Error('maintenance.errors.scope');if((await db.query("select id from maintenance_runs where schedule_ids ? $1 and status in('queued','inspecting','analyzing','awaiting_review')",[id])).rows.length)throw new Error('maintenance.errors.wait');await db.query("update maintenance_schedules set retired_at=now(),policy=jsonb_set(policy,'{enabled}','false'),revision=revision+1 where id=$1",[id]);}return null;});},
 async manualAuthority(policyId:string,now=new Date(),context?:Pick<AutomaticMaintenanceRun['snapshot'],'promptPin'|'profile'|'contentLanguage'>,kind='incremental'){const existing=await api.authority(policyId,now);if(existing)return existing;const active=(await api.active(policyId))[0];if(active&&!active.checkpoint.incomplete&&[null,'maintenance.errors.idle','maintenance.errors.wait'].includes(active.checkpoint.reason)){const schedule=(await api.schedules(policyId)).find(s=>active.scheduleIds.includes(s.id));if(!schedule)throw new Error('maintenance.errors.revoked');const resumed=(await api.admit([schedule],now,true,randomUUID(),context))!;resumed.status='inspecting';resumed.checkpoint.reason=await api.blocker(policyId);resumed.checkpoint.startedAt??=now.toISOString();await api.checkpoint(resumed);if(resumed.checkpoint.reason)throw new Error(resumed.checkpoint.reason);return resumed;}if(active)throw new Error(active.checkpoint.reason??'maintenance.errors.wait');const s=(await api.schedules(policyId)).find(s=>s.policy.kind===kind&&s.policy.enabled);if(!s)throw new Error('maintenance.errors.revoked');const r=await api.admit([s],now,true,randomUUID(),context);if(!r)throw new Error('maintenance.errors.retainedDecision');r.status='inspecting';r.checkpoint.startedAt=now.toISOString();r.checkpoint.reason=await api.blocker(policyId);await api.checkpoint(r);if(r.checkpoint.reason)throw new Error(r.checkpoint.reason);return r;},
 async canceledChildren(scheduleId:string){return(await pool.query("select j.id from jobs j join organization_runs child on child.job_id=j.id join maintenance_runs r on r.id::text=child.snapshot->>'maintenanceRunId' where r.schedule_ids ? $1 and r.status='canceled' and j.status in('queued','running')",[scheduleId])).rows.map(j=>j.id as string);},
 async save(id:string,expected:number,p:AutomaticRoutinePolicy,now:Date){return tx(async db=>{await policyLock(db,p.policyId);const old=(await db.query('select * from maintenance_schedules where id=$1 for update',[id])).rows[0];if(!old||old.revision!==expected||old.policy.policyId!==p.policyId||old.policy.kind!==p.kind||old.policy.scopeKey!==p.scopeKey)throw new Error('maintenance.errors.conflict');if(!isDeepStrictEqual(old.policy.monthAllowance,p.monthAllowance))throw new Error('maintenance.errors.budget');await db.query('update maintenance_schedules set policy=$2,revision=revision+1,next_at=$3,updated_at=$4 where id=$1',[id,p,automaticNext(p,now),now]);await db.query(`update maintenance_runs set status='canceled' where schedule_ids ? $1 and ${live}`,[id]);return schedule((await db.query('select * from maintenance_schedules where id=$1',[id])).rows[0]!);});},
 async authority(policyId:string,now=new Date()){const active=(await api.active(policyId)).find(r=>['inspecting','analyzing'].includes(r.status)&&!r.checkpoint.reason);if(!active)return null;try{return await validateAutomaticAuthority(pool,active.id,policyId,false,now);}catch{return null;}},
 async reserve(runId:string,organizationRunId:string,sequence:number,tokens:number,now=new Date()){return tx(async db=>{const initial=await api.get(runId);if(!initial)throw new Error('maintenance.errors.revoked');const policyId=initial.snapshot.policy.policyId;await policyLock(db,policyId);const r=await validateAutomaticAuthority(db,runId,policyId,true,now);const prior=(await db.query('select * from automatic_routine_calls where organization_run_id=$1 and sequence=$2',[organizationRunId,sequence])).rows[0];if(prior){if(prior.run_id!==runId)throw new Error('maintenance.errors.budget');return;}
  const child=(await db.query('select snapshot,checkpoint from organization_runs where id=$1',[organizationRunId])).rows[0];if((child?.checkpoint.investigationOccurrenceId??child?.snapshot.maintenanceRunId)!==runId||(child.snapshot.investigationPolicyId??child.snapshot.policy.id)!==policyId)throw new Error('maintenance.errors.revoked');const period=now.toISOString().slice(0,7);await checkRecordedBudget(db,r,now);
  await db.query('insert into automatic_routine_calls(organization_run_id,sequence,run_id,policy_id,period,tokens) values($1,$2,$3,$4,$5,$6)',[organizationRunId,sequence,runId,policyId,period,tokens]);await db.query("insert into maintenance_budget_reservations(run_id,scope_key,period,reservation) values($1,$2,$3,$4) on conflict(run_id,period) do update set reservation=jsonb_build_object('calls',(maintenance_budget_reservations.reservation->>'calls')::int+1,'tokens',(maintenance_budget_reservations.reservation->>'tokens')::int+$5,'spend',null)",[runId,'automatic-policy:'+policyId,period,{calls:1,tokens,spend:null},tokens]);await db.query("update maintenance_runs set reservation=jsonb_build_object('calls',(reservation->>'calls')::int+1,'tokens',(reservation->>'tokens')::int+$2,'spend',null),checkpoint=jsonb_set(jsonb_set(checkpoint,'{calls}',to_jsonb((reservation->>'calls')::int+1)),'{reservedTokens}',to_jsonb((reservation->>'tokens')::int+$2)) where id=$1",[runId,tokens]);
 });}
 };return api;
}
type zSchedule=ReturnType<typeof schedule>;
