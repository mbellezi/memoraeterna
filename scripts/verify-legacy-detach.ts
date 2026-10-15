import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import "../apps/desktop/src/main/services/verify-worker-host.js";
import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createHierarchicalIngestionRepository,
  createIngestionRunRepository,
  createJobRepository,
  createPgPool,
  createSourceItemRepository,
  legacyContentTables,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  DocumentDivisionCandidateSchema,
  ProcessingPlanRequestSchema,
  SourceDescriptorSchema
} from "@app/domain";
import { BackupService } from "../apps/desktop/src/main/services/backup-service.js";
import { backupKeyTables } from "../apps/desktop/src/main/services/backup-verifier.js";
import {
  goldenManifestSchema,
  goldenSourcePath,
  verifyGoldenFile
} from "../apps/desktop/src/main/services/golden-runner.js";
import { HierarchicalIngestionService } from "../apps/desktop/src/main/services/hierarchical-ingestion-service.js";
import { IngestionService } from "../apps/desktop/src/main/services/ingestion-service.js";
import { JobSupervisor } from "../apps/desktop/src/main/services/job-supervisor.js";
import { seedAutomaticWikiFixture } from "./fixtures/automatic-wiki-fixture.js";

/**
 * Real-database proof of the legacy detach (migration 0052_legacy_detach, F2 T35a). It starts its
 * own temporary PostgreSQL sidecar and touches no other database.
 *
 * A. Pending path: a database migrated up to 0051 holds the automatic-wiki fixture, a row in every
 *    legacy-content table and an evolution row tied to a legacy run. Before 0052 the impact triggers
 *    write events and a TRUNCATE of the 30 legacy tables fails on the evolution FK. 0052 is applied:
 *    no wiki impact trigger, function or FK is left, the enum holds `retired`, the 7 fence triggers
 *    exist and every row count is unchanged. Chunk inserts (the real `replaceDocumentChunks`) are
 *    timed before and after. A pg_dump/pg_restore round trip of that database (legacy rows and the
 *    fence) and a verified backup whose key tables include the 30 legacy tables both succeed; then
 *    the TRUNCATE of the 30 tables succeeds without CASCADE.
 * B. Baseline path: an empty database seeded with every migration gets the same shape, and a golden
 *    source imported with `full_knowledge` through the real ingestion services and job supervisor
 *    (no AI route) writes 0 impact events and 0 legacy rows, with no fence refusal.
 *
 *   MEMORA_VERIFY_GOLDEN_ROOT=<checkout holding .cache/golden/sources> \
 *     npx tsx scripts/verify-legacy-detach.ts
 */
