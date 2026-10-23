-- Gardener task state (F4 T74, D5-D9). The jobs table keeps its five statuses; a job also carries
--   * scope_key: claimable kinds only (spec 3.1); two running jobs of one scope never exist
--     (jobs_running_scope_uidx), inline ingestion stage rows keep null beside their scoped parent;
--   * subject_key: the outcome cache's key with the job type;
--   * outcome (done, no_change, skipped) on a succeeded job; a succeeded job without one finished
--     before this migration (read as legacy);
--   * blocked_class, blocked_reason, blocked_at on a queued job set aside (it burns no attempt);
--   * quarantined_at on a failed job whose input failed before; input_fingerprint, the content-only
--     fingerprint it ran with.
-- gardener_outcomes is the outcome cache per (kind, subject): the last successful fingerprint and
-- the run of consecutive failed jobs. note_match_state.input_hash (MATCH, D16) is null on every
-- existing row: such a note is matched again. jobs_type_status_idx serves latestByType.
-- Queued and running jobs get their scope and subject from the kind table (running ones are queued
-- again by recoverInterrupted at the next start; a second running job of one scope, which the old
-- code allowed, keeps a null scope so the unique index can be built), and queued link and promote
-- jobs name their root as sourceItemId so cancelling or deleting the source reaches them.
-- `packages/db/src/scripts/verify-gardener-tasks.ts` checks the result. Forward only.
CREATE TABLE "gardener_outcomes" (
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"last_outcome" text NOT NULL,
	"last_fingerprint" text,
	"failed_fingerprint" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"last_job_id" uuid,
	"quarantined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gardener_outcomes_kind_subject_key_pk" PRIMARY KEY("kind","subject_key"),
	CONSTRAINT "gardener_outcomes_values" CHECK (char_length("gardener_outcomes"."kind") between 1 and 200 and char_length("gardener_outcomes"."subject_key") between 1 and 200
        and "gardener_outcomes"."last_outcome" in ('done','no_change','skipped','failed')
        and ("gardener_outcomes"."last_fingerprint" is null or char_length("gardener_outcomes"."last_fingerprint") between 1 and 200)
        and ("gardener_outcomes"."failed_fingerprint" is null or char_length("gardener_outcomes"."failed_fingerprint") between 1 and 200)
        and ("gardener_outcomes"."last_error_class" is null or char_length("gardener_outcomes"."last_error_class") between 1 and 200)
        and "gardener_outcomes"."consecutive_failures" >= 0
        and ("gardener_outcomes"."quarantined_at" is null or "gardener_outcomes"."consecutive_failures" >= 1))
);
--> statement-breakpoint
ALTER TABLE "note_match_state" DROP CONSTRAINT "note_match_state_values";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_class" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "input_fingerprint" text;--> statement-breakpoint
ALTER TABLE "note_match_state" ADD COLUMN "input_hash" text;--> statement-breakpoint
-- Topic jobs: tree:<treeId>:structure | :gate | :names; PLACE and the gate own the item they place.
UPDATE "jobs" SET
  "scope_key" = 'tree:' || ("payload"->>'treeId') || CASE
    WHEN "type" = 'topic-gate' THEN ':gate'
    WHEN "type" IN ('topic-name', 'topic-areas', 'topic-label-embed') THEN ':names'
    ELSE ':structure' END,
  "subject_key" = CASE
    WHEN "type" NOT IN ('topic-place', 'topic-gate') THEN 'tree:' || ("payload"->>'treeId')
    WHEN "payload"->>'rootSourceId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$' THEN 'root:' || ("payload"->>'rootSourceId')
    WHEN "payload"->>'noteId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$' THEN 'note:' || ("payload"->>'noteId')
    END
 WHERE "status" IN ('queued', 'running')
   AND "type" IN ('topic-place', 'topic-sweep', 'topic-gate', 'topic-rebalance', 'topic-build',
                  'topic-audit', 'topic-name', 'topic-areas', 'topic-label-embed')
   AND "payload"->>'treeId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$';--> statement-breakpoint
