import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import * as schema from "../schema.js";
import {
  createLegacyStateRepository,
  hasLegacyContent,
  legacyContentTables,
  type LegacyContentCounts
} from "./legacyStateRepository.js";
import type { Queryable } from "./types.js";

// The real SQL runs against PostgreSQL in the T04 proof; this pins the table list, the statement
// shape and the mapping.
const empty = Object.fromEntries(
  legacyContentTables.map((table) => [table, 0])
) as unknown as LegacyContentCounts;

function setup(rows: QueryResultRow[]) {
  const query = vi.fn(
    async <T extends QueryResultRow>() => ({ rows, rowCount: rows.length }) as QueryResult<T>
  );
  const db: Queryable = { query };
  return { repository: createLegacyStateRepository(db), query };
}

describe("legacy state repository", () => {
  it("lists the seven legacy-content tables, all present in the schema", () => {
    expect([...legacyContentTables].sort()).toEqual([
      "maintenance_runs",
      "maintenance_schedules",
      "organization_runs",
      "organization_settings_revisions",
      "wiki_investigations",
      "wiki_pages",
      "wiki_policy_revisions"
    ]);
    const schemaTables = new Set(
      Object.values(schema).flatMap((value) => (is(value, PgTable) ? [getTableName(value)] : []))
    );
    for (const table of legacyContentTables) expect(schemaTables.has(table)).toBe(true);
  });

  it("never counts the trigger-fed impact rows, which every ingestion writes", () => {
    for (const table of legacyContentTables) expect(table).not.toMatch(/^knowledge_impact_/);
  });

  it("counts every table in one statement and maps the rows by table name", async () => {
    const { repository, query } = setup([
      {
        wiki_pages: 9,
        organization_runs: 0,
        organization_settings_revisions: 1,
        maintenance_runs: 0,
        maintenance_schedules: 4,
        wiki_policy_revisions: 2,
        wiki_investigations: 0
      }
    ]);
    const counts = await repository.legacyContentCounts();
    expect(counts).toEqual({
      wiki_pages: 9,
      organization_runs: 0,
      organization_settings_revisions: 1,
      maintenance_runs: 0,
      maintenance_schedules: 4,
      wiki_policy_revisions: 2,
      wiki_investigations: 0
    });
    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]![0]);
    for (const table of legacyContentTables) expect(sql).toContain(`from ${table})`);
    expect(sql).not.toContain("knowledge_impact");
  });

  it("reads absent counts as zero", async () => {
    expect(await setup([{ wiki_pages: 3 }]).repository.legacyContentCounts()).toEqual({
      ...empty,
      wiki_pages: 3
    });
    expect(await setup([]).repository.legacyContentCounts()).toEqual(empty);
  });

  it("has legacy content when any one table holds a row", () => {
    expect(hasLegacyContent(empty)).toBe(false);
    for (const table of legacyContentTables)
      expect(hasLegacyContent({ ...empty, [table]: 1 })).toBe(true);
  });
});
