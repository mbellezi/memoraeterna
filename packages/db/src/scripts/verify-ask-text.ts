import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import {
  contentTsvectorCalls,
  storedVectorReads,
  type PlanNode
} from "../repositories/consultationPlan.js";
import { consultationCandidatesSql } from "../repositories/consultationRepository.js";
import { splitSqlStatements } from "../seed.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";

/**
 * Real-PostgreSQL verification of migration 0064 `ask_text_vectors` (F4 T79; D22): the stored
 * `chunks.search_tsv` and `atomic_notes.ask_tsv` and the evidence index that Ask's candidates
 * statement reads.
 *
 *   npm run db:ask-text:verify
 *       A temporary PostgreSQL sidecar (never an existing database): a library at the migration
 *       before 0064 gets it as pending, each step timed apart (the two table rewrites, the index);
 *       then the checks below, an empty database through the baseline seed (same definitions), and
 *       a writer that never names the new columns.
 *   npm run db:ask-text:verify -- --db <postgres URL | scratch connection .json>
 *       An existing scratch database (a restore or an APFS clone, never a live profile; gate M).
 *       Any migration before 0064 is applied first, timed apart; 0064 is applied step by step,
 *       timed, and recorded in the history as the migrator would; then the same checks. Prints one
 *       JSON summary. Loopback only.
 *   npm run db:ask-text:verify -- --db <...> --before-only
 *       Applies only the migrations before 0064 (timed) and stops: the "before" state of a clone,
 *       on which the candidates statement is measured before it is migrated.
 *
 * Checks: both columns are stored generated tsvectors and never null; each equals, for every row,
 * the document the candidates statement built per row before (`to_tsvector('simple', unaccent(...))`),
 * so `ts_rank_cd` gives the same rank for any question (also compared on a sample of questions,
 * to 1e-9); the evidence index is valid; nothing indexes the vectors; the candidates statement
 * reads the vectors and parses no text of a passage or a note; a second run has nothing to apply.
 */
export const askTextTag = "0064_ask_text_vectors";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const breakpointStep = /^\s*(?:--[^\n]*\n\s*)*/u;

interface Journal {
  entries: Array<{ tag: string; when: number }>;
}

const readJournal = async (folder: string): Promise<Journal> =>
  JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8")) as Journal;

/** A copy of the migrations folder that ends right before `tag`, as a profile before it. */
async function migrationsBefore(tag: string, workDir: string): Promise<string> {
  const folder = join(workDir, "migrations-before");
  await rm(folder, { recursive: true, force: true });
  await cp(migrationsFolder, folder, { recursive: true });
  const journal = await readJournal(folder);
  const position = journal.entries.findIndex((entry) => entry.tag === tag);
  assert.ok(position > 0, `${tag} is in the journal`);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }, null, 2)
  );
  return folder;
}

const historyCount = async (db: PgPool): Promise<number> =>
  Number(
    (
      await db.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations"
      )
    ).rows[0]!.count
  );

const hasColumn = async (db: PgPool, table: string, column: string): Promise<boolean> =>
  (
    await db.query(
      "select 1 from information_schema.columns where table_name = $1 and column_name = $2",
      [table, column]
    )
  ).rowCount === 1;

interface Step {
  step: string;
  ms: number;
}

/**
 * Applies the migration statement by statement in one transaction (as the migrator does), timing
 * each apart, and records it in the history with the hash and time the migrator records.
 */
