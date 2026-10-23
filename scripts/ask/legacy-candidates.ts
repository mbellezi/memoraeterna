import { consultationCandidatesSql } from "@app/db";

/**
 * The candidates statement of Ask as it ran before migration 0064 (F4 T79, D22), kept only to
 * measure the stored text vectors against it: the text and note signals parse and unaccent the text
 * of every passage and note in scope on every question, the title is parsed per passage, and the
 * entity text per mention. It is the current statement with exactly those expressions put back, so
 * everything the stored vectors did not touch (scope, concepts, relations, ordering, limits) stays
 * the product's own. Each piece is replaced exactly once or this throws: a statement that changed
 * shape must be looked at, not measured. Not used by the product.
 */
const replaceOnce = (text: string, from: string, to: string): string => {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + 1) >= 0)
    throw new Error(`The candidates statement no longer holds exactly one of: ${from}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
};

/** The text between two fragments, both included, removed. */
const cutBetween = (text: string, start: string, end: string): string => {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error(`Cannot find ${start} ... ${end} in the statement`);
  return text.slice(0, first) + text.slice(last + end.length);
};

export const legacyCandidatesSql = (() => {
  let text = consultationCandidatesSql;
  // The CTEs that now carry the title and entity signals once per statement.
  const ctes = text.indexOf(", title_ranks as materialized(");
  const candidates = text.indexOf(", candidates as(");
  if (ctes < 0 || candidates < ctes)
    throw new Error("The title and entity CTEs are not where expected");
  text = text.slice(0, ctes) + text.slice(candidates);
  text = replaceOnce(
    text,
    "ts_rank_cd(c.search_tsv,terms.q) as text",
    "ts_rank_cd(to_tsvector('simple',unaccent(c.content)),terms.q) as text"
  );
  text = replaceOnce(
    text,
    "title_ranks.rank as title",
    "case when unaccent(lower(s.title))=unaccent(lower($2)) then 1 else ts_rank_cd(to_tsvector('simple',unaccent(s.title)),terms.q) end as title"
  );
  text = replaceOnce(
    text,
    "max(ts_rank_cd(n.ask_tsv,terms.q))",
    "max(ts_rank_cd(to_tsvector('simple',unaccent(n.idea_statement||' '||n.body_markdown)),terms.q))"
  );
  text = replaceOnce(
    text,
    "coalesce(entity_ranks.rank,0) as entity",
    "case when $3 then 0 else coalesce((select max(ts_rank_cd(to_tsvector('simple',unaccent(e.canonical_name||' '||e.aliases::text)),terms.q)) from entity_mentions m join entities e on e.id=m.entity_id where m.chunk_id=c.id and m.source_item_id=c.source_item_id),0) end as entity"
  );
  text = cutBetween(text, "      join title_ranks on", "c.source_item_id\n");
  text = cutBetween(text, "      left join entity_ranks on", "c.source_item_id\n");
  return text;
})();
