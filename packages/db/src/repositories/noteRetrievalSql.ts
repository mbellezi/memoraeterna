import type { Queryable } from "./types.js";

/**
 * SQL of note candidate retrieval (F3 D28, T49). Both queries are written for the indexes of
 * migration 0058, and `scripts/relations/explain-retrieval.ts` proves with EXPLAIN that they use
 * them:
 *
 *  - text: the note's most selective terms, OR-joined, against the GIN index of
 *    `atomic_notes.search_tsv`, or a similar title against the trigram GIN index on
 *    `f_unaccent(title)`, ranked by `ts_rank_cd` and title similarity;
 *  - vector: the partial HNSW index of the dimension table, ordered by the raw cosine distance
 *    (a computed alias cannot use it), read with iterative scans so the filters that follow still
 *    return `limit` rows, and re-sorted exactly outside.
 *
 * Both exclude superseded, archived and rejected notes and the note itself, take an optional
 * visibility fence, and end every ordering on content (title, idea) before the ID, so the same
 * library hands the same candidates to a prompt after any import.
 */

export const noteRetrievalDefaults = {
  /** Candidates one text or vector query returns. */
  limit: 30,
  /** Terms of the note the text query looks for (D28: its top 12). */
  termLimit: 12,
  /**
   * A term found in more notes than this says nothing about one of them and is left out. It also
   * bounds the rows the text query has to rank (about `termLimit` times this at the very most).
   */
  termPostingLimit: 300,
  /** `hnsw.ef_search` of the vector query (D28). */
  hnswEfSearch: 100,
  /** `random_page_cost` of the vector query (see `vectorScanSettingsSql`). */
  randomPageCost: 1.1
} as const;

/**
 * The visibility fence of a re-match run (F3 3.17): retrieval sees only the notes of the listed
 * root sources and of every source below them. An empty list hides every note.
 */
export interface RetrievalFence {
  readonly rootSourceItemIds: readonly string[];
}

export interface NoteTextCandidatesInput {
  noteId: string;
  limit?: number;
  /** Terms searched (default `noteRetrievalDefaults.termLimit`). */
  termLimit?: number;
  /** Notes a term may appear in and still be searched (default `termPostingLimit`). */
  termPostingLimit?: number;
  fence?: RetrievalFence;
}

export interface NoteVectorCandidatesInput {
  noteId: string;
  embedding: number[];
  embeddingModel?: string;
  embeddingSpaceKey?: string | undefined;
  embeddingProvider?: string | undefined;
  embeddingRuntime?: string | undefined;
  limit?: number;
  fence?: RetrievalFence;
}

export interface NoteRetrievalStatement {
  text: string;
  values: unknown[];
}

/**
 * The columns of a candidate. `ownership` is read from the column itself: `to_jsonb(candidate)`
 * would serialize the whole row, `search_tsv` included, for every candidate returned.
 */
export const noteCandidateColumns = `candidate.ownership, candidate.id, candidate.generation_id as "generationId",
  candidate.supersession_status as "supersessionStatus", candidate.title,
  candidate.body_markdown as "bodyMarkdown", candidate.idea_statement as "ideaStatement",
  candidate.language, candidate.status,
  candidate.created_from_source_item_id as "createdFromSourceItemId",
  candidate.source_span_id as "sourceSpanId", candidate.evidence_chunk_id as "evidenceChunkId",
  candidate.generation_profile_id as "generationProfileId",
  candidate.ai_task_run_id as "aiTaskRunId",
  candidate.generation_provider as "generationProvider",
  candidate.generation_model as "generationModel",
  candidate.generation_runtime as "generationRuntime",
  candidate.generation_prompt_version as "generationPromptVersion",
  candidate.generation_key as "generationKey", candidate.metadata,
  candidate.reviewed_at as "reviewedAt", candidate.created_at as "createdAt",
  candidate.updated_at as "updatedAt"`;

/** A note matching may relate: not discarded, not archived, and the current version of its content. */
const eligible = `candidate.status not in ('rejected', 'archived') and candidate.supersession_status = 'current'`;

/** The sources a fence lets through: its roots and everything below them. */
function fenceParts(parameter: string, fence: RetrievalFence | undefined) {
  if (!fence) return { recursive: "with", cte: "", filter: "" };
  return {
    recursive: "with recursive",
    cte: `fence_tree(id) as (
      select id from source_items where id = any(${parameter}::uuid[])
      union all
      select child.id from source_items child join fence_tree parent on child.parent_source_item_id = parent.id),`,
    filter: "and candidate.created_from_source_item_id in (select id from fence_tree)"
  };
}

/**
 * Snowball dictionaries of the languages the product writes in. `ts_lexize` returns an empty array
 * for a stop word of the language, and the 'simple' configuration of `search_tsv` removes none.
 */
const stopwordDictionaries = `array['english_stem','portuguese_stem','spanish_stem','french_stem','italian_stem']`;

