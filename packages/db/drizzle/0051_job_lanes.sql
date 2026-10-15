ALTER TABLE "jobs" ADD COLUMN "lane" text DEFAULT 'heavy' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "jobs_lane_queue_idx" ON "jobs" USING btree ("lane","priority" DESC NULLS FIRST,"run_after") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_queued_uidx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lane" CHECK ("jobs"."lane" in ('heavy','light'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dedupe_key" CHECK ("jobs"."dedupe_key" is null or char_length("jobs"."dedupe_key") between 1 and 200);