import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { applyBaselineSeedIfNeeded, splitSqlStatements, verifyBaselineSeed } from "./seed.js";

class FakePool {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly options: { hasMigrationHistory?: boolean; isEmpty?: boolean } = {}) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });

    if (text.includes("to_regclass")) {
      return createResult([{ migrationTable: this.options.hasMigrationHistory ? "drizzle.__drizzle_migrations" : null }]);
    }

    if (text.includes("from drizzle.__drizzle_migrations")) {
      return createResult([{ count: this.options.hasMigrationHistory ? "1" : "0" }]);
    }

    if (text.includes("from pg_class")) {
      const isEmpty = this.options.isEmpty ?? true;
      return createResult([{ relationCount: isEmpty ? "0" : "1", enumCount: "0" }]);
    }

    return createResult([]);
  }
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");

describe("baseline seed", () => {
  it("keeps the baseline seed in sync with the current migrations", async () => {
    const plan = await verifyBaselineSeed(migrationsFolder, seedFolder);

    expect(plan.seedFile).toBe("baseline.sql");
    expect(plan.includedMigrations.map((migration) => migration.tag)).toEqual([
      "0000_sour_dust",
      "0001_sleepy_the_hunter",
      "0002_flat_captain_cross"
    ]);
  });

  it("splits seed SQL on Drizzle statement breakpoints", () => {
    expect(splitSqlStatements("select 1;--> statement-breakpoint\n\nselect 2;")).toEqual([
      "select 1;",
      "select 2;"
    ]);
  });

  it("applies the baseline seed and records covered migrations on an empty database", async () => {
    const pool = new FakePool({ isEmpty: true });

    const result = await applyBaselineSeedIfNeeded(pool, migrationsFolder, seedFolder);

    expect(result).toEqual({
      applied: true,
      seededMigrations: ["0000_sour_dust", "0001_sleepy_the_hunter", "0002_flat_captain_cross"]
    });
    expect(pool.queries.some((query) => query.text === "begin")).toBe(true);
    expect(pool.queries.some((query) => query.text.startsWith("CREATE TYPE"))).toBe(true);
    expect(
      pool.queries.some((query) => query.text.includes("insert into drizzle.__drizzle_migrations"))
    ).toBe(true);
    expect(pool.queries.at(-1)?.text).toBe("commit");
  });

  it("skips the baseline seed when migration history already exists", async () => {
    const pool = new FakePool({ hasMigrationHistory: true });

    const result = await applyBaselineSeedIfNeeded(pool, "/missing-migrations", "/missing-seed");

    expect(result).toEqual({ applied: false, seededMigrations: [] });
    expect(pool.queries.some((query) => query.text === "begin")).toBe(false);
  });

  it("refuses to seed a non-empty database without migration history", async () => {
    const pool = new FakePool({ isEmpty: false });

    await expect(applyBaselineSeedIfNeeded(pool, migrationsFolder, seedFolder)).rejects.toThrow(
      "Database is not empty and has no Drizzle migration history"
    );
  });
});

function createResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}
