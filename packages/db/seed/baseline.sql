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

CREATE TABLE "atomic_note_evidence" (
	"note_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "atomic_note_evidence_note_id_chunk_id_pk" PRIMARY KEY("note_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "atomic_note_evolution" (
	"previous_id" uuid NOT NULL,
	"next_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atomic_note_evolution_previous_id_next_id_pk" PRIMARY KEY("previous_id","next_id")
);
--> statement-breakpoint
ALTER TABLE "atomic_notes" DROP CONSTRAINT "atomic_notes_created_from_source_item_id_source_items_id_fk";
--> statement-breakpoint
ALTER TABLE "atomic_notes" DROP CONSTRAINT "atomic_notes_evidence_chunk_id_chunks_id_fk";
--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "ownership" text DEFAULT 'source' NOT NULL;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "owning_source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "owning_chunk_id" uuid;--> statement-breakpoint
ALTER TABLE "atomic_note_evidence" ADD CONSTRAINT "atomic_note_evidence_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_evolution" ADD CONSTRAINT "atomic_note_evolution_previous_id_atomic_notes_id_fk" FOREIGN KEY ("previous_id") REFERENCES "public"."atomic_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_evolution" ADD CONSTRAINT "atomic_note_evolution_next_id_atomic_notes_id_fk" FOREIGN KEY ("next_id") REFERENCES "public"."atomic_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_evolution" ADD CONSTRAINT "atomic_note_evolution_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atomic_note_evidence_source_idx" ON "atomic_note_evidence" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "atomic_note_evolution_run_idx" ON "atomic_note_evolution" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_owning_source_item_id_source_items_id_fk" FOREIGN KEY ("owning_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD CONSTRAINT "atomic_notes_owning_chunk_id_chunks_id_fk" FOREIGN KEY ("owning_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;

-- Legacy notes retain their original lifecycle; reviewed knowledge notes do not.
ALTER TABLE atomic_notes DISABLE TRIGGER USER;
--> statement-breakpoint
UPDATE atomic_notes SET owning_source_item_id=created_from_source_item_id,owning_chunk_id=evidence_chunk_id WHERE ownership='source';
--> statement-breakpoint
ALTER TABLE atomic_notes ENABLE TRIGGER USER;
--> statement-breakpoint
ALTER TABLE atomic_notes ADD CONSTRAINT atomic_notes_ownership_check CHECK ((ownership='source' AND owning_source_item_id=created_from_source_item_id AND owning_chunk_id=evidence_chunk_id AND owning_source_item_id IS NOT NULL AND owning_chunk_id IS NOT NULL) OR (ownership='knowledge' AND owning_source_item_id IS NULL AND owning_chunk_id IS NULL));
--> statement-breakpoint
CREATE FUNCTION memora_note_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ownership='source' THEN
  NEW.owning_source_item_id:=NEW.created_from_source_item_id;
  NEW.owning_chunk_id:=NEW.evidence_chunk_id;
 ELSE
  NEW.owning_source_item_id:=NULL;
  NEW.owning_chunk_id:=NULL;
 END IF;
 IF TG_OP='INSERT' OR NEW.created_from_source_item_id IS DISTINCT FROM OLD.created_from_source_item_id OR NEW.evidence_chunk_id IS DISTINCT FROM OLD.evidence_chunk_id THEN
  IF NOT EXISTS(SELECT 1 FROM chunks WHERE id=NEW.evidence_chunk_id AND source_item_id=NEW.created_from_source_item_id) THEN RAISE EXCEPTION 'organization.errors.evidence'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.ownership='knowledge' AND NEW.ownership<>'knowledge' THEN RAISE EXCEPTION 'organization.errors.evidence'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER atomic_notes_ownership BEFORE INSERT OR UPDATE ON atomic_notes FOR EACH ROW EXECUTE FUNCTION memora_note_ownership();


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
 -- Page review is an editorial acknowledgment, not a new semantic input.
 -- Preserve the revision and review flag without invalidating consumers.
 -- Administrative pin/order/current membership revision pointers are not semantic inputs.
 IF (old_content-'sections'-'pinned'-'position'-'parentId'-'automatic'-'review') IS DISTINCT FROM (new_content-'sections'-'pinned'-'position'-'parentId'-'automatic'-'review') OR
    ((old_content->'automatic')-'memberships'-'placementProtected') IS DISTINCT FROM ((new_content->'automatic')-'memberships'-'placementProtected') OR
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(old_content->'automatic'->'memberships','[]'))) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(new_content->'automatic'->'memberships','[]'))) THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_page',NEW.id,'update',md5((new_content-'pinned'-'position'-'parentId')::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_page_update',changed_at=clock_timestamp() WHERE kind='wiki_page' AND input_id=NEW.id AND stale_reason IS NULL;
 END IF;
 RETURN NEW;
END $$;


ALTER TABLE "ai_task_runs" ADD COLUMN "queue_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD COLUMN "attempt_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_run_stages" ADD COLUMN "ended_at" timestamp with time zone;

CREATE TABLE "relation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pair_key" text NOT NULL,
	"lo_atomic_note_id" uuid NOT NULL,
	"hi_atomic_note_id" uuid NOT NULL,
	"lo_content_hash" text NOT NULL,
	"hi_content_hash" text NOT NULL,
	"decider_key" text NOT NULL,
	"lo_to_hi_score" double precision,
	"lo_to_hi_relation_type" text,
	"hi_to_lo_score" double precision,
	"hi_to_lo_relation_type" text,
	"relation_type" text,
	"accepted" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_task_run_id" uuid,
	CONSTRAINT "relation_decisions_pair" CHECK ("relation_decisions"."lo_atomic_note_id" < "relation_decisions"."hi_atomic_note_id" and "relation_decisions"."pair_key" = "relation_decisions"."lo_atomic_note_id"::text || ':' || "relation_decisions"."hi_atomic_note_id"::text),
	CONSTRAINT "relation_decisions_directions" CHECK (("relation_decisions"."lo_to_hi_score" is not null or "relation_decisions"."hi_to_lo_score" is not null)
        and ("relation_decisions"."lo_to_hi_score" is null) = ("relation_decisions"."lo_to_hi_relation_type" is null)
        and ("relation_decisions"."hi_to_lo_score" is null) = ("relation_decisions"."hi_to_lo_relation_type" is null)
        and coalesce("relation_decisions"."lo_to_hi_score", 0) between 0 and 1
        and coalesce("relation_decisions"."hi_to_lo_score", 0) between 0 and 1),
	CONSTRAINT "relation_decisions_accepted" CHECK (("relation_decisions"."relation_type" is not null) = "relation_decisions"."accepted"),
	CONSTRAINT "relation_decisions_types" CHECK (coalesce("relation_decisions"."lo_to_hi_relation_type", 'related') in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related')
        and coalesce("relation_decisions"."hi_to_lo_relation_type", 'related') in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related')
        and coalesce("relation_decisions"."relation_type", 'related') in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related'))
);
--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_lo_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("lo_atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_hi_atomic_note_id_atomic_notes_id_fk" FOREIGN KEY ("hi_atomic_note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_decisions_pair_decider_uidx" ON "relation_decisions" USING btree ("pair_key","decider_key");--> statement-breakpoint
CREATE INDEX "relation_decisions_lo_note_idx" ON "relation_decisions" USING btree ("lo_atomic_note_id");--> statement-breakpoint
CREATE INDEX "relation_decisions_hi_note_idx" ON "relation_decisions" USING btree ("hi_atomic_note_id");

-- Decision 13: generated atomic notes are active at birth; review is optional and never a gate.
-- A value added to an enum cannot be used in the transaction that adds it, and every pending
-- migration runs in one transaction, so the type is rebuilt with the new value instead.
ALTER TABLE "atomic_notes" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."atomic_note_status" RENAME TO "atomic_note_status_old";--> statement-breakpoint
CREATE TYPE "public"."atomic_note_status" AS ENUM('active', 'pending_review', 'approved', 'rejected', 'archived');--> statement-breakpoint
ALTER TABLE "atomic_notes" ALTER COLUMN "status" TYPE "public"."atomic_note_status" USING "status"::text::"public"."atomic_note_status";--> statement-breakpoint
ALTER TABLE "atomic_note_review_events" ALTER COLUMN "previous_status" TYPE "public"."atomic_note_status" USING "previous_status"::text::"public"."atomic_note_status";--> statement-breakpoint
ALTER TABLE "atomic_note_review_events" ALTER COLUMN "next_status" TYPE "public"."atomic_note_status" USING "next_status"::text::"public"."atomic_note_status";--> statement-breakpoint
ALTER TABLE "atomic_notes" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
DROP TYPE "public"."atomic_note_status_old";--> statement-breakpoint
-- Generated notes nobody reviewed become active. Discarded, approved, archived, human-edited
-- (protected) notes and notes with an edit in their audit keep their status. The wiki impact
-- trigger is off for this one statement: it is a relabeling, not a change of evidence.
ALTER TABLE "atomic_notes" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "atomic_notes" SET "status" = 'active'
WHERE "status" = 'pending_review'
  AND "metadata"->>'humanProtected' IS DISTINCT FROM 'true'
  AND NOT EXISTS (
    SELECT 1 FROM "atomic_note_review_events" e
    WHERE e."atomic_note_id" = "atomic_notes"."id" AND e."action" = 'edit'
  );--> statement-breakpoint
ALTER TABLE "atomic_notes" ENABLE TRIGGER USER;


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


CREATE TABLE "view_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"address" text NOT NULL,
	"title" text NOT NULL,
	"parent_address" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_count" integer DEFAULT 1 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	CONSTRAINT "view_history_kind" CHECK ("view_history"."kind" in ('source','note','topic','question','entity')),
	CONSTRAINT "view_history_address" CHECK ("view_history"."address" = 'memora://' || "view_history"."kind" || '/' || "view_history"."object_id"::text),
	CONSTRAINT "view_history_title" CHECK (char_length("view_history"."title") between 1 and 300),
	CONSTRAINT "view_history_open_count" CHECK ("view_history"."open_count" >= 1),
	CONSTRAINT "view_history_pin" CHECK (("view_history"."pinned") = ("view_history"."pinned_at" is not null)),
	CONSTRAINT "view_history_parent" CHECK ("view_history"."parent_address" is null or "view_history"."parent_address" like 'memora://%/%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "view_history_address_uidx" ON "view_history" USING btree ("address");--> statement-breakpoint
CREATE INDEX "view_history_order_idx" ON "view_history" USING btree ("pinned","opened_at");

-- Approving a note no longer changes the fingerprint of the source-relation evidence derived from it.
-- Re-key every stored fingerprint that matches the former formula under any live review status, so
-- evidence made stale only by an approval becomes current again. Idempotent: a re-keyed row no longer
-- matches the former formula.
update source_relation_evidence e
   set snapshot = jsonb_set(e.snapshot, '{noteFingerprint}', to_jsonb(md5(concat_ws('|',
         n.id::text, n.relation_type, n.status::text, n.metadata::text,
         least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
               concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
         greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                  concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))))
  from atomic_note_relations n, atomic_notes a, atomic_notes b
 where n.id = e.note_relation_id and a.id = e.source_note_id and b.id = e.target_note_id
   and e.snapshot->>'noteFingerprint' in (
     select md5(concat_ws('|', n.id::text, n.relation_type, n.status::text, n.metadata::text,
              least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,sa,a.supersession_status),
                    concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,sb,b.supersession_status)),
              greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,sa,a.supersession_status),
                       concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,sb,b.supersession_status))))
       from unnest(array['active','pending_review','approved']) sa,
            unnest(array['active','pending_review','approved']) sb);


