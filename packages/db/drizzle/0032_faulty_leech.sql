CREATE TABLE "knowledge_impact_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"input_generation" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_until" timestamp with time zone,
	"defer_until" timestamp with time zone,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_impact_delivery_state_check" CHECK ("knowledge_impact_deliveries"."status" in ('pending','leased','deferred','acknowledged')),
	CONSTRAINT "knowledge_impact_delivery_receipt_check" CHECK ("knowledge_impact_deliveries"."status"<>'acknowledged' or "knowledge_impact_deliveries"."receipt" is not null)
);
--> statement-breakpoint
CREATE TABLE "wiki_source_coverage" (
	"policy_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_source_coverage_policy_id_source_id_pk" PRIMARY KEY("policy_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_impact_events" ADD COLUMN "source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_impact_events" ADD COLUMN "causal_run_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_impact_events" ADD COLUMN "causal_group_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_impact_deliveries" ADD CONSTRAINT "knowledge_impact_deliveries_event_id_knowledge_impact_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."knowledge_impact_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_source_coverage" ADD CONSTRAINT "wiki_source_coverage_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_impact_delivery_generation_idx" ON "knowledge_impact_deliveries" USING btree ("event_id","consumer","input_generation");--> statement-breakpoint
CREATE INDEX "knowledge_impact_delivery_pending_idx" ON "knowledge_impact_deliveries" USING btree ("consumer","status","defer_until");--> statement-breakpoint
CREATE INDEX "wiki_source_coverage_state_idx" ON "wiki_source_coverage" USING btree ("policy_id","status");