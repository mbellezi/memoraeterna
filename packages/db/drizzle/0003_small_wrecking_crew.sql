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