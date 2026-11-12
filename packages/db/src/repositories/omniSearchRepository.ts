import type { QueryResultRow } from "pg";

import {
  compareOmniHits,
  formatObjectAddress,
  objectKinds,
  omniArmLimit,
  omniKindOrder,
  rrfK,
  rrfScore,
  type ObjectKind,
  type OmniArmName,
  type OmniArmRank
} from "@app/domain";

import { currentNoteSql } from "./note-relation-sql.js";
import { withVectorScanSettings } from "./noteRetrievalSql.js";
import { topicScopeCtes } from "./topicScopeSql.js";
import type { Queryable } from "./types.js";

/**
 * `search.omni`'s statement (F5 D12, spec 3.4): one SQL statement per request. Each arm returns its
 * best twenty hits, written with the exact expression of its index (migration 0067, 0066, 0058;
 * `objectSearchArms.ts` holds the same expressions for the EXPLAIN gate), and the statement fuses
 * them by reciprocal rank (`rrf.ts`) and orders them with the deterministic tiebreak.
 *
 * - Quick mode: trigram `word_similarity` on titles (sources, topics, notes), question text, entity
 *   names and entity aliases; full text (`search_tsv @@`, `ts_rank_cd`) on notes, topics (title A,
 *   aliases B, description C) and questions.
 * - Full mode adds the passages' full text and, given the query's vector, the nearest notes
 *   (partial HNSW of 0058) and passages (the table's HNSW with a `target_type` filter) of the
 *   embedding space the vector belongs to. A passage is a hit on its source's address with a
 *   `passage` anchor.
 *
 * Visibility applies inside every arm, before its limit, through the predicate modules: a note
 * counts only when `currentNoteSql` says it is current, a topic only when it is not retired and its
 * tree is active, a passage only when its document has not been superseded; a source exists until
 * it is deleted. A topic scope reads the topic's subtree through `topicScopeSql.ts`. Read-only.
 */

export type OmniMode = "quick" | "full";

/** The query's vector and the embedding space it belongs to (the rows' `strategy` and runtime). */
export interface OmniQueryEmbedding {
  vector: readonly number[];
  model: string;
  spaceKey: string;
  provider: string;
  runtime: string;
}

export interface OmniSearchInput {
  query: string;
  mode: OmniMode;
  /** Only these kinds (a passage is a source); every kind when absent. */
  kinds?: readonly ObjectKind[] | undefined;
  /** Only the subtree of this topic. */
  topicId?: string | undefined;
  limit: number;
  /** Full mode only; without it the vector arms do not run. */
  embedding?: OmniQueryEmbedding | null | undefined;
}

export interface OmniSearchHit {
  address: string;
  kind: ObjectKind;
  title: string;
  snippet?: string;
  arms: OmniArmRank[];
  score: number;
}

/** An arm family the request could have used and did not: the answer is still right, but partial. */
export type OmniDegraded = "ann" | "fts";

export interface OmniSearchOutcome {
  items: OmniSearchHit[];
  /** True when a full-text arm ran (false for a query with no word, or kinds that have none). */
  fullText: boolean;
  /** True when a vector arm ran. */
  vectors: boolean;
  /** The arm families that apply to the request's kinds and mode but did not run. */
  degraded: OmniDegraded[];
}

export interface OmniSearchStatement {
  text: string;
  values: unknown[];
  arms: readonly { arm: OmniArmName; kind: ObjectKind; table: string }[];
  /** A full-text arm is in `arms`. */
  fullText: boolean;
  /** A vector arm is in `arms`. */
  vectors: boolean;
  degraded: OmniDegraded[];
}

const vectorDimensions = new Set([256, 768, 1_024]);
/** Characters of a snippet; the renderer cuts it to its line. */
const snippetLength = 240;
/** Words of the query the full-text arms look for. */
const maxQueryTerms = 12;

/**
 * The words of a query the full-text arms look for, at most twelve. The statement unaccents each
 * one (`f_unaccent`), quotes it, joins them with `&` and makes the last a prefix; the 'simple'
 * configuration lower-cases them, as `search_tsv` was built.
 */
export function omniQueryWords(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu)?.slice(0, maxQueryTerms) ?? [];
}

/** The tsquery of the words in `words` (a `text[]` expression), the last one a prefix. */
const tsquerySql = (words: string) => `to_tsquery('simple', (
    select string_agg('''' || replace(replace(f_unaccent(w.word), '\\', '\\\\'), '''', '''''') || ''''
                      || case when w.n = cardinality(${words}) then ':*' else '' end, ' & ' order by w.n)
      from unnest(${words}) with ordinality as w(word, n)))`;

