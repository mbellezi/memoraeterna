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

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "ai_model_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_config_id" uuid,
	"model_id" text NOT NULL,
	"capability" text NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_profile_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"privacy_mode" text DEFAULT 'allow_remote' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_profile_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider_config_id" uuid,
	"model_id" text NOT NULL,
	"runtime" text DEFAULT 'remote' NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fallback_policy" text DEFAULT 'block' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"credential_ref" text,
	"base_url" text,
	"status" text DEFAULT 'configured' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"task_type" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"runtime" text NOT NULL,
	"capabilities_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_hash" text,
	"output_hash" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_estimate" double precision,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bibliographic_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"type" text NOT NULL,
	"edition" text,
	"volume" text,
	"issue" text,
	"publication_date" text,
	"publisher" text,
	"isbn" text,
	"issn" text,
	"doi" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bibliographic_works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"canonical_title" text,
	"language" varchar(16) DEFAULT 'und' NOT NULL,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings_256" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"chunk_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"usage" text DEFAULT 'retrieval' NOT NULL,
	"strategy" text DEFAULT 'native' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(256) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings_768" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"chunk_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"usage" text DEFAULT 'retrieval' NOT NULL,
	"strategy" text DEFAULT 'native' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(768) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_item_bibliographic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"instance_id" uuid,
	"relation_type" text DEFAULT 'instance_of' NOT NULL,
	"pages" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "document_assets_storage_path_uidx";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "language" varchar(16) DEFAULT 'und' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "chunking_version" text DEFAULT 'markdown-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "subtitle" text;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "source_origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "language" varchar(16) DEFAULT 'und' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "summary_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_spans" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "source_spans" ADD COLUMN "source_block_id" text;--> statement-breakpoint
ALTER TABLE "source_spans" ADD COLUMN "bounding_box" jsonb;--> statement-breakpoint
ALTER TABLE "source_spans" ADD COLUMN "selector" text;--> statement-breakpoint
ALTER TABLE "ai_model_capabilities" ADD CONSTRAINT "ai_model_capabilities_provider_config_id_ai_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."ai_provider_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" ADD CONSTRAINT "ai_profile_tasks_profile_id_ai_profile_sets_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."ai_profile_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" ADD CONSTRAINT "ai_profile_tasks_provider_config_id_ai_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."ai_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_profile_id_ai_profile_sets_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."ai_profile_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bibliographic_instances" ADD CONSTRAINT "bibliographic_instances_work_id_bibliographic_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."bibliographic_works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings_256" ADD CONSTRAINT "embeddings_256_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings_768" ADD CONSTRAINT "embeddings_768_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_bibliographic_links" ADD CONSTRAINT "source_item_bibliographic_links_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_bibliographic_links" ADD CONSTRAINT "source_item_bibliographic_links_work_id_bibliographic_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."bibliographic_works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_bibliographic_links" ADD CONSTRAINT "source_item_bibliographic_links_instance_id_bibliographic_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."bibliographic_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_model_capabilities_model_capability_uidx" ON "ai_model_capabilities" USING btree ("provider_config_id","model_id","capability");--> statement-breakpoint
CREATE INDEX "ai_profile_sets_default_idx" ON "ai_profile_sets" USING btree ("is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_profile_tasks_profile_task_uidx" ON "ai_profile_tasks" USING btree ("profile_id","task");--> statement-breakpoint
CREATE INDEX "ai_provider_configs_provider_idx" ON "ai_provider_configs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "ai_task_runs_task_type_idx" ON "ai_task_runs" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX "bibliographic_instances_work_id_idx" ON "bibliographic_instances" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "bibliographic_instances_isbn_idx" ON "bibliographic_instances" USING btree ("isbn");--> statement-breakpoint
CREATE INDEX "bibliographic_instances_issn_idx" ON "bibliographic_instances" USING btree ("issn");--> statement-breakpoint
CREATE INDEX "bibliographic_instances_doi_idx" ON "bibliographic_instances" USING btree ("doi");--> statement-breakpoint
CREATE INDEX "bibliographic_works_title_idx" ON "bibliographic_works" USING btree ("title");--> statement-breakpoint
CREATE INDEX "bibliographic_works_canonical_title_idx" ON "bibliographic_works" USING btree ("canonical_title");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_256_target_model_uidx" ON "embeddings_256" USING btree ("target_type","target_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_256_chunk_id_idx" ON "embeddings_256" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "embeddings_256_embedding_hnsw_idx" ON "embeddings_256" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_768_target_model_uidx" ON "embeddings_768" USING btree ("target_type","target_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_768_chunk_id_idx" ON "embeddings_768" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "embeddings_768_embedding_hnsw_idx" ON "embeddings_768" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "source_item_bibliographic_links_source_work_uidx" ON "source_item_bibliographic_links" USING btree ("source_item_id","work_id");--> statement-breakpoint
CREATE INDEX "document_assets_storage_path_idx" ON "document_assets" USING btree ("storage_base","relative_path");--> statement-breakpoint
CREATE INDEX "source_items_content_hash_idx" ON "source_items" USING btree ("content_hash");
--> statement-breakpoint
CREATE INDEX "chunks_content_trgm_idx" ON "chunks" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "chunks_content_fts_idx" ON "chunks" USING gin (to_tsvector('simple', "content"));


ALTER TABLE "source_items" ADD COLUMN "parent_source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_parent_source_item_id_source_items_id_fk" FOREIGN KEY ("parent_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_items_parent_source_item_id_idx" ON "source_items" USING btree ("parent_source_item_id");