import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createLibraryResetRepository,
  createObjectLocateRepository,
  createPgPool,
  createSourceItemRepository,
  createTopicOverviewRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "../index.js";

/**
 * Real-database proof of the topic overview tables (migration 0054, F2 T31): migration history
 * and shape (columns, types, nullability, indexes, constraints, foreign-key actions) on the
 * pending and baseline paths, with existing data kept; the checks refusing malformed rows; the
 * repository's write, read-back and support guard; what a replaced passage and a deleted note do
 * to a citation; `objects.locate` citedBy through notes, chunks and spans with the indexes it
 * relies on (EXPLAIN); and the library reset. It starts its own temporary PostgreSQL sidecar and
 * never touches an existing database.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-topic-overview-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_topic_overview",
  user: "memora_topic_overview",
  password: `topic-overview-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

const report: Record<string, unknown> = {};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const overviewTables = ["topic_overviews", "topic_overview_citations"];

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const tags: string[] = journal.entries.map((entry: { tag: string }) => entry.tag);
  const tag = tags.find((name) => name.endsWith("_topic_overviews"));
  assert.ok(tag, "the topic overview migration is in the journal");
  const index = tags.indexOf(tag);
  assert.equal(index, tags.length - 1, "0054 is the latest migration");
  const historyCount = async (db: PgPool) =>
    Number(
      (
        await db.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]?.count
    );

  // 1. Pending path: a database at 0053 with a library and a topic tree gets 0054 and keeps both.
  const db = createPgPool({ connectionString: connection.connectionString, max: 6 });
  pools.push(db);
  const before = join(workDir, "drizzle-before-overviews");
  await cp(migrationsFolder, before, { recursive: true });
  await writeFile(
    join(before, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) })
  );
  await runMigrations(db, before);
  assert.equal(await historyCount(db), index, "history before the overview migration");

  const sources = createSourceItemRepository(db);
  const book = await sources.create({ type: "Book", title: "The Book of Sleep" });
  const article = await sources.create({ type: "StandaloneArticle", title: "Unrelated article" });
  const document = await createDocumentRepository(db).create({
    sourceItemId: book.id,
    title: "Document",
    canonicalMarkdown: "One.\n\nTwo.\n\nThree.",
    contentHash: randomUUID()
  });
  const passages = [
    "Deep sleep replays the day's memories.",
    "Short naps restore attention.",
    "Sleep cycles last about ninety minutes."
  ];
  let offset = 0;
  const chunkRows = passages.map((content, chunkIndex) => {
    const span = { id: randomUUID(), startOffset: offset, endOffset: offset + content.length };
    offset += content.length + 2;
    return {
      id: randomUUID(),
      sourceSpanId: span.id,
      chunkIndex,
      content,
      contentHash: sha(content),
      span
    };
  });
  await createChunkRepository(db).replaceDocumentChunks(document.id, book.id, chunkRows);
  const notes: string[] = [];
  for (const [position, chunk] of chunkRows.entries()) {
    const id = randomUUID();
    notes.push(id);
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key)
       values ($1::uuid, $2, 'Body', $2, 'source', $3, $4, 'verify', 'verify', 'none', 'verify', $1::uuid::text)`,
      [id, `Sleep note ${position + 1}`, book.id, chunk.id]
    );
  }
  const trees = createTopicTreeRepository(db);
  const rootId = randomUUID();
  const sleep = randomUUID();
  const naps = randomUUID();
  const tree = await trees.createTree({
    id: randomUUID(),
    rootId,
    spaceKey: "verify:overview:256",
    embeddingProvider: "verify",
    embeddingModel: "verify",
    embeddingRuntime: "none",
    dimensions: 256,
    config: {},
    configHash: "verify",
    seed: 1
  });
  const named = (title: string, position: number) =>
    ({
      role: "topic",
      title,
      nameState: "named",
      nameSource: "llm",
      nameLanguage: "en",
      position
    }) as const;
  const built = await trees.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics: [
      topicRecord(sleep, rootId, named("Sleep", 0)),
      topicRecord(naps, sleep, named("Naps", 0))
    ],
    placements: [
      {
        item: itemKey("note", notes[0]!),
        placement: placementRecord(sleep, { itemFingerprint: "v1" })
      },
      {
        item: itemKey("note", notes[1]!),
        placement: placementRecord(naps, { itemFingerprint: "v1" })
      },
      {
        item: itemKey("note", notes[2]!),
        placement: placementRecord(sleep, { itemFingerprint: "v1" })
      }
    ]
  });
  assert.equal(built.kind, "applied", "the verification tree is written through the engine");

  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), tags.length, "0054 applied as a pending migration");
  const kept = await db.query<{ notes: number; placements: number; topics: number }>(
    `select (select count(*)::int from atomic_notes) as notes,
            (select count(*)::int from topic_placements) as placements,
            (select count(*)::int from topics) as topics`
  );
  assert.deepEqual(kept.rows[0], { notes: 3, placements: 3, topics: 3 }, "existing data survives");
  const lastHistory = await db.query<{ hash: string }>(
    "select hash from drizzle.__drizzle_migrations order by created_at desc, id desc limit 1"
  );
  assert.equal(
    lastHistory.rows[0]?.hash,
    sha(await readFile(join(migrationsFolder, `${tag}.sql`), "utf8")),
    "the history records 0054's own SQL"
  );

  // 2. Baseline path: an empty database is seeded with every migration, 0054 included.
  const seededName = "memora_topic_overview_seed";
  await db.query(`create database ${seededName}`);
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = `/${seededName}`;
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(tag), "baseline holds 0054");
  assert.equal(await historyCount(seeded), tags.length, "seeded history");

  // 3. Shape: identical on both paths, and exactly what the overview needs.
  const shape = async (pool: PgPool) => ({
    columns: (
      await pool.query<{ row: string }>(
        `select table_name || '.' || column_name || ':' || data_type ||
                coalesce('(' || character_maximum_length || ')', '') || ':' || is_nullable ||
                coalesce(':' || column_default, '') as row
           from information_schema.columns where table_name = any($1::text[])`,
        [overviewTables]
      )
    ).rows
      .map((row) => row.row)
      .sort(),
    indexes: (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = any($1::text[])",
        [overviewTables]
      )
    ).rows
      .map((row) => row.indexdef)
      .sort(),
    constraints: (
      await pool.query<{ conname: string; contype: string; def: string }>(
        `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = any(select oid from pg_class where relname = any($1::text[]))`,
        [overviewTables]
      )
    ).rows
      .map((row) => `${row.conname}:${row.contype}:${row.def}`)
      .sort()
  });
  const pendingShape = await shape(db);
  assert.deepEqual(await shape(seeded), pendingShape, "pending and baseline shapes are identical");
  assert.deepEqual(
    pendingShape.columns,
    [
      "topic_overview_citations.chunk_id:uuid:YES",
      "topic_overview_citations.excerpt:text:NO",
      "topic_overview_citations.excerpt_hash:text:NO",
      "topic_overview_citations.n:smallint:NO",
      "topic_overview_citations.note_id:uuid:YES",
      "topic_overview_citations.source_span_id:uuid:YES",
      "topic_overview_citations.topic_id:uuid:NO",
      "topic_overviews.ai_task_run_id:uuid:YES",
      "topic_overviews.evidence:jsonb:NO:'[]'::jsonb",
      "topic_overviews.input_hash:text:NO",
      "topic_overviews.language:character varying(16):NO",
      "topic_overviews.member_count:integer:NO",
      "topic_overviews.member_fingerprint:text:NO",
      "topic_overviews.model:text:NO",
      "topic_overviews.paragraphs:jsonb:NO",
      "topic_overviews.prompt_revision_id:text:NO",
      "topic_overviews.provider:text:NO",
      "topic_overviews.runtime:text:NO",
      `topic_overviews.support:jsonb:NO:'{"status": "unchecked", "unsupported": []}'::jsonb`,
      "topic_overviews.topic_id:uuid:NO",
      "topic_overviews.written_at:timestamp with time zone:NO:now()"
    ],
    "columns, types, nullability and defaults"
  );
  const constraint = (prefix: string) =>
    pendingShape.constraints.find((definition) => definition.startsWith(prefix)) ?? "";
  assert.match(constraint("topic_overviews_pkey:p"), /PRIMARY KEY \(topic_id\)/u);
  assert.match(
    constraint("topic_overview_citations_topic_id_n_pk:p"),
    /PRIMARY KEY \(topic_id, n\)/u
  );
  assert.match(
    constraint("topic_overviews_topic_id_topics_id_fk:f"),
    /REFERENCES topics\(id\) ON DELETE CASCADE/u
  );
  assert.match(
    constraint("topic_overviews_ai_task_run_id_ai_task_runs_id_fk:f"),
    /REFERENCES ai_task_runs\(id\) ON DELETE SET NULL/u
  );
  assert.match(
    constraint("topic_overview_citations_topic_id_topic_overviews_topic_id_fk:f"),
    /REFERENCES topic_overviews\(topic_id\) ON DELETE CASCADE/u
  );
  for (const [column, target] of [
    ["chunk_id", "chunks"],
    ["source_span_id", "source_spans"],
    ["note_id", "atomic_notes"]
  ] as const) {
    assert.match(
      constraint(`topic_overview_citations_${column}_${target}_id_fk:f`),
      new RegExp(`REFERENCES ${target}\\(id\\) ON DELETE SET NULL`, "u"),
      `${column} is set null when its target goes`
    );
  }
  for (const check of [
    "topic_overviews_shape:c",
    "topic_overviews_text:c",
    "topic_overview_citations_citation:c"
  ]) {
    assert.ok(constraint(check), `check ${check}`);
  }
  for (const [name, column] of [
    ["topic_overview_citations_note_idx", "note_id"],
    ["topic_overview_citations_chunk_idx", "chunk_id"],
    ["topic_overview_citations_span_idx", "source_span_id"]
  ] as const) {
    const definition = pendingShape.indexes.find((item) => item.includes(name)) ?? "";
    assert.match(
      definition,
      new RegExp(`USING btree \\(${column}\\) WHERE \\(${column} IS NOT NULL\\)`, "u"),
      `partial index ${name}`
    );
  }
  report.shape = {
    columns: pendingShape.columns.length,
    indexes: pendingShape.indexes.length,
    constraints: pendingShape.constraints.length
  };

  // 4. The repository writes an overview with its citations and reads it back.
  const overviews = createTopicOverviewRepository(db);
  const context = await overviews.readContext(sleep);
  assert.ok(context, "the context of a live topic");
  assert.equal(context.topic.title, "Sleep");
  assert.equal(context.members.notes, 3, "the members are the subtree's primary placements");
  assert.equal(context.stored, null);
  const evidence = await overviews.readEvidence(context.topic, { perTopic: 16, candidates: 400 });
  assert.equal(evidence.length, 3, "every central note of the subtree is a candidate");
  assert.deepEqual(
    evidence.map((row) => row.round).sort(),
    [0, 0, 1],
    "rounds count inside each topic"
  );
  assert.ok(
    evidence.every((row) => passages.includes(row.passage) && row.sourceSpanId !== null),
    "candidates carry their whole passage and its span"
  );
  const byNote = new Map(evidence.map((row) => [row.noteId, row]));
  const cite = (n: number, noteId: string) => {
    const row = byNote.get(noteId)!;
    return {
      n,
      chunkId: row.chunkId,
      sourceSpanId: row.sourceSpanId,
      noteId,
      excerpt: row.passage,
      excerptHash: sha(row.passage)
    };
  };
  const saved = await overviews.save({
    topicId: sleep,
    paragraphs: [{ text: "Deep sleep replays memories [1]. Naps help [2].", citations: [1, 2] }],
    evidence: evidence.map((row) => ({
      noteId: row.noteId,
      chunkId: row.chunkId,
      sourceSpanId: row.sourceSpanId,
      sourceId: row.sourceId,
      contentHash: sha(row.passage)
    })),
    memberFingerprint: context.members.fingerprint,
    memberCount: context.members.notes,
    inputHash: sha("prompt"),
    promptRevisionId: "topic-overview-v1:verify",
    provider: "verify",
    model: "verify-writer",
    runtime: "none",
    aiTaskRunId: null,
    language: "en",
    support: { status: "unchecked", unsupported: [] },
    citations: [cite(1, notes[0]!), cite(2, notes[1]!)]
  });
  assert.ok(saved, "an overview of a live topic is stored");
  const stored = (await overviews.readContext(sleep))?.stored;
  assert.ok(stored);
  assert.equal(stored.memberFingerprint, context.members.fingerprint);
  assert.deepEqual(
    stored.citations.map((citation) => [
      citation.n,
      citation.sourceId,
      citation.sourceTitle,
      citation.available
    ]),
    [
      [1, book.id, "The Book of Sleep", true],
      [2, book.id, "The Book of Sleep", true]
    ],
    "citations resolve to their source and are available"
  );
  assert.equal(
    await overviews.save({
      topicId: randomUUID(),
      paragraphs: [{ text: "Text [1].", citations: [1] }],
      evidence: [],
      memberFingerprint: "f",
      memberCount: 0,
      inputHash: "h",
      promptRevisionId: "p",
      provider: "verify",
      model: "verify",
      runtime: "none",
      aiTaskRunId: null,
      language: "en",
      support: { status: "unchecked", unsupported: [] },
      citations: []
    }),
    null,
    "nothing is stored for a topic that does not exist"
  );
  assert.equal(
    await overviews.saveSupport({
      topicId: sleep,
      writtenAtExact: "2020-01-01T00:00:00Z",
      support: {}
    }),
    false,
    "a support verdict for another writing is refused"
  );
  assert.equal(
    await overviews.saveSupport({
      topicId: sleep,
      writtenAtExact: saved.writtenAtExact,
      support: { status: "verified", unsupported: [], sentences: { checked: 2, supported: 2 } }
    }),
    true,
    "the verdict of this writing is stored"
  );
  assert.equal((await overviews.readContext(sleep))?.stored?.support.status, "verified");

  // 5. The checks refuse malformed rows (overview constraint probe).
  const refused = async (sql: string, values: unknown[], label: string) => {
    await assert.rejects(db.query(sql, values), /violates check constraint/u, label);
  };
  await refused(
    /* overview constraint probe */ `insert into topic_overview_citations
       (topic_id, n, excerpt, excerpt_hash) values ($1, 0, 'x', 'h')`,
    [sleep],
    "a citation is numbered from 1"
  );
  await refused(
    /* overview constraint probe */ `insert into topic_overview_citations
       (topic_id, n, excerpt, excerpt_hash) values ($1, 9, '', 'h')`,
    [sleep],
    "a citation keeps an excerpt"
  );
  await refused(
    /* overview constraint probe */ `insert into topic_overviews
       (topic_id, paragraphs, member_fingerprint, member_count, input_hash, prompt_revision_id,
        provider, model, runtime, language)
     values ($1, '[]'::jsonb, 'f', 0, 'h', 'p', 'x', 'x', 'x', 'en')`,
    [naps],
    "an overview has a paragraph"
  );
  await refused(
    /* overview constraint probe */ `insert into topic_overviews
       (topic_id, paragraphs, member_fingerprint, member_count, input_hash, prompt_revision_id,
        provider, model, runtime, language, support)
     values ($1, '[{}]'::jsonb, 'f', 0, 'h', 'p', 'x', 'x', 'x', 'en', '[]'::jsonb)`,
    [naps],
    "the support is an object"
  );

  // 6. objects.locate: the citing topic for the note and the source, through the indexes.
  const locate = createObjectLocateRepository(db);
  const sleepRef = { kind: "topic", id: sleep, title: "Sleep" };
  assert.deepEqual((await locate.locateNote(notes[0]!))?.citedBy, [sleepRef], "a cited note");
  assert.deepEqual((await locate.locateNote(notes[2]!))?.citedBy, [], "an uncited note");
  assert.deepEqual((await locate.locateSource(book.id))?.citedBy, [sleepRef], "a cited source");
  assert.deepEqual((await locate.locateSource(article.id))?.citedBy, [], "an uncited source");
  const plans: Record<string, string> = {};
  const client = await db.connect();
  try {
    await client.query("set enable_seqscan = off");
    for (const [name, statement, id] of [
      ["note", locate.statements.note, notes[0]!],
      ["source", locate.statements.source, book.id]
    ] as const) {
      const plan = (
        await client.query<{ "QUERY PLAN": string }>(`explain ${statement}`, [id, 25, 31])
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      plans[name] = plan;
    }
  } finally {
    await client.query("reset enable_seqscan").catch(() => undefined);
    client.release();
  }
  assert.match(
    plans.note!,
    /topic_overview_citations_note_idx/u,
    "citedBy of a note uses its index"
  );
  assert.match(
    plans.source!,
    /topic_overview_citations_(chunk|span)_idx/u,
    "citedBy of a source uses the chunk or span index"
  );
  report.explain = {
    note: /topic_overview_citations_note_idx/u.test(plans.note!),
    sourceChunk: /topic_overview_citations_chunk_idx/u.test(plans.source!),
    sourceSpan: /topic_overview_citations_span_idx/u.test(plans.source!)
  };

  // 7. A deleted note leaves its citation readable through the chunk; a replaced passage leaves it
  // readable and unavailable, still cited by its source through the span; once the document goes,
  // only the excerpt remains.
  await db.query("delete from atomic_notes where id = $1", [notes[1]!]);
  let citations = (await overviews.readContext(sleep))?.stored?.citations ?? [];
  assert.equal(citations[1]?.noteId, null, "a deleted note leaves its citation");
  assert.equal(citations[1]?.available, true, "its passage is still current");
  assert.equal(citations[1]?.sourceId, book.id);
  await db.query("delete from chunks where id = $1", [chunkRows[1]!.id]);
  citations = (await overviews.readContext(sleep))?.stored?.citations ?? [];
  assert.equal(citations[1]?.chunkId, null, "a replaced passage is set null");
  assert.equal(citations[1]?.available, false, "and is unavailable");
  assert.equal(citations[1]?.excerpt, passages[1], "its excerpt stays readable");
  assert.equal(citations[1]?.sourceId, book.id, "its source is found through the span");
  assert.deepEqual(
    (await locate.locateSource(book.id))?.citedBy,
    [sleepRef],
    "the source is still cited through the span"
  );
  await db.query("delete from documents where id = $1", [document.id]);
  citations = (await overviews.readContext(sleep))?.stored?.citations ?? [];
  assert.ok(
    citations.every((citation) => citation.chunkId === null && citation.sourceSpanId === null),
    "the document's chunks and spans are gone"
  );
  assert.ok(citations.every((citation) => !citation.available && citation.excerpt.length > 0));
  report.citations = citations.map((citation) => ({
    n: citation.n,
    available: citation.available,
    hasNote: citation.noteId !== null
  }));

  // 8. The library reset clears the overview tables.
  await createLibraryResetRepository(db).reset();
  const remaining: Record<string, number> = {};
  for (const table of overviewTables) {
    const count = await db.query<{ count: number }>(`select count(*)::int as count from ${table}`);
    remaining[table] = Number(count.rows[0]?.count);
  }
  assert.ok(
    Object.values(remaining).every((count) => count === 0),
    "the reset empties them"
  );
  report.reset = remaining;

  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
