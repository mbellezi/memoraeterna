import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import {
  createAtomicNoteRepository,
  vectorScanSettingsSql,
  noteRetrievalDefaults,
  noteTextCandidatesStatement,
  noteVectorCandidatesStatement,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  shownNoteRelationSql
} from "@app/db";
import type { RetrievalFence } from "@app/db";

import { resolveConnection } from "../kpi/connection.js";
import { legacyTextStatement, legacyVectorStatement } from "./legacy-retrieval.js";
import {
  fuseRankings,
  mean,
  overlapAtK,
  summarize,
  summarizePlan,
  textPlanProblems,
  vectorPlanProblems
} from "./retrieval-plan.js";
import type { Distribution, PlanNode } from "./retrieval-plan.js";
import { seedRetrievalLibrary } from "./retrieval-seed.js";
import type { RetrievalSeedSummary } from "./retrieval-seed.js";

/**
 * The EXPLAIN gate and latency proof of the indexed candidate queries of note matching (F3 T49,
 * D28; `rules/data.md`: an index must be usable by the queries that rely on it). Against
 *
 *   --db <connection.json | postgres url>   an existing database, read-only: an ENV-C restore, a
 *                                           fixture restore (the schema must be migrated to 0058), or
 *   --seed                                  a throwaway PostgreSQL sidecar built from the baseline seed
 *                                           and filled with SEED30K: the sources of the synthetic
 *                                           library with notes and vectors that have the statistics
 *                                           retrieval depends on (`retrieval-seed.ts`),
 *
 * for a sample of notes it measures, with the notes' own stored vectors as queries,
 *
 *  - EXPLAIN (ANALYZE) of the text and vector statements: both GIN indexes and an HNSW index (the
 *    partial one of migration 0058, or the global one) are scanned and `atomic_notes` and the
 *    embeddings table are never read sequentially (the gate applies from `--gate-min-rows` notes);
 *  - latency per note (text plus vector) of the new queries and of the queries they replace;
 *  - top-20 overlap of the new queries with the old ones;
 *  - recall@20 of the filtered ANN query against the exact scan with the same filters, plain and
 *    behind a visibility fence.
 *
 * The exit code is 1 when a gate fails.
 */
const usage = `Usage: npx tsx scripts/relations/explain-retrieval.ts (--db <connection.json | url> | --seed) [options]

  --db <value>          Scratch connection file or postgres:// URL; opened read-only.
  --seed                Seed a throwaway sidecar database (SEED30K with retrieval text and vectors).
  --notes <n>           (--seed) atomic notes (default 30000).
  --books <n>           (--seed) root books of the library (default 300 = 3,000 sources).
  --dimensions <n>      (--seed) embedding dimensions: 256, 768 or 1024 (default 768).
  --rng-seed <n>        (--seed) corpus seed (default 20261058).
  --sample <n>          Notes measured (default 200).
  --rounds <n>          Timed passes over the sample after one warm-up pass (default 3).
  --legacy-sample <n>   Notes also run through the old queries (default 30; 0 skips them).
  --explain-sample <n>  Notes whose plans are checked (default 25).
  --relation-sample <n> Existing note relations whose endpoints' candidate lists are checked, old and new (default 150; 0 skips).
  --text-k <n>          Text candidates per note (default 16, textK).
  --vector-k <n>        Vector candidates per note (default 24, vectorK).
  --recall-k <n>        Recall and overlap depth (default 20).
  --fence-share <f>     Share of the root sources a fenced recall run lets through (default 0.1; 0 skips it).
  --gate-min-rows <n>   The EXPLAIN gate applies from this many live notes (default 5000).
  --target-ms <n>       p95 per-note retrieval target (text plus vector) (default 50).
  --recall-target <f>   Filtered ANN recall@k target (default 0.98).
  --plans <file>        Also write the plans of the slowest text and vector statements as text.
  --json <file>         Also write the measurements as JSON.
  --help                Show this text.`;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    seed: { type: "boolean" },
    notes: { type: "string" },
    books: { type: "string" },
    dimensions: { type: "string" },
    "rng-seed": { type: "string" },
    sample: { type: "string" },
    rounds: { type: "string" },
    "legacy-sample": { type: "string" },
    "explain-sample": { type: "string" },
    "relation-sample": { type: "string" },
    "text-k": { type: "string" },
    "vector-k": { type: "string" },
    "recall-k": { type: "string" },
    "fence-share": { type: "string" },
    "gate-min-rows": { type: "string" },
    "target-ms": { type: "string" },
    "recall-target": { type: "string" },
    plans: { type: "string" },
    json: { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true,
  allowPositionals: false
});
if (values.help) {
  console.info(usage);
  process.exit(0);
}
if (Boolean(values.db) === Boolean(values.seed)) {
  console.error(`Pass exactly one of --db and --seed.\n\n${usage}`);
  process.exit(2);
}
const integer = (value: string | undefined, fallback: number, name: string, min = 1): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    console.error(`--${name} must be an integer of at least ${min}.`);
    process.exit(2);
  }
  return parsed;
};
const fraction = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.error(`--${name} must be a number between 0 and 1.`);
    process.exit(2);
  }
  return parsed;
};
const options = {
  notes: integer(values.notes, 30_000, "notes"),
  books: integer(values.books, 300, "books"),
  dimensions: integer(values.dimensions, 768, "dimensions"),
  rngSeed: integer(values["rng-seed"], 20_261_058, "rng-seed", 0),
  sample: integer(values.sample, 200, "sample"),
  rounds: integer(values.rounds, 3, "rounds"),
  legacySample: integer(values["legacy-sample"], 30, "legacy-sample", 0),
  explainSample: integer(values["explain-sample"], 25, "explain-sample"),
  relationSample: integer(values["relation-sample"], 150, "relation-sample", 0),
  textK: integer(values["text-k"], 16, "text-k"),
  vectorK: integer(values["vector-k"], 24, "vector-k"),
  recallK: integer(values["recall-k"], 20, "recall-k"),
  fenceShare: fraction(values["fence-share"], 0.1, "fence-share"),
  gateMinRows: integer(values["gate-min-rows"], 5_000, "gate-min-rows", 0),
  targetMs: integer(values["target-ms"], 50, "target-ms"),
  recallTarget: fraction(values["recall-target"], 0.98, "recall-target")
};
if (![256, 768, 1_024].includes(options.dimensions)) {
  console.error("--dimensions must be 256, 768 or 1024.");
  process.exit(2);
}

