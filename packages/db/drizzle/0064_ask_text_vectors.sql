-- Ask's candidate statement parsed and unaccented the text of every passage and note in scope on
-- every question (F4 T79, D22). This stores the two documents it ranked, so a question only ranks them.
--   * chunks.search_tsv: the 'simple' full-text document of a passage over f_unaccent (0053), the
--     expression the statement computed per row with unaccent() (the same dictionary, pinned), so
--     ts_rank_cd gives the same rank. Generated and stored.
--   * atomic_notes.ask_tsv: the document of a note's idea and body, unweighted and not cut, which is
--     what the note signal ranked. It is not search_tsv (0058: weighted, with the title, body cut at
--     4,000 characters), whose order within the signal would differ.
--   * an index on atomic_notes(evidence_chunk_id): the notes resting on a passage were found by
--     scanning the notes of its source.
-- No GIN: the statement ranks every passage in scope and has no `@@` an index could serve. One is
-- added only if the measurement of the candidates statement asks for a prefilter.
-- The generated columns rewrite chunks and atomic_notes, and the index builds, in the migrator's
-- startup transaction (no CONCURRENTLY); `packages/db/src/scripts/verify-ask-text.ts` checks the
-- result and times each step.
SET LOCAL maintenance_work_mem = '512MB';--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent("content"))) STORED;--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "ask_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent("idea_statement" || ' ' || "body_markdown"))) STORED;--> statement-breakpoint
CREATE INDEX "atomic_notes_evidence_chunk_id_idx" ON "atomic_notes" USING btree ("evidence_chunk_id");
