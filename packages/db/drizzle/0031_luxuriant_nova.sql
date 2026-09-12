CREATE TABLE "wiki_group_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"targets" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_policy_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_policy_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_section_assessments" (
	"section_revision_id" uuid PRIMARY KEY NOT NULL,
	"section_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"assessment" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_toc_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "management" text DEFAULT 'human_managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "toc_owner_kind" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "toc_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_group_receipts" ADD CONSTRAINT "wiki_group_receipts_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_memberships" ADD CONSTRAINT "wiki_memberships_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_memberships" ADD CONSTRAINT "wiki_memberships_group_id_wiki_toc_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wiki_toc_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_policy_activations" ADD CONSTRAINT "wiki_policy_activations_revision_id_wiki_policy_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_assessments" ADD CONSTRAINT "wiki_section_assessments_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_toc_groups" ADD CONSTRAINT "wiki_toc_groups_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_toc_groups" ADD CONSTRAINT "wiki_toc_groups_revision_id_wiki_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_group_receipt_run_idx" ON "wiki_group_receipts" USING btree ("run_id","group_id");--> statement-breakpoint
CREATE INDEX "wiki_membership_order_idx" ON "wiki_memberships" USING btree ("group_id","position","id");--> statement-breakpoint
CREATE INDEX "wiki_membership_target_idx" ON "wiki_memberships" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "wiki_policy_activation_lookup_idx" ON "wiki_policy_activations" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE INDEX "wiki_toc_page_idx" ON "wiki_toc_groups" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_toc_owner_idx" ON "wiki_pages" USING btree ("role","toc_owner_kind","toc_owner_id");--> statement-breakpoint
-- Conservative classification does not rewrite immutable historical snapshots or activate work.
UPDATE wiki_pages p SET management='ai_managed'
FROM wiki_page_revisions r WHERE r.id=p.current_revision_id AND r.origin='organization'
AND r.content->>'review'='draft' AND NOT EXISTS (
 SELECT 1 FROM jsonb_array_elements(r.content->'sections') s WHERE coalesce((s->>'protected')::boolean,true)
);
