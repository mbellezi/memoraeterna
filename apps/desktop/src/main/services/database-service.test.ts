import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { databaseStatusSchema } from "../../shared/ipc";
import { DatabaseService } from "./database-service.js";

const fakes = vi.hoisted(() => ({
  queries: [] as string[],
  history: { table: true, max: "1000" as string | null },
  runMigrations: vi.fn(async () => ({ seed: { applied: false, seededMigrations: [] } })),
  closePgPool: vi.fn(async () => undefined),
  managerStop: vi.fn(async () => undefined)
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/u, "")
  }
}));

vi.mock("@app/db", () => ({
  closePgPool: fakes.closePgPool,
  createPgPool: () => ({
    query: async (text: string) => {
      fakes.queries.push(text);
      if (text.includes("to_regclass")) return { rows: [{ present: fakes.history.table }] };
      if (text.includes("max(created_at)")) return { rows: [{ maxCreatedAt: fakes.history.max }] };
      return { rows: [] };
    }
  }),
  PostgresSidecarManager: class {
    public async start() {
      return {
        host: "127.0.0.1",
        port: 5999,
        database: "memora_app",
        user: "memora_app",
        password: "unit-test-password",
        connectionString: "postgresql://memora_app:unit-test-password@127.0.0.1:5999/memora_app"
      };
    }
    public stop = fakes.managerStop;
  },
  resolvePostgresSidecarPaths: () => ({ binDir: "/fake/sidecar/bin" }),
  runMigrations: fakes.runMigrations
}));

/** The newest `when` in the journal below: what the history is compared with. */
const journalLastWhen = 2_000;
const guardKey = "database.errors.defaultProfileUpgradeRefused";

