import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import { OnboardingService, pgOnboardingStore } from "./onboarding-service.js";

// The first run's stored state (F4 D31) on a real PostgreSQL database: the `settings` row and the
// library's emptiness, read and written by the statements the app runs.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the first run's state on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const service = () =>
    new OnboardingService({
      store: pgOnboardingStore(() => pool ?? null),
      now: () => new Date("2026-10-24T10:00:00.000Z")
    });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-onboarding-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_onboarding",
      user: "memora_onboarding",
      password: `onboarding-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 2 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("is due on an empty library with no record, and stays due until it is recorded", async () => {
    await expect(service().state()).resolves.toEqual({
      outcome: null,
      at: null,
      libraryEmpty: true,
      show: true
    });
  });

  it("records the first run once and keeps the first record", async () => {
    await expect(service().finish("completed")).resolves.toEqual({
      outcome: "completed",
      at: "2026-10-24T10:00:00.000Z",
      libraryEmpty: true,
      show: false
    });
    await expect(service().finish("skipped")).resolves.toMatchObject({ outcome: "completed" });
    const stored = await pool!.query("select value from settings where key = 'onboarding.v1'");
    expect(stored.rows).toEqual([
      { value: { version: 1, outcome: "completed", at: "2026-10-24T10:00:00.000Z" } }
    ]);
  });

  it("is never due once the library holds a source, whatever was recorded", async () => {
    await pool!.query("delete from settings where key = 'onboarding.v1'");
    await pool!.query(
      "insert into source_items (id, type, title) values ($1, 'PersonalNote', 'A first note')",
      [randomUUID()]
    );
    await expect(service().state()).resolves.toEqual({
      outcome: null,
      at: null,
      libraryEmpty: false,
      show: false
    });
  });
});
