import type { AutomaticWikiPolicy } from "@app/domain";
import type { PgPool } from "../client.js";

// A review save refreshes membership revision pointers but not their content.
const withoutReview = (
  value: string
) => `jsonb_build_object('content',${value}-'review'-'automatic',
 'automatic',(${value}->'automatic')-'memberships',
 'memberships',(select jsonb_agg(m.value-'expectedPageRevisionId' order by m.ordinality)
   from jsonb_array_elements(coalesce(${value}->'automatic'->'memberships','[]')) with ordinality m))`;

/** Retire legacy review-only triggers without approving or rejecting their prose. */
export function createWikiImpactReconciliationRepository(pool: PgPool) {
  return {
    async editorial(policy: AutomaticWikiPolicy) {
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          "wiki-policy:" + policy.id
        ]);
        const activation = (
          await db.query(
            "select state,revision_id from wiki_policy_activations where policy_id=$1 order by created_at desc,id desc limit 1",
            [policy.id]
          )
        ).rows[0];
        if (activation?.state !== "enabled" || activation.revision_id !== policy.revisionId) {
          await db.query("commit");
          return [];
        }
        const rows = (
          await db.query(
            `select d.id,d.checkpoint,d.receipt,child.id child_id,child.status child_status
    from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id
    left join organization_runs child on child.id::text=d.checkpoint->>'childRunId'
    where d.consumer='curator' and d.consumer_key=$1 and right(d.input_generation,36)=$2
    and (d.status<>'acknowledged' or d.receipt->>'kind'='attention')
    and e.kind='wiki_page' and e.operation='update' and e.causal_run_id is null
    and d.checkpoint->>'bootstrapId' is null
    and (child.id is null or child.status in('awaiting_review','applied'))
    and exists(select 1 from wiki_page_revisions r join wiki_page_revisions old on old.id=r.parent_revision_id
      where r.page_id=e.input_id and r.origin='human' and r.created_at<=e.created_at
      and md5((r.content-'pinned'-'position'-'parentId')::text)=e.fingerprint
      and r.content->'review' is distinct from old.content->'review'
      and ${withoutReview("r.content")}=${withoutReview("old.content")})
    order by e.created_at,d.id limit 100 for update of d skip locked`,
            [policy.id, policy.revisionId]
          )
        ).rows;
        for (const row of rows) {
          // Only a finished, unapplied proposal exclusively owned by this obsolete
          // trigger can be technically canceled. Shared/active/applied work survives.
          const canceled =
            row.child_status === "awaiting_review"
              ? (
                  await db.query(
                    `update organization_runs child
     set status='canceled',checkpoint=jsonb_set(checkpoint,'{error}','"organization.errors.supersededTrigger"'),updated_at=clock_timestamp()
     where child.id=$1 and child.status='awaiting_review' and coalesce((checkpoint->>'callPending')::boolean,false)=false
     and child.snapshot->>'parentBootstrapId' is null and child.snapshot->'policy'->>'id'=$3 and child.snapshot->'policy'->>'revisionId'=$4
     and not exists(select 1 from wiki_group_receipts where run_id=child.id)
     and not exists(select 1 from knowledge_impact_deliveries other where other.id<>$2
       and (other.checkpoint->>'childRunId'=child.id::text or other.checkpoint->>'bootstrapId' in(
         select b.id::text from organization_runs b where b.checkpoint->>'childRunId'=child.id::text))
       and (other.status<>'acknowledged' or other.receipt->>'kind'='attention'))
     returning child.id`,
                    [row.child_id, row.id, policy.id, policy.revisionId]
                  )
                ).rows[0]?.id
              : null;
          await db.query(
            `update knowledge_impact_deliveries set status='acknowledged',lease_until=null,defer_until=null,
      receipt=jsonb_build_object('kind','excluded','reason','editorial_review_only','runId',$2::text,'previousAttention',receipt),
      updated_at=clock_timestamp() where id=$1`,
            [row.id, row.child_id]
          );
          await db.query(
            `update maintenance_runs set status='inspecting',
      checkpoint=checkpoint||'{"reason":null,"incomplete":false,"impactDeliveryId":null}'::jsonb||
       case when checkpoint->>'reviewChildId'=$3::text then '{"reviewChildId":null}'::jsonb else '{}'::jsonb end,
      updated_at=clock_timestamp() where snapshot->'policy'->>'policyId'=$1 and status='awaiting_review'
      and checkpoint->>'reason'='organization.errors.review'
      and (checkpoint->>'impactDeliveryId'=$2::text or checkpoint->>'reviewChildId'=$3::text)`,
            [policy.id, row.id, canceled ?? null]
          );
        }
        await db.query("commit");
        return rows.map((r) => r.id as string);
      } catch (error) {
        await db.query("rollback");
        throw error;
      } finally {
        db.release();
      }
    }
  };
}