describe("DatabaseService default-profile guard", () => {
  let root = "";
  let migrationsFolder = "";
  let defaultPath = "";
  let profileCount = 0;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "memora-database-service-")));
    migrationsFolder = join(root, "migrations");
    await mkdir(join(migrationsFolder, "meta"), { recursive: true });
    await writeFile(
      join(migrationsFolder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 1_000, tag: "0000_first", breakpoints: true },
          { idx: 1, version: "7", when: journalLastWhen, tag: "0001_second", breakpoints: true }
        ]
      })
    );
    defaultPath = join(root, "default-profile");
    await mkdir(defaultPath);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fakes.queries.length = 0;
    fakes.history.table = true;
    fakes.history.max = "1000";
    fakes.runMigrations.mockClear();
    fakes.closePgPool.mockClear();
    fakes.managerStop.mockClear();
  });

  /** A service whose userData is a new folder, or the given one, over the fake database. */
  function createService(
    overrides: {
      userDataPath?: string;
      isPackaged?: boolean;
      env?: NodeJS.ProcessEnv;
      migrations?: string;
    } = {}
  ) {
    profileCount += 1;
    const userDataPath = overrides.userDataPath ?? join(root, `profile-${profileCount}`);
    return {
      userDataPath,
      service: new DatabaseService({
        userDataPath,
        defaultUserDataPath: defaultPath,
        cwd: root,
        resourcesPath: root,
        isPackaged: overrides.isPackaged ?? false,
        env: {
          MEMORA_WORKSPACE_ROOT: root,
          MEMORA_DB_MIGRATIONS_DIR: overrides.migrations ?? migrationsFolder,
          MEMORA_DB_SEED_DIR: join(root, "seed"),
          ...overrides.env
        }
      })
    };
  }

  it("refuses pending migrations on the default profile before running any, and stops cleanly", async () => {
    const { service, userDataPath } = createService({ userDataPath: defaultPath });

    const status = await service.start();

    expect(status.state).toBe("failed");
    expect(status.messageKey).toBe(guardKey);
    expect(status.error).toContain("MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE");
    expect(status.error).not.toContain(userDataPath);
    expect(databaseStatusSchema.parse(status)).toEqual(status);
    expect(fakes.runMigrations).not.toHaveBeenCalled();
    expect(fakes.closePgPool).toHaveBeenCalledTimes(1);
    expect(fakes.managerStop).toHaveBeenCalledTimes(1);
    expect(service.getPool()).toBeNull();
    expect(service.getConnection()).toBeNull();
    expect(existsSync(join(userDataPath, "database", "dev-connection.json"))).toBe(false);
  });

  it("refuses again each time it is started again", async () => {
    const { service } = createService({ userDataPath: defaultPath });

    expect((await service.start()).messageKey).toBe(guardKey);
    expect((await service.start()).messageKey).toBe(guardKey);
    expect(fakes.runMigrations).not.toHaveBeenCalled();
  });

  it("refuses through a symlink that leads to the default profile", async () => {
    const link = join(root, "link-to-default");
    await symlink(defaultPath, link);
    const { service } = createService({ userDataPath: link });

    const status = await service.start();

    expect(status.messageKey).toBe(guardKey);
    expect(fakes.runMigrations).not.toHaveBeenCalled();
  });

  it("migrates the default profile when the knob is exactly 1", async () => {
    const { service } = createService({
      userDataPath: defaultPath,
      env: { MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE: "1" }
    });

    const status = await service.start();

    expect(status.state).toBe("ready");
    expect(status.messageKey).toBe("database.status.ready");
    expect(fakes.runMigrations).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it.each(["true", " 1", "1 ", "0", ""])("does not take %j for the knob", async (knob) => {
    const { service } = createService({
      userDataPath: defaultPath,
      env: { MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE: knob }
    });

    expect((await service.start()).messageKey).toBe(guardKey);
    expect(fakes.runMigrations).not.toHaveBeenCalled();
  });

  it("migrates a profile that is not the default one without reading the history", async () => {
    const { service } = createService();

    const status = await service.start();

    expect(status.state).toBe("ready");
    expect(fakes.runMigrations).toHaveBeenCalledTimes(1);
    expect(fakes.queries).toEqual([]);
    await service.stop();
  });

  it("migrates a packaged build on the default profile without reading the history", async () => {
    const { service } = createService({ userDataPath: defaultPath, isPackaged: true });

    const status = await service.start();

    expect(status.state).toBe("ready");
    expect(fakes.runMigrations).toHaveBeenCalledTimes(1);
    expect(fakes.queries).toEqual([]);
    await service.stop();
  });

  it("starts a fresh default profile: no migration table, or a table with no rows", async () => {
    fakes.history.table = false;
    const withoutTable = createService({ userDataPath: defaultPath });
    expect((await withoutTable.service.start()).state).toBe("ready");
    expect(fakes.queries.filter((text) => text.includes("max(created_at)"))).toEqual([]);
    await withoutTable.service.stop();

    fakes.history.table = true;
    fakes.history.max = null;
    const withoutRows = createService({ userDataPath: defaultPath });
    expect((await withoutRows.service.start()).state).toBe("ready");
    expect(fakes.runMigrations).toHaveBeenCalledTimes(2);
    await withoutRows.service.stop();
  });

  it.each([String(journalLastWhen), String(journalLastWhen + 1)])(
    "starts the default profile when its history (%s) holds the journal's last migration or a later one",
    async (max) => {
      fakes.history.max = max;
      const { service } = createService({ userDataPath: defaultPath });

      expect((await service.start()).state).toBe("ready");
      expect(fakes.runMigrations).toHaveBeenCalledTimes(1);
      await service.stop();
    }
  );

  it("refuses when the history's newest migration is one tick older than the journal's", async () => {
    fakes.history.max = String(journalLastWhen - 1);
    const { service } = createService({ userDataPath: defaultPath });

    expect((await service.start()).messageKey).toBe(guardKey);
    expect(fakes.runMigrations).not.toHaveBeenCalled();
  });

  it("fails closed, with the generic key, when the journal cannot be read", async () => {
    const empty = join(root, "no-journal");
    await mkdir(empty);
    const { service } = createService({ userDataPath: defaultPath, migrations: empty });

    const status = await service.start();

    expect(status.state).toBe("failed");
    expect(status.messageKey).toBe("database.status.failed");
    expect(fakes.runMigrations).not.toHaveBeenCalled();
  });

  it("fails closed when the history holds a timestamp it cannot read", async () => {
    fakes.history.max = "not-a-number";
    const { service } = createService({ userDataPath: defaultPath });

    const status = await service.start();

    expect(status.state).toBe("failed");
    expect(status.messageKey).toBe("database.status.failed");
    expect(fakes.runMigrations).not.toHaveBeenCalled();
  });
});