interface ArmContext {
  scoped: boolean;
  vector: string | null;
  embedding: { model: string; space: string; provider: string; runtime: string } | null;
  dimensions: number;
}

interface ArmSpec {
  arm: OmniArmName;
  kind: ObjectKind;
  table: string;
  /** `trgm` and `fts` run in both modes; `passage` and `ann` in full mode only. */
  needs: "trgm" | "fts" | "passage" | "ann";
  /** `select id, passage, score ... order by score limit 20`; a higher score ranks first. */
  sql: (context: ArmContext) => string;
}

/**
 * A topic counts when it is not retired and its tree is the active one. The tree is read by primary
 * key per matching row (as `currentNoteSql` reads a note's document), so the planner keeps the
 * arm's index as the driver instead of walking every topic of the active tree.
 */
export const liveTopicSql = (alias: string) =>
  `(${alias}.retired_at is null and coalesce((select omni_tree.status = 'active' from topic_trees omni_tree
     where omni_tree.id = ${alias}.tree_id), false))`;

/** A passage counts when its document has not been superseded (as `currentNoteSql` reads it). */
const livePassage = (alias: string) =>
  `coalesce((select omni_document.metadata->>'supersededByDocumentId' is null from documents omni_document
              where omni_document.id = ${alias}.document_id), false)`;

/** The scope condition of each kind, over the CTEs of `topicScopeCtes`. */
const inScope: Record<ObjectKind | "passage", (alias: string) => string> = {
  topic: (x) => `${x}.id in (select id from topic_sub)`,
  note: (x) => `${x}.id in (select note_id from topic_note_ids)`,
  source: (x) => `(${x}.id in (select id from topic_sources)
      or ${x}.id in (select omni_scoped.created_from_source_item_id from atomic_notes omni_scoped
                      where omni_scoped.id in (select note_id from topic_note_ids)))`,
  passage: (x) => `${x}.id in (select chunk_id from topic_chunks)`,
  entity: (x) => `exists (select 1 from atomic_note_entity_links omni_link
      where omni_link.entity_id = ${x}.id and omni_link.atomic_note_id in (select note_id from topic_note_ids))`,
  question: (x) =>
    `(${x}.scope->>'kind' = 'topic' and ${x}.scope->>'topicId' in (select id::text from topic_sub))`
};

const visibility: Partial<Record<ObjectKind | "passage", (alias: string) => string>> = {
  topic: liveTopicSql,
  note: currentNoteSql,
  passage: livePassage
};

function conditions(kind: ObjectKind | "passage", alias: string, scoped: boolean): string {
  const parts = [visibility[kind]?.(alias), scoped ? inScope[kind](alias) : undefined].filter(
    (part): part is string => part !== undefined
  );
  return parts.map((part) => `and ${part}`).join("\n     ");
}

/** A trigram arm: `f_unaccent(q) <% expression`, as the GIN index is written. */
function trigramArm(
  arm: "title_trgm" | "alias_trgm",
  kind: ObjectKind,
  table: string,
  expression: string
): ArmSpec {
  return {
    arm,
    kind,
    table,
    needs: "trgm",
    sql: ({
      scoped
    }) => `select x.id, null::uuid as passage, word_similarity(q.t, ${expression}) as score
    from ${table} x, q
   where q.t <% ${expression}
     ${conditions(kind, "x", scoped)}
   order by score desc, x.id
   limit ${omniArmLimit}`
  };
}

/** A full-text arm: `search_tsv @@ q`, ranked by `ts_rank_cd`. */
function fullTextArm(kind: ObjectKind, table: string): ArmSpec {
  return {
    arm: "fts",
    kind,
    table,
    needs: "fts",
    sql: ({
      scoped
    }) => `select x.id, null::uuid as passage, ts_rank_cd(x.search_tsv, q.ts) as score
    from ${table} x, q
   where x.search_tsv @@ q.ts
     ${conditions(kind, "x", scoped)}
   order by score desc, x.id
   limit ${omniArmLimit}`
  };
}

/** The embedding rows of the query's space, as `noteVectorCandidatesStatement` matches them. */
const spaceFilter = (context: ArmContext) =>
  `e.model = ${context.embedding!.model} and e.strategy = 'native-v2:' || ${context.embedding!.space}
     and e.provider = ${context.embedding!.provider} and e.runtime = ${context.embedding!.runtime}`;

const isFullTextArm = (spec: ArmSpec) => spec.needs === "fts" || spec.needs === "passage";
const isVectorArm = (spec: ArmSpec) => spec.needs === "ann";