function log(message: string): void {
  console.error(`[explain-retrieval] ${message}`);
}

interface Space {
  dimensions: number;
  provider: string;
  model: string;
  runtime: string;
  spaceKey: string;
  vectors: number;
}

/** The embedding space holding the most note vectors: the one note matching reads. */
async function dominantSpace(client: pg.Pool): Promise<Space> {
  const result = await client.query<{
    dimensions: number;
    provider: string;
    model: string;
    runtime: string;
    spaceKey: string;
    vectors: number;
  }>(
    [256, 768, 1_024]
      .map(
        (dimensions) => `select ${dimensions} as dimensions, provider, model, runtime,
              substring(strategy from 11) as "spaceKey", count(*)::int as vectors
         from embeddings_${dimensions}
        where target_type = 'atomic_note' and strategy like 'native-v2:%'
        group by provider, model, runtime, strategy`
      )
      .join(" union all ") + " order by vectors desc limit 1"
  );
  const space = result.rows[0];
  if (!space) throw new Error("The database holds no native-v2 note vector.");
  return space;
}

interface Sample {
  id: string;
  vector: string;
}

async function sampleNotes(client: pg.Pool, space: Space, count: number): Promise<Sample[]> {
  const result = await client.query<Sample>(
    `select n.id, e.embedding::text as vector
       from atomic_notes n
       join embeddings_${space.dimensions} e
         on e.target_type = 'atomic_note' and e.target_id = n.id and e.model = $1
        and e.strategy = 'native-v2:' || $2 and e.provider = $3 and e.runtime = $4
      where n.status not in ('rejected', 'archived') and n.supersession_status = 'current'
      order by md5(n.id::text || 'explain-retrieval')
      limit $5`,
    [space.model, space.spaceKey, space.provider, space.runtime, count]
  );
  return result.rows;
}

/** One note's stored vector in the space, or null when it is not eligible or has none. */
async function sampleOne(client: pg.Pool, space: Space, id: string): Promise<Sample | null> {
  const result = await client.query<Sample>(
    `select n.id, e.embedding::text as vector
       from atomic_notes n
       join embeddings_${space.dimensions} e
         on e.target_type = 'atomic_note' and e.target_id = n.id and e.model = $1
        and e.strategy = 'native-v2:' || $2 and e.provider = $3 and e.runtime = $4
      where n.id = $5 and n.status not in ('rejected', 'archived') and n.supersession_status = 'current'`,
    [space.model, space.spaceKey, space.provider, space.runtime, id]
  );
  return result.rows[0] ?? null;
}

