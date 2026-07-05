import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDbClient, type PgPool } from "./client.js";
import { applyBaselineSeedIfNeeded } from "./seed.js";

export interface RunMigrationsOptions {
  readonly seedFolder?: string;
}

export async function runMigrations(
  pool: PgPool,
  migrationsFolder: string,
  options: RunMigrationsOptions = {}
): Promise<void> {
  if (options.seedFolder) {
    await applyBaselineSeedIfNeeded(pool, migrationsFolder, options.seedFolder);
  }

  const db = createDbClient(pool);
  await migrate(db, { migrationsFolder });
}