const arms: readonly ArmSpec[] = [
  trigramArm("title_trgm", "topic", "topics", "f_unaccent(x.title)"),
  trigramArm("title_trgm", "source", "source_items", "f_unaccent(x.title)"),
  trigramArm("title_trgm", "note", "atomic_notes", "f_unaccent(x.title)"),
  trigramArm("title_trgm", "entity", "entities", "f_unaccent(x.canonical_name)"),
  trigramArm("alias_trgm", "entity", "entities", "f_unaccent(f_jsonb_text_array(x.aliases))"),
  trigramArm("title_trgm", "question", "questions", "f_unaccent(x.text)"),
  fullTextArm("topic", "topics"),
  fullTextArm("note", "atomic_notes"),
  fullTextArm("question", "questions"),
  {
    arm: "chunk_fts",
    kind: "source",
    table: "chunks",
    needs: "passage",
    sql: ({
      scoped
    }) => `select x.source_item_id as id, x.id as passage, ts_rank_cd(x.search_tsv, q.ts) as score
    from chunks x, q
   where x.search_tsv @@ q.ts
     ${conditions("passage", "x", scoped)}
   order by score desc, x.id
   limit ${omniArmLimit}`
  },
  {
    arm: "ann",
    kind: "note",
    table: "embeddings",
    needs: "ann",
    // The partial HNSW of 0058 serves `target_type = 'atomic_note'` ordered by the raw distance.
    sql: (context) => `select nearest.id, null::uuid as passage, -nearest.distance as score from (
    select x.id, e.embedding <=> ${context.vector} as distance
      from embeddings_${context.dimensions} e join atomic_notes x on x.id = e.target_id
     where e.target_type = 'atomic_note' and ${spaceFilter(context)}
       ${conditions("note", "x", context.scoped)}
     order by e.embedding <=> ${context.vector}
     limit ${omniArmLimit}) nearest`
  },
  {
    arm: "ann",
    kind: "source",
    table: "embeddings",
    needs: "ann",
    // The table's HNSW with a `target_type` filter; a partial chunk HNSW is D27's lever.
    sql: (
      context
    ) => `select nearest.source_item_id as id, nearest.id as passage, -nearest.distance as score from (
    select x.id, x.source_item_id, e.embedding <=> ${context.vector} as distance
      from embeddings_${context.dimensions} e join chunks x on x.id = e.chunk_id
     where e.target_type = 'chunk' and ${spaceFilter(context)}
       ${conditions("passage", "x", context.scoped)}
     order by e.embedding <=> ${context.vector}
     limit ${omniArmLimit}) nearest`
  }
];

const kindOrderSql = `array_position(array[${omniKindOrder.map((kind) => `'${kind}'`).join(",")}]::text[], kind)`;
const fusedOrderSql = `score desc, best, ${kindOrderSql}, title collate "C", id, passage nulls first`;

/** The text a hit shows when its title is not what matched (or the passage it is). */
const snippetSql = `case
    when top.passage is not null then
      (select left(regexp_replace(c.content, '\\s+', ' ', 'g'), ${snippetLength}) from chunks c where c.id = top.passage)
    when top.arms @> '[{"arm":"title_trgm"}]' then null
    when top.kind = 'note' then
      (select left(n.idea_statement, ${snippetLength}) from atomic_notes n where n.id = top.id)
    when top.kind = 'topic' then
      (select left(t.description, ${snippetLength}) from topics t where t.id = top.id)
    when top.kind = 'entity' then
      (select left(string_agg(a.alias, ', ' order by a.n), ${snippetLength})
         from entities e, jsonb_array_elements_text(e.aliases) with ordinality as a(alias, n)
        where e.id = top.id and jsonb_typeof(e.aliases) = 'array')
  end`;

/**
 * Builds the statement of one request. Only the arms of the requested kinds and mode run; the
 * full-text arms need a word in the query and the vector arms a vector of a supported dimension.
 */