const retrievalIndexNames = (dimensions: number): string[] => [
  "atomic_notes_search_tsv_idx",
  "atomic_notes_title_trgm_idx",
  `embeddings_${dimensions}_note_hnsw_idx`
];

interface PlanRun {
  executionMs: number;
  problems: string[];
  scans: string[];
  text: string;
}

/** EXPLAIN (ANALYZE, BUFFERS) of one statement in a transaction that has the HNSW settings. */
async function explain(
  client: pg.Pool,
  statement: { text: string; values: unknown[] },
  withHnsw: boolean
): Promise<{ run: Omit<PlanRun, "problems">; root: PlanNode }> {
  const connection = await client.connect();
  try {
    await connection.query("begin");
    if (withHnsw) await connection.query(vectorScanSettingsSql);
    const json = await connection.query<{
      "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number }>;
    }>(`explain (analyze, buffers, format json) ${statement.text}`, statement.values);
    const plan = json.rows[0]!["QUERY PLAN"][0]!;
    const text = await connection.query<{ "QUERY PLAN": string }>(
      `explain (analyze, buffers) ${statement.text}`,
      statement.values
    );
    await connection.query("rollback");
    return {
      run: {
        executionMs: plan["Execution Time"],
        scans: summarizePlan(plan.Plan).scans,
        text: text.rows.map((row) => row["QUERY PLAN"]).join("\n")
      },
      root: plan.Plan
    };
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

const ms = (value: number): string => (Number.isNaN(value) ? "n/a" : value.toFixed(2));

const startedAt = Date.now();
let manager: PostgresSidecarManager | null = null;
let workDir: string | null = null;
let pool: pg.Pool | null = null;
try {
  let origin: string;
  let seedSummary: RetrievalSeedSummary | null = null;
  let space: Space;
  if (values.db) {
    const connection = await resolveConnection(values.db);
    origin = `${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`;
    pool = new pg.Pool({
      connectionString: connection.connectionString,
      max: 2,
      options: "-c default_transaction_read_only=on -c statement_timeout=120000"
    });
    space = await dominantSpace(pool);
  } else {
    workDir = await mkdtemp(join(tmpdir(), "memora-explain-retrieval-"));
    const repoRoot = resolve(import.meta.dirname, "../..");
    const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_explain_retrieval",
      user: "memora_explain_retrieval",
      password: `explain-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const started = await manager.start();
    origin = "throwaway sidecar";
    pool = new pg.Pool({ connectionString: started.connectionString, max: 2 });
    log("migrating");
    await runMigrations(pool, resolve(repoRoot, "packages/db/drizzle"), {
      seedFolder: resolve(repoRoot, "packages/db/seed")
    });
    seedSummary = await seedRetrievalLibrary(pool, {
      books: options.books,
      notes: options.notes,
      dimensions: options.dimensions as 256 | 768 | 1_024,
      seed: options.rngSeed,
      log
    });
    space = {
      dimensions: options.dimensions,
      ...seedSummary.space,
      vectors: options.notes
    };
  }

  const library = (
    await pool.query<Record<string, string>>(
      `select (select count(*) from atomic_notes)::text as notes,
              (select count(*) from atomic_notes
                where status not in ('rejected', 'archived') and supersession_status = 'current')::text as "liveNotes",
              (select count(*) from source_items where parent_source_item_id is null)::text as roots`
    )
  ).rows[0]!;
  const liveNotes = Number(library.liveNotes);
  const indexes = (
    await pool.query<{ name: string; valid: boolean; bytes: string }>(
      `select c.relname as name, i.indisvalid as valid, pg_relation_size(c.oid)::text as bytes
         from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = any($1::text[])
        order by c.relname`,
      [retrievalIndexNames(space.dimensions)]
    )
  ).rows;
  const missingIndexes = retrievalIndexNames(space.dimensions).filter(
    (name) => !indexes.some((index) => index.name === name && index.valid)
  );
  log(
    `library: ${JSON.stringify(library)}; space ${space.provider}/${space.model} ${space.dimensions}-d, ${space.vectors} note vectors`
  );
  if (missingIndexes.length > 0)
    log(
      `missing or invalid indexes (is the database migrated to 0058?): ${missingIndexes.join(", ")}`
    );

  const samples = await sampleNotes(pool, space, options.sample);
  if (samples.length === 0) throw new Error("The database holds no note with a vector to measure.");
  const repository = createAtomicNoteRepository(pool);
  const vectorInput = (sample: Sample, extra: { fence?: RetrievalFence } = {}) => ({
    noteId: sample.id,
    embedding: JSON.parse(sample.vector) as number[],
    embeddingModel: space.model,
    embeddingSpaceKey: space.spaceKey,
    embeddingProvider: space.provider,
    embeddingRuntime: space.runtime,
    limit: options.vectorK,
    ...extra
  });
  // Parse each vector once: the loop below runs it through the repository many times.
  const inputs = new Map(samples.map((sample) => [sample.id, vectorInput(sample)]));
  const textInput = (sample: Sample) => ({ noteId: sample.id, limit: options.textK });

  // 1. EXPLAIN gate.
  log(`explaining ${Math.min(options.explainSample, samples.length)} notes`);
  const gateContext = { rows: liveNotes, minRows: options.gateMinRows };
  const textPlans: Array<PlanRun & { id: string }> = [];
  const vectorPlans: Array<PlanRun & { id: string }> = [];
  for (const sample of samples.slice(0, options.explainSample)) {
    const text = await explain(pool, noteTextCandidatesStatement(textInput(sample)), false);
    textPlans.push({
      id: sample.id,
      ...text.run,
      problems: textPlanProblems(summarizePlan(text.root), gateContext)
    });
    const vector = await explain(pool, noteVectorCandidatesStatement(inputs.get(sample.id)!), true);
    vectorPlans.push({
      id: sample.id,
      ...vector.run,
      problems: vectorPlanProblems(summarizePlan(vector.root), space.dimensions, gateContext)
    });
  }
  const slowest = (plans: Array<PlanRun & { id: string }>) =>
    plans.reduce((a, b) => (b.executionMs > a.executionMs ? b : a));
  const planProblems = [
    ...new Set([...textPlans, ...vectorPlans].flatMap((plan) => plan.problems))
  ];
  const slowestText = slowest(textPlans);
  const slowestVector = slowest(vectorPlans);

  // 2. Latency of the indexed queries: warm-up, then timed rounds.
  log("timing the indexed queries");
  const run = async (sample: Sample) => {
    const t0 = performance.now();
    const text = await repository.findTextMatchingCandidates(textInput(sample));
    const t1 = performance.now();
    const vector = await repository.findVectorMatchingCandidates(inputs.get(sample.id)!);
    const t2 = performance.now();
    return { text, vector, textMs: t1 - t0, vectorMs: t2 - t1 };
  };
  for (const sample of samples) await run(sample);
  const textMs: number[] = [];
  const vectorMs: number[] = [];
  const totalMs: number[] = [];
  const latest = new Map<string, Awaited<ReturnType<typeof run>>>();
  for (let round = 0; round < options.rounds; round += 1)
    for (const sample of samples) {
      const result = await run(sample);
      textMs.push(result.textMs);
      vectorMs.push(result.vectorMs);
      totalMs.push(result.textMs + result.vectorMs);
      latest.set(sample.id, result);
    }
  const returned = {
    textMean: mean([...latest.values()].map((result) => result.text.length)),
    vectorMean: mean([...latest.values()].map((result) => result.vector.length)),
    vectorShort: [...latest.values()].filter((result) => result.vector.length < options.vectorK)
      .length
  };

  // 3. Recall of the filtered ANN against the exact scan with the same filters.
  log("measuring recall against the exact scan");
  const exactSql = (text: string): string => {
    const ordered = text.replace(
      "order by e.embedding <=> $2::vector",
      "order by (e.embedding <=> $2::vector) + 0"
    );
    if (ordered === text)
      throw new Error("The vector statement no longer orders by the raw distance.");
    return ordered;
  };
  const exactIds = async (sample: Sample, fence?: RetrievalFence): Promise<string[]> => {
    const statement = noteVectorCandidatesStatement(vectorInput(sample, fence ? { fence } : {}));
    const result = await pool!.query<{ id: string }>(exactSql(statement.text), statement.values);
    return result.rows.map((row) => row.id);
  };
  const recalls: number[] = [];
  for (const sample of samples)
    recalls.push(
      overlapAtK(
        latest.get(sample.id)!.vector.map((candidate) => candidate.note.id),
        await exactIds(sample),
        options.recallK
      )
    );

  let fenced: {
    share: number;
    roots: number;
    recall: number;
    meanReturned: number;
    short: number;
  } | null = null;
  if (options.fenceShare > 0) {
    const rootLimit = Math.max(1, Math.ceil(Number(library.roots) * options.fenceShare));
    const roots = (
      await pool.query<{ id: string }>(
        `select id from source_items where parent_source_item_id is null
          order by md5(id::text || 'explain-retrieval-fence') limit $1`,
        [rootLimit]
      )
    ).rows.map((row) => row.id);
    const fence: RetrievalFence = { rootSourceItemIds: roots };
    const fencedRecalls: number[] = [];
    const fencedReturned: number[] = [];
    let short = 0;
    for (const sample of samples) {
      const ann = await repository.findVectorMatchingCandidates(vectorInput(sample, { fence }));
      const exact = await exactIds(sample, fence);
      fencedRecalls.push(
        overlapAtK(
          ann.map((candidate) => candidate.note.id),
          exact,
          options.recallK
        )
      );
      fencedReturned.push(ann.length);
      if (ann.length < Math.min(options.vectorK, exact.length)) short += 1;
    }
    fenced = {
      share: options.fenceShare,
      roots: roots.length,
      recall: mean(fencedRecalls),
      meanReturned: mean(fencedReturned),
      short
    };
  }

  // 4. The queries they replace: latency, top-20 overlap, and what their candidate lists held of
  // the relations the old pipeline went on to create.
  const oldLists = async (sample: Sample, textLimit: number, vectorLimit: number) => {
    const text = legacyTextStatement(sample.id, textLimit);
    const t0 = performance.now();
    const oldText = await pool!.query<{ id: string }>(text.text, text.values);
    const t1 = performance.now();
    const vector = legacyVectorStatement({
      noteId: sample.id,
      embedding: sample.vector,
      dimensions: space.dimensions,
      model: space.model,
      spaceKey: space.spaceKey,
      provider: space.provider,
      runtime: space.runtime,
      limit: vectorLimit
    });
    const oldVector = await pool!.query<{ id: string }>(vector.text, vector.values);
    const t2 = performance.now();
    return {
      text: oldText.rows.map((row) => row.id),
      vector: oldVector.rows.map((row) => row.id),
      textMs: t1 - t0,
      vectorMs: t2 - t1
    };
  };
  const ids = (candidates: Array<{ note: { id: string } }>): string[] =>
    candidates.map((candidate) => candidate.note.id);
  let legacy: {
    notes: number;
    textMs: Distribution;
    vectorMs: Distribution;
    totalMs: Distribution;
    textOverlap: number;
    vectorOverlap: number;
    fusedOverlap: number;
  } | null = null;
  if (options.legacySample > 0) {
    log(`running the old queries on ${Math.min(options.legacySample, samples.length)} notes`);
    const legacyText: number[] = [];
    const legacyVector: number[] = [];
    const legacyTotal: number[] = [];
    const textOverlaps: number[] = [];
    const vectorOverlaps: number[] = [];
    const fusedOverlaps: number[] = [];
    for (const sample of samples.slice(0, options.legacySample)) {
      const old = await oldLists(sample, 30, 30);
      legacyText.push(old.textMs);
      legacyVector.push(old.vectorMs);
      legacyTotal.push(old.textMs + old.vectorMs);
      const fresh = latest.get(sample.id)!;
      const wide = {
        text: ids(await repository.findTextMatchingCandidates({ noteId: sample.id, limit: 30 })),
        vector: ids(
          await repository.findVectorMatchingCandidates({ ...inputs.get(sample.id)!, limit: 30 })
        )
      };
      textOverlaps.push(overlapAtK(wide.text, old.text, options.recallK));
      vectorOverlaps.push(overlapAtK(wide.vector, old.vector, options.recallK));
      // What reaches the decider: the two rankings fused with RRF at the preset depths (old text
      // 20 and vector 20; new text and vector as configured), top 20.
      fusedOverlaps.push(
        overlapAtK(
          fuseRankings([ids(fresh.text), ids(fresh.vector)], 60),
          fuseRankings([old.text.slice(0, 20), old.vector.slice(0, 20)], 60),
          options.recallK
        )
      );
    }
    legacy = {
      notes: legacyText.length,
      textMs: summarize(legacyText),
      vectorMs: summarize(legacyVector),
      totalMs: summarize(legacyTotal),
      textOverlap: mean(textOverlaps),
      vectorOverlap: mean(vectorOverlaps),
      fusedOverlap: mean(fusedOverlaps)
    };
  }

  // Relations the old pipeline created (any status but rejected): is the partner in either
  // endpoint's candidate lists, old and new? Only relations between eligible notes with vectors.
  let relationCoverage: {
    relations: number;
    oldCovered: number;
    newCovered: number;
    newTextOnly: number;
    newVectorOnly: number;
  } | null = null;
  if (options.relationSample > 0) {
    const relations = (
      await pool.query<{ a: string; b: string }>(
        `select r.source_atomic_note_id as a, r.target_atomic_note_id as b
           from atomic_note_relations r
          where ${shownNoteRelationSql("r")}
          order by md5(r.id::text) limit $1`,
        [options.relationSample]
      )
    ).rows;
    if (relations.length > 0) {
      log(`checking the candidate lists against ${relations.length} existing relations`);
      const lists = new Map<
        string,
        { oldUnion: Set<string>; newText: Set<string>; newVector: Set<string> } | null
      >();
      const listsOf = async (id: string) => {
        if (lists.has(id)) return lists.get(id)!;
        const found = await sampleOne(pool!, space, id);
        let entry = null;
        if (found) {
          const old = await oldLists(found, 20, 20);
          const newText = ids(await repository.findTextMatchingCandidates(textInput(found)));
          const newVector = ids(await repository.findVectorMatchingCandidates(vectorInput(found)));
          entry = {
            oldUnion: new Set([...old.text, ...old.vector]),
            newText: new Set(newText),
            newVector: new Set(newVector)
          };
        }
        lists.set(id, entry);
        return entry;
      };
      let measured = 0;
      let oldCovered = 0;
      let newCovered = 0;
      let newTextOnly = 0;
      let newVectorOnly = 0;
      for (const { a, b } of relations) {
        const [la, lb] = [await listsOf(a), await listsOf(b)];
        if (!la || !lb) continue;
        measured += 1;
        const inOld = la.oldUnion.has(b) || lb.oldUnion.has(a);
        const inText = la.newText.has(b) || lb.newText.has(a);
        const inVector = la.newVector.has(b) || lb.newVector.has(a);
        if (inOld) oldCovered += 1;
        if (inText || inVector) newCovered += 1;
        if (inText && !inVector) newTextOnly += 1;
        if (inVector && !inText) newVectorOnly += 1;
      }
      relationCoverage = {
        relations: measured,
        oldCovered,
        newCovered,
        newTextOnly,
        newVectorOnly
      };
    }
  }

  const total = summarize(totalMs);
  const recall = mean(recalls);
  const gates = {
    indexes: missingIndexes.length === 0,
    explain: planProblems.length === 0,
    latency: total.p95 <= options.targetMs,
    recall: recall >= options.recallTarget
  };
  const passed = Object.values(gates).every(Boolean);
  const report = {
    origin,
    library: { ...library, space },
    seed: seedSummary,
    indexes,
    missingIndexes,
    sampledNotes: samples.length,
    rounds: options.rounds,
    explain: {
      gateApplied: liveNotes >= options.gateMinRows,
      problems: planProblems,
      text: {
        notes: textPlans.length,
        slowestMs: slowestText.executionMs,
        scans: slowestText.scans
      },
      vector: {
        notes: vectorPlans.length,
        slowestMs: slowestVector.executionMs,
        scans: slowestVector.scans
      }
    },
    latencyMs: {
      text: summarize(textMs),
      vector: summarize(vectorMs),
      total
    },
    returned,
    recall: { atK: options.recallK, mean: recall, target: options.recallTarget, fenced },
    legacy,
    relationCoverage,
    gates,
    passed,
    wallSeconds: Math.round((Date.now() - startedAt) / 1000)
  };

  const row = (name: string, d: Distribution) =>
    `| ${name} | ${d.count} | ${ms(d.p50)} | ${ms(d.p95)} | ${ms(d.p99)} | ${ms(d.max)} |`;
  console.info(
    [
      `Note retrieval on ${origin}`,
      `library: ${Object.entries(library)
        .map(([key, value]) => `${key} ${value}`)
        .join(", ")}; ${space.dimensions}-d space ${space.model} (${space.vectors} note vectors)`,
      `indexes: ${indexes.map((index) => `${index.name} ${index.valid ? "valid" : "INVALID"} ${(Number(index.bytes) / 1_048_576).toFixed(1)} MB`).join("; ") || "none"}`,
      ...(seedSummary
        ? [
            `index build seconds (SEED, maintenance_work_mem ${seedSummary.maintenanceWorkMem}): ${JSON.stringify(seedSummary.indexBuildSeconds)}`
          ]
        : []),
      "",
      `EXPLAIN gate (${report.explain.gateApplied ? "applied" : `reported only below ${options.gateMinRows} live notes`}): ${planProblems.length === 0 ? "PASS" : `FAIL: ${planProblems.join("; ")}`}`,
      `  text scans, slowest of ${textPlans.length} (${ms(slowestText.executionMs)} ms): ${slowestText.scans.join("; ")}`,
      `  vector scans, slowest of ${vectorPlans.length} (${ms(slowestVector.executionMs)} ms): ${slowestVector.scans.join("; ")}`,
      "",
      `| Indexed queries (ms) | Calls | p50 | p95 | p99 | max |`,
      "| --- | --- | --- | --- | --- | --- |",
      row(`text (k ${options.textK})`, report.latencyMs.text),
      row(`vector (k ${options.vectorK})`, report.latencyMs.vector),
      row("text + vector per note", total),
      ...(legacy
        ? [
            row("old text", legacy.textMs),
            row("old vector", legacy.vectorMs),
            row("old text + vector per note", legacy.totalMs)
          ]
        : []),
      "",
      `Per-note p95 <= ${options.targetMs} ms: ${gates.latency ? "PASS" : "FAIL"} (${ms(total.p95)} ms)`,
      `Rows returned per note: text ${returned.textMean.toFixed(1)} of ${options.textK}, vector ${returned.vectorMean.toFixed(1)} of ${options.vectorK} (${returned.vectorShort} notes got fewer than ${options.vectorK})`,
      `ANN recall@${options.recallK} against the exact scan with the same filters: ${recall.toFixed(4)} (target ${options.recallTarget}): ${gates.recall ? "PASS" : "FAIL"}`,
      ...(fenced
        ? [
            `  behind a fence of ${fenced.roots} root(s) (${(fenced.share * 100).toFixed(0)}%): recall ${fenced.recall.toFixed(4)}, ${fenced.meanReturned.toFixed(1)} rows per note, ${fenced.short} note(s) short of the exact count`
          ]
        : []),
      ...(legacy
        ? [
            `Top-${options.recallK} overlap with the old queries (${legacy.notes} notes): text ${legacy.textOverlap.toFixed(3)}, vector ${legacy.vectorOverlap.toFixed(3)}, fused (RRF of the two) ${legacy.fusedOverlap.toFixed(3)}`
          ]
        : []),
      ...(relationCoverage
        ? [
            `Existing relations whose partner is in a candidate list of either endpoint (${relationCoverage.relations} relations): old text 20 + vector 20 ${relationCoverage.oldCovered}, new text ${options.textK} + vector ${options.vectorK} ${relationCoverage.newCovered} (only through text ${relationCoverage.newTextOnly}, only through vectors ${relationCoverage.newVectorOnly})`
          ]
        : []),
      `Gates: ${Object.entries(gates)
        .map(([name, ok]) => `${name} ${ok ? "PASS" : "FAIL"}`)
        .join(", ")}`
    ].join("\n")
  );
  if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`);
  if (values.plans)
    await writeFile(
      resolve(values.plans),
      [
        `-- text statement, slowest of ${textPlans.length} (note ${slowestText.id})`,
        slowestText.text,
        "",
        `-- vector statement, slowest of ${vectorPlans.length} (note ${slowestVector.id}); hnsw.iterative_scan = relaxed_order, hnsw.ef_search = ${noteRetrievalDefaults.hnswEfSearch}, random_page_cost = ${noteRetrievalDefaults.randomPageCost}`,
        slowestVector.text,
        ""
      ].join("\n")
    );
  if (!passed) process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  if (manager) await manager.stop().catch(() => undefined);
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
