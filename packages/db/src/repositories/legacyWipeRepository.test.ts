import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { PgPool } from "../client.js";
import * as schema from "../schema.js";
import { legacyContentTables } from "./legacyStateRepository.js";
import {
  createLegacyWipeRepository,
  hasLegacyWipeState,
  legacyWipeDifferences,
  legacyWipeSettingsKeys,
  legacyWipeTables,
  type LegacyWipeRun,
  type LegacyWipeState
} from "./legacyWipeRepository.js";

// The real statements run against PostgreSQL in legacy-wipe.sidecar.test.ts and the T36w proof;
// these pin the table list, the guard and the order of the wipe transaction.

const zeroTables = Object.fromEntries(
  legacyWipeTables.map((table) => [table, 0])
) as LegacyWipeState["tables"];

const emptyState: LegacyWipeState = {
  tables: zeroTables,
  keys: {
    settings: {
      "knowledge.automation.policy.v1": 0,
      "knowledge.wiki-areas.v1": 0,
      "organization.active": 0
    },
    scopePageIds: 0,
    jobs: {},
    pagesByManagement: {},
    vaultFiles: {}
  }
};

const legacyState: LegacyWipeState = {
  tables: { ...zeroTables, wiki_pages: 2, organization_runs: 1, knowledge_impact_events: 5 },
  keys: {
    settings: {
      "knowledge.automation.policy.v1": 1,
      "knowledge.wiki-areas.v1": 1,
      "organization.active": 0
    },
    scopePageIds: 1,
    jobs: { "organization:succeeded": 1 },
    pagesByManagement: { ai_managed: 1, human_managed: 1 },
    vaultFiles: { "wiki_page:synced": 2 }
  }
};

const run: LegacyWipeRun = {
  reason: "wiped",
  at: "2026-10-15T12:00:00.000Z",
  backupPath: "/backups/memora-backup-x",
  verifiedAt: "2026-10-15T11:59:00.000Z",
  counts: legacyState,
  token: "0123456789ab"
};

