import { createHash, randomUUID } from "node:crypto";
import type { PgPool, PgClient } from "../client.js";
import { createWikiRepository } from "./wikiRepository.js";
import { currentSourceRelationEvidenceSql, sourceRelationEvidenceJoins } from "./sourceRelationRepository.js";

const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const stamp=(v:unknown)=>new Date(v as string).toISOString();
const runSelect=`select r.id,r.job_id as "jobId",r.status,r.snapshot,r.checkpoint,p.proposal,
  receipt.revision_id as "receiptRevisionId",r.created_at as "createdAt",r.updated_at as "updatedAt"
  from organization_runs r left join organization_proposals p on p.run_id=r.id left join organization_receipts receipt on receipt.run_id=r.id`;
export function createOrganizationRepository(pool:PgPool) {
  const transaction=async<T>(fn:(db:PgClient)=>Promise<T>)=>{
    const db=await pool.connect();try {await db.query("begin");const result=await fn(db);await db.query("commit");return result;}
    catch(error){await db.query("rollback");throw error;}finally{db.release();}
  };
  const activeSql="coalesce((select value->>'revisionId' from settings where key='organization.active'),(select revision_id::text from organization_settings_activations order by created_at desc,id desc limit 1))";
  return {
    async settings(){
      const revisions=(await pool.query(`select c.id,c.configuration,c.hash,c.created_at as "createdAt",exists(select 1 from organization_runs r where r.status='sample_passed' and r.snapshot->>'configurationId'=c.id::text) as "samplePassed" from organization_settings_revisions c where c.id in(select id from organization_settings_revisions order by created_at desc,id desc limit 100) or c.id=(${activeSql})::uuid order by c.created_at desc,c.id desc`)).rows.map(r=>({...r,createdAt:stamp(r.createdAt)}));
      const activations=(await pool.query(`select id,revision_id as "revisionId",created_at as "createdAt" from organization_settings_activations order by created_at desc,id desc limit 100`)).rows.map(r=>({...r,createdAt:stamp(r.createdAt)}));
      const activeId=(await pool.query(`select ${activeSql} as id`)).rows[0]?.id??null;return {activeId,revisions,activations};
    },
    async configuration(id:string){return (await pool.query('select id,configuration,hash from organization_settings_revisions where id=$1',[id])).rows[0]??null;},
    async saveDraft(configuration:unknown){return (await pool.query('insert into organization_settings_revisions(configuration,hash) values($1,$2) returning id',[configuration,hash(configuration)])).rows[0]!.id as string;},
    async activate(id:string,expectedActiveId:string|null,requiredPrompts:string[]){
      return transaction(async db=>{
        await db.query("select pg_advisory_xact_lock(hashtextextended('organization-settings',0))");
        const active=(await db.query(`select ${activeSql} as id`)).rows[0]?.id??null;
        if(active!==expectedActiveId)throw new Error('organization.errors.conflict');
        for(const prompt of requiredPrompts)if(!(await db.query("select id from organization_runs where status='sample_passed' and snapshot->>'configurationId'=$1 and snapshot->'instructions'->'slots'->>'advanced'=$2 limit 1",[id,prompt])).rows.length)throw new Error('organization.errors.sample');
        await db.query('insert into organization_settings_activations(revision_id,created_at) values($1,clock_timestamp())',[id]);
        await db.query("insert into settings(key,value) values('organization.active',$1) on conflict(key) do update set value=excluded.value,updated_at=now()",[{revisionId:id}]);
      });
    },
    async scope(ids:string[],descendants:boolean){
      const rows=(await pool.query(`with recursive scoped as (select id from source_items where id=any($1::uuid[]) union select s.id from source_items s join scoped p on p.id=s.parent_source_item_id where $2) select id from scoped limit 501`,[ids,descendants])).rows;
      if(rows.length>500 || ids.some(id=>!rows.some(r=>r.id===id)))throw new Error('organization.errors.scope');return rows.map(r=>r.id as string);
    },
    async evidence(sourceIds:string[]){
      const rows=(await pool.query(`select c.id as "chunkId",c.source_item_id as "sourceItemId",c.document_id as "documentId",c.source_span_id as "sourceSpanId",c.content_hash as "contentHash",c.content as excerpt,s.title as "sourceTitle",d.created_at as "documentCreatedAt",coalesce(sp.label,sp.selector,sp.page::text) as locator
        from chunks c join documents d on d.id=c.document_id join source_items s on s.id=c.source_item_id left join source_spans sp on sp.id=c.source_span_id
        where c.source_item_id=any($1::uuid[]) and d.metadata->>'supersededByDocumentId' is null
        and c.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and c.chunking_version<>'catalog-metadata-v1' order by c.id limit 201`,[sourceIds])).rows;
      if(rows.length>200||rows.some(r=>r.excerpt.length>12000))throw new Error('organization.errors.scopeLimit');
      return rows.map((r,i)=>({...r,documentCreatedAt:stamp(r.documentCreatedAt),handle:`e${i+1}`}));
    },
    async relations(sourceIds:string[]){
      return (await pool.query(`select distinct on(r.id) r.id,e.id as "evidenceId",md5(e.snapshot::text) as fingerprint,r.source_item_id as "sourceItemId",r.target_source_item_id as "targetSourceItemId",r.status as review,r.updated_at as "updatedAt",r.source_idea as "sourceIdea",r.target_idea as "targetIdea",r.explanation,e.source_chunk_id as "sourceChunkId",e.target_chunk_id as "targetChunkId"
        from source_relations r join source_relation_evidence e on e.relation_id=r.id ${sourceRelationEvidenceJoins}
        where r.source_item_id=any($1::uuid[]) and r.target_source_item_id=any($1::uuid[]) and r.status<>'rejected' and ${currentSourceRelationEvidenceSql}
        order by r.id,e.id limit 20`,[sourceIds])).rows.map(r=>({...r,updatedAt:stamp(r.updatedAt)}));
    },
    async validateRelations(relations:Array<{id:string;evidenceId:string;fingerprint:string;review:string;updatedAt:string}>,sourceIds:string[]){
      for(const relation of relations){
        const current=(await pool.query(`select r.status,r.updated_at,md5(e.snapshot::text) as fingerprint from source_relations r join source_relation_evidence e on e.relation_id=r.id ${sourceRelationEvidenceJoins}
          where r.id=$1 and e.id=$2 and r.source_item_id=any($3::uuid[]) and r.target_source_item_id=any($3::uuid[]) and r.status<>'rejected' and ${currentSourceRelationEvidenceSql}`,[relation.id,relation.evidenceId,sourceIds])).rows[0];
        if(!current||current.fingerprint!==relation.fingerprint||current.status!==relation.review||stamp(current.updated_at)!==relation.updatedAt)throw new Error('organization.errors.evidence');
      }
    },
    async create(snapshot:unknown,checkpoint:unknown){
      return transaction(async db=>{
        const id=randomUUID();const job=(await db.query("insert into jobs(type,payload,max_attempts) values('organization',$1,3) returning id",[{organizationRunId:id}])).rows[0]!.id;
        await db.query('insert into organization_runs(id,job_id,snapshot,checkpoint) values($1,$2,$3,$4)',[id,job,snapshot,checkpoint]);return id;
      });
    },
    async get(id:string){await pool.query("update organization_runs set status='applied',updated_at=now() where id=$1 and status<>'applied' and exists(select 1 from organization_receipts where run_id=$1)",[id]);const r=(await pool.query(`${runSelect} where r.id=$1`,[id])).rows[0];return r?{...r,createdAt:stamp(r.createdAt),updatedAt:stamp(r.updatedAt)}:null;},
    async list(){await pool.query("update organization_runs r set status='applied',updated_at=now() where status<>'applied' and exists(select 1 from organization_receipts where run_id=r.id)");return (await pool.query(`select r.id,r.status,case when r.checkpoint->>'callPending'='true' then case when r.checkpoint->>'waitingForModel'='true' then 'waiting' else 'active' end else 'none' end as "modelState",r.snapshot->'baseContent'->>'title' as title,(r.snapshot->>'sample')::boolean as sample,receipt.revision_id as "receiptRevisionId",r.created_at as "createdAt",r.updated_at as "updatedAt" from organization_runs r left join organization_receipts receipt on receipt.run_id=r.id order by r.created_at desc limit 50`)).rows.map(r=>({...r,createdAt:stamp(r.createdAt),updatedAt:stamp(r.updatedAt)}));},
    async checkpoint(id:string,status:string,checkpoint:unknown){await pool.query("update organization_runs set status=$2,checkpoint=$3,updated_at=now() where id=$1 and status not in('canceled','rejected','applied','sample_passed')",[id,status,checkpoint]);},
    async modelStarted(id:string,sequence:number){await pool.query("update organization_runs set checkpoint=jsonb_set(checkpoint,'{waitingForModel}','false'::jsonb),updated_at=now() where id=$1 and status='analyzing' and checkpoint->>'callPending'='true' and (checkpoint->>'calls')::int=$2",[id,sequence]);},
    async step(id:string,sequence:number,checkpoint:unknown,artifact:unknown,aiTaskRunId:string|null){
      return transaction(async db=>{
        await db.query('insert into organization_steps(run_id,sequence,artifact,ai_task_run_id) values($1,$2,$3,$4) on conflict(run_id,sequence) do update set artifact=excluded.artifact',[id,sequence,artifact,aiTaskRunId]);
        await db.query("update organization_runs set checkpoint=$2,updated_at=now() where id=$1",[id,checkpoint]);
      });
    },
    async usage(id:string){
      const row=(await pool.query(`select coalesce(sum(a.input_tokens),0)::float as "inputTokens",coalesce(sum(a.output_tokens),0)::float as "outputTokens",coalesce(sum(a.cost_estimate),0)::float as "costEstimate",count(a.input_tokens)::int as "knownInputCalls",count(a.output_tokens)::int as "knownOutputCalls",count(a.cost_estimate)::int as "knownCostCalls",coalesce(bool_or(a.input_tokens is null or a.output_tokens is null or a.cost_estimate is null),false) as incomplete from organization_steps s left join ai_task_runs a on a.id=s.ai_task_run_id where s.run_id=$1`,[id])).rows[0]!;return row;
    },
    async propose(id:string,proposal:unknown,checkpoint:unknown,sample:boolean){
      return transaction(async db=>{
        const run=(await db.query('select status from organization_runs where id=$1 for update',[id])).rows[0];
        if(!run || run.status==='canceled')throw new Error('organization.errors.canceled');
        await db.query('insert into organization_proposals(run_id,proposal) values($1,$2) on conflict(run_id) do nothing',[id,proposal]);
        await db.query('update organization_runs set status=$2,checkpoint=$3,updated_at=now() where id=$1',[id,sample?'sample_passed':'awaiting_review',checkpoint]);
      });
    },
    async cancel(id:string){await pool.query("update organization_runs set status='canceled',updated_at=now() where id=$1 and status not in('applied','sample_passed','rejected') and not exists(select 1 from organization_receipts where run_id=$1)",[id]);},
    async reject(id:string){return transaction(async db=>{
      const run=(await db.query('select status from organization_runs where id=$1 for update',[id])).rows[0];
      if(run?.status!=='awaiting_review')throw new Error('organization.errors.invalid');
      await db.query("update organization_proposals set decision='reject',decided_at=now() where run_id=$1",[id]);
      await db.query("update organization_runs set status='rejected',updated_at=now() where id=$1",[id]);
    });},
    async retry(id:string){return transaction(async db=>{
      const run=(await db.query("select * from organization_runs where id=$1 for update",[id])).rows[0];
      if(!run||!['failed','canceled'].includes(run.status)||(run.status==='failed'&&run.checkpoint.error&&!['organization.errors.failed','organization.errors.uncertain'].includes(run.checkpoint.error))||run.checkpoint.calls>=run.snapshot.limits.modelCalls)throw new Error('organization.errors.budget');
      const currentJob=(await db.query('select status from jobs where id=$1 for update',[run.job_id])).rows[0];
      if(currentJob&&['queued','running'].includes(currentJob.status))throw new Error('organization.errors.wait');
      const job=(await db.query("update jobs set status='queued',cancel_requested_at=null,error=null,run_after=now(),locked_at=null,locked_by=null,finished_at=null where id=$1 and status in('failed','canceled','succeeded') and attempts<max_attempts returning id",[run.job_id])).rows[0];
      if(!job)throw new Error('organization.errors.budget');
      await db.query("update organization_runs set status='queued',updated_at=now() where id=$1",[id]);
    });},
    async apply(id:string,human:boolean,build:(run:Record<string,any>)=>Parameters<ReturnType<typeof createWikiRepository>['save']>[0]){
      return transaction(async db=>{
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        const run=(await db.query('select * from organization_runs where id=$1 for update',[id])).rows[0];
        if(!run)throw new Error('organization.errors.invalid');
        const receipt=(await db.query('select revision_id from organization_receipts where run_id=$1',[id])).rows[0];
        if(receipt){await db.query("update organization_runs set status='applied',updated_at=now() where id=$1",[id]);return receipt.revision_id as string;}
        const job=(await db.query('select cancel_requested_at from jobs where id=$1 for update',[run.job_id])).rows[0];
        if(run.status!=='awaiting_review'||job?.cancel_requested_at||run.snapshot.sample)throw new Error('organization.errors.canceled');
        if(!human&&run.snapshot.policy!=='apply_unprotected')throw new Error('organization.errors.review');
        const proposal=(await db.query('select proposal from organization_proposals where run_id=$1',[id])).rows[0]?.proposal;
        const input=build({...run,proposal});
        for(const chunkId of input.evidenceChunkIds){
          const evidence=run.snapshot.evidence.find((e:Record<string,unknown>)=>e.chunkId===chunkId);
          const current=(await db.query(`select c.content_hash,c.source_item_id,c.document_id,c.source_span_id from chunks c join documents d on d.id=c.document_id where c.id=$1 and c.source_item_id=any($2::uuid[]) and d.metadata->>'supersededByDocumentId' is null for share of c,d`,[chunkId,run.snapshot.sourceIds])).rows[0];
          if(!evidence||current?.content_hash!==evidence.contentHash||current.source_item_id!==evidence.sourceItemId||current.document_id!==evidence.documentId||current.source_span_id!==evidence.sourceSpanId)throw new Error('organization.errors.evidence');
        }
        for(const relation of run.snapshot.relations){
          const support=(await db.query('select source_chunk_id,target_chunk_id,note_relation_id,source_note_id,target_note_id from source_relation_evidence where id=$1',[relation.evidenceId])).rows[0];
          if(!support)throw new Error('organization.errors.evidence');
          const owners=[support.source_chunk_id,support.target_chunk_id];
          await db.query('select id from chunks where id=any($1::uuid[]) for share',[owners]);
          await db.query('select id from documents where id in(select document_id from chunks where id=any($1::uuid[])) for share',[owners]);
          if(support.note_relation_id)await db.query('select id from atomic_note_relations where id=$1 for share',[support.note_relation_id]);
          if(support.source_note_id||support.target_note_id)await db.query('select id from atomic_notes where id=any($1::uuid[]) for share',[[support.source_note_id,support.target_note_id].filter(Boolean)]);
          const current=(await db.query(`select r.status,r.updated_at,md5(e.snapshot::text) as fingerprint from source_relations r join source_relation_evidence e on e.relation_id=r.id ${sourceRelationEvidenceJoins}
            where r.id=$1 and e.id=$2 and r.source_item_id=any($3::uuid[]) and r.target_source_item_id=any($3::uuid[]) and r.status<>'rejected' and ${currentSourceRelationEvidenceSql} for share of r,e`,[relation.id,relation.evidenceId,run.snapshot.sourceIds])).rows[0];
          if(!current||current.fingerprint!==relation.fingerprint||current.status!==relation.review||stamp(current.updated_at)!==relation.updatedAt)throw new Error('organization.errors.evidence');
        }
        for(const chunkId of input.evidenceChunkIds){
          const original=run.snapshot.evidence.find((e:Record<string,unknown>)=>e.chunkId===chunkId);
          const saved=(await db.query('select snapshot from wiki_evidence where page_id=$1 and chunk_id=$2',[run.snapshot.targetId,chunkId])).rows[0];
          if(saved&&saved.snapshot.contentHash!==original.contentHash)throw new Error('organization.errors.evidence');
        }
        await createWikiRepository(pool).save(input,{transaction:db,origin:'organization',humanApproved:human,allocatedTarget:run.snapshot.expectedRevisionId===null});
        const revision=(await db.query('select current_revision_id from wiki_pages where id=$1',[run.snapshot.targetId])).rows[0]!.current_revision_id;
        await db.query('insert into organization_receipts(run_id,revision_id) values($1,$2)',[id,revision]);
        await db.query("update organization_proposals set decision=$2,decided_at=now() where run_id=$1",[id,human?'accept':'policy']);
        // The receipt is canonical; completion may be checkpointed after this transaction.
        return revision as string;
      });
    },
    async complete(id:string){await pool.query("update organization_runs set status='applied',updated_at=now() where id=$1 and exists(select 1 from organization_receipts where run_id=$1)",[id]);}
  };
}
