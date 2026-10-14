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