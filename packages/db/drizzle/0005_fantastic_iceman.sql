CREATE TABLE "local_model_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_model_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"current_file" text,
	"downloaded_bytes" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint NOT NULL,
	"bytes_per_second" bigint DEFAULT 0 NOT NULL,
	"eta_seconds" integer,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_model_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_model_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"expected_size_bytes" bigint NOT NULL,
	"downloaded_size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_id" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"family" text NOT NULL,
	"variant" text NOT NULL,
	"repository" text NOT NULL,
	"revision" text NOT NULL,
	"runtime" text NOT NULL,
	"format" text NOT NULL,
	"quantization" text NOT NULL,
	"managed_path" text,
	"expected_size_bytes" bigint NOT NULL,
	"installed_size_bytes" bigint DEFAULT 0 NOT NULL,
	"manifest_hash" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"license_name" text NOT NULL,
	"license_url" text NOT NULL,
	"license_accepted_at" timestamp with time zone,
	"status" text DEFAULT 'not_downloaded' NOT NULL,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" ADD COLUMN "local_model_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "adapter" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "revision" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "quantization" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "local_model_downloads" ADD CONSTRAINT "local_model_downloads_local_model_id_local_models_id_fk" FOREIGN KEY ("local_model_id") REFERENCES "public"."local_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_model_downloads" ADD CONSTRAINT "local_model_downloads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_model_files" ADD CONSTRAINT "local_model_files_local_model_id_local_models_id_fk" FOREIGN KEY ("local_model_id") REFERENCES "public"."local_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_model_downloads_job_id_uidx" ON "local_model_downloads" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "local_model_downloads_model_id_idx" ON "local_model_downloads" USING btree ("local_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_model_files_model_path_uidx" ON "local_model_files" USING btree ("local_model_id","relative_path");--> statement-breakpoint
CREATE INDEX "local_model_files_status_idx" ON "local_model_files" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "local_models_catalog_id_uidx" ON "local_models" USING btree ("catalog_id");--> statement-breakpoint
CREATE INDEX "local_models_runtime_idx" ON "local_models" USING btree ("runtime");--> statement-breakpoint
CREATE INDEX "local_models_status_idx" ON "local_models" USING btree ("status");--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" ADD CONSTRAINT "ai_profile_tasks_local_model_id_local_models_id_fk" FOREIGN KEY ("local_model_id") REFERENCES "public"."local_models"("id") ON DELETE set null ON UPDATE no action;