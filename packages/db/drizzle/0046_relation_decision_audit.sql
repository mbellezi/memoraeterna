-- Each decided direction keeps the AI run and the time of its own verdict. The pair-level columns
-- were overwritten by whichever direction was decided last, so a verdict could point to the run of
-- the other direction.
ALTER TABLE "relation_decisions" ADD COLUMN "lo_to_hi_ai_task_run_id" uuid;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD COLUMN "lo_to_hi_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD COLUMN "hi_to_lo_ai_task_run_id" uuid;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD COLUMN "hi_to_lo_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_lo_to_hi_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("lo_to_hi_ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_hi_to_lo_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("hi_to_lo_ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Best known audit for every direction that has a verdict: the run and time the pair last recorded.
UPDATE "relation_decisions" SET
  "lo_to_hi_ai_task_run_id" = CASE WHEN "lo_to_hi_score" IS NOT NULL THEN "ai_task_run_id" END,
  "lo_to_hi_decided_at" = CASE WHEN "lo_to_hi_score" IS NOT NULL THEN "decided_at" END,
  "hi_to_lo_ai_task_run_id" = CASE WHEN "hi_to_lo_score" IS NOT NULL THEN "ai_task_run_id" END,
  "hi_to_lo_decided_at" = CASE WHEN "hi_to_lo_score" IS NOT NULL THEN "decided_at" END;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_decided_at" CHECK (("relation_decisions"."lo_to_hi_score" is null) = ("relation_decisions"."lo_to_hi_decided_at" is null)
        and ("relation_decisions"."hi_to_lo_score" is null) = ("relation_decisions"."hi_to_lo_decided_at" is null)
        and ("relation_decisions"."lo_to_hi_score" is not null or "relation_decisions"."lo_to_hi_ai_task_run_id" is null)
        and ("relation_decisions"."hi_to_lo_score" is not null or "relation_decisions"."hi_to_lo_ai_task_run_id" is null));--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_ai_task_run_id_ai_task_runs_id_fk";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP COLUMN "decided_at";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP COLUMN "ai_task_run_id";
