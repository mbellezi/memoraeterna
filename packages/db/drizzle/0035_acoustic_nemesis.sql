CREATE TABLE "automatic_routine_bindings" (
	"policy_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"preset_version" text NOT NULL,
	"schedule_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automatic_routine_calls" (
	"organization_run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"period" text NOT NULL,
	"tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automatic_routine_bindings" ADD CONSTRAINT "automatic_routine_bindings_schedule_id_maintenance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."maintenance_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatic_routine_calls" ADD CONSTRAINT "automatic_routine_calls_organization_run_id_organization_runs_id_fk" FOREIGN KEY ("organization_run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automatic_routine_calls" ADD CONSTRAINT "automatic_routine_calls_run_id_maintenance_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_routine_binding_identity_idx" ON "automatic_routine_bindings" USING btree ("policy_id","kind","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_routine_binding_schedule_idx" ON "automatic_routine_bindings" USING btree ("schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_routine_call_identity_idx" ON "automatic_routine_calls" USING btree ("organization_run_id","sequence");--> statement-breakpoint
CREATE INDEX "automatic_routine_call_policy_period_idx" ON "automatic_routine_calls" USING btree ("policy_id","period");