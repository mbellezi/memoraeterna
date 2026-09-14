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
 -- Page review is an editorial acknowledgment, not a new semantic input.
 -- Preserve the revision and review flag without invalidating consumers.
 -- Administrative pin/order/current membership revision pointers are not semantic inputs.
 IF (old_content-'sections'-'pinned'-'position'-'parentId'-'automatic'-'review') IS DISTINCT FROM (new_content-'sections'-'pinned'-'position'-'parentId'-'automatic'-'review') OR
    ((old_content->'automatic')-'memberships'-'placementProtected') IS DISTINCT FROM ((new_content->'automatic')-'memberships'-'placementProtected') OR
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(old_content->'automatic'->'memberships','[]'))) IS DISTINCT FROM
    (SELECT coalesce(jsonb_agg(value-'expectedPageRevisionId'-'placementProtected'-'order'),'[]') FROM jsonb_array_elements(coalesce(new_content->'automatic'->'memberships','[]'))) THEN
   INSERT INTO knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids,causal_run_id,causal_group_id) VALUES('wiki_page',NEW.id,'update',md5((new_content-'pinned'-'position'-'parentId')::text),sources,nullif(current_setting('memora.causal_run_id',true),'')::uuid,nullif(current_setting('memora.causal_group_id',true),'')::uuid);
   UPDATE wiki_dependencies SET stale_reason='wiki_page_update',changed_at=clock_timestamp() WHERE kind='wiki_page' AND input_id=NEW.id AND stale_reason IS NULL;
 END IF;
 RETURN NEW;
END $$;
