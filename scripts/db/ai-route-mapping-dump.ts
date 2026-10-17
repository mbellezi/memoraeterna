import { parseArgs } from "node:util";

import { closePgPool, createAiConfigRepository, createPgPool, type JsonObject } from "@app/db";

import {
  applyRouteMappingPlan,
  classMapSettingKey,
  createRouteMappingStore,
  describeEffectiveRoutes,
  effectiveRouteChanges,
  legacyOperations,
  mapLegacyRoutesV1,
  planLegacyRouteMapping,
  unroutedGenerativeDecide
} from "../../apps/desktop/src/main/services/ai-route-mapping.js";
import { resolveConnection } from "../kpi/connection.js";

/**
 * The proof of F3 T54 for `mapLegacyRoutesV1` (D34): every operation that ran on a legacy task
 * route keeps the model and the parameters it ran on once the class routes exist.
 *
 *   npx tsx scripts/db/ai-route-mapping-dump.ts --db <connection.json | postgres url> [--apply]
 *
 * It resolves each legacy operation through the real route SQL (`getDefaultTask`) with the route
 * keys of before F3 (the operation override, the class route only for callers that already stated
 * a class, the task route) and prints the profile and parameters. Without `--apply` it plans the
 * mapping in memory, so the database is only read, and compares the dump with what the planned
 * routes would resolve. With `--apply` it runs the mapping on the database (use a clone of a
 * profile, never a live one), resolves every operation again with the keys of every caller that
 * states its class, and compares the two dumps. The exit code is 1 when they differ.
 */
const usage = `Usage: npx tsx scripts/db/ai-route-mapping-dump.ts --db <connection.json | postgres url> [--apply] [--json]

  --db <value>   A scratch connection file or a postgres:// URL (a clone of the profile under test).
  --apply        Run the mapping on the database. Without it the database is only read.
  --json         Print the dumps as JSON instead of a table.`;

type Dump = Array<{
  operation: string;
  task: string;
  profileId: string | null;
  parameters: JsonObject | null;
  routeKey: string | null;
}>;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      apply: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help || !values.db) {
    console.log(usage);
    return values.help ? 0 : 2;
  }
  const connection = await resolveConnection(values.db);
  const pool = createPgPool({ connectionString: connection.connectionString, max: 2 });
  try {
    const config = createAiConfigRepository(pool);
    const store = createRouteMappingStore(pool);

    const sqlDump = async (mode: "legacy" | "classed"): Promise<Dump> => {
      const dump: Dump = [];
      for (const entry of legacyOperations) {
        const keys = [
          `op:${entry.operation}`,
          ...(mode === "classed" || entry.classedBefore ? [`class:${entry.class}`] : []),
          entry.task
        ];
        const selection = await config.getDefaultTask(entry.task, undefined, keys);
        dump.push({
          operation: entry.operation,
          task: entry.task,
          profileId: selection?.profileId ?? null,
          parameters: selection?.parameters ?? null,
          routeKey: selection?.routeKey ?? null
        });
      }
      return dump;
    };

    const before = await sqlDump("legacy");
    const read = await store.read();
    const plan = planLegacyRouteMapping(read.facts, read.state?.releasedClasses ?? []);
    let after: Dump;
    if (values.apply) {
      const written = await mapLegacyRoutesV1(store);
      console.error(
        `mapping applied: ${written.classRoutes.length} class routes and ${written.operationRoutes.length} operation routes written`
      );
      after = await sqlDump("classed");
    } else {
      const mapped = applyRouteMappingPlan(read.facts, plan);
      after = describeEffectiveRoutes(mapped, "classed").map((entry) => ({
        operation: entry.operation,
        task: entry.task,
        profileId: entry.route?.profileId ?? null,
        parameters: entry.route?.parameters ?? null,
        routeKey: null
      }));
    }

    // Only operations whose legacy route resolved are compared: a call that failed before may not
    // start to work silently, but it is not a model change either.
    const changes = effectiveRouteChanges(
      before.map((entry) => ({
        operation: entry.operation,
        task: entry.task as never,
        class: "write-fast",
        route: entry.profileId
          ? { profileId: entry.profileId, parameters: entry.parameters ?? {} }
          : null
      })),
      after.map((entry) => ({
        operation: entry.operation,
        task: entry.task as never,
        class: "write-fast",
        route: entry.profileId
          ? { profileId: entry.profileId, parameters: entry.parameters ?? {} }
          : null
      }))
    );
    const routes = (await config.listTaskRoutes()).map((route) => route.task);
    const unrouted = unroutedGenerativeDecide(routes);

    if (values.json) {
      console.log(
        JSON.stringify({ applied: values.apply, before, after, changes, unrouted }, null, 2)
      );
    } else {
      console.log(`database: ${connection.info.name} (${connection.info.host})`);
      console.log(
        `mode: ${values.apply ? "applied" : "read-only plan"}  state: ${classMapSettingKey}`
      );
      console.log(
        `planned or written: ${plan.classRoutes.length} class routes, ${plan.operationRoutes.length} operation routes`
      );
      console.log("operation".padEnd(34), "before".padEnd(38), "after");
      for (const [index, entry] of before.entries()) {
        const next = after[index]!;
        console.log(
          entry.operation.padEnd(34),
          (entry.profileId ?? "(unrouted)").padEnd(38),
          next.profileId ?? "(unrouted)"
        );
      }
      console.log(
        `operations unrouted before: ${before.filter((e) => e.profileId === null).length}`
      );
      console.log(
        `generative-decide operations without a route: ${unrouted.length ? unrouted.join(", ") : "none"}`
      );
      console.log(
        changes.length === 0
          ? "RESULT: effective models equal before and after"
          : `RESULT: ${changes.length} operation(s) changed model or parameters`
      );
      for (const change of changes)
        console.log("  changed:", change.operation, JSON.stringify(change));
    }
    return changes.length === 0 ? 0 : 1;
  } finally {
    await closePgPool(pool);
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 2;
});
