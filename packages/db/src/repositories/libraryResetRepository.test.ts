import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "../client.js";
import { createLibraryResetRepository, resetClearedTables } from "./libraryResetRepository.js";

describe("full application reset", () => {
  it("rolls back graph removal when relational cleanup fails", async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const query = async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("truncate")) throw new Error("foreign key guard");
      return { rows: [], rowCount: 1 };
    };
    const pool = { connect: async () => ({ query, release }) } as unknown as PgPool;
    await expect(createLibraryResetRepository(pool).reset()).rejects.toThrow("foreign key guard");
    expect(statements.some(sql => sql.includes("drop_graph"))).toBe(true);
    expect(statements.at(-1)).toBe("rollback");
    expect(statements).not.toContain("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("covers every embedding family and durable wiki/harness history", () => {
    for (const family of ["embeddings", "entity_identity_embeddings", "relation_type_embeddings"]) {
      for (const dimension of [256, 768, 1024]) expect(resetClearedTables).toContain(`${family}_${dimension}`);
    }
    for (const table of ["wiki_pages", "wiki_page_revisions", "wiki_evidence", "wiki_dependencies",
      "organization_settings_revisions", "organization_settings_activations", "organization_runs",
      "maintenance_schedules", "maintenance_runs", "maintenance_decisions", "integration_clients",
      "settings", "storage_settings", "local_model_downloads"]) expect(resetClearedTables).toContain(table);
  });
});
