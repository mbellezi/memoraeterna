import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createAtomicNoteRelationRepository,
  createChunkRepository,
  createDocumentRepository,
  createPgPool,
  createRelationDecisionRepository,
  createSourceItemRepository,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of `relation_decisions` (migrations 0044 and 0046): both applied as pending
 * migrations on a database with history and data (0046 over legacy pair-level audit rows), and
 * through the baseline seed on an empty one; columns, indexes and constraints; per-direction
 * verdicts keyed by content hashes and decider, each with its own AI run and time; and cascades.
 * It starts its own temporary PostgreSQL sidecar and never touches an existing database.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-relation-decisions-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_relation_decisions",
  user: "memora_relation_decisions",
  password: `relation-decisions-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const createTag = "0044_relation_decisions";
const auditTag = "0046_relation_decision_audit";

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const tags: string[] = journal.entries.map((entry: { tag: string }) => entry.tag);
  const createIndex = tags.indexOf(createTag);
  const auditIndex = tags.indexOf(auditTag);
  assert.ok(createIndex > 0, "0044 is in the journal");
  assert.ok(auditIndex > createIndex, "0046 follows 0044 in the journal");
  const historyCount = async (db: PgPool) =>
    Number(
      (
        await db.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]?.count
    );
  /** A copy of the migrations whose journal stops before `before`, to apply a database step by step. */
  const migrationsBefore = async (before: number, name: string) => {
    const folder = join(workDir, name);
    await cp(migrationsFolder, folder, { recursive: true });
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) })
    );
    return folder;
  };

  // 1. Pending path: a database migrated to 0043 with data gets 0044, 0045 and 0046 as pending.
  const db = createPgPool({ connectionString: connection.connectionString, max: 3 });
  pools.push(db);
  await runMigrations(db, await migrationsBefore(createIndex, "drizzle-before-0044"));
  assert.equal(await historyCount(db), createIndex, "history before 0044");
  // Notes need real evidence: a source, its document and a chunk.
  const source = await createSourceItemRepository(db).create({
    type: "StandaloneArticle",
    title: "Relation decisions"
  });
  const content = "Retrieval practice improves long-term retention.";
  const document = await createDocumentRepository(db).create({
    sourceItemId: source.id,
    title: source.title,
    canonicalMarkdown: content,
    contentHash: content
  });
  const chunkId = randomUUID();
  const spanId = randomUUID();
  await createChunkRepository(db).replaceDocumentChunks(document.id, source.id, [
    {
      id: chunkId,
      sourceSpanId: spanId,
      chunkIndex: 0,
      content,
      contentHash: content,
      span: { id: spanId, startOffset: 0, endOffset: content.length }
    }
  ]);
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  const [lo, mid, hi] = ids as [string, string, string];
  for (const id of ids)
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1::uuid, $1::uuid::text, $1::uuid::text, $1::uuid::text, $2, $3, 'verify',
         'verify', 'local', 'verify', $1::uuid::text)`,
      [id, source.id, chunkId]
    );
  const relation = await createAtomicNoteRelationRepository(db).upsert({
    sourceAtomicNoteId: hi,
    targetAtomicNoteId: lo,
    relationType: "supports",
    finalScore: 0.9,
    explanation: "verify"
  });
  const aiConfig = createAiConfigRepository(db);
  const newRun = () =>
    aiConfig.recordTaskRun({
      taskType: "reranking",
      provider: "verify",
      modelId: "verify-model",
      runtime: "remote",
      durationMs: 1,
      status: "succeeded"
    });

  // 0044 and 0045 first: legacy rows keep one AI run and time for the whole pair.
  await runMigrations(db, await migrationsBefore(auditIndex, "drizzle-before-0046"));
  assert.equal(await historyCount(db), auditIndex, "0044 applied as pending");
  const legacyRun = await newRun();
  const legacyAt = "2026-01-02T03:04:05.000Z";
  const legacy = `insert into relation_decisions (pair_key, lo_atomic_note_id, hi_atomic_note_id,
    lo_content_hash, hi_content_hash, decider_key, lo_to_hi_score, lo_to_hi_relation_type,
    hi_to_lo_score, hi_to_lo_relation_type, ai_task_run_id, decided_at)
    values ($1, $2, $3, 'a', 'b', $4, $5, $6, $7, $8, $9, $10)`;
  const legacyPair = `${lo}:${hi}`;
  await db.query(legacy, [
    legacyPair,
    lo,
    hi,
    "legacy-lo",
    0.2,
    "related",
    null,
    null,
    legacyRun,
    legacyAt
  ]);
  await db.query(legacy, [
    legacyPair,
    lo,
    hi,
    "legacy-hi",
    null,
    null,
    0.7,
    "supports",
    legacyRun,
    legacyAt
  ]);
  await db.query(legacy, [
    legacyPair,
    lo,
    hi,
    "legacy-both",
    0.4,
    "related",
    0.6,
    "extends",
    legacyRun,
    legacyAt
  ]);
  await db.query(legacy, [
    legacyPair,
    lo,
    hi,
    "legacy-norun",
    0.5,
    "related",
    null,
    null,
    null,
    legacyAt
  ]);

  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), tags.length, "0046 applied as pending");
  assert.equal(
    (
      await db.query("select count(*)::int as count from atomic_note_relations where id = $1", [
        relation.id
      ])
    ).rows[0]?.count,
    1,
    "existing relations survive"
  );
  // The backfill gives every direction that has a verdict the run and time the pair recorded.
  const backfilled = (
    await db.query(
      `select decider_key, lo_to_hi_ai_task_run_id as lo_run, lo_to_hi_decided_at as lo_at,
         hi_to_lo_ai_task_run_id as hi_run, hi_to_lo_decided_at as hi_at
       from relation_decisions where decider_key like 'legacy-%' order by decider_key`
    )
  ).rows.map((row) => [
    row.decider_key,
    row.lo_run,
    row.lo_at?.toISOString() ?? null,
    row.hi_run,
    row.hi_at?.toISOString() ?? null
  ]);
  assert.deepEqual(
    backfilled,
    [
      ["legacy-both", legacyRun, legacyAt, legacyRun, legacyAt],
      ["legacy-hi", null, null, legacyRun, legacyAt],
      ["legacy-lo", legacyRun, legacyAt, null, null],
      ["legacy-norun", null, legacyAt, null, null]
    ],
    "backfill follows the directions that have a verdict"
  );

  // 2. Baseline path: an empty database is seeded with every migration, 0044 and 0046 included.
  const seededName = "memora_relation_decisions_seed";
  await db.query(`create database ${seededName}`);
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = `/${seededName}`;
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(
    seed.seed.applied &&
      seed.seed.seededMigrations.includes(createTag) &&
      seed.seed.seededMigrations.includes(auditTag),
    "baseline holds 0044 and 0046"
  );
  assert.equal(await historyCount(seeded), tags.length, "seeded history");

  // 3. Shape: columns, types, indexes and constraints are identical on both paths.
  const shape = async (pool: PgPool) => ({
    columns: (
      await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_name = 'relation_decisions'`
      )
    ).rows
      .map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`)
      .sort(),
    indexes: (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = 'relation_decisions'"
      )
    ).rows
      .map((row) => row.indexdef)
      .sort(),
    constraints: (
      await pool.query<{ conname: string; contype: string }>(
        `select conname, contype from pg_constraint
         where conrelid = 'relation_decisions'::regclass and contype in ('c', 'f', 'p', 'u')`
      )
    ).rows
      .map((row) => `${row.conname}:${row.contype}`)
      .sort()
  });
  const migrated = await shape(db);
  assert.deepEqual(await shape(seeded), migrated, "baseline and pending paths agree");
  assert.deepEqual(
    migrated.columns,
    [
      "accepted:boolean:NO",
      "decider_key:text:NO",
      "hi_atomic_note_id:uuid:NO",
      "hi_content_hash:text:NO",
      "hi_to_lo_ai_task_run_id:uuid:YES",
      "hi_to_lo_decided_at:timestamp with time zone:YES",
      "hi_to_lo_relation_type:text:YES",
      "hi_to_lo_score:double precision:YES",
      "id:uuid:NO",
      "lo_atomic_note_id:uuid:NO",
      "lo_content_hash:text:NO",
      "lo_to_hi_ai_task_run_id:uuid:YES",
      "lo_to_hi_decided_at:timestamp with time zone:YES",
      "lo_to_hi_relation_type:text:YES",
      "lo_to_hi_score:double precision:YES",
      "pair_key:text:NO",
      "relation_type:text:YES"
    ].sort(),
    "per-direction audit columns replace the pair-level ones"
  );
  assert.deepEqual(
    migrated.constraints,
    [
      "relation_decisions_accepted:c",
      "relation_decisions_decided_at:c",
      "relation_decisions_directions:c",
      "relation_decisions_hi_atomic_note_id_atomic_notes_id_fk:f",
      "relation_decisions_hi_to_lo_ai_task_run_id_ai_task_runs_id_fk:f",
      "relation_decisions_lo_atomic_note_id_atomic_notes_id_fk:f",
      "relation_decisions_lo_to_hi_ai_task_run_id_ai_task_runs_id_fk:f",
      "relation_decisions_pair:c",
      "relation_decisions_pkey:p",
      "relation_decisions_types:c"
    ].sort()
  );
  assert.ok(
    migrated.indexes.some((def) =>
      def.includes(
        "UNIQUE INDEX relation_decisions_pair_decider_uidx ON public.relation_decisions USING btree (pair_key, decider_key)"
      )
    ),
    "unique pair and decider"
  );
  assert.equal(migrated.indexes.length, 4, "primary key, pair/decider and both note indexes");

  // 4. Behavior: one row per pair and decider, one verdict per direction and content version,
  // each direction with the AI run and time of its own decision.
  await db.query("delete from relation_decisions where decider_key like 'legacy-%'");
  const decisions = createRelationDecisionRepository(db);
  const [runA, runB, runC] = [await newRun(), await newRun(), await newRun()] as [
    string,
    string,
    string
  ];
  const hashes = { [lo]: "hash-lo", [mid]: "hash-mid", [hi]: "hash-hi" } as Record<string, string>;
  const record = (
    source: string,
    target: string,
    score: number,
    relationType: string,
    accepted: boolean,
    aiTaskRunId: string | null,
    deciderKey = "decider-a",
    sourceHash = hashes[source]!
  ) =>
    decisions.record({
      sourceAtomicNoteId: source,
      targetAtomicNoteId: target,
      sourceContentHash: sourceHash,
      targetContentHash: hashes[target]!,
      deciderKey,
      score,
      relationType,
      accepted,
      aiTaskRunId
    });
  const verdicts = (source: string, sourceHash = hashes[source]!, deciderKey = "decider-a") =>
    decisions
      .findVerdicts({
        sourceAtomicNoteId: source,
        sourceContentHash: sourceHash,
        deciderKey,
        targets: ids
          .filter((id) => id !== source)
          .map((id) => ({
            atomicNoteId: id,
            contentHash: hashes[id]!
          }))
      })
      .then((map) => Object.fromEntries(map));
  const rows = async () =>
    (
      await db.query(
        `select pair_key, lo_to_hi_score, lo_to_hi_relation_type, lo_to_hi_ai_task_run_id,
           lo_to_hi_decided_at, hi_to_lo_score, hi_to_lo_relation_type, hi_to_lo_ai_task_run_id,
           hi_to_lo_decided_at, relation_type, accepted, decider_key
         from relation_decisions where decider_key like 'decider-%' order by pair_key, decider_key`
      )
    ).rows;

  await record(hi, lo, 0.9, "extends", true, runA);
  assert.deepEqual(await verdicts(hi), { [lo]: { score: 0.9, relationType: "extends" } });
  assert.deepEqual(await verdicts(lo), {}, "the reverse direction is still undecided");
  const [first] = await rows();
  assert.deepEqual(
    [first.hi_to_lo_ai_task_run_id, first.lo_to_hi_ai_task_run_id, first.lo_to_hi_decided_at],
    [runA, null, null],
    "only the recorded direction has a run and a time"
  );
  assert.ok(first.hi_to_lo_decided_at instanceof Date, "the recorded direction has a time");
  await record(lo, hi, 0.2, "related", false, runB);
  assert.deepEqual(await verdicts(lo), { [hi]: { score: 0.2, relationType: "related" } });
  assert.deepEqual(await verdicts(hi), { [lo]: { score: 0.9, relationType: "extends" } });
  const [both] = await rows();
  assert.deepEqual(
    {
      pair_key: both.pair_key,
      lo_to_hi_score: both.lo_to_hi_score,
      lo_to_hi_relation_type: both.lo_to_hi_relation_type,
      hi_to_lo_score: both.hi_to_lo_score,
      hi_to_lo_relation_type: both.hi_to_lo_relation_type,
      relation_type: both.relation_type,
      accepted: both.accepted,
      decider_key: both.decider_key
    },
    {
      pair_key: `${lo}:${hi}`,
      lo_to_hi_score: 0.2,
      lo_to_hi_relation_type: "related",
      hi_to_lo_score: 0.9,
      hi_to_lo_relation_type: "extends",
      relation_type: "extends",
      accepted: true,
      decider_key: "decider-a"
    }
  );
  // Each direction keeps the AI run and the time of its own decision.
  assert.deepEqual(
    [both.hi_to_lo_ai_task_run_id, both.lo_to_hi_ai_task_run_id],
    [runA, runB],
    "recording one direction never moves the other direction's run"
  );
  assert.equal(
    both.hi_to_lo_decided_at.getTime(),
    first.hi_to_lo_decided_at.getTime(),
    "recording one direction never moves the other direction's time"
  );
  assert.ok(both.lo_to_hi_decided_at instanceof Date);
  assert.ok(both.lo_to_hi_decided_at.getTime() >= first.hi_to_lo_decided_at.getTime());
  // Deciding a direction again replaces its run, even with no run at all.
  await record(hi, lo, 0.95, "extends", true, null);
  const [again] = await rows();
  assert.deepEqual(
    [again.hi_to_lo_ai_task_run_id, again.lo_to_hi_ai_task_run_id],
    [null, runB],
    "the recording direction takes the new run, the other keeps its own"
  );
  assert.ok(again.hi_to_lo_decided_at.getTime() >= both.hi_to_lo_decided_at.getTime());
  await record(hi, lo, 0.9, "extends", true, runA);
  // Another decider keeps its own row; a different decider key never answers for this one.
  await record(lo, mid, 0.4, "related", false, runC, "decider-b");
  assert.deepEqual(await verdicts(lo), { [hi]: { score: 0.2, relationType: "related" } });
  assert.deepEqual(await verdicts(lo, hashes[lo], "decider-b"), {
    [mid]: { score: 0.4, relationType: "related" }
  });
  // Changed content is a different input: no verdict, and recording it drops the stale direction.
  assert.deepEqual(await verdicts(hi, "hash-hi-edited"), {});
  await record(hi, lo, 0.3, "related", false, runC, "decider-a", "hash-hi-edited");
  const [pair] = (await rows()).filter((row) => row.pair_key === `${lo}:${hi}`);
  assert.deepEqual(
    [pair.lo_to_hi_score, pair.hi_to_lo_score, pair.accepted, pair.relation_type],
    [null, 0.3, false, null],
    "a content change resets the pair"
  );
  assert.deepEqual(
    [pair.lo_to_hi_ai_task_run_id, pair.lo_to_hi_decided_at, pair.hi_to_lo_ai_task_run_id],
    [null, null, runC],
    "the stale direction loses its run and time with its verdict"
  );
  assert.deepEqual(await verdicts(lo), {}, "the old direction is gone with the old content");

  // Constraints refuse inconsistent rows.
  const insert = `insert into relation_decisions (pair_key, lo_atomic_note_id, hi_atomic_note_id,
    lo_content_hash, hi_content_hash, decider_key, lo_to_hi_score, lo_to_hi_relation_type,
    lo_to_hi_decided_at, lo_to_hi_ai_task_run_id, hi_to_lo_decided_at, hi_to_lo_ai_task_run_id,
    relation_type, accepted)
    values ($1, $2, $3, 'a', 'b', 'decider-c', $4, $5, $6, $7, $8, $9, $10, $11)`;
  const at = new Date();
  // A valid lo -> hi verdict with its time; each case breaks exactly one rule.
  const valid = {
    pair: `${lo}:${mid}`,
    lo,
    hi: mid,
    score: 0.5 as number | null,
    type: "related" as string | null,
    loAt: at as Date | null,
    loRun: null as string | null,
    hiAt: null as Date | null,
    hiRun: null as string | null,
    relationType: null as string | null,
    accepted: false
  };
  const invalid = async (label: string, change: Partial<typeof valid>) => {
    const v = { ...valid, ...change };
    await assert.rejects(
      db.query(insert, [
        v.pair,
        v.lo,
        v.hi,
        v.score,
        v.type,
        v.loAt,
        v.loRun,
        v.hiAt,
        v.hiRun,
        v.relationType,
        v.accepted
      ]),
      /check constraint/,
      label
    );
  };
  await invalid("pair order", { pair: `${hi}:${lo}`, lo: hi, hi: lo });
  await invalid("pair key", { pair: `${lo}:${mid}x` });
  await invalid("score range", { score: 1.5 });
  await invalid("score without type", { type: null });
  await invalid("no direction", { score: null, type: null, loAt: null });
  await invalid("type list", { type: "invented" });
  await invalid("accepted type", { score: 0.9, type: "supports", accepted: true });
  await invalid("score without time", { loAt: null });
  await invalid("time without score", { hiAt: at });
  await invalid("run without score", { hiRun: runA });

  // Cascades: a deleted audit run is unlinked in its direction, a deleted note takes its decisions.
  await db.query("delete from ai_task_runs where id = any($1::uuid[])", [[runA, runB, runC]]);
  assert.ok(
    (await rows()).every(
      (row) => row.lo_to_hi_ai_task_run_id === null && row.hi_to_lo_ai_task_run_id === null
    ),
    "audit runs unlinked"
  );
  await db.query("delete from atomic_notes where id = $1", [mid]);
  assert.deepEqual(
    (await rows()).map((row) => row.pair_key),
    [`${lo}:${hi}`],
    "decisions of a deleted note are deleted"
  );

  console.info(
    JSON.stringify({
      verified: [
        "0044, 0045 and 0046 applied as pending migrations on a database with history and data",
        "0046 backfilled the audit of every decided direction of legacy pair-level rows",
        "0044 and 0046 applied through the baseline seed on an empty database",
        "identical columns, types, nullability, indexes and constraints on both paths",
        "per-direction verdicts keyed by content hashes and decider; reverse direction undecided",
        "each direction keeps its own AI run and time; a content change resets the pair",
        "constraints refuse inconsistent rows, including run or time without a verdict",
        "per-direction ai_task_run_id set null and note deletion cascade"
      ],
      migrations: tags.length
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
