DROP INDEX "knowledge_impact_delivery_generation_idx";--> statement-breakpoint
ALTER TABLE "knowledge_impact_deliveries" ADD COLUMN "consumer_key" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_impact_delivery_generation_idx" ON "knowledge_impact_deliveries" USING btree ("event_id","consumer","consumer_key","input_generation");--> statement-breakpoint
CREATE FUNCTION wiki_enroll_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
    SELECT NEW.id,'curator',a.policy_id::text,NEW.fingerprint||':'||a.revision_id::text
    FROM (SELECT DISTINCT ON(policy_id) policy_id,revision_id,state FROM wiki_policy_activations ORDER BY policy_id,created_at DESC,id DESC) a
    JOIN wiki_policy_revisions p ON p.id=a.revision_id
    WHERE a.state IN('enabled','paused') AND p.policy->'triggers' ? 'input_changed'
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_enroll_impact AFTER INSERT ON knowledge_impact_events FOR EACH ROW EXECUTE FUNCTION wiki_enroll_impact();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wiki_record_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object_id uuid; data jsonb; before_data jsonb; input_kind text:=TG_ARGV[0]; sources jsonb;
BEGIN
 data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 before_data:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 sources:=CASE WHEN input_kind='source' THEN jsonb_build_array(data->'id') WHEN data ? 'source_item_id' THEN jsonb_build_array(data->'source_item_id') WHEN data ? 'created_from_source_item_id' THEN jsonb_build_array(data->'created_from_source_item_id') ELSE '[]'::jsonb END;
 IF data ? 'target_source_item_id' THEN sources:=sources||jsonb_build_array(data->'target_source_item_id'); END IF;
 data:=data-'updated_at'-'created_at';before_data:=before_data-'updated_at'-'created_at';
 IF input_kind='source' THEN
  data:=jsonb_build_object('id',data->'id','title',data->'title','subtitle',data->'subtitle','type',data->'type','source_uri',data->'source_uri','parent_source_item_id',data->'parent_source_item_id','descriptor',data->'metadata'->'descriptor');
  before_data:=jsonb_build_object('id',before_data->'id','title',before_data->'title','subtitle',before_data->'subtitle','type',before_data->'type','source_uri',before_data->'source_uri','parent_source_item_id',before_data->'parent_source_item_id','descriptor',before_data->'metadata'->'descriptor');
 END IF;
 IF TG_OP='UPDATE' AND data=before_data THEN RETURN NEW; END IF;
 object_id:=(data->>coalesce(TG_ARGV[1],'id'))::uuid;
 INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id)
 VALUES(input_kind,object_id,lower(TG_OP),md5(data::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
 UPDATE wiki_dependencies SET stale_reason=input_kind||'_'||lower(TG_OP),changed_at=clock_timestamp() WHERE kind=input_kind AND input_id=object_id AND stale_reason IS NULL;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER wiki_source_insert_impact AFTER INSERT ON source_items FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('source');
CREATE TRIGGER wiki_document_insert_impact AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('document');
CREATE TRIGGER wiki_chunk_insert_impact AFTER INSERT ON chunks FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('chunk');
CREATE TRIGGER wiki_note_insert_impact AFTER INSERT ON atomic_notes FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('atomic_note');
CREATE TRIGGER wiki_summary_insert_impact AFTER INSERT ON source_summaries FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('summary');
CREATE TRIGGER wiki_entity_insert_impact AFTER INSERT ON entities FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity');
CREATE TRIGGER wiki_mention_insert_impact AFTER INSERT ON entity_mentions FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('entity_mention');
CREATE TRIGGER wiki_note_relation_insert_impact AFTER INSERT ON atomic_note_relations FOR EACH ROW EXECUTE FUNCTION wiki_record_impact('note_relation');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wiki_record_section_impact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_section jsonb; new_section jsonb; old_content jsonb; new_content jsonb; sources jsonb; section_key uuid;
BEGIN
 IF OLD.current_revision_id IS NOT DISTINCT FROM NEW.current_revision_id THEN RETURN NEW; END IF;
 SELECT content INTO old_content FROM wiki_page_revisions WHERE id=OLD.current_revision_id;
 SELECT content INTO new_content FROM wiki_page_revisions WHERE id=NEW.current_revision_id;
 SELECT coalesce(jsonb_agg(DISTINCT source_item_id),'[]') INTO sources FROM wiki_evidence WHERE page_id=NEW.id;
 FOR section_key IN SELECT (value->>'id')::uuid FROM jsonb_array_elements(coalesce(old_content->'sections','[]')||coalesce(new_content->'sections','[]')) GROUP BY value->>'id' LOOP
  SELECT value INTO old_section FROM jsonb_array_elements(coalesce(old_content->'sections','[]')) WHERE value->>'id'=section_key::text;
  SELECT value INTO new_section FROM jsonb_array_elements(coalesce(new_content->'sections','[]')) WHERE value->>'id'=section_key::text;
  IF old_section IS DISTINCT FROM new_section THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_section',section_key,CASE WHEN old_section IS NULL THEN 'insert' WHEN new_section IS NULL THEN 'delete' ELSE 'update' END,md5(coalesce(new_section::text,'deleted')),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_section_update',changed_at=clock_timestamp() WHERE kind='wiki_section' AND input_id=section_key AND stale_reason IS NULL;
  END IF;
 END LOOP;
 -- Administrative pin/order/current membership revision pointers are not semantic inputs.
 IF (old_content-'sections'-'pinned'-'position'-'parentId'-'automatic') IS DISTINCT FROM (new_content-'sections'-'pinned'-'position'-'parentId'-'automatic') OR
    (old_content->'automatic'-'memberships'-'placementProtected') IS DISTINCT FROM (new_content->'automatic'-'memberships'-'placementProtected') OR
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(old_content->'automatic'->'memberships','[]'))) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(new_content->'automatic'->'memberships','[]'))) THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_page',NEW.id,'update',md5((new_content-'pinned'-'position'-'parentId')::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_page_update',changed_at=clock_timestamp() WHERE kind='wiki_page' AND input_id=NEW.id AND stale_reason IS NULL;
 END IF;
 RETURN NEW;
END $$;
