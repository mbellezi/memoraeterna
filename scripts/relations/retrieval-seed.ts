import type pg from "pg";

import { librarySeedSteps } from "../objects/synthetic-library.js";
import { RetrievalCorpus, vectorLiteral } from "./retrieval-corpus.js";

/**
 * SEED30K for the retrieval benchmarks: the library of `synthetic-library.ts` (books > chapters >
 * sections with chunks, 30,000 notes by default) with its notes rewritten by `RetrievalCorpus` and
 * every note, chunk and source embedded in one vector space. The retrieval indexes are dropped
 * before the bulk load and rebuilt after it from their own definitions, so the seed also times
 * their build on a library of this size (the migration builds them the same way at startup).
 *
 * Run on a throwaway database migrated from scratch: it writes through raw SQL and disables user
 * triggers while it loads.
 */

export interface RetrievalSeedOptions {
  books: number;
  notes: number;
  dimensions: 256 | 768 | 1024;
  seed: number;
  topics?: number;
  /** `maintenance_work_mem` while the indexes build (default 512 MB, as migration 0058 sets it). */
  maintenanceWorkMem?: string;
  log?: (message: string) => void;
}

export interface RetrievalSeedSummary {
  notes: number;
  chunks: number;
  sources: number;
  space: EmbeddingSpace;
  /** Seconds each rebuilt index took, by index name. */
  indexBuildSeconds: Record<string, number>;
  /** The `maintenance_work_mem` those builds ran with. */
  maintenanceWorkMem: string;
  /** Share of notes that are archived, rejected or superseded, so the filters have work to do. */
  excludedNotes: number;
}

export interface EmbeddingSpace {
  provider: string;
  model: string;
  runtime: string;
  spaceKey: string;
}

export const syntheticSpace: EmbeddingSpace = {
  provider: "local",
  model: "synthetic-retrieval-embedding",
  runtime: "mlx",
  spaceKey: "synthetic-retrieval-space"
};

/** The eligibility of a note by its number, so tests and the benchmark agree on who is excluded. */
export function syntheticNoteState(number: number): {
  status: "active" | "archived" | "rejected";
  supersession: "current" | "superseded";
} {
  const slot = number % 100;
  if (slot >= 1 && slot <= 3) return { status: "archived", supersession: "superseded" };
  if (slot === 4 || slot === 5) return { status: "rejected", supersession: "current" };
  if (slot >= 6 && slot <= 8) return { status: "archived", supersession: "current" };
  return { status: "active", supersession: "current" };
}

const retrievalIndexes = (dimensions: number): string[] => [
  "atomic_notes_search_tsv_idx",
  "atomic_notes_title_trgm_idx",
  `embeddings_${dimensions}_note_hnsw_idx`,
  `embeddings_${dimensions}_embedding_hnsw_idx`
];

