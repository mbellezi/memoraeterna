-- Automatic relations carry no direction (plan decision 31b). The typer reads a directed relation's
-- direction from the order the two notes are shown (0.57 accurate, against 0.85 needed), so the
-- direction it stores is kept for audit and never shown. `direction_source` says where a stored
-- direction came from: `typer` (a guess, not shown), `decider` (the Decisions decider's two
-- directional scores differ clearly) or `owner` (chosen on Keep, where `symmetric` on a directed
-- type is the owner's "no direction"). Null: a legacy row (no band; read as it was decided) or a
-- relation that reads the same both ways. Nothing is deleted or rewritten except this column;
-- every banded directed relation already stored holds a typer or generative guess, so it becomes
-- `typer`, in its row and in the images of its events. `packages/db/src/scripts/verify-relations-v2.ts`
-- checks the result.
ALTER TABLE "atomic_note_relations" DROP CONSTRAINT "atomic_note_relations_values";--> statement-breakpoint
ALTER TABLE "atomic_note_relations" DROP CONSTRAINT "atomic_note_relations_v2";--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "direction_source" text;--> statement-breakpoint
UPDATE "atomic_note_relations" SET "direction_source" = 'typer'
 WHERE "band" IS NOT NULL AND "direction" IN ('lo_to_hi','hi_to_lo');--> statement-breakpoint
-- The relation events keep the row before and after each automatic change, and a revert compares
-- and restores whole rows (I-R8). An image of an automatic directed relation gets the value its
-- row got, as if the column had always existed, so a run recorded before this migration still
-- reverts byte for byte.
UPDATE "relation_events" SET
  "before" = CASE WHEN "before"->>'band' IS NOT NULL AND "before"->>'direction' IN ('lo_to_hi','hi_to_lo')
                  THEN "before" || '{"direction_source": "typer"}'::jsonb ELSE "before" END,
  "after" = CASE WHEN "after"->>'band' IS NOT NULL AND "after"->>'direction' IN ('lo_to_hi','hi_to_lo')
                 THEN "after" || '{"direction_source": "typer"}'::jsonb ELSE "after" END
 WHERE "relation_kind" = 'note'
   AND (("before"->>'band' IS NOT NULL AND "before"->>'direction' IN ('lo_to_hi','hi_to_lo'))
     OR ("after"->>'band' IS NOT NULL AND "after"->>'direction' IN ('lo_to_hi','hi_to_lo')));--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_values" CHECK ("atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo','symmetric','unknown')
        and ("atomic_note_relations"."band" is null or "atomic_note_relations"."band" in ('apply','suggest'))
        and ("atomic_note_relations"."probability" is null or "atomic_note_relations"."probability" between 0 and 1)
        and ("atomic_note_relations"."veto_source" is null or "atomic_note_relations"."veto_source" in ('explainer','typer'))
        and ("atomic_note_relations"."veto_source" is null) = ("atomic_note_relations"."vetoed_at" is null)
        and ("atomic_note_relations"."direction_source" is null or "atomic_note_relations"."direction_source" in ('typer','decider','owner'))
        and ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')));--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_v2" CHECK (("atomic_note_relations"."relation_type" is not null or "atomic_note_relations"."band" is not null)
        and ("atomic_note_relations"."direction" <> 'unknown' or "atomic_note_relations"."band" is null)
        and ("atomic_note_relations"."band" is not null or "atomic_note_relations"."direction_source" is null)
        and ("atomic_note_relations"."band" is null or (
          ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as'))
          and case when "atomic_note_relations"."relation_type" in ('supports','extends','depends_on','example_of','clarifies')
                then ("atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo') and "atomic_note_relations"."direction_source" is not null)
                  or ("atomic_note_relations"."direction" = 'symmetric' and "atomic_note_relations"."direction_source" is not distinct from 'owner')
                else "atomic_note_relations"."direction" = 'symmetric' and "atomic_note_relations"."direction_source" is null end)));
