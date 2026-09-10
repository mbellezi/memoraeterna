import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { PgPool } from "../client.js";
import * as schema from "../schema.js";

// Model identities, provider credentials (references only), parameters and routes
// survive a reset. Download attempts are transient and reference deleted jobs.
export const resetPreservedTables = new Set([
  "ai_model_capabilities", "ai_profile_sets", "ai_profile_tasks",
  "ai_provider_configs", "ai_task_profile_routes", "local_models", "local_model_files"
]);

export const resetClearedTables = Object.values(schema)
  .flatMap(value => is(value, PgTable) ? [getTableName(value)] : []).filter(name => !resetPreservedTables.has(name)).sort();

export function createLibraryResetRepository(pool: PgPool) {
  return {
    async reset() {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("load 'age'");
        await client.query('set local search_path = ag_catalog, "$user", public');
        const graph = await client.query("select 1 from ag_catalog.ag_graph where name=$1", ["memora_knowledge"]);
        if (graph.rowCount) await client.query("select ag_catalog.drop_graph($1, true)", ["memora_knowledge"]);
        // No CASCADE: a new FK into preserved configuration must fail safely.
        await client.query(`truncate table ${resetClearedTables.map(name => `public."${name}"`).join(", ")} restart identity`);
        await client.query("insert into public.obsidian_projection_clock(id,generation) values(1,0)");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
