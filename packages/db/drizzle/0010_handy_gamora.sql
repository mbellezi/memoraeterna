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