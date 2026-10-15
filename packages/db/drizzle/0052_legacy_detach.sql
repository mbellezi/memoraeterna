ALTER TYPE "public"."obsidian_sync_status" ADD VALUE 'retired';--> statement-breakpoint
ALTER TABLE "atomic_note_evolution" DROP CONSTRAINT "atomic_note_evolution_run_id_organization_runs_id_fk";
--> statement-breakpoint
-- Legacy detach (F2 D5): the legacy wiki impact feed leaves the ingestion hot path. Every row stays.
DROP TRIGGER wiki_source_impact ON source_items;
--> statement-breakpoint
DROP TRIGGER wiki_document_impact ON documents;
--> statement-breakpoint
DROP TRIGGER wiki_chunk_impact ON chunks;
--> statement-breakpoint
DROP TRIGGER wiki_note_impact ON atomic_notes;
--> statement-breakpoint
DROP TRIGGER wiki_note_links_impact ON atomic_note_source_links;
--> statement-breakpoint
DROP TRIGGER wiki_note_relation_impact ON atomic_note_relations;
--> statement-breakpoint
DROP TRIGGER wiki_relation_impact ON source_relations;
--> statement-breakpoint
DROP TRIGGER wiki_relation_evidence_impact ON source_relation_evidence;
--> statement-breakpoint
DROP TRIGGER wiki_summary_impact ON source_summaries;
--> statement-breakpoint
DROP TRIGGER wiki_entity_impact ON entities;
--> statement-breakpoint
DROP TRIGGER wiki_mention_impact ON entity_mentions;
--> statement-breakpoint
DROP TRIGGER wiki_section_impact ON wiki_pages;
--> statement-breakpoint
DROP TRIGGER wiki_enroll_impact ON knowledge_impact_events;
--> statement-breakpoint
DROP TRIGGER wiki_source_insert_impact ON source_items;
--> statement-breakpoint
DROP TRIGGER wiki_document_insert_impact ON documents;
--> statement-breakpoint
DROP TRIGGER wiki_chunk_insert_impact ON chunks;
--> statement-breakpoint
DROP TRIGGER wiki_note_insert_impact ON atomic_notes;
--> statement-breakpoint
DROP TRIGGER wiki_summary_insert_impact ON source_summaries;
--> statement-breakpoint
DROP TRIGGER wiki_entity_insert_impact ON entities;
--> statement-breakpoint
DROP TRIGGER wiki_mention_insert_impact ON entity_mentions;
--> statement-breakpoint
DROP TRIGGER wiki_note_relation_insert_impact ON atomic_note_relations;
--> statement-breakpoint
DROP TRIGGER wiki_investigation_impact_enroll ON knowledge_impact_events;
--> statement-breakpoint
DROP FUNCTION wiki_record_impact();
--> statement-breakpoint
DROP FUNCTION wiki_record_section_impact();
--> statement-breakpoint
DROP FUNCTION wiki_enroll_impact();
--> statement-breakpoint
DROP FUNCTION wiki_enroll_investigation_impact();
--> statement-breakpoint
-- Legacy insert fence (F2 D40): code that still writes legacy content (an older build on this
-- database, or a stray writer) fails closed instead of re-creating the wiki or starting curator work.
-- Only test seeders set memora.legacy_fixture, on scratch databases.
CREATE FUNCTION legacy_insert_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('memora.legacy_fixture', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'legacy.errors.retired';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON wiki_pages FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON organization_runs FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON organization_settings_revisions FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON maintenance_runs FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON maintenance_schedules FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON wiki_policy_revisions FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
--> statement-breakpoint
CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON wiki_investigations FOR EACH ROW EXECUTE FUNCTION legacy_insert_fence();
