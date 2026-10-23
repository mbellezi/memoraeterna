-- F4 D14 (T76): the RemoteBudget's columns on the AI audit. Every new column is nullable, so rows written
-- before 0061 keep reading as unknown; the partial index serves the monthly ledger of background remote
-- spend (background rows, and the unclassified P2/P3 rows written before this migration).
ALTER TABLE "ai_task_runs" ADD COLUMN "budget_class" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "budget_estimate_usd" double precision;--> statement-breakpoint
CREATE INDEX "ai_task_runs_budget_ledger_idx" ON "ai_task_runs" USING btree ("started_at") WHERE "ai_task_runs"."lane" like 'remote:%' and ("ai_task_runs"."budget_class" = 'background' or ("ai_task_runs"."budget_class" is null and "ai_task_runs"."priority" between 2 and 3));--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_budget_class" CHECK (("ai_task_runs"."budget_class" is null or "ai_task_runs"."budget_class" in ('user','background','interactive'))
        and ("ai_task_runs"."budget_estimate_usd" is null or "ai_task_runs"."budget_estimate_usd" >= 0));
