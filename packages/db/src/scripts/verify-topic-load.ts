import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";
import { runTopicLoadProof } from "./topicLoadProof.js";

/**
 * Real-database proof of the topic load repository (T12b) on a throwaway PostgreSQL sidecar migrated
 * from scratch: answers on a synthetic library of 18.6k notes with 1024-d vectors, 1.5k topics and
 * about 18.8k placements, the latency bars (skeleton under 300 ms, the vectors under 5 s) and EXPLAIN
 * proving the statements read through indexes. Needs the topic tables of migration 0053.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-topic-load-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_topic_load",
  user: "memora_topic_load",
  password: `topic-load-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

try {
  const connection = await manager.start();
  const setup = createPgPool({ connectionString: connection.connectionString, max: 1 });
  try {
    await runMigrations(setup, resolve(packageRoot, "drizzle"));
    const topicTables = await setup.query<{ present: boolean }>(
      "select to_regclass('public.topic_trees') is not null as present"
    );
    if (!topicTables.rows[0]?.present) {
      throw new Error(
        "The topic tables (migration 0053, T12) are missing: run this proof after T12."
      );
    }
  } finally {
    await closePgPool(setup);
  }
  const report = await runTopicLoadProof(connection.connectionString, {
    log: (line) => console.log(line)
  });
  console.log(JSON.stringify(report, null, 2));
  console.log("db:topic-load:verify passed");
} finally {
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
