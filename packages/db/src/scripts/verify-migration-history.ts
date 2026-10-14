import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PgPool } from "../index.js";

/**
 * Helpers for verify scripts that depend on a set of migrations without pinning the total count:
 * later migrations may exist, so a check names the migrations it needs and verifies those.
 */
export interface JournalMigration {
  tag: string;
  when: number;
}

/** The journal migrations from the first one up to and including `lastTag`. */
export async function requiredMigrations(
  migrationsFolder: string,
  lastTag: string
): Promise<JournalMigration[]> {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")
  ) as { entries: JournalMigration[] };
  const entries = journal.entries.map(({ tag, when }) => ({ tag, when }));
  const last = entries.findIndex((entry) => entry.tag === lastTag);
  if (last < 0) throw new Error(`Required migration ${lastTag} is missing from the journal.`);
  return entries.slice(0, last + 1);
}

/** Every required migration was applied by the baseline seed, whatever else it holds. */
export function assertMigrationsSeeded(
  seeded: readonly string[],
  required: readonly JournalMigration[],
  label: string
): void {
  const missing = required.filter((migration) => !seeded.includes(migration.tag));
  if (missing.length)
    throw new Error(`${label}: baseline is missing ${missing.map((m) => m.tag).join(", ")}.`);
}

/** Every required migration is in the migration history, matched by its journal timestamp. */
export async function assertMigrationsRecorded(
  db: Pick<PgPool, "query">,
  required: readonly JournalMigration[],
  label: string
): Promise<void> {
  const history = await db.query<{ createdAt: string }>(
    'select created_at::text as "createdAt" from drizzle.__drizzle_migrations'
  );
  const recorded = new Set(history.rows.map((row) => row.createdAt));
  const missing = required.filter((migration) => !recorded.has(String(migration.when)));
  if (missing.length)
    throw new Error(`${label}: history is missing ${missing.map((m) => m.tag).join(", ")}.`);
}
