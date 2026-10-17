-- F3 D29-D31 (T47): the lane scheduler's audit of every AI execution. Every new column is nullable or
-- defaulted, so the rows written before the scheduler keep their values and read as unknown.
ALTER TABLE "ai_task_runs" ADD COLUMN "lane" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "workload_class" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "priority" smallint;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "deadline_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "deadline_outcome" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "is_repair" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "schema_mode" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "retry_wait_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "requeue_ms" integer;--> statement-breakpoint
CREATE INDEX "ai_task_runs_started_class_idx" ON "ai_task_runs" USING btree ("started_at","workload_class");--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_lane" CHECK ("ai_task_runs"."lane" is null or "ai_task_runs"."lane" = 'local' or "ai_task_runs"."lane" ~ '^remote:.{1,200}$');--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_workload_class" CHECK ("ai_task_runs"."workload_class" is null or "ai_task_runs"."workload_class" in ('embed','decide','write-fast','write-quality','answer'));--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_priority" CHECK ("ai_task_runs"."priority" is null or "ai_task_runs"."priority" between 0 and 3);--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_deadline" CHECK (("ai_task_runs"."deadline_ms" is null or "ai_task_runs"."deadline_ms" > 0)
        and ("ai_task_runs"."deadline_outcome" is null or "ai_task_runs"."deadline_outcome" in ('met','aborted','none')));--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_schema_mode" CHECK ("ai_task_runs"."schema_mode" is null or "ai_task_runs"."schema_mode" in ('strict','json','grammar','none'));--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_waits" CHECK (("ai_task_runs"."retry_wait_ms" is null or "ai_task_runs"."retry_wait_ms" >= 0)
        and ("ai_task_runs"."requeue_ms" is null or "ai_task_runs"."requeue_ms" >= 0));