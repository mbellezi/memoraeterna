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
 * Real-database check of `relation_decisions` (migration 0044): the migration applied as a pending
 * migration on a database with history and data, and through the baseline seed on an empty one;
 * columns, indexes and constraints; per-direction verdicts keyed by content hashes and decider; and
 * cascades. It starts its own temporary PostgreSQL sidecar and never touches an existing database.
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
const tag = "0044_relation_decisions";

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  assert.equal(journal.entries.at(-1)?.tag, tag, "0044 is the newest migration");
  const historyCount = async (db: PgPool) =>
    Number(
      (
        await db.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]?.count
    );

  // 1. Pending path: a database migrated to 0043 with data gets only 0044.
  const db = createPgPool({ connectionString: connection.connectionString, max: 3 });
  pools.push(db);
  const previousFolder = join(workDir, "drizzle-0043");
  await cp(migrationsFolder, previousFolder, { recursive: true });
  await writeFile(
    join(previousFolder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) })
  );
  await runMigrations(db, previousFolder);
  assert.equal(await historyCount(db), journal.entries.length - 1, "history before 0044");
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
  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), journal.entries.length, "0044 applied as pending");
  assert.equal(
    (
      await db.query("select count(*)::int as count from atomic_note_relations where id = $1", [
        relation.id
      ])
    ).rows[0]?.count,
    1,
    "existing relations survive"
  );

  // 2. Baseline path: an empty database is seeded with every migration, 0044 included.
  const seededName = "memora_relation_decisions_seed";
  await db.query(`create database ${seededName}`);
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = `/${seededName}`;
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(tag), "baseline holds 0044");
  assert.equal(await historyCount(seeded), journal.entries.length, "seeded history");

  // 3. Shape: columns, types, indexes and constraints are identical on both paths.
  const shape = async (pool: PgPool) => ({
    columns: (
      await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_name = 'relation_decisions' order by column_name`
      )
    ).rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`),
    indexes: (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = 'relation_decisions' order by indexname"
      )
    ).rows.map((row) => row.indexdef),
    constraints: (
      await pool.query<{ conname: string; contype: string }>(
        `select conname, contype from pg_constraint
         where conrelid = 'relation_decisions'::regclass and contype in ('c', 'f', 'p', 'u')
         order by conname`
      )
    ).rows.map((row) => `${row.conname}:${row.contype}`)
  });
  const migrated = await shape(db);
  assert.deepEqual(await shape(seeded), migrated, "baseline and pending paths agree");
  assert.deepEqual(migrated.columns, [
    "accepted:boolean:NO",
    "ai_task_run_id:uuid:YES",
    "decided_at:timestamp with time zone:NO",
    "decider_key:text:NO",
    "hi_atomic_note_id:uuid:NO",
    "hi_content_hash:text:NO",
    "hi_to_lo_relation_type:text:YES",
    "hi_to_lo_score:double precision:YES",
    "id:uuid:NO",
    "lo_atomic_note_id:uuid:NO",
    "lo_content_hash:text:NO",
    "lo_to_hi_relation_type:text:YES",
    "lo_to_hi_score:double precision:YES",
    "pair_key:text:NO",
    "relation_type:text:YES"
  ]);
  assert.deepEqual(migrated.constraints, [
    "relation_decisions_accepted:c",
    "relation_decisions_ai_task_run_id_ai_task_runs_id_fk:f",
    "relation_decisions_directions:c",
    "relation_decisions_hi_atomic_note_id_atomic_notes_id_fk:f",
    "relation_decisions_lo_atomic_note_id_atomic_notes_id_fk:f",
    "relation_decisions_pair:c",
    "relation_decisions_pkey:p",
    "relation_decisions_types:c"
  ]);
  assert.ok(
    migrated.indexes.some((def) =>
      def.includes(
        "UNIQUE INDEX relation_decisions_pair_decider_uidx ON public.relation_decisions USING btree (pair_key, decider_key)"
      )
    ),
    "unique pair and decider"
  );
  assert.equal(migrated.indexes.length, 4, "primary key, pair/decider and both note indexes");

  // 4. Behavior: one row per pair and decider, one verdict per direction and content version.
  const decisions = createRelationDecisionRepository(db);
  const run = await createAiConfigRepository(db).recordTaskRun({
    taskType: "reranking",
    provider: "verify",
    modelId: "verify-model",
    runtime: "remote",
    durationMs: 1,
    status: "succeeded"
  });
  const hashes = { [lo]: "hash-lo", [mid]: "hash-mid", [hi]: "hash-hi" } as Record<string, string>;
  const record = (
    source: string,
    target: string,
    score: number,
    relationType: string,
    accepted: boolean,
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
      aiTaskRunId: run
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
        `select pair_key, lo_to_hi_score, lo_to_hi_relation_type, hi_to_lo_score,
           hi_to_lo_relation_type, relation_type, accepted, decider_key, ai_task_run_id
         from relation_decisions order by pair_key, decider_key`
      )
    ).rows;

  await record(hi, lo, 0.9, "extends", true);
  assert.deepEqual(await verdicts(hi), { [lo]: { score: 0.9, relationType: "extends" } });
  assert.deepEqual(await verdicts(lo), {}, "the reverse direction is still undecided");
  await record(lo, hi, 0.2, "related", false);
  assert.deepEqual(await verdicts(lo), { [hi]: { score: 0.2, relationType: "related" } });
  assert.deepEqual(await verdicts(hi), { [lo]: { score: 0.9, relationType: "extends" } });
  assert.deepEqual(await rows(), [
    {
      pair_key: `${lo}:${hi}`,
      lo_to_hi_score: 0.2,
      lo_to_hi_relation_type: "related",
      hi_to_lo_score: 0.9,
      hi_to_lo_relation_type: "extends",
      relation_type: "extends",
      accepted: true,
      decider_key: "decider-a",
      ai_task_run_id: run
    }
  ]);
  // Another decider keeps its own row; a different decider key never answers for this one.
  await record(lo, mid, 0.4, "related", false, "decider-b");
  assert.deepEqual(await verdicts(lo), { [hi]: { score: 0.2, relationType: "related" } });
  assert.deepEqual(await verdicts(lo, hashes[lo], "decider-b"), {
    [mid]: { score: 0.4, relationType: "related" }
  });
  // Changed content is a different input: no verdict, and recording it drops the stale direction.
  assert.deepEqual(await verdicts(hi, "hash-hi-edited"), {});
  await record(hi, lo, 0.3, "related", false, "decider-a", "hash-hi-edited");
  const [pair] = (await rows()).filter((row) => row.pair_key === `${lo}:${hi}`);
  assert.deepEqual(
    [pair.lo_to_hi_score, pair.hi_to_lo_score, pair.accepted, pair.relation_type],
    [null, 0.3, false, null],
    "a content change resets the pair"
  );
  assert.deepEqual(await verdicts(lo), {}, "the old direction is gone with the old content");

  // Constraints refuse inconsistent rows.
  const invalid = async (sql: string, values: unknown[], label: string) =>
    assert.rejects(db.query(sql, values), /check constraint/, label);
  const insert = `insert into relation_decisions (pair_key, lo_atomic_note_id, hi_atomic_note_id,
    lo_content_hash, hi_content_hash, decider_key, lo_to_hi_score, lo_to_hi_relation_type,
    relation_type, accepted) values ($1, $2, $3, 'a', 'b', 'decider-c', $4, $5, $6, $7)`;
  await invalid(insert, [`${hi}:${lo}`, hi, lo, 0.5, "related", null, false], "pair order");
  await invalid(insert, [`${lo}:${mid}x`, lo, mid, 0.5, "related", null, false], "pair key");
  await invalid(insert, [`${lo}:${mid}`, lo, mid, 1.5, "related", null, false], "score range");
  await invalid(insert, [`${lo}:${mid}`, lo, mid, 0.5, null, null, false], "score without type");
  await invalid(insert, [`${lo}:${mid}`, lo, mid, null, null, null, false], "no direction");
  await invalid(insert, [`${lo}:${mid}`, lo, mid, 0.5, "invented", null, false], "type list");
  await invalid(insert, [`${lo}:${mid}`, lo, mid, 0.9, "supports", null, true], "accepted type");

  // Cascades: a deleted audit run is unlinked, a deleted note takes its decisions along.
  await db.query("delete from ai_task_runs where id = $1", [run]);
  assert.ok(
    (await rows()).every((row) => row.ai_task_run_id === null),
    "audit run unlinked"
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
        "0044 applied as a pending migration on a database with history and data",
        "0044 applied through the baseline seed on an empty database",
        "identical columns, types, nullability, indexes and constraints on both paths",
        "per-direction verdicts keyed by content hashes and decider; reverse direction undecided",
        "content change resets the pair; constraints refuse inconsistent rows",
        "ai_task_run_id set null and note deletion cascade"
      ],
      migrations: journal.entries.length
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