async function applySteps(db: PgPool): Promise<{ steps: Step[]; ms: number }> {
  const sql = await readFile(join(migrationsFolder, `${askTextTag}.sql`), "utf8");
  const when = (await readJournal(migrationsFolder)).entries.find(
    (entry) => entry.tag === askTextTag
  )!.when;
  const client = await db.connect();
  const steps: Step[] = [];
  const started = performance.now();
  try {
    await client.query("begin");
    for (const statement of splitSqlStatements(sql)) {
      const from = performance.now();
      await client.query(statement);
      const label = statement.replace(breakpointStep, "").slice(0, 80).replace(/\s+/gu, " ");
      steps.push({ step: label, ms: Math.round(performance.now() - from) });
    }
    await client.query(
      'insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)',
      [createHash("sha256").update(sql).digest("hex"), when]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { steps, ms: Math.round(performance.now() - started) };
}

const questionTerms = `terms as(select to_tsquery('simple',coalesce(nullif(string_agg(quote_literal(word),' | '),''),'''__empty__''')) as q from (select distinct unnest(tsvector_to_array(to_tsvector('simple',unaccent($1)))) as word) words)`;

async function tableSizes(db: PgPool): Promise<Record<string, number>> {
  const sizes = await db.query<Record<string, string>>(
    `select pg_total_relation_size('chunks')::text as chunks, pg_total_relation_size('atomic_notes')::text as notes`
  );
  return Object.fromEntries(
    Object.entries(sizes.rows[0]!).map(([key, value]) => [`${key}Bytes`, Number(value)])
  );
}

async function verifyState(db: PgPool, label: string) {
  // 0064 is recorded; later migrations (0065 on) may follow it, and none is missing before it.
  const journal = await readJournal(migrationsFolder);
  const through = journal.entries.findIndex((entry) => entry.tag === askTextTag) + 1;
  const recorded = await historyCount(db);
  assert.ok(
    recorded >= through && recorded <= journal.entries.length,
    `${label}: ${recorded} migrations recorded, ${through} through ${askTextTag}`
  );
  // 1. Both columns are stored, generated, tsvector, never null.
  for (const [table, column] of [
    ["chunks", "search_tsv"],
    ["atomic_notes", "ask_tsv"]
  ] as const) {
    const column_ = await db.query<{ type: string; generated: string }>(
      `select format_type(a.atttypid, a.atttypmod) as type, a.attgenerated as generated
         from pg_attribute a where a.attrelid = $1::regclass and a.attname = $2`,
      [table, column]
    );
    assert.deepEqual(
      column_.rows[0],
      { type: "tsvector", generated: "s" },
      `${label}: ${table}.${column}`
    );
    const nulls = await db.query<{ count: string }>(
      `select count(*)::text as count from ${table} where ${column} is null`
    );
    assert.equal(nulls.rows[0]!.count, "0", `${label}: ${table}.${column} is never null`);
  }
  // 2. Each equals, for every row, the document the statement built per row before.
  const rows = (
    await db.query<{ chunks: number; notes: number; chunkMismatch: number; noteMismatch: number }>(
      `select (select count(*) from chunks)::int as chunks, (select count(*) from atomic_notes)::int as notes,
              (select count(*) from chunks where search_tsv is distinct from to_tsvector('simple', unaccent(content)))::int as "chunkMismatch",
              (select count(*) from atomic_notes where ask_tsv is distinct from
                 to_tsvector('simple', unaccent(idea_statement || ' ' || body_markdown)))::int as "noteMismatch"`
    )
  ).rows[0]!;
  assert.equal(rows.chunkMismatch, 0, `${label}: chunks.search_tsv equals the per-row document`);
  assert.equal(rows.noteMismatch, 0, `${label}: atomic_notes.ask_tsv equals the per-row document`);
  // 3. The same ranks for a sample of questions, to 1e-9 (a rank is a function of the document).
  const questions = (
    await db.query<{ content: string }>(
      "select content from chunks order by md5(id::text) limit 12"
    )
  ).rows.map((row) => row.content.split(/\s+/u).slice(0, 7).join(" "));
  questions.push("???", "unrelated words only", "memória ação ÁGUA");
  let largest = 0;
  let ranked = 0;
  for (const question of questions) {
    const { rows: result } = await db.query<{
      chunkDiff: number | null;
      noteDiff: number | null;
      positive: number;
    }>(
      `with ${questionTerms}
       select (select max(abs(ts_rank_cd(c.search_tsv, terms.q)::float8 - ts_rank_cd(to_tsvector('simple', unaccent(c.content)), terms.q)::float8))
                 from (select * from chunks order by md5(id::text) limit 400) c cross join terms)::float8 as "chunkDiff",
              (select max(abs(ts_rank_cd(n.ask_tsv, terms.q)::float8 - ts_rank_cd(to_tsvector('simple', unaccent(n.idea_statement || ' ' || n.body_markdown)), terms.q)::float8))
                 from (select * from atomic_notes order by md5(id::text) limit 400) n cross join terms)::float8 as "noteDiff",
              (select count(*) from (select * from chunks order by md5(id::text) limit 400) c cross join terms
                where ts_rank_cd(c.search_tsv, terms.q) > 0)::int as positive`,
      [question]
    );
    largest = Math.max(largest, result[0]!.chunkDiff ?? 0, result[0]!.noteDiff ?? 0);
    ranked += result[0]!.positive;
  }
  assert.ok(largest <= 1e-9, `${label}: ranks differ by ${largest}`);
  // 4. The evidence index is valid and says what the note lookup needs; nothing indexes the vectors.
  const index = await db.query<{ valid: boolean; definition: string }>(
    `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
       from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'atomic_notes_evidence_chunk_id_idx'`
  );
  assert.equal(index.rows[0]?.valid, true, `${label}: the evidence index is valid`);
  assert.match(index.rows[0]!.definition, /USING btree \(evidence_chunk_id\)/u);
  const onVectors = await db.query(
    `select 1 from pg_indexes where (tablename = 'chunks' and indexdef like '%search_tsv%')
        or (tablename = 'atomic_notes' and indexdef like '%ask_tsv%')`
  );
  assert.equal(
    onVectors.rowCount,
    0,
    `${label}: no index on the vectors (the statement has no @@)`
  );
  // 5. The candidates statement reads the vectors and parses no text of a passage or a note.
  const sources = (
    await db.query<{ id: string }>("select id from source_items order by id limit 50")
  ).rows.map((row) => row.id);
  const plan = (
    await db.query(`explain (verbose, format json) ${consultationCandidatesSql}`, [
      sources,
      questions[0] ?? "question",
      false,
      [],
      null
    ])
  ).rows[0]!["QUERY PLAN"] as { Plan: PlanNode }[];
  assert.deepEqual(
    contentTsvectorCalls(plan[0]!.Plan),
    [],
    `${label}: no content to_tsvector( in the plan`
  );
  assert.deepEqual(storedVectorReads(plan[0]!.Plan), { passages: true, notes: true });
  // 6. A second run does not apply 0064 again: only the migrations after it, if any, run.
  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), journal.entries.length, `${label}: nothing left to apply`);
  const hash = createHash("sha256")
    .update(await readFile(join(migrationsFolder, `${askTextTag}.sql`), "utf8"))
    .digest("hex");
  const recordedOnce = await db.query(
    "select 1 from drizzle.__drizzle_migrations where hash = $1",
    [hash]
  );
  assert.equal(recordedOnce.rowCount, 1, `${label}: ${askTextTag} is recorded once`);
  return {
    chunks: rows.chunks,
    notes: rows.notes,
    tsvectorMismatches: 0,
    largestRankDifference: largest,
    questionsCompared: questions.length,
    positiveRankings: ranked
  };
}

