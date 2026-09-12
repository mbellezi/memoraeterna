CREATE OR REPLACE FUNCTION wiki_enroll_investigation_impact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation)
 SELECT NEW.id,'investigation',i.id::text,NEW.fingerprint||':'||i.policy_revision_id::text
 FROM wiki_investigations i WHERE i.state IN ('followed','paused','awaiting_evidence')
 AND NEW.created_at>=i.created_at
 AND (coalesce(jsonb_array_length(i.input->'sourceIds'),0)=0 OR NEW.source_ids ?| ARRAY(SELECT jsonb_array_elements_text(i.input->'sourceIds'))
 OR coalesce((i.input->>'includeDescendants')::boolean,false) AND EXISTS(
 WITH RECURSIVE ancestors AS (
  SELECT id,parent_source_item_id FROM source_items WHERE NEW.source_ids ? id::text
  UNION SELECT p.id,p.parent_source_item_id FROM source_items p JOIN ancestors a ON p.id=a.parent_source_item_id
 ) SELECT 1 FROM ancestors WHERE i.input->'sourceIds' ? id::text)
 OR EXISTS(SELECT 1 FROM wiki_dependencies d JOIN wiki_pages p ON p.current_revision_id=d.revision_id WHERE p.id=i.answer_page_id AND d.kind=NEW.kind AND d.input_id=NEW.input_id))
 AND NOT EXISTS(SELECT 1 FROM wiki_investigation_evaluations e WHERE e.investigation_id=i.id AND e.run_id=NEW.causal_run_id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
