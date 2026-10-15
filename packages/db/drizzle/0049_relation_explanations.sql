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