CREATE TABLE "atomic_note_relation_explanations" (
	"relation_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"input_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"ai_task_run_id" uuid,
	"language" varchar(16) NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atomic_note_relation_explanations_text" CHECK (char_length("atomic_note_relation_explanations"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "atomic_note_relation_explanations" ADD CONSTRAINT "atomic_note_relation_explanations_relation_id_atomic_note_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."atomic_note_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_note_relation_explanations" ADD CONSTRAINT "atomic_note_relation_explanations_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;

CREATE TABLE "source_relation_explanations" (
	"relation_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"input_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"ai_task_run_id" uuid,
	"language" varchar(16) NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_relation_explanations_text" CHECK (char_length("source_relation_explanations"."text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "source_idea" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "target_idea" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "explanation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relation_explanations" ADD CONSTRAINT "source_relation_explanations_relation_id_source_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."source_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relation_explanations" ADD CONSTRAINT "source_relation_explanations_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "jobs" ADD COLUMN "lane" text DEFAULT 'heavy' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "jobs_lane_queue_idx" ON "jobs" USING btree ("lane","priority" DESC NULLS FIRST,"run_after") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_queued_uidx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lane" CHECK ("jobs"."lane" in ('heavy','light'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dedupe_key" CHECK ("jobs"."dedupe_key" is null or char_length("jobs"."dedupe_key") between 1 and 200);

ALTER TYPE "public"."obsidian_sync_status" ADD VALUE 'retired';--> statement-breakpoint
ALTER TABLE "atomic_note_evolution" DROP CONSTRAINT "atomic_note_evolution_run_id_organization_runs_id_fk";
--> statement-breakpoint
-- Legacy detach (F2 D5): the legacy wiki impact feed leaves the ingestion hot path. Every row stays.
DROP TRIGGER wiki_source_impact ON source_items;
--> statement-breakpoint
DROP TRIGGER wiki_document_impact ON documents;
--> statement-breakpoint
DROP TRIGGER wiki_chunk_impact ON chunks;
--> statement-breakpoint
DROP TRIGGER wiki_note_impact ON atomic_notes;
--> statement-breakpoint
DROP TRIGGER wiki_note_links_impact ON atomic_note_source_links;
--> statement-breakpoint
DROP TRIGGER wiki_note_relation_impact ON atomic_note_relations;
--> statement-breakpoint
DROP TRIGGER wiki_relation_impact ON source_relations;
--> statement-breakpoint
DROP TRIGGER wiki_relation_evidence_impact ON source_relation_evidence;
--> statement-breakpoint
DROP TRIGGER wiki_summary_impact ON source_summaries;
--> statement-breakpoint
DROP TRIGGER wiki_entity_impact ON entities;
--> statement-breakpoint
DROP TRIGGER wiki_mention_impact ON entity_mentions;
--> statement-breakpoint
DROP TRIGGER wiki_section_impact ON wiki_pages;
--> statement-breakpoint
DROP TRIGGER wiki_enroll_impact ON knowledge_impact_events;
--> statement-breakpoint
DROP TRIGGER wiki_source_insert_impact ON source_items;
--> statement-breakpoint
DROP TRIGGER wiki_document_insert_impact ON documents;
--> statement-breakpoint
DROP TRIGGER wiki_chunk_insert_impact ON chunks;
--> statement-breakpoint
DROP TRIGGER wiki_note_insert_impact ON atomic_notes;
--> statement-breakpoint
DROP TRIGGER wiki_summary_insert_impact ON source_summaries;
--> statement-breakpoint
DROP TRIGGER wiki_entity_insert_impact ON entities;
--> statement-breakpoint
DROP TRIGGER wiki_mention_insert_impact ON entity_mentions;
--> statement-breakpoint
DROP TRIGGER wiki_note_relation_insert_impact ON atomic_note_relations;
--> statement-breakpoint
DROP TRIGGER wiki_investigation_impact_enroll ON knowledge_impact_events;
--> statement-breakpoint
DROP FUNCTION wiki_record_impact();
--> statement-breakpoint
DROP FUNCTION wiki_record_section_impact();
--> statement-breakpoint
DROP FUNCTION wiki_enroll_impact();
--> statement-breakpoint
DROP FUNCTION wiki_enroll_investigation_impact();
--> statement-breakpoint
-- Legacy insert fence (F2 D40): code that still writes legacy content (an older build on this
-- database, or a stray writer) fails closed instead of re-creating the wiki or starting curator work.
-- Only test seeders set memora.legacy_fixture, on scratch databases.
CREATE FUNCTION legacy_insert_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('memora.legacy_fixture', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'legacy.errors.retired';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON wiki_pages FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON organization_runs FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON organization_settings_revisions FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON maintenance_runs FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON maintenance_schedules FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON wiki_policy_revisions FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON wiki_investigations FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();


-- Topic Tree Engine tables (F2 T12; D1, D7, D9, D32). The I7 backstop indexes titles without case
-- or accents; unaccent() is only STABLE, so an IMMUTABLE wrapper pins its dictionary.
CREATE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
--> statement-breakpoint
CREATE TABLE "topic_calibrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_key" text NOT NULL,
	"decider_key" text,
	"params" jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dataset" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_calibrations_json" CHECK (jsonb_typeof("topic_calibrations"."params") = 'object' and jsonb_typeof("topic_calibrations"."metrics") = 'object')
);
--> statement-breakpoint
CREATE TABLE "topic_change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"title_key" text NOT NULL,
	"title_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text DEFAULT 'low' NOT NULL,
	"undo_of" uuid,
	"job_id" uuid,
	"ai_task_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	CONSTRAINT "topic_change_sets_origin" CHECK ("topic_change_sets"."origin" in ('build','place','gate','rebalance','audit','naming','areas','human','undo','rebuild')
        and ("topic_change_sets"."origin" = 'undo') = ("topic_change_sets"."undo_of" is not null)),
	CONSTRAINT "topic_change_sets_status" CHECK ("topic_change_sets"."status" in ('applied','undone','pending_review','dismissed')
        and ("topic_change_sets"."status" in ('applied','undone')) = ("topic_change_sets"."generation" is not null)
        and ("topic_change_sets"."status" in ('applied','undone')) = ("topic_change_sets"."applied_at" is not null)
        and ("topic_change_sets"."status" = 'undone') = ("topic_change_sets"."undone_at" is not null)),
	CONSTRAINT "topic_change_sets_risk" CHECK ("topic_change_sets"."risk" in ('low','medium','high')),
	CONSTRAINT "topic_change_sets_json" CHECK (char_length("topic_change_sets"."title_key") between 1 and 200 and jsonb_typeof("topic_change_sets"."title_params") = 'object'
        and jsonb_typeof("topic_change_sets"."ai_task_run_ids") = 'array' and jsonb_typeof("topic_change_sets"."summary") = 'object')
);
--> statement-breakpoint
CREATE TABLE "topic_daily_metrics" (
	"tree_id" uuid NOT NULL,
	"day" date NOT NULL,
	"ops_applied" integer DEFAULT 0 NOT NULL,
	"items_moved" integer DEFAULT 0 NOT NULL,
	"primary_path_changes" integer DEFAULT 0 NOT NULL,
	"unsorted_share" real,
	"mean_depth" real,
	"fanout_in_target" real,
	"hard_violations" integer,
	"soft_violations" integer,
	"gate_calls" integer DEFAULT 0 NOT NULL,
	"naming_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_daily_metrics_tree_id_day_pk" PRIMARY KEY("tree_id","day"),
	CONSTRAINT "topic_daily_metrics_counts" CHECK ("topic_daily_metrics"."ops_applied" >= 0 and "topic_daily_metrics"."items_moved" >= 0 and "topic_daily_metrics"."primary_path_changes" >= 0
        and "topic_daily_metrics"."gate_calls" >= 0 and "topic_daily_metrics"."naming_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "topic_gate_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_hash" text NOT NULL,
	"descriptor_set_hash" text NOT NULL,
	"decider_key" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"chosen_topic_id" uuid,
	"none_of_these" boolean DEFAULT false NOT NULL,
	"ai_task_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_gate_decisions_decision" CHECK ("topic_gate_decisions"."item_kind" in ('note','source') and "topic_gate_decisions"."none_of_these" = ("topic_gate_decisions"."chosen_topic_id" is null)
        and jsonb_typeof("topic_gate_decisions"."candidates") = 'array')
);
--> statement-breakpoint
CREATE TABLE "topic_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"note_id" uuid,
	"source_item_id" uuid,
	"root_source_item_id" uuid,
	"topic_id" uuid NOT NULL,
	"role" text NOT NULL,
	"rank" smallint NOT NULL,
	"management" text DEFAULT 'ai' NOT NULL,
	"decided_by" text NOT NULL,
	"item_fingerprint" text,
	"score" double precision,
	"margin" double precision,
	"centrality" real,
	"needs_gate" boolean DEFAULT false NOT NULL,
	"needs_split_check" boolean DEFAULT false NOT NULL,
	"needs_vector" boolean DEFAULT false NOT NULL,
	"moved_from_topic_id" uuid,
	"moved_at" timestamp with time zone,
	"change_set_id" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_placements_item" CHECK (("topic_placements"."item_kind" = 'note' and "topic_placements"."note_id" is not null and "topic_placements"."source_item_id" is null)
        or ("topic_placements"."item_kind" = 'source' and "topic_placements"."source_item_id" is not null and "topic_placements"."note_id" is null
            and "topic_placements"."root_source_item_id" is null)),
	CONSTRAINT "topic_placements_rank" CHECK ("topic_placements"."rank" between 0 and 2 and "topic_placements"."role" in ('primary','secondary')
        and ("topic_placements"."role" = 'primary') = ("topic_placements"."rank" = 0)),
	CONSTRAINT "topic_placements_decision" CHECK ("topic_placements"."management" in ('ai','human')
        and "topic_placements"."decided_by" in ('build','auto','gate','fallback','human','rebuild')
        and ("topic_placements"."item_fingerprint" is null or char_length("topic_placements"."item_fingerprint") between 1 and 200))
);
--> statement-breakpoint
CREATE TABLE "topic_stats" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"space_key" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"ls" "bytea",
	"cos_sq_sum" double precision DEFAULT 0 NOT NULL,
	"low_cos_percentiles" real[] DEFAULT '{}'::real[] NOT NULL,
	"coherence" real,
	"direct_items" integer DEFAULT 0 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"health" text DEFAULT 'good' NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"last_repair_at" timestamp with time zone,
	"repair_clock" bigint,
	"computed_at" timestamp with time zone,
	CONSTRAINT "topic_stats_counts" CHECK ("topic_stats"."n" >= 0 and "topic_stats"."direct_items" >= 0 and "topic_stats"."children" >= 0),
	CONSTRAINT "topic_stats_health" CHECK ("topic_stats"."health" in ('good','attention','violation') and jsonb_typeof("topic_stats"."violations") = 'array')
);
--> statement-breakpoint
CREATE TABLE "topic_structure_events" (
	"change_set_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"topic_id" uuid,
	"item_kind" text,
	"item_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ref_topic_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "topic_structure_events_change_set_id_seq_pk" PRIMARY KEY("change_set_id","seq"),
	CONSTRAINT "topic_structure_events_op" CHECK ("topic_structure_events"."op" in ('topic.create','topic.retire','topic.restore','topic.move','topic.rename',
        'topic.describe','topic.manage','item.place','item.unplace','item.move') and "topic_structure_events"."seq" >= 0),
	CONSTRAINT "topic_structure_events_item" CHECK (("topic_structure_events"."item_kind" is null) = ("topic_structure_events"."item_id" is null)
        and ("topic_structure_events"."item_kind" is null or "topic_structure_events"."item_kind" in ('note','source')))
);
--> statement-breakpoint
CREATE TABLE "topic_trees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"space_key" text NOT NULL,
	"embedding_provider" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_runtime" text NOT NULL,
	"dimensions" smallint NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"seed" bigint NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"clock" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "topic_trees_status" CHECK ("topic_trees"."status" in ('active','retired')),
	CONSTRAINT "topic_trees_life" CHECK (("topic_trees"."status" = 'retired') = ("topic_trees"."retired_at" is not null)
        and ("topic_trees"."status" <> 'active' or "topic_trees"."activated_at" is not null)),
	CONSTRAINT "topic_trees_dimensions" CHECK ("topic_trees"."dimensions" in (256,768,1024)),
	CONSTRAINT "topic_trees_counters" CHECK ("topic_trees"."generation" >= 0 and "topic_trees"."clock" >= 0),
	CONSTRAINT "topic_trees_text" CHECK (char_length("topic_trees"."space_key") between 1 and 300 and char_length("topic_trees"."config_hash") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tree_id" uuid NOT NULL,
	"parent_id" uuid,
	"role" text DEFAULT 'topic' NOT NULL,
	"title" text,
	"name_state" text DEFAULT 'unnamed' NOT NULL,
	"name_source" text,
	"name_language" varchar(16),
	"named_change_set_id" uuid,
	"description" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"management" text DEFAULT 'ai' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"retired_at" timestamp with time zone,
	"redirect_to" uuid,
	"created_change_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_role" CHECK ("topics"."role" in ('root','topic')),
	CONSTRAINT "topics_parent" CHECK ("topics"."parent_id" is distinct from "topics"."id" and ("topics"."role" = 'root') = ("topics"."parent_id" is null)),
	CONSTRAINT "topics_name_state" CHECK ("topics"."name_state" in ('named','provisional','unnamed')
        and ("topics"."name_source" is null or "topics"."name_source" in ('llm','human','tfidf'))
        and ("topics"."role" = 'root' or ("topics"."name_state" = 'unnamed') = ("topics"."title" is null))),
	CONSTRAINT "topics_text" CHECK (("topics"."title" is null or char_length("topics"."title") between 1 and 120)
        and ("topics"."description" is null or char_length("topics"."description") between 1 and 400)
        and ("topics"."name_language" is null or char_length("topics"."name_language") >= 1)
        and jsonb_typeof("topics"."aliases") = 'array' and jsonb_array_length("topics"."aliases") <= 10),
	CONSTRAINT "topics_management" CHECK ("topics"."management" in ('ai','human','pinned')),
	CONSTRAINT "topics_position" CHECK ("topics"."position" >= 0),
	CONSTRAINT "topics_redirect" CHECK (("topics"."redirect_to" is null or "topics"."retired_at" is not null) and "topics"."redirect_to" is distinct from "topics"."id")
);
--> statement-breakpoint
ALTER TABLE "topic_change_sets" ADD CONSTRAINT "topic_change_sets_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_change_sets" ADD CONSTRAINT "topic_change_sets_undo_of_topic_change_sets_id_fk" FOREIGN KEY ("undo_of") REFERENCES "public"."topic_change_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_change_sets" ADD CONSTRAINT "topic_change_sets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_daily_metrics" ADD CONSTRAINT "topic_daily_metrics_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_gate_decisions" ADD CONSTRAINT "topic_gate_decisions_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_gate_decisions" ADD CONSTRAINT "topic_gate_decisions_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_change_set_id_topic_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."topic_change_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_stats" ADD CONSTRAINT "topic_stats_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_structure_events" ADD CONSTRAINT "topic_structure_events_change_set_id_topic_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."topic_change_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_tree_id_topic_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."topic_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_redirect_to_topics_id_fk" FOREIGN KEY ("redirect_to") REFERENCES "public"."topics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_calibrations_active_uidx" ON "topic_calibrations" USING btree ("space_key",coalesce("decider_key", '')) WHERE "topic_calibrations"."active";--> statement-breakpoint
CREATE INDEX "topic_change_sets_tree_created_idx" ON "topic_change_sets" USING btree ("tree_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "topic_change_sets_generation_uidx" ON "topic_change_sets" USING btree ("tree_id","generation") WHERE "topic_change_sets"."generation" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_gate_decisions_cache_uidx" ON "topic_gate_decisions" USING btree ("item_hash","descriptor_set_hash","decider_key");--> statement-breakpoint
CREATE INDEX "topic_gate_decisions_item_idx" ON "topic_gate_decisions" USING btree ("item_kind","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_placements_item_rank_uidx" ON "topic_placements" USING btree ("tree_id","item_kind",coalesce("note_id", "source_item_id"),"rank");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_placements_item_topic_uidx" ON "topic_placements" USING btree ("tree_id","item_kind",coalesce("note_id", "source_item_id"),"topic_id");--> statement-breakpoint
CREATE INDEX "topic_placements_topic_role_idx" ON "topic_placements" USING btree ("topic_id","role","centrality" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topic_placements_note_idx" ON "topic_placements" USING btree ("note_id") WHERE "topic_placements"."note_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_placements_source_idx" ON "topic_placements" USING btree ("source_item_id") WHERE "topic_placements"."source_item_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_placements_flagged_idx" ON "topic_placements" USING btree ("tree_id") WHERE "topic_placements"."needs_gate" or "topic_placements"."needs_split_check" or "topic_placements"."needs_vector";--> statement-breakpoint
CREATE INDEX "topic_stats_dirty_idx" ON "topic_stats" USING btree ("topic_id") WHERE "topic_stats"."dirty";--> statement-breakpoint
CREATE INDEX "topic_structure_events_topic_idx" ON "topic_structure_events" USING btree ("topic_id") WHERE "topic_structure_events"."topic_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_structure_events_item_idx" ON "topic_structure_events" USING btree ("item_kind","item_id") WHERE "topic_structure_events"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_structure_events_refs_idx" ON "topic_structure_events" USING gin ("ref_topic_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_trees_active_uidx" ON "topic_trees" USING btree ("status") WHERE "topic_trees"."status" = 'active';--> statement-breakpoint
CREATE INDEX "topics_children_idx" ON "topics" USING btree ("tree_id","parent_id","position") WHERE "topics"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_tree_root_uidx" ON "topics" USING btree ("tree_id") WHERE "topics"."role" = 'root' and "topics"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_sibling_title_uidx" ON "topics" USING btree ("parent_id",f_unaccent(lower("title"))) WHERE "topics"."retired_at" is null and "topics"."title" is not null;
--> statement-breakpoint
-- D9: the engine is the single writer of AI-managed topic structure. Inserting an AI-managed topic,
-- or changing the parent or management of a topic that is or becomes AI-managed, is refused unless
-- the transaction set memora.topic_writer = 'engine'. The same trigger keeps a parent in the
-- topic's own tree and refuses cycles.
CREATE FUNCTION topics_parent_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ancestor uuid;
  hops integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
     AND NEW.management = OLD.management THEN
    RETURN NEW;
  END IF;
  IF (NEW.management = 'ai' OR (TG_OP = 'UPDATE' AND OLD.management = 'ai'))
     AND current_setting('memora.topic_writer', true) IS DISTINCT FROM 'engine' THEN
    RAISE EXCEPTION 'topics.errors.writerGuard';
  END IF;
  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    IF NOT EXISTS (SELECT 1 FROM topics p WHERE p.id = NEW.parent_id AND p.tree_id = NEW.tree_id) THEN
      RAISE EXCEPTION 'topics.errors.parentTree';
    END IF;
    ancestor := NEW.parent_id;
    WHILE ancestor IS NOT NULL LOOP
      hops := hops + 1;
      IF ancestor = NEW.id OR hops > 64 THEN
        RAISE EXCEPTION 'topics.errors.cycle';
      END IF;
      SELECT p.parent_id INTO ancestor FROM topics p WHERE p.id = ancestor;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER topics_parent_writer_guard BEFORE INSERT OR UPDATE OF parent_id, management ON topics
  FOR EACH ROW EXECUTE FUNCTION topics_parent_writer_guard();
--> statement-breakpoint
-- D32: placements leave with their items by cascade. Every delete marks the statistics of the topics
-- that held them, of their ancestors and, for a note's primary placement, of its root source's primary
-- path (the source may count again, D8) dirty; topic-sweep recomputes them. Rows are locked root
-- first and updated even when already dirty, so a mark waits for a recompute holding them and lands
-- after it instead of being lost.
CREATE FUNCTION topic_placements_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM removed) THEN
    RETURN NULL;
  END IF;
  WITH RECURSIVE touched AS (
    SELECT r.topic_id AS id FROM removed r
    UNION
    SELECT p.topic_id FROM removed r
      JOIN topic_placements p ON p.tree_id = r.tree_id AND p.item_kind = 'source'
       AND p.source_item_id = r.root_source_item_id AND p.rank = 0
     WHERE r.item_kind = 'note' AND r.rank = 0 AND r.root_source_item_id IS NOT NULL
  ), path AS (
    SELECT t.id, t.parent_id FROM topics t JOIN touched ON t.id = touched.id
    UNION
    SELECT t.id, t.parent_id FROM topics t JOIN path ON t.id = path.parent_id
  ), locked AS (
    SELECT s.topic_id FROM topic_stats s JOIN path ON path.id = s.topic_id
     ORDER BY (path.parent_id IS NULL) DESC, s.topic_id FOR UPDATE OF s
  )
  UPDATE topic_stats s SET dirty = true FROM locked WHERE s.topic_id = locked.topic_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER topic_placements_mark_dirty AFTER DELETE ON topic_placements
  REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION topic_placements_mark_dirty();


-- Topic overviews (F2 T31, D16): prose written when a Topic page opens, cached per member
-- fingerprint, prompt revision and content language, with citations to exact chunks and spans. A
-- replaced passage or a deleted note leaves its citation readable (excerpt) and unavailable.
CREATE TABLE "topic_overview_citations" (
	"topic_id" uuid NOT NULL,
	"n" smallint NOT NULL,
	"chunk_id" uuid,
	"source_span_id" uuid,
	"note_id" uuid,
	"excerpt" text NOT NULL,
	"excerpt_hash" text NOT NULL,
	CONSTRAINT "topic_overview_citations_topic_id_n_pk" PRIMARY KEY("topic_id","n"),
	CONSTRAINT "topic_overview_citations_citation" CHECK ("topic_overview_citations"."n" between 1 and 40 and char_length("topic_overview_citations"."excerpt") between 1 and 1200
        and char_length("topic_overview_citations"."excerpt_hash") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "topic_overviews" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"paragraphs" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"member_fingerprint" text NOT NULL,
	"member_count" integer NOT NULL,
	"input_hash" text NOT NULL,
	"prompt_revision_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"runtime" text NOT NULL,
	"ai_task_run_id" uuid,
	"language" varchar(16) NOT NULL,
	"support" jsonb DEFAULT '{"status":"unchecked","unsupported":[]}'::jsonb NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_overviews_shape" CHECK (jsonb_typeof("topic_overviews"."paragraphs") = 'array' and jsonb_array_length("topic_overviews"."paragraphs") between 1 and 12
        and jsonb_typeof("topic_overviews"."evidence") = 'array' and jsonb_array_length("topic_overviews"."evidence") <= 40
        and jsonb_typeof("topic_overviews"."support") = 'object' and "topic_overviews"."member_count" >= 0),
	CONSTRAINT "topic_overviews_text" CHECK (char_length("topic_overviews"."member_fingerprint") between 1 and 200 and char_length("topic_overviews"."input_hash") between 1 and 200
        and char_length("topic_overviews"."prompt_revision_id") between 1 and 200 and char_length("topic_overviews"."language") >= 1)
);
--> statement-breakpoint
ALTER TABLE "topic_overview_citations" ADD CONSTRAINT "topic_overview_citations_topic_id_topic_overviews_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic_overviews"("topic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_overview_citations" ADD CONSTRAINT "topic_overview_citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_overview_citations" ADD CONSTRAINT "topic_overview_citations_source_span_id_source_spans_id_fk" FOREIGN KEY ("source_span_id") REFERENCES "public"."source_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_overview_citations" ADD CONSTRAINT "topic_overview_citations_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_overviews" ADD CONSTRAINT "topic_overviews_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_overviews" ADD CONSTRAINT "topic_overviews_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_overview_citations_note_idx" ON "topic_overview_citations" USING btree ("note_id") WHERE "topic_overview_citations"."note_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_overview_citations_chunk_idx" ON "topic_overview_citations" USING btree ("chunk_id") WHERE "topic_overview_citations"."chunk_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_overview_citations_span_idx" ON "topic_overview_citations" USING btree ("source_span_id") WHERE "topic_overview_citations"."source_span_id" is not null;

-- Owner decision 19 (F2): a gated placement that meets no validated decider is the gate's "none",
-- recorded as `decided_by = 'fallback-none'`, so the gate decides it again once a ranker validates.
ALTER TABLE "topic_placements" DROP CONSTRAINT "topic_placements_decision";--> statement-breakpoint
ALTER TABLE "topic_placements" ADD CONSTRAINT "topic_placements_decision" CHECK ("topic_placements"."management" in ('ai','human')
        and "topic_placements"."decided_by" in ('build','auto','gate','fallback','fallback-none','human','rebuild')
        and ("topic_placements"."item_fingerprint" is null or char_length("topic_placements"."item_fingerprint") between 1 and 200));

-- Relations v2 (F3 T48; docs/f3-decisions.md D8-D12, D14, D20, D27). Note relations keep their pair
-- once (source < target by UUID) with an explicit direction; automation's band, probability and veto
-- stay apart from the human review status; relation decisions record their score scale; source
-- relations may be promoted (no scores, a support count); typing cache, matching state, runs and
-- events; and the source-evidence note fingerprint hashes facts only. Nothing is deleted and no
-- `metadata` is rewritten: every relation keeps its meaning, and its direction wherever the decided
-- metadata names its pair. `packages/db/src/scripts/verify-relations-v2.ts` checks the result.
--
-- 1. Guards: nothing below may lose or merge a relation. The canonical CHECKs would also refuse a
-- self pair or an unknown type; the guards say why.
DO $$
DECLARE
  self_pairs bigint;
  collisions bigint;
  unknown_types text;
BEGIN
  SELECT count(*) INTO self_pairs FROM atomic_note_relations
   WHERE source_atomic_note_id = target_atomic_note_id;
  IF self_pairs > 0 THEN
    RAISE EXCEPTION 'relations_v2: % note relation(s) link a note to itself', self_pairs;
  END IF;
  SELECT count(*) INTO collisions FROM atomic_note_relations r
    JOIN atomic_note_relations s ON s.source_atomic_note_id = r.target_atomic_note_id
                                AND s.target_atomic_note_id = r.source_atomic_note_id
   WHERE r.source_atomic_note_id > r.target_atomic_note_id;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'relations_v2: % note relation(s) are stored in both orders; sorting them would merge relations', collisions;
  END IF;
  SELECT string_agg(DISTINCT coalesce(relation_type, '<null>'), ', ') INTO unknown_types
    FROM atomic_note_relations
   WHERE relation_type IS NULL OR relation_type NOT IN ('supports','contrasts','extends','similar_to',
     'depends_on','clarifies','mentions','related','contradicts','example_of','same_as');
  IF unknown_types IS NOT NULL THEN
    RAISE EXCEPTION 'relations_v2: note relations with types outside the vocabulary: %', unknown_types;
  END IF;
END $$;
--> statement-breakpoint
-- 2. Pre-counts (the report) and the source evidence that is current under the former fingerprint
-- and currentness rules, inlined as they stood before this migration.
CREATE TEMP TABLE "relations_v2_report" ("key" text PRIMARY KEY, "value" bigint NOT NULL) ON COMMIT DROP;
--> statement-breakpoint
CREATE TEMP TABLE "relations_v2_current_evidence" ON COMMIT DROP AS
SELECT e.id, e.relation_id, e.origin
  FROM source_relation_evidence e
  LEFT JOIN chunks sc ON sc.id = e.source_chunk_id
  LEFT JOIN chunks tc ON tc.id = e.target_chunk_id
  LEFT JOIN documents sd ON sd.id = sc.document_id LEFT JOIN documents td ON td.id = tc.document_id
  LEFT JOIN atomic_note_relations n ON n.id = e.note_relation_id
  LEFT JOIN atomic_notes a ON a.id = e.source_note_id
  LEFT JOIN atomic_notes b ON b.id = e.target_note_id
 WHERE (sc.id IS NOT NULL AND tc.id IS NOT NULL
   AND sd.metadata->>'supersededByDocumentId' IS NULL AND td.metadata->>'supersededByDocumentId' IS NULL
   AND sc.content_hash = e.snapshot->>'sourceHash' AND tc.content_hash = e.snapshot->>'targetHash'
   AND (e.origin = 'source_analysis' OR (n.id IS NOT NULL AND n.status <> 'rejected'
     AND a.status NOT IN ('rejected','archived') AND b.status NOT IN ('rejected','archived')
     AND a.supersession_status = 'current' AND b.supersession_status = 'current'
     AND md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
       least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
             concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
       greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))
         = e.snapshot->>'noteFingerprint')));
--> statement-breakpoint
-- Note-origin evidence whose stored fingerprint is the former formula's, whatever its other
-- currentness conditions: step 7 re-keys all of it, so evidence that is stale only for a reversible
-- reason (an endpoint note discarded or archived, then approved again) still revives, as 0048 kept it.
CREATE TEMP TABLE "relations_v2_rekey" ON COMMIT DROP AS
SELECT e.id
  FROM source_relation_evidence e
  JOIN atomic_note_relations n ON n.id = e.note_relation_id
  JOIN atomic_notes a ON a.id = e.source_note_id
  JOIN atomic_notes b ON b.id = e.target_note_id
 WHERE e.origin = 'atomic_notes'
   AND md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
       least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
             concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
       greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))
       = e.snapshot->>'noteFingerprint';
