CREATE TABLE "wiki_investigation_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"composition_hash" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"previous" jsonb,
	"snapshot" jsonb NOT NULL,
	"run_id" uuid,
	"changed_understanding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_investigations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"identity" text NOT NULL,
	"question" text NOT NULL,
	"answer_page_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"input" jsonb NOT NULL,
	"current" jsonb NOT NULL,
	"last_input_fingerprint" text,
	"gaps" jsonb NOT NULL,
	"attention" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_investigation_state_check" CHECK ("wiki_investigations"."state" in ('followed','paused','resolved','awaiting_evidence'))
);
--> statement-breakpoint
ALTER TABLE "wiki_investigation_evaluations" ADD CONSTRAINT "wiki_investigation_evaluations_investigation_id_wiki_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."wiki_investigations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_investigation_evaluations" ADD CONSTRAINT "wiki_investigation_evaluations_run_id_organization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."organization_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_investigations" ADD CONSTRAINT "wiki_investigations_answer_page_id_wiki_pages_id_fk" FOREIGN KEY ("answer_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_investigations" ADD CONSTRAINT "wiki_investigations_policy_revision_id_wiki_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."wiki_policy_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_investigation_evaluation_identity_idx" ON "wiki_investigation_evaluations" USING btree ("investigation_id","input_fingerprint","composition_hash");--> statement-breakpoint
CREATE INDEX "wiki_investigation_evaluation_history_idx" ON "wiki_investigation_evaluations" USING btree ("investigation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_investigation_request_idx" ON "wiki_investigations" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_investigation_identity_idx" ON "wiki_investigations" USING btree ("identity");--> statement-breakpoint
CREATE INDEX "wiki_investigation_policy_state_idx" ON "wiki_investigations" USING btree ("policy_id","state");--> statement-breakpoint
CREATE FUNCTION wiki_enroll_investigation_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
 SELECT NEW.id,'investigation',i.id::text,NEW.fingerprint||':'||i.policy_revision_id::text
 FROM wiki_investigations i WHERE i.state IN ('followed','paused','awaiting_evidence')
 AND NEW.created_at>=i.created_at
 AND (coalesce(jsonb_array_length(i.input->'sourceIds'),0)=0 OR NEW.source_ids ?| ARRAY(SELECT jsonb_array_elements_text(i.input->'sourceIds'))
 OR EXISTS(SELECT 1 FROM wiki_dependencies d JOIN wiki_pages p ON p.current_revision_id=d.revision_id WHERE p.id=i.answer_page_id AND d.kind=NEW.kind AND d.input_id=NEW.input_id))
 AND NOT EXISTS(SELECT 1 FROM wiki_investigation_evaluations e WHERE e.investigation_id=i.id AND e.run_id=NEW.causal_run_id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_investigation_impact_enroll AFTER INSERT ON knowledge_impact_events FOR EACH ROW EXECUTE FUNCTION wiki_enroll_investigation_impact();
