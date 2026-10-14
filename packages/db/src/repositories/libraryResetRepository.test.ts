import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "../client.js";
import {
  createLibraryResetRepository,
  resetClearedTables,
  resetPreservedTables
} from "./libraryResetRepository.js";

describe("full application reset", () => {
  it("rolls back graph removal when relational cleanup fails", async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.includes("to_regclass")) return { rows: [{ available: true }], rowCount: 1 };
      if (sql.startsWith("truncate")) throw new Error("foreign key guard");
      return { rows: [], rowCount: 1 };
    };
    const pool = { connect: async () => ({ query, release }) } as unknown as PgPool;
    await expect(createLibraryResetRepository(pool).reset()).rejects.toThrow("foreign key guard");
    expect(statements.some((sql) => sql.includes("drop_graph"))).toBe(true);
    expect(statements.at(-1)).toBe("rollback");
    expect(statements).not.toContain("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("commits relational reset without loading an absent optional AGE catalog", async () => {
    const statements: string[] = [],
      release = vi.fn();
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.includes("to_regclass")) return { rows: [{ available: false }], rowCount: 1 };
      if (
        sql.includes("load 'age'") ||
        sql.includes("from ag_catalog") ||
        sql.includes("drop_graph")
      )
        throw new Error("AGE is unavailable");
      return { rows: [], rowCount: 0 };
    };
    await createLibraryResetRepository({
      connect: async () => ({ query, release })
    } as unknown as PgPool).reset();
    const truncate = statements.find((sql) => sql.startsWith("truncate"))!;
    expect(truncate).not.toContain("cascade");
    for (const table of resetPreservedTables) expect(truncate).not.toContain(`public."${table}"`);
    expect(statements.at(-2)).toBe(
      "insert into public.obsidian_projection_clock(id,generation) values(1,0)"
    );
    expect(statements.at(-1)).toBe("commit");
    expect(statements).not.toContain("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not hide graph cleanup errors when the AGE catalog is present", async () => {
    const statements: string[] = [],
      release = vi.fn();
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.includes("to_regclass")) return { rows: [{ available: true }], rowCount: 1 };
      if (sql.includes("drop_graph")) throw new Error("graph permission failure");
      return { rows: [], rowCount: 1 };
    };
    await expect(
      createLibraryResetRepository({
        connect: async () => ({ query, release })
      } as unknown as PgPool).reset()
    ).rejects.toThrow("graph permission failure");
    expect(statements.at(-1)).toBe("rollback");
    expect(statements.some((sql) => sql.startsWith("truncate"))).toBe(false);
    expect(statements).not.toContain("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("covers every embedding family and durable wiki/harness history", () => {
    for (const family of ["embeddings", "entity_identity_embeddings", "relation_type_embeddings"]) {
      for (const dimension of [256, 768, 1024])
        expect(resetClearedTables).toContain(`${family}_${dimension}`);
    }
    for (const table of [
      "wiki_pages",
      "wiki_page_revisions",
      "wiki_evidence",
      "wiki_dependencies",
      "organization_settings_revisions",
      "organization_settings_activations",
      "organization_runs",
      "maintenance_schedules",
      "maintenance_runs",
      "maintenance_decisions",
      "integration_clients",
      "settings",
      "storage_settings",
      "local_model_downloads"
    ])
      expect(resetClearedTables).toContain(table);
  });
});