--> statement-breakpoint
INSERT INTO "relations_v2_report" ("key", "value")
SELECT 'note_relations_' || status::text, count(*) FROM atomic_note_relations GROUP BY status
UNION ALL SELECT 'note_relations', count(*) FROM atomic_note_relations
UNION ALL SELECT 'metadata_names_pair', count(*) FROM atomic_note_relations
 WHERE (lower(metadata->>'semanticSourceAtomicNoteId'), lower(metadata->>'semanticTargetAtomicNoteId'))
       IN ((source_atomic_note_id::text, target_atomic_note_id::text),
           (target_atomic_note_id::text, source_atomic_note_id::text))
UNION ALL SELECT 'swapped', count(*) FROM atomic_note_relations
 WHERE source_atomic_note_id > target_atomic_note_id
UNION ALL SELECT 'source_relations', count(*) FROM source_relations
UNION ALL SELECT 'source_evidence', count(*) FROM source_relation_evidence
UNION ALL SELECT 'evidence_former_fingerprint', count(*) FROM relations_v2_rekey
UNION ALL SELECT 'current_evidence_before', count(*) FROM relations_v2_current_evidence
UNION ALL SELECT 'current_source_relations_before', count(DISTINCT relation_id) FROM relations_v2_current_evidence;
--> statement-breakpoint
-- 3. The canonical pair. Sorting swaps the endpoint columns of any row stored high-to-low (none
-- expected: the upsert always sorted lowercase UUIDs, whose text order is PostgreSQL's uuid order).
UPDATE atomic_note_relations
   SET source_atomic_note_id = target_atomic_note_id, target_atomic_note_id = source_atomic_note_id
 WHERE source_atomic_note_id > target_atomic_note_id;
--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "band" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "probability" real;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "decider_key" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "typer_key" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "vetoed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "veto_source" text;--> statement-breakpoint
-- The direction a legacy relation was decided in: symmetric types read both ways; any other type
-- keeps the direction its matching metadata names when that names exactly the pair's two notes;
-- otherwise it is unknown (legacy rows only). Band, probability, keys and veto stay null.
UPDATE atomic_note_relations SET direction = CASE
  WHEN relation_type IN ('contrasts','similar_to','contradicts','same_as') THEN 'symmetric'
  WHEN lower(metadata->>'semanticSourceAtomicNoteId') = source_atomic_note_id::text
   AND lower(metadata->>'semanticTargetAtomicNoteId') = target_atomic_note_id::text THEN 'lo_to_hi'
  WHEN lower(metadata->>'semanticSourceAtomicNoteId') = target_atomic_note_id::text
   AND lower(metadata->>'semanticTargetAtomicNoteId') = source_atomic_note_id::text THEN 'hi_to_lo'
  ELSE 'unknown' END;
--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ALTER COLUMN "direction" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ALTER COLUMN "relation_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ALTER COLUMN "relation_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_pair" CHECK ("atomic_note_relations"."source_atomic_note_id" < "atomic_note_relations"."target_atomic_note_id");--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_values" CHECK ("atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo','symmetric','unknown')
        and ("atomic_note_relations"."band" is null or "atomic_note_relations"."band" in ('apply','suggest'))
        and ("atomic_note_relations"."probability" is null or "atomic_note_relations"."probability" between 0 and 1)
        and ("atomic_note_relations"."veto_source" is null or "atomic_note_relations"."veto_source" in ('explainer','typer'))
        and ("atomic_note_relations"."veto_source" is null) = ("atomic_note_relations"."vetoed_at" is null)
        and ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')));--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_v2" CHECK (("atomic_note_relations"."relation_type" is not null or "atomic_note_relations"."band" is not null)
        and ("atomic_note_relations"."direction" <> 'unknown' or "atomic_note_relations"."band" is null)
        and ("atomic_note_relations"."band" is null or (
          ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as'))
          and case when "atomic_note_relations"."relation_type" in ('supports','extends','depends_on','example_of','clarifies')
                then "atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo')
                else "atomic_note_relations"."direction" = 'symmetric' end)));--> statement-breakpoint
INSERT INTO "relations_v2_report" ("key", "value")
SELECT 'direction_' || direction, count(*) FROM atomic_note_relations GROUP BY direction
UNION ALL SELECT 'metadata_direction_disagreements', count(*) FROM atomic_note_relations
 WHERE direction IN ('lo_to_hi','hi_to_lo','unknown')
   AND (lower(metadata->>'semanticSourceAtomicNoteId'), lower(metadata->>'semanticTargetAtomicNoteId'))
       IN ((source_atomic_note_id::text, target_atomic_note_id::text),
           (target_atomic_note_id::text, source_atomic_note_id::text))
   AND direction <> CASE WHEN lower(metadata->>'semanticSourceAtomicNoteId') = source_atomic_note_id::text
                         THEN 'lo_to_hi' ELSE 'hi_to_lo' END;
--> statement-breakpoint
-- 4. Relation decisions: a score scale with a scale-aware CHECK; `accepted` and the pair-level type
-- are no longer written (the columns go in F4).
ALTER TABLE "relation_decisions" ADD COLUMN "score_scale" text DEFAULT 'probability' NOT NULL;--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_accepted";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_directions";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_types";--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_score_scale" CHECK ("relation_decisions"."score_scale" in ('probability','log_odds'));--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_directions" CHECK (("relation_decisions"."lo_to_hi_score" is not null or "relation_decisions"."hi_to_lo_score" is not null)
        and case when "relation_decisions"."score_scale" = 'log_odds' then
              "relation_decisions"."lo_to_hi_relation_type" is null and "relation_decisions"."hi_to_lo_relation_type" is null
              and ("relation_decisions"."lo_to_hi_score" is null or ("relation_decisions"."lo_to_hi_score" > '-Infinity'::float8 and "relation_decisions"."lo_to_hi_score" < 'Infinity'::float8))
              and ("relation_decisions"."hi_to_lo_score" is null or ("relation_decisions"."hi_to_lo_score" > '-Infinity'::float8 and "relation_decisions"."hi_to_lo_score" < 'Infinity'::float8))
            else
              ("relation_decisions"."lo_to_hi_score" is null) = ("relation_decisions"."lo_to_hi_relation_type" is null)
              and ("relation_decisions"."hi_to_lo_score" is null) = ("relation_decisions"."hi_to_lo_relation_type" is null)
              and coalesce("relation_decisions"."lo_to_hi_score", 0) between 0 and 1
              and coalesce("relation_decisions"."hi_to_lo_score", 0) between 0 and 1
            end);--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_types" CHECK (coalesce("relation_decisions"."lo_to_hi_relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')
        and coalesce("relation_decisions"."hi_to_lo_relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')
        and coalesce("relation_decisions"."relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related'));--> statement-breakpoint
-- 5. Source relations: every existing row was judged; promoted rows (design E) come with T53.
ALTER TABLE "source_relations" ADD COLUMN "origin" text DEFAULT 'judged' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ADD COLUMN "support_count" integer;--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT "source_relations_scores";--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT "source_relations_type";--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "importance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "confidence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_origin" CHECK ("source_relations"."origin" in ('judged','promoted')
        and ("source_relations"."origin" <> 'judged' or ("source_relations"."importance" is not null and "source_relations"."confidence" is not null))
        and ("source_relations"."origin" <> 'promoted' or ("source_relations"."support_count" is not null and "source_relations"."support_count" >= 1))
        and ("source_relations"."support_count" is null or "source_relations"."support_count" >= 1));--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_scores" CHECK (("source_relations"."importance" is null or "source_relations"."importance" between 0 and 1)
        and ("source_relations"."confidence" is null or "source_relations"."confidence" between 0 and 1));--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_type" CHECK ("source_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related'));--> statement-breakpoint
