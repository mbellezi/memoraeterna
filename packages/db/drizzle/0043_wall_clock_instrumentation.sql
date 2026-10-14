ALTER TABLE "ai_task_runs" ADD COLUMN "queue_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD COLUMN "attempt_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD COLUMN "ended_at" timestamp with time zone;