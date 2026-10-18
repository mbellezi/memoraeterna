import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  createSettingsRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  MatchingConfigurationSchema,
  migrateMatchingSettingsV2,
  recommendedMatchingConfiguration
} from "@app/domain";

import { SettingsService } from "./settings-service.js";

// The matching settings v2 migration (T53b) against the real `settings` table: the document the
// ENV-F, ENV-G, ENV-C and DEV profiles hold is rewritten once, without the dead fields, and nothing
// else in it changes.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const profileDocument = (
  JSON.parse(
    readFileSync(
      join(workspace, "packages/domain/src/fixtures/app-settings-matching-before-v2.json"),
      "utf8"
    )
  ) as { document: Record<string, unknown> }
).document;

interface StoredSettings {
  atomicNoteRelationThreshold?: number;
  atomicNoteMatchingSettings: Record<string, unknown>;
  sourceRelationSettings: Record<string, unknown>;
  activeMatchingPresetId?: string;
  themeMode?: string;
  updatedAt: string;
}

describe.skipIf(!sidecarInstalled)("matching settings v2 migration on a real PostgreSQL", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-settings-migration-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_settings_migration_test",
        user: "memora_settings_migration_test",
        password: `settings-migration-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const service = () => new SettingsService(workDir, { getDatabasePool: () => pool });
  const row = async () =>
    (
      await pool.query<{ value: StoredSettings; updatedAt: Date }>(
        `select value, updated_at as "updatedAt" from settings where key = 'app.preferences'`
      )
    ).rows[0]!;

  it("rewrites the stored document once, drops only the dead fields and keeps the recommendation", async () => {
    await createSettingsRepository(pool).set("app.preferences", profileDocument);
    const before = await row();
    const app = await service().getApp();
    expect(app.activeMatchingPresetId).toBe("recommended-v2");
    expect(MatchingConfigurationSchema.parse(app)).toEqual(recommendedMatchingConfiguration);
    const after = await row();
    expect(after.value).toEqual(migrateMatchingSettingsV2(profileDocument));
    expect(after.value.atomicNoteRelationThreshold).toBeUndefined();
    expect(Object.keys(after.value.atomicNoteMatchingSettings)).toEqual(["maxRerankOutputTokens"]);
    expect(after.value.sourceRelationSettings).not.toHaveProperty("maxPairs");
    expect(after.value.sourceRelationSettings.includeWeakTypes).toBe(false);
    expect(after.value.updatedAt).toBe(profileDocument.updatedAt);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // A later start finds nothing to drop and does not touch the row.
    await service().getApp();
    expect((await row()).updatedAt.getTime()).toBe(after.updatedAt.getTime());
  });

  it("keeps what the person saved afterwards, with no dead field written back", async () => {
    await createSettingsRepository(pool).set("app.preferences", profileDocument);
    const settings = service();
    await settings.updateApp({ themeMode: "dark" });
    const saved = (await row()).value;
    expect(saved).toMatchObject({ themeMode: "dark", activeMatchingPresetId: "recommended-v2" });
    expect(saved.atomicNoteRelationThreshold).toBeUndefined();
    expect(Object.keys(saved.atomicNoteMatchingSettings)).toEqual(["maxRerankOutputTokens"]);
    expect(saved.sourceRelationSettings).not.toHaveProperty("reciprocalRankConstant");
  });
});
