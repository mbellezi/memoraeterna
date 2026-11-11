/**
 * The arms of omni's quick and full statements as the search indexes of migration 0067 (and 0058,
 * 0066) serve them (F5 T117, spec 3.4, D12). Each arm is written with the exact expression of its
 * index: `f_unaccent(q) <% f_unaccent(title)` for a trigram GIN, `search_tsv @@ q` for a full-text
 * GIN, and nothing around the column (no `coalesce`). The statements here are what
 * `db:search-indexes:verify` and the migration test run EXPLAIN on; the service of T127 builds its
 * statement from the same expressions, and that test is what keeps them equal.
 *
 * Parameters: `$1` the query text, `$2` the tsquery source (`to_tsquery('simple', $2)`, with a
 * prefix `:*` on the last term). Visibility (current notes, non-retired topics, sources not
 * deleted) is applied by the service through the predicate modules; it is not an index question and
 * is left out here.
 */
export interface OmniArm {
  /** The arm's name in `search.omni`'s `arms` (spec 3.4). */
  arm: "title_trgm" | "alias_trgm" | "fts" | "chunk_fts";
  /** The table the arm reads; `Seq Scan` on it is a failure. */
  table: string;
  /** The index the plan must name. */
  index: string;
  /** Whether the arm belongs to the quick statement (`false`: full mode only). */
  quick: boolean;
  sql: string;
}

const query = "select f_unaccent($1::text) as t, to_tsquery('simple', $2::text) as ts";

/** A trigram arm: `word_similarity` over the unaccented expression, the best twenty. */
const trigramArm = (
  arm: "title_trgm" | "alias_trgm",
  table: string,
  index: string,
  expression: string
): OmniArm => ({
  arm,
  table,
  index,
  quick: true,
  sql: `with q as (${query})
select x.id, word_similarity(q.t, ${expression}) as score
  from ${table} x, q
 where q.t <% ${expression}
 order by score desc, x.id
 limit 20`
});

/** A full-text arm: `search_tsv @@ q`, ranked by `ts_rank_cd`, the best twenty. */
const ftsArm = (
  arm: "fts" | "chunk_fts",
  table: string,
  index: string,
  quick: boolean
): OmniArm => ({
  arm,
  table,
  index,
  quick,
  sql: `with q as (${query})
select x.id, ts_rank_cd(x.search_tsv, q.ts) as score
  from ${table} x, q
 where x.search_tsv @@ q.ts
 order by score desc, x.id
 limit 20`
});

export const omniArms: readonly OmniArm[] = [
  trigramArm("title_trgm", "source_items", "source_items_title_trgm_idx", "f_unaccent(x.title)"),
  trigramArm("title_trgm", "topics", "topics_title_trgm_idx", "f_unaccent(x.title)"),
  trigramArm("title_trgm", "atomic_notes", "atomic_notes_title_trgm_idx", "f_unaccent(x.title)"),
  trigramArm("title_trgm", "questions", "questions_text_trgm_idx", "f_unaccent(x.text)"),
  trigramArm(
    "title_trgm",
    "entities",
    "entities_canonical_name_trgm_idx",
    "f_unaccent(x.canonical_name)"
  ),
  trigramArm(
    "alias_trgm",
    "entities",
    "entities_aliases_trgm_idx",
    "f_unaccent(f_jsonb_text_array(x.aliases))"
  ),
  ftsArm("fts", "topics", "topics_search_tsv_idx", true),
  ftsArm("fts", "atomic_notes", "atomic_notes_search_tsv_idx", true),
  ftsArm("fts", "questions", "questions_search_tsv_idx", true),
  ftsArm("chunk_fts", "chunks", "chunks_search_tsv_idx", false)
];

/** The unaccented query and its tsquery for a probe of every arm. */
export const omniArmParameters = ["memoria", "memoria:*"] as const;
