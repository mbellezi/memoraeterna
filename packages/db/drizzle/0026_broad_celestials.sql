CREATE TABLE "maintenance_budget_reservations" (
	"run_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"period" text NOT NULL,
	"reservation" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_decisions" (
	"key" text PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"occurrence_key" text NOT NULL,
	"due_from" timestamp with time zone NOT NULL,
	"due_until" timestamp with time zone NOT NULL,
	"run_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_receipts" (
	"run_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"period" text NOT NULL,
	"schedule_ids" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"proposal" jsonb,
	"reservation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_runs_status_check" CHECK ("maintenance_runs"."status" in ('queued','inspecting','analyzing','awaiting_review','no_change','applied','rejected','canceled','failed','sample_passed'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"policy" jsonb NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"last_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"ai_task_run_id" uuid,
	"artifact" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenance_budget_reservations" ADD CONSTRAINT "maintenance_budget_reservations_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_decisions" ADD CONSTRAINT "maintenance_decisions_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrences_schedule_id_maintenance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."maintenance_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrences_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_receipts" ADD CONSTRAINT "maintenance_receipts_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_receipts" ADD CONSTRAINT "maintenance_receipts_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_receipts" ADD CONSTRAINT "maintenance_receipts_revision_id_wiki_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_runs" ADD CONSTRAINT "maintenance_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_steps" ADD CONSTRAINT "maintenance_steps_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_steps" ADD CONSTRAINT "maintenance_steps_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_budget_run_period_idx" ON "maintenance_budget_reservations" USING btree ("run_id","period");--> statement-breakpoint
CREATE INDEX "maintenance_budget_scope_period_idx" ON "maintenance_budget_reservations" USING btree ("scope_key","period");--> statement-breakpoint
CREATE INDEX "maintenance_decisions_page_idx" ON "maintenance_decisions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_occurrences_identity_idx" ON "maintenance_occurrences" USING btree ("schedule_id","occurrence_key");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_receipts_run_page_idx" ON "maintenance_receipts" USING btree ("run_id","page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_runs_job_idx" ON "maintenance_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "maintenance_runs_period_idx" ON "maintenance_runs" USING btree ("scope_key","period");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_due_idx" ON "maintenance_schedules" USING btree ("next_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_steps_sequence_idx" ON "maintenance_steps" USING btree ("run_id","sequence");