/** Two sources of accented, repetitive text: a library for the self-contained run. */
async function seedLibrary(db: PgPool): Promise<void> {
  const vocabulary = [
    "memória",
    "ação",
    "coração",
    "água",
    "fotossíntese",
    "luz",
    "azúcar",
    "network",
    "neural",
    "gradient",
    "descent",
    "ÁRVORE",
    "Árvore",
    "señal",
    "über",
    "naïve",
    "café",
    "plain",
    "text"
  ];
  let state = 20_261_023;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
  };
  const sentence = (words: number) =>
    Array.from({ length: words }, () => vocabulary[next() % vocabulary.length]).join(" ");
  for (let s = 0; s < 12; s += 1) {
    const source = randomUUID();
    const document = randomUUID();
    await db.query("insert into source_items (id, type, title) values ($1, 'Book', $2)", [
      source,
      `Fonte ${s} — ${sentence(3)}`
    ]);
    await db.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', $3)",
      [document, source, `d-${s}`]
    );
    for (let c = 0; c < 50; c += 1) {
      const chunk = randomUUID();
      await db.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, $5, $6)`,
        [chunk, document, source, c, sentence(40 + (next() % 120)), `c-${s}-${c}`]
      );
      if (c % 2 === 0)
        await db.query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
             evidence_chunk_id, generation_provider, generation_model, generation_runtime,
             generation_prompt_version, generation_key, status)
           values ($1::uuid, $2, $3, $4, $5, $6, 't', 't', 'local', 't', $1::text, 'active')`,
          [randomUUID(), sentence(4), sentence(60), sentence(12), source, chunk]
        );
    }
  }
}

