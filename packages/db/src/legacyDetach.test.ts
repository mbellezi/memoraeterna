import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "./client.js";
import { runMigrations } from "./migrations.js";
import { createHierarchicalIngestionRepository } from "./repositories/hierarchicalIngestionRepository.js";
import { createIngestionRunRepository } from "./repositories/ingestionRunRepository.js";
import { legacyContentTables } from "./repositories/legacyStateRepository.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "./sidecar/index.js";

// Migration 0052 (F2 T35a): the legacy impact triggers and their functions go, the only FK from
// kept data into legacy data goes, obsidian_sync_status gains `retired`, and inserts into the
// legacy-content tables are fenced (D40).
const workspace = resolve(import.meta.dirname, "../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const detachSql = () => readFile(join(migrationsFolder, "0052_legacy_detach.sql"), "utf8");
const legacyImpactFunctions = [
  "wiki_enroll_impact",
  "wiki_enroll_investigation_impact",
  "wiki_record_impact",
  "wiki_record_section_impact"
];

describe("migration 0052 legacy detach", () => {
  it("fences exactly the legacy-content tables", async () => {
    const fenced = [
      ...(await detachSql()).matchAll(
        /CREATE TRIGGER legacy_insert_fence BEFORE INSERT ON (\w+) FOR EACH ROW/g
      )
    ].map((match) => match[1]);
    expect(fenced.toSorted()).toEqual([...legacyContentTables].sort());
  });

  it("drops every legacy impact trigger an earlier migration created, and nothing else", async () => {
    const created = new Map<string, string>();
    for (const file of (await readdir(migrationsFolder)).filter((name) => name.endsWith(".sql"))) {
      if (file === "0052_legacy_detach.sql") continue;
      const sql = await readFile(join(migrationsFolder, file), "utf8");
      for (const match of sql.matchAll(/CREATE TRIGGER (wiki_\w*impact\w*) \w+ [^;]*? ON (\w+)/g))
        created.set(match[1]!, match[2]!);
    }
    const dropped = [...(await detachSql()).matchAll(/DROP TRIGGER (\w+) ON (\w+);/g)].map(
      (match) => [match[1]!, match[2]!] as const
    );
    expect(created.size).toBe(22);
    expect(new Map(dropped)).toEqual(created);
    expect(dropped).toHaveLength(22);
  });
});

const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("legacy detach on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-legacy-detach-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_legacy_detach",
      user: "memora_legacy_detach",
      password: `legacy-detach-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    // The baseline path: an empty database receives every migration, 0052 included, at once.
    await runMigrations(pool, migrationsFolder, {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("leaves no impact trigger or function, no legacy FK, and the retired sync status", async () => {
    const triggers = await db().query<{ name: string; table: string }>(
      `select tgname as name, tgrelid::regclass::text as table from pg_trigger
       where not tgisinternal and (tgname like 'wiki_%impact%' or tgname = 'legacy_insert_fence')`
    );
    expect(triggers.rows.filter((row) => row.name !== "legacy_insert_fence")).toEqual([]);
    expect(triggers.rows.map((row) => row.table).sort()).toEqual([...legacyContentTables].sort());
    const functions = await db().query<{ name: string }>(
      "select proname as name from pg_proc where proname = any($1::text[])",
      [legacyImpactFunctions]
    );
    expect(functions.rows).toEqual([]);
    const foreignKeys = await db().query<{ name: string }>(
      `select conname as name from pg_constraint
       where conrelid = 'atomic_note_evolution'::regclass and contype = 'f'`
    );
    expect(foreignKeys.rows.map((row) => row.name).sort()).toEqual([
      "atomic_note_evolution_next_id_atomic_notes_id_fk",
      "atomic_note_evolution_previous_id_atomic_notes_id_fk"
    ]);
    const statuses = await db().query<{ value: string }>(
      "select unnest(enum_range(null::obsidian_sync_status))::text as value"
    );
    expect(statuses.rows.map((row) => row.value)).toEqual([
      "pending",
      "synced",
      "conflict",
      "deleted",
      "ignored",
      "retired"
    ]);
  });

  it("refuses legacy content without the fixture setting and accepts it with the setting", async () => {
    for (const table of legacyContentTables)
      await expect(db().query(`insert into ${table} default values`)).rejects.toThrow(
        /^legacy\.errors\.retired$/
      );
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query("set local memora.legacy_fixture = 'on'");
      const page = randomUUID();
      const policyRevision = randomUUID();
      const job = (
        await client.query<{ id: string }>(
          "insert into jobs (type, payload) values ('maintenance', '{}'::jsonb) returning id"
        )
      ).rows[0]!.id;
      await client.query("insert into wiki_pages (id, title, kind) values ($1, 'Page', 'topic')", [
        page
      ]);
      await client.query(
        `insert into wiki_policy_revisions (id, policy_id, policy, preview, preview_hash)
         values ($1, $2, '{}'::jsonb, '{}'::jsonb, 'hash')`,
        [policyRevision, randomUUID()]
      );
      await client.query(
        `insert into wiki_investigations (id, request_id, identity, question, answer_page_id, policy_id,
           policy_revision_id, state, input, current, gaps)
         values ($1, $2, 'identity', 'Question?', $3, $4, $5, 'paused', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
        [randomUUID(), randomUUID(), page, randomUUID(), policyRevision]
      );
      await client.query(
        "insert into organization_runs (status, snapshot, checkpoint) values ('applied', '{}'::jsonb, '{}'::jsonb)"
      );
      await client.query(
        "insert into organization_settings_revisions (configuration, hash) values ('{}'::jsonb, 'hash')"
      );
      await client.query(
        "insert into maintenance_schedules (policy, next_at) values ('{}'::jsonb, now())"
      );
      await client.query(
        `insert into maintenance_runs (job_id, scope_key, period, schedule_ids, snapshot, checkpoint, reservation)
         values ($1, 'scope', 'p1', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
        [job]
      );
      const counts = await client.query<Record<string, number>>(
        `select ${legacyContentTables.map((table) => `(select count(*) from ${table})::int as ${table}`).join(", ")}`
      );
      expect(Object.values(counts.rows[0]!)).toEqual(legacyContentTables.map(() => 1));
    } finally {
      await client.query("rollback");
      client.release();
    }
    // The setting was local to that transaction: the next writer is fenced again.
    await expect(
      db().query("insert into wiki_pages (title, kind) values ('Again', 'topic')")
    ).rejects.toThrow(/^legacy\.errors\.retired$/);
  });

  it("writes no impact event when ingestion writes content", async () => {
    const source = (
      await db().query<{ id: string }>(
        "insert into source_items (type, title) values ('WebArticle', 'Impact-free source') returning id"
      )
    ).rows[0]!.id;
    const document = (
      await db().query<{ id: string }>(
        `insert into documents (source_item_id, title, canonical_markdown, content_hash)
         values ($1, 'Document', 'Text', 'hash') returning id`,
        [source]
      )
    ).rows[0]!.id;
    await db().query(
      `insert into chunks (document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, 0, 'Text', 'chunk-hash')`,
      [document, source]
    );
    await db().query("update source_items set title = 'Renamed' where id = $1", [source]);
    await db().query("delete from source_items where id = $1", [source]);
    const events = await db().query<{ count: number }>(
      "select count(*)::int as count from knowledge_impact_events"
    );
    expect(events.rows[0]!.count).toBe(0);
  });

  it("completes a batch admitted with the retired stage still pending or failed", async () => {
    const hierarchy = createHierarchicalIngestionRepository(db());
    const runs = createIngestionRunRepository(db());
    const stages = ["chunking", "sourceMatching", "organizeKnowledge"];
    const batch = await hierarchy.createBatch({
      trigger: "interactive_import",
      requestedPlan: { preset: "full_knowledge", effectiveStages: stages },
      effectivePlan: { preset: "full_knowledge", effectiveStages: stages },
      reingestionPolicy: "reuse_valid",
      targetSourceItemIds: []
    });
    for (const organizeKnowledge of [
      { status: "waiting_for_batch", metadata: {} },
      { status: "pending" },
      { status: "failed", error: "organization.errors.context" }
    ])
      await runs.create({
        batchId: batch.id,
        effectiveStages: stages,
        status: "succeeded",
        currentStage: "completed",
        stagesCheckpoint: {
          chunking: { status: "completed" },
          sourceMatching: { status: "completed" },
          organizeKnowledge
        }
      });
    const settled = await hierarchy.refreshBatch(batch.id);
    expect(settled).toMatchObject({
      status: "succeeded",
      totalItems: 3,
      completedItems: 3,
      failedItems: 0,
      progress: 1
    });

    // Another stage still fails the run, as before.
    await runs.create({
      batchId: batch.id,
      effectiveStages: stages,
      status: "succeeded",
      currentStage: "completed",
      stagesCheckpoint: {
        chunking: { status: "completed" },
        sourceMatching: { status: "failed" },
        organizeKnowledge: { status: "pending" }
      }
    });
    expect(await hierarchy.refreshBatch(batch.id)).toMatchObject({
      status: "partial",
      completedItems: 3,
      failedItems: 1
    });
  });
});