-- 6. New tables: the typing cache, per-note and per-root matching state, runs and events.
CREATE TABLE "note_match_state" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"decider_key" text NOT NULL,
	"space_key" text NOT NULL,
	"kth_cosine" real,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_match_state_values" CHECK (char_length("note_match_state"."decider_key") between 1 and 200 and char_length("note_match_state"."space_key") between 1 and 200
        and ("note_match_state"."kth_cosine" is null or "note_match_state"."kth_cosine" between -1 and 1))
);
--> statement-breakpoint
CREATE TABLE "relation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"run_id" uuid NOT NULL,
	"relation_kind" text NOT NULL,
	"relation_id" uuid,
	"pair_key" text NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_events_values" CHECK ("relation_events"."relation_kind" in ('note','source')
        and "relation_events"."kind" in ('applied','suggested','typed','untyped','vetoed','kept','removed','promoted','retired','reconciled')
        and char_length("relation_events"."pair_key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "relation_match_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"root_id" uuid,
	"decider_key" text,
	"calibration_version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "relation_match_runs_values" CHECK ("relation_match_runs"."kind" in ('match','link','type','promote','discover','review','veto','reconcile','retype')
        and ("relation_match_runs"."outcome" is null or char_length("relation_match_runs"."outcome") between 1 and 200)
        and jsonb_typeof("relation_match_runs"."counts") = 'object' and jsonb_typeof("relation_match_runs"."timings") = 'object')
);
--> statement-breakpoint
CREATE TABLE "relation_typings" (
	"pair_key" text NOT NULL,
	"typer_key" text NOT NULL,
	"lo_hash" text NOT NULL,
	"hi_hash" text NOT NULL,
	"relation_type" text NOT NULL,
	"direction" text,
	"ai_task_run_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_typings_pair_key_typer_key_pk" PRIMARY KEY("pair_key","typer_key"),
	CONSTRAINT "relation_typings_verdict" CHECK ("relation_typings"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','none')
        and case when "relation_typings"."relation_type" = 'none' then "relation_typings"."direction" is null
                 when "relation_typings"."relation_type" in ('supports','extends','depends_on','example_of','clarifies')
                   then "relation_typings"."direction" in ('lo_to_hi','hi_to_lo')
                 else "relation_typings"."direction" = 'symmetric' end
        and char_length("relation_typings"."pair_key") between 1 and 200 and char_length("relation_typings"."typer_key") between 1 and 200
        and char_length("relation_typings"."lo_hash") between 1 and 200 and char_length("relation_typings"."hi_hash") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "source_match_state" (
	"root_id" uuid PRIMARY KEY NOT NULL,
	"match_seq" bigserial NOT NULL,
	"nearest_root_id" uuid,
	"nearest_cosine" real,
	"space_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_match_state_values" CHECK (("source_match_state"."nearest_root_id" is null or "source_match_state"."nearest_root_id" <> "source_match_state"."root_id")
        and ("source_match_state"."nearest_cosine" is null or "source_match_state"."nearest_cosine" between -1 and 1)
        and char_length("source_match_state"."space_key") between 1 and 200 and char_length("source_match_state"."fingerprint") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "note_match_state" ADD CONSTRAINT "note_match_state_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_events" ADD CONSTRAINT "relation_events_run_id_relation_match_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."relation_match_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_typings" ADD CONSTRAINT "relation_typings_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_match_state" ADD CONSTRAINT "source_match_state_root_id_source_items_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_match_state" ADD CONSTRAINT "source_match_state_nearest_root_id_source_items_id_fk" FOREIGN KEY ("nearest_root_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_events_seq_uidx" ON "relation_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "relation_events_run_idx" ON "relation_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "relation_events_relation_idx" ON "relation_events" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "relation_match_runs_root_started_idx" ON "relation_match_runs" USING btree ("root_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_match_state_match_seq_uidx" ON "source_match_state" USING btree ("match_seq");--> statement-breakpoint
CREATE INDEX "source_match_state_space_nearest_idx" ON "source_match_state" USING btree ("space_key","nearest_root_id");--> statement-breakpoint
-- 7. The facts-only note fingerprint (D11): md5 of the relation ID, both endpoints, the direction,
-- the type and both notes' facts, never status, band, probability, veto or metadata. Every evidence
-- row whose stored fingerprint is the former formula's is re-keyed (`relations_v2_rekey`, which
-- holds every current one); the counts of current evidence and current source relations under the
-- new formula and currentness (note-origin evidence counts only while its note relation is applied)
-- must equal the counts before, or the migration rolls back. Every existing note relation is a
-- legacy, unvetoed row, so applied is the former "not rejected".
-- `noteRelationFingerprintSql` and `currentSourceRelationEvidenceSql` of
-- `packages/db/src/repositories/` hold the same expressions.
DO $$
DECLARE
  recomputed bigint;
  evidence_after bigint;
  relations_after bigint;
  evidence_before bigint;
  relations_before bigint;
  missing bigint;
BEGIN
  UPDATE source_relation_evidence e
     SET snapshot = jsonb_set(e.snapshot, '{noteFingerprint}', to_jsonb(md5(concat_ws('|',
           n.id::text, n.source_atomic_note_id::text, n.target_atomic_note_id::text, n.direction,
           coalesce(n.relation_type, ''),
           case when a.id = n.source_atomic_note_id
                then concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status)
                else concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status) end,
           case when a.id = n.source_atomic_note_id
                then concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)
                else concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status) end))))
    FROM relations_v2_rekey c, atomic_note_relations n, atomic_notes a, atomic_notes b
   WHERE c.id = e.id AND e.origin = 'atomic_notes' AND n.id = e.note_relation_id
     AND a.id = e.source_note_id AND b.id = e.target_note_id;
  GET DIAGNOSTICS recomputed = ROW_COUNT;

  CREATE TEMP TABLE relations_v2_current_after ON COMMIT DROP AS
  SELECT e.id, e.relation_id
    FROM source_relation_evidence e
    LEFT JOIN chunks sc ON sc.id = e.source_chunk_id
    LEFT JOIN chunks tc ON tc.id = e.target_chunk_id
    LEFT JOIN documents sd ON sd.id = sc.document_id LEFT JOIN documents td ON td.id = tc.document_id
    LEFT JOIN atomic_note_relations n ON n.id = e.note_relation_id
    LEFT JOIN atomic_notes a ON a.id = e.source_note_id
    LEFT JOIN atomic_notes b ON b.id = e.target_note_id
   WHERE (sc.id IS NOT NULL AND tc.id IS NOT NULL
     AND sd.metadata->>'supersededByDocumentId' IS NULL AND td.metadata->>'supersededByDocumentId' IS NULL
     AND sc.content_hash = e.snapshot->>'sourceHash' AND tc.content_hash = e.snapshot->>'targetHash'
     AND (e.origin = 'source_analysis' OR (n.id IS NOT NULL
       AND (n.status = 'accepted' OR (n.status = 'pending_review' AND n.vetoed_at IS NULL
            AND (n.band = 'apply' OR n.band IS NULL)))
       AND a.status NOT IN ('rejected','archived') AND b.status NOT IN ('rejected','archived')
       AND a.supersession_status = 'current' AND b.supersession_status = 'current'
       AND md5(concat_ws('|',
             n.id::text, n.source_atomic_note_id::text, n.target_atomic_note_id::text, n.direction,
             coalesce(n.relation_type, ''),
             case when a.id = n.source_atomic_note_id
                  then concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status)
                  else concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status) end,
             case when a.id = n.source_atomic_note_id
                  then concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)
                  else concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status) end))
           = e.snapshot->>'noteFingerprint')));

  SELECT count(*), count(DISTINCT relation_id) INTO evidence_after, relations_after
    FROM relations_v2_current_after;
  SELECT count(*), count(DISTINCT relation_id) INTO evidence_before, relations_before
    FROM relations_v2_current_evidence;
  SELECT count(*) INTO missing FROM relations_v2_current_evidence c
   WHERE NOT EXISTS (SELECT 1 FROM relations_v2_current_after x WHERE x.id = c.id);
  INSERT INTO relations_v2_report ("key", "value") VALUES
    ('evidence_recomputed', recomputed),
    ('current_evidence_after', evidence_after),
    ('current_source_relations_after', relations_after),
    ('current_evidence_lost', missing);
  -- 8. The report, captured by the verify script.
  RAISE NOTICE 'relations_v2 report %', (SELECT jsonb_object_agg("key", "value") FROM relations_v2_report);
  IF evidence_after <> evidence_before OR relations_after <> relations_before OR missing <> 0 THEN
    RAISE EXCEPTION 'relations_v2: current source evidence % -> %, current source relations % -> %, lost %',
      evidence_before, evidence_after, relations_before, relations_after, missing;
  END IF;
