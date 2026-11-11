-- Omni search indexes (F5 T117, D12, D27): every arm of `search.omni` reads an index written as the
-- arm's own expression, so the planner can use it.
--   * f_jsonb_text_array: the elements of a jsonb array of strings joined by spaces. IMMUTABLE (the
--     elements are read as text, no locale or setting is involved), so it can sit in a generated
--     column and an index expression. A value that is not an array reads as the empty text instead
--     of raising, so one odd row can never fail an insert or an index build. It stays a plain call
--     (a body with a FROM is not inlined); the indexes and the arms name it the same way.
--   * topics.search_tsv: title A, aliases B, description C, over f_unaccent (0053). Generated and
--     stored; a GIN serves `search_tsv @@`.
--   * trigram GINs over f_unaccent(title) for source_items and topics (a null title is not
--     indexed), and over f_unaccent(canonical_name) and f_unaccent(f_jsonb_text_array(aliases)) for
--     entities. No coalesce: the expression is the one the arm uses.
--   * a GIN on chunks.search_tsv (0064) for the full-mode chunk arm.
--   * the two indexes of 0001 on chunks.content are dropped: nothing reads them (`content` is
--     matched through search_tsv), they are in no snapshot (hand-added here, as DROP INDEX is not
--     generated for an index the snapshot does not know) and dropping an index needs no backup.
-- The generated column rewrites topics and the GIN builds run in the migrator's startup
-- transaction; `packages/db/src/scripts/verify-object-search-indexes.ts` checks the result.
SET LOCAL maintenance_work_mem = '512MB';--> statement-breakpoint
CREATE FUNCTION f_jsonb_text_array(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT CASE WHEN jsonb_typeof(value) = 'array'
          THEN (SELECT coalesce(string_agg(e, ' '), '') FROM jsonb_array_elements_text(value) AS e)
          ELSE '' END $$;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', f_unaccent(coalesce("topics"."title", ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(coalesce(f_jsonb_text_array("topics"."aliases"), ''))), 'B') ||
        setweight(to_tsvector('simple', f_unaccent(coalesce("topics"."description", ''))), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "chunks_search_tsv_idx" ON "chunks" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "entities_canonical_name_trgm_idx" ON "entities" USING gin (f_unaccent("canonical_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entities_aliases_trgm_idx" ON "entities" USING gin (f_unaccent(f_jsonb_text_array("aliases")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "source_items_title_trgm_idx" ON "source_items" USING gin (f_unaccent("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "topics_search_tsv_idx" ON "topics" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "topics_title_trgm_idx" ON "topics" USING gin (f_unaccent("title") gin_trgm_ops);--> statement-breakpoint
DROP INDEX IF EXISTS "chunks_content_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "chunks_content_fts_idx";
