import { isNonReviewableValidation } from '@app/domain';
import type { PgPool } from '../client.js';
type Db=Pick<PgPool,'query'>;
/** Called in a transaction. Rejection is owned by validation, never attributed to the user. */
export async function recordValidationRejection(db:Db,id:string){
  const initial=(await db.query('select snapshot from organization_runs where id=$1',[id])).rows[0];
  if(initial?.snapshot.version!=='wiki-curator-v2')return false;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['wiki-policy:'+initial.snapshot.policy.id]);
  const row=(await db.query('select * from organization_runs where id=$1 for update',[id])).rows[0];
  if(!row||!['analyzing','failed'].includes(row.status)||!isNonReviewableValidation(row.checkpoint,row.snapshot.limits))return false;
  const checkpoint={...row.checkpoint,rejection:{kind:'automatic_validation',decidedAt:new Date().toISOString()}};
  if(checkpoint.proposal)await db.query("insert into organization_proposals(run_id,proposal,decision,decided_at) values($1,$2,'reject',now()) on conflict(run_id) do update set decision='reject',decided_at=now() where organization_proposals.decision is null",[id,checkpoint.proposal]);
  await db.query("update organization_runs set status='rejected',checkpoint=$2,updated_at=clock_timestamp() where id=$1",[id,checkpoint]);
  return true;
}
