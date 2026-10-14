-- Decision 13: generated atomic notes are active at birth; review is optional and never a gate.
-- A value added to an enum cannot be used in the transaction that adds it, and every pending
-- migration runs in one transaction, so the type is rebuilt with the new value instead.
ALTER TABLE "atomic_notes" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."atomic_note_status" RENAME TO "atomic_note_status_old";--> statement-breakpoint
CREATE TYPE "public"."atomic_note_status" AS ENUM('active', 'pending_review', 'approved', 'rejected', 'archived');--> statement-breakpoint
ALTER TABLE "atomic_notes" ALTER COLUMN "status" TYPE "public"."atomic_note_status" USING "status"::text::"public"."atomic_note_status";--> statement-breakpoint
ALTER TABLE "atomic_note_review_events" ALTER COLUMN "previous_status" TYPE "public"."atomic_note_status" USING "previous_status"::text::"public"."atomic_note_status";--> statement-breakpoint
ALTER TABLE "atomic_note_review_events" ALTER COLUMN "next_status" TYPE "public"."atomic_note_status" USING "next_status"::text::"public"."atomic_note_status";--> statement-breakpoint
ALTER TABLE "atomic_notes" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
DROP TYPE "public"."atomic_note_status_old";--> statement-breakpoint
-- Generated notes nobody reviewed become active. Discarded, approved, archived, human-edited
-- (protected) notes and notes with an edit in their audit keep their status. The wiki impact
-- trigger is off for this one statement: it is a relabeling, not a change of evidence.
ALTER TABLE "atomic_notes" DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE "atomic_notes" SET "status" = 'active'
WHERE "status" = 'pending_review'
  AND "metadata"->>'humanProtected' IS DISTINCT FROM 'true'
  AND NOT EXISTS (
    SELECT 1 FROM "atomic_note_review_events" e
    WHERE e."atomic_note_id" = "atomic_notes"."id" AND e."action" = 'edit'
  );--> statement-breakpoint
ALTER TABLE "atomic_notes" ENABLE TRIGGER USER;
