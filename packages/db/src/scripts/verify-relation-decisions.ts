import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
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
 * verdicts keyed by content hashes and decider, each with its own AI run and time; the score scale
 * of 0056 (ranker log-odds rows without types, reused only on equal rendered inputs; no pair-level
 * outcome written); and cascades. It starts its own temporary PostgreSQL sidecar and never touches
 * an existing database.
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
  // A relation as the matcher stored it before relations v2 (this database is at 0043).
  const relation = (
    await db.query<{ id: string }>(
      `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
         final_score, explanation) values ($1, $2, 'supports', 0.9, 'verify') returning id`,
      [lo, hi]
    )
  ).rows[0]!;
  // An AI run the decisions reference, written with the columns every schema step has: the
  // repository writer targets the latest schema, which this database reaches only at the end.
  const newRun = async () =>
    (
      await db.query<{ id: string }>(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
         values ('reranking', 'verify', 'verify-model', 'remote', 1, 'succeeded', now()) returning id`
      )
    ).rows[0]!.id;

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
      "relation_type:text:YES",
      "score_scale:text:NO"
    ].sort(),
    "per-direction audit columns replace the pair-level ones; 0056 adds the score scale"
  );
  assert.deepEqual(
    migrated.constraints,
    [
      "relation_decisions_decided_at:c",
      "relation_decisions_directions:c",
      "relation_decisions_hi_atomic_note_id_atomic_notes_id_fk:f",
      "relation_decisions_hi_to_lo_ai_task_run_id_ai_task_runs_id_fk:f",
      "relation_decisions_lo_atomic_note_id_atomic_notes_id_fk:f",
      "relation_decisions_lo_to_hi_ai_task_run_id_ai_task_runs_id_fk:f",
      "relation_decisions_pair:c",
      "relation_decisions_pkey:p",
      "relation_decisions_score_scale:c",
      "relation_decisions_types:c"
    ].sort(),
    "0056 drops relation_decisions_accepted and adds the scale check"
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
  // The verdict of the reverse direction (target -> source) on the same content and decider.
  const reverseVerdicts = (
    source: string,
    sourceHash = hashes[source]!,
    deciderKey = "decider-a"
  ) =>
    decisions
      .findReverseVerdicts({
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

  await record(hi, lo, 0.9, "extends", runA);
  assert.deepEqual(await verdicts(hi), { [lo]: { score: 0.9, relationType: "extends" } });
  assert.deepEqual(await verdicts(lo), {}, "the reverse direction is still undecided");
  // One judgment answers the pair: the undecided direction reads the decided one as its reverse.
  assert.deepEqual(
    await reverseVerdicts(lo),
    { [hi]: { score: 0.9, relationType: "extends" } },
    "lo reuses the verdict of hi -> lo"
  );
  assert.deepEqual(await reverseVerdicts(hi), {}, "hi -> lo has no reverse verdict to reuse");
  const [first] = await rows();
  assert.deepEqual(
    [first.hi_to_lo_ai_task_run_id, first.lo_to_hi_ai_task_run_id, first.lo_to_hi_decided_at],
    [runA, null, null],
    "only the recorded direction has a run and a time"
  );
  assert.ok(first.hi_to_lo_decided_at instanceof Date, "the recorded direction has a time");
  await record(lo, hi, 0.2, "related", runB);
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
      // The pair-level outcome is no longer written (F3 D12): calibration owns acceptance.
      relation_type: null,
      accepted: false,
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
  await record(hi, lo, 0.95, "extends", null);
  const [again] = await rows();
  assert.deepEqual(
    [again.hi_to_lo_ai_task_run_id, again.lo_to_hi_ai_task_run_id],
    [null, runB],
    "the recording direction takes the new run, the other keeps its own"
  );
  assert.ok(again.hi_to_lo_decided_at.getTime() >= both.hi_to_lo_decided_at.getTime());
  await record(hi, lo, 0.9, "extends", runA);
  // Another decider keeps its own row; a different decider key never answers for this one.
  await record(lo, mid, 0.4, "related", runC, "decider-b");
  assert.deepEqual(await verdicts(lo), { [hi]: { score: 0.2, relationType: "related" } });
  assert.deepEqual(await verdicts(lo, hashes[lo], "decider-b"), {
    [mid]: { score: 0.4, relationType: "related" }
  });
  assert.deepEqual(
    await reverseVerdicts(mid, hashes[mid], "decider-b"),
    { [lo]: { score: 0.4, relationType: "related" } },
    "a reverse verdict belongs to its own decider"
  );
  assert.deepEqual(
    await reverseVerdicts(mid, hashes[mid], "decider-a"),
    {},
    "another decider's verdict is never reused"
  );
  // Changed content is a different input: no verdict, and recording it drops the stale direction.
  assert.deepEqual(await verdicts(hi, "hash-hi-edited"), {});
  await record(hi, lo, 0.3, "related", runC, "decider-a", "hash-hi-edited");
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
  assert.deepEqual(
    await reverseVerdicts(lo),
    {},
    "a reverse verdict recorded on the old content is not reused"
  );
  assert.deepEqual(
    await reverseVerdicts(hi, "hash-hi-edited"),
    {},
    "the edited note finds nothing to reuse: the other direction went with the old content"
  );

  // Ranker rows (0056, F3 D12): raw log-odds per direction, no type, reused only on equal
  // rendered-input hashes and decider key; they never answer a generative lookup.
  const rankerKey = "decider-ranker";
  await decisions.recordRankerScores({
    loAtomicNoteId: lo,
    hiAtomicNoteId: hi,
    loInputHash: "render-lo",
    hiInputHash: "render-hi",
    deciderKey: rankerKey,
    loToHi: 4.25,
    hiToLo: -1.5,
    aiTaskRunId: runC
  });
  const rankerPair = [
    { loAtomicNoteId: lo, hiAtomicNoteId: hi, loInputHash: "render-lo", hiInputHash: "render-hi" }
  ];
  assert.deepEqual(
    Object.fromEntries(
      await decisions.findRankerScores({ deciderKey: rankerKey, pairs: rankerPair })
    ),
    { [`${lo}:${hi}`]: { loToHi: 4.25, hiToLo: -1.5 } },
    "both directions' raw log-odds are stored"
  );
  assert.equal(
    (
      await decisions.findRankerScores({
        deciderKey: rankerKey,
        pairs: [{ ...rankerPair[0]!, hiInputHash: "render-hi-edited" }]
      })
    ).size,
    0,
    "a changed rendered input is never reused"
  );
  assert.deepEqual(
    await verdicts(hi, hashes[hi], rankerKey),
    {},
    "ranker rows never answer a probability lookup"
  );
  // The Decisions decider's neighbourhood (plan decision 30): the other endpoint of every pair with
  // a stored direction under the decider's key, from either side, and nothing under another key.
  const partners = await decisions.findDecidedPartners({
    deciderKey: rankerKey,
    noteIds: [lo, hi, randomUUID()]
  });
  assert.deepEqual(
    Object.fromEntries(partners),
    { [lo]: [hi], [hi]: [lo] },
    "a pair is a partner of both of its notes"
  );
  assert.equal(
    (await decisions.findDecidedPartners({ deciderKey: "another-key", noteIds: [lo, hi] })).size,
    0,
    "partners are read under one decider key"
  );
  assert.equal(
    (await decisions.findDecidedPartners({ deciderKey: rankerKey, noteIds: [] })).size,
    0,
    "no note asks for nothing"
  );
  const [rankerRow] = (
    await db.query(
      `select score_scale, lo_to_hi_relation_type, hi_to_lo_relation_type, relation_type, accepted,
              lo_to_hi_ai_task_run_id, hi_to_lo_ai_task_run_id
         from relation_decisions where decider_key = $1`,
      [rankerKey]
    )
  ).rows;
  assert.deepEqual(rankerRow, {
    score_scale: "log_odds",
    lo_to_hi_relation_type: null,
    hi_to_lo_relation_type: null,
    relation_type: null,
    accepted: false,
    lo_to_hi_ai_task_run_id: runC,
    hi_to_lo_ai_task_run_id: runC
  });
  await assert.rejects(
    decisions.record({
      sourceAtomicNoteId: lo,
      targetAtomicNoteId: hi,
      sourceContentHash: "render-lo",
      targetContentHash: "render-hi",
      deciderKey: rankerKey,
      score: 0.5,
      relationType: "supports",
      aiTaskRunId: null
    }),
    /two score scales/,
    "one decider key never mixes scales"
  );
  await db.query("delete from relation_decisions where decider_key = $1", [rankerKey]);

  // Constraints refuse inconsistent rows.
  const insert = `insert into relation_decisions (pair_key, lo_atomic_note_id, hi_atomic_note_id,
    lo_content_hash, hi_content_hash, decider_key, lo_to_hi_score, lo_to_hi_relation_type,
    lo_to_hi_decided_at, lo_to_hi_ai_task_run_id, hi_to_lo_decided_at, hi_to_lo_ai_task_run_id,
    relation_type, accepted, score_scale)
    values ($1, $2, $3, 'a', 'b', 'decider-c', $4, $5, $6, $7, $8, $9, $10, $11, $12)`;
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
    accepted: false,
    scale: "probability"
  };
  const values = (change: Partial<typeof valid>) => {
    const v = { ...valid, ...change };
    return [
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
      v.accepted,
      v.scale
    ];
  };
  const invalid = async (label: string, change: Partial<typeof valid>) => {
    await assert.rejects(db.query(insert, values(change)), /check constraint/, label);
  };
  await invalid("pair order", { pair: `${hi}:${lo}`, lo: hi, hi: lo });
  await invalid("pair key", { pair: `${lo}:${mid}x` });
  await invalid("score range", { score: 1.5 });
  await invalid("score without type", { type: null });
  await invalid("no direction", { score: null, type: null, loAt: null });
  await invalid("type list", { type: "invented" });
  await invalid("score without time", { loAt: null });
  await invalid("time without score", { hiAt: at });
  await invalid("run without score", { hiRun: runA });
  await invalid("score scale list", { scale: "logit" });
  await invalid("a log-odds row has no type", { scale: "log_odds", score: 3.5 });
  await invalid("log-odds are finite", { scale: "log_odds", type: null, score: Infinity });
  await invalid("log-odds are a number", { scale: "log_odds", type: null, score: Number.NaN });
  // A log-odds score outside [0, 1] is valid, and so is a write-vocabulary type (0056).
  for (const change of [
    { scale: "log_odds", type: null, score: -3.5 },
    { type: "contradicts", score: 0.75 }
  ]) {
    await db.query(insert, values(change));
    await db.query("delete from relation_decisions where decider_key = 'decider-c'");
  }

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
        "an undecided direction reads the decided one as its reverse, for the same decider and content only",
        "each direction keeps its own AI run and time; a content change resets the pair",
        "0056: ranker rows store raw log-odds per direction with no type, on their own scale",
        "the Decisions decider's decided neighbourhood: the partners of a note under one decider key",
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
