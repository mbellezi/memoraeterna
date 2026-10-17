-- Retrieval on indexes (F3 T49, D28). Note matching asked the library for candidates with a text
-- query that computed unaccent() and similarity() per row, and a vector query that ordered by a
-- computed alias: no index could serve either. This adds what both need.
--   * search_tsv: the weighted full-text document of a note ('simple' configuration over the
--     f_unaccent wrapper of 0053, so it is immutable), generated and stored, with a GIN index.
--   * a trigram GIN index on the unaccented title, for the title-similarity arm of the text query.
--   * one partial HNSW index per dimension table for atomic-note vectors, ordered by raw cosine
--     distance. The global HNSW indexes of 0001 and 0008 stay for the other targets.
-- The generated column rewrites atomic_notes and the HNSW builds run in the migrator's startup
-- transaction (no CONCURRENTLY). The builds need room: the graph spills to disk past
-- maintenance_work_mem, which is slow.
SET LOCAL maintenance_work_mem = '512MB';--> statement-breakpoint
ALTER TABLE "atomic_notes" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', f_unaccent(coalesce("title", ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(coalesce("idea_statement", ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(left(coalesce("body_markdown", ''), 4000))), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "atomic_notes_search_tsv_idx" ON "atomic_notes" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "atomic_notes_title_trgm_idx" ON "atomic_notes" USING gin (f_unaccent("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "embeddings_256_note_hnsw_idx" ON "embeddings_256" USING hnsw ("embedding" vector_cosine_ops) WHERE "embeddings_256"."target_type" = 'atomic_note';--> statement-breakpoint
CREATE INDEX "embeddings_768_note_hnsw_idx" ON "embeddings_768" USING hnsw ("embedding" vector_cosine_ops) WHERE "embeddings_768"."target_type" = 'atomic_note';--> statement-breakpoint
CREATE INDEX "embeddings_1024_note_hnsw_idx" ON "embeddings_1024" USING hnsw ("embedding" vector_cosine_ops) WHERE "embeddings_1024"."target_type" = 'atomic_note';