/** A fake connection that answers the recount with `recount` and records every statement. */
function fakePool(recount: {
  tables: LegacyWipeState["tables"];
  settings: Array<{ key: string; value: unknown }>;
  jobs: Array<{ type: string; status: string }>;
  record?: unknown;
}) {
  const statements: string[] = [];
  const client = {
    query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<unknown>>(async (text) => {
      statements.push(text.replace(/\s+/g, " ").trim());
      if (text.startsWith("select (select count(*)"))
        return {
          rows: [
            Object.fromEntries(
              Object.entries(recount.tables).map(([table, n]) => [table, String(n)])
            )
          ]
        };
      if (text.includes("from settings where key = any")) return { rows: recount.settings };
      if (text.includes("from jobs where type = any")) return { rows: recount.jobs };
      if (text.includes("select value from settings where key = $1 for update"))
        return { rows: recount.record === undefined ? [] : [{ value: recount.record }] };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn()
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as PgPool;
  return { pool, client, statements };
}

const recountOf = (state: LegacyWipeState) => ({
  tables: state.tables,
  settings: [
    { key: "knowledge.automation.policy.v1", value: {} },
    { key: "knowledge.wiki-areas.v1", value: true },
    { key: "obsidian.wiki.scope", value: { pageIds: ["p"], sourceIds: [] } }
  ],
  jobs: [{ type: "organization", status: "succeeded" }]
});

describe("legacy wipe repository", () => {
  it("lists exactly the 30 legacy-prefixed schema tables, never note history", () => {
    const schemaTables = Object.values(schema).flatMap((value) =>
      is(value, PgTable) ? [getTableName(value)] : []
    );
    const prefixed = schemaTables
      .filter((table) =>
        /^(wiki_|organization_|maintenance_|automatic_routine_|knowledge_impact_)/.test(table)
      )
      .sort();
    expect([...legacyWipeTables]).toEqual(prefixed);
    expect(legacyWipeTables).toHaveLength(30);
    expect(legacyWipeTables).not.toContain("atomic_note_evidence");
    expect(legacyWipeTables).not.toContain("atomic_note_evolution");
    for (const table of legacyContentTables) expect(legacyWipeTables).toContain(table);
  });

  it("has something to wipe for any legacy row, setting, scope page or job, never for vault files", () => {
    expect(hasLegacyWipeState(emptyState)).toBe(false);
    expect(
      hasLegacyWipeState({
        ...emptyState,
        keys: { ...emptyState.keys, vaultFiles: { "wiki_page:synced": 3 } }
      })
    ).toBe(false);
    for (const table of legacyWipeTables)
      expect(hasLegacyWipeState({ ...emptyState, tables: { ...zeroTables, [table]: 1 } })).toBe(
        true
      );
    for (const key of legacyWipeSettingsKeys)
      expect(
        hasLegacyWipeState({
          ...emptyState,
          keys: { ...emptyState.keys, settings: { ...emptyState.keys.settings, [key]: 1 } }
        })
      ).toBe(true);
    expect(
      hasLegacyWipeState({ ...emptyState, keys: { ...emptyState.keys, scopePageIds: 1 } })
    ).toBe(true);
    expect(
      hasLegacyWipeState({
        ...emptyState,
        keys: { ...emptyState.keys, jobs: { "maintenance:queued": 1 } }
      })
    ).toBe(true);
  });

  it("names every difference between the expected state and a recount", () => {
    expect(legacyWipeDifferences(legacyState, legacyState)).toEqual([]);
    expect(
      legacyWipeDifferences(legacyState, {
        tables: { ...legacyState.tables, wiki_pages: 3 },
        keys: {
          ...legacyState.keys,
          settings: { ...legacyState.keys.settings, "organization.active": 1 },
          jobs: { "maintenance:queued": 1, "organization:succeeded": 1 }
        }
      })
    ).toEqual([
      "wiki_pages: expected 2, found 3",
      "settings organization.active: expected 0, found 1",
      "jobs maintenance:queued: expected 0, found 1"
    ]);
  });

  it("rejects a malformed snapshot identifier before connecting", async () => {
    const { pool } = fakePool(recountOf(legacyState));
    await expect(
      createLegacyWipeRepository(pool).countKeys("x'; drop table jobs; --")
    ).rejects.toThrow("Invalid snapshot identifier");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rolls back without truncating when the recount under the locks differs", async () => {
    const { pool, statements, client } = fakePool({
      ...recountOf(legacyState),
      tables: { ...legacyState.tables, wiki_pages: 3 }
    });
    const result = await createLegacyWipeRepository(pool).wipe(legacyState, run, {
      lockTimeoutMs: 1000
    });
    expect(result).toEqual({
      outcome: "changed",
      differences: ["wiki_pages: expected 2, found 3"]
    });
    expect(statements.at(-1)).toBe("rollback");
    expect(statements.some((sql) => sql.startsWith("truncate"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("delete"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("locks, recounts, truncates, deletes, bumps the clock and records in one transaction", async () => {
    const earlier = { ...run, token: "aaaaaaaaaaaa", at: "2026-10-01T00:00:00.000Z" };
    const { pool, statements, client } = fakePool({
      ...recountOf(legacyState),
      record: { runs: [earlier] }
    });
    const result = await createLegacyWipeRepository(pool).wipe(legacyState, run, {
      lockTimeoutMs: 30_000
    });
    expect(result.outcome).toBe("wiped");
    const kinds = statements.map((sql) => sql.split(" ").slice(0, 2).join(" "));
    expect(kinds).toEqual([
      "begin isolation",
      "set local",
      "lock table",
      "select (select",
      "select key,",
      "select type,",
      "truncate table",
      "delete from",
      "update settings",
      "delete from",
      "insert into",
      "select value",
      "insert into",
      "commit"
    ]);
    expect(statements[1]).toBe("set local lock_timeout = '30000ms'");
    const lock = statements[2]!;
    const truncate = statements[6]!;
    for (const table of legacyWipeTables) {
      expect(lock).toContain(`public."${table}"`);
      expect(truncate).toContain(`public."${table}"`);
    }
    expect(lock).toMatch(/in access exclusive mode$/);
    expect(truncate).not.toMatch(/cascade/i);
    expect(statements[7]).toContain("delete from settings");
    expect(statements[9]).toContain("delete from jobs");
    expect(statements[10]).toContain("obsidian_projection_clock");
    const recordWrite = client.query.mock.calls.find(([sql]) =>
      sql.includes("insert into settings")
    );
    const written = JSON.parse(String(recordWrite?.[1]?.[1]));
    expect(written.runs).toEqual([earlier, run]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and rethrows when a statement fails", async () => {
    const { pool, client, statements } = fakePool(recountOf(legacyState));
    const query = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (text: string, values?: readonly unknown[]) => {
      if (text.startsWith("truncate"))
        throw new Error("cannot truncate a table referenced in a foreign key constraint");
      return query(text, values);
    });
    await expect(
      createLegacyWipeRepository(pool).wipe(legacyState, run, { lockTimeoutMs: 1000 })
    ).rejects.toThrow("foreign key");
    expect(statements.at(-1)).toBe("rollback");
    expect(statements.some((sql) => sql === "commit")).toBe(false);
  });

  it("refuses to record a malformed run", async () => {
    const { pool } = fakePool(recountOf(legacyState));
    await expect(
      createLegacyWipeRepository(pool).wipe(
        legacyState,
        { ...run, verifiedAt: "yesterday" },
        { lockTimeoutMs: 1000 }
      )
    ).rejects.toThrow();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