export async function seedRetrievalLibrary(
  pool: pg.Pool,
  options: RetrievalSeedOptions
): Promise<RetrievalSeedSummary> {
  const log = options.log ?? (() => undefined);
  const corpus = new RetrievalCorpus({
    seed: options.seed,
    ...(options.topics === undefined ? {} : { topics: options.topics })
  });
  const client = await pool.connect();
  try {
    log(`library: ${options.books} books, ${options.notes} notes`);
    for (const step of librarySeedSteps(options.books, options.notes, 0)) await client.query(step);

    // Drop the indexes the load would otherwise maintain row by row; rebuild them from their own
    // definitions afterwards.
    const indexNames = retrievalIndexes(options.dimensions);
    const definitions = (
      await client.query<{ indexname: string; indexdef: string }>(
        "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = any($1::text[])",
        [indexNames]
      )
    ).rows;
    for (const { indexname } of definitions) await client.query(`drop index "${indexname}"`);

    log("rewriting the notes");
    await client.query("alter table atomic_notes disable trigger user");
    const batch = 500;
    let excluded = 0;
    for (let first = 1; first <= options.notes; first += batch) {
      const numbers: number[] = [];
      const titles: string[] = [];
      const ideas: string[] = [];
      const bodies: string[] = [];
      const languages: string[] = [];
      const statuses: string[] = [];
      const supersessions: string[] = [];
      for (let number = first; number < first + batch && number <= options.notes; number += 1) {
        const note = corpus.note(number);
        const state = syntheticNoteState(number);
        if (state.status !== "active" || state.supersession !== "current") excluded += 1;
        numbers.push(number);
        titles.push(note.title);
        ideas.push(note.idea);
        bodies.push(note.body);
        languages.push(note.language === "pt" ? "pt-BR" : "en");
        statuses.push(state.status);
        supersessions.push(state.supersession);
      }
      await client.query(
        `update atomic_notes n
            set title = v.title, idea_statement = v.idea, body_markdown = v.body,
                language = v.language, status = v.status::atomic_note_status,
                supersession_status = v.supersession
           from unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                  as v(g, title, idea, body, language, status, supersession)
           join t_note on t_note.g = v.g
          where n.id = t_note.id`,
        [numbers, titles, ideas, bodies, languages, statuses, supersessions]
      );
    }
    await client.query("alter table atomic_notes enable trigger user");

    const space = syntheticSpace;
    const table = `embeddings_${options.dimensions}`;
    const insertVectors = async (
      targetType: string,
      ids: string[],
      vectors: string[],
      withChunk: boolean
    ) =>
      client.query(
        `insert into ${table}
           (target_type, target_id, chunk_id, provider, model, runtime, strategy, content_hash, embedding)
         select $1, v.id, case when $5 then v.id end, $2, $3, $4, 'native-v2:' || $6, md5(v.id::text), v.vector::vector
           from unnest($7::uuid[], $8::text[]) as v(id, vector)`,
        [
          targetType,
          space.provider,
          space.model,
          space.runtime,
          withChunk,
          space.spaceKey,
          ids,
          vectors
        ]
      );

    log("embedding the notes, chunks and sources");
    const noteRows = (
      await client.query<{ id: string; g: number }>("select id, g from t_note order by g")
    ).rows;
    for (let first = 0; first < noteRows.length; first += 200) {
      const slice = noteRows.slice(first, first + 200);
      await insertVectors(
        "atomic_note",
        slice.map((row) => row.id),
        slice.map((row) => vectorLiteral(corpus.vector(Number(row.g), options.dimensions))),
        false
      );
    }
    // Chunk and source vectors share the table: the partial index must keep them out.
    const others = (
      await client.query<{ id: string; kind: string; n: number }>(
        `select id, 'chunk' as kind, row_number() over (order by id)::int as n from chunks
         union all select id, 'source_item', row_number() over (order by id)::int + 1000000 from source_items`
      )
    ).rows;
    for (const kind of ["chunk", "source_item"]) {
      const rows = others.filter((row) => row.kind === kind);
      for (let first = 0; first < rows.length; first += 200) {
        const slice = rows.slice(first, first + 200);
        await insertVectors(
          kind,
          slice.map((row) => row.id),
          slice.map((row) => vectorLiteral(corpus.vector(row.n + 5_000_000, options.dimensions))),
          kind === "chunk"
        );
      }
    }

    const indexBuildSeconds: Record<string, number> = {};
    const maintenanceWorkMem = options.maintenanceWorkMem ?? "512MB";
    await client.query(`set maintenance_work_mem = '${maintenanceWorkMem}'`);
    for (const { indexname, indexdef } of definitions) {
      const started = performance.now();
      await client.query(indexdef);
      indexBuildSeconds[indexname] = Number(((performance.now() - started) / 1000).toFixed(2));
      log(`index ${indexname}: ${indexBuildSeconds[indexname]} s`);
    }
    await client.query("reset maintenance_work_mem");
    await client.query("analyze");

    const counts = (
      await client.query<{ chunks: string; sources: string }>(
        "select (select count(*) from chunks)::text as chunks, (select count(*) from source_items)::text as sources"
      )
    ).rows[0]!;
    return {
      notes: options.notes,
      chunks: Number(counts.chunks),
      sources: Number(counts.sources),
      space,
      indexBuildSeconds,
      maintenanceWorkMem,
      excludedNotes: excluded
    };
  } finally {
    client.release();
  }
}
