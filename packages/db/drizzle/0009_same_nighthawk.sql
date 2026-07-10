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