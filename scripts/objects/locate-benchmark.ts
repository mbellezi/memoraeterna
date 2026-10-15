import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import { ObjectLocateResultSchema } from "@app/domain";
import {
  createObjectLocateRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";

import { resolveConnection } from "../kpi/connection.js";
import { librarySeedSteps, seedTopicTree } from "./synthetic-library.js";

/**
 * Latency of `objects.locate` (F1b exit and F2 T27: p95 <= 50 ms, with the topic path in front of
 * the source chain). Measures the read-only locate repository (the same statement and Zod
 * validation the desktop service runs) against
 *
 *   --db <connection.json | postgres url>   an existing database, read-only: a restored backup or
 *                                           a profile's cluster with an active topic tree (ENV-C),
 *                                           or
 *   --seed                                  a throwaway PostgreSQL sidecar migrated from scratch
 *                                           and filled with DS-S: a synthetic library and a seeded
 *                                           topic tree written through `topicTreeRepository`.
 *
 * The time includes the database round trip on loopback and the result validation, and excludes the
 * Electron IPC hop (about a millisecond). Nothing is written to a `--db` database. The run also
 * reports how many of the located objects have a topic path, and fails when the database holds an
 * active tree but none of them has one (the placement lookup would be reading nothing), or when a
 * sequential scan of `topic_placements`, `atomic_notes` or `chunks` appears in a sampled plan.
 */
const usage = `Usage: npx tsx scripts/objects/locate-benchmark.ts (--db <connection.json | url> | --seed) [options]

  --db <value>         Scratch connection file or postgres:// URL; opened read-only.
  --seed               Seed a throwaway sidecar database with DS-S instead.
  --books <n>          (--seed) root books; each has 3 chapters x 2 sections (default 300 = 3,000 sources).
  --notes <n>          (--seed) atomic notes (default 30000).
  --topics <n>         (--seed) topics of the tree, the root included (default 2500).
  --sample <n>         Random sources and notes measured per kind (default 300), plus the heaviest ones.
  --rounds <n>         Passes over the sample after one warm-up pass (default 5).
  --target-ms <n>      p95 target; the exit code is 1 above it (default 50).
  --json <file>        Also write the measurements as JSON.
  --help               Show this text.`;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    seed: { type: "boolean" },
    books: { type: "string" },
    notes: { type: "string" },
    topics: { type: "string" },
    sample: { type: "string" },
    rounds: { type: "string" },
    "target-ms": { type: "string" },
    json: { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true,
  allowPositionals: false
});
if (values.help) {
  console.info(usage);
  process.exit(0);
}
if (Boolean(values.db) === Boolean(values.seed)) {
  console.error(`Pass exactly one of --db and --seed.\n\n${usage}`);
  process.exit(2);
}
const integer = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`--${name} must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
};
const books = integer(values.books, 300, "books");
const noteTotal = integer(values.notes, 30_000, "notes");
const topicTotal = integer(values.topics, 2_500, "topics");
const sampleSize = integer(values.sample, 300, "sample");
const rounds = integer(values.rounds, 5, "rounds");
const targetMs = integer(values["target-ms"], 50, "target-ms");

function log(message: string): void {
  console.error(`[locate-benchmark] ${message}`);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

interface Sample {
  readonly kind: "source" | "note";
  readonly id: string;
}

async function ids(client: pg.Pool, sql: string, values: unknown[] = []): Promise<string[]> {
  return (await client.query<{ id: string }>(sql, values)).rows.map((row) => row.id);
}

async function collectSamples(client: pg.Pool): Promise<Sample[]> {
  const sources = new Set<string>();
  const notes = new Set<string>();
  const add = (target: Set<string>, list: string[]) => list.forEach((id) => target.add(id));
  add(
    sources,
    await ids(client, "select id from source_items order by random() limit $1", [sampleSize])
  );
  add(
    notes,
    await ids(client, "select id from atomic_notes order by random() limit $1", [sampleSize])
  );
  // The heaviest objects: the sources with the most linked notes and the most retained evidence.
  add(
    sources,
    await ids(
      client,
      "select source_item_id as id from atomic_note_source_links group by source_item_id order by count(*) desc limit 20"
    )
  );
  add(
    sources,
    await ids(
      client,
      "select source_id as id from atomic_note_evidence group by source_id order by count(*) desc limit 20"
    )
  );
  // The tree's own extremes: root sources and notes placed, notes with secondary placements and
  // the items of the deepest and of the fullest topics.
  const active = "p.tree_id = (select id from topic_trees where status = 'active')";
  add(
    sources,
    await ids(
      client,
      `select p.source_item_id as id from topic_placements p
        where ${active} and p.source_item_id is not null order by random() limit 20`
    )
  );
  add(
    notes,
    await ids(
      client,
      `select p.note_id as id from topic_placements p
        where ${active} and p.rank > 0 and p.note_id is not null order by random() limit 20`
    )
  );
  add(
    notes,
    await ids(
      client,
      `with recursive depth(id, level) as (
         select t.id, 0 from topics t where t.role = 'root' and t.retired_at is null
         union all
         select c.id, depth.level + 1 from depth join topics c on c.parent_id = depth.id
          where c.retired_at is null)
       select p.note_id as id from topic_placements p join depth on depth.id = p.topic_id
        where ${active} and p.rank = 0 and p.note_id is not null
        order by depth.level desc, p.id limit 20`
    )
  );
  add(
    notes,
    await ids(
      client,
      `select p.note_id as id from topic_placements p
        where ${active} and p.rank = 0 and p.note_id is not null
          and p.topic_id = (select q.topic_id from topic_placements q
                              where q.tree_id = p.tree_id and q.rank = 0
                              group by q.topic_id order by count(*) desc, q.topic_id limit 1)
        limit 20`
    )
  );
  return [
    ...[...sources].map((id): Sample => ({ kind: "source", id })),
    ...[...notes].map((id): Sample => ({ kind: "note", id }))
  ];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
}

function scans(node: PlanNode, found: string[] = []): string[] {
  if (node["Relation Name"]) {
    const index = node["Index Name"] ? ` using ${node["Index Name"]}` : "";
    found.push(`${node["Node Type"]} on ${node["Relation Name"]}${index}`);
  }
  for (const child of node.Plans ?? []) scans(child, found);
  return found;
}

async function scanSummary(client: pg.Pool, statement: string, id: string): Promise<string[]> {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `explain (analyze, format json) ${statement}`,
    [id, 25, 31]
  );
  const counts = new Map<string, number>();
  for (const line of scans(result.rows[0]!["QUERY PLAN"][0]!.Plan))
    counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, count]) => (count > 1 ? `${line} x${count}` : line)).sort();
}

/** Large tables a locate must reach through an index, never by reading them whole. */
const guardedRelations = new Set(["topic_placements", "atomic_notes", "chunks"]);

function sequentialRelations(node: PlanNode, found: Set<string> = new Set()): Set<string> {
  if (
    node["Node Type"] === "Seq Scan" &&
    node["Relation Name"] &&
    guardedRelations.has(node["Relation Name"])
  )
    found.add(node["Relation Name"]);
  for (const child of node.Plans ?? []) sequentialRelations(child, found);
  return found;
}

async function sequentialScans(client: pg.Pool, statement: string, id: string): Promise<string[]> {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `explain (format json) ${statement}`,
    [id, 25, 31]
  );
  return [...sequentialRelations(result.rows[0]!["QUERY PLAN"][0]!.Plan)];
}

const startedAt = Date.now();
let manager: PostgresSidecarManager | null = null;
let workDir: string | null = null;
let pool: pg.Pool | null = null;
try {
  let connectionString: string;
  let origin: string;
  if (values.db) {
    const connection = await resolveConnection(values.db);
    connectionString = connection.connectionString;
    origin = `${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`;
    pool = new pg.Pool({
      connectionString,
      max: 1,
      options: "-c default_transaction_read_only=on -c statement_timeout=60000"
    });
  } else {
    workDir = await mkdtemp(join(tmpdir(), "memora-locate-benchmark-"));
    const repoRoot = resolve(import.meta.dirname, "../..");
    const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_locate_benchmark",
      user: "memora_locate_benchmark",
      password: `benchmark-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const started = await manager.start();
    connectionString = started.connectionString;
    origin = "throwaway sidecar";
    pool = new pg.Pool({ connectionString, max: 2 });
    log("migrating");
    await runMigrations(pool, resolve(repoRoot, "packages/db/drizzle"));
    log(`seeding ${books * 10} sources and ${noteTotal} notes`);
    const seedClient = await pool.connect();
    try {
      // No legacy wiki pages: the wiki is wiped (D37) and locate no longer reads its tables.
      for (const step of librarySeedSteps(books, noteTotal, 0)) await seedClient.query(step);
    } finally {
      seedClient.release();
    }
    log(`seeding a topic tree of about ${topicTotal} topics`);
    const seeded = await seedTopicTree(pool, { topics: topicTotal });
    log(
      `tree: ${1 + seeded.areaIds.length + seeded.subtopicIds.length + seeded.leafIds.length} topics, ` +
        `${seeded.placedItems} items, generation ${seeded.generation}`
    );
  }

  const hasTree =
    (
      await pool.query(
        "select 1 from topic_trees t join topic_placements p on p.tree_id = t.id where t.status = 'active' limit 1"
      )
    ).rowCount === 1;
  const library = (
    await pool.query<Record<string, string>>(
      `select (select count(*) from source_items)::text as sources,
              (select count(*) from chunks)::text as chunks,
              (select count(*) from atomic_notes)::text as notes,
              (select count(*) from atomic_note_source_links)::text as links,
              (select count(*) from topics t join topic_trees tree on tree.id = t.tree_id
                where tree.status = 'active' and t.retired_at is null)::text as topics,
              (select count(*) from topic_placements p join topic_trees tree on tree.id = p.tree_id
                where tree.status = 'active')::text as placements`
    )
  ).rows[0]!;
  log(`library: ${JSON.stringify(library)}`);

  const repository = createObjectLocateRepository(pool);
  const samples = await collectSamples(pool);
  if (samples.length === 0) throw new Error("The database holds no source or note to measure.");
  const shape = { placed: 0, alsoIn: 0, topicSteps: 0, longestTopicPath: 0, located: 0 };
  let measuring = false;
  const measure = async (sample: Sample): Promise<number> => {
    const start = performance.now();
    const result =
      sample.kind === "source"
        ? await repository.locateSource(sample.id)
        : await repository.locateNote(sample.id);
    ObjectLocateResultSchema.parse(result);
    const elapsed = performance.now() - start;
    if (measuring && result) {
      const topicPath = result.primaryPath.filter((segment) => segment.kind === "topic").length;
      shape.located += 1;
      shape.placed += topicPath > 0 ? 1 : 0;
      shape.alsoIn += result.alsoIn.length > 0 ? 1 : 0;
      shape.topicSteps += topicPath;
      shape.longestTopicPath = Math.max(shape.longestTopicPath, topicPath);
    }
    return elapsed;
  };

  for (const sample of samples) await measure(sample); // warm-up: caches and plans
  measuring = true;
  const byKind = { source: [] as number[], note: [] as number[] };
  const slowest = { ms: 0, sample: samples[0]! };
  for (let round = 0; round < rounds; round += 1) {
    for (const sample of samples) {
      const ms = await measure(sample);
      byKind[sample.kind].push(ms);
      if (ms > slowest.ms) {
        slowest.ms = ms;
        slowest.sample = sample;
      }
    }
  }
  const summarize = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? Number.NaN
    };
  };
  const all = summarize([...byKind.source, ...byKind.note]);
  // Plans under the planner's own choices for the objects sampled (the first 40 of each kind).
  const sequential = new Map<string, number>();
  for (const sample of samples.filter((s) => s.kind === "source").slice(0, 40))
    for (const relation of await sequentialScans(pool, repository.statements.source, sample.id))
      sequential.set(`source: ${relation}`, (sequential.get(`source: ${relation}`) ?? 0) + 1);
  for (const sample of samples.filter((s) => s.kind === "note").slice(0, 40))
    for (const relation of await sequentialScans(pool, repository.statements.note, sample.id))
      sequential.set(`note: ${relation}`, (sequential.get(`note: ${relation}`) ?? 0) + 1);
  const report = {
    origin,
    library,
    sampledObjects: {
      sources: samples.filter((s) => s.kind === "source").length,
      notes: samples.filter((s) => s.kind === "note").length
    },
    rounds,
    targetMs,
    source: summarize(byKind.source),
    note: summarize(byKind.note),
    overall: all,
    topicPaths: {
      located: shape.located,
      withTopicPath: shape.placed,
      withAlsoIn: shape.alsoIn,
      meanTopicPathLength: shape.placed > 0 ? shape.topicSteps / shape.placed : 0,
      longestTopicPath: shape.longestTopicPath
    },
    sequentialScans: Object.fromEntries(sequential),
    passed: all.p95 <= targetMs && (!hasTree || shape.placed > 0) && sequential.size === 0,
    slowestPlan: {
      kind: slowest.sample.kind,
      ms: slowest.ms,
      scans: await scanSummary(
        pool,
        slowest.sample.kind === "source"
          ? repository.statements.source
          : repository.statements.note,
        slowest.sample.id
      )
    },
    wallSeconds: Math.round((Date.now() - startedAt) / 1000)
  };

  const fixed = (value: number) => (Number.isNaN(value) ? "n/a" : value.toFixed(2));
  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.count} | ${fixed(s.p50)} | ${fixed(s.p95)} | ${fixed(s.p99)} | ${fixed(s.max)} |`;
  console.info(
    [
      `objects.locate latency (ms) on ${origin}`,
      `library: ${Object.entries(library)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
      "",
      "| Kind | Calls | p50 | p95 | p99 | max |",
      "| --- | --- | --- | --- | --- | --- |",
      row("source", report.source),
      row("note", report.note),
      row("all", report.overall),
      "",
      `Topic paths: ${report.topicPaths.withTopicPath} of ${report.topicPaths.located} located objects have one (mean ${report.topicPaths.meanTopicPathLength.toFixed(2)} topics, longest ${report.topicPaths.longestTopicPath}); ${report.topicPaths.withAlsoIn} have secondary placements`,
      sequential.size === 0
        ? "No sequential scan of topic_placements, atomic_notes or chunks in the sampled plans"
        : `Sequential scans of large tables: ${[...sequential].map(([line, n]) => `${line} (${n})`).join(", ")}`,
      `Target p95 <= ${targetMs} ms: ${report.passed ? "PASS" : "FAIL"} (${fixed(all.p95)} ms)`,
      `Slowest call: ${report.slowestPlan.kind}, ${fixed(report.slowestPlan.ms)} ms; scans in its plan:`,
      ...report.slowestPlan.scans.map((line) => `  - ${line}`)
    ].join("\n")
  );
  if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  if (manager) await manager.stop().catch(() => undefined);
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
