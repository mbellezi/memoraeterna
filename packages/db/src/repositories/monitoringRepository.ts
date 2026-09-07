import type { JsonObject, Queryable } from "./types.js";

export interface MonitoringStart {
  kind: "ai" | "operation"; operation: string; taskType?: string; stage: string;
  context: JsonObject; sourceItemIds: string[]; provider?: string; modelId?: string;
  runtime?: string; profileId?: string; parameters?: JsonObject; debugRecorded: boolean; input?: unknown;
}
export interface MonitoringFinish {
  status: "succeeded" | "failed" | "canceled"; durationMs: number;
  aiTaskRunId?: string; tokenUsage?: Record<string, number>; costEstimate?: number;
  output?: unknown; error?: string; details?: JsonObject; parameters?: JsonObject;
}
export interface MonitoringFilter {
  view: "ai" | "debug"; kind: "all" | "embedding" | "llm" | "operation";
  status: string; search: string; since?: string | undefined; until?: string | undefined; limit: number; offset: number;
}
const columns = `id, kind, operation, task_type as "taskType", stage, context, sources,
  provider, model_id as "modelId", runtime, profile_id as "profileId", ai_task_run_id as "aiTaskRunId",
  status, started_at as "startedAt", finished_at as "finishedAt", duration_ms as "durationMs",
  token_usage as "tokenUsage", cost_estimate as "costEstimate", debug_recorded as "debugRecorded",
  (input is not null or output is not null) as "hasPayload", error`;

export function createMonitoringRepository(db: Queryable) {
  return {
    async start(input: MonitoringStart): Promise<string> {
      const result = await db.query<{ id: string }>(`insert into monitoring_operations
        (kind, operation, task_type, stage, context, sources, provider, model_id, runtime, profile_id,
         parameters, debug_recorded, input, status)
        values ($1,$2,$3,$4,$5,
          coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title) order by title, id)
            from source_items where id = any($6::uuid[])), '[]'::jsonb),$7,$8,$9,$10,$11,$12,$13,'running') returning id`,
      [input.kind, input.operation, input.taskType ?? null, input.stage, input.context, input.sourceItemIds,
        input.provider ?? null, input.modelId ?? null, input.runtime ?? null, input.profileId ?? null,
        input.parameters ?? {}, input.debugRecorded, input.input === undefined ? null : JSON.stringify(input.input)]);
      if (!result.rows[0]) throw new Error("Monitoring insert returned no row.");
      return result.rows[0].id;
    },
    async finish(id: string, input: MonitoringFinish): Promise<void> {
      await db.query(`update monitoring_operations set status=$2, finished_at=now(), duration_ms=$3,
        ai_task_run_id=$4, token_usage=$5, cost_estimate=$6, output=$7, error=$8, details=$9,
        parameters=coalesce($10::jsonb, parameters) where id=$1`,
      [id, input.status, input.durationMs, input.aiTaskRunId ?? null, input.tokenUsage ?? {}, input.costEstimate ?? null,
        input.output === undefined ? null : JSON.stringify(input.output), input.error ?? null, input.details ?? {}, input.parameters ?? null]);
    },
    async recover(): Promise<void> {
      await db.query(`update monitoring_operations set status='interrupted', finished_at=now(),
        duration_ms=least(2147483647, greatest(0, extract(epoch from (now()-started_at))*1000))::integer where status='running'`);
    },
    async list(input: MonitoringFilter) {
      const values: unknown[] = [];
      const where: string[] = [input.view === "ai" ? "kind='ai'" : "debug_recorded=true"];
      const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
      if (input.kind === "embedding") where.push("task_type='embedding'");
      if (input.kind === "llm") where.push("kind='ai' and task_type <> 'embedding'");
      if (input.kind === "operation") where.push("kind='operation'");
      if (input.status !== "all") where.push(`status=${bind(input.status)}`);
      if (input.since) where.push(`started_at >= ${bind(input.since)}::timestamptz`);
      if (input.until) where.push(`started_at <= ${bind(input.until)}::timestamptz`);
      if (input.search.trim()) {
        const query = bind(`%${input.search.trim().replace(/[\\%_]/g, "\\$&")}%`);
        where.push(`concat_ws(' ', id, operation, task_type, stage, provider, model_id, context::text, sources::text) ilike ${query}`);
      }
      const predicate = where.join(" and ");
      // Aggregate the entire filtered history, never just the visible page. Nullable sums distinguish unknown from zero.
      const aggregate = await db.query(`select count(*)::int as count,
        count(*) filter (where status in ('failed','interrupted'))::int as failed,
        count(*) filter (where status='running')::int as running,
        sum((token_usage->>'totalTokens')::double precision) as tokens,
        sum((token_usage->>'inputTokens')::double precision) as "inputTokens",
        sum((token_usage->>'outputTokens')::double precision) as "outputTokens",
        sum((token_usage->>'reasoningTokens')::double precision) as "reasoningTokens",
        sum((token_usage->>'cachedInputTokens')::double precision) as "cachedInputTokens",
        sum(cost_estimate) as "costEstimate",
        count(*) filter (where kind='ai' and not (token_usage ? 'totalTokens'))::int as "missingUsage",
        count(*) filter (where kind='ai' and cost_estimate is null)::int as "missingCost"
        from monitoring_operations where ${predicate}`, values);
      const rows = await db.query(`select ${columns} from monitoring_operations where ${predicate}
        order by started_at desc, id desc limit ${bind(input.limit)} offset ${bind(input.offset)}`, values);
      return { rows: rows.rows, totals: aggregate.rows[0] };
    },
    async detail(id: string) {
      const result = await db.query(`select ${columns}, parameters, details, input, output from monitoring_operations where id=$1`, [id]);
      return result.rows[0] ?? null;
    },
    async prune(cutoff: Date, scope: "all" | "payloads", preview: boolean): Promise<number> {
      const predicate = `finished_at < $1 and status <> 'running'${scope === "payloads" ? " and (input is not null or output is not null)" : ""}`;
      if (preview) {
        const result = await db.query<{ count: number }>(`select ((select count(*) from monitoring_operations where ${predicate})
          ${scope === "all" ? "+ (select count(*) from similarity_debug_runs where created_at < $1)" : ""})::int as count`, [cutoff]);
        return result.rows[0]?.count ?? 0;
      }
      const result = await db.query<{ count: number }>(scope === "payloads"
        ? `with changed as (update monitoring_operations set input=null, output=null where ${predicate} returning 1) select count(*)::int as count from changed`
        : `with changed as (delete from monitoring_operations where ${predicate} returning 1),
          similarity as (delete from similarity_debug_runs where created_at < $1 returning 1)
          select ((select count(*) from changed)+(select count(*) from similarity))::int as count`, [cutoff]);
      return result.rows[0]?.count ?? 0;
    }
  };
}
