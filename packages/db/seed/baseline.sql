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

CREATE TYPE "public"."atomic_note_relation_status" AS ENUM('pending_review', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."atomic_note_status" AS ENUM('pending_review', 'approved', 'rejected', 'archived');--> statement-breakpoint
CREATE TABLE "atomic_note_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_atomic_note_id" uuid NOT NULL,
	"target_atomic_note_id" uuid NOT NULL,
	"relation_type" text DEFAULT 'related' NOT NULL,
	"vector_score" double precision,
	"graph_score" double precision,
	"rerank_score" double precision,
	"final_score" double precision NOT NULL,
	"explanation" text NOT NULL,
	"status" "atomic_note_relation_status" DEFAULT 'pending_review' NOT NULL,
	"matching_profile_id" uuid,
	"matching_model" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atomic_note_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atomic_note_id" uuid NOT NULL,
	"action" text NOT NULL,
	"previous_status" "atomic_note_status" NOT NULL,
	"next_status" "atomic_note_status" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atomic_note_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atomic_note_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_span_id" uuid,
	"claim_id" uuid,
	"relation_type" text DEFAULT 'derived_from' NOT NULL,
	"confidence" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atomic_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"idea_statement" text NOT NULL,
	"language" varchar(16) DEFAULT 'und' NOT NULL,
	"status" "atomic_note_status" DEFAULT 'pending_review' NOT NULL,
	"created_from_source_item_id" uuid NOT NULL,
	"source_span_id" uuid,
	"evidence_chunk_id" uuid NOT NULL,
	"generation_profile_id" uuid,
	"ai_task_run_id" uuid,
	"generation_provider" text NOT NULL,
	"generation_model" text NOT NULL,
	"generation_runtime" text NOT NULL,
	"generation_prompt_version" text NOT NULL,
	"generation_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"language" varchar(16) DEFAULT 'und' NOT NULL,
	"profile_id" uuid,
	"ai_task_run_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"output_hash" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_source_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("source_atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_target_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("target_atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_matching_profile_id_ai_profile_sets_id_fk" FOREIGN KEY ("matching_profile_id") REFERENCES "public"."ai_profile_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_review_events" ADD CONSTRAINT "atomic_note_review_events_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_source_links" ADD CONSTRAINT "atomic_note_source_links_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_source_links" ADD CONSTRAINT "atomic_note_source_links_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_source_links" ADD CONSTRAINT "atomic_note_source_links_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_source_links" ADD CONSTRAINT "atomic_note_source_links_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_created_from_source_item_id_source_items_id_fk" FOREIGN KEY ("created_from_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_evidence_chunk_id_chunks_id_fk" FOREIGN KEY ("evidence_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_generation_profile_id_ai_profile_sets_id_fk" FOREIGN KEY ("generation_profile_id") REFERENCES "public"."ai_profile_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_summaries" ADD CONSTRAINT "source_summaries_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_summaries" ADD CONSTRAINT "source_summaries_profile_id_ai_profile_sets_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."ai_profile_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_summaries" ADD CONSTRAINT "source_summaries_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atomic_note_relations_source_id_idx" ON "atomic_note_relations" USING btree ("source_atomic_note_id");--> statement-breakpoint
CREATE INDEX "atomic_note_relations_target_id_idx" ON "atomic_note_relations" USING btree ("target_atomic_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "atomic_note_relations_source_target_uidx" ON "atomic_note_relations" USING btree ("source_atomic_note_id","target_atomic_note_id");--> statement-breakpoint
CREATE INDEX "atomic_note_review_events_note_id_idx" ON "atomic_note_review_events" USING btree ("atomic_note_id");--> statement-breakpoint
CREATE INDEX "atomic_note_source_links_note_id_idx" ON "atomic_note_source_links" USING btree ("atomic_note_id");--> statement-breakpoint
CREATE INDEX "atomic_note_source_links_source_id_idx" ON "atomic_note_source_links" USING btree ("source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "atomic_note_source_links_note_chunk_uidx" ON "atomic_note_source_links" USING btree ("atomic_note_id","chunk_id");--> statement-breakpoint
CREATE INDEX "atomic_notes_source_item_id_idx" ON "atomic_notes" USING btree ("created_from_source_item_id");--> statement-breakpoint
CREATE INDEX "atomic_notes_status_idx" ON "atomic_notes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "atomic_notes_source_generation_key_uidx" ON "atomic_notes" USING btree ("created_from_source_item_id","generation_key");--> statement-breakpoint
CREATE INDEX "source_summaries_source_item_id_idx" ON "source_summaries" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "source_summaries_generated_at_idx" ON "source_summaries" USING btree ("generated_at");

ALTER TABLE "integration_clients" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_clients" ADD COLUMN "contract_version" text DEFAULT '1.0.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "memora_id" uuid;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ADD COLUMN "frontmatter_hash" text;--> statement-breakpoint
UPDATE "obsidian_sync_files"
SET "memora_id" = coalesce("source_item_id", "document_id", "id"),
    "entity_type" = CASE WHEN "memora_type" = 'atomic_note' THEN 'atomic_note' ELSE 'source_item' END,
    "entity_id" = coalesce("source_item_id", "document_id", "id"),
    "frontmatter_hash" = "content_hash";--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "memora_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "entity_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "entity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obsidian_sync_files" ALTER COLUMN "frontmatter_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "obsidian_sync_files_memora_id_uidx" ON "obsidian_sync_files" USING btree ("memora_id");


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

CREATE TABLE "ai_task_profile_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "output_language" varchar(16) DEFAULT 'ui' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD COLUMN "default_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "local_models" ADD COLUMN "default_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_task_profile_routes" ADD CONSTRAINT "ai_task_profile_routes_profile_id_ai_profile_sets_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."ai_profile_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_task_profile_routes_task_uidx" ON "ai_task_profile_routes" USING btree ("task");--> statement-breakpoint
CREATE INDEX "ai_task_profile_routes_profile_id_idx" ON "ai_task_profile_routes" USING btree ("profile_id");


ALTER TABLE "ai_profile_tasks" DROP CONSTRAINT "ai_profile_tasks_provider_config_id_ai_provider_configs_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP CONSTRAINT "ai_profile_tasks_local_model_id_local_models_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "provider_config_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "local_model_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "runtime" text;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
WITH selected_models AS (
	SELECT DISTINCT ON (task.profile_id)
		task.profile_id,
		task.provider_config_id,
		task.local_model_id,
		task.model_id,
		task.runtime,
		COALESCE(local_model.capabilities, provider.metadata->'capabilities', task.required_capabilities, '[]'::jsonb) AS capabilities
	FROM ai_profile_tasks AS task
	LEFT JOIN ai_provider_configs AS provider ON provider.id = task.provider_config_id
	LEFT JOIN local_models AS local_model ON local_model.id = task.local_model_id
	WHERE task.status = 'active'
	ORDER BY task.profile_id, task.updated_at DESC, task.created_at DESC
)
UPDATE ai_profile_sets AS profile
SET provider_config_id = selected.provider_config_id,
	local_model_id = selected.local_model_id,
	model_id = selected.model_id,
	runtime = selected.runtime,
	capabilities = selected.capabilities
FROM selected_models AS selected
WHERE selected.profile_id = profile.id;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD CONSTRAINT "ai_profile_sets_provider_config_id_ai_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."ai_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile_sets" ADD CONSTRAINT "ai_profile_sets_local_model_id_local_models_id_fk" FOREIGN KEY ("local_model_id") REFERENCES "public"."local_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "provider_config_id";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "local_model_id";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "model_id";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "runtime";--> statement-breakpoint
ALTER TABLE "ai_profile_tasks" DROP COLUMN "required_capabilities";


CREATE TABLE "embeddings_1024" (
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
	"embedding" vector(1024) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings_1024" ADD CONSTRAINT "embeddings_1024_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_1024_target_model_uidx" ON "embeddings_1024" USING btree ("target_type","target_id","model");--> statement-breakpoint
CREATE INDEX "embeddings_1024_chunk_id_idx" ON "embeddings_1024" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "embeddings_1024_embedding_hnsw_idx" ON "embeddings_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
TRUNCATE TABLE "embeddings_256", "embeddings_768";--> statement-breakpoint
UPDATE "ai_profile_sets"
SET "local_model_id" = NULL, "model_id" = NULL, "runtime" = NULL, "capabilities" = '[]'::jsonb, "updated_at" = now()
WHERE "local_model_id" IN (
	SELECT "id" FROM "local_models"
	WHERE "catalog_id" IN ('gguf-embeddinggemma-300m-q8-0', 'gguf-multilingual-e5-base-q5-k-s')
);--> statement-breakpoint
DELETE FROM "local_models"
WHERE "catalog_id" IN ('gguf-embeddinggemma-300m-q8-0', 'gguf-multilingual-e5-base-q5-k-s');


CREATE TABLE "similarity_debug_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_label" text,
	"final_rank" integer NOT NULL,
	"text_rank" integer,
	"vector_rank" integer,
	"text_score" double precision,
	"vector_score" double precision,
	"metadata_score" double precision,
	"rerank_score" double precision,
	"fusion_score" double precision,
	"final_score" double precision NOT NULL,
	"passed_threshold" boolean,
	"explanation" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "similarity_debug_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"query_text" text NOT NULL,
	"query_target_id" uuid,
	"mode" text NOT NULL,
	"model" text,
	"dimensions" integer,
	"requested_limit" integer NOT NULL,
	"strategy" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "similarity_debug_results" ADD CONSTRAINT "similarity_debug_results_run_id_similarity_debug_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."similarity_debug_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "similarity_debug_results_run_rank_idx" ON "similarity_debug_results" USING btree ("run_id","final_rank");--> statement-breakpoint
CREATE INDEX "similarity_debug_runs_kind_created_at_idx" ON "similarity_debug_runs" USING btree ("kind","created_at");

CREATE TABLE "atomic_note_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"atomic_note_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"relation_type" text DEFAULT 'about' NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"evidence_chunk_id" uuid NOT NULL,
	"source_span_id" uuid,
	"text" text NOT NULL,
	"content_hash" text NOT NULL,
	"confidence" double precision NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"language" varchar(16) DEFAULT 'und' NOT NULL,
	"confidence" double precision NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_span_id" uuid,
	"surface_text" text NOT NULL,
	"confidence" double precision NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"object_entity_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"evidence_chunk_id" uuid NOT NULL,
	"source_span_id" uuid,
	"confidence" double precision NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "similarity_debug_results" ADD COLUMN "graph_rank" integer;--> statement-breakpoint
ALTER TABLE "similarity_debug_results" ADD COLUMN "graph_score" double precision;--> statement-breakpoint
ALTER TABLE "atomic_note_entity_links" ADD CONSTRAINT "atomic_note_entity_links_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_entity_links" ADD CONSTRAINT "atomic_note_entity_links_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_entity_links" ADD CONSTRAINT "claim_entity_links_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_entity_links" ADD CONSTRAINT "claim_entity_links_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_evidence_chunk_id_chunks_id_fk" FOREIGN KEY ("evidence_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_subject_entity_id_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_object_entity_id_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_evidence_chunk_id_chunks_id_fk" FOREIGN KEY ("evidence_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "atomic_note_entity_links_note_entity_uidx" ON "atomic_note_entity_links" USING btree ("atomic_note_id","entity_id");--> statement-breakpoint
CREATE INDEX "atomic_note_entity_links_entity_id_idx" ON "atomic_note_entity_links" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_entity_links_claim_entity_uidx" ON "claim_entity_links" USING btree ("claim_id","entity_id");--> statement-breakpoint
CREATE INDEX "claim_entity_links_entity_id_idx" ON "claim_entity_links" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "claims_source_item_id_idx" ON "claims" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "claims_evidence_chunk_id_idx" ON "claims" USING btree ("evidence_chunk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_source_content_hash_uidx" ON "claims" USING btree ("source_item_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_type_normalized_name_uidx" ON "entities" USING btree ("type","normalized_name");--> statement-breakpoint
CREATE INDEX "entities_canonical_name_idx" ON "entities" USING btree ("canonical_name");--> statement-breakpoint
CREATE INDEX "entity_mentions_source_item_id_idx" ON "entity_mentions" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "entity_mentions_chunk_id_idx" ON "entity_mentions" USING btree ("chunk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_mentions_entity_chunk_uidx" ON "entity_mentions" USING btree ("entity_id","chunk_id");--> statement-breakpoint
CREATE INDEX "entity_relations_source_item_id_idx" ON "entity_relations" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "entity_relations_subject_entity_id_idx" ON "entity_relations" USING btree ("subject_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relations_object_entity_id_idx" ON "entity_relations" USING btree ("object_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relations_evidence_uidx" ON "entity_relations" USING btree ("source_item_id","subject_entity_id","predicate","object_entity_id","evidence_chunk_id");--> statement-breakpoint
ALTER TABLE "atomic_note_source_links" ADD CONSTRAINT "atomic_note_source_links_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;

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


DROP INDEX "atomic_notes_source_generation_key_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "source_summaries_current_source_uidx" ON "source_summaries" USING btree ("source_item_id") WHERE "source_summaries"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "atomic_notes_source_generation_key_uidx" ON "atomic_notes" USING btree ("created_from_source_item_id","generation_id","generation_key");


ALTER TABLE "document_divisions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "document_divisions" ADD COLUMN "stable_id" uuid NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_divisions_structure_stable_uidx" ON "document_divisions" USING btree ("structure_id","stable_id");


DROP INDEX "document_divisions_child_source_uidx";--> statement-breakpoint
CREATE INDEX "document_divisions_child_source_idx" ON "document_divisions" USING btree ("child_source_item_id");


CREATE UNIQUE INDEX "knowledge_generations_run_stage_uidx" ON "knowledge_generations" USING btree ("ingestion_run_id","stage") WHERE "knowledge_generations"."ingestion_run_id" is not null;


CREATE TABLE "ai_task_run_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ai_task_run_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_task_run_sources" ADD CONSTRAINT "ai_task_run_sources_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_run_sources" ADD CONSTRAINT "ai_task_run_sources_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_task_run_sources_run_source_uidx" ON "ai_task_run_sources" USING btree ("ai_task_run_id","source_item_id");--> statement-breakpoint
CREATE INDEX "ai_task_run_sources_source_item_id_idx" ON "ai_task_run_sources" USING btree ("source_item_id");--> statement-breakpoint
INSERT INTO "ai_task_run_sources" ("ai_task_run_id", "source_item_id")
SELECT DISTINCT link.ai_task_run_id, link.source_item_id
FROM (
	SELECT ai_task_run_id, source_item_id
	FROM source_summaries
	WHERE ai_task_run_id IS NOT NULL
	UNION ALL
	SELECT ai_task_run_id, created_from_source_item_id
	FROM atomic_notes
	WHERE ai_task_run_id IS NOT NULL
	UNION ALL
	SELECT ai_task_run_id, source_item_id
	FROM knowledge_generations
	WHERE ai_task_run_id IS NOT NULL
) link
ON CONFLICT ("ai_task_run_id", "source_item_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "ai_task_run_sources" ("ai_task_run_id", "source_item_id")
SELECT DISTINCT run.id, artifact.source_item_id
FROM (
	SELECT source_item_id, jsonb_array_elements_text(
		CASE WHEN jsonb_typeof(metadata -> 'aiTaskRunIds') = 'array'
			THEN metadata -> 'aiTaskRunIds' ELSE '[]'::jsonb END
	) AS run_id
	FROM source_summaries
	UNION ALL
	SELECT source_item_id, jsonb_array_elements_text(
		CASE WHEN jsonb_typeof(metadata -> 'aiTaskRunIds') = 'array'
			THEN metadata -> 'aiTaskRunIds' ELSE '[]'::jsonb END
	) AS run_id
	FROM knowledge_generations
) artifact
JOIN ai_task_runs run ON run.id::text = artifact.run_id
ON CONFLICT ("ai_task_run_id", "source_item_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "ai_task_run_sources" ("ai_task_run_id", "source_item_id")
SELECT DISTINCT run.id, chunk.source_item_id
FROM ai_task_runs run
JOIN chunks chunk ON chunk.content_hash = run.input_hash
WHERE run.task_type = 'embedding'
ON CONFLICT ("ai_task_run_id", "source_item_id") DO NOTHING;


ALTER TABLE "bibliographic_instances" ADD COLUMN "creators" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bibliographic_instances" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "bibliographic_instances" ADD COLUMN "series" text;--> statement-breakpoint
ALTER TABLE "bibliographic_works" ADD COLUMN "creators" jsonb DEFAULT '[]'::jsonb NOT NULL;

CREATE TABLE "relation_type_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"relation_type_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_type_embeddings_1024" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_type_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_type_embeddings_256" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_type_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_type_embeddings_768" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_type_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"predicate" text NOT NULL,
	"definition" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_relations" ADD COLUMN "relation_type_id" uuid;--> statement-breakpoint
ALTER TABLE "relation_type_aliases" ADD CONSTRAINT "relation_type_aliases_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_type_embeddings_1024" ADD CONSTRAINT "relation_type_embeddings_1024_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_type_embeddings_256" ADD CONSTRAINT "relation_type_embeddings_256_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_type_embeddings_768" ADD CONSTRAINT "relation_type_embeddings_768_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_type_embeddings_1024_type_space_uidx" ON "relation_type_embeddings_1024" USING btree ("relation_type_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_type_embeddings_256_type_space_uidx" ON "relation_type_embeddings_256" USING btree ("relation_type_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_type_embeddings_768_type_space_uidx" ON "relation_type_embeddings_768" USING btree ("relation_type_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relation_types_predicate_uidx" ON "relation_types" USING btree ("predicate");--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE restrict ON UPDATE no action;

CREATE TABLE "entity_identity_embeddings_1024" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_identity_embeddings_256" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_identity_embeddings_768" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"space_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "entities_type_normalized_name_uidx";--> statement-breakpoint
ALTER TABLE "entity_identity_embeddings_1024" ADD CONSTRAINT "entity_identity_embeddings_1024_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_embeddings_256" ADD CONSTRAINT "entity_identity_embeddings_256_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_embeddings_768" ADD CONSTRAINT "entity_identity_embeddings_768_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identity_embeddings_1024_entity_space_uidx" ON "entity_identity_embeddings_1024" USING btree ("entity_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identity_embeddings_256_entity_space_uidx" ON "entity_identity_embeddings_256" USING btree ("entity_id","space_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identity_embeddings_768_entity_space_uidx" ON "entity_identity_embeddings_768" USING btree ("entity_id","space_key");--> statement-breakpoint
CREATE INDEX "entities_type_normalized_name_idx" ON "entities" USING btree ("type","normalized_name");

CREATE TABLE "entity_identity_keys" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_identity_keys" ADD CONSTRAINT "entity_identity_keys_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identity_keys" ADD CONSTRAINT "entity_identity_keys_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;

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


CREATE TABLE "source_matching_decisions" (
	"key" text PRIMARY KEY NOT NULL,
	"source_root_id" uuid NOT NULL,
	"target_root_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_matching_runs" (
	"key" text PRIMARY KEY NOT NULL,
	"source_root_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_relation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"origin" text NOT NULL,
	"source_chunk_id" uuid,
	"target_chunk_id" uuid,
	"note_relation_id" uuid,
	"source_note_id" uuid,
	"target_note_id" uuid,
	"snapshot" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_relation_evidence_origin" CHECK ("source_relation_evidence"."origin" in ('atomic_notes', 'source_analysis'))
);
--> statement-breakpoint
CREATE TABLE "source_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"target_source_item_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"relation_type" text NOT NULL,
	"source_idea" text NOT NULL,
	"target_idea" text NOT NULL,
	"explanation" text NOT NULL,
	"importance" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"status" "atomic_note_relation_status" DEFAULT 'pending_review' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_relations_distinct_endpoints" CHECK ("source_relations"."source_item_id" <> "source_relations"."target_source_item_id"),
	CONSTRAINT "source_relations_scores" CHECK ("source_relations"."importance" between 0 and 1 and "source_relations"."confidence" between 0 and 1),
	CONSTRAINT "source_relations_type" CHECK ("source_relations"."relation_type" in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related'))
);
--> statement-breakpoint
ALTER TABLE "source_matching_decisions" ADD CONSTRAINT "source_matching_decisions_source_root_id_source_items_id_fk" FOREIGN KEY ("source_root_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_matching_decisions" ADD CONSTRAINT "source_matching_decisions_target_root_id_source_items_id_fk" FOREIGN KEY ("target_root_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_matching_runs" ADD CONSTRAINT "source_matching_runs_source_root_id_source_items_id_fk" FOREIGN KEY ("source_root_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_evidence" ADD CONSTRAINT "source_relation_evidence_relation_id_source_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."source_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_evidence" ADD CONSTRAINT "source_relation_evidence_source_chunk_id_chunks_id_fk" FOREIGN KEY ("source_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_evidence" ADD CONSTRAINT "source_relation_evidence_target_chunk_id_chunks_id_fk" FOREIGN KEY ("target_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_evidence" ADD CONSTRAINT "source_relation_evidence_note_relation_id_atomic_note_relations_id_fk" FOREIGN KEY ("note_relation_id") REFERENCES "public"."atomic_note_relations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_evidence" ADD CONSTRAINT "source_relation_evidence_source_note_id_atomic_notes_id_fk" FOREIGN KEY ("source_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_evidence" ADD CONSTRAINT "source_relation_evidence_target_note_id_atomic_notes_id_fk" FOREIGN KEY ("target_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_target_source_item_id_source_items_id_fk" FOREIGN KEY ("target_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_relation_evidence_uidx" ON "source_relation_evidence" USING btree ("relation_id","evidence_key");--> statement-breakpoint
CREATE INDEX "source_relation_evidence_relation_idx" ON "source_relation_evidence" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "source_relation_evidence_note_idx" ON "source_relation_evidence" USING btree ("note_relation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_relations_identity_uidx" ON "source_relations" USING btree ("identity_key");--> statement-breakpoint
CREATE INDEX "source_relations_source_idx" ON "source_relations" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "source_relations_target_idx" ON "source_relations" USING btree ("target_source_item_id");

CREATE TABLE "wiki_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_span_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"number" integer NOT NULL,
	"origin" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"current_revision_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_pages_not_self_parent" CHECK ("wiki_pages"."parent_id" is distinct from "wiki_pages"."id")
);
--> statement-breakpoint
ALTER TABLE "wiki_evidence" ADD CONSTRAINT "wiki_evidence_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_parent_id_wiki_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_evidence_page_chunk_idx" ON "wiki_evidence" USING btree ("page_id","chunk_id");--> statement-breakpoint
CREATE INDEX "wiki_evidence_source_idx" ON "wiki_evidence" USING btree ("source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_page_revisions_number_idx" ON "wiki_page_revisions" USING btree ("page_id","number");--> statement-breakpoint
CREATE INDEX "wiki_pages_parent_position_idx" ON "wiki_pages" USING btree ("parent_id","position");

CREATE TABLE "organization_proposals" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"proposal" jsonb NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_receipts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_runs_status_check" CHECK ("organization_runs"."status" in ('queued','analyzing','awaiting_review','applied','sample_passed','rejected','canceled','failed'))
);
--> statement-breakpoint
CREATE TABLE "organization_settings_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"configuration" jsonb NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"ai_task_run_id" uuid,
	"artifact" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_proposals" ADD CONSTRAINT "organization_proposals_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "organization_receipts_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "organization_receipts_revision_id_wiki_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_runs" ADD CONSTRAINT "organization_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings_activations" ADD CONSTRAINT "organization_settings_activations_revision_id_organization_settings_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."organization_settings_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_steps" ADD CONSTRAINT "organization_steps_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_steps" ADD CONSTRAINT "organization_steps_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_runs_job_idx" ON "organization_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "organization_runs_status_idx" ON "organization_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_steps_sequence_idx" ON "organization_steps" USING btree ("run_id","sequence");

CREATE TABLE "knowledge_impact_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"input_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"input_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"stale_reason" text,
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wiki_dependencies" ADD CONSTRAINT "wiki_dependencies_revision_id_wiki_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_impact_events_pending_idx" ON "knowledge_impact_events" USING btree ("consumed_at","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_impact_events_input_idx" ON "knowledge_impact_events" USING btree ("kind","input_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_dependencies_consumer_idx" ON "wiki_dependencies" USING btree ("revision_id","section_id","kind","input_id");--> statement-breakpoint
CREATE INDEX "wiki_dependencies_input_idx" ON "wiki_dependencies" USING btree ("kind","input_id");--> statement-breakpoint
CREATE INDEX "wiki_dependencies_revision_idx" ON "wiki_dependencies" USING btree ("revision_id");--> statement-breakpoint
-- Transactional invalidation observes all canonical writers, including cascades.
CREATE FUNCTION wiki_record_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object_id uuid; data jsonb; before_data jsonb; input_kind text := TG_ARGV[0];
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  before_data := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  -- Administrative timestamps alone are not an evidence change.
  data := data - 'updated_at' - 'created_at';
  before_data := before_data - 'updated_at' - 'created_at';
  IF input_kind='source' THEN
    data := jsonb_build_object('id',data->'id','title',data->'title','subtitle',data->'subtitle','type',data->'type','source_uri',data->'source_uri','parent_source_item_id',data->'parent_source_item_id','descriptor',data->'metadata'->'descriptor');
    before_data := jsonb_build_object('id',before_data->'id','title',before_data->'title','subtitle',before_data->'subtitle','type',before_data->'type','source_uri',before_data->'source_uri','parent_source_item_id',before_data->'parent_source_item_id','descriptor',before_data->'metadata'->'descriptor');
  END IF;
  IF TG_OP='UPDATE' AND data=before_data THEN RETURN NEW; END IF;
  object_id := (data->>coalesce(TG_ARGV[1],'id'))::uuid;
  INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint)
    VALUES(input_kind,object_id,lower(TG_OP),md5(data::text));
  UPDATE wiki_dependencies SET stale_reason=input_kind||'_'||lower(TG_OP),changed_at=clock_timestamp()
    WHERE kind=input_kind AND input_id=object_id AND stale_reason IS NULL;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_source_impact AFTER UPDATE OR DELETE ON source_items FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('source');
--> statement-breakpoint
CREATE TRIGGER wiki_document_impact AFTER UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('document');
--> statement-breakpoint
CREATE TRIGGER wiki_chunk_impact AFTER UPDATE OR DELETE ON chunks FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('chunk');
--> statement-breakpoint
CREATE TRIGGER wiki_note_impact AFTER UPDATE OR DELETE ON atomic_notes FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('atomic_note');
--> statement-breakpoint
CREATE TRIGGER wiki_note_links_impact AFTER INSERT OR UPDATE OR DELETE ON atomic_note_source_links FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('atomic_note','atomic_note_id');
--> statement-breakpoint
CREATE TRIGGER wiki_note_relation_impact AFTER UPDATE OR DELETE ON atomic_note_relations FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('note_relation');
--> statement-breakpoint
CREATE TRIGGER wiki_relation_impact AFTER INSERT OR UPDATE OR DELETE ON source_relations FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('source_relation');
--> statement-breakpoint
CREATE TRIGGER wiki_relation_evidence_impact AFTER INSERT OR UPDATE OR DELETE ON source_relation_evidence FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('relation_evidence');
--> statement-breakpoint
CREATE TRIGGER wiki_summary_impact AFTER UPDATE OR DELETE ON source_summaries FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('summary');
--> statement-breakpoint
CREATE TRIGGER wiki_entity_impact AFTER UPDATE OR DELETE ON entities FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity');
--> statement-breakpoint
CREATE TRIGGER wiki_mention_impact AFTER UPDATE OR DELETE ON entity_mentions FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity_mention');
--> statement-breakpoint
-- Backfill direct section dependencies for immutable M1/M2 history.
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT r.id,(sec->>'id')::uuid,v.kind,v.input_id,e.snapshot->>'contentHash',e.snapshot
FROM wiki_page_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.content->'sections') sec
JOIN wiki_evidence e ON e.page_id=r.page_id AND sec->'evidenceIds' ? e.id::text
CROSS JOIN LATERAL (VALUES ('source',e.source_item_id),('document',e.document_id),('chunk',e.chunk_id)) v(kind,input_id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- M2 preloaded interpretations were all mandatory reads; retain their precise occurrence.
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT receipt.revision_id,(sec->>'id')::uuid,v.kind,v.input_id,rel->>'fingerprint',rel
FROM organization_receipts receipt JOIN organization_runs run ON run.id=receipt.run_id
JOIN wiki_page_revisions rev ON rev.id=receipt.revision_id
CROSS JOIN LATERAL jsonb_array_elements(rev.content->'sections') sec
CROSS JOIN LATERAL jsonb_array_elements(run.snapshot->'relations') rel
CROSS JOIN LATERAL (VALUES ('source_relation',(rel->>'id')::uuid),('relation_evidence',(rel->>'evidenceId')::uuid)) v(kind,input_id)
WHERE EXISTS (SELECT 1 FROM organization_proposals p CROSS JOIN LATERAL jsonb_array_elements(p.proposal->'sections') op WHERE p.run_id=run.id AND op->>'markdown' IS NOT NULL AND (op->>'sectionId'=sec->>'id' OR (op->>'sectionId' IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.snapshot->'baseContent'->'sections') base WHERE base->>'id'=sec->>'id'))))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION wiki_record_section_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_section jsonb; new_section jsonb; old_content jsonb; new_content jsonb;
BEGIN
  IF OLD.current_revision_id IS NOT DISTINCT FROM NEW.current_revision_id THEN RETURN NEW; END IF;
  SELECT content INTO old_content FROM wiki_page_revisions WHERE id=OLD.current_revision_id;
  SELECT content INTO new_content FROM wiki_page_revisions WHERE id=NEW.current_revision_id;
  FOR old_section IN SELECT value FROM jsonb_array_elements(coalesce(old_content->'sections','[]'::jsonb)) LOOP
    SELECT value INTO new_section FROM jsonb_array_elements(coalesce(new_content->'sections','[]'::jsonb)) WHERE value->>'id'=old_section->>'id';
    IF old_section IS DISTINCT FROM new_section THEN
      INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint) VALUES('wiki_section',(old_section->>'id')::uuid,'update',md5(coalesce(new_section::text,'deleted')));
      UPDATE wiki_dependencies SET stale_reason='wiki_section_update',changed_at=clock_timestamp() WHERE kind='wiki_section' AND input_id=(old_section->>'id')::uuid AND stale_reason IS NULL;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_section_impact AFTER UPDATE ON wiki_pages FOR EACH ROW EXECUTE FUNCTION wiki_record_section_impact();
--> statement-breakpoint
-- Include indirect M2 note-derived occurrence inputs, even when the row itself never changes.
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT dep.revision_id,dep.section_id,v.kind,v.input_id,dep.fingerprint,dep.snapshot
FROM wiki_dependencies dep JOIN source_relation_evidence e ON e.id=dep.input_id AND dep.kind='relation_evidence'
CROSS JOIN LATERAL (VALUES ('atomic_note',e.source_note_id),('atomic_note',e.target_note_id),('note_relation',e.note_relation_id),('chunk',e.source_chunk_id),('chunk',e.target_chunk_id)) v(kind,input_id)
WHERE v.input_id IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT dep.revision_id,dep.section_id,'document',c.document_id,dep.fingerprint,dep.snapshot FROM wiki_dependencies dep JOIN chunks c ON c.id=dep.input_id AND dep.kind='chunk' ON CONFLICT DO NOTHING;


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

ALTER TABLE "maintenance_schedules" ADD COLUMN "last_error" text;

CREATE TABLE "obsidian_projection_clock" (
	"id" integer PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obsidian_projection_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memora_id" uuid NOT NULL,
	"revision_id" text NOT NULL,
	"binding_hash" text NOT NULL,
	"relative_path" text NOT NULL,
	"content" text NOT NULL,
	"editable_hash" text NOT NULL,
	"generated_hash" text NOT NULL,
	"rendered_hash" text NOT NULL,
	"base_hash" text,
	"before_content" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "obsidian_projection_target_idx" ON "obsidian_projection_revisions" USING btree ("memora_id","created_at");--> statement-breakpoint
CREATE INDEX "obsidian_projection_pending_idx" ON "obsidian_projection_revisions" USING btree ("status");--> statement-breakpoint
INSERT INTO obsidian_projection_clock(id,generation) VALUES(1,1);
--> statement-breakpoint
CREATE FUNCTION invalidate_obsidian_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE obsidian_projection_clock SET generation=generation+1 WHERE id=1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['wiki_pages','wiki_dependencies','source_items','documents','chunks','atomic_notes','atomic_note_relations','atomic_note_source_links','source_relations','source_relation_evidence','source_spans','document_revisions','bibliographic_works','bibliographic_instances','source_item_bibliographic_links'] LOOP
    EXECUTE format('CREATE TRIGGER obsidian_projection_dirty AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION invalidate_obsidian_projection()', target);
  END LOOP;
END $$;


CREATE TABLE "atomic_note_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"previous" jsonb NOT NULL,
	"current" jsonb NOT NULL,
	"origin" text DEFAULT 'human' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obsidian_editorial_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"binding_hash" text NOT NULL,
	"target_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "atomic_note_revisions" ADD CONSTRAINT "atomic_note_revisions_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atomic_note_revisions_note_idx" ON "atomic_note_revisions" USING btree ("note_id","created_at");--> statement-breakpoint
CREATE INDEX "obsidian_editorial_target_idx" ON "obsidian_editorial_operations" USING btree ("target_id","created_at");
--> statement-breakpoint
-- Existing edit audit proves human ownership; old text that was never stored is not reconstructed.
UPDATE atomic_notes SET metadata = metadata || '{"humanProtected":true}'::jsonb
WHERE EXISTS (SELECT 1 FROM atomic_note_review_events e WHERE e.atomic_note_id=atomic_notes.id AND e.action='edit');


CREATE TABLE "prompt_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" text NOT NULL,
	"scope" text NOT NULL,
	"domain_id" uuid,
	"fields" jsonb NOT NULL,
	"origin" text NOT NULL,
	"legacy" jsonb,
	"legacy_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_revisions_scope_check" CHECK ("prompt_revisions"."scope" in ('global','function','domain','domain_function') and (("prompt_revisions"."scope" in ('domain','domain_function')) = ("prompt_revisions"."domain_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "prompt_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"composition_hash" text NOT NULL,
	"sample_passed" boolean DEFAULT false NOT NULL,
	"audit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "prompt_compositions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_activations" ADD CONSTRAINT "prompt_activations_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_validations" ADD CONSTRAINT "prompt_validations_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_activations_revision_idx" ON "prompt_activations" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "prompt_revisions_leaf_idx" ON "prompt_revisions" USING btree ("prompt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_revisions_legacy_idx" ON "prompt_revisions" USING btree ("legacy_key");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_validations_composition_idx" ON "prompt_validations" USING btree ("revision_id","composition_hash");
--> statement-breakpoint
-- Pin source-free catalog templates transactionally when a job is admitted.
-- Existing jobs intentionally retain their legacy shipped-template reader.
CREATE FUNCTION pin_job_prompt_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inherited jsonb;
BEGIN
 IF NOT (NEW.payload ? 'promptPin') THEN
   IF NEW.payload ? 'ingestionRunId' THEN
     SELECT j.payload->'promptPin' INTO inherited FROM ingestion_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id::text=NEW.payload->>'ingestionRunId';
   END IF;
   inherited := coalesce(inherited,(SELECT value->'default' FROM settings WHERE key='prompts.active'));
   IF inherited IS NOT NULL THEN NEW.payload := NEW.payload || jsonb_build_object('promptPin',inherited); END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_pin_prompt_catalog BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION pin_job_prompt_catalog();


CREATE TABLE "wiki_group_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"targets" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_policy_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_policy_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_section_assessments" (
	"section_revision_id" uuid PRIMARY KEY NOT NULL,
	"section_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"assessment" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_toc_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "management" text DEFAULT 'human_managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "toc_owner_kind" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "toc_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_group_receipts" ADD CONSTRAINT "wiki_group_receipts_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_memberships" ADD CONSTRAINT "wiki_memberships_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_memberships" ADD CONSTRAINT "wiki_memberships_group_id_wiki_toc_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wiki_toc_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_policy_activations" ADD CONSTRAINT "wiki_policy_activations_revision_id_wiki_policy_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_assessments" ADD CONSTRAINT "wiki_section_assessments_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_toc_groups" ADD CONSTRAINT "wiki_toc_groups_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_toc_groups" ADD CONSTRAINT "wiki_toc_groups_revision_id_wiki_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_group_receipt_run_idx" ON "wiki_group_receipts" USING btree ("run_id","group_id");--> statement-breakpoint
CREATE INDEX "wiki_membership_order_idx" ON "wiki_memberships" USING btree ("group_id","position","id");--> statement-breakpoint
CREATE INDEX "wiki_membership_target_idx" ON "wiki_memberships" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "wiki_policy_activation_lookup_idx" ON "wiki_policy_activations" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE INDEX "wiki_toc_page_idx" ON "wiki_toc_groups" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_toc_owner_idx" ON "wiki_pages" USING btree ("role","toc_owner_kind","toc_owner_id");--> statement-breakpoint
-- Conservative classification does not rewrite immutable historical snapshots or activate work.
UPDATE wiki_pages p SET management='ai_managed'
FROM wiki_page_revisions r WHERE r.id=p.current_revision_id AND r.origin='organization'
AND r.content->>'review'='draft' AND NOT EXISTS (
 SELECT 1 FROM jsonb_array_elements(r.content->'sections') s WHERE coalesce((s->>'protected')::boolean,true)
);


CREATE TABLE "knowledge_impact_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"input_generation" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_until" timestamp with time zone,
	"defer_until" timestamp with time zone,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_impact_delivery_state_check" CHECK ("knowledge_impact_deliveries"."status" in ('pending','leased','deferred','acknowledged')),
	CONSTRAINT "knowledge_impact_delivery_receipt_check" CHECK ("knowledge_impact_deliveries"."status"<>'acknowledged' or "knowledge_impact_deliveries"."receipt" is not null)
);
--> statement-breakpoint
CREATE TABLE "wiki_source_coverage" (
	"policy_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_source_coverage_policy_id_source_id_pk" PRIMARY KEY("policy_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_impact_events" ADD COLUMN "source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_impact_events" ADD COLUMN "causal_run_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_impact_events" ADD COLUMN "causal_group_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_impact_deliveries" ADD CONSTRAINT "knowledge_impact_deliveries_event_id_knowledge_impact_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."knowledge_impact_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_source_coverage" ADD CONSTRAINT "wiki_source_coverage_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_impact_delivery_generation_idx" ON "knowledge_impact_deliveries" USING btree ("event_id","consumer","input_generation");--> statement-breakpoint
CREATE INDEX "knowledge_impact_delivery_pending_idx" ON "knowledge_impact_deliveries" USING btree ("consumer","status","defer_until");--> statement-breakpoint
CREATE INDEX "wiki_source_coverage_state_idx" ON "wiki_source_coverage" USING btree ("policy_id","status");

DROP INDEX "knowledge_impact_delivery_generation_idx";--> statement-breakpoint
ALTER TABLE "knowledge_impact_deliveries" ADD COLUMN "consumer_key" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_impact_delivery_generation_idx" ON "knowledge_impact_deliveries" USING btree ("event_id","consumer","consumer_key","input_generation");--> statement-breakpoint
CREATE FUNCTION wiki_enroll_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
    SELECT NEW.id,'curator',a.policy_id::text,NEW.fingerprint||':'||a.revision_id::text
    FROM (SELECT DISTINCT ON(policy_id) policy_id,revision_id,state FROM wiki_policy_activations ORDER BY policy_id,created_at DESC,id DESC) a
    JOIN wiki_policy_revisions p ON p.id=a.revision_id
    WHERE a.state IN('enabled','paused') AND p.policy->'triggers' ? 'input_changed'
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_enroll_impact AFTER INSERT ON knowledge_impact_events FOR EACH ROW EXECUTE FUNCTION wiki_enroll_impact();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wiki_record_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object_id uuid; data jsonb; before_data jsonb; input_kind text:=TG_ARGV[0]; sources jsonb;
BEGIN
 data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 before_data:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 sources:=CASE WHEN input_kind='source' THEN jsonb_build_array(data->'id') WHEN data ? 'source_item_id' THEN jsonb_build_array(data->'source_item_id') WHEN data ? 'created_from_source_item_id' THEN jsonb_build_array(data->'created_from_source_item_id') ELSE '[]'::jsonb END;
 IF data ? 'target_source_item_id' THEN sources:=sources||jsonb_build_array(data->'target_source_item_id'); END IF;
 data:=data-'updated_at'-'created_at';before_data:=before_data-'updated_at'-'created_at';
 IF input_kind='source' THEN
  data:=jsonb_build_object('id',data->'id','title',data->'title','subtitle',data->'subtitle','type',data->'type','source_uri',data->'source_uri','parent_source_item_id',data->'parent_source_item_id','descriptor',data->'metadata'->'descriptor');
  before_data:=jsonb_build_object('id',before_data->'id','title',before_data->'title','subtitle',before_data->'subtitle','type',before_data->'type','source_uri',before_data->'source_uri','parent_source_item_id',before_data->'parent_source_item_id','descriptor',before_data->'metadata'->'descriptor');
 END IF;
 IF TG_OP='UPDATE' AND data=before_data THEN RETURN NEW; END IF;
 object_id:=(data->>coalesce(TG_ARGV[1],'id'))::uuid;
 INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id)
 VALUES(input_kind,object_id,lower(TG_OP),md5(data::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
 UPDATE wiki_dependencies SET stale_reason=input_kind||'_'||lower(TG_OP),changed_at=clock_timestamp() WHERE kind=input_kind AND input_id=object_id AND stale_reason IS NULL;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_source_insert_impact AFTER INSERT ON source_items FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('source');
CREATE TRIGGER wiki_document_insert_impact AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('document');
CREATE TRIGGER wiki_chunk_insert_impact AFTER INSERT ON chunks FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('chunk');
CREATE TRIGGER wiki_note_insert_impact AFTER INSERT ON atomic_notes FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('atomic_note');
CREATE TRIGGER wiki_summary_insert_impact AFTER INSERT ON source_summaries FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('summary');
CREATE TRIGGER wiki_entity_insert_impact AFTER INSERT ON entities FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity');
CREATE TRIGGER wiki_mention_insert_impact AFTER INSERT ON entity_mentions FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity_mention');
CREATE TRIGGER wiki_note_relation_insert_impact AFTER INSERT ON atomic_note_relations FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('note_relation');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wiki_record_section_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_section jsonb; new_section jsonb; old_content jsonb; new_content jsonb; sources jsonb; section_key uuid;
BEGIN
 IF OLD.current_revision_id IS NOT DISTINCT FROM NEW.current_revision_id THEN RETURN NEW; END IF;
 SELECT content INTO old_content FROM wiki_page_revisions WHERE id=OLD.current_revision_id;
 SELECT content INTO new_content FROM wiki_page_revisions WHERE id=NEW.current_revision_id;
 SELECT coalesce(jsonb_agg(DISTINCT source_item_id),'[]') INTO sources FROM wiki_evidence WHERE page_id=NEW.id;
 FOR section_key IN SELECT (value->>'id')::uuid FROM jsonb_array_elements(coalesce(old_content->'sections','[]')||coalesce(new_content->'sections','[]')) GROUP BY value->>'id' LOOP
  SELECT value INTO old_section FROM jsonb_array_elements(coalesce(old_content->'sections','[]')) WHERE value->>'id'=section_key::text;
  SELECT value INTO new_section FROM jsonb_array_elements(coalesce(new_content->'sections','[]')) WHERE value->>'id'=section_key::text;
  IF old_section IS DISTINCT FROM new_section THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_section',section_key,CASE WHEN old_section IS NULL THEN 'insert' WHEN new_section IS NULL THEN 'delete' ELSE 'update' END,md5(coalesce(new_section::text,'deleted')),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_section_update',changed_at=clock_timestamp() WHERE kind='wiki_section' AND input_id=section_key AND stale_reason IS NULL;
  END IF;
 END LOOP;
 -- Administrative pin/order/current membership revision pointers are not semantic inputs.
 IF (old_content-'sections'-'pinned'-'position'-'parentId'-'automatic') IS DISTINCT FROM (new_content-'sections'-'pinned'-'position'-'parentId'-'automatic') OR
    (old_content->'automatic'-'memberships'-'placementProtected') IS DISTINCT FROM (new_content->'automatic'-'memberships'-'placementProtected') OR
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(old_content->'automatic'->'memberships','[]'))) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(new_content->'automatic'->'memberships','[]'))) THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_page',NEW.id,'update',md5((new_content-'pinned'-'position'-'parentId')::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_page_update',changed_at=clock_timestamp() WHERE kind='wiki_page' AND input_id=NEW.id AND stale_reason IS NULL;
 END IF;
 RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION wiki_record_section_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_section jsonb; new_section jsonb; old_content jsonb; new_content jsonb; sources jsonb; section_key uuid;
BEGIN
 IF OLD.current_revision_id IS NOT DISTINCT FROM NEW.current_revision_id THEN RETURN NEW; END IF;
 SELECT content INTO old_content FROM wiki_page_revisions WHERE id=OLD.current_revision_id;
 SELECT content INTO new_content FROM wiki_page_revisions WHERE id=NEW.current_revision_id;
 SELECT coalesce(jsonb_agg(DISTINCT source_item_id),'[]') INTO sources FROM wiki_evidence WHERE page_id=NEW.id;
 FOR section_key IN SELECT (value->>'id')::uuid FROM jsonb_array_elements(coalesce(old_content->'sections','[]')||coalesce(new_content->'sections','[]')) GROUP BY value->>'id' LOOP
  SELECT value INTO old_section FROM jsonb_array_elements(coalesce(old_content->'sections','[]')) WHERE value->>'id'=section_key::text;
  SELECT value INTO new_section FROM jsonb_array_elements(coalesce(new_content->'sections','[]')) WHERE value->>'id'=section_key::text;
  IF old_section IS DISTINCT FROM new_section THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_section',section_key,CASE WHEN old_section IS NULL THEN 'insert' WHEN new_section IS NULL THEN 'delete' ELSE 'update' END,md5(coalesce(new_section::text,'deleted')),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_section_update',changed_at=clock_timestamp() WHERE kind='wiki_section' AND input_id=section_key AND stale_reason IS NULL;
  END IF;
 END LOOP;
 -- Administrative pin/order/current membership revision pointers are not semantic inputs.
 IF (old_content-'sections'-'pinned'-'position'-'parentId'-'automatic') IS DISTINCT FROM (new_content-'sections'-'pinned'-'position'-'parentId'-'automatic') OR
    ((old_content->'automatic')-'memberships'-'placementProtected') IS DISTINCT FROM ((new_content->'automatic')-'memberships'-'placementProtected') OR
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(old_content->'automatic'->'memberships','[]'))) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(new_content->'automatic'->'memberships','[]'))) THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_page',NEW.id,'update',md5((new_content-'pinned'-'position'-'parentId')::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_page_update',changed_at=clock_timestamp() WHERE kind='wiki_page' AND input_id=NEW.id AND stale_reason IS NULL;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION wiki_enroll_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
 SELECT NEW.id,'curator',a.policy_id::text,NEW.fingerprint||':'||a.revision_id::text
 FROM (SELECT DISTINCT ON(policy_id) policy_id,revision_id,state FROM wiki_policy_activations ORDER BY policy_id,created_at DESC,id DESC) a JOIN wiki_policy_revisions p ON p.id=a.revision_id
 WHERE a.state IN('enabled','paused') AND p.policy->'triggers' ? 'input_changed' ON CONFLICT DO NOTHING;
 IF NEW.causal_run_id IS NULL THEN UPDATE wiki_source_coverage SET status='stale',updated_at=clock_timestamp() WHERE NEW.source_ids ? source_id::text; END IF;
 RETURN NEW;
END $$;


CREATE TABLE "automatic_routine_bindings" (
	"policy_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"preset_version" text NOT NULL,
	"schedule_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automatic_routine_calls" (
	"organization_run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"period" text NOT NULL,
	"tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automatic_routine_bindings" ADD CONSTRAINT "automatic_routine_bindings_schedule_id_maintenance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."maintenance_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatic_routine_calls" ADD CONSTRAINT "automatic_routine_calls_organization_run_id_organization_runs_id_fk" FOREIGN KEY ("organization_run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatic_routine_calls" ADD CONSTRAINT "automatic_routine_calls_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_routine_binding_identity_idx" ON "automatic_routine_bindings" USING btree ("policy_id","kind","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_routine_binding_schedule_idx" ON "automatic_routine_bindings" USING btree ("schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_routine_call_identity_idx" ON "automatic_routine_calls" USING btree ("organization_run_id","sequence");--> statement-breakpoint
CREATE INDEX "automatic_routine_call_policy_period_idx" ON "automatic_routine_calls" USING btree ("policy_id","period");

ALTER TABLE "maintenance_schedules" ADD COLUMN "retired_at" timestamp with time zone;

CREATE TABLE "wiki_investigation_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"composition_hash" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"previous" jsonb,
	"snapshot" jsonb NOT NULL,
	"run_id" uuid,
	"changed_understanding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_investigations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"identity" text NOT NULL,
	"question" text NOT NULL,
	"answer_page_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"input" jsonb NOT NULL,
	"current" jsonb NOT NULL,
	"last_input_fingerprint" text,
	"gaps" jsonb NOT NULL,
	"attention" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_investigation_state_check" CHECK ("wiki_investigations"."state" in ('followed','paused','resolved','awaiting_evidence'))
);
--> statement-breakpoint
ALTER TABLE "wiki_investigation_evaluations" ADD CONSTRAINT "wiki_investigation_evaluations_investigation_id_wiki_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."wiki_investigations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_investigation_evaluations" ADD CONSTRAINT "wiki_investigation_evaluations_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_investigations" ADD CONSTRAINT "wiki_investigations_answer_page_id_wiki_pages_id_fk" FOREIGN KEY ("answer_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_investigations" ADD CONSTRAINT "wiki_investigations_policy_revision_id_wiki_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."wiki_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_investigation_evaluation_identity_idx" ON "wiki_investigation_evaluations" USING btree ("investigation_id","input_fingerprint","composition_hash");--> statement-breakpoint
CREATE INDEX "wiki_investigation_evaluation_history_idx" ON "wiki_investigation_evaluations" USING btree ("investigation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_investigation_request_idx" ON "wiki_investigations" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_investigation_identity_idx" ON "wiki_investigations" USING btree ("identity");--> statement-breakpoint
CREATE INDEX "wiki_investigation_policy_state_idx" ON "wiki_investigations" USING btree ("policy_id","state");--> statement-breakpoint
CREATE FUNCTION wiki_enroll_investigation_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
 SELECT NEW.id,'investigation',i.id::text,NEW.fingerprint||':'||i.policy_revision_id::text
 FROM wiki_investigations i WHERE i.state IN ('followed','paused','awaiting_evidence')
 AND NEW.created_at>=i.created_at
 AND (coalesce(jsonb_array_length(i.input->'sourceIds'),0)=0 OR NEW.source_ids ?| ARRAY(SELECT jsonb_array_elements_text(i.input->'sourceIds'))
 OR EXISTS(SELECT 1 FROM wiki_dependencies d JOIN wiki_pages p ON p.current_revision_id=d.revision_id WHERE p.id=i.answer_page_id AND d.kind=NEW.kind AND d.input_id=NEW.input_id))
 AND NOT EXISTS(SELECT 1 FROM wiki_investigation_evaluations e WHERE e.investigation_id=i.id AND e.run_id=NEW.causal_run_id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_investigation_impact_enroll AFTER INSERT ON knowledge_impact_events FOR EACH ROW EXECUTE FUNCTION wiki_enroll_investigation_impact();


CREATE OR REPLACE FUNCTION wiki_enroll_investigation_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
 SELECT NEW.id,'investigation',i.id::text,NEW.fingerprint||':'||i.policy_revision_id::text
 FROM wiki_investigations i WHERE i.state IN ('followed','paused','awaiting_evidence')
 AND NEW.created_at>=i.created_at
 AND (coalesce(jsonb_array_length(i.input->'sourceIds'),0)=0 OR NEW.source_ids ?| ARRAY(SELECT jsonb_array_elements_text(i.input->'sourceIds'))
 OR coalesce((i.input->>'includeDescendants')::boolean,false) AND EXISTS(
 WITH RECURSIVE ancestors AS (
  SELECT id,parent_source_item_id FROM source_items WHERE NEW.source_ids ? id::text
  UNION SELECT p.id,p.parent_source_item_id FROM source_items p JOIN ancestors a ON p.id=a.parent_source_item_id
 ) SELECT 1 FROM ancestors WHERE i.input->'sourceIds' ? id::text)
 OR EXISTS(SELECT 1 FROM wiki_dependencies d JOIN wiki_pages p ON p.current_revision_id=d.revision_id WHERE p.id=i.answer_page_id AND d.kind=NEW.kind AND d.input_id=NEW.input_id))
 AND NOT EXISTS(SELECT 1 FROM wiki_investigation_evaluations e WHERE e.investigation_id=i.id AND e.run_id=NEW.causal_run_id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;


CREATE TABLE "obsidian_layout_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"config" jsonb NOT NULL,
	"previous_config" jsonb,
	"targets" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "obsidian_layout_binding_idx" ON "obsidian_layout_migrations" USING btree ("binding","created_at");