import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";

interface BaselineSeedManifest {
  readonly version: 1;
  readonly seedFile: string;
  readonly includedMigrations: readonly string[];
}

interface MigrationJournalEntry {
  readonly tag: string;
  readonly when: number;
}

interface MigrationJournal {
  readonly entries: readonly MigrationJournalEntry[];
}

export interface BaselineSeedMigration {
  readonly tag: string;
  readonly folderMillis: number;
  readonly hash: string;
  readonly sql: string;
}

export interface BaselineSeedPlan {
  readonly seedFile: string;
  readonly seedSql: string;
  readonly includedMigrations: readonly BaselineSeedMigration[];
}

export interface BaselineSeedResult {
  readonly applied: boolean;
  readonly seededMigrations: readonly string[];
}

interface QueryablePool {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>>;
}

const statementBreakpoint = "--> statement-breakpoint";

export async function applyBaselineSeedIfNeeded(
  pool: QueryablePool,
  migrationsFolder: string,
  seedFolder: string
): Promise<BaselineSeedResult> {
  if ((await getMigrationHistoryCount(pool)) > 0) {
    return { applied: false, seededMigrations: [] };
  }

  if (!(await isApplicationDatabaseEmpty(pool))) {
    throw new Error(
      "Database is not empty and has no Drizzle migration history; refusing to apply the baseline seed."
    );
  }

  const plan = await verifyBaselineSeed(migrationsFolder, seedFolder);
  await pool.query("begin");

  try {
    for (const statement of splitSqlStatements(plan.seedSql)) {
      await pool.query(statement);
    }

    await ensureDrizzleMigrationTable(pool);

    for (const migration of plan.includedMigrations) {
      await pool.query(
        'insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)',
        [migration.hash, migration.folderMillis]
      );
    }

    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }

  return {
    applied: true,
    seededMigrations: plan.includedMigrations.map((migration) => migration.tag)
  };
}

export async function verifyBaselineSeed(migrationsFolder: string, seedFolder: string): Promise<BaselineSeedPlan> {
  const plan = await readBaselineSeedPlan(migrationsFolder, seedFolder);
  const journal = await readMigrationJournal(migrationsFolder);
  const journalTags = journal.entries.map((entry) => entry.tag);
  const seedTags = plan.includedMigrations.map((migration) => migration.tag);

  if (!stringArraysEqual(seedTags, journalTags)) {
    throw new Error(
      `Baseline seed is out of sync with migrations. Seed has [${seedTags.join(", ")}], migrations have [${journalTags.join(", ")}].`
    );
  }

  const expectedSql = plan.includedMigrations.map((migration) => migration.sql).join("\n\n");
  if (normalizeSql(plan.seedSql) !== normalizeSql(expectedSql)) {
    throw new Error("Baseline seed SQL does not match the included migration SQL files.");
  }

  return plan;
}

export async function readBaselineSeedPlan(
  migrationsFolder: string,
  seedFolder: string
): Promise<BaselineSeedPlan> {
  const manifest = parseBaselineSeedManifest(await readFile(join(seedFolder, "manifest.json"), "utf8"));
  const journal = await readMigrationJournal(migrationsFolder);
  const journalByTag = new Map(journal.entries.map((entry) => [entry.tag, entry]));
  const includedMigrations: BaselineSeedMigration[] = [];

  for (const tag of manifest.includedMigrations) {
    const entry = journalByTag.get(tag);
    if (!entry) {
      throw new Error(`Baseline seed references an unknown migration: ${tag}.`);
    }

    const sql = await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8");
    includedMigrations.push({
      tag: entry.tag,
      folderMillis: entry.when,
      hash: createHash("sha256").update(sql).digest("hex"),
      sql
    });
  }

  return {
    seedFile: manifest.seedFile,
    seedSql: await readFile(join(seedFolder, manifest.seedFile), "utf8"),
    includedMigrations
  };
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(statementBreakpoint)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function getMigrationHistoryCount(pool: QueryablePool): Promise<number> {
  const exists = await pool.query<{ migrationTable: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations')::text as \"migrationTable\""
  );

  if (!exists.rows[0]?.migrationTable) {
    return 0;
  }

  const count = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  return Number(count.rows[0]?.count ?? 0);
}

async function isApplicationDatabaseEmpty(pool: QueryablePool): Promise<boolean> {
  const result = await pool.query<{ relationCount: string; enumCount: string }>(`
    select
      (
        select count(*)::text
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
      ) as "relationCount",
      (
        select count(*)::text
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname not in ('pg_catalog', 'information_schema', 'drizzle')
          and t.typtype = 'e'
      ) as "enumCount"
  `);
  const row = result.rows[0];

  return Number(row?.relationCount ?? 0) === 0 && Number(row?.enumCount ?? 0) === 0;
}

async function ensureDrizzleMigrationTable(pool: QueryablePool): Promise<void> {
  await pool.query("create schema if not exists drizzle");
  await pool.query(`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
}

async function readMigrationJournal(migrationsFolder: string): Promise<MigrationJournal> {
  const raw = await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error("Invalid Drizzle migration journal.");
  }

  const entries = parsed.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.tag !== "string" || typeof entry.when !== "number") {
      throw new Error("Invalid Drizzle migration journal entry.");
    }

    return {
      tag: entry.tag,
      when: entry.when
    };
  });

  return { entries };
}

function parseBaselineSeedManifest(raw: string): BaselineSeedManifest {
  const parsed = JSON.parse(raw) as unknown;

  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.seedFile !== "string" ||
    !isSafeFileName(parsed.seedFile) ||
    !Array.isArray(parsed.includedMigrations) ||
    !parsed.includedMigrations.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Invalid baseline seed manifest.");
  }

  return {
    version: 1,
    seedFile: parsed.seedFile,
    includedMigrations: parsed.includedMigrations
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeFileName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeSql(sql: string): string {
  return `${sql.replace(/\r\n/g, "\n").trimEnd()}\n`;
}
