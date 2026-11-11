import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { topicRecord } from "@app/domain/topic-tree";

import {
  closePgPool,
  createPgPool,
  createQuestionRepository,
  createSourceItemRepository,
  createTopicOverviewRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  questionListOrder,
  questionSearchCondition,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type Queryable
} from "../index.js";

/**
 * Real-database check of migration `0066_questions` (F5 T116, D14): on a database with history only
 * the new migration runs and creates the three tables, on an empty one the baseline brings the
 * same shape; the columns, types, checks and indexes are what the design states; an insert, the
 * cascade delete and the generated `search_tsv` behave; EXPLAIN shows the full-text and the trigram
 * indexes (and the keyset index of the list) used; and each citation hash expression computes, on a
 * fixture row, what an independent computation of the same bytes does. It starts its own temporary
 * PostgreSQL sidecar and never touches an existing database.
 */
const migrationName = "0066_questions";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-questions-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_questions",
  user: "memora_questions",
  password: `questions-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface Journal {
  entries: Array<{ tag: string }>;
}

/** Applies every migration before 0066 from a copy of the folder, as a profile from before it. */
async function migrateBefore(db: PgPool, journal: Journal): Promise<void> {
  const folder = join(workDir, "migrations-before");
  await cp(migrationsFolder, folder, { recursive: true });
  const position = journal.entries.findIndex((entry) => entry.tag === migrationName);
  assert.ok(position > 0, "the migration is in the journal");
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }, null, 2)
  );
  await runMigrations(db, folder);
}

/** The three tables' columns, checks, indexes and keys, as the catalog states them. */
async function shape(db: Queryable) {
  const lines = async (sql: string) =>
    (await db.query<{ line: string }>(sql)).rows.map((row) => row.line);
  return {
    columns: await lines(
      `select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' ||
              coalesce(column_default, '') || ':' || coalesce(generation_expression, '') as line
         from information_schema.columns where table_name in ('questions','question_answers','question_citations')
        order by table_name, column_name`
    ),
    constraints: await lines(
      `select conrelid::regclass || '.' || conname || ':' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid in ('questions'::regclass, 'question_answers'::regclass, 'question_citations'::regclass)
        order by 1`
    ),
    indexes: await lines(
      `select indexdef as line from pg_indexes
        where tablename in ('questions','question_answers','question_citations') order by indexname`
    )
  };
}

/** A statement a check or key must refuse (SQLSTATE class 23). */
async function refused(db: Queryable, label: string, sql: string, values: unknown[] = []) {
  try {
    await db.query(sql, values);
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    assert.ok(code.startsWith("23"), `${label}: refused with ${code}`);
    return;
  }
  assert.fail(`${label}: the table accepted it`);
}

/** The plan of a statement with sequential scans off, so a usable index is the cheapest path. */
async function plan(db: PgPool, sql: string, values: unknown[] = []): Promise<string> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const rows = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, values);
    await client.query("rollback");
    return rows.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    client.release();
  }
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const report: Record<string, unknown> = {};
const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const admin = createPgPool({ connectionString: connection.connectionString, max: 2 });
  pools.push(admin);
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")
  ) as Journal;
  const databaseUrl = (name: string) => {
    const url = new URL(connection.connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  };

  // 1. A database with history: the tables are absent, then the one pending migration creates them.
  await admin.query("create database memora_questions_history");
  const db = createPgPool({ connectionString: databaseUrl("memora_questions_history"), max: 4 });
  pools.push(db);
  await migrateBefore(db, journal);
  const absent = await db.query(
    "select to_regclass('questions') as q, to_regclass('question_answers') as a"
  );
  assert.deepEqual(absent.rows[0], { q: null, a: null }, "no question table before 0066");
  const sources = await createSourceItemRepository(db).create({ type: "Book", title: "Kept" });
  await runMigrations(db, migrationsFolder);
  const history = await db.query("select count(*)::int as count from drizzle.__drizzle_migrations");
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, "history records 0066");
  const kept = await db.query("select title from source_items where id = $1", [sources.id]);
  assert.equal(kept.rows[0]?.title, "Kept", "existing rows are untouched");
  const after = await shape(db);

  // 2. The shape the design states.
  const expectedColumns = [
    "question_answers.completed_at:timestamp with time zone:YES::",
    "question_answers.id:uuid:NO:gen_random_uuid():",
    "question_answers.paragraphs:jsonb:NO::",
    "question_answers.provenance:jsonb:NO::",
    "question_answers.question_id:uuid:NO::",
    "question_answers.started_at:timestamp with time zone:NO::",
    "question_answers.status:text:NO::",
    "question_answers.version:integer:NO::",
    "question_citations.anchor:jsonb:YES::",
    "question_citations.answer_id:uuid:NO::",
    "question_citations.content_hash:text:NO::",
    "question_citations.ordinal:integer:NO::",
    "question_citations.target_id:uuid:NO::",
    "question_citations.target_kind:text:NO::",
    "questions.created_at:timestamp with time zone:NO:now():",
    "questions.error_key:text:YES::",
    "questions.id:uuid:NO:gen_random_uuid():",
    "questions.language:character varying:NO:'und'::character varying:",
    "questions.mode:text:NO::",
    "questions.privacy:text:NO::",
    'questions.scope:jsonb:NO:\'{"kind": "library"}\'::jsonb:',
    "questions.search_tsv:tsvector:YES::to_tsvector('simple'::regconfig, f_unaccent(text))",
    "questions.status:text:NO::",
    "questions.text:text:NO::",
    "questions.updated_at:timestamp with time zone:NO:now():"
  ];
  assert.deepEqual(after.columns, expectedColumns, "columns, types, nullability and defaults");
  const indexNames = after.indexes.map((line) => /INDEX (\S+) ON/.exec(line)?.[1] ?? "").sort();
  assert.deepEqual(
    indexNames,
    [
      "question_answers_pkey",
      "question_answers_question_id_version_unique",
      "question_citations_answer_id_ordinal_pk",
      "question_citations_target_idx",
      "questions_created_at_idx",
      "questions_pkey",
      "questions_search_tsv_idx",
      "questions_text_trgm_idx"
    ],
    "indexes"
  );
  const definition = (name: string) =>
    after.indexes.find((line) => line.includes(` ${name} `)) ?? "";
  assert.ok(definition("questions_search_tsv_idx").includes("USING gin (search_tsv)"), "tsv GIN");
  assert.ok(
    definition("questions_text_trgm_idx").includes("USING gin (f_unaccent(text) gin_trgm_ops)"),
    "trigram GIN over f_unaccent(text)"
  );
  assert.ok(
    definition("questions_created_at_idx").includes(
      "(created_at DESC NULLS LAST, id DESC NULLS LAST)"
    ),
    "keyset index"
  );
  for (const name of [
    "questions_text",
    "questions_mode",
    "questions_status",
    "question_answers_version",
    "question_answers_status",
    "question_citations_ordinal",
    "question_citations_kind"
  ])
    assert.ok(
      after.constraints.some((line) => line.includes(`.${name}:CHECK`)),
      `check ${name}`
    );
  assert.ok(
    after.constraints.some(
      (line) =>
        line.includes("question_answers_question_id_questions_id_fk") &&
        line.includes("ON DELETE CASCADE")
    ) &&
      after.constraints.some(
        (line) =>
          line.includes("question_citations_answer_id_question_answers_id_fk") &&
          line.includes("ON DELETE CASCADE")
      ),
    "both foreign keys cascade"
  );
  assert.ok(
    !after.constraints.some((line) => /FOREIGN KEY \(target_id\)/.test(line)),
    "no foreign key from target_id: a deleted target leaves an unavailable citation"
  );
  const invalid = await db.query(
    `select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid in ('questions'::regclass, 'question_answers'::regclass, 'question_citations'::regclass)
        and not i.indisvalid`
  );
  assert.equal(invalid.rowCount, 0, "every index is valid");

  // 3. An empty database: the baseline seed carries 0066 with the same shape.
  await admin.query("create database memora_questions_empty");
  const seeded = createPgPool({ connectionString: databaseUrl("memora_questions_empty"), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(migrationName), "baseline");
  assert.deepEqual(await shape(seeded), after, "baseline and pending shapes are identical");
  report.shape = { columns: after.columns.length, indexes: indexNames.length };

  // 4. Behavior: insert, the checks, the cascade and the generated column.
  const questionId = randomUUID();
  await db.query(
    `insert into questions (id, text, privacy, mode, status)
     values ($1, 'Como a MEMÓRIA consolida o sono?', 'offline_only', 'text', 'running')`,
    [questionId]
  );
  const stored = await db.query<{ tsv: string; scope: unknown; language: string }>(
    "select search_tsv::text as tsv, scope, language from questions where id = $1",
    [questionId]
  );
  assert.equal(stored.rows[0]?.tsv, "'a':2 'como':1 'consolida':4 'memoria':3 'o':5 'sono':6");
  assert.deepEqual(stored.rows[0]?.scope, { kind: "library" }, "the default scope is the library");
  assert.equal(stored.rows[0]?.language, "und");
  const insertQuestion = (text: string, mode: string, status: string) =>
    refused(
      db,
      `question ${mode}/${status}`,
      "insert into questions (text, privacy, mode, status) values ($1, 'offline_only', $2, $3)",
      [text, mode, status]
    );
  await insertQuestion("", "text", "running");
  await insertQuestion("x".repeat(2001), "text", "running");
  await insertQuestion("ok", "vector", "running");
  await insertQuestion("ok", "text", "paused");
  const answer = await db.query<{ id: string }>(
    `insert into question_answers (question_id, version, paragraphs, provenance, status, started_at)
     values ($1, 1, '[{"markdown":"a","citations":[1]}]', '{"model":"m"}', 'complete', now()) returning id`,
    [questionId]
  );
  const answerId = answer.rows[0]!.id;
  await refused(
    db,
    "duplicate version",
    `insert into question_answers (question_id, version, paragraphs, provenance, status, started_at)
     values ($1, 1, '[]', '{}', 'complete', now())`,
    [questionId]
  );
  await refused(
    db,
    "version 0",
    `insert into question_answers (question_id, version, paragraphs, provenance, status, started_at)
     values ($1, 0, '[]', '{}', 'complete', now())`,
    [questionId]
  );
  await refused(
    db,
    "running answer",
    `insert into question_answers (question_id, version, paragraphs, provenance, status, started_at)
     values ($1, 2, '[]', '{}', 'running', now())`,
    [questionId]
  );
  await db.query(
    `insert into question_citations (answer_id, ordinal, target_kind, target_id, content_hash)
     values ($1, 1, 'note', $2, 'h')`,
    [answerId, randomUUID()]
  );
  await refused(
    db,
    "duplicate ordinal",
    "insert into question_citations (answer_id, ordinal, target_kind, target_id, content_hash) values ($1, 1, 'note', $2, 'h')",
    [answerId, randomUUID()]
  );
  await refused(
    db,
    "ordinal 0",
    "insert into question_citations (answer_id, ordinal, target_kind, target_id, content_hash) values ($1, 0, 'note', $2, 'h')",
    [answerId, randomUUID()]
  );
  await refused(
    db,
    "unknown kind",
    "insert into question_citations (answer_id, ordinal, target_kind, target_id, content_hash) values ($1, 2, 'entity', $2, 'h')",
    [answerId, randomUUID()]
  );
  await db.query("delete from questions where id = $1", [questionId]);
  for (const table of ["question_answers", "question_citations"]) {
    const left = await db.query<{ count: number }>(`select count(*)::int as count from ${table}`);
    assert.equal(left.rows[0]?.count, 0, `${table}: the cascade delete leaves no row`);
  }
  report.behavior = "checks, keys, cascade and the generated search_tsv";

  // 5. EXPLAIN: the questions' text and keyset order use their indexes.
  const texts = ["memória e sono", "notas e passagens", "o que é um tópico", "sleep and memory"];
  await db.query(
    `insert into questions (text, privacy, mode, status)
     select t || ' ' || g, 'offline_only', 'text', 'complete' from unnest($1::text[]) as t, generate_series(1, 400) as g`,
    [texts]
  );
  await db.query("analyze questions");
  const searchPlan = await plan(
    db,
    `select q.id from questions q where ${questionSearchCondition("q", "$1")}`,
    ["memoria"]
  );
  assert.match(searchPlan, /questions_search_tsv_idx/, `full text uses its GIN:\n${searchPlan}`);
  assert.match(
    searchPlan,
    /questions_text_trgm_idx/,
    `similar words use the trigram GIN:\n${searchPlan}`
  );
  const keysetPlan = await plan(
    db,
    `select q.id from questions q
      where (q.created_at, q.id) < (now(), gen_random_uuid()) order by ${questionListOrder} limit 26`
  );
  assert.match(
    keysetPlan,
    /questions_created_at_idx/,
    `the list uses its keyset index:\n${keysetPlan}`
  );
  const citationPlan = await plan(
    db,
    "select answer_id from question_citations where target_kind = 'note' and target_id = $1",
    [randomUUID()]
  );
  assert.match(
    citationPlan,
    /question_citations_target_idx/,
    `backlinks use the target index:\n${citationPlan}`
  );
  report.explain = "search_tsv @@ and <% use both GINs; keyset and target indexes used";
  await db.query("delete from questions");

  // 6. Each citation hash expression on a fixture row, against an independent computation.
  const source = await createSourceItemRepository(db).create({ type: "Book", title: "Sleep" });
  await db.query(
    "update source_items set content_hash = 'sc', summary = 'Résumé ✓' where id = $1",
    [source.id]
  );
  const documentId = randomUUID();
  const chunkId = randomUUID();
  const noteId = randomUUID();
  await db.query(
    "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', 'doc')",
    [documentId, source.id]
  );
  await db.query(
    `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
     values ($1, $2, $3, 0, 'Naps.', 'chunk-hash')`,
    [chunkId, documentId, source.id]
  );
  await db.query(
    `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
        evidence_chunk_id, generation_provider, generation_model, generation_runtime,
        generation_prompt_version, generation_key)
     values ($1::uuid, 'Título', 'Corpo — ação', 'Ideia', $2, $3, 't', 't', 'local', 't', $1::text)`,
    [noteId, source.id, chunkId]
  );
  const trees = createTopicTreeRepository(db);
  const rootId = randomUUID();
  const topicId = randomUUID();
  const tree = await trees.createTree({
    id: randomUUID(),
    rootId,
    spaceKey: "verify:questions:256",
    embeddingProvider: "verify",
    embeddingModel: "verify",
    embeddingRuntime: "none",
    dimensions: 256,
    config: {},
    configHash: "verify",
    seed: 1
  });
  await trees.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics: [
      topicRecord(topicId, rootId, {
        role: "topic",
        title: "Sleep",
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en"
      })
    ],
    placements: []
  });
  const overview = (text: string) => ({
    topicId,
    paragraphs: [{ text, citations: [] }],
    evidence: [],
    memberFingerprint: `members-${text}`,
    memberCount: 1,
    inputHash: `input-${text}`,
    promptRevisionId: "topic.overview@verify",
    provider: "verify",
    model: "verify",
    runtime: "none",
    aiTaskRunId: null,
    language: "en",
    support: { status: "unchecked" as const, unsupported: [] },
    divergences: [],
    citations: []
  });
  const overviews = createTopicOverviewRepository(db);
  const questions = createQuestionRepository(db);
  const question = await questions.create({
    text: "Hashes?",
    privacy: "offline_only",
    mode: "text"
  });
  const cited = [
    { kind: "note", targetId: noteId },
    { kind: "chunk", targetId: chunkId },
    { kind: "source", targetId: source.id },
    { kind: "topic", targetId: topicId }
  ] as const;
  const answerOf = () => ({
    paragraphs: [{ markdown: "Cited.", citations: [1, 2, 3, 4] }],
    citations: cited.map((citation, index) => ({ ordinal: index + 1, ...citation })),
    provenance: { model: "verify" },
    status: "complete" as const,
    startedAt: new Date()
  });
  // A topic with no overview hashes to v0; its first overview, v1.
  const beforeOverview = await questions.appendAnswer(question.id, answerOf());
  assert.equal(beforeOverview?.missingTargets, 0);
  await overviews.write(overview("Naps help."));
  const hashes = (answerIdValue: string) =>
    db.query<{ ordinal: number; hash: string }>(
      "select ordinal, content_hash as hash from question_citations where answer_id = $1 order by ordinal",
      [answerIdValue]
    );
  assert.equal(
    (await hashes(beforeOverview!.answerId)).rows[3]?.hash,
    "v0",
    "topic: v0 without an overview"
  );
  const second = await questions.appendAnswer(question.id, answerOf());
  assert.deepEqual(
    (await hashes(second!.answerId)).rows.map((row) => row.hash),
    [sha256("Título\u001fIdeia\u001fCorpo — ação"), "chunk-hash", `sc:${sha256("Résumé ✓")}`, "v1"],
    "note, chunk, source and topic hashes equal their independent computation"
  );
  const read = await questions.get(question.id);
  assert.deepEqual(
    read?.answers.map((entry) => [entry.version, entry.stale]),
    [
      [1, true],
      [2, false]
    ],
    "the answer stored before the overview is stale; the later one is not"
  );
  await overviews.write(overview("Naps help a lot."));
  assert.equal(
    (await questions.get(question.id))?.answers[1]?.stale,
    true,
    "an overview version up"
  );
  report.hashes = "note, chunk, source and topic expressions on a fixture row";

  console.log(JSON.stringify({ ok: true, migration: migrationName, ...report }, null, 2));
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
