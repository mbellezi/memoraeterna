import { createHierarchicalIngestionRepository,createIngestionRunRepository,createOrganizationRepository,type PgPool,type IngestionRunRecord } from '@app/db';
import { OrganizationStartSchema,EffectiveProcessingPlanSchema } from '@app/domain';
import type { OrganizationService } from './organization-service.js';
const derivations=['chunking','summarization','embedding','atomicNotes','knowledgeGraph','atomicNoteMatching','sourceMatching','aggregateSummarization'];
const terminal=new Set(['completed','skipped','failed','canceled']);
export function organizationReadiness(runs:Array<Pick<IngestionRunRecord,'id'|'sourceItemId'|'effectiveStages'|'stagesCheckpoint'|'status'>>,active:boolean){
  const selected=runs.filter(r=>r.effectiveStages.includes('organizeKnowledge'));
  const omissions=runs.flatMap(r=>derivations.filter(stage=>r.effectiveStages.includes(stage)).flatMap(stage=>{
    const checkpoint=r.stagesCheckpoint[stage] as {status?:string;metadata?:Record<string,unknown>}|undefined,status=checkpoint?.status??'pending';
    return status==='completed'&&!checkpoint?.metadata?.partial&&checkpoint?.metadata?.configured!==false?[]:[{sourceItemId:r.sourceItemId,stage,status:status==='completed'?'partial':status}];
  }));
  const settled=runs.every(r=>derivations.filter(stage=>r.effectiveStages.includes(stage)).every(stage=>terminal.has((r.stagesCheckpoint[stage] as {status?:string}|undefined)?.status??'pending')));
  return {ready:selected.length>0&&!active&&settled,selected,omissions};
}
/** Reconcile only explicitly selected runs; no matching or generation method is available here. */
export async function reconcileOrganizationParticipation(pool:PgPool,service:OrganizationService){
  const repository=createOrganizationRepository(pool),runsRepo=createIngestionRunRepository(pool);
  const batches=await repository.participatingBatches();
  for(const batch of batches){
    let runs=await runsRepo.listByBatch(batch.id);
    if(!batch.active){
      const failed=runs.some(r=>['failed','canceled'].includes(r.status)||derivations.some(stage=>['failed','canceled'].includes((r.stagesCheckpoint[stage] as {status?:string}|undefined)?.status??'')));
      if(failed){
        for(const run of runs) for(const stage of derivations.filter(stage=>run.effectiveStages.includes(stage))){
          const status=(run.stagesCheckpoint[stage] as {status?:string}|undefined)?.status??'pending';
          // Explicitly terminalize interrupted/unreachable selected work on its owning checkpoint.
          // Idle successful parents alone never release a matching barrier.
          if(!terminal.has(status)&&(['failed','canceled'].includes(run.status)||stage==='atomicNoteMatching'||stage==='sourceMatching'))await runsRepo.skipStage(run.id,stage,'upstream_failed_or_canceled');
        }
        runs=await runsRepo.listByBatch(batch.id);
      }
    }
    const state=organizationReadiness(runs,batch.active);
    if(!state.ready)continue;
    const prior=await repository.participationRun(batch.id);
    if(prior){
      for(const run of state.selected){
        const checkpoint=run.stagesCheckpoint.organizeKnowledge as {status?:string;metadata?:{organizationRunId?:string}}|undefined;
        if(['awaiting_review','applied','rejected'].includes(prior.status)&&checkpoint?.status!=='completed')await runsRepo.completeStage(run.id,'organizeKnowledge',{organizationRunId:prior.id,outcome:prior.status,partial:state.omissions.length>0});
        else if(['failed','canceled'].includes(prior.status)&&checkpoint?.status!==prior.status)await runsRepo.failStage(run.id,'organizeKnowledge',prior.checkpoint.error??'organization.errors.failed',prior.status==='canceled');
      }
      await createHierarchicalIngestionRepository(pool).refreshBatch(batch.id);
      continue;
    }
    if(state.selected.every(r=>r.status==='canceled')){for(const run of state.selected)await runsRepo.failStage(run.id,'organizeKnowledge','organization.errors.canceled',true);continue;}
    const parsed=EffectiveProcessingPlanSchema.safeParse(batch.plan);
    if(!parsed.success||!parsed.data.organization){for(const run of state.selected)await runsRepo.failStage(run.id,"organizeKnowledge","organization.errors.model",false);await repository.participationFailed(batch.id);continue;}
    const plan=parsed.data;
    const sourceIds=[...new Set(state.selected.flatMap(r=>r.sourceItemId&&r.status!=='canceled'&&(r.stagesCheckpoint.chunking as {status?:string}|undefined)?.status==='completed'?[r.sourceItemId]:[]))];
    try{
      if(!sourceIds.length)throw new Error('organization.errors.noEvidence');
      const targetId=await repository.topicTarget(plan.organization!.title,sourceIds);
      const started=await service.start(OrganizationStartSchema.parse({title:plan.organization!.title,targetPageId:targetId??null,sourceIds,profileId:plan.organization!.profileId,privacy:plan.organization!.privacy,domainId:plan.organization!.domainId,relationContext:true,optionalContext:true,pageKind:'topic'}),{batchId:batch.id,ingestionRunIds:state.selected.map(r=>r.id),omissions:state.omissions});
      for(const run of state.selected){await runsRepo.waitForBatchStage(run.id,'organizeKnowledge');await runsRepo.updateStageProgress(run.id,'organizeKnowledge',0,{organizationRunId:started!.id,partial:state.omissions.length>0});}
    }catch(error){
      for(const run of state.selected)await runsRepo.failStage(run.id,'organizeKnowledge',String(error).match(/organization\.errors\.[A-Za-z]+/)?.[0]??'organization.errors.failed',false);
      await repository.participationFailed(batch.id);
    }
    await createHierarchicalIngestionRepository(pool).refreshBatch(batch.id);
  }
}
