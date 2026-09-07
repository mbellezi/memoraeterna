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