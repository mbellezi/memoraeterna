-- Legacy drop (F4 D35, spec 3.17): the pre-refactoring wiki, organization, curator, maintenance,
-- routine and impact tables leave the schema. Nothing reads or writes them any more (F2 D5 detached
-- them, D40 fenced them, and the legacy wipe emptied the owner's profile). The 30 tables go with
-- CASCADE (their foreign keys, indexes and the fence triggers on seven of them go with them), then
-- the fence function. `relation_decisions` loses the pair-level `accepted` and `relation_type` that
-- F3 D12 stopped writing (its type check keeps the two directions), and `atomic_note_evolution`
-- loses `run_id`, whose foreign key 0052 dropped and whose target table no longer exists. A profile
-- restored from a backup taken before the wipe loses its legacy rows (F2 D37). Not reversible: going
-- back means restoring a backup. `packages/db/src/scripts/verify-legacy-drop.ts` checks it
-- (`npm run db:legacy-drop:verify`).
DROP TABLE "automatic_routine_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "automatic_routine_calls" CASCADE;--> statement-breakpoint
DROP TABLE "knowledge_impact_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "knowledge_impact_events" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_budget_reservations" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_decisions" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_occurrences" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_receipts" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_runs" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_schedules" CASCADE;--> statement-breakpoint
DROP TABLE "maintenance_steps" CASCADE;--> statement-breakpoint
DROP TABLE "organization_proposals" CASCADE;--> statement-breakpoint
DROP TABLE "organization_receipts" CASCADE;--> statement-breakpoint
DROP TABLE "organization_runs" CASCADE;--> statement-breakpoint
DROP TABLE "organization_settings_activations" CASCADE;--> statement-breakpoint
DROP TABLE "organization_settings_revisions" CASCADE;--> statement-breakpoint
DROP TABLE "organization_steps" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_dependencies" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_evidence" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_group_receipts" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_investigation_evaluations" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_investigations" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_memberships" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_page_revisions" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_pages" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_policy_activations" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_policy_revisions" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_section_assessments" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_source_coverage" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_toc_groups" CASCADE;--> statement-breakpoint
DROP FUNCTION legacy_insert_fence();--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_types";--> statement-breakpoint
DROP INDEX "atomic_note_evolution_run_idx";--> statement-breakpoint
ALTER TABLE "atomic_note_evolution" DROP COLUMN "run_id";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP COLUMN "relation_type";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP COLUMN "accepted";--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_types" CHECK (coalesce("relation_decisions"."lo_to_hi_relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')
        and coalesce("relation_decisions"."hi_to_lo_relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related'));