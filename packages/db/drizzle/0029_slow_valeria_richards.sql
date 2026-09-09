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