const execFileAsync = promisify(execFile);
const workspace = resolve(import.meta.dirname, "..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const seedFolder = join(workspace, "packages/db/seed");
const goldenRoot = process.env.MEMORA_VERIFY_GOLDEN_ROOT ?? workspace;
const goldenKey = "o-henry-the-gift-of-the-magi";
const target = "0052_legacy_detach";
const throughputChunks = 4_000;
const throughputRuns = 5;
const legacyPrefix = /^(wiki_|organization_|maintenance_|automatic_routine_|knowledge_impact_)/;

const workDir = await mkdtemp(join(tmpdir(), "memora-legacy-detach-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_legacy_detach",
  user: "memora_legacy_detach",
  password: `legacy-detach-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const pools: PgPool[] = [];
const report: Record<string, unknown> = {};
const round = (value: number) => Math.round(value * 10) / 10;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

async function tables(db: PgPool): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `select relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`
  );
  return result.rows.map((row) => row.name);
}

async function tableCounts(db: PgPool): Promise<Record<string, number>> {
  const names = await tables(db);
  const result = await db.query<Record<string, number>>(
    `select ${names.map((name) => `(select count(*) from "${name}")::int as "${name}"`).join(", ")}`
  );
  return result.rows[0]!;
}

/** Triggers, functions, the evolution FKs and the sync statuses: comparable across databases. */
async function detachShape(db: PgPool) {
  const triggers = await db.query<{ name: string; table: string }>(
    `select tgname as name, tgrelid::regclass::text as table from pg_trigger
      where not tgisinternal and (tgname like 'wiki_%impact%' or tgname = 'legacy_insert_fence')
      order by 2, 1`
  );
  const functions = await db.query<{ name: string }>(
    `select proname as name from pg_proc where pronamespace = 'public'::regnamespace
       and (proname like 'wiki_%impact%' or proname = 'legacy_insert_fence') order by 1`
  );
  const evolutionKeys = await db.query<{ name: string }>(
    `select conname as name from pg_constraint
      where conrelid = 'atomic_note_evolution'::regclass and contype = 'f' order by 1`
  );
  const statuses = await db.query<{ value: string }>(
    "select unnest(enum_range(null::obsidian_sync_status))::text as value"
  );
  return {
    triggers: triggers.rows,
    functions: functions.rows.map((row) => row.name),
    evolutionKeys: evolutionKeys.rows.map((row) => row.name),
    statuses: statuses.rows.map((row) => row.value)
  };
}

function assertDetached(shape: Awaited<ReturnType<typeof detachShape>>, where: string) {
  assert.deepEqual(
    shape.triggers.filter((row) => row.name !== "legacy_insert_fence"),
    [],
    `${where}: no wiki impact trigger`
  );
  assert.deepEqual(
    shape.triggers.map((row) => row.table).sort(),
    [...legacyContentTables].sort(),
    `${where}: one fence trigger per legacy-content table`
  );
  assert.deepEqual(shape.functions, ["legacy_insert_fence"], `${where}: the 4 impact functions go`);
  assert.deepEqual(
    shape.evolutionKeys,
    [
      "atomic_note_evolution_next_id_atomic_notes_id_fk",
      "atomic_note_evolution_previous_id_atomic_notes_id_fk"
    ],
    `${where}: the evolution run FK goes`
  );
  assert.equal(shape.statuses.at(-1), "retired", `${where}: the sync status enum holds retired`);
}

/** One row in each legacy-content table, written by a session that is allowed to. */
async function seedLegacyRows(db: PgPool, page: string, noteIds: [string, string]) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local memora.legacy_fixture = 'on'");
    const job = (
      await client.query<{ id: string }>(
        "insert into jobs (type, status, payload) values ('maintenance', 'succeeded', '{}') returning id"
      )
    ).rows[0]!.id;
    const run = (
      await client.query<{ id: string }>(
        "insert into organization_runs (status, snapshot, checkpoint) values ('applied', '{}', '{}') returning id"
      )
    ).rows[0]!.id;
    await client.query(
      "insert into atomic_note_evolution (previous_id, next_id, run_id, kind, reason) values ($1, $2, $3, 'merge', 'verify')",
      [noteIds[0], noteIds[1], run]
    );
    const settings = (
      await client.query<{ id: string }>(
        "insert into organization_settings_revisions (configuration, hash) values ('{}', 'hash') returning id"
      )
    ).rows[0]!.id;
    await client.query("insert into organization_settings_activations (revision_id) values ($1)", [
      settings
    ]);
    await client.query(
      "insert into maintenance_schedules (policy, next_at) values ('{}', now() + interval '1 day')"
    );
    await client.query(
      `insert into maintenance_runs (job_id, scope_key, period, schedule_ids, status, snapshot, checkpoint, reservation)
       values ($1, 'scope', 'p1', '[]', 'no_change', '{}', '{}', '{}')`,
      [job]
    );
    const policyRevision = randomUUID();
    await client.query(
      `insert into wiki_policy_revisions (id, policy_id, policy, preview, preview_hash)
       values ($1, $2, '{}', '{}', 'hash')`,
      [policyRevision, randomUUID()]
    );
    await client.query(
      `insert into wiki_investigations (id, request_id, identity, question, answer_page_id, policy_id,
         policy_revision_id, state, input, current, gaps)
       values ($1, $2, 'verify', 'Question?', $3, $4, $5, 'paused', '{}', '{}', '[]')`,
      [randomUUID(), randomUUID(), page, randomUUID(), policyRevision]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Chunks per second through the ingestion path (`replaceDocumentChunks`), on fresh documents. */
async function chunkThroughput(db: PgPool, label: string) {
  const durations: number[] = [];
  const sources = createSourceItemRepository(db);
  const documents = createDocumentRepository(db);
  const chunks = createChunkRepository(db);
  for (let run = 0; run < throughputRuns; run += 1) {
    const source = await sources.create({
      type: "StandaloneArticle",
      title: `Throughput ${label} ${run}`
    });
    const document = await documents.create({
      sourceItemId: source.id,
      title: "Throughput",
      canonicalMarkdown: "Throughput",
      contentHash: randomUUID()
    });
    const input = Array.from({ length: throughputChunks }, (_, index) => {
      const id = randomUUID();
      const span = randomUUID();
      return {
        id,
        sourceSpanId: span,
        chunkIndex: index,
        content: `Passage ${index} of the throughput document, long enough to look like text.`,
        contentHash: `${label}-${run}-${index}`,
        span: { id: span, startOffset: index * 100, endOffset: index * 100 + 99 }
      };
    });
    const started = performance.now();
    await chunks.replaceDocumentChunks(document.id, source.id, input);
    durations.push(performance.now() - started);
  }
  await db.query("delete from source_items where title like $1", [`Throughput ${label} %`]);
  const ms = median(durations);
  return {
    chunks: throughputChunks,
    runs: throughputRuns,
    medianMs: round(ms),
    chunksPerSecond: Math.round(throughputChunks / (ms / 1000))
  };
}

async function fenced(db: PgPool, setting: "off" | null) {
  const client = await db.connect();
  try {
    if (setting) await client.query(`set memora.legacy_fixture = '${setting}'`);
    await client.query("insert into wiki_pages (title, kind) values ('Fenced', 'topic')");
    return false;
  } catch (error) {
    return (error as Error).message === "legacy.errors.retired";
  } finally {
    client.release();
  }
}

const databaseUrl = (connectionString: string, database: string) => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
};

try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const tags: string[] = journal.entries.map((entry: { tag: string }) => entry.tag);
  const index = tags.indexOf(target);
  assert.ok(index > 0, `${target} is in the journal`);

  // A. Pending path: a legacy library at 0051.
  const before = join(workDir, "drizzle-before");
  await cp(migrationsFolder, before, { recursive: true });
  await writeFile(
    join(before, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) })
  );
  const legacy = createPgPool({ connectionString: connection.connectionString, max: 4 });
  pools.push(legacy);
  await runMigrations(legacy, before);
  const fixture = await seedAutomaticWikiFixture(legacy, true);
  const firstNote = fixture.noteIds[0]!;
  const note = (
    await legacy.query<{ source: string; chunk: string }>(
      "select created_from_source_item_id as source, evidence_chunk_id as chunk from atomic_notes where id = $1",
      [firstNote]
    )
  ).rows[0]!;
  const secondNote = randomUUID();
  await legacy.query(
    `insert into atomic_notes (id, title, idea_statement, body_markdown, created_from_source_item_id,
       evidence_chunk_id, generation_provider, generation_model, generation_runtime,
       generation_prompt_version, generation_key)
     values ($1::uuid, 'Evolved note', 'Evolved', 'Evolved', $2, $3, 'synthetic', 'fixture', 'test',
       'fixture-v1', $1::text)`,
    [secondNote, note.source, note.chunk]
  );
  await seedLegacyRows(legacy, fixture.humanId, [firstNote, secondNote]);
  const legacyTables = (await tables(legacy)).filter((name) => legacyPrefix.test(name));
  assert.equal(legacyTables.length, 30, "30 legacy tables");
  for (const table of legacyContentTables)
    assert.ok(
      Number((await legacy.query(`select count(*)::int as n from ${table}`)).rows[0]!.n) > 0,
      `${table} holds a row at 0051`
    );
  const eventsAt0051 = Number(
    (await legacy.query("select count(*)::int as n from knowledge_impact_events")).rows[0]!.n
  );
  assert.ok(eventsAt0051 > 0, "before 0052 the impact triggers write events");
  const truncate = `truncate table ${legacyTables.join(", ")}`;
  const attempt = await legacy.connect();
  let blocked: string | null = null;
  try {
    await attempt.query("begin");
    await attempt.query(truncate);
  } catch (error) {
    blocked = (error as Error).message;
  } finally {
    await attempt.query("rollback");
    attempt.release();
  }
  assert.match(
    blocked ?? "",
    /cannot truncate a table referenced in a foreign key constraint/,
    "before 0052 the evolution FK blocks the TRUNCATE"
  );
  const throughputBefore = await chunkThroughput(legacy, "0051");
  const countsBefore = await tableCounts(legacy);
  const eventsBeforeImport = countsBefore.knowledge_impact_events!;

  const migrated = await runMigrations(legacy, migrationsFolder);
  assert.equal(
    migrated.seed.applied,
    false,
    "a database with history only runs pending migrations"
  );
  const history = await legacy.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]!.count), tags.length, "0052 applied as a pending migration");
  const pendingShape = await detachShape(legacy);
  assertDetached(pendingShape, "pending path");
  const countsAfter = await tableCounts(legacy);
  assert.deepEqual(countsAfter, countsBefore, "every row count is unchanged by 0052");
  assert.ok(await fenced(legacy, "off"), "without the fixture setting a legacy insert is refused");
  const throughputAfter = await chunkThroughput(legacy, "0052");
  const eventsAfterThroughput = Number(
    (await legacy.query("select count(*)::int as n from knowledge_impact_events")).rows[0]!.n
  );
  assert.equal(
    eventsAfterThroughput,
    eventsBeforeImport,
    "chunk inserts after 0052 write no event"
  );
  report.pendingPath = {
    legacyTables: legacyTables.length,
    legacyRows: Object.fromEntries(legacyTables.map((table) => [table, countsBefore[table]])),
    impactEventsWrittenAt0051: eventsAt0051,
    truncateAt0051: blocked,
    tablesCompared: Object.keys(countsBefore).length,
    rowsCompared: Object.values(countsBefore).reduce((sum, value) => sum + value, 0),
    shape: pendingShape
  };
  report.chunkInsert = {
    before: throughputBefore,
    after: throughputAfter,
    speedup: round(throughputAfter.chunksPerSecond / throughputBefore.chunksPerSecond)
  };

  // A. Round trip: pg_dump and pg_restore of the legacy library with the fence in place.
  const dumpPath = join(workDir, "legacy.dump");
  const credentials = { ...process.env, PGPASSWORD: connection.password };
  const server = ["--host", connection.host, "--port", String(connection.port)];
  const dumpStarted = performance.now();
  await execFileAsync(
    join(sidecar.binDir, "pg_dump"),
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...server,
      "--username",
      connection.user,
      "--file",
      dumpPath,
      connection.database
    ],
    { env: credentials }
  );
  await legacy.query("create database memora_legacy_detach_restored");
  await execFileAsync(
    join(sidecar.binDir, "pg_restore"),
    [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      ...server,
      "--username",
      connection.user,
      "--dbname",
      "memora_legacy_detach_restored",
      dumpPath
    ],
    { env: credentials }
  );
  const roundTripMs = performance.now() - dumpStarted;
  const restored = createPgPool({
    connectionString: databaseUrl(connection.connectionString, "memora_legacy_detach_restored"),
    max: 2
  });
  pools.push(restored);
  assert.deepEqual(await tableCounts(restored), countsAfter, "the restore holds every row");
  assertDetached(await detachShape(restored), "restored copy");
  assert.ok(await fenced(restored, null), "the restored fence refuses legacy inserts");

  // The verified backup the legacy wipe takes: key tables extended with the 30 legacy tables.
  const backupRoot = join(workDir, "backups");
  await mkdir(backupRoot);
  const backup = await new BackupService({
    getDatabaseContext: () => ({ connection, pgDumpPath: join(sidecar.binDir, "pg_dump") }),
    getStorageSettings: async () => ({
      obsidianVaultPath: null,
      managedRoot: "Memora",
      obsidianSyncEnabled: false,
      obsidianSyncPaused: false,
      deletionPolicy: "tombstone",
      uploadCopiesEnabled: false,
      uploadCopiesFolderPath: null,
      updatedAt: new Date().toISOString()
    }),
    keyTables: [...backupKeyTables, ...legacyTables]
  }).create(backupRoot);
  assert.ok(backup.verified, "the backup restores with matching legacy counts");
  report.roundTrip = {
    pgDumpPgRestoreMs: Math.round(roundTripMs),
    restoredTables: Object.keys(countsAfter).length,
    verifiedBackup: { verified: backup.verified, keyTables: backupKeyTables.length + 30 }
  };

  // A. The TRUNCATE of the 30 legacy tables now succeeds without CASCADE.
  const truncateStarted = performance.now();
  await legacy.query(truncate);
  const truncateMs = performance.now() - truncateStarted;
  const afterTruncate = await tableCounts(legacy);
  for (const table of legacyTables) assert.equal(afterTruncate[table], 0, `${table} is empty`);
  for (const [table, count] of Object.entries(afterTruncate))
    if (!legacyPrefix.test(table))
      assert.equal(count, countsAfter[table], `${table} is untouched by the TRUNCATE`);
  assert.equal(afterTruncate.atomic_note_evolution, 1, "the evolution row survives its legacy run");
  report.truncate = { tables: legacyTables.length, ms: round(truncateMs), fkError: false };

  // B. Baseline path, then a golden import with full_knowledge.
  await legacy.query("create database memora_legacy_detach_seed");
  const seeded = createPgPool({
    connectionString: databaseUrl(connection.connectionString, "memora_legacy_detach_seed"),
    max: 5
  });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(
    seed.seed.applied && seed.seed.seededMigrations.includes(target),
    "baseline holds 0052"
  );
  assert.deepEqual(
    await detachShape(seeded),
    pendingShape,
    "baseline and migration give one shape"
  );
  assert.ok(await fenced(seeded, null), "the baseline database refuses legacy inserts");

  const manifest = goldenManifestSchema.parse(
    JSON.parse(await readFile(join(workspace, "scripts/golden/manifest.json"), "utf8"))
  );
  const golden = manifest.sources.find((source) => source.key === goldenKey);
  assert.ok(golden && golden.kind === "document" && golden.import === "file", "golden source");
  const goldenPath = goldenSourcePath(goldenRoot, golden);
  assert.deepEqual(
    await verifyGoldenFile(goldenPath, golden),
    { status: "ok" },
    `${goldenPath} matches its pinned size and SHA-256`
  );
  const storageSettings = async () => ({
    obsidianVaultPath: null,
    managedRoot: "Memora",
    obsidianSyncEnabled: false,
    obsidianSyncPaused: false,
    deletionPolicy: "tombstone" as const,
    uploadCopiesEnabled: false,
    uploadCopiesFolderPath: null,
    updatedAt: new Date().toISOString()
  });
  const hierarchy = new HierarchicalIngestionService({ getPool: () => seeded });
  const ingestion = new IngestionService({
    getPool: () => seeded,
    getStorageSettings: storageSettings,
    userDataPath: join(workDir, "userData"),
    resourcesPath: workspace,
    workspaceRoot: workspace,
    isPackaged: false,
    hierarchicalIngestionService: hierarchy,
    fetchExternalPage: async () => new Response("", { status: 500 })
  });
  const fullKnowledge = ProcessingPlanRequestSchema.parse({
    preset: "full_knowledge",
    requestedStages: []
  });
  let imported = await ingestion.importFile(goldenPath, {
    descriptor: SourceDescriptorSchema.parse({
      ...golden.descriptor,
      title: golden.title,
      language: golden.language
    }),
    duplicatePolicy: "ignore",
    processingPlan: fullKnowledge
  });
  if (imported.requiresStructureReview && imported.structureId) {
    const structure = (await hierarchy.getStructure(imported.structureId))!;
    const confirmed = await hierarchy.confirmStructure({
      structureId: imported.structureId,
      divisions: structure.divisions.map((division) =>
        DocumentDivisionCandidateSchema.parse({
          id: division.id,
          parentId: division.parentId,
          kind: division.kind,
          title: division.title,
          level: division.level,
          position: division.position,
          startSelector: division.startSelector,
          endSelector: division.endSelector,
          ...(division.startPage === undefined ? {} : { startPage: division.startPage }),
          ...(division.endPage === undefined ? {} : { endPage: division.endPage }),
          ...(division.markdownStart === undefined
            ? {}
            : { markdownStart: division.markdownStart }),
          ...(division.markdownEnd === undefined ? {} : { markdownEnd: division.markdownEnd }),
          confidence: division.confidence,
          evidence: division.evidence,
          reviewStatus: division.reviewStatus,
          isProcessable: division.isProcessable,
          metadata: division.metadata
        })
      ),
      plan: fullKnowledge
    });
    imported = { ...imported, batchId: confirmed.batchId };
  }
  const supervisor = new JobSupervisor({ getPool: () => seeded });
  const jobs = createJobRepository(seeded);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await supervisor.runOnce();
    const open = await seeded.query<{ n: number }>(
      "select count(*)::int as n from jobs where status::text in ('queued', 'running')"
    );
    if (open.rows[0]!.n === 0) break;
  }
  const settledJobs = await jobs.list();
  const runs = await createIngestionRunRepository(seeded).listByBatch(imported.batchId!);
  const batch = (await createHierarchicalIngestionRepository(seeded).listBatches()).find(
    (item) => item.id === imported.batchId
  );
  const importCounts = await tableCounts(seeded);
  assert.ok(importCounts.chunks! > 0, "the golden source was chunked");
  assert.equal(importCounts.knowledge_impact_events, 0, "the import writes no impact event");
  for (const table of legacyTables)
    assert.equal(importCounts[table], 0, `the import writes no ${table} row`);
  assert.ok(
    settledJobs.every((job) => !String(job.error ?? "").includes("legacy.errors.retired")),
    "no job met the fence"
  );
  assert.ok(runs.length > 0, "the import queued its runs");
  for (const run of runs) assert.ok(!run.effectiveStages.includes("organizeKnowledge"));
  assert.ok(
    !(batch?.effectivePlan.effectiveStages as string[]).includes("organizeKnowledge"),
    "the batch plan has no organizeKnowledge"
  );
  report.goldenImport = {
    source: `${goldenKey} (${golden.bytes} bytes, sha256 ${golden.sha256?.slice(0, 12)}…)`,
    plan: "full_knowledge (no AI route)",
    batch: batch ? { status: batch.status, items: batch.totalItems } : null,
    runs: runs.map((run) => ({
      status: run.status,
      stages: Object.fromEntries(
        Object.entries(run.stagesCheckpoint).map(([stage, value]) => [
          stage,
          (value as { status?: string }).status
        ])
      )
    })),
    jobs: settledJobs.map((job) => `${job.type}:${job.status}`),
    rows: {
      source_items: importCounts.source_items,
      documents: importCounts.documents,
      chunks: importCounts.chunks,
      knowledge_impact_events: importCounts.knowledge_impact_events,
      legacyRows: legacyTables.reduce((sum, table) => sum + importCounts[table]!, 0)
    }
  };
  console.log(`LEGACY_DETACH_PROOF ${JSON.stringify(report, null, 2)}`);
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
