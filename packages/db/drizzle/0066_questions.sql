CREATE TABLE "question_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"paragraphs" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "question_answers_question_id_version_unique" UNIQUE("question_id","version"),
	CONSTRAINT "question_answers_version" CHECK ("question_answers"."version" >= 1),
	CONSTRAINT "question_answers_status" CHECK ("question_answers"."status" in ('complete','canceled','failed'))
);
--> statement-breakpoint
CREATE TABLE "question_citations" (
	"answer_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"anchor" jsonb,
	"content_hash" text NOT NULL,
	CONSTRAINT "question_citations_answer_id_ordinal_pk" PRIMARY KEY("answer_id","ordinal"),
	CONSTRAINT "question_citations_ordinal" CHECK ("question_citations"."ordinal" >= 1),
	CONSTRAINT "question_citations_kind" CHECK ("question_citations"."target_kind" in ('note','source','topic','chunk'))
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"language" varchar(16) DEFAULT 'und' NOT NULL,
	"scope" jsonb DEFAULT '{"kind":"library"}'::jsonb NOT NULL,
	"privacy" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"error_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent("questions"."text"))) STORED,
	CONSTRAINT "questions_text" CHECK (char_length("questions"."text") between 1 and 2000),
	CONSTRAINT "questions_mode" CHECK ("questions"."mode" in ('text','hybrid')),
	CONSTRAINT "questions_status" CHECK ("questions"."status" in ('running','complete','canceled','failed'))
);
--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_citations" ADD CONSTRAINT "question_citations_answer_id_question_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."question_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_citations_target_idx" ON "question_citations" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "questions_search_tsv_idx" ON "questions" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "questions_text_trgm_idx" ON "questions" USING gin (f_unaccent("text") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "questions_created_at_idx" ON "questions" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
