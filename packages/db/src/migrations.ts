import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDbClient, type PgPool } from "./client.js";
import { applyBaselineSeedIfNeeded, type BaselineSeedResult } from "./seed.js";

export interface RunMigrationsOptions {
  readonly seedFolder?: string;
}

export interface RunMigrationsResult {
  readonly seed: BaselineSeedResult;
}

export async function runMigrations(
  pool: PgPool,
  migrationsFolder: string,
  options: RunMigrationsOptions = {}
): Promise<RunMigrationsResult> {
  let seed: BaselineSeedResult = { applied: false, seededMigrations: [] };
  if (options.seedFolder) {
    seed = await applyBaselineSeedIfNeeded(pool, migrationsFolder, options.seedFolder);
  }

  const db = createDbClient(pool);
  await migrate(db, { migrationsFolder });
  return { seed };
}
