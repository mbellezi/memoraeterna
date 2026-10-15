// Real-database check of `topics:export` (T22a): a throwaway PostgreSQL sidecar migrated from
// scratch and seeded with the topic load proof's synthetic library (18.6k notes with 1024-d vectors,
// 1.5k topics, 18.8k placements, written through `topicTreeRepository`), then
//
//   - the SQL source exports it through a read-only session (the export cannot write),
//   - the counts of the export equal the database's own counts,
//   - the replay store loads through T09's loader and its vectors equal the stored ones,
//   - the CLI (`scripts/topics/export.ts`) runs end to end from a scratch connection file,
//   - an existing export is refused without --force.
//
//   npx tsx scripts/topics/verify-export.ts   (MEMORA_VERIFY_KEEP=1 keeps the work folder)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import pg from "pg";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";

import { runTopicLoadProof } from "../../packages/db/src/scripts/topicLoadProof.js";
import { loadReplayDataset, listReplayDatasets, repoRoot } from "./datasets.js";
import { createSqlTopicExportSource, exportTopicTree } from "./export-tree.js";
import { readReplayStore } from "./export-vectors.js";

const execFileAsync = promisify(execFile);
const workDir = await mkdtemp(join(tmpdir(), "memora-topic-export-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_topic_export",
  user: "memora_topic_export",
  password: `topic-export-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

const step = (what: string): void => console.log(`ok  ${what}`);

try {
  const connection = await manager.start();
  const setup = createPgPool({ connectionString: connection.connectionString, max: 1 });
  try {
    await runMigrations(setup, join(repoRoot, "packages", "db", "drizzle"));
  } finally {
    await closePgPool(setup);
  }
  const seeded = await runTopicLoadProof(connection.connectionString, {
    skeletonRuns: 1,
    vectorRuns: 1,
    log: (line) => console.log(`seed  ${line}`)
  });
  step(
    `seeded ${seeded.counts.notes} notes, ${seeded.counts.topics} topics, ` +
      `${seeded.counts.placements} placements, ${seeded.counts.vectors} vectors`
  );

  // The session the CLI uses: it can read, it cannot write.
  const client = new pg.Client({
    connectionString: connection.connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=300000"
  });
  await client.connect();
  try {
    await assert.rejects(client.query("create table export_probe (id int)"), /read-only/u);
    step("the export session refuses writes");

    const count = async (sql: string): Promise<number> =>
      Number((await client.query<{ n: number }>(sql)).rows[0]?.n);
    const expected = {
      topics: await count("select count(*)::int as n from topics"),
      placements: await count("select count(*)::int as n from topic_placements"),
      notes: await count(
        `select count(*)::int as n from atomic_notes
         where status not in ('rejected', 'archived') and supersession_status = 'current'`
      ),
      roots: await count(
        "select count(*)::int as n from source_items where parent_source_item_id is null"
      ),
      vectors: await count(
        `select count(*)::int as n from embeddings_1024 e join atomic_notes a on a.id = e.target_id
         where e.target_type = 'atomic_note' and e.strategy like 'native-v2:%'
           and a.status not in ('rejected', 'archived') and a.supersession_status = 'current'`
      )
    };

    const cache = join(workDir, "cache");
    const started = performance.now();
    const result = await exportTopicTree(createSqlTopicExportSource(client), {
      name: "verify-export",
      cacheDirectory: cache,
      label: "verify"
    });
    const exportMs = Math.round(performance.now() - started);
    assert.equal(result.summary.topics, expected.topics);
    assert.equal(result.summary.placements, expected.placements);
    assert.equal(result.summary.notes, expected.notes);
    assert.equal(result.summary.vectorRows, expected.vectors);
    assert.equal(result.summary.vectorRows + result.summary.notesWithoutVector, expected.notes);
    step(
      `export counts equal the database: ${expected.topics} topics, ${expected.placements} placements, ` +
        `${expected.notes} notes (${expected.vectors} with a vector) in ${exportMs} ms`
    );

    const document = JSON.parse(await readFile(result.exportPath, "utf8")) as {
      topics: unknown[];
      placements: unknown[];
      roots: unknown[];
      audit: { items: number; reachable: number; reachability: number };
      tree: { generation: number };
    };
    assert.equal(document.topics.length, expected.topics);
    assert.equal(document.placements.length, expected.placements);
    assert.equal(document.roots.length, expected.roots);
    assert.equal(document.audit.items, expected.notes + expected.roots);
    assert.ok(document.audit.reachable > 0 && document.audit.reachable <= document.audit.items);
    step(
      `the audit sees ${document.audit.reachable} of ${document.audit.items} expected items reachable`
    );

    // The replay store: T09's loader reads it and the vectors are the stored ones.
    const vectors = join(cache, "topics", "vectors");
    const store = await readReplayStore(vectors, "verify-export");
    assert.equal(store.meta.count, expected.vectors);
    assert.equal(store.meta.dim, 1024);
    assert.equal(store.rows.length, store.matrix.count);
    const dataset = await loadReplayDataset("verify-export", { dirs: [vectors], twins: false });
    assert.equal(dataset.rows.length, expected.vectors);
    assert.deepEqual(
      (await listReplayDatasets([vectors])).map((entry) => entry.name),
      ["verify-export"]
    );
    const probe = store.rows[Math.floor(store.rows.length / 2)]!;
    const stored = await client.query<{ embedding: string }>(
      `select embedding::text as embedding from embeddings_1024
       where target_type = 'atomic_note' and target_id = $1 and strategy like 'native-v2:%'`,
      [probe.id]
    );
    const row = store.rows.indexOf(probe);
    const fromDatabase = JSON.parse(stored.rows[0]!.embedding) as number[];
    let norm = 0;
    for (const value of fromDatabase) norm += value * value;
    norm = Math.sqrt(norm);
    for (let k = 0; k < 1024; k += 1)
      assert.ok(
        Math.abs((store.matrix.data[row * 1024 + k] as number) - fromDatabase[k]! / norm) < 1e-6
      );
    step("the replay store loads through the T09 loader and holds the stored (unit) vectors");

    await assert.rejects(
      exportTopicTree(createSqlTopicExportSource(client), {
        name: "verify-export",
        cacheDirectory: cache
      }),
      /already exists/u
    );
    await exportTopicTree(createSqlTopicExportSource(client), {
      name: "verify-export",
      cacheDirectory: cache,
      force: true,
      vectors: false
    });
    step("an existing export is refused without --force and replaced with it");

    // The CLI from a scratch connection file, as the orchestrator will run it on a profile.
    const connectionFile = join(workDir, "scratch-verify.json");
    await writeFile(
      connectionFile,
      JSON.stringify({ connectionString: connection.connectionString, slug: "verify" })
    );
    const { stdout } = await execFileAsync(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [
        join(repoRoot, "scripts", "topics", "export.ts"),
        "--db",
        connectionFile,
        "--name",
        "verify-cli",
        "--cache",
        cache
      ],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
    );
    const summary = JSON.parse(stdout) as { topics: number; placements: number; notes: number };
    assert.equal(summary.topics, expected.topics);
    assert.equal(summary.notes, expected.notes);
    assert.ok(!stdout.includes(connection.connectionString));
    const cliDocument = await readFile(
      join(cache, "topics", "exports", "verify-cli", "export.json"),
      "utf8"
    );
    assert.ok(!cliDocument.includes(connection.connectionString));
    assert.ok(!cliDocument.includes("topic-export-"));
    assert.equal(
      JSON.parse(cliDocument).tree.generation,
      document.tree.generation,
      "the CLI exports the same tree"
    );
    step("the CLI exports from a connection file and writes no connection string");
    console.log("TOPICS_EXPORT_VERIFY ok");
  } finally {
    await client.end();
  }
} catch (error) {
  console.error("TOPICS_EXPORT_VERIFY failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await manager.stop().catch(() => undefined);
  if (process.env.MEMORA_VERIFY_KEEP === "1") console.log(`kept ${workDir}`);
  else await rm(workDir, { recursive: true, force: true });
}
