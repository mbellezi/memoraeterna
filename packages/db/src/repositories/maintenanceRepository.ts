import { createHash, randomUUID } from "node:crypto";
import type { PgPool, PgClient } from "../client.js";
import { createWikiRepository } from "./wikiRepository.js";
const stamp=(v:unknown)=>new Date(v as string).toISOString();
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Data=Record<string,any>;
const terminal="'no_change','applied','rejected','canceled','failed','sample_passed'";
const scheduleRow=(r:Data)=>({id:r.id,revision:r.revision,policy:r.policy,nextAt:stamp(r.next_at),lastRunId:r.last_run_id,updatedAt:stamp(r.updated_at)});
export function createMaintenanceRepository(pool:PgPool){
  const tx=async<T>(fn:(db:PgClient)=>Promise<T>)=>{const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(e){await db.query('rollback');throw e;}finally{db.release();}};
  const lock=async(db:PgClient)=>{await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-maintenance',0))");};
  const cancel=async(db:PgClient,id:string)=>{
    const row=(await db.query(`update maintenance_runs set status='canceled',updated_at=now() where id=$1 and status not in ('applied','rejected','sample_passed') returning job_id`,[id])).rows[0];
    if(row)await db.query("update jobs set cancel_requested_at=now(),status=case when status='queued' then 'canceled' else status end where id=$1 and status in('queued','running')",[row.job_id]);
    return row?.job_id as string|undefined;
  };
  return {
    async schedules(){return (await pool.query('select * from maintenance_schedules order by updated_at desc limit 100')).rows.map(scheduleRow);},
    async save(id:string|undefined,expected:number|undefined,policy:Data,nextAt:string){return tx(async db=>{
      await lock(db);let key=id??randomUUID();
      if(id){const existing=(await db.query('select * from maintenance_schedules where id=$1 for update',[id])).rows[0];if(!existing||existing.revision!==expected)throw new Error('maintenance.errors.conflict');
        for(const run of (await db.query(`select id from maintenance_runs where schedule_ids ? $1 and status not in(${terminal})`,[id])).rows)await cancel(db,run.id);
        await db.query('update maintenance_schedules set revision=revision+1,policy=$2,next_at=$3,updated_at=now() where id=$1',[id,policy,nextAt]);
      }else{if(Number((await db.query('select count(*) n from maintenance_schedules')).rows[0].n)>=100)throw new Error('maintenance.errors.budget');await db.query('insert into maintenance_schedules(id,policy,next_at) values($1,$2,$3)',[key,policy,nextAt]);}
      return scheduleRow((await db.query('select * from maintenance_schedules where id=$1',[key])).rows[0]!);
    });},
    async scope(scope:Data){
      const sources=new Set<string>(scope.sourceIds),pages=new Set<string>();
      for(const id of scope.pageIds){const p=(await pool.query('select id from wiki_pages where id=$1',[id])).rows[0];if(!p)throw new Error('maintenance.errors.scope');pages.add(id);}
      if(scope.sourceIds.length&&(await pool.query('select id from source_items where id=any($1::uuid[])',[scope.sourceIds])).rows.length!==scope.sourceIds.length)throw new Error('maintenance.errors.scope');
      /* Current page citation provenance never broadens explicit source authorization. */
      if(scope.includePageDescendants&&pages.size){const children=(await pool.query('with recursive tree as(select id from wiki_pages where id=any($1::uuid[]) union select p.id from wiki_pages p join tree t on p.parent_id=t.id) select id from tree limit 201',[[...pages]])).rows;if(children.length>200)throw new Error('maintenance.errors.scope');children.forEach(r=>pages.add(r.id));}
      const excluded=(await pool.query('with recursive tree as(select id from wiki_pages where id=any($1::uuid[]) union select p.id from wiki_pages p join tree t on p.parent_id=t.id) select id from tree limit 201',[scope.excludedPageIds])).rows.map(r=>r.id);if(excluded.length>200)throw new Error('maintenance.errors.scope');
      return {wholeLibrary:scope.wholeLibrary,includePageDescendants:scope.includePageDescendants,pageIds:[...pages].filter(id=>!excluded.includes(id)).sort(),sourceIds:[...sources].sort(),excludedPageIds:excluded.sort()};
    },
    async blockers(exceptJob?:string){
      const r=(await pool.query(`select exists(select 1 from jobs where status in('queued','running') and type<>'maintenance' and id is distinct from $1::uuid) as jobs,exists(select 1 from obsidian_sync_files where status::text in('conflict','pending','local_modified')) as sync`,[exceptJob??null])).rows[0]!;
      return r.jobs?'maintenance.errors.busy':r.sync?'maintenance.errors.sync':null;
    },
    async admit(snapshot:Data,checkpoint:unknown,occurrences:Array<{scheduleId:string;revision:number;key:string;from:string;until:string;nextAt:string}>,manual:boolean){return tx(async db=>{
      await lock(db);
      for(const o of occurrences){const s=(await db.query('select * from maintenance_schedules where id=$1 for update',[o.scheduleId])).rows[0];if(!s||s.revision!==o.revision||(!manual&&!s.policy.enabled))throw new Error('maintenance.errors.revoked');
        const old=(await db.query('select run_id from maintenance_occurrences where schedule_id=$1 and occurrence_key=$2',[o.scheduleId,o.key])).rows[0];if(old)return old.run_id as string;}
      const active=(await db.query(`select * from maintenance_runs where scope_key=$1 and status not in(${terminal}) order by created_at limit 1 for update`,[snapshot.scopeKey])).rows[0];
      // A live run keeps its pinned policy. Only compatible admission may share its result.
      if(active&&(active.snapshot.configurationHash!==snapshot.configurationHash||JSON.stringify(active.snapshot.instructions)!==JSON.stringify(snapshot.instructions)||hash({...active.snapshot.policy,name:null,enabled:null,cadence:null})!==hash({...snapshot.policy,name:null,enabled:null,cadence:null})))throw new Error('maintenance.errors.wait');
      let id=active?.id as string|undefined;
      if(!id){
        const reserved=(await db.query('select reservation from maintenance_budget_reservations where scope_key=$1 and period=$2',[snapshot.scopeKey,snapshot.period])).rows;
        for(const key of ['calls','tokens','spend','inspected','changes']){const limit=snapshot.policy.periodBudget[key];if(limit!==null&&(snapshot.policy.budget[key]===null||reserved.reduce((n,r)=>n+(r.reservation[key]??0),0)+snapshot.policy.budget[key]>limit))throw new Error('maintenance.errors.period');}
        id=randomUUID();const job=(await db.query("insert into jobs(type,payload,max_attempts) values('maintenance',$1,3) returning id",[{maintenanceRunId:id}])).rows[0]!.id;
        await db.query('insert into maintenance_runs(id,job_id,scope_key,period,schedule_ids,snapshot,checkpoint,reservation) values($1,$2,$3,$4,$5,$6,$7,$8)',[id,job,snapshot.scopeKey,snapshot.period,occurrences.map(o=>o.scheduleId),snapshot,checkpoint,snapshot.policy.modelEnabled?snapshot.policy.budget:{...snapshot.policy.budget,calls:0,tokens:0,spend:0,changes:0}]);
        await db.query("insert into maintenance_budget_reservations(run_id,scope_key,period,reservation) values($1,$2,$3,$4)",[id,snapshot.scopeKey,snapshot.period,snapshot.policy.modelEnabled?snapshot.policy.budget:{...snapshot.policy.budget,calls:0,tokens:0,spend:0,changes:0}]);
      }
      for(const o of occurrences){await db.query('insert into maintenance_occurrences(schedule_id,occurrence_key,due_from,due_until,run_id) values($1,$2,$3,$4,$5)',[o.scheduleId,o.key,o.from,o.until,id]);
        await db.query('update maintenance_schedules set last_run_id=$2,next_at=case when $4 then next_at else $3 end where id=$1',[o.scheduleId,id,o.nextAt,manual]);}
      if(active)await db.query('update maintenance_runs set schedule_ids=$2 where id=$1',[id,[...new Set([...active.schedule_ids,...occurrences.map(o=>o.scheduleId)])]]);
      return id;
    });},
    async sample(snapshot:unknown,checkpoint:unknown){return tx(async db=>{const id=randomUUID(),job=(await db.query("insert into jobs(type,payload,max_attempts) values('maintenance',$1,1) returning id",[{maintenanceRunId:id}])).rows[0]!.id;await db.query("insert into maintenance_runs(id,job_id,scope_key,period,schedule_ids,snapshot,checkpoint,reservation) values($1,$2,'sample','sample','[]',$3,$4,'{}')",[id,job,snapshot,checkpoint]);return id;});},
    async get(id:string){const r=(await pool.query('select * from maintenance_runs where id=$1',[id])).rows[0];if(!r)return null;const receipts=(await pool.query('select page_id as "pageId",revision_id as "revisionId" from maintenance_receipts where run_id=$1',[id])).rows;return {id:r.id,jobId:r.job_id,scheduleIds:r.schedule_ids,status:receipts.length?'applied':r.status,snapshot:r.snapshot,checkpoint:r.checkpoint,proposal:r.proposal,receipts,createdAt:stamp(r.created_at),updatedAt:stamp(r.updated_at)};},
    async list(){return (await pool.query(`select id,job_id as "jobId",schedule_ids as "scheduleIds",status,snapshot->'policy'->>'name' as name,snapshot->'policy'->>'routine' as routine,checkpoint,proposal,created_at as "createdAt",updated_at as "updatedAt" from maintenance_runs order by created_at desc limit 50`)).rows.map(r=>{const {checkpoint:c,proposal:p,...rest}=r;return {...rest,inspected:c.inspected,total:c.total,findings:c.findings,deferred:c.deferred,changes:p?.operations.length??0,error:c.error,createdAt:stamp(r.createdAt),updatedAt:stamp(r.updatedAt)};});},
    async checkpoint(id:string,status:string,checkpoint:unknown){await pool.query(`update maintenance_runs set status=$2,checkpoint=$3,updated_at=now() where id=$1 and status not in('canceled','applied','rejected','sample_passed','awaiting_review','no_change')`,[id,status,checkpoint]);},
    async modelStarted(id:string){await pool.query("update maintenance_runs set checkpoint=jsonb_set(checkpoint,'{modelState}','\"active\"'::jsonb) where id=$1 and status='analyzing' and checkpoint->>'callPending'='true'",[id]);},
    async defer(id:string,error:string){await pool.query("update maintenance_runs set checkpoint=jsonb_set(checkpoint,'{error}',to_jsonb($2::text)),updated_at=now() where id=$1 and status='queued'",[id,error]);},
    async cancel(id:string){return tx(async db=>{await lock(db);return cancel(db,id);});},
    async retry(id:string){return tx(async db=>{await lock(db);const r=(await db.query('select * from maintenance_runs where id=$1 for update',[id])).rows[0];if(!r||!['failed'].includes(r.status)||r.checkpoint.callPending||r.checkpoint.error!=='maintenance.errors.failed')throw new Error('maintenance.errors.retry');
      for(const sid of r.schedule_ids){const s=(await db.query('select policy from maintenance_schedules where id=$1',[sid])).rows[0];if(!s?.policy.enabled)throw new Error('maintenance.errors.revoked');}
      const updated=await db.query("update jobs set status='queued',error=null,run_after=now(),locked_at=null,locked_by=null,finished_at=null where id=$1 and status in('failed','succeeded') and attempts<max_attempts",[r.job_id]);if(!updated.rowCount)throw new Error('maintenance.errors.wait');await db.query("update maintenance_runs set status='queued' where id=$1",[id]);
    });},
    async reservePeriod(id:string,period:string){return tx(async db=>{await lock(db);const r=(await db.query('select * from maintenance_runs where id=$1 for update',[id])).rows[0];if(!r||r.status==='canceled')throw new Error('maintenance.errors.revoked');if(r.snapshot.sample)return;
      if((await db.query('select run_id from maintenance_budget_reservations where run_id=$1 and period=$2',[id,period])).rows.length)return;
      const rows=(await db.query('select reservation from maintenance_budget_reservations where scope_key=$1 and period=$2',[r.scope_key,period])).rows;
      for(const k of ['calls','tokens','spend','inspected','changes']){const cap=r.snapshot.policy.periodBudget[k],amount=r.reservation[k];if(cap!==null&&(amount===null||rows.reduce((n,row)=>n+(row.reservation[k]??0),0)+amount>cap))throw new Error('maintenance.errors.period');}
      await db.query('insert into maintenance_budget_reservations(run_id,scope_key,period,reservation) values($1,$2,$3,$4)',[id,r.scope_key,period,r.reservation]);
    });},
    async cursor(scopeKey:string,configurationHash:string){const r=(await pool.query("select checkpoint->'cursor' as cursor from maintenance_runs where scope_key=$1 and snapshot->>'configurationHash'=$2 and status in('no_change','applied','rejected') order by created_at desc limit 1",[scopeKey,configurationHash])).rows[0];return r?.cursor?.kind==='done'?null:r?.cursor??null;},
    async analysisAttempt(id:string,decisions:Array<{key:string;pageId:string}>){return tx(async db=>{await lock(db);const r=(await db.query('select status from maintenance_runs where id=$1 for update',[id])).rows[0];if(r?.status==='canceled')throw new Error('maintenance.errors.revoked');for(const d of decisions)await db.query("insert into maintenance_decisions(key,page_id,run_id,outcome) values($1,$2,$3,'attempt') on conflict do nothing",[d.key,d.pageId,id]);});},
    async decisions(keys:string[],pageIds:string[],cutoff:Date){return (await pool.query('select key,page_id as "pageId" from maintenance_decisions where key=any($1::text[]) or page_id=any($2::uuid[]) and created_at>$3 and outcome<>'attempt'',[keys,pageIds,cutoff])).rows;},
    async settle(id:string,proposal:unknown,checkpoint:Data,decisions:Array<{key:string;pageId:string}>,sample:boolean){return tx(async db=>{await lock(db);const r=(await db.query('select status from maintenance_runs where id=$1 for update',[id])).rows[0];if(!r||r.status==='canceled')throw new Error('maintenance.errors.revoked');const status=sample?'sample_passed':(proposal as Data).operations.length?'awaiting_review':'no_change';await db.query('update maintenance_runs set proposal=$2,checkpoint=$3,status=$4,updated_at=now() where id=$1',[id,proposal,checkpoint,status]);if(!sample)for(const d of decisions)await db.query('insert into maintenance_decisions(key,page_id,run_id,outcome) values($1,$2,$3,$4) on conflict(key) do update set outcome=excluded.outcome',[d.key,d.pageId,id,status]);});},
    async usage(id:string){return (await pool.query(`select sum(a.input_tokens)::float as input,sum(a.output_tokens)::float as output,sum(a.cost_estimate)::float as cost,count(*)::int as calls,count(a.input_tokens)::int as inputs,count(a.output_tokens)::int as outputs,count(a.cost_estimate)::int as costs from maintenance_steps s left join ai_task_runs a on a.id=s.ai_task_run_id where s.run_id=$1`,[id])).rows[0]!;},
    async samplePassed(configurationId:string,functionName:string,prompt:string){return !!(await pool.query("select id from maintenance_runs where status='sample_passed' and snapshot->>'configurationId'=$1 and snapshot->'policy'->>'routine'=$2 and snapshot->'instructions'->'slots'->>'advanced'=$3 limit 1",[configurationId,functionName,prompt])).rows.length;},
    async inspect(scope:Data,kind:string,cursor:string|null,cutoff:string,limit:number){
      const pageScope=`($1::boolean or p.id=any($2::uuid[]) or exists(select 1 from wiki_evidence e where e.page_id=p.id and e.source_item_id=any($3::uuid[]) and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text))) and not p.id=any($4::uuid[]) and not p.archived and p.created_at<=$5`;
      const args=[scope.wholeLibrary,scope.pageIds,scope.sourceIds,scope.excludedPageIds,cutoff,cursor,limit];
      if(kind==='page'){
        const rows=(await pool.query(`select p.id,p.current_revision_id as "revisionId",p.title,r.content,r.content_hash as fingerprint,
          exists(select 1 from wiki_page_revisions h left join wiki_page_revisions prev on prev.id=h.parent_revision_id where h.page_id=p.id and h.origin='human' and (prev.id is null or h.content->'parentId' is distinct from prev.content->'parentId' or h.content->'collectionIds' is distinct from prev.content->'collectionIds')) as manual,
          (select count(*)::int from wiki_pages child where child.parent_id=p.id and not child.archived) as children,
          exists(select 1 from wiki_dependencies d where d.revision_id=r.id and d.stale_reason is not null) as stale,
          exists(select 1 from wiki_evidence e left join chunks c on c.id=e.chunk_id left join documents doc on doc.id=e.document_id where e.page_id=p.id and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text) and (c.id is null or c.content_hash<>e.snapshot->>'contentHash' or doc.metadata->>'supersededByDocumentId' is not null)) as broken,
          array(select distinct e.source_item_id from wiki_evidence e where e.page_id=p.id and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text)) as "sourceIds",
          array(select q.id from wiki_pages q join wiki_page_revisions qr on qr.id=q.current_revision_id where q.id<>p.id and not q.archived and not q.id=any($4::uuid[]) and ($1::boolean or q.id=any($2::uuid[])) and (unaccent(lower(q.title))=unaccent(lower(p.title)) or exists(select 1 from jsonb_array_elements_text(qr.content->'aliases') alias where unaccent(lower(alias))=unaccent(lower(p.title)))) order by q.id limit 5) as "relatedIds"
          from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where ${pageScope} and ($6::uuid is null or p.id>$6) order by p.id limit $7`,args)).rows;
        for(const r of rows)r.path=(await pool.query(`with recursive a as(select id,parent_id,title,0 as depth from wiki_pages where id=$1 union all select p.id,p.parent_id,p.title,a.depth+1 from wiki_pages p join a on p.id=a.parent_id where a.depth<100) select id,title from a order by depth desc`,[r.id])).rows;
        const total=Number((await pool.query(`select count(*) n from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where ${pageScope}`,args.slice(0,5))).rows[0].n);return {rows,total};
      }
      const sourceAllowed=`($1::boolean or s.id=any($3::uuid[])) and cardinality($2::uuid[])>=0 and cardinality($4::uuid[])>=0`;
      if(kind==='source'){
        const where=`${sourceAllowed} and s.created_at<=$5`;
        const rows=(await pool.query(`select s.id,s.title,md5(jsonb_build_array(s.title,s.updated_at)::text) as fingerprint,not exists(select 1 from wiki_evidence e join wiki_pages p on p.id=e.page_id join wiki_page_revisions r on r.id=p.current_revision_id where e.source_item_id=s.id and not p.archived and exists(select 1 from jsonb_array_elements(r.content->'sections') sec where sec->'evidenceIds' ? e.id::text)) as unplaced from source_items s where ${where} and ($6::uuid is null or s.id>$6) order by s.id limit $7`,args)).rows;
        const total=Number((await pool.query(`select count(*) n from source_items s where ${where}`,args.slice(0,5))).rows[0].n);return {rows,total};
      }
      const where=`${sourceAllowed} and n.created_at<=$5 and n.status not in('rejected','archived') and n.supersession_status='current' and not exists(select 1 from atomic_note_source_links l where l.atomic_note_id=n.id and not($1::boolean or l.source_item_id=any($3::uuid[])))`;
      const rows=(await pool.query(`select n.id,n.title,s.id as "sourceItemId",md5(jsonb_build_array(n.title,n.body_markdown,n.updated_at)::text) as fingerprint,left(n.body_markdown,2000) as excerpt,not exists(select 1 from wiki_dependencies d join wiki_pages p on p.current_revision_id=d.revision_id where d.kind='atomic_note' and d.input_id=n.id) as disconnected from atomic_notes n join source_items s on s.id=n.created_from_source_item_id where ${where} and ($6::uuid is null or n.id>$6) order by n.id limit $7`,args)).rows;
      const total=Number((await pool.query(`select count(*) n from atomic_notes n join source_items s on s.id=n.source_item_id where ${where}`,args.slice(0,5))).rows[0].n);return {rows,total};
    },
    async validateObjects(objects:Data[]){for(const o of objects.filter(o=>o.kind==='page')){const p=(await pool.query('select current_revision_id from wiki_pages where id=$1',[o.id])).rows[0];if(p?.current_revision_id!==o.revisionId)throw new Error('maintenance.errors.conflict');}},
    async review(id:string,decision:string,validate:(run:Data)=>Array<{id:string;expectedRevisionId:string;content:any;evidenceChunkIds:string[]}>){return tx(async db=>{
      await lock(db);await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
      const run=(await db.query('select * from maintenance_runs where id=$1 for update',[id])).rows[0];if(!run)throw new Error('maintenance.errors.scope');if(run.status==='applied')return;
      if(run.status!=='awaiting_review')throw new Error('maintenance.errors.revoked');
      if(decision==='reject'){await db.query("update maintenance_runs set status='rejected',updated_at=now() where id=$1",[id]);await db.query("update maintenance_decisions set outcome='rejected',created_at=now() where run_id=$1",[id]);return;}
      if((await db.query("select id from jobs where status in('queued','running') and type<>'maintenance' limit 1")).rows.length)throw new Error('maintenance.errors.busy');
      if((await db.query("select id from obsidian_sync_files where status::text in('conflict','pending','local_modified') limit 1")).rows.length)throw new Error('maintenance.errors.sync');
      const inputs=validate(run);
      for(const candidate of run.checkpoint.candidates.filter((c:Data)=>c.kind==='page')){const row=(await db.query('select current_revision_id from wiki_pages where id=$1 for update',[candidate.id])).rows[0];if(row?.current_revision_id!==candidate.revisionId)throw new Error('maintenance.errors.conflict');}
      for(const input of inputs){await createWikiRepository(pool).save(input,{transaction:db,origin:'organization',allocatedTarget:false,humanApproved:true});const revision=(await db.query('select current_revision_id from wiki_pages where id=$1',[input.id])).rows[0]!.current_revision_id;await db.query('insert into maintenance_receipts(run_id,page_id,revision_id) values($1,$2,$3)',[id,input.id,revision]);}
      await db.query("update maintenance_runs set status='applied',updated_at=now() where id=$1",[id]);await db.query("update maintenance_decisions set outcome='applied',created_at=now() where run_id=$1",[id]);
    });}
  };
}
