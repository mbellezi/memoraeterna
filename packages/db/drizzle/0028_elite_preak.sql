CREATE TABLE "obsidian_projection_clock" (
	"id" integer PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obsidian_projection_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memora_id" uuid NOT NULL,
	"revision_id" text NOT NULL,
	"binding_hash" text NOT NULL,
	"relative_path" text NOT NULL,
	"content" text NOT NULL,
	"editable_hash" text NOT NULL,
	"generated_hash" text NOT NULL,
	"rendered_hash" text NOT NULL,
	"base_hash" text,
	"before_content" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "obsidian_projection_target_idx" ON "obsidian_projection_revisions" USING btree ("memora_id","created_at");--> statement-breakpoint
CREATE INDEX "obsidian_projection_pending_idx" ON "obsidian_projection_revisions" USING btree ("status");--> statement-breakpoint
INSERT INTO obsidian_projection_clock(id,generation) VALUES(1,1);
--> statement-breakpoint
CREATE FUNCTION invalidate_obsidian_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE obsidian_projection_clock SET generation=generation+1 WHERE id=1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['wiki_pages','wiki_dependencies','source_items','documents','chunks','atomic_notes','atomic_note_relations','atomic_note_source_links','source_relations','source_relation_evidence','source_spans','document_revisions','bibliographic_works','bibliographic_instances','source_item_bibliographic_links'] LOOP
    EXECUTE format('CREATE TRIGGER obsidian_projection_dirty AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION invalidate_obsidian_projection()', target);
  END LOOP;
END $$;
