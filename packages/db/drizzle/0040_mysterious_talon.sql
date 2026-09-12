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