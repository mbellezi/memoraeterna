CREATE TABLE "wiki_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_span_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"number" integer NOT NULL,
	"origin" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"current_revision_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_pages_not_self_parent" CHECK ("wiki_pages"."parent_id" is distinct from "wiki_pages"."id")
);
--> statement-breakpoint
ALTER TABLE "wiki_evidence" ADD CONSTRAINT "wiki_evidence_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_parent_id_wiki_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_evidence_page_chunk_idx" ON "wiki_evidence" USING btree ("page_id","chunk_id");--> statement-breakpoint
CREATE INDEX "wiki_evidence_source_idx" ON "wiki_evidence" USING btree ("source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_page_revisions_number_idx" ON "wiki_page_revisions" USING btree ("page_id","number");--> statement-breakpoint
CREATE INDEX "wiki_pages_parent_position_idx" ON "wiki_pages" USING btree ("parent_id","position");