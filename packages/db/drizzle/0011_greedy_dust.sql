CREATE TYPE "public"."document_division_review_status" AS ENUM('proposed', 'accepted', 'rejected', 'edited');--> statement-breakpoint
CREATE TYPE "public"."document_structure_status" AS ENUM('draft', 'in_review', 'confirmed', 'materialized', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."ingestion_run_kind" AS ENUM('initial', 'missing_stages', 'reingestion', 'retry_resume');--> statement-breakpoint
CREATE TYPE "public"."ingestion_run_stage_status" AS ENUM('pending', 'running', 'completed', 'skipped', 'failed', 'canceled', 'waiting_for_review');--> statement-breakpoint
CREATE TYPE "public"."processing_batch_status" AS ENUM('pending', 'running', 'waiting_for_review', 'succeeded', 'partial', 'failed', 'canceled');--> statement-breakpoint
ALTER TYPE "public"."source_item_type" ADD VALUE 'PeriodicalIssue' BEFORE 'StandaloneArticle';--> statement-breakpoint
ALTER TYPE "public"."source_item_type" ADD VALUE 'AcademicPaper' BEFORE 'StandaloneArticle';--> statement-breakpoint
ALTER TYPE "public"."source_item_type" ADD VALUE 'DocumentSection' BEFORE 'StandaloneArticle';--> statement-breakpoint
CREATE TABLE "document_divisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"structure_id" uuid NOT NULL,
	"parent_division_id" uuid,
	"child_source_item_id" uuid,
	"child_document_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"level" integer NOT NULL,
	"position" integer NOT NULL,
	"start_selector" jsonb NOT NULL,
	"end_selector" jsonb NOT NULL,
	"start_page" integer,
	"end_page" integer,
	"start_page_label" text,
	"end_page_label" text,
	"markdown_start" integer,
	"markdown_end" integer,
	"content_hash" text,
	"confidence" double precision NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_status" "document_division_review_status" DEFAULT 'proposed' NOT NULL,
	"is_processable" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"supersedes_revision_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"content_hash" text NOT NULL,
	"structure_hash" text,
	"created_by_ingestion_run_id" uuid,
	"reason" text DEFAULT 'initial' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_source_item_id" uuid NOT NULL,
	"root_document_id" uuid NOT NULL,
	"format" text NOT NULL,
	"detector_version" text NOT NULL,
	"status" "document_structure_status" DEFAULT 'draft' NOT NULL,
	"overall_confidence" double precision NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"raw_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"supersedes_structure_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_run_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" "ingestion_run_stage_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"input_hash" text,
	"output_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"document_revision_id" uuid,
	"stage" text NOT NULL,
	"ingestion_run_id" uuid,
	"job_id" uuid,
	"ai_task_run_id" uuid,
	"supersedes_generation_id" uuid,
	"status" text DEFAULT 'current' NOT NULL,
	"input_hash" text,
	"output_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"requested_plan" jsonb NOT NULL,
	"effective_plan" jsonb NOT NULL,
	"reingestion_policy" text DEFAULT 'reuse_valid' NOT NULL,
	"status" "processing_batch_status" DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"completed_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"matching_barrier_released_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "generation_id" uuid;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "supersession_status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "run_kind" "ingestion_run_kind" DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "requested_stages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "effective_stages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "plan_version" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "input_document_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "input_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "supersedes_run_id" uuid;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "previous_artifact_policy" text DEFAULT 'reuse_valid' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "trigger" text DEFAULT 'interactive_import' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_summaries" ADD COLUMN "generation_id" uuid;--> statement-breakpoint
ALTER TABLE "source_summaries" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_structure_id_document_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."document_structures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_parent_division_id_document_divisions_id_fk" FOREIGN KEY ("parent_division_id") REFERENCES "public"."document_divisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_child_source_item_id_source_items_id_fk" FOREIGN KEY ("child_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_child_document_id_documents_id_fk" FOREIGN KEY ("child_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_supersedes_revision_id_document_revisions_id_fk" FOREIGN KEY ("supersedes_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_structures" ADD CONSTRAINT "document_structures_root_source_item_id_source_items_id_fk" FOREIGN KEY ("root_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_structures" ADD CONSTRAINT "document_structures_root_document_id_documents_id_fk" FOREIGN KEY ("root_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_structures" ADD CONSTRAINT "document_structures_supersedes_structure_id_document_structures_id_fk" FOREIGN KEY ("supersedes_structure_id") REFERENCES "public"."document_structures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD CONSTRAINT "ingestion_run_stages_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_generations" ADD CONSTRAINT "knowledge_generations_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_generations" ADD CONSTRAINT "knowledge_generations_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_generations" ADD CONSTRAINT "knowledge_generations_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_generations" ADD CONSTRAINT "knowledge_generations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_generations" ADD CONSTRAINT "knowledge_generations_supersedes_generation_id_knowledge_generations_id_fk" FOREIGN KEY ("supersedes_generation_id") REFERENCES "public"."knowledge_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_divisions_structure_id_idx" ON "document_divisions" USING btree ("structure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_divisions_child_source_uidx" ON "document_divisions" USING btree ("child_source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_divisions_sibling_position_uidx" ON "document_divisions" USING btree ("structure_id","parent_division_id","position") WHERE "document_divisions"."parent_division_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_divisions_root_position_uidx" ON "document_divisions" USING btree ("structure_id","position") WHERE "document_divisions"."parent_division_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_document_revision_uidx" ON "document_revisions" USING btree ("document_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_current_document_uidx" ON "document_revisions" USING btree ("document_id") WHERE "document_revisions"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "document_structures_root_revision_uidx" ON "document_structures" USING btree ("root_source_item_id","revision");--> statement-breakpoint
CREATE INDEX "document_structures_root_status_idx" ON "document_structures" USING btree ("root_source_item_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_run_stages_run_stage_uidx" ON "ingestion_run_stages" USING btree ("ingestion_run_id","stage");--> statement-breakpoint
CREATE INDEX "ingestion_run_stages_status_idx" ON "ingestion_run_stages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "knowledge_generations_source_stage_idx" ON "knowledge_generations" USING btree ("source_item_id","stage","status");--> statement-breakpoint
CREATE INDEX "processing_batches_status_idx" ON "processing_batches" USING btree ("status");--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_generation_id_knowledge_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."knowledge_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_batch_id_processing_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."processing_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_input_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("input_document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_supersedes_run_id_ingestion_runs_id_fk" FOREIGN KEY ("supersedes_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_summaries" ADD CONSTRAINT "source_summaries_generation_id_knowledge_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."knowledge_generations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_created_by_ingestion_run_id_fk" FOREIGN KEY ("created_by_ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_page_range_check" CHECK ("start_page" IS NULL OR "end_page" IS NULL OR "end_page" >= "start_page");
--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_markdown_range_check" CHECK ("markdown_start" IS NULL OR "markdown_end" IS NULL OR "markdown_end" >= "markdown_start");
--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1);
--> statement-breakpoint
ALTER TABLE "document_divisions" ADD CONSTRAINT "document_divisions_level_position_check" CHECK ("level" >= 0 AND "position" >= 0);
--> statement-breakpoint
INSERT INTO "document_revisions" ("document_id", "revision", "is_current", "content_hash", "reason", "metadata")
SELECT "id", 1, true, "content_hash", 'migration_backfill', jsonb_build_object('backfilledAt', now())
FROM "documents"
ON CONFLICT ("document_id", "revision") DO NOTHING;
--> statement-breakpoint
UPDATE "ingestion_runs"
SET "requested_stages" = '["conversion","chunking","embedding","summarization","atomicNotes","knowledgeGraph","atomicNoteMatching","obsidianProjection"]'::jsonb,
    "effective_stages" = '["conversion","chunking","embedding","summarization","atomicNotes","knowledgeGraph","atomicNoteMatching","obsidianProjection"]'::jsonb,
    "input_document_revision_id" = revision."id",
    "input_hashes" = jsonb_build_object('contentHash', document."content_hash")
FROM "documents" document
JOIN "document_revisions" revision ON revision."document_id" = document."id" AND revision."is_current" = true
WHERE document."source_item_id" = "ingestion_runs"."source_item_id";
--> statement-breakpoint
INSERT INTO "ingestion_run_stages" ("ingestion_run_id", "stage", "status", "skip_reason", "progress", "metadata", "started_at", "completed_at", "error")
SELECT run."id", checkpoint.key,
       CASE checkpoint.value ->> 'status'
         WHEN 'completed' THEN 'completed'::"ingestion_run_stage_status"
         WHEN 'running' THEN 'running'::"ingestion_run_stage_status"
         WHEN 'failed' THEN 'failed'::"ingestion_run_stage_status"
         WHEN 'canceled' THEN 'canceled'::"ingestion_run_stage_status"
         WHEN 'skipped' THEN 'skipped'::"ingestion_run_stage_status"
         ELSE 'pending'::"ingestion_run_stage_status"
       END,
       CASE WHEN checkpoint.value ->> 'status' = 'skipped' THEN coalesce(checkpoint.value ->> 'reason', 'legacy_checkpoint') END,
       CASE WHEN checkpoint.value ->> 'status' = 'completed' THEN 10000 ELSE coalesce(((checkpoint.value ->> 'progress')::double precision * 10000)::integer, 0) END,
       coalesce(checkpoint.value -> 'metadata', '{}'::jsonb),
       (checkpoint.value ->> 'startedAt')::timestamptz,
       (checkpoint.value ->> 'completedAt')::timestamptz,
       checkpoint.value ->> 'error'
FROM "ingestion_runs" run
CROSS JOIN LATERAL jsonb_each(run."stages_checkpoint") checkpoint
ON CONFLICT ("ingestion_run_id", "stage") DO NOTHING;
