CREATE TABLE "monitoring_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"operation" text NOT NULL,
	"task_type" text,
	"stage" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"model_id" text,
	"runtime" text,
	"profile_id" uuid,
	"ai_task_run_id" uuid,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"token_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_estimate" double precision,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"debug_recorded" boolean DEFAULT false NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "monitoring_operations" ADD CONSTRAINT "monitoring_operations_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitoring_operations_started_idx" ON "monitoring_operations" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "monitoring_operations_kind_status_idx" ON "monitoring_operations" USING btree ("kind","status","started_at");--> statement-breakpoint
-- Seed existing audit history once. Missing historical provenance and usage remain explicitly unknown.
INSERT INTO monitoring_operations (kind, operation, task_type, stage, context, sources, provider,
  model_id, runtime, profile_id, ai_task_run_id, status, started_at, finished_at, duration_ms,
  token_usage, cost_estimate, parameters, error)
SELECT 'ai', run.task_type, run.task_type, run.task_type,
  '{"origin":"legacy_audit","provenanceUnavailable":true}'::jsonb,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id', source.id, 'title', source.title) ORDER BY source.title, source.id)
    FROM ai_task_run_sources link JOIN source_items source ON source.id=link.source_item_id
    WHERE link.ai_task_run_id=run.id), '[]'::jsonb),
  run.provider, run.model_id, run.runtime, run.profile_id, run.id,
  CASE WHEN run.status IN ('succeeded','failed','canceled') THEN run.status ELSE 'interrupted' END,
  run.started_at, coalesce(run.finished_at, run.started_at), run.duration_ms,
  jsonb_strip_nulls(jsonb_build_object('inputTokens', run.input_tokens, 'outputTokens', run.output_tokens,
    'totalTokens', CASE WHEN run.task_type='embedding' THEN run.input_tokens ELSE run.input_tokens + run.output_tokens END)),
  run.cost_estimate, run.parameters, run.error
FROM ai_task_runs run;