export function noteTextCandidatesStatement(
  input: NoteTextCandidatesInput
): NoteRetrievalStatement {
  const values: unknown[] = [
    input.noteId,
    input.limit ?? noteRetrievalDefaults.limit,
    input.termLimit ?? noteRetrievalDefaults.termLimit,
    input.termPostingLimit ?? noteRetrievalDefaults.termPostingLimit
  ];
  if (input.fence) values.push([...input.fence.rootSourceItemIds]);
  const fence = fenceParts("$5", input.fence);
  return {
    // `candidates` are the note's own lexemes, best first (title and idea weigh A, then how often the
    // lexeme occurs, then its length); `terms` keeps the rarest of them that no more than
    // `termPostingLimit` notes share, found by a bounded count on the GIN index.
    text: `${fence.recursive} ${fence.cte}
      subject as (select f_unaccent(title) as title_unaccented from atomic_notes where id = $1),
      candidates as (
        select t.lexeme,
               '''' || replace(replace(t.lexeme, '\\', '\\\\'), '''', '''''') || '''' as operand
          from atomic_notes note, unnest(note.search_tsv) as t(lexeme, positions, weights)
         where note.id = $1 and char_length(t.lexeme) >= 3
           and not exists (
             select 1 from unnest(${stopwordDictionaries}) as d(name)
              where ts_lexize(d.name::regdictionary, t.lexeme) = '{}')
         order by (case when 'A' = any(t.weights) then 0 else 1 end),
                  cardinality(t.positions) desc, char_length(t.lexeme) desc, t.lexeme
         limit $3::int * 2),
      terms as (
        select c.operand
          from candidates c
          cross join lateral (
            select count(*) as postings from (
              select 1 from atomic_notes n where n.search_tsv @@ c.operand::tsquery
               limit $4::int + 1) probe) p
         where p.postings <= $4::int
         order by p.postings, c.lexeme
         limit $3::int),
      lexical as (select string_agg(operand, ' | ')::tsquery as query from terms),
      ranked as (
        select candidate.id, candidate.title, candidate.idea_statement,
               least(1, greatest(
                 coalesce(ts_rank_cd(candidate.search_tsv, (select query from lexical), 32), 0),
                 similarity(f_unaccent(candidate.title), (select title_unaccented from subject))
               )) as score
          from atomic_notes candidate
         where candidate.id <> $1 and ${eligible}
           and (candidate.search_tsv @@ (select query from lexical)
                or f_unaccent(candidate.title) % (select title_unaccented from subject))
           ${fence.filter}
         order by score desc, candidate.title, candidate.idea_statement, candidate.id
         limit $2::int)
      select ${noteCandidateColumns},
             ranked.score as "textScore", 0::double precision as "vectorScore"
        from ranked join atomic_notes candidate on candidate.id = ranked.id
       order by "textScore" desc, candidate.title, candidate.idea_statement, candidate.id`,
    values
  };
}

export function noteVectorCandidatesStatement(
  input: NoteVectorCandidatesInput
): NoteRetrievalStatement {
  const dimensions = input.embedding.length;
  if (dimensions !== 256 && dimensions !== 768 && dimensions !== 1_024) {
    throw new Error(`Unsupported embedding dimension: ${dimensions}`);
  }
  const values: unknown[] = [
    input.noteId,
    `[${input.embedding.join(",")}]`,
    input.embeddingModel ?? null,
    input.limit ?? noteRetrievalDefaults.limit,
    input.embeddingSpaceKey ?? null,
    input.embeddingProvider ?? null,
    input.embeddingRuntime ?? null
  ];
  if (input.fence) values.push([...input.fence.rootSourceItemIds]);
  const fence = fenceParts("$8", input.fence);
  return {
    text: `${fence.recursive} ${fence.cte}
      nearest as (
        select e.target_id, e.embedding <=> $2::vector as distance
          from embeddings_${dimensions} e
          join atomic_notes candidate on candidate.id = e.target_id
         where e.target_type = 'atomic_note'
           and ($3::text is null or e.model = $3)
           and e.strategy = 'native-v2:' || $5::text and e.provider = $6 and e.runtime = $7
           and candidate.id <> $1 and ${eligible}
           ${fence.filter}
         order by e.embedding <=> $2::vector
         limit $4::int)
      select ${noteCandidateColumns},
             0::double precision as "textScore",
             coalesce(greatest(0, 1 - nearest.distance), 0) as "vectorScore"
        from nearest join atomic_notes candidate on candidate.id = nearest.target_id
       order by "vectorScore" desc, candidate.title, candidate.idea_statement, candidate.id`,
    values
  };
}

/**
 * The settings the vector query runs with, for the transaction that runs it:
 *  - iterative scans, so the filters after the HNSW scan (eligible notes, a fence) still return
 *    `limit` rows, and the candidates it examines (`ef_search`);
 *  - the page cost of a solid-state disk. pgvector prices an HNSW scan by the random pages of its
 *    index, one page per vector at 1,024 dimensions, and the planner prices the sequential scan it
 *    competes with without the TOAST pages the vectors live in: at 30,000 notes of 1,024
 *    dimensions it chose the exact scan (45 ms against 2.5 ms) with the default of 4.
 */
export const vectorScanSettingsSql = `select set_config('hnsw.iterative_scan', 'relaxed_order', true),
  set_config('hnsw.ef_search', '${noteRetrievalDefaults.hnswEfSearch}', true),
  set_config('random_page_cost', '${noteRetrievalDefaults.randomPageCost}', true)`;

interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release?: () => void }>;
  totalCount: number;
}

function isPool(db: Queryable): db is PoolLike {
  return typeof (db as Partial<PoolLike>).totalCount === "number";
}

/**
 * Runs `work` with the vector scan settings applied to its transaction only. On a pool
 * it takes a connection and its own transaction; on a client it applies them to the caller's
 * transaction, which they then keep until it ends.
 */
export async function withVectorScanSettings<T>(
  db: Queryable,
  work: (connection: Queryable) => Promise<T>
): Promise<T> {
  if (!isPool(db)) {
    await db.query(vectorScanSettingsSql);
    return await work(db);
  }
  const connection = await db.connect();
  try {
    await connection.query("begin");
    await connection.query(vectorScanSettingsSql);
    const result = await work(connection);
    await connection.query("commit");
    return result;
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release?.();
  }
}
