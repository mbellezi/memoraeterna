import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  type PgPool,
  type PostgresSidecarConnection
} from "@app/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BackupService } from "./backup-service.js";
import { BackupVerificationError, BackupVerifier, backupKeyTables } from "./backup-verifier.js";

/**
 * Backup verification against the real PostgreSQL sidecar binaries: a throwaway cluster, the
 * shipped pg_dump and pg_restore, and the key tables of the real schema reduced to plain tables.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const binary = (name: string) => join(sidecarPaths.binDir, name);
const sidecarAvailable = ["postgres", "pg_dump", "pg_restore"].every((name) =>
  existsSync(binary(name))
);

/** Parallel test files pick free ports the same way; a lost race needs only a fresh attempt. */
async function startSidecar(
  workDir: string
): Promise<{ manager: PostgresSidecarManager; connection: PostgresSidecarConnection }> {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_backup_test",
      user: "memora_backup_test",
      password: `backup-${randomUUID()}`,
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

describe.skipIf(!sidecarAvailable)("backup verification on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let backups: BackupService;
  let verifier: BackupVerifier;
  let destination = "";

  async function scalar(sql: string): Promise<string> {
    const { rows } = await pool.query<{ value: string }>(sql);
    return String(rows[0]?.value);
  }
  const scratchDatabases = async () =>
    (
      await pool.query<{ name: string }>(
        "select datname as name from pg_database where datname like 'memora\\_verify\\_%'"
      )
    ).rows.map((row) => row.name);
  const quiet = { warn: () => undefined };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-backup-sidecar-"));
    destination = join(workDir, "backups");
    await mkdir(destination);
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 2 });
    for (const [index, table] of backupKeyTables.entries()) {
      await pool.query(`create table public."${table}" (id int primary key)`);
      // Distinct counts per table, and the three embedding tables stay empty.
      const rows = table.startsWith("embeddings_") ? 0 : 3 + index * 7;
      await pool.query(`insert into public."${table}" select generate_series(1, ${rows})`);
    }
    const context = () => ({
      connection,
      pgDumpPath: binary("pg_dump")
    });
    backups = new BackupService({
      getDatabaseContext: context,
      getStorageSettings: async () => ({
        obsidianVaultPath: null,
        managedRoot: "Memora",
        obsidianSyncEnabled: false,
        obsidianSyncPaused: false,
        uploadCopiesEnabled: false,
        uploadCopiesFolderPath: null,
        updatedAt: new Date().toISOString()
      }),
      logger: quiet
    });
    verifier = new BackupVerifier({ getDatabaseContext: context, logger: quiet });
  }, 90_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("creates a backup that is restored, matched and cleaned up", async () => {
    const result = await backups.create(destination);
    expect(result.verified).toBe(true);
    expect(result.included).toEqual(["database"]);
    const manifest = JSON.parse(await readFile(join(result.path, "manifest.json"), "utf8")) as {
      version: number;
      verifiedAt: string | null;
      counts: Record<string, number>;
    };
    expect(manifest.version).toBe(2);
    expect(Date.parse(manifest.verifiedAt ?? "")).not.toBeNaN();
    expect(Object.keys(manifest.counts).sort()).toEqual([...backupKeyTables].sort());
    expect(manifest.counts.source_items).toBe(3);
    expect(manifest.counts.embeddings_768).toBe(0);
    expect(await scratchDatabases()).toEqual([]);
    expect((await stat(join(result.path, "database.dump"))).size).toBeGreaterThan(0);
  }, 60_000);

  it("takes the counts and the dump from one snapshot, so concurrent writes cannot cause a mismatch", async () => {
    const snapshot = await backups.openSnapshot();
    try {
      await pool.query("insert into public.chunks select generate_series(1000, 1004)");
      const live = Number(await scalar("select count(*)::text as value from public.chunks"));
      expect(snapshot.counts.chunks).toBe(live - 5);
      const result = await backups.create(destination, { snapshot });
      expect(result.verified).toBe(true);
      const manifest = JSON.parse(await readFile(join(result.path, "manifest.json"), "utf8")) as {
        counts: Record<string, number>;
      };
      expect(manifest.counts.chunks).toBe(live - 5);
      // Counting the live table instead of the snapshot would have refused this very dump.
      const error = await verifier
        .verify(join(result.path, "database.dump"), { chunks: live })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BackupVerificationError);
      expect((error as BackupVerificationError).failure).toBe("countMismatch");
    } finally {
      await snapshot.release();
      await pool.query("delete from public.chunks where id >= 1000");
    }
  }, 90_000);

  it("refuses a dump with its last byte cut and leaves no scratch database", async () => {
    const whole = await backups.create(destination, { verify: false });
    expect(whole.verified).toBe(false);
    const dump = join(whole.path, "database.dump");
    const size = (await stat(dump)).size;
    const cut = join(workDir, "cut.dump");
    const source = await open(dump, "r");
    try {
      const bytes = Buffer.alloc(size - 1);
      await source.read(bytes, 0, size - 1, 0);
      await writeFile(cut, bytes);
    } finally {
      await source.close();
    }
    const counts = Object.fromEntries(
      await Promise.all(
        backupKeyTables.map(
          async (table) =>
            [
              table,
              Number(await scalar(`select count(*)::text as value from public."${table}"`))
            ] as const
        )
      )
    );
    await expect(verifier.verify(dump, counts)).resolves.toBeDefined();

    const error = await verifier.verify(cut, counts).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupVerificationError);
    expect((error as BackupVerificationError).failure).toBe("restoreFailed");
    expect((error as BackupVerificationError).message).toBe("errors.backup.verificationFailed");
    expect((error as BackupVerificationError).detail).toMatch(/end of file/);
    expect(await scratchDatabases()).toEqual([]);
  }, 90_000);

  it("refuses a file that is not a PostgreSQL archive", async () => {
    const notADump = join(workDir, "not-a-dump.dump");
    await writeFile(notADump, "this is not a pg_dump archive");
    const error = await verifier
      .verify(notADump, { source_items: 3 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupVerificationError);
    expect((error as BackupVerificationError).failure).toBe("dumpUnreadable");
    expect(await scratchDatabases()).toEqual([]);
  });

  it("refuses counts that differ from the restored tables and names them", async () => {
    const result = await backups.create(destination, { verify: false });
    const error = await verifier
      .verify(join(result.path, "database.dump"), { source_items: 3, documents: 1_000_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupVerificationError);
    expect((error as BackupVerificationError).failure).toBe("countMismatch");
    expect((error as BackupVerificationError).detail).toContain("documents: snapshot 1000000");
    expect(await scratchDatabases()).toEqual([]);
  }, 60_000);

  it("drops a scratch database a killed verification left behind", async () => {
    await pool.query('create database "memora_verify_20200101000000000" template template0');
    expect(await scratchDatabases()).toEqual(["memora_verify_20200101000000000"]);
    const result = await backups.create(destination);
    expect(result.verified).toBe(true);
    expect(await scratchDatabases()).toEqual([]);
  }, 60_000);

  it("keeps and marks a backup whose snapshot counts do not match its dump", async () => {
    const snapshot = await backups.openSnapshot();
    try {
      const wrong = {
        snapshotId: snapshot.snapshotId,
        counts: { ...snapshot.counts, documents: 999 }
      };
      const error = await backups.create(destination, { snapshot: wrong }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackupVerificationError);
      const failure = error as BackupVerificationError;
      expect(failure.failure).toBe("countMismatch");
      const manifest = JSON.parse(
        await readFile(join(failure.backupPath!, "manifest.json"), "utf8")
      ) as { verifiedAt: string | null; verificationFailure: string };
      expect(manifest.verifiedAt).toBeNull();
      expect(manifest.verificationFailure).toBe("countMismatch");
      expect((await stat(join(failure.backupPath!, "database.dump"))).isFile()).toBe(true);
    } finally {
      await snapshot.release();
    }
    expect(await scratchDatabases()).toEqual([]);
  }, 60_000);
});
