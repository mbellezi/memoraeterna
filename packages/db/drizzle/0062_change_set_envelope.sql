-- Change-sets of every store, read through one view (F4 D10, D11, D17, D19, D29; spec 3.4).
-- Relation passes become change-sets: a title key and parameters (null: the kind's default key),
-- a risk, the owner's verdict when a pass waits for review, when it was reverted, and the job that
-- ran it (no foreign key: pruning old jobs never touches a run). Overviews gain a version and the
-- Divergences kept beside the prose; `topic_overview_versions` keeps the text each write replaced
-- (undo) and the proposals that wait for the owner. `gardener_findings` holds AUDIT's findings and
-- the backlog and budget Inbox items. The `change_sets` view unions the topic engine's change-sets,
-- the finished relation passes that changed something (human review and veto passes excluded) and
-- the overview writes; every store keeps its own undo. Existing rows keep their values: a pass
-- reads `low` with no title, review or revert time (a pass reverted before this migration keeps an
-- unknown revert time), and an overview is version 1 with no Divergence. Additive only: going back
-- drops the view, the two tables and the new columns. `packages/db/src/scripts/verify-change-sets.ts`
-- checks it (`npm run db:changes:verify`).
CREATE TABLE "gardener_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"object_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "gardener_findings_values" CHECK ("gardener_findings"."kind" in ('duplicate','broken_link','redirect_chain','backlog','budget')
        and char_length("gardener_findings"."fingerprint") between 1 and 200
        and jsonb_typeof("gardener_findings"."object_refs") = 'array' and jsonb_array_length("gardener_findings"."object_refs") <= 50
        and jsonb_typeof("gardener_findings"."params") = 'object'
        and "gardener_findings"."risk" in ('low','medium','high')
        and "gardener_findings"."status" in ('open','dismissed','resolved')
        and ("gardener_findings"."status" = 'open') = ("gardener_findings"."closed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "topic_overview_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"title_key" text NOT NULL,
	"title_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text DEFAULT 'low' NOT NULL,
	"base_version" integer NOT NULL,
	"version" integer,
	"undo_of" uuid,
	"job_id" uuid,
	"previous" jsonb,
	"proposed" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	CONSTRAINT "topic_overview_versions_origin" CHECK ("topic_overview_versions"."origin" in ('write','patch','rewrite','undo')
        and ("topic_overview_versions"."origin" = 'undo') = ("topic_overview_versions"."undo_of" is not null)),
	CONSTRAINT "topic_overview_versions_status" CHECK ("topic_overview_versions"."status" in ('applied','undone','pending_review','dismissed')
        and ("topic_overview_versions"."status" in ('applied','undone')) = ("topic_overview_versions"."version" is not null)
        and ("topic_overview_versions"."status" in ('applied','undone')) = ("topic_overview_versions"."applied_at" is not null)
        and ("topic_overview_versions"."status" = 'undone') = ("topic_overview_versions"."undone_at" is not null)
        and ("topic_overview_versions"."status" <> 'pending_review' or "topic_overview_versions"."proposed" is not null)),
	CONSTRAINT "topic_overview_versions_values" CHECK ("topic_overview_versions"."risk" in ('low','medium','high') and "topic_overview_versions"."base_version" >= 0
        and ("topic_overview_versions"."version" is null or "topic_overview_versions"."version" > "topic_overview_versions"."base_version")
        and char_length("topic_overview_versions"."title_key") between 1 and 200 and jsonb_typeof("topic_overview_versions"."title_params") = 'object'
        and ("topic_overview_versions"."previous" is null or jsonb_typeof("topic_overview_versions"."previous") = 'object')
        and ("topic_overview_versions"."proposed" is null or jsonb_typeof("topic_overview_versions"."proposed") = 'object'))
);
--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD COLUMN "title_key" text;--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD COLUMN "title_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD COLUMN "risk" text DEFAULT 'low' NOT NULL;--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "topic_overviews" ADD COLUMN "divergences" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_overviews" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_overview_versions" ADD CONSTRAINT "topic_overview_versions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_overview_versions" ADD CONSTRAINT "topic_overview_versions_undo_of_topic_overview_versions_id_fk" FOREIGN KEY ("undo_of") REFERENCES "public"."topic_overview_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gardener_findings_kind_fingerprint_uidx" ON "gardener_findings" USING btree ("kind","fingerprint");--> statement-breakpoint
CREATE INDEX "gardener_findings_open_idx" ON "gardener_findings" USING btree ("created_at") WHERE "gardener_findings"."status" = 'open';--> statement-breakpoint
CREATE INDEX "topic_overview_versions_topic_created_idx" ON "topic_overview_versions" USING btree ("topic_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topic_overview_versions_created_idx" ON "topic_overview_versions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_overview_versions_version_uidx" ON "topic_overview_versions" USING btree ("topic_id","version") WHERE "topic_overview_versions"."version" is not null;--> statement-breakpoint
CREATE INDEX "topic_overview_versions_undo_idx" ON "topic_overview_versions" USING btree ("undo_of") WHERE "topic_overview_versions"."undo_of" is not null;--> statement-breakpoint
CREATE INDEX "relation_match_runs_started_idx" ON "relation_match_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "topic_change_sets_created_idx" ON "topic_change_sets" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "relation_match_runs" ADD CONSTRAINT "relation_match_runs_change_set" CHECK (("relation_match_runs"."title_key" is null or char_length("relation_match_runs"."title_key") between 1 and 200)
        and jsonb_typeof("relation_match_runs"."title_params") = 'object'
        and "relation_match_runs"."risk" in ('low','medium','high')
        and ("relation_match_runs"."review_status" is null or "relation_match_runs"."review_status" in ('pending_review','kept','dismissed'))
        and ("relation_match_runs"."undone_at" is null or "relation_match_runs"."outcome" = 'reverted'));--> statement-breakpoint
ALTER TABLE "topic_overviews" ADD CONSTRAINT "topic_overviews_version" CHECK ("topic_overviews"."version" >= 1 and jsonb_typeof("topic_overviews"."divergences") = 'array'
        and jsonb_array_length("topic_overviews"."divergences") <= 40);--> statement-breakpoint
-- `undo` is what the store can tell without reading later work: a topic change-set or a relation
-- pass reads `available` until the repository checks later change-sets on the same objects; an
-- overview write is `blocked` once the overview was written again. `at` is when it was made.
CREATE VIEW "change_sets" AS
SELECT 'topic'::text AS "kind", cs."id", cs."title_key", cs."title_params", cs."risk", cs."status",
       cs."origin", cs."tree_id" AS "subject_id", cs."job_id", cs."created_at" AS "at", cs."undone_at",
       CASE WHEN cs."status" = 'applied' AND cs."origin" NOT IN ('build', 'undo') THEN 'available'
            ELSE 'unavailable' END AS "undo"
  FROM "topic_change_sets" cs
UNION ALL
SELECT 'relation'::text, r."id", coalesce(r."title_key", 'changes.titles.relation.' || r."kind"),
       r."title_params", r."risk",
       CASE WHEN r."review_status" = 'pending_review' THEN 'pending_review'
            WHEN r."review_status" = 'dismissed' THEN 'dismissed'
            WHEN r."outcome" = 'reverted' THEN 'undone'
            ELSE 'applied' END,
       r."kind", r."root_id", r."job_id", r."started_at", r."undone_at",
       CASE WHEN r."outcome" IS DISTINCT FROM 'reverted'
             AND (r."review_status" IS NULL OR r."review_status" = 'kept') THEN 'available'
            ELSE 'unavailable' END
  FROM "relation_match_runs" r
 WHERE r."kind" NOT IN ('review', 'veto') AND r."finished_at" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "relation_events" e WHERE e."run_id" = r."id")
UNION ALL
SELECT 'overview'::text, v."id", v."title_key", v."title_params", v."risk", v."status", v."origin",
       v."topic_id", v."job_id", v."created_at", v."undone_at",
       CASE WHEN v."status" <> 'applied' OR v."origin" = 'undo' OR v."previous" IS NULL THEN 'unavailable'
            WHEN o."version" = v."version" THEN 'available'
            ELSE 'blocked' END
  FROM "topic_overview_versions" v
  LEFT JOIN "topic_overviews" o ON o."topic_id" = v."topic_id";