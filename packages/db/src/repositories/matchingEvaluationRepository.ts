import type { PgPool } from "../client.js";
import { z } from "zod";

const savedMatchingSchema = z.object({
  noteRelations:z.array(z.object({id:z.string().uuid(),source_atomic_note_id:z.string().uuid(),target_atomic_note_id:z.string().uuid(),status:z.literal("pending_review")}).passthrough()).max(100000),
  sourceRelations:z.array(z.object({id:z.string().uuid(),source_item_id:z.string().uuid(),target_source_item_id:z.string().uuid(),status:z.literal("pending_review")}).passthrough()).max(100000),
  sourceEvidence:z.array(z.object({id:z.string().uuid(),relation_id:z.string().uuid(),note_relation_id:z.string().uuid().nullable()}).passthrough()).max(100000)
});

/** Evaluation snapshots and a guarded synthetic-only reset for the explicit DEV runner. */
export function createMatchingEvaluationRepository(pool: PgPool) {
  return {
    async resetPilotMatching(sourceIds: string[], expectedSourceCount: 20 | 62 | 82 = 20, savedMatching?: unknown) {
      if (sourceIds.length !== expectedSourceCount || new Set(sourceIds).size !== expectedSourceCount) throw new Error(`Expected exactly the ${expectedSourceCount} synthetic source IDs`);
      const restored=savedMatching===undefined?undefined:savedMatchingSchema.parse(savedMatching);
      if(restored) {
        const allowed=new Set(sourceIds),sourceRelations=new Set(restored.sourceRelations.map(r=>r.id)),noteRelations=new Set(restored.noteRelations.map(r=>r.id));
        if(restored.sourceRelations.some(r=>!allowed.has(r.source_item_id)||!allowed.has(r.target_source_item_id))
          ||restored.sourceEvidence.some(r=>!sourceRelations.has(r.relation_id)||(r.note_relation_id!==null&&!noteRelations.has(r.note_relation_id)))) throw Error("Snapshot contains unrelated relationships or evidence");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("lock table source_relations, atomic_note_relations in share row exclusive mode");
        const check = (await client.query(`select
          (select count(*)::int from source_items) as total,
          (select count(*)::int from source_items where id=any($1::uuid[])) as selected,
          (select count(*)::int from source_relations where status <> 'pending_review') +
          (select count(*)::int from atomic_note_relations where status <> 'pending_review') as reviewed,
          (select count(*)::int from jobs j join ingestion_runs r on r.job_id=j.id where j.status in ('queued','running')) as active`, [sourceIds])).rows[0]!;
        if (check.total !== expectedSourceCount || check.selected !== expectedSourceCount || check.reviewed !== 0 || check.active !== 0) throw new Error("Pilot rematch refuses unrelated sources, reviewed relationships or active ingestion");
        if(restored?.noteRelations.length) {
          const valid=(await client.query(`select count(*)::int as count from json_to_recordset($1::json) as r(source_atomic_note_id uuid,target_atomic_note_id uuid)
            join atomic_notes a on a.id=r.source_atomic_note_id join atomic_notes b on b.id=r.target_atomic_note_id
            where a.created_from_source_item_id=any($2::uuid[]) and b.created_from_source_item_id=any($2::uuid[])`,[JSON.stringify(restored.noteRelations),sourceIds])).rows[0]!.count;
          if(valid!==restored.noteRelations.length) throw Error("Snapshot notes do not belong to the synthetic library");
        }
        const source = await client.query("delete from source_relations where source_item_id=any($1::uuid[]) and target_source_item_id=any($1::uuid[])", [sourceIds]);
        const notes = await client.query(`delete from atomic_note_relations r using atomic_notes a, atomic_notes b
          where a.id=r.source_atomic_note_id and b.id=r.target_atomic_note_id
          and a.created_from_source_item_id=any($1::uuid[]) and b.created_from_source_item_id=any($1::uuid[])`, [sourceIds]);
        await client.query("delete from source_matching_decisions where source_root_id=any($1::uuid[]) and target_root_id=any($1::uuid[])", [sourceIds]);
        await client.query("delete from source_matching_runs where source_root_id=any($1::uuid[])", [sourceIds]);
        if(restored) {
          for(const [table,rows] of [["atomic_note_relations",restored.noteRelations],["source_relations",restored.sourceRelations],["source_relation_evidence",restored.sourceEvidence]] as const) {
            if(rows.length) await client.query(`insert into ${table} select * from json_populate_recordset(null::${table},$1::json)`,[JSON.stringify(rows)]);
          }
        }
        await client.query("commit");
        return { noteRelations: notes.rowCount, sourceRelations: source.rowCount };
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    },
    async canonicalFingerprint(sourceIds: string[]) {
      const result: Record<string, { count: number; digest: string | null }> = {};
      const definitions = {
        source_items: "id", documents: "source_item_id", chunks: "source_item_id", source_spans: "source_item_id",
        atomic_notes: "created_from_source_item_id", entity_mentions: "source_item_id", claims: "source_item_id",
        entity_relations: "source_item_id", source_summaries: "source_item_id"
      };
      for (const [table, column] of Object.entries(definitions)) {
        // Exclude mutable timestamps/progress but include content, identity and evidence fields.
        result[table] = (await pool.query(`select count(*)::int as count, md5(string_agg((to_jsonb(t)-'updated_at'-'last_processed_at')::text, '' order by id)) as digest
          from ${table} t where ${column}=any($1::uuid[])`, [sourceIds])).rows[0]!;
      }
      return result;
    },
    async preflight() {
      return (await pool.query(`select current_database() as database,
        (select count(*)::int from source_items) as sources,
        (select count(*)::int from atomic_notes) as notes,
        (select count(*)::int from source_relations) as source_relations,
        (select count(*)::int from ai_profile_sets) as profiles`)).rows[0]!;
    },
    async progress(batchId: string, since: string) {
      const [runs, usage] = await Promise.all([
        pool.query(`select s.title, r.id, r.status, r.current_stage, r.error, r.stages_checkpoint, r.job_id, j.status as job_status
          from ingestion_runs r join source_items s on s.id = r.source_item_id left join jobs j on j.id=r.job_id where r.batch_id = $1 order by s.title`, [batchId]),
        pool.query(`select count(*)::int as calls, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
          sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) as reported_tokens,
          count(*) filter (where input_tokens is null)::int as missing_input_usage,
          count(*) filter (where output_tokens is null and task_type <> 'embedding')::int as missing_output_usage
          from ai_task_runs where started_at >= $1`, [since])
      ]);
      return { runs: runs.rows, usage: usage.rows[0]! };
    },
    async snapshot(sourceIds: string[], since: string) {
      const queries = {
        sources: ["select id,title,type,parent_source_item_id from source_items where id=any($1::uuid[]) order by title", [sourceIds]],
        notes: ["select id,created_from_source_item_id,title,idea_statement,body_markdown,status from atomic_notes where created_from_source_item_id=any($1::uuid[]) order by created_from_source_item_id,title", [sourceIds]],
        noteRelations: [`select r.* from atomic_note_relations r join atomic_notes n on n.id=r.source_atomic_note_id
          where n.created_from_source_item_id=any($1::uuid[]) order by r.final_score desc`, [sourceIds]],
        sourceRelations: ["select * from source_relations where source_item_id=any($1::uuid[]) or target_source_item_id=any($1::uuid[]) order by created_at", [sourceIds]],
        sourceEvidence: ["select e.* from source_relation_evidence e join source_relations r on r.id=e.relation_id where r.source_item_id=any($1::uuid[]) or r.target_source_item_id=any($1::uuid[]) order by e.relation_id,e.created_at", [sourceIds]],
        sourceDecisions: ["select * from source_matching_decisions where source_root_id=any($1::uuid[]) and target_root_id=any($1::uuid[]) order by created_at,key", [sourceIds]],
        sourceRuns: ["select * from source_matching_runs where source_root_id=any($1::uuid[]) order by created_at,key", [sourceIds]],
        entities: [`select e.id,e.type,e.canonical_name,e.metadata->>'identityDescription' as identity_description,e.aliases,array_agg(distinct m.source_item_id) as sources
          from entities e join entity_mentions m on m.entity_id=e.id where m.source_item_id=any($1::uuid[])
          group by e.id order by e.canonical_name`, [sourceIds]],
        usage: [`select operation,stage,task_type,model_id,status,count(*)::int as calls,
          sum((token_usage->>'inputTokens')::numeric) as input_tokens,
          sum((token_usage->>'outputTokens')::numeric) as output_tokens,
          sum((token_usage->>'reasoningTokens')::numeric) as reasoning_tokens,
          sum((token_usage->>'cachedInputTokens')::numeric) as cached_input_tokens,
          sum(cost_estimate) as estimated_cost, count(cost_estimate)::int as calls_with_cost,
          sum(duration_ms) as duration_ms from monitoring_operations where kind='ai' and started_at >= $1
          group by operation,stage,task_type,model_id,status order by stage,operation`, [since]],
        diagnostics: ["select r.*,d.query_target_id as source_note_id,d.metadata as run_metadata from similarity_debug_results r join similarity_debug_runs d on d.id=r.run_id where d.created_at >= $1 order by r.run_id,r.final_rank", [since]]
      } as const;
      const result: Record<string, unknown[]> = {};
      for (const [key, [sql, values]] of Object.entries(queries)) result[key] = (await pool.query(sql, [...values])).rows;
      return result;
    }
  };
}
