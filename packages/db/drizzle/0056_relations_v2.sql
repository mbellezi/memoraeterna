-- Relations v2 (F3 T48; docs/f3-decisions.md D8-D12, D14, D20, D27). Note relations keep their pair
-- once (source < target by UUID) with an explicit direction; automation's band, probability and veto
-- stay apart from the human review status; relation decisions record their score scale; source
-- relations may be promoted (no scores, a support count); typing cache, matching state, runs and
-- events; and the source-evidence note fingerprint hashes facts only. Nothing is deleted and no
-- `metadata` is rewritten: every relation keeps its meaning, and its direction wherever the decided
-- metadata names its pair. `packages/db/src/scripts/verify-relations-v2.ts` checks the result.
--
-- 1. Guards: nothing below may lose or merge a relation. The canonical CHECKs would also refuse a
-- self pair or an unknown type; the guards say why.
DO $$
DECLARE
  self_pairs bigint;
  collisions bigint;
  unknown_types text;
BEGIN
  SELECT count(*) INTO self_pairs FROM atomic_note_relations
   WHERE source_atomic_note_id = target_atomic_note_id;
  IF self_pairs > 0 THEN
    RAISE EXCEPTION 'relations_v2: % note relation(s) link a note to itself', self_pairs;
  END IF;
  SELECT count(*) INTO collisions FROM atomic_note_relations r
    JOIN atomic_note_relations s ON s.source_atomic_note_id = r.target_atomic_note_id
                                AND s.target_atomic_note_id = r.source_atomic_note_id
   WHERE r.source_atomic_note_id > r.target_atomic_note_id;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'relations_v2: % note relation(s) are stored in both orders; sorting them would merge relations', collisions;
  END IF;
  SELECT string_agg(DISTINCT coalesce(relation_type, '<null>'), ', ') INTO unknown_types
    FROM atomic_note_relations
   WHERE relation_type IS NULL OR relation_type NOT IN ('supports','contrasts','extends','similar_to',
     'depends_on','clarifies','mentions','related','contradicts','example_of','same_as');
  IF unknown_types IS NOT NULL THEN
    RAISE EXCEPTION 'relations_v2: note relations with types outside the vocabulary: %', unknown_types;
  END IF;
END $$;
--> statement-breakpoint
-- 2. Pre-counts (the report) and the source evidence that is current under the former fingerprint
-- and currentness rules, inlined as they stood before this migration.
CREATE TEMP TABLE "relations_v2_report" ("key" text PRIMARY KEY, "value" bigint NOT NULL) ON COMMIT DROP;
--> statement-breakpoint
CREATE TEMP TABLE "relations_v2_current_evidence" ON COMMIT DROP AS
SELECT e.id, e.relation_id, e.origin
  FROM source_relation_evidence e
  LEFT JOIN chunks sc ON sc.id = e.source_chunk_id
  LEFT JOIN chunks tc ON tc.id = e.target_chunk_id
  LEFT JOIN documents sd ON sd.id = sc.document_id LEFT JOIN documents td ON td.id = tc.document_id
  LEFT JOIN atomic_note_relations n ON n.id = e.note_relation_id
  LEFT JOIN atomic_notes a ON a.id = e.source_note_id
  LEFT JOIN atomic_notes b ON b.id = e.target_note_id
 WHERE (sc.id IS NOT NULL AND tc.id IS NOT NULL
   AND sd.metadata->>'supersededByDocumentId' IS NULL AND td.metadata->>'supersededByDocumentId' IS NULL
   AND sc.content_hash = e.snapshot->>'sourceHash' AND tc.content_hash = e.snapshot->>'targetHash'
   AND (e.origin = 'source_analysis' OR (n.id IS NOT NULL AND n.status <> 'rejected'
     AND a.status NOT IN ('rejected','archived') AND b.status NOT IN ('rejected','archived')
     AND a.supersession_status = 'current' AND b.supersession_status = 'current'
     AND md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
       least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
             concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
       greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))
         = e.snapshot->>'noteFingerprint')));