export function omniSearchStatement(input: OmniSearchInput): OmniSearchStatement {
  const values: unknown[] = [];
  const parameter = (value: unknown, type: string) => {
    values.push(value);
    return `$${values.length}::${type}`;
  };
  const kinds = new Set(input.kinds?.length ? input.kinds : objectKinds);
  const words = omniQueryWords(input.query);
  const tsquery = words.length > 0 ? words : null;
  const vector =
    input.mode === "full" && input.embedding && vectorDimensions.has(input.embedding.vector.length)
      ? input.embedding
      : null;

  const query = parameter(input.query, "text");
  const qColumns = [`f_unaccent(${query}) as t`];
  if (tsquery) qColumns.push(`${tsquerySql(parameter(tsquery, "text[]"))} as ts`);
  const limit = parameter(input.limit, "int");
  const scoped = typeof input.topicId === "string";
  const scope = scoped ? topicScopeCtes(parameter(input.topicId, "text")) : null;
  const context: ArmContext = {
    scoped,
    vector: vector ? parameter(`[${vector.vector.join(",")}]`, "vector") : null,
    embedding: vector
      ? {
          model: parameter(vector.model, "text"),
          space: parameter(vector.spaceKey, "text"),
          provider: parameter(vector.provider, "text"),
          runtime: parameter(vector.runtime, "text")
        }
      : null,
    dimensions: vector?.vector.length ?? 0
  };

  const applicable = arms.filter(
    (spec) => kinds.has(spec.kind) && (input.mode === "full" || spec.needs !== "passage")
  );
  const runs = arms.filter((spec) => {
    if (!kinds.has(spec.kind)) return false;
    if (spec.needs === "trgm") return true;
    if (spec.needs === "fts") return tsquery !== null;
    if (input.mode !== "full") return false;
    return spec.needs === "passage" ? tsquery !== null : vector !== null;
  });
  const armCtes = runs.map(
    (spec, index) => `arm_${index} as (
  select '${spec.kind}'::text as kind, h.id, h.passage, '${spec.arm}'::text as arm,
         row_number() over (order by h.score desc, h.id, h.passage) as rank
    from (${spec.sql(context)}) h)`
  );

  const text = `with recursive q as not materialized (select ${qColumns.join(", ")}),
${scope ? `${scope},\n` : ""}${armCtes.join(",\n")},
hits as (${runs.map((_, index) => `select * from arm_${index}`).join("\n  union all ")}),
fused as (
  select kind, id, passage, sum(1.0 / (${rrfK} + rank)) as score, min(rank) as best,
         jsonb_agg(jsonb_build_object('arm', arm, 'rank', rank) order by rank, arm) as arms
    from hits group by kind, id, passage),
titled as materialized (
  select f.*, coalesce(case f.kind
           when 'source' then (select s.title from source_items s where s.id = f.id)
           when 'topic' then (select t.title from topics t where t.id = f.id)
           when 'note' then (select n.title from atomic_notes n where n.id = f.id)
           when 'entity' then (select e.canonical_name from entities e where e.id = f.id)
           when 'question' then (select left(qn.text, 200) from questions qn where qn.id = f.id)
         end, '') as title
    from fused f),
top as (select * from titled order by ${fusedOrderSql} limit ${limit})
select top.kind, top.id, top.passage, top.title, top.arms, ${snippetSql} as snippet
  from top
 order by ${fusedOrderSql}`;

  return {
    text,
    values,
    arms: runs.map(({ arm, kind, table }) => ({
      arm,
      kind,
      table: table === "embeddings" ? `embeddings_${context.dimensions}` : table
    })),
    fullText: runs.some(isFullTextArm),
    vectors: runs.some(isVectorArm),
    // An arm family is missing only where one applies: a request for topics or entities has no
    // vector arm to miss, and one for entities has no full-text arm.
    degraded: [
      ...(input.mode === "full" && applicable.some(isVectorArm) && !runs.some(isVectorArm)
        ? (["ann"] as const)
        : []),
      ...(applicable.some(isFullTextArm) && !runs.some(isFullTextArm) ? (["fts"] as const) : [])
    ]
  };
}

interface OmniRow extends QueryResultRow {
  kind: ObjectKind;
  id: string;
  passage: string | null;
  title: string;
  arms: { arm: OmniArmName; rank: number | string }[];
  snippet: string | null;
}

export function createOmniSearchRepository(db: Queryable) {
  return {
    /**
     * The fused hits of one request, best first. Each hit's score is `rrfScore` of its arms and the
     * order is `compareOmniHits`, the order the statement itself sorts by.
     */
    async search(input: OmniSearchInput): Promise<OmniSearchOutcome> {
      const statement = omniSearchStatement(input);
      const run = (connection: Queryable) =>
        connection.query<OmniRow>(statement.text, statement.values);
      const result = statement.vectors ? await withVectorScanSettings(db, run) : await run(db);
      const items = result.rows.map((row): OmniSearchHit => {
        const ranks = row.arms.map(({ arm, rank }) => ({ arm, rank: Number(rank) }));
        return {
          address: formatObjectAddress({
            kind: row.kind,
            id: row.id,
            ...(row.passage ? { anchor: { passage: row.passage } } : {})
          }),
          kind: row.kind,
          title: row.title,
          ...(row.snippet ? { snippet: row.snippet } : {}),
          arms: ranks,
          score: rrfScore(ranks.map(({ rank }) => rank))
        };
      });
      return {
        items: items.sort(compareOmniHits),
        fullText: statement.fullText,
        vectors: statement.vectors,
        degraded: statement.degraded
      };
    }
  };
}