async function selfContained() {
  const workDir = await mkdtemp(join(tmpdir(), "memora-ask-text-db-"));
  const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: join(workDir, "data"),
    database: "memora_ask_text",
    user: "memora_ask_text",
    password: `ask-text-${randomUUID()}`,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000
  });
  const pools: PgPool[] = [];
  try {
    const connection = await manager.start();
    const history = createPgPool({ connectionString: connection.connectionString, max: 3 });
    pools.push(history);
    const before = await migrationsBefore(askTextTag, workDir);
    await runMigrations(history, before);
    assert.equal(await hasColumn(history, "chunks", "search_tsv"), false, "no vector before 0064");
    await seedLibrary(history);
    const sizesBefore = await tableSizes(history);
    const applied = await applySteps(history);
    const state = await verifyState(history, "history");
    // A writer that never names the new columns still fills them.
    const source = randomUUID();
    const document = randomUUID();
    await history.query("insert into source_items (id, type, title) values ($1, 'Book', 'Novo')", [
      source
    ]);
    await history.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', 'new')",
      [document, source]
    );
    const written = await history.query<{ matches: boolean }>(
      `insert into chunks (document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, 0, 'Coração e ÁGUA', 'new-chunk') returning search_tsv @@ to_tsquery('simple', 'coracao & agua') as matches`,
      [document, source]
    );
    assert.equal(written.rows[0]?.matches, true, "a new passage gets its vector from the database");
    await assert.rejects(
      history.query(
        `insert into chunks (document_id, source_item_id, chunk_index, content, content_hash, search_tsv)
         values ($1, $2, 1, 'x', 'y', null)`,
        [document, source]
      ),
      (error: { code?: string }) => error.code === "428C9",
      "a stored generated column refuses a value"
    );

    // An empty database: the baseline seed carries 0064 with the same definitions.
    await history.query("create database memora_ask_text_empty");
    const empty = createPgPool({
      connectionString: connection.connectionString.replace(
        /\/[^/?]+(\?|$)/u,
        "/memora_ask_text_empty$1"
      ),
      max: 2
    });
    pools.push(empty);
    const seeded = await runMigrations(empty, migrationsFolder, { seedFolder });
    assert.ok(seeded.seed.applied && seeded.seed.seededMigrations.includes(askTextTag));
    const shapes = async (db: PgPool) =>
      (
        await db.query(
          `select a.attrelid::regclass::text as relation, a.attname, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) as expression
             from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attname in ('search_tsv', 'ask_tsv') and a.attrelid in ('chunks'::regclass, 'atomic_notes'::regclass)
            order by 1, 2`
        )
      ).rows;
    assert.deepEqual(
      await shapes(empty),
      await shapes(history),
      "the baseline gives the same columns"
    );
    console.info(
      JSON.stringify({
        verified: [
          "history database: only 0064 ran, step by step; both vectors stored, generated, never null",
          "every row equals the per-row unaccent() document; ranks equal to 1e-9 on a sample of questions",
          "evidence index valid; no index on the vectors",
          "the candidates statement reads the vectors and parses no text of a passage or a note",
          "a writer that never names the columns fills them; the column refuses a value",
          "empty database: the baseline seed carries the same columns"
        ],
        migrationMs: applied.ms,
        steps: applied.steps,
        sizesBefore,
        sizesAfter: await tableSizes(history),
        ...state
      })
    );
  } finally {
    for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
    await manager.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function connectionStringOf(value: string): Promise<string> {
  if (/^postgres(ql)?:\/\//u.test(value)) return value;
  const file = JSON.parse(await readFile(resolve(value), "utf8")) as { connectionString?: unknown };
  if (typeof file.connectionString !== "string")
    throw new Error(`${value} has no connectionString.`);
  return file.connectionString;
}

/**
 * Gate M on the existing scratch database: every migration before 0064 that is pending is applied
 * first (timed apart), then 0064 step by step, then the checks. A database that already holds 0064
 * is only checked.
 */
export async function verifyExistingDatabase(
  connectionString: string,
  options: { beforeOnly?: boolean } = {}
) {
  const db = createPgPool({ connectionString, max: 3 });
  const workDir = await mkdtemp(join(tmpdir(), "memora-ask-text-existing-"));
  try {
    const journal = await readJournal(migrationsFolder);
    const position = journal.entries.findIndex((entry) => entry.tag === askTextTag);
    const head = await historyCount(db);
    if (head > journal.entries.length)
      throw new Error(
        `The database has ${head} migrations; this code knows ${journal.entries.length}.`
      );
    const alreadyApplied = (await hasColumn(db, "chunks", "search_tsv")) && head > position;
    let earlier: { migrations: number; ms: number } | null = null;
    let applied: { steps: Step[]; ms: number } | null = null;
    const sizesBefore = await tableSizes(db);
    if (!alreadyApplied) {
      if (head < position) {
        const started = performance.now();
        await runMigrations(db, await migrationsBefore(askTextTag, workDir));
        earlier = { migrations: position - head, ms: Math.round(performance.now() - started) };
      }
      assert.equal(await historyCount(db), position, "the database stands right before 0064");
      if (options.beforeOnly)
        return {
          head: { before: head, after: position, total: journal.entries.length },
          earlierMigrations: earlier,
          stoppedBefore: askTextTag
        };
      applied = await applySteps(db);
    }
    const state = await verifyState(db, "existing");
    return {
      head: { before: head, after: await historyCount(db), total: journal.entries.length },
      earlierMigrations: earlier,
      migration: applied,
      sizesBefore: alreadyApplied ? null : sizesBefore,
      sizesAfter: await tableSizes(db),
      ...state
    };
  } finally {
    await closePgPool(db).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function existingDatabase(value: string, beforeOnly: boolean) {
  const connectionString = await connectionStringOf(value);
  const host = new URL(connectionString).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
    throw new Error("Only a loopback scratch database is verified.");
  const summary = await verifyExistingDatabase(connectionString, { beforeOnly });
  console.info(
    JSON.stringify({ database: new URL(connectionString).pathname.slice(1), ...summary }, null, 2)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { db: { type: "string" }, "before-only": { type: "boolean" } },
    strict: true
  });
  if (values["before-only"] && !values.db) throw new Error("--before-only needs --db.");
  await (values.db ? existingDatabase(values.db, values["before-only"] === true) : selfContained());
}
