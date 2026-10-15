// Real-database check of `topics:report` (T22b) at ENV-C's scale: a throwaway PostgreSQL sidecar
// migrated from scratch and seeded with the topic load proof's synthetic library (18.6k notes with
// 1024-d vectors, 1.5k topics, written through `topicTreeRepository`), exported through the SQL
// source of `topics:export` and then reported on:
//
//   - the report reads the export and its 18.6k-row replay store, builds the fresh tree offline
//     with the product's builder and compares the two trees (time recorded),
//   - the in-app audit of the export and the report agree (items, reachability, hard violations),
//   - the samples hold five central members each, with the titles of the stored notes,
//   - the CLI runs end to end from the cache, writes the HTML and the data, and the page holds no
//     connection string,
//   - the whole report stays within a time budget.
//
// The synthetic tree is seeded, not built by Louvain, so it is expected to DIFFER from the fresh
// build; the equal-partition proof on a cold-start build belongs to ENV-C itself.
//
//   npx tsx scripts/topics/verify-report.ts   (MEMORA_VERIFY_KEEP=1 keeps the work folder)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { repoRoot } from "./datasets.js";
import { createSqlTopicExportSource, exportTopicTree } from "./export-tree.js";
import { ComparisonDocumentSchema, defaultReportOptions } from "./report-core.js";
import { runReport } from "./report.js";

const execFileAsync = promisify(execFile);
const workDir = await mkdtemp(join(tmpdir(), "memora-topic-report-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
const password = `topic-report-${randomUUID()}`;
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_topic_report",
  user: "memora_topic_report",
  password,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

const step = (what: string): void => console.log(`ok  ${what}`);
const budgetMs = 180_000;

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

  const cache = join(workDir, "cache");
  const client = new pg.Client({
    connectionString: connection.connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=300000"
  });
  await client.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const exported = await exportTopicTree(createSqlTopicExportSource(client), {
      name: "verify-report",
      cacheDirectory: cache,
      label: "verify"
    }).finally(() => client.query("rollback"));
    step(
      `exported ${exported.summary.notes} notes (${exported.summary.vectorRows} with a vector), ` +
        `${exported.summary.topics} topics`
    );
  } finally {
    await client.end();
  }

  const began = performance.now();
  const result = await runReport(
    {
      exports: ["verify-report"],
      cache,
      out: null,
      corpus: null,
      options: { ...defaultReportOptions, sample: 12 },
      check: false
    },
    (line) => console.log(`report  ${line}`)
  );
  const reportMs = Math.round(performance.now() - began);
  assert.ok(reportMs < budgetMs, `the report took ${reportMs} ms, over the ${budgetMs} ms budget`);
  const [profile] = result.document.profiles;
  assert.ok(profile);
  assert.equal(profile.name, "verify-report");
  assert.equal(profile.library.notes, seeded.counts.notes);
  const document = JSON.parse(
    await readFile(join(cache, "topics", "exports", "verify-report", "export.json"), "utf8")
  ) as { audit: { items: number; reachability: number; violations: { hardCount: number } } };
  assert.equal(profile.shape.items, document.audit.items);
  assert.equal(
    profile.targets.find((t) => t.name === "Reachability")?.value,
    Math.round(document.audit.reachability * 1e6) / 1e6
  );
  assert.equal(
    profile.targets.find((t) => t.name === "Hard violations")?.value,
    document.audit.violations.hardCount
  );
  step(
    `report in ${reportMs} ms: ${profile.shape.items} items, ${profile.shape.topics} topics, ` +
      `reachability ${profile.shape.reachability}, E1/E2 verdicts ` +
      profile.targets
        .filter((t) => t.gating)
        .map((t) => `${t.id} ${t.status}`)
        .join(", ")
  );

  const fresh = profile.fresh;
  assert.ok(fresh, "the fresh build ran");
  assert.equal(fresh.rows, seeded.counts.vectors);
  assert.equal(fresh.fresh.shape.items, seeded.counts.vectors);
  assert.equal(fresh.fresh.shape.reachability, 1);
  assert.equal(fresh.fresh.shape.hardViolations, 0);
  assert.equal(fresh.identical, false, "a seeded tree is not a Louvain build");
  step(
    `fresh build of ${fresh.rows} vectors in ${fresh.buildMs} ms: ${fresh.fresh.shape.topics} topics, ` +
      `depth ${fresh.fresh.shape.depthMean}; app ${fresh.app.shape.topics} topics; ` +
      `leaf NMI ${fresh.agreement.leafNmi}`
  );

  assert.ok(profile.samples.length > 0);
  for (const sample of profile.samples) {
    assert.equal(sample.members.length, Math.min(defaultReportOptions.members, sample.notes));
    assert.ok(sample.members.every((member) => member.title.length > 0));
  }
  step(`${profile.samples.length} sampled topics with their central members`);

  ComparisonDocumentSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
  const html = await readFile(result.htmlPath, "utf8");
  assert.ok(!html.includes(connection.connectionString) && !html.includes(password));
  assert.ok(!/<script/u.test(html));
  step(
    `the page is ${(html.length / 1024).toFixed(0)} KiB, script-free and holds no connection string`
  );

  // The CLI from the cache, as the orchestrator will run it.
  const { stdout } = await execFileAsync(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [
      join(repoRoot, "scripts", "topics", "report.ts"),
      "--cache",
      cache,
      "--export",
      "verify-report",
      "--no-fresh",
      "--out",
      join(workDir, "cli.html")
    ],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
  );
  assert.match(stdout, /verify-report: E1 /u);
  assert.ok((await readFile(join(workDir, "cli.html"), "utf8")).includes("Topic tree comparison"));
  assert.ok(
    (await readFile(join(workDir, "cli.json"), "utf8")).includes('"schema": "topics-compare/v1"')
  );
  step("the CLI reports from the cache without the fresh build");
  console.log("TOPICS_REPORT_VERIFY ok");
} catch (error) {
  console.error("TOPICS_REPORT_VERIFY failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await manager.stop().catch(() => undefined);
  if (process.env.MEMORA_VERIFY_KEEP === "1") console.log(`kept ${workDir}`);
  else await rm(workDir, { recursive: true, force: true });
}
