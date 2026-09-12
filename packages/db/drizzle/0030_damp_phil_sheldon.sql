CREATE TABLE "prompt_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" text NOT NULL,
	"scope" text NOT NULL,
	"domain_id" uuid,
	"fields" jsonb NOT NULL,
	"origin" text NOT NULL,
	"legacy" jsonb,
	"legacy_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_revisions_scope_check" CHECK ("prompt_revisions"."scope" in ('global','function','domain','domain_function') and (("prompt_revisions"."scope" in ('domain','domain_function')) = ("prompt_revisions"."domain_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "prompt_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"composition_hash" text NOT NULL,
	"sample_passed" boolean DEFAULT false NOT NULL,
	"audit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "prompt_compositions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_activations" ADD CONSTRAINT "prompt_activations_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_validations" ADD CONSTRAINT "prompt_validations_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_activations_revision_idx" ON "prompt_activations" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "prompt_revisions_leaf_idx" ON "prompt_revisions" USING btree ("prompt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_revisions_legacy_idx" ON "prompt_revisions" USING btree ("legacy_key");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_validations_composition_idx" ON "prompt_validations" USING btree ("revision_id","composition_hash");
--> statement-breakpoint
-- Pin source-free catalog templates transactionally when a job is admitted.
-- Existing jobs intentionally retain their legacy shipped-template reader.
CREATE FUNCTION pin_job_prompt_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inherited jsonb;
BEGIN
 IF NOT (NEW.payload ? 'promptPin') THEN
   IF NEW.payload ? 'ingestionRunId' THEN
     SELECT j.payload->'promptPin' INTO inherited FROM ingestion_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id::text=NEW.payload->>'ingestionRunId';
   END IF;
   inherited := coalesce(inherited,(SELECT value->'default' FROM settings WHERE key='prompts.active'));
   IF inherited IS NOT NULL THEN NEW.payload := NEW.payload || jsonb_build_object('promptPin',inherited); END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_pin_prompt_catalog BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION pin_job_prompt_catalog();
