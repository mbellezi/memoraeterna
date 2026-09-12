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
      "0002_flat_captain_cross",
      "0003_small_wrecking_crew",
      "0004_condemned_the_anarchist",
      "0005_fantastic_iceman",
      "0006_workable_lockheed",
      "0007_concerned_marrow",
      "0008_plain_wrecker",
      "0009_same_nighthawk",
      "0010_handy_gamora",
      "0011_greedy_dust",
      "0012_broken_psynapse",
      "0013_nice_kinsey_walden",
      "0014_living_typhoid_mary",
      "0015_chunky_marvel_apes",
      "0016_awesome_dragon_man",
      "0017_wooden_thunderbird",
      "0018_fair_golden_guardian",
      "0019_vengeful_wasp",
      "0020_light_stick",
      "0021_small_supernaut",
      "0022_even_alex_wilder",
      "0023_graceful_carnage",
      "0024_awesome_mole_man",
      "0025_clean_the_spike",
      "0026_broad_celestials",
      "0027_curvy_doomsday",
      "0028_elite_preak",
      "0029_slow_valeria_richards",
      "0030_damp_phil_sheldon",
      "0031_luxuriant_nova",
      "0032_faulty_leech",
      "0033_wakeful_kulan_gath",
      "0034_wiki_impact_expression_fix",
      "0035_acoustic_nemesis",
      "0036_hot_scarlet_witch",
      "0037_flawless_norrin_radd",
      "0038_investigation_descendant_impacts",
      "0039_sturdy_lila_cheney"
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
      seededMigrations: [
        "0000_sour_dust",
        "0001_sleepy_the_hunter",
        "0002_flat_captain_cross",
        "0003_small_wrecking_crew",
        "0004_condemned_the_anarchist",
        "0005_fantastic_iceman",
        "0006_workable_lockheed",
        "0007_concerned_marrow",
        "0008_plain_wrecker",
        "0009_same_nighthawk",
        "0010_handy_gamora",
        "0011_greedy_dust",
        "0012_broken_psynapse",
        "0013_nice_kinsey_walden",
        "0014_living_typhoid_mary",
        "0015_chunky_marvel_apes",
        "0016_awesome_dragon_man",
        "0017_wooden_thunderbird",
      "0018_fair_golden_guardian",
      "0019_vengeful_wasp",
      "0020_light_stick",
      "0021_small_supernaut",
      "0022_even_alex_wilder",
      "0023_graceful_carnage",
      "0024_awesome_mole_man",
      "0025_clean_the_spike",
      "0026_broad_celestials",
      "0027_curvy_doomsday",
      "0028_elite_preak",
      "0029_slow_valeria_richards",
      "0030_damp_phil_sheldon",
      "0031_luxuriant_nova",
      "0032_faulty_leech",
      "0033_wakeful_kulan_gath",
      "0034_wiki_impact_expression_fix",
      "0035_acoustic_nemesis",
      "0036_hot_scarlet_witch",
      "0037_flawless_norrin_radd",
      "0038_investigation_descendant_impacts",
      "0039_sturdy_lila_cheney"
      ]
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
