CREATE TYPE "public"."ingestion_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."integration_client_status" AS ENUM('paired', 'revoked', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."obsidian_sync_status" AS ENUM('pending', 'synced', 'conflict', 'deleted', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."source_item_type" AS ENUM('PersonalNote', 'DailyNote', 'WebArticle', 'Book', 'BookChapter', 'StandaloneArticle', 'Video', 'GenericDocument');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"source_span_id" uuid,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"content_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid,
	"source_item_id" uuid,
	"original_file_name" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_base" text NOT NULL,
	"relative_path" text NOT NULL,
	"role" text DEFAULT 'source' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"title" text NOT NULL,
	"canonical_markdown" text NOT NULL,
	"content_hash" text NOT NULL,
	"language" varchar(16) DEFAULT 'und' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid,
	"job_id" uuid,
	"status" "ingestion_run_status" DEFAULT 'pending' NOT NULL,
	"current_stage" text DEFAULT 'queued' NOT NULL,
	"stages_checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_type" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "integration_client_status" DEFAULT 'paired' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obsidian_sync_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid,
	"document_id" uuid,
	"memora_type" text NOT NULL,
	"relative_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"sync_version" integer DEFAULT 1 NOT NULL,
	"status" "obsidian_sync_status" DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "source_item_type" NOT NULL,
	"title" text NOT NULL,
	"source_uri" text,
	"external_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"label" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"obsidian_vault_path" text,
	"obsidian_managed_root" text DEFAULT 'Memora' NOT NULL,
	"obsidian_sync_enabled" boolean DEFAULT false NOT NULL,
	"obsidian_sync_paused" boolean DEFAULT false NOT NULL,
	"delete_policy" text DEFAULT 'tombstone' NOT NULL,
	"upload_copy_enabled" boolean DEFAULT false NOT NULL,
	"upload_copy_base_path" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_assets" ADD CONSTRAINT "document_assets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_assets" ADD CONSTRAINT "document_assets_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD CONSTRAINT "obsidian_sync_files_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD CONSTRAINT "obsidian_sync_files_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_spans" ADD CONSTRAINT "source_spans_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_spans" ADD CONSTRAINT "source_spans_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_source_item_id_idx" ON "chunks" USING btree ("source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_chunk_index_uidx" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_assets_document_id_idx" ON "document_assets" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_assets_source_item_id_idx" ON "document_assets" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "document_assets_sha256_idx" ON "document_assets" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "document_assets_storage_path_uidx" ON "document_assets" USING btree ("storage_base","relative_path");--> statement-breakpoint
CREATE INDEX "documents_source_item_id_idx" ON "documents" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "documents_content_hash_idx" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "ingestion_runs_source_item_id_idx" ON "ingestion_runs" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_job_id_idx" ON "ingestion_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_status_idx" ON "ingestion_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integration_clients_client_type_idx" ON "integration_clients" USING btree ("client_type");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_clients_token_hash_uidx" ON "integration_clients" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("status","priority","run_after");--> statement-breakpoint
CREATE INDEX "jobs_locked_idx" ON "jobs" USING btree ("locked_by","locked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "obsidian_sync_files_relative_path_uidx" ON "obsidian_sync_files" USING btree ("relative_path");--> statement-breakpoint
CREATE INDEX "obsidian_sync_files_source_item_id_idx" ON "obsidian_sync_files" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "obsidian_sync_files_document_id_idx" ON "obsidian_sync_files" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "obsidian_sync_files_status_idx" ON "obsidian_sync_files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_items_type_idx" ON "source_items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "source_items_source_uri_idx" ON "source_items" USING btree ("source_uri");--> statement-breakpoint
CREATE INDEX "source_items_external_id_idx" ON "source_items" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "source_spans_document_id_idx" ON "source_spans" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "source_spans_source_item_id_idx" ON "source_spans" USING btree ("source_item_id");