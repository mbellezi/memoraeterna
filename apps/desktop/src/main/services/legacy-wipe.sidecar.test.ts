import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createLegacyWipeRepository,
  createPgPool,
  createSourceItemRepository,
  createWikiRepository,
  legacyWipeTables,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type PostgresSidecarConnection
} from "@app/db";
import { WikiPageContentSchema } from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLegacyWipeBackup,
  detectLegacyRecreated,
  LegacyWipeRefusal,
  LegacyWipeService,
  type LegacyWipePhase
} from "./legacy-wipe-service.js";

/**
 * The legacy wipe against the real schema on a throwaway PostgreSQL sidecar: every migration, the
 * shipped pg_dump and pg_restore, legacy rows seeded through the repositories and raw SQL, and the
 * service's phases interrupted one by one.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const binary = (name: string) => join(sidecarPaths.binDir, name);
const sidecarAvailable = ["postgres", "pg_dump", "pg_restore"].every((name) =>
  existsSync(binary(name))
);
const quiet = { info: () => undefined, warn: () => undefined };

/** Parallel test files pick free ports the same way; a lost race needs only a fresh attempt. */
async function startSidecar(
  workDir: string
): Promise<{ manager: PostgresSidecarManager; connection: PostgresSidecarConnection }> {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_legacy_wipe_test",
      user: "memora_legacy_wipe_test",
      password: `legacy-wipe-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    try {
      return { manager, connection: await manager.start() };
    } catch (error) {
      await manager.stop().catch(() => undefined);
      if (attempt >= 3) throw error;
    }
  }
}

/** A library with notes, note history and a legacy wiki around them, as old builds left it. */
async function seedLegacyLibrary(pool: PgPool) {
  const source = await createSourceItemRepository(pool).create({
    type: "GenericDocument",
    title: "Legacy wipe source"
  });
  const text = "Notes survive the legacy wipe; the wiki around them does not.";
  const document = await createDocumentRepository(pool).create({
    sourceItemId: source.id,
    title: source.title,
    canonicalMarkdown: text,
    contentHash: text
  });
  const chunkId = randomUUID();
  const spanId = randomUUID();
  await createChunkRepository(pool).replaceDocumentChunks(document.id, source.id, [
    {
      id: chunkId,
      sourceSpanId: spanId,
      chunkIndex: 0,
      content: text,
      contentHash: text,
      span: { id: spanId, startOffset: 0, endOffset: text.length }
    }
  ]);
  const notes = [randomUUID(), randomUUID()];
  for (const [index, id] of notes.entries())
    await pool.query(
      `insert into atomic_notes(id, title, idea_statement, body_markdown, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1::uuid, $2, $2, $2, $3, $4, 'synthetic', 'fixture', 'test', 'fixture-v1', $1::text)`,
      [id, `Note ${index}`, source.id, chunkId]
    );
  await pool.query(
    `insert into atomic_note_evidence(note_id, chunk_id, source_id, snapshot)
     values ($1, $2, $3, '{"text":"kept"}')`,
    [notes[0], chunkId, source.id]
  );

  const wiki = createWikiRepository(pool);
  const pageIds: string[] = [];
  for (const title of ["Personal interpretation", "Area page"]) {
    const saved = await wiki.save({
      expectedRevisionId: null,
      content: WikiPageContentSchema.parse({
        title,
        kind: "topic",
        sections: [{ id: randomUUID(), title: "Body", markdown: `${title} text` }]
      }),
      evidenceChunkIds: [chunkId]
    });
    pageIds.push(saved);
  }
  await pool.query("update wiki_pages set management = 'ai_managed' where id = $1", [pageIds[1]]);

  const revision = await pool.query<{ id: string }>(
    `insert into organization_settings_revisions(configuration, hash) values ('{}', 'h1') returning id`
  );
  await pool.query("insert into organization_settings_activations(revision_id) values ($1)", [
    revision.rows[0]!.id
  ]);
  const organizationJob = await pool.query<{ id: string }>(
    `insert into jobs(type, status, payload) values ('organization', 'succeeded', '{}') returning id`
  );
  await pool.query(
    `insert into jobs(type, status, payload) values ('maintenance', 'queued', '{}')`
  );
  await pool.query(
    `insert into jobs(type, status, payload) values ('ingestion', 'succeeded', '{}')`
  );
  const run = await pool.query<{ id: string }>(
    `insert into organization_runs(job_id, status, snapshot, checkpoint)
     values ($1, 'applied', '{}', '{}') returning id`,
    [organizationJob.rows[0]!.id]
  );
  await pool.query(
    `insert into atomic_note_evolution(previous_id, next_id, run_id, kind, reason)
     values ($1, $2, $3, 'merge', 'kept history')`,
    [notes[0], notes[1], run.rows[0]!.id]
  );
  for (const [key, value] of [
    ["knowledge.wiki-areas.v1", true],
    ["knowledge.automation.policy.v1", { id: "policy" }],
    ["organization.active", { revisionId: revision.rows[0]!.id }],
    ["obsidian.wiki.scope", { sourceIds: [source.id], pageIds, includeDescendants: true }]
  ] as const)
    await pool.query("insert into settings(key, value) values ($1, $2::jsonb)", [
      key,
      JSON.stringify(value)
    ]);
  await pool.query(
    `insert into obsidian_sync_files(memora_id, entity_type, entity_id, memora_type, relative_path,
       frontmatter_hash, content_hash, mtime_ms, status)
     values ($1, 'wiki_page', $1, 'wiki_page', 'Memora/Wiki/area.md', 'f', 'c', 0, 'synced')`,
    [pageIds[1]]
  );
  return { pageIds, sourceId: source.id };
}

describe.skipIf(!sidecarAvailable)("legacy wipe on the PostgreSQL sidecar", () => {
  let workDir = "";
  let backupRoot = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  const repository = () => createLegacyWipeRepository(pool);
  const service = (afterPhase?: (phase: LegacyWipePhase) => Promise<void> | void) =>
    new LegacyWipeService({
      pool,
      backup: createLegacyWipeBackup({
        getDatabaseContext: () => ({ connection, pgDumpPath: binary("pg_dump") }),
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
        logger: quiet
      }),
      backupRoot,
      logger: quiet,
      ...(afterPhase ? { afterPhase } : {})
    });
  const backups = async () => (await readdir(backupRoot).catch(() => [])).sort();
  const scratchDatabases = async () =>
    (
      await pool.query<{ name: string }>(
        "select datname as name from pg_database where datname like 'memora\\_verify\\_%'"
      )
    ).rows;
  const census = async () => ({
    tables: await repository().countAllTables(),
    keys: (await repository().countKeys()).keys,
    clock: Number(
      (
        await pool.query<{ generation: string }>(
          "select generation::text from obsidian_projection_clock where id = 1"
        )
      ).rows[0]?.generation
    )
  });
  const preview = () => service().run({ mode: "preview" });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-legacy-wipe-sidecar-"));
    backupRoot = join(workDir, "backups");
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    // Test seeders may write legacy tables once migration 0052's insert fence exists (D40).
    await pool.query(`alter database "${connection.database}" set memora.legacy_fixture = 'on'`);
    await closePgPool(pool);
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("needs no backup and writes nothing on a database without legacy content", async () => {
    const before = await census();
    for (const request of [
      { mode: "preview" } as const,
      { mode: "wipe", token: "0123456789ab" } as const
    ]) {
      const report = await service().run(request);
      expect(report.outcome).toBe("nothing");
      expect(report.backupPath).toBeNull();
    }
    expect(await census()).toEqual(before);
    expect(await backups()).toEqual([]);
  }, 60_000);

  it("refuses to wipe while a foreign key from another table points into a legacy table", async () => {
    await seedLegacyLibrary(pool);
    await pool.query(
      "create table public.legacy_wipe_probe (page_id uuid references public.wiki_pages(id))"
    );
    try {
      const { token } = await preview();
      const refusal = await service()
        .run({ mode: "wipe", token })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(LegacyWipeRefusal);
      expect((refusal as LegacyWipeRefusal).reason).toBe("foreignKey");
      expect((refusal as LegacyWipeRefusal).detail).toContain("legacy_wipe_probe");
    } finally {
      await pool.query("drop table public.legacy_wipe_probe");
    }
    // Migration 0052 (T35a) drops the only real one; this keeps the test valid before it lands.
    await pool.query(
      `alter table atomic_note_evolution
         drop constraint if exists atomic_note_evolution_run_id_organization_runs_id_fk`
    );
    expect(await repository().foreignKeysIntoLegacy()).toEqual([]);
  }, 90_000);

  it("previews with a verified backup and changes nothing", async () => {
    const before = await census();
    const report = await preview();
    expect(report.outcome).toBe("previewed");
    expect(report.counts.wiki_pages).toBe(2);
    expect(report.counts.organization_runs).toBe(1);
    expect(report.counts.knowledge_impact_events).toBeGreaterThanOrEqual(0);
    expect(report.keyCounts).toMatchObject({
      settings: {
        "knowledge.automation.policy.v1": 1,
        "knowledge.wiki-areas.v1": 1,
        "organization.active": 1
      },
      scopePageIds: 2,
      jobs: { "maintenance:queued": 1, "organization:succeeded": 1 },
      pagesByManagement: { ai_managed: 1, human_managed: 1 },
      vaultFiles: { "wiki_page:synced": 1 }
    });
    expect(report.library.source_items).toBe(1);
    expect(report.library.atomic_notes).toBe(2);
    expect(report.backupPath).not.toBeNull();
    expect(report.verifiedAt).not.toBeNull();
    expect(await census()).toEqual(before);
    expect(await scratchDatabases()).toEqual([]);
  }, 90_000);

  it("refuses a stale token and changes nothing", async () => {
    const before = await census();
    const refusal = await service()
      .run({ mode: "wipe", token: "0123456789ab" })
      .catch((error: unknown) => error);
    expect((refusal as LegacyWipeRefusal).reason).toBe("tokenMismatch");
    expect(await census()).toEqual(before);
  }, 60_000);

  it("leaves the data intact when the run dies after counted, backed_up or verified", async () => {
    const { token } = await preview();
    const before = await census();
    for (const killAfter of ["counted", "backed_up", "verified"] as const) {
      const backupsBefore = await backups();
      const error = await service((phase) => {
        if (phase === killAfter) throw new Error(`killed after ${phase}`);
      })
        .run({ mode: "wipe", token })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(`killed after ${killAfter}`);
      expect(await census()).toEqual(before);
      expect((await backups()).length).toBe(
        backupsBefore.length + (killAfter === "counted" ? 0 : 1)
      );
      expect(await scratchDatabases()).toEqual([]);
    }
  }, 180_000);

  it("aborts on the recount when a legacy row arrives between the dump and the wipe", async () => {
    const { token } = await preview();
    const before = await census();
    const late = createPgPool({ connectionString: connection.connectionString, max: 1 });
    try {
      const refusal = await service(async (phase) => {
        if (phase === "verified")
          await late.query(
            `insert into organization_settings_revisions(configuration, hash) values ('{}', 'late')`
          );
      })
        .run({ mode: "wipe", token })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(LegacyWipeRefusal);
      expect((refusal as LegacyWipeRefusal).reason).toBe("countsChanged");
      expect((refusal as LegacyWipeRefusal).detail).toContain(
        "organization_settings_revisions: expected 1, found 2"
      );
    } finally {
      await closePgPool(late);
    }
    const after = await census();
    expect(after.tables).toEqual({
      ...before.tables,
      organization_settings_revisions: before.tables.organization_settings_revisions! + 1
    });
    expect(after.keys).toEqual(before.keys);
  }, 90_000);

  it("wipes the legacy tables, settings and jobs in one transaction and keeps everything else", async () => {
    const before = await census();
    const { token } = await preview();
    const report = await service().run({ mode: "wipe", token });
    expect(report.outcome).toBe("wiped");
    expect(report.timings.wipeMs).not.toBeNull();
    const after = await census();
    for (const table of legacyWipeTables) expect(after.tables[table]).toBe(0);
    for (const [table, rows] of Object.entries(before.tables)) {
      if ((legacyWipeTables as readonly string[]).includes(table)) continue;
      if (table === "settings") expect(after.tables.settings).toBe(rows - 3 + 1);
      else if (table === "jobs") expect(after.tables.jobs).toBe(rows - 2);
      else expect([table, after.tables[table]]).toEqual([table, rows]);
    }
    expect(after.tables.atomic_note_evidence).toBe(1);
    expect(after.tables.atomic_note_evolution).toBe(1);
    expect(after.keys).toEqual({
      settings: {
        "knowledge.automation.policy.v1": 0,
        "knowledge.wiki-areas.v1": 0,
        "organization.active": 0
      },
      scopePageIds: 0,
      jobs: {},
      pagesByManagement: {},
      // The registry is the projection's to retire (T34a); the wipe leaves it.
      vaultFiles: { "wiki_page:synced": 1 }
    });
    expect(after.clock).toBe(before.clock + 1);
    const scope = await pool.query<{ value: { sourceIds: string[]; pageIds: string[] } }>(
      "select value from settings where key = 'obsidian.wiki.scope'"
    );
    expect(scope.rows[0]!.value.pageIds).toEqual([]);
    expect(scope.rows[0]!.value.sourceIds).toHaveLength(1);
    const record = await repository().readRecord();
    expect(record?.runs).toHaveLength(1);
    expect(record?.runs[0]).toMatchObject({
      reason: "wiped",
      token,
      backupPath: report.backupPath,
      verifiedAt: report.verifiedAt
    });
    expect(record?.runs[0]?.counts.tables.wiki_pages).toBe(2);
  }, 90_000);

  it("is a no-op the second time, and reports legacy content created after it", async () => {
    const before = await census();
    const backupsBefore = await backups();
    const report = await service().run({ mode: "wipe", token: "0123456789ab" });
    expect(report.outcome).toBe("nothing");
    expect(await census()).toEqual(before);
    expect(await backups()).toEqual(backupsBefore);

    const warnings: string[] = [];
    expect(await detectLegacyRecreated(pool, { warn: (line) => warnings.push(line) })).toBeNull();
    await pool.query(
      `insert into organization_settings_revisions(configuration, hash) values ('{}', 'again')`
    );
    const counts = await detectLegacyRecreated(pool, { warn: (line) => warnings.push(line) });
    expect(counts?.organization_settings_revisions).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^LEGACY_RECREATED /);
  }, 60_000);
});
