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