END $$;


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

-- Retrieval on indexes (F3 T49, D28). Note matching asked the library for candidates with a text
-- query that computed unaccent() and similarity() per row, and a vector query that ordered by a
-- computed alias: no index could serve either. This adds what both need.
--   * search_tsv: the weighted full-text document of a note ('simple' configuration over the
--     f_unaccent wrapper of 0053, so it is immutable), generated and stored, with a GIN index.
--   * a trigram GIN index on the unaccented title, for the title-similarity arm of the text query.
--   * one partial HNSW index per dimension table for atomic-note vectors, ordered by raw cosine
--     distance. The global HNSW indexes of 0001 and 0008 stay for the other targets.
-- The generated column rewrites atomic_notes and the HNSW builds run in the migrator's startup
-- transaction (no CONCURRENTLY). The builds need room: the graph spills to disk past
-- maintenance_work_mem, which is slow.
SET LOCAL maintenance_work_mem = '512MB';--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', f_unaccent(coalesce("title", ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(coalesce("idea_statement", ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(left(coalesce("body_markdown", ''), 4000))), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "atomic_notes_search_tsv_idx" ON "atomic_notes" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "atomic_notes_title_trgm_idx" ON "atomic_notes" USING gin (f_unaccent("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "embeddings_256_note_hnsw_idx" ON "embeddings_256" USING hnsw ("embedding" vector_cosine_ops) WHERE "embeddings_256"."target_type" = 'atomic_note';--> statement-breakpoint
CREATE INDEX "embeddings_768_note_hnsw_idx" ON "embeddings_768" USING hnsw ("embedding" vector_cosine_ops) WHERE "embeddings_768"."target_type" = 'atomic_note';--> statement-breakpoint
CREATE INDEX "embeddings_1024_note_hnsw_idx" ON "embeddings_1024" USING hnsw ("embedding" vector_cosine_ops) WHERE "embeddings_1024"."target_type" = 'atomic_note';


