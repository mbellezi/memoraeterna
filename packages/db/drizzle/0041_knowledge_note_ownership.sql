-- Legacy notes retain their original lifecycle; reviewed knowledge notes do not.
ALTER TABLE atomic_notes DISABLE TRIGGER USER;
--> statement-breakpoint
UPDATE atomic_notes SET owning_source_item_id=created_from_source_item_id,owning_chunk_id=evidence_chunk_id WHERE ownership='source';
--> statement-breakpoint
ALTER TABLE atomic_notes ENABLE TRIGGER USER;
--> statement-breakpoint
ALTER TABLE atomic_notes ADD CONSTRAINT atomic_notes_ownership_check CHECK ((ownership='source' AND owning_source_item_id=created_from_source_item_id AND owning_chunk_id=evidence_chunk_id AND owning_source_item_id IS NOT NULL AND owning_chunk_id IS NOT NULL) OR (ownership='knowledge' AND owning_source_item_id IS NULL AND owning_chunk_id IS NULL));
--> statement-breakpoint
CREATE FUNCTION memora_note_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ownership='source' THEN
  NEW.owning_source_item_id:=NEW.created_from_source_item_id;
  NEW.owning_chunk_id:=NEW.evidence_chunk_id;
 ELSE
  NEW.owning_source_item_id:=NULL;
  NEW.owning_chunk_id:=NULL;
 END IF;
 IF TG_OP='INSERT' OR NEW.created_from_source_item_id IS DISTINCT FROM OLD.created_from_source_item_id OR NEW.evidence_chunk_id IS DISTINCT FROM OLD.evidence_chunk_id THEN
  IF NOT EXISTS(SELECT 1 FROM chunks WHERE id=NEW.evidence_chunk_id AND source_item_id=NEW.created_from_source_item_id) THEN RAISE EXCEPTION 'organization.errors.evidence'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.ownership='knowledge' AND NEW.ownership<>'knowledge' THEN RAISE EXCEPTION 'organization.errors.evidence'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER atomic_notes_ownership BEFORE INSERT OR UPDATE ON atomic_notes FOR EACH ROW EXECUTE FUNCTION memora_note_ownership();