--> statement-breakpoint
INSERT INTO "relations_v2_report" ("key", "value")
SELECT 'note_relations_' || status::text, count(*) FROM atomic_note_relations GROUP BY status
UNION ALL SELECT 'note_relations', count(*) FROM atomic_note_relations
UNION ALL SELECT 'metadata_names_pair', count(*) FROM atomic_note_relations
 WHERE (lower(metadata->>'semanticSourceAtomicNoteId'), lower(metadata->>'semanticTargetAtomicNoteId'))
       IN ((source_atomic_note_id::text, target_atomic_note_id::text),
           (target_atomic_note_id::text, source_atomic_note_id::text))
UNION ALL SELECT 'swapped', count(*) FROM atomic_note_relations
 WHERE source_atomic_note_id > target_atomic_note_id
UNION ALL SELECT 'source_relations', count(*) FROM source_relations
UNION ALL SELECT 'source_evidence', count(*) FROM source_relation_evidence
UNION ALL SELECT 'current_evidence_before', count(*) FROM relations_v2_current_evidence
UNION ALL SELECT 'current_source_relations_before', count(DISTINCT relation_id) FROM relations_v2_current_evidence;
--> statement-breakpoint
-- 3. The canonical pair. Sorting swaps the endpoint columns of any row stored high-to-low (none
-- expected: the upsert always sorted lowercase UUIDs, whose text order is PostgreSQL's uuid order).
UPDATE atomic_note_relations
   SET source_atomic_note_id = target_atomic_note_id, target_atomic_note_id = source_atomic_note_id
 WHERE source_atomic_note_id > target_atomic_note_id;
--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "band" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "probability" real;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "decider_key" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "typer_key" text;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "vetoed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD COLUMN "veto_source" text;--> statement-breakpoint
-- The direction a legacy relation was decided in: symmetric types read both ways; any other type
-- keeps the direction its matching metadata names when that names exactly the pair's two notes;
-- otherwise it is unknown (legacy rows only). Band, probability, keys and veto stay null.
UPDATE atomic_note_relations SET direction = CASE
  WHEN relation_type IN ('contrasts','similar_to','contradicts','same_as') THEN 'symmetric'
  WHEN lower(metadata->>'semanticSourceAtomicNoteId') = source_atomic_note_id::text
   AND lower(metadata->>'semanticTargetAtomicNoteId') = target_atomic_note_id::text THEN 'lo_to_hi'
  WHEN lower(metadata->>'semanticSourceAtomicNoteId') = target_atomic_note_id::text
   AND lower(metadata->>'semanticTargetAtomicNoteId') = source_atomic_note_id::text THEN 'hi_to_lo'
  ELSE 'unknown' END;
--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ALTER COLUMN "direction" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ALTER COLUMN "relation_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ALTER COLUMN "relation_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_pair" CHECK ("atomic_note_relations"."source_atomic_note_id" < "atomic_note_relations"."target_atomic_note_id");--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_values" CHECK ("atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo','symmetric','unknown')
        and ("atomic_note_relations"."band" is null or "atomic_note_relations"."band" in ('apply','suggest'))
        and ("atomic_note_relations"."probability" is null or "atomic_note_relations"."probability" between 0 and 1)
        and ("atomic_note_relations"."veto_source" is null or "atomic_note_relations"."veto_source" in ('explainer','typer'))
        and ("atomic_note_relations"."veto_source" is null) = ("atomic_note_relations"."vetoed_at" is null)
        and ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')));--> statement-breakpoint
ALTER TABLE "atomic_note_relations" ADD CONSTRAINT "atomic_note_relations_v2" CHECK (("atomic_note_relations"."relation_type" is not null or "atomic_note_relations"."band" is not null)
        and ("atomic_note_relations"."direction" <> 'unknown' or "atomic_note_relations"."band" is null)
        and ("atomic_note_relations"."band" is null or (
          ("atomic_note_relations"."relation_type" is null or "atomic_note_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as'))
          and case when "atomic_note_relations"."relation_type" in ('supports','extends','depends_on','example_of','clarifies')
                then "atomic_note_relations"."direction" in ('lo_to_hi','hi_to_lo')
                else "atomic_note_relations"."direction" = 'symmetric' end)));--> statement-breakpoint
INSERT INTO "relations_v2_report" ("key", "value")
SELECT 'direction_' || direction, count(*) FROM atomic_note_relations GROUP BY direction
UNION ALL SELECT 'metadata_direction_disagreements', count(*) FROM atomic_note_relations
 WHERE direction IN ('lo_to_hi','hi_to_lo','unknown')
   AND (lower(metadata->>'semanticSourceAtomicNoteId'), lower(metadata->>'semanticTargetAtomicNoteId'))
       IN ((source_atomic_note_id::text, target_atomic_note_id::text),
           (target_atomic_note_id::text, source_atomic_note_id::text))
   AND direction <> CASE WHEN lower(metadata->>'semanticSourceAtomicNoteId') = source_atomic_note_id::text
                         THEN 'lo_to_hi' ELSE 'hi_to_lo' END;
--> statement-breakpoint
-- 4. Relation decisions: a score scale with a scale-aware CHECK; `accepted` and the pair-level type
-- are no longer written (the columns go in F4).
ALTER TABLE "relation_decisions" ADD COLUMN "score_scale" text DEFAULT 'probability' NOT NULL;--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_accepted";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_directions";--> statement-breakpoint
ALTER TABLE "relation_decisions" DROP CONSTRAINT "relation_decisions_types";--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_score_scale" CHECK ("relation_decisions"."score_scale" in ('probability','log_odds'));--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_directions" CHECK (("relation_decisions"."lo_to_hi_score" is not null or "relation_decisions"."hi_to_lo_score" is not null)
        and case when "relation_decisions"."score_scale" = 'log_odds' then
              "relation_decisions"."lo_to_hi_relation_type" is null and "relation_decisions"."hi_to_lo_relation_type" is null
              and ("relation_decisions"."lo_to_hi_score" is null or ("relation_decisions"."lo_to_hi_score" > '-Infinity'::float8 and "relation_decisions"."lo_to_hi_score" < 'Infinity'::float8))
              and ("relation_decisions"."hi_to_lo_score" is null or ("relation_decisions"."hi_to_lo_score" > '-Infinity'::float8 and "relation_decisions"."hi_to_lo_score" < 'Infinity'::float8))
            else
              ("relation_decisions"."lo_to_hi_score" is null) = ("relation_decisions"."lo_to_hi_relation_type" is null)
              and ("relation_decisions"."hi_to_lo_score" is null) = ("relation_decisions"."hi_to_lo_relation_type" is null)
              and coalesce("relation_decisions"."lo_to_hi_score", 0) between 0 and 1
              and coalesce("relation_decisions"."hi_to_lo_score", 0) between 0 and 1
            end);--> statement-breakpoint
ALTER TABLE "relation_decisions" ADD CONSTRAINT "relation_decisions_types" CHECK (coalesce("relation_decisions"."lo_to_hi_relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')
        and coalesce("relation_decisions"."hi_to_lo_relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')
        and coalesce("relation_decisions"."relation_type", 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related'));--> statement-breakpoint
-- 5. Source relations: every existing row was judged; promoted rows (design E) come with T53.
ALTER TABLE "source_relations" ADD COLUMN "origin" text DEFAULT 'judged' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ADD COLUMN "support_count" integer;--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT "source_relations_scores";--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT "source_relations_type";--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "importance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ALTER COLUMN "confidence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_origin" CHECK ("source_relations"."origin" in ('judged','promoted')
        and ("source_relations"."origin" <> 'judged' or ("source_relations"."importance" is not null and "source_relations"."confidence" is not null))
        and ("source_relations"."origin" <> 'promoted' or ("source_relations"."support_count" is not null and "source_relations"."support_count" >= 1))
        and ("source_relations"."support_count" is null or "source_relations"."support_count" >= 1));--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_scores" CHECK (("source_relations"."importance" is null or "source_relations"."importance" between 0 and 1)
        and ("source_relations"."confidence" is null or "source_relations"."confidence" between 0 and 1));--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_type" CHECK ("source_relations"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related'));--> statement-breakpoint
-- 6. New tables: the typing cache, per-note and per-root matching state, runs and events.
CREATE TABLE "note_match_state" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"decider_key" text NOT NULL,
	"space_key" text NOT NULL,
	"kth_cosine" real,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_match_state_values" CHECK (char_length("note_match_state"."decider_key") between 1 and 200 and char_length("note_match_state"."space_key") between 1 and 200
        and ("note_match_state"."kth_cosine" is null or "note_match_state"."kth_cosine" between -1 and 1))
);
--> statement-breakpoint
CREATE TABLE "relation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"run_id" uuid NOT NULL,
	"relation_kind" text NOT NULL,
	"relation_id" uuid,
	"pair_key" text NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_events_values" CHECK ("relation_events"."relation_kind" in ('note','source')
        and "relation_events"."kind" in ('applied','suggested','typed','untyped','vetoed','kept','removed','promoted','retired','reconciled')
        and char_length("relation_events"."pair_key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "relation_match_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"root_id" uuid,
	"decider_key" text,
	"calibration_version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "relation_match_runs_values" CHECK ("relation_match_runs"."kind" in ('match','link','type','promote','discover','review','veto','reconcile','retype')
        and ("relation_match_runs"."outcome" is null or char_length("relation_match_runs"."outcome") between 1 and 200)
        and jsonb_typeof("relation_match_runs"."counts") = 'object' and jsonb_typeof("relation_match_runs"."timings") = 'object')
);
--> statement-breakpoint
CREATE TABLE "relation_typings" (
	"pair_key" text NOT NULL,
	"typer_key" text NOT NULL,
	"lo_hash" text NOT NULL,
	"hi_hash" text NOT NULL,
	"relation_type" text NOT NULL,
	"direction" text,
	"ai_task_run_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_typings_pair_key_typer_key_pk" PRIMARY KEY("pair_key","typer_key"),
	CONSTRAINT "relation_typings_verdict" CHECK ("relation_typings"."relation_type" in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','none')
        and case when "relation_typings"."relation_type" = 'none' then "relation_typings"."direction" is null
                 when "relation_typings"."relation_type" in ('supports','extends','depends_on','example_of','clarifies')
                   then "relation_typings"."direction" in ('lo_to_hi','hi_to_lo')
                 else "relation_typings"."direction" = 'symmetric' end
        and char_length("relation_typings"."pair_key") between 1 and 200 and char_length("relation_typings"."typer_key") between 1 and 200
        and char_length("relation_typings"."lo_hash") between 1 and 200 and char_length("relation_typings"."hi_hash") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "source_match_state" (
	"root_id" uuid PRIMARY KEY NOT NULL,
	"match_seq" bigserial NOT NULL,
	"nearest_root_id" uuid,
	"nearest_cosine" real,
	"space_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_match_state_values" CHECK (("source_match_state"."nearest_root_id" is null or "source_match_state"."nearest_root_id" <> "source_match_state"."root_id")
        and ("source_match_state"."nearest_cosine" is null or "source_match_state"."nearest_cosine" between -1 and 1)
        and char_length("source_match_state"."space_key") between 1 and 200 and char_length("source_match_state"."fingerprint") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "note_match_state" ADD CONSTRAINT "note_match_state_note_id_atomic_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."atomic_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_events" ADD CONSTRAINT "relation_events_run_id_relation_match_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."relation_match_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_typings" ADD CONSTRAINT "relation_typings_ai_task_run_id_ai_task_runs_id_fk" FOREIGN KEY ("ai_task_run_id") REFERENCES "public"."ai_task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_match_state" ADD CONSTRAINT "source_match_state_root_id_source_items_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_match_state" ADD CONSTRAINT "source_match_state_nearest_root_id_source_items_id_fk" FOREIGN KEY ("nearest_root_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_events_seq_uidx" ON "relation_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "relation_events_run_idx" ON "relation_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "relation_events_relation_idx" ON "relation_events" USING btree ("relation_id");--> statement-breakpoint
CREATE INDEX "relation_match_runs_root_started_idx" ON "relation_match_runs" USING btree ("root_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_match_state_match_seq_uidx" ON "source_match_state" USING btree ("match_seq");--> statement-breakpoint
CREATE INDEX "source_match_state_space_nearest_idx" ON "source_match_state" USING btree ("space_key","nearest_root_id");--> statement-breakpoint
-- 7. The facts-only note fingerprint (D11): md5 of the relation ID, both endpoints, the direction,
-- the type and both notes' facts, never status, band, probability, veto or metadata. Every evidence
-- row current under the former formula is re-keyed; the counts of current evidence and current
-- source relations under the new formula and currentness (note-origin evidence counts only while
-- its note relation is applied) must equal the counts before, or the migration rolls back. Every
-- existing note relation is a legacy, unvetoed row, so applied is the former "not rejected".
-- `noteRelationFingerprintSql` and `currentSourceRelationEvidenceSql` of
-- `packages/db/src/repositories/` hold the same expressions.
DO $$
DECLARE
  recomputed bigint;
  evidence_after bigint;
  relations_after bigint;
  evidence_before bigint;
  relations_before bigint;
  missing bigint;
BEGIN
  UPDATE source_relation_evidence e
     SET snapshot = jsonb_set(e.snapshot, '{noteFingerprint}', to_jsonb(md5(concat_ws('|',
           n.id::text, n.source_atomic_note_id::text, n.target_atomic_note_id::text, n.direction,
           coalesce(n.relation_type, ''),
           case when a.id = n.source_atomic_note_id
                then concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status)
                else concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status) end,
           case when a.id = n.source_atomic_note_id
                then concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)
                else concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status) end))))
    FROM relations_v2_current_evidence c, atomic_note_relations n, atomic_notes a, atomic_notes b
   WHERE c.id = e.id AND e.origin = 'atomic_notes' AND n.id = e.note_relation_id
     AND a.id = e.source_note_id AND b.id = e.target_note_id;
  GET DIAGNOSTICS recomputed = ROW_COUNT;

  CREATE TEMP TABLE relations_v2_current_after ON COMMIT DROP AS
  SELECT e.id, e.relation_id
    FROM source_relation_evidence e
    LEFT JOIN chunks sc ON sc.id = e.source_chunk_id
    LEFT JOIN chunks tc ON tc.id = e.target_chunk_id
    LEFT JOIN documents sd ON sd.id = sc.document_id LEFT JOIN documents td ON td.id = tc.document_id
    LEFT JOIN atomic_note_relations n ON n.id = e.note_relation_id
    LEFT JOIN atomic_notes a ON a.id = e.source_note_id
    LEFT JOIN atomic_notes b ON b.id = e.target_note_id
   WHERE (sc.id IS NOT NULL AND tc.id IS NOT NULL
     AND sd.metadata->>'supersededByDocumentId' IS NULL AND td.metadata->>'supersededByDocumentId' IS NULL
     AND sc.content_hash = e.snapshot->>'sourceHash' AND tc.content_hash = e.snapshot->>'targetHash'
     AND (e.origin = 'source_analysis' OR (n.id IS NOT NULL
       AND (n.status = 'accepted' OR (n.status = 'pending_review' AND n.vetoed_at IS NULL
            AND (n.band = 'apply' OR n.band IS NULL)))
       AND a.status NOT IN ('rejected','archived') AND b.status NOT IN ('rejected','archived')
       AND a.supersession_status = 'current' AND b.supersession_status = 'current'
       AND md5(concat_ws('|',
             n.id::text, n.source_atomic_note_id::text, n.target_atomic_note_id::text, n.direction,
             coalesce(n.relation_type, ''),
             case when a.id = n.source_atomic_note_id
                  then concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status)
                  else concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status) end,
             case when a.id = n.source_atomic_note_id
                  then concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)
                  else concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status) end))
           = e.snapshot->>'noteFingerprint')));

  SELECT count(*), count(DISTINCT relation_id) INTO evidence_after, relations_after
    FROM relations_v2_current_after;
  SELECT count(*), count(DISTINCT relation_id) INTO evidence_before, relations_before
    FROM relations_v2_current_evidence;
  SELECT count(*) INTO missing FROM relations_v2_current_evidence c
   WHERE NOT EXISTS (SELECT 1 FROM relations_v2_current_after x WHERE x.id = c.id);
  INSERT INTO relations_v2_report ("key", "value") VALUES
    ('evidence_recomputed', recomputed),
    ('current_evidence_after', evidence_after),
    ('current_source_relations_after', relations_after),
    ('current_evidence_lost', missing);
  -- 8. The report, captured by the verify script.
  RAISE NOTICE 'relations_v2 report %', (SELECT jsonb_object_agg("key", "value") FROM relations_v2_report);
  IF evidence_after <> evidence_before OR relations_after <> relations_before OR missing <> 0 THEN
    RAISE EXCEPTION 'relations_v2: current source evidence % -> %, current source relations % -> %, lost %',
      evidence_before, evidence_after, relations_before, relations_after, missing;
  END IF;
END $$;