-- Automatic relations carry no direction (plan decision 31b). The typer reads a directed relation's
-- direction from the order the two notes are shown (0.57 accurate, against 0.85 needed), so the
-- direction it stores is kept for audit and never shown. `direction_source` says where a stored
-- direction came from: `typer` (a guess, not shown), `decider` (the Decisions decider's two
-- directional scores differ clearly) or `owner` (chosen on Keep, where `symmetric` on a directed
-- type is the owner's "no direction"). Null: a legacy row (no band; read as it was decided) or a
-- relation that reads the same both ways. Nothing is deleted or rewritten except this column;
-- every banded directed relation already stored holds a typer or generative guess, so it becomes
-- `typer`, in its row and in the images of its events. `packages/db/src/scripts/verify-relations-v2.ts`
-- checks the result. Forward only: the constraint requires a direction source on a banded directed
-- relation, which a version that predates this migration does not write, so going back to one means
-- restoring the backup taken before this migration.
ALTER TABLE "atomic_note_relations" DROP CONSTRAINT "atomic_note_relations_values";--> statement-breakpoint
ALTER TABLE "atomic_note_relations" DROP CONSTRAINT "atomic_note_relations_v2";--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "direction_source" text;--> statement-breakpoint
UPDATE "atomic_note_relations" SET "direction_source" = 'typer'
 WHERE "band" IS NOT NULL AND "direction" IN ('lo_to_hi','hi_to_lo');--> statement-breakpoint
-- The relation events keep the row before and after each automatic change, and a revert compares
-- and restores whole rows (I-R8). An image of an automatic directed relation gets the value its
-- row got, as if the column had always existed, so a run recorded before this migration still
-- reverts byte for byte.
UPDATE "relation_events" SET
  "before" = CASE WHEN "before"->>'band' IS NOT NULL AND "before"->>'direction' IN ('lo_to_hi','hi_to_lo')
                  THEN "before" || '{"direction_source": "typer"}'::jsonb ELSE "before" END,
  "after" = CASE WHEN "after"->>'band' IS NOT NULL AND "after"->>'direction' IN ('lo_to_hi','hi_to_lo')
                 THEN "after" || '{"direction_source": "typer"}'::jsonb ELSE "after" END
 WHERE "relation_kind" = 'note'
   AND (("before"->>'band' IS NOT NULL AND "before"->>'direction' IN ('lo_to_hi','hi_to_lo'))
     OR ("after"->>'band' IS NOT NULL AND "after"->>'direction' IN ('lo_to_hi','hi_to_lo')));--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_values" CHECK ("atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo','symmetric','unknown')
        and ("atomic_note_relations"."band" is null or "atomic_note_relations"."band" in ('apply','suggest'))
        and ("atomic_note_relations"."probability" is null or "atomic_note_relations"."probability" between 0 and 1)
        and ("atomic_note_relations"."veto_source" is null or "atomic_note_relations"."veto_source" in ('explainer','typer'))
        and ("atomic_note_relations"."veto_source" is null) = ("atomic_note_relations"."vetoed_at" is null)
        and ("atomic_note_relations"."direction_source" is null or "atomic_note_relations"."direction_source" in ('typer','decider','owner'))
        and ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')));--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_v2" CHECK (("atomic_note_relations"."relation_type" is not null or "atomic_note_relations"."band" is not null)
        and ("atomic_note_relations"."direction" <> 'unknown' or "atomic_note_relations"."band" is null)
        and ("atomic_note_relations"."band" is not null or "atomic_note_relations"."direction_source" is null)
        and ("atomic_note_relations"."band" is null or (
          ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as'))
          and case when "atomic_note_relations"."relation_type" in ('supports','extends','depends_on','example_of','clarifies')
                then ("atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo') and "atomic_note_relations"."direction_source" is not null)
                  or ("atomic_note_relations"."direction" = 'symmetric' and "atomic_note_relations"."direction_source" is not distinct from 'owner')
                else "atomic_note_relations"."direction" = 'symmetric' and "atomic_note_relations"."direction_source" is null end)));


-- Gardener task state (F4 T74, D5-D9). The jobs table keeps its five statuses; a job also carries
--   * scope_key: claimable kinds only (spec 3.1); two running jobs of one scope never exist
--     (jobs_running_scope_uidx), inline ingestion stage rows keep null beside their scoped parent;
--   * subject_key: the outcome cache's key with the job type;
--   * outcome (done, no_change, skipped) on a succeeded job; a succeeded job without one finished
--     before this migration (read as legacy);
--   * blocked_class, blocked_reason, blocked_at on a queued job set aside (it burns no attempt);
--   * quarantined_at on a failed job whose input failed before; input_fingerprint, the content-only
--     fingerprint it ran with.
-- gardener_outcomes is the outcome cache per (kind, subject): the last successful fingerprint and
-- the run of consecutive failed jobs. note_match_state.input_hash (MATCH, D16) is null on every
-- existing row: such a note is matched again. jobs_type_status_idx serves latestByType.
-- Queued and running jobs get their scope and subject from the kind table (running ones are queued
-- again by recoverInterrupted at the next start; a second running job of one scope, which the old
-- code allowed, keeps a null scope so the unique index can be built), and queued link and promote
-- jobs name their root as sourceItemId so cancelling or deleting the source reaches them.
-- `packages/db/src/scripts/verify-gardener-tasks.ts` checks the result. Forward only.
CREATE TABLE "gardener_outcomes" (
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"last_outcome" text NOT NULL,
	"last_fingerprint" text,
	"failed_fingerprint" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"last_job_id" uuid,
	"quarantined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gardener_outcomes_kind_subject_key_pk" PRIMARY KEY("kind","subject_key"),
	CONSTRAINT "gardener_outcomes_values" CHECK (char_length("gardener_outcomes"."kind") between 1 and 200 and char_length("gardener_outcomes"."subject_key") between 1 and 200
        and "gardener_outcomes"."last_outcome" in ('done','no_change','skipped','failed')
        and ("gardener_outcomes"."last_fingerprint" is null or char_length("gardener_outcomes"."last_fingerprint") between 1 and 200)
        and ("gardener_outcomes"."failed_fingerprint" is null or char_length("gardener_outcomes"."failed_fingerprint") between 1 and 200)
        and ("gardener_outcomes"."last_error_class" is null or char_length("gardener_outcomes"."last_error_class") between 1 and 200)
        and "gardener_outcomes"."consecutive_failures" >= 0
        and ("gardener_outcomes"."quarantined_at" is null or "gardener_outcomes"."consecutive_failures" >= 1))
);
--> statement-breakpoint
ALTER TABLE "note_match_state" DROP CONSTRAINT "note_match_state_values";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_class" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "input_fingerprint" text;--> statement-breakpoint
ALTER TABLE "note_match_state" ADD COLUMN "input_hash" text;--> statement-breakpoint
-- Topic jobs: tree:<treeId>:structure | :gate | :names; PLACE and the gate own the item they place.
UPDATE "jobs" SET
  "scope_key" = 'tree:' || ("payload"->>'treeId') || CASE
    WHEN "type" = 'topic-gate' THEN ':gate'
    WHEN "type" IN ('topic-name', 'topic-areas', 'topic-label-embed') THEN ':names'
    ELSE ':structure' END,
  "subject_key" = CASE
    WHEN "type" NOT IN ('topic-place', 'topic-gate') THEN 'tree:' || ("payload"->>'treeId')
    WHEN "payload"->>'rootSourceId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$' THEN 'root:' || ("payload"->>'rootSourceId')
    WHEN "payload"->>'noteId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$' THEN 'note:' || ("payload"->>'noteId')
    END
 WHERE "status" IN ('queued', 'running')
   AND "type" IN ('topic-place', 'topic-sweep', 'topic-gate', 'topic-rebalance', 'topic-build',
                  'topic-audit', 'topic-name', 'topic-areas', 'topic-label-embed')
   AND "payload"->>'treeId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$';--> statement-breakpoint
-- Link and promote jobs of one root: root:<rootId>, and the root as sourceItemId.
UPDATE "jobs" SET
  "scope_key" = 'root:' || ("payload"->>'rootId'),
  "subject_key" = 'root:' || ("payload"->>'rootId'),
  "payload" = CASE WHEN "payload" ? 'sourceItemId' THEN "payload"
                   ELSE "payload" || jsonb_build_object('sourceItemId', "payload"->>'rootId') END
 WHERE "status" IN ('queued', 'running')
   AND "type" IN ('relation-link', 'relation-promote')
   AND "payload"->>'rootId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$';--> statement-breakpoint
-- The global singletons, and the untyped sweep (no scope, one subject).
UPDATE "jobs" SET
  "scope_key" = CASE WHEN "type" = 'relation-retype' THEN NULL ELSE "type" END,
  "subject_key" = "type"
 WHERE "status" IN ('queued', 'running')
   AND "type" IN ('relation-composite', 'catalog-header', 'relation-retype');--> statement-breakpoint
-- An ingestion job: the hierarchy root of its source (as relation-link.ts linkRootOf finds it).
WITH RECURSIVE "up" AS (
  SELECT j."id" AS "job_id", s."id", s."parent_source_item_id", 0 AS "depth"
    FROM "jobs" j JOIN "source_items" s ON s."id"::text = j."payload"->>'sourceItemId'
   WHERE j."type" = 'ingestion' AND j."status" IN ('queued', 'running')
  UNION ALL
  SELECT "up"."job_id", p."id", p."parent_source_item_id", "up"."depth" + 1
    FROM "up" JOIN "source_items" p ON p."id" = "up"."parent_source_item_id"
   WHERE "up"."depth" < 64
), "roots" AS (
  SELECT DISTINCT ON ("job_id") "job_id", "id"::text AS "root_id"
    FROM "up" ORDER BY "job_id", "depth" DESC
)
UPDATE "jobs" j SET "scope_key" = 'root:' || r."root_id", "subject_key" = 'root:' || r."root_id"
  FROM "roots" r WHERE j."id" = r."job_id";--> statement-breakpoint
-- Two running jobs of one scope (possible before this migration): the later ones keep no scope.
UPDATE "jobs" j SET "scope_key" = NULL
  FROM (SELECT "id", row_number() OVER (PARTITION BY "scope_key" ORDER BY "locked_at" NULLS LAST, "id") AS "n"
          FROM "jobs" WHERE "status" = 'running' AND "scope_key" IS NOT NULL) d
 WHERE j."id" = d."id" AND d."n" > 1;--> statement-breakpoint
CREATE INDEX "gardener_outcomes_quarantined_idx" ON "gardener_outcomes" USING btree ("quarantined_at") WHERE "gardener_outcomes"."quarantined_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_running_scope_uidx" ON "jobs" USING btree ("scope_key") WHERE "jobs"."scope_key" is not null and "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_type_status_idx" ON "jobs" USING btree ("type","status");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_gardener" CHECK (("jobs"."scope_key" is null or char_length("jobs"."scope_key") between 1 and 200)
        and ("jobs"."subject_key" is null or char_length("jobs"."subject_key") between 1 and 200)
        and ("jobs"."input_fingerprint" is null or char_length("jobs"."input_fingerprint") between 1 and 200)
        and ("jobs"."outcome" is null or ("jobs"."outcome" in ('done','no_change','skipped') and "jobs"."status" = 'succeeded'))
        and ("jobs"."blocked_class" is null) = ("jobs"."blocked_reason" is null)
        and ("jobs"."blocked_class" is null) = ("jobs"."blocked_at" is null)
        and ("jobs"."blocked_class" is null or ("jobs"."status" = 'queued'
          and "jobs"."blocked_class" in ('paused','no_model','cap','download','waiting','offline')
          and char_length("jobs"."blocked_reason") between 1 and 64))
        and ("jobs"."quarantined_at" is null or "jobs"."status" = 'failed'));--> statement-breakpoint
