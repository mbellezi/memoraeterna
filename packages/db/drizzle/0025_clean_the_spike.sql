CREATE TABLE "knowledge_impact_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"input_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"input_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"stale_reason" text,
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wiki_dependencies" ADD CONSTRAINT "wiki_dependencies_revision_id_wiki_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."wiki_page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_impact_events_pending_idx" ON "knowledge_impact_events" USING btree ("consumed_at","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_impact_events_input_idx" ON "knowledge_impact_events" USING btree ("kind","input_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_dependencies_consumer_idx" ON "wiki_dependencies" USING btree ("revision_id","section_id","kind","input_id");--> statement-breakpoint
CREATE INDEX "wiki_dependencies_input_idx" ON "wiki_dependencies" USING btree ("kind","input_id");--> statement-breakpoint
CREATE INDEX "wiki_dependencies_revision_idx" ON "wiki_dependencies" USING btree ("revision_id");--> statement-breakpoint
-- Transactional invalidation observes all canonical writers, including cascades.
CREATE FUNCTION wiki_record_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object_id uuid; data jsonb; before_data jsonb; input_kind text := TG_ARGV[0];
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  before_data := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  -- Administrative timestamps alone are not an evidence change.
  data := data - 'updated_at' - 'created_at';
  before_data := before_data - 'updated_at' - 'created_at';
  IF input_kind='source' THEN
    data := jsonb_build_object('id',data->'id','title',data->'title','subtitle',data->'subtitle','type',data->'type','source_uri',data->'source_uri','parent_source_item_id',data->'parent_source_item_id','descriptor',data->'metadata'->'descriptor');
    before_data := jsonb_build_object('id',before_data->'id','title',before_data->'title','subtitle',before_data->'subtitle','type',before_data->'type','source_uri',before_data->'source_uri','parent_source_item_id',before_data->'parent_source_item_id','descriptor',before_data->'metadata'->'descriptor');
  END IF;
  IF TG_OP='UPDATE' AND data=before_data THEN RETURN NEW; END IF;
  object_id := (data->>coalesce(TG_ARGV[1],'id'))::uuid;
  INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint)
    VALUES(input_kind,object_id,lower(TG_OP),md5(data::text));
  UPDATE wiki_dependencies SET stale_reason=input_kind||'_'||lower(TG_OP),changed_at=clock_timestamp()
    WHERE kind=input_kind AND input_id=object_id AND stale_reason IS NULL;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_source_impact AFTER UPDATE OR DELETE ON source_items FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('source');
--> statement-breakpoint
CREATE TRIGGER wiki_document_impact AFTER UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('document');
--> statement-breakpoint
CREATE TRIGGER wiki_chunk_impact AFTER UPDATE OR DELETE ON chunks FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('chunk');
--> statement-breakpoint
CREATE TRIGGER wiki_note_impact AFTER UPDATE OR DELETE ON atomic_notes FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('atomic_note');
--> statement-breakpoint
CREATE TRIGGER wiki_note_links_impact AFTER INSERT OR UPDATE OR DELETE ON atomic_note_source_links FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('atomic_note','atomic_note_id');
--> statement-breakpoint
CREATE TRIGGER wiki_note_relation_impact AFTER UPDATE OR DELETE ON atomic_note_relations FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('note_relation');
--> statement-breakpoint
CREATE TRIGGER wiki_relation_impact AFTER INSERT OR UPDATE OR DELETE ON source_relations FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('source_relation');
--> statement-breakpoint
CREATE TRIGGER wiki_relation_evidence_impact AFTER INSERT OR UPDATE OR DELETE ON source_relation_evidence FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('relation_evidence');
--> statement-breakpoint
CREATE TRIGGER wiki_summary_impact AFTER UPDATE OR DELETE ON source_summaries FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('summary');
--> statement-breakpoint
CREATE TRIGGER wiki_entity_impact AFTER UPDATE OR DELETE ON entities FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity');
--> statement-breakpoint
CREATE TRIGGER wiki_mention_impact AFTER UPDATE OR DELETE ON entity_mentions FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity_mention');
--> statement-breakpoint
-- Backfill direct section dependencies for immutable M1/M2 history.
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT r.id,(sec->>'id')::uuid,v.kind,v.input_id,e.snapshot->>'contentHash',e.snapshot
FROM wiki_page_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.content->'sections') sec
JOIN wiki_evidence e ON e.page_id=r.page_id AND sec->'evidenceIds' ? e.id::text
CROSS JOIN LATERAL (VALUES ('source',e.source_item_id),('document',e.document_id),('chunk',e.chunk_id)) v(kind,input_id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- M2 preloaded interpretations were all mandatory reads; retain their precise occurrence.
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT receipt.revision_id,(sec->>'id')::uuid,v.kind,v.input_id,rel->>'fingerprint',rel
FROM organization_receipts receipt JOIN organization_runs run ON run.id=receipt.run_id
JOIN wiki_page_revisions rev ON rev.id=receipt.revision_id
CROSS JOIN LATERAL jsonb_array_elements(rev.content->'sections') sec
CROSS JOIN LATERAL jsonb_array_elements(run.snapshot->'relations') rel
CROSS JOIN LATERAL (VALUES ('source_relation',(rel->>'id')::uuid),('relation_evidence',(rel->>'evidenceId')::uuid)) v(kind,input_id)
WHERE EXISTS (SELECT 1 FROM organization_proposals p CROSS JOIN LATERAL jsonb_array_elements(p.proposal->'sections') op WHERE p.run_id=run.id AND op->>'markdown' IS NOT NULL AND (op->>'sectionId'=sec->>'id' OR (op->>'sectionId' IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.snapshot->'baseContent'->'sections') base WHERE base->>'id'=sec->>'id'))))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION wiki_record_section_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_section jsonb; new_section jsonb; old_content jsonb; new_content jsonb;
BEGIN
  IF OLD.current_revision_id IS NOT DISTINCT FROM NEW.current_revision_id THEN RETURN NEW; END IF;
  SELECT content INTO old_content FROM wiki_page_revisions WHERE id=OLD.current_revision_id;
  SELECT content INTO new_content FROM wiki_page_revisions WHERE id=NEW.current_revision_id;
  FOR old_section IN SELECT value FROM jsonb_array_elements(coalesce(old_content->'sections','[]'::jsonb)) LOOP
    SELECT value INTO new_section FROM jsonb_array_elements(coalesce(new_content->'sections','[]'::jsonb)) WHERE value->>'id'=old_section->>'id';
    IF old_section IS DISTINCT FROM new_section THEN
      INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint) VALUES('wiki_section',(old_section->>'id')::uuid,'update',md5(coalesce(new_section::text,'deleted')));
      UPDATE wiki_dependencies SET stale_reason='wiki_section_update',changed_at=clock_timestamp() WHERE kind='wiki_section' AND input_id=(old_section->>'id')::uuid AND stale_reason IS NULL;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_section_impact AFTER UPDATE ON wiki_pages FOR EACH ROW EXECUTE FUNCTION wiki_record_section_impact();
--> statement-breakpoint
-- Include indirect M2 note-derived occurrence inputs, even when the row itself never changes.
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT dep.revision_id,dep.section_id,v.kind,v.input_id,dep.fingerprint,dep.snapshot
FROM wiki_dependencies dep JOIN source_relation_evidence e ON e.id=dep.input_id AND dep.kind='relation_evidence'
CROSS JOIN LATERAL (VALUES ('atomic_note',e.source_note_id),('atomic_note',e.target_note_id),('note_relation',e.note_relation_id),('chunk',e.source_chunk_id),('chunk',e.target_chunk_id)) v(kind,input_id)
WHERE v.input_id IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO wiki_dependencies(revision_id,section_id,kind,input_id,fingerprint,snapshot)
SELECT dep.revision_id,dep.section_id,'document',c.document_id,dep.fingerprint,dep.snapshot FROM wiki_dependencies dep JOIN chunks c ON c.id=dep.input_id AND dep.kind='chunk' ON CONFLICT DO NOTHING;