-- Link and promote jobs of one root: root:<rootId>, and the root as sourceItemId.
UPDATE "jobs" SET
  "scope_key" = 'root:' || ("payload"->>'rootId'),
  "subject_key" = 'root:' || ("payload"->>'rootId'),
  "payload" = CASE WHEN "payload" ? 'sourceItemId' THEN "payload"
                   ELSE "payload" || jsonb_build_object('sourceItemId', "payload"->>'rootId') END
 WHERE "status" IN ('queued', 'running')
   AND "type" IN ('relation-link', 'relation-promote')
   AND "payload"->>'rootId' ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$';--> statement-breakpoint
-- The global singletons, and the untyped sweep (no scope, one subject).
UPDATE "jobs" SET
  "scope_key" = CASE WHEN "type" = 'relation-retype' THEN NULL ELSE "type" END,
  "subject_key" = "type"
 WHERE "status" IN ('queued', 'running')
   AND "type" IN ('relation-composite', 'catalog-header', 'relation-retype');--> statement-breakpoint
-- An ingestion job: the hierarchy root of its source (as relation-link.ts linkRootOf finds it).
WITH RECURSIVE "up" AS (
  SELECT j."id" AS "job_id", s."id", s."parent_source_item_id", 0 AS "depth"
    FROM "jobs" j JOIN "source_items" s ON s."id"::text = j."payload"->>'sourceItemId'
   WHERE j."type" = 'ingestion' AND j."status" IN ('queued', 'running')
  UNION ALL
  SELECT "up"."job_id", p."id", p."parent_source_item_id", "up"."depth" + 1
    FROM "up" JOIN "source_items" p ON p."id" = "up"."parent_source_item_id"
   WHERE "up"."depth" < 64
), "roots" AS (
  SELECT DISTINCT ON ("job_id") "job_id", "id"::text AS "root_id"
    FROM "up" ORDER BY "job_id", "depth" DESC
)
UPDATE "jobs" j SET "scope_key" = 'root:' || r."root_id", "subject_key" = 'root:' || r."root_id"
  FROM "roots" r WHERE j."id" = r."job_id";--> statement-breakpoint
-- Two running jobs of one scope (possible before this migration): the later ones keep no scope.
UPDATE "jobs" j SET "scope_key" = NULL
  FROM (SELECT "id", row_number() OVER (PARTITION BY "scope_key" ORDER BY "locked_at" NULLS LAST, "id") AS "n"
          FROM "jobs" WHERE "status" = 'running' AND "scope_key" IS NOT NULL) d
 WHERE j."id" = d."id" AND d."n" > 1;--> statement-breakpoint
CREATE INDEX "gardener_outcomes_quarantined_idx" ON "gardener_outcomes" USING btree ("quarantined_at") WHERE "gardener_outcomes"."quarantined_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_running_scope_uidx" ON "jobs" USING btree ("scope_key") WHERE "jobs"."scope_key" is not null and "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_type_status_idx" ON "jobs" USING btree ("type","status");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_gardener" CHECK (("jobs"."scope_key" is null or char_length("jobs"."scope_key") between 1 and 200)
        and ("jobs"."subject_key" is null or char_length("jobs"."subject_key") between 1 and 200)
        and ("jobs"."input_fingerprint" is null or char_length("jobs"."input_fingerprint") between 1 and 200)
        and ("jobs"."outcome" is null or ("jobs"."outcome" in ('done','no_change','skipped') and "jobs"."status" = 'succeeded'))
        and ("jobs"."blocked_class" is null) = ("jobs"."blocked_reason" is null)
        and ("jobs"."blocked_class" is null) = ("jobs"."blocked_at" is null)
        and ("jobs"."blocked_class" is null or ("jobs"."status" = 'queued'
          and "jobs"."blocked_class" in ('paused','no_model','cap','download','waiting','offline')
          and char_length("jobs"."blocked_reason") between 1 and 64))
        and ("jobs"."quarantined_at" is null or "jobs"."status" = 'failed'));--> statement-breakpoint
ALTER TABLE "note_match_state" ADD CONSTRAINT "note_match_state_values" CHECK (char_length("note_match_state"."decider_key") between 1 and 200 and char_length("note_match_state"."space_key") between 1 and 200
        and ("note_match_state"."kth_cosine" is null or "note_match_state"."kth_cosine" between -1 and 1)
        and ("note_match_state"."input_hash" is null or char_length("note_match_state"."input_hash") between 1 and 200));