ALTER TABLE "note_match_state" ADD CONSTRAINT "note_match_state_values" CHECK (char_length("note_match_state"."decider_key") between 1 and 200 and char_length("note_match_state"."space_key") between 1 and 200
        and ("note_match_state"."kth_cosine" is null or "note_match_state"."kth_cosine" between -1 and 1)
        and ("note_match_state"."input_hash" is null or char_length("note_match_state"."input_hash") between 1 and 200));


-- F4 D14 (T76): the RemoteBudget's columns on the AI audit. Every new column is nullable, so rows written
-- before 0061 keep reading as unknown; the partial index serves the monthly ledger of background remote
-- spend (background rows, and the unclassified P2/P3 rows written before this migration).
ALTER TABLE "ai_task_runs" ADD COLUMN "budget_class" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "budget_estimate_usd" double precision;--> statement-breakpoint
CREATE INDEX "ai_task_runs_budget_ledger_idx" ON "ai_task_runs" USING btree ("started_at") WHERE "ai_task_runs"."lane" like 'remote:%' and ("ai_task_runs"."budget_class" = 'background' or ("ai_task_runs"."budget_class" is null and "ai_task_runs"."priority" between 2 and 3));--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_budget_class" CHECK (("ai_task_runs"."budget_class" is null or "ai_task_runs"."budget_class" in ('user','background','interactive'))
        and ("ai_task_runs"."budget_estimate_usd" is null or "ai_task_runs"."budget_estimate_usd" >= 0));
