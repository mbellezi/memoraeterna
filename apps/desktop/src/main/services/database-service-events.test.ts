import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppEventSchema, type AppEvent } from "../../shared/app-events.js";
import { appEventPort } from "./app-events.js";
import { DatabaseService } from "./database-service.js";

const fakes = vi.hoisted(() => ({
  runMigrations: vi.fn(async () => ({ seed: { applied: false, seededMigrations: [] } })),
  startFails: false
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/u, "")
  }
}));

vi.mock("@app/db", () => ({
  closePgPool: vi.fn(async () => undefined),
  createPgPool: () => ({
    query: async (text: string) => {
      if (text.includes("to_regclass")) return { rows: [{ present: true }] };
      if (text.includes("max(created_at)")) return { rows: [{ maxCreatedAt: "1000" }] };
      return { rows: [] };
    }
  }),
  PostgresSidecarManager: class {
    public async start() {
      if (fakes.startFails) throw new Error("sidecar did not start");
      return {
        host: "127.0.0.1",
        port: 5999,
        database: "memora_app",
        user: "memora_app",
        password: "unit-test-password",
        connectionString: "postgresql://memora_app:unit-test-password@127.0.0.1:5999/memora_app"
      };
    }
    public stop = vi.fn(async () => undefined);
  },
  resolvePostgresSidecarPaths: () => ({ binDir: "/fake/sidecar/bin" }),
  runMigrations: fakes.runMigrations
}));

describe("DatabaseService publishes its lifecycle on the bus (T115)", () => {
  let root = "";
  let count = 0;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "memora-database-events-")));
    await mkdir(join(root, "migrations", "meta"), { recursive: true });
    await writeFile(
      join(root, "migrations", "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1_000, tag: "0000_first", breakpoints: true }]
      })
    );
    await mkdir(join(root, "default-profile"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    appEventPort.detach();
    fakes.startFails = false;
  });

  function createService() {
    count += 1;
    return new DatabaseService({
      userDataPath: join(root, `profile-${count}`),
      defaultUserDataPath: join(root, "default-profile"),
      cwd: root,
      resourcesPath: root,
      isPackaged: false,
      env: {
        MEMORA_WORKSPACE_ROOT: root,
        MEMORA_DB_MIGRATIONS_DIR: join(root, "migrations"),
        MEMORA_DB_SEED_DIR: join(root, "seed")
      }
    });
  }

  function listen(): AppEvent[] {
    const events: AppEvent[] = [];
    appEventPort.attach({ publish: (event) => events.push(event) });
    return events;
  }

  const states = (events: AppEvent[]) =>
    events.flatMap((event) => (event.type === "database.status" ? [event.state] : []));

  it("publishes each state of a start and of a stop, in order, as valid events", async () => {
    const events = listen();
    const service = createService();

    await service.start();
    await service.stop();

    expect(states(events)).toEqual(["starting", "migrating", "ready", "stopping", "stopped"]);
    for (const event of events) expect(AppEventSchema.safeParse(event).success).toBe(true);
    const ready = events.find(
      (event) => event.type === "database.status" && event.state === "ready"
    );
    expect(ready).toMatchObject({ messageKey: "database.status.ready" });
  });

  it("publishes a failed start with its message key", async () => {
    const events = listen();
    fakes.startFails = true;

    const status = await createService().start();

    expect(status.state).toBe("failed");
    expect(states(events)).toEqual(["starting", "failed"]);
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: "database.status", messageKey: "database.status.failed" });
    expect(AppEventSchema.safeParse(failed).success).toBe(true);
  });

  it("keeps the last state for a bus that attaches after the start (sticky)", async () => {
    const service = createService();
    await service.start();

    const events = listen();

    expect(states(events)).toEqual(["ready"]);
    await service.stop();
  });
});
