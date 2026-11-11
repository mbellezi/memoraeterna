import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolvePostgresSidecarPaths, runMigrations } from "@app/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseService, type DatabaseServiceOptions } from "./database-service.js";

// Only `safeStorage` is faked: the credentials it seals are for a throwaway cluster.
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/u, "")
  }
}));

// The real migrations, run for real; the wrapper only lets the test see whether they were asked for.
vi.mock("@app/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/db")>();
  return { ...actual, runMigrations: vi.fn(actual.runMigrations) };
});

/**
 * F5 D25 (T111) on a real PostgreSQL cluster: an unpackaged build whose userData is the default one
 * must not apply a pending migration unless the knob is exactly 1. The pending migration is a probe
 * appended to a copy of the real journal, so the test never depends on which migration is last.
 */
const workspaceRoot = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const realMigrations = join(workspaceRoot, "packages/db/drizzle");
const guardKey = "database.errors.defaultProfileUpgradeRefused";

describe.skipIf(!sidecarInstalled)("the startup guard on a PostgreSQL cluster", () => {
  let workDir = "";
  let profile = "";
  let otherDefault = "";
  let journalLastWhen = 0;
  let journalLength = 0;
  const running: DatabaseService[] = [];
  let folderCount = 0;

  /** The real journal and SQL files, plus `count` probe migrations that each create one table. */
  async function migrationsWithProbes(
    count: number
  ): Promise<{ folder: string; lastWhen: number }> {
    folderCount += 1;
    const folder = join(workDir, `migrations-${folderCount}`);
    await mkdir(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(
      await readFile(join(realMigrations, "meta/_journal.json"), "utf8")
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    for (const entry of journal.entries) {
      await symlink(join(realMigrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    for (let probe = 1; probe <= count; probe += 1) {
      const idx = journal.entries.length;
      const tag = `${String(idx).padStart(4, "0")}_guard_probe_${probe}`;
      journal.entries.push({
        idx,
        version: "7",
        when: journalLastWhen + probe * 1_000,
        tag,
        breakpoints: true
      });
      await writeFile(
        join(folder, `${tag}.sql`),
        `create table guard_probe_${probe} (id integer primary key);\n`
      );
    }
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    return { folder, lastWhen: journalLastWhen + count * 1_000 };
  }

  /** Starts a service on the profile; a lost race for a port is not the guard, so it starts afresh. */
  async function start(input: {
    defaultUserDataPath: string;
    migrations?: string;
    knob?: string;
  }): Promise<DatabaseService> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.MEMORA_DATABASE_PORT;
    delete env.MEMORA_DB_SEED_DIR;
    delete env.MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE;
    delete env.MEMORA_DB_MIGRATIONS_DIR;
    if (input.migrations) env.MEMORA_DB_MIGRATIONS_DIR = input.migrations;
    if (input.knob !== undefined) env.MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE = input.knob;

    for (let attempt = 1; ; attempt += 1) {
      const options: DatabaseServiceOptions = {
        userDataPath: profile,
        defaultUserDataPath: input.defaultUserDataPath,
        cwd: workspaceRoot,
        resourcesPath: workspaceRoot,
        isPackaged: false,
        env
      };
      const service = new DatabaseService(options);
      running.push(service);
      const status = await service.start();
      if (status.state !== "failed" || status.messageKey === guardKey || attempt >= 3)
        return service;
      await service.stop();
    }
  }

  async function scalar(service: DatabaseService, sql: string): Promise<string | null> {
    const pool = service.getPool();
    if (!pool) throw new Error("The database is not ready.");
    const { rows } = await pool.query<{ value: string | null }>(sql);
    return rows[0]?.value ?? null;
  }

  const lastApplied = (service: DatabaseService) =>
    scalar(service, "select max(created_at)::text as value from drizzle.__drizzle_migrations");
  const probeTable = (service: DatabaseService, probe: number) =>
    scalar(service, `select to_regclass('public.guard_probe_${probe}')::text as value`);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-guard-"));
    profile = join(workDir, "profile");
    otherDefault = join(workDir, "the-default-profile");
    const journal = JSON.parse(
      await readFile(join(realMigrations, "meta/_journal.json"), "utf8")
    ) as {
      entries: Array<{ when: number }>;
    };
    journalLength = journal.entries.length;
    journalLastWhen = Math.max(...journal.entries.map((entry) => entry.when));
  });

  beforeEach(() => {
    vi.mocked(runMigrations).mockClear();
  });

  afterAll(async () => {
    for (const service of running) await service.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  });

  it("starts a fresh default profile and brings it to the journal's head", async () => {
    const service = await start({ defaultUserDataPath: profile });

    expect(service.getStatus().state).toBe("ready");
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(
      await scalar(service, "select count(*)::text as value from drizzle.__drizzle_migrations")
    ).toBe(String(journalLength));
    expect(await lastApplied(service)).toBe(String(journalLastWhen));
    await service.stop();
  }, 180_000);

  it("refuses, as the default profile without the knob, a history that lacks the journal's last migration", async () => {
    const { folder } = await migrationsWithProbes(1);

    const service = await start({ defaultUserDataPath: profile, migrations: folder });

    expect(service.getStatus().state).toBe("failed");
    expect(service.getStatus().messageKey).toBe(guardKey);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(service.getPool()).toBeNull();
    await service.stop();
  }, 180_000);

  it("leaves the refused profile as it was: its own journal still starts it, with no probe table", async () => {
    const service = await start({ defaultUserDataPath: profile });

    expect(service.getStatus().state).toBe("ready");
    expect(await lastApplied(service)).toBe(String(journalLastWhen));
    expect(await probeTable(service, 1)).toBeNull();
    await service.stop();
  }, 180_000);

  it("refuses when the knob is set to anything but exactly 1", async () => {
    const { folder } = await migrationsWithProbes(1);

    const service = await start({ defaultUserDataPath: profile, migrations: folder, knob: "true" });

    expect(service.getStatus().messageKey).toBe(guardKey);
    expect(runMigrations).not.toHaveBeenCalled();
    await service.stop();
  }, 180_000);

  it("migrates the default profile when the knob is 1", async () => {
    const { folder, lastWhen } = await migrationsWithProbes(1);

    const service = await start({ defaultUserDataPath: profile, migrations: folder, knob: "1" });

    expect(service.getStatus().state).toBe("ready");
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(await probeTable(service, 1)).toBe("guard_probe_1");
    expect(await lastApplied(service)).toBe(String(lastWhen));
    await service.stop();
  }, 180_000);

  it("migrates, without the knob, when the profile is not the default one", async () => {
    const { folder, lastWhen } = await migrationsWithProbes(2);

    const service = await start({ defaultUserDataPath: otherDefault, migrations: folder });

    expect(service.getStatus().state).toBe("ready");
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(await probeTable(service, 2)).toBe("guard_probe_2");
    expect(await lastApplied(service)).toBe(String(lastWhen));
    await service.stop();
  }, 180_000);
});
