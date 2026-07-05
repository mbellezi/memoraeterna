import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDbClient, type PgPool } from "./client.js";

export async function runMigrations(pool: PgPool, migrationsFolder: string): Promise<void> {
  const db = createDbClient(pool);
  await migrate(db, { migrationsFolder });
}
