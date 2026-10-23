import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import {
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicReadDefaults,
  topicReadSql
} from "@app/db";

import { TopicReadService } from "../../apps/desktop/src/main/services/topic-tree/topic-read-service.ts";
import { resolveConnection } from "../kpi/connection.js";
import {
  librarySeedSteps,
  noteRelationSeedSteps,
  seedTopicTree
} from "../objects/synthetic-library.js";

/**
 * Latency of the topic reads (F2 T16 proof: `topics.tree` p95 <= 20 ms, `topics.page` p95 <= 50 ms,
 * `topics.shape` with 2,000 cells p95 <= 100 ms) and the plans of their statements. It measures
 * the read service (the statements, the cursors and the validation of every answer), against
 *
 *   --db <connection.json | postgres url>   an existing database, read-only: a restored backup or
 *                                           a profile's cluster with an active topic tree, or
 *   --seed                                  a throwaway PostgreSQL sidecar migrated from scratch and
 *                                           filled with DS-S: a synthetic library (30,000 notes,
 *                                           relations, hub notes) and a seeded tree of about 2,500
 *                                           topics, written through `topicTreeRepository`.
 *
 * The time includes the database round trip on loopback and excludes the Electron IPC hop (about a
 * millisecond). Nothing is written to a `--db` database. The plans run under the planner's own
 * choices, so a sequential scan of `topic_placements`, `atomic_notes` or `atomic_note_relations`
 * in any of them fails the run.
 */
const usage = `Usage: npx tsx scripts/topics/read-benchmark.ts (--db <connection.json | url> | --seed) [options]

  --db <value>         Scratch connection file or postgres:// URL; opened read-only.
  --seed               Seed a throwaway sidecar database with DS-S instead.
  --books <n>          (--seed) root books; each has 3 chapters x 2 sections (default 300 = 3,000 sources).
  --notes <n>          (--seed) atomic notes (default 30000).
  --topics <n>         (--seed) topics of the tree, the root included (default 2500).
  --sample <n>         Topics measured per endpoint (default 200), plus the heaviest ones.
  --rounds <n>         Passes over the sample after one warm-up pass (default 3).
  --tree-ms <n>        topics.tree p95 bar (default 20).
  --page-ms <n>        topics.page p95 bar (default 50).
  --shape-ms <n>       topics.shape p95 bar (default 100).
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
    "tree-ms": { type: "string" },
    "page-ms": { type: "string" },
    "shape-ms": { type: "string" },
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
const sampleSize = integer(values.sample, 200, "sample");
const rounds = integer(values.rounds, 3, "rounds");
const bars = {
  tree: integer(values["tree-ms"], 20, "tree-ms"),
  page: integer(values["page-ms"], 50, "page-ms"),
  shape: integer(values["shape-ms"], 100, "shape-ms")
};

const log = (message: string): void => console.error(`[read-benchmark] ${message}`);

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

function summarize(list: readonly number[]) {
  const sorted = [...list].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? Number.NaN
  };
}
type Summary = ReturnType<typeof summarize>;

async function ids(client: pg.Pool, sql: string, params: unknown[] = []): Promise<string[]> {
  return (await client.query<{ id: string }>(sql, params)).rows.map((row) => row.id);
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Total Time"?: number;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
}

function scans(
  node: PlanNode,
  found: Array<{ type: string; relation: string; index: string | null }> = []
) {
  if (node["Relation Name"]) {
    found.push({
      type: node["Node Type"],
      relation: node["Relation Name"],
      index: node["Index Name"] ?? null
    });
  }
  for (const child of node.Plans ?? []) scans(child, found);
  return found;
}

const startedAt = Date.now();
let manager: PostgresSidecarManager | null = null;
let workDir: string | null = null;
let pool: pg.Pool | null = null;
try {
  let origin: string;
  if (values.db) {
    const connection = await resolveConnection(values.db);
    origin = `${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`;
    pool = new pg.Pool({
      connectionString: connection.connectionString,
      max: 4,
      options: "-c default_transaction_read_only=on -c statement_timeout=60000"
    });
  } else {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-read-benchmark-"));
    const repoRoot = resolve(import.meta.dirname, "../..");
    const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_topic_read_benchmark",
      user: "memora_topic_read_benchmark",
      password: `benchmark-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const started = await manager.start();
    origin = "throwaway sidecar";
    pool = new pg.Pool({ connectionString: started.connectionString, max: 4 });
    log("migrating");
    await runMigrations(pool, resolve(repoRoot, "packages/db/drizzle"));
    log(`seeding ${books * 10} sources and ${noteTotal} notes`);
    const seedClient = await pool.connect();
    try {
      for (const step of [
        ...librarySeedSteps(books, noteTotal),
        ...noteRelationSeedSteps({ relationsPerNote: 6, hubNotes: 20, hubRelations: 400 })
      ])
        await seedClient.query(step);
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

  const tree = (
    await pool.query<{ id: string; generation: string; rootId: string }>(
      `select t.id, t.generation::text as generation, r.id as "rootId"
         from topic_trees t join topics r on r.tree_id = t.id and r.role = 'root' and r.retired_at is null
        where t.status = 'active'`
    )
  ).rows[0];
  if (!tree) throw new Error("The database holds no active topic tree to measure.");
  const library = (
    await pool.query<Record<string, string>>(
      `select (select count(*) from atomic_notes)::text as notes,
              (select count(*) from atomic_note_relations)::text as relations,
              (select count(*) from topics where tree_id = $1 and retired_at is null)::text as topics,
              (select count(*) from topic_placements where tree_id = $1)::text as placements,
              (select count(*) from topic_change_sets where tree_id = $1)::text as "changeSets"`,
      [tree.id]
    )
  ).rows[0]!;
  log(`library: ${JSON.stringify(library)}`);

  const areas = await ids(
    pool,
    `select id from topics where tree_id = $1 and parent_id = $2 and retired_at is null order by position, id`,
    [tree.id, tree.rootId]
  );
  const live = `t.tree_id = $1 and t.retired_at is null and t.role = 'topic'`;
  const leaves = await ids(
    pool,
    `select t.id from topics t where ${live}
        and not exists (select 1 from topics c where c.parent_id = t.id and c.retired_at is null)
      order by random() limit $2`,
    [tree.id, sampleSize]
  );
  const subtopics = await ids(
    pool,
    `select t.id from topics t where ${live}
        and exists (select 1 from topics c where c.parent_id = t.id and c.retired_at is null)
        and t.parent_id <> $2
      order by random() limit $3`,
    [tree.id, tree.rootId, Math.max(20, Math.floor(sampleSize / 2))]
  );
  // The heaviest: the leaves with the most direct items, and the ones holding the notes with the most relations.
  const biggest = await ids(
    pool,
    `select t.id from topics t join topic_stats s on s.topic_id = t.id
      where ${live} order by s.direct_items desc, t.id limit 20`,
    [tree.id]
  );
  const hubs = await ids(
    pool,
    `select distinct p.topic_id as id from topic_placements p
      where p.tree_id = $1 and p.rank = 0 and p.note_id in (
        select r.source_atomic_note_id from atomic_note_relations r
         group by r.source_atomic_note_id order by count(*) desc limit 20)`,
    [tree.id]
  );
  const changeSets = await ids(
    pool,
    `select id from topic_change_sets where tree_id = $1 order by created_at desc, id limit 30`,
    [tree.id]
  );
  const largest = (
    await pool.query<{ id: string }>(
      `select id from topic_change_sets where tree_id = $1
        order by (select count(*) from topic_structure_events e where e.change_set_id = topic_change_sets.id) desc
        limit 1`,
      [tree.id]
    )
  ).rows.map((row) => row.id);
  const unique = (list: string[]) => [...new Set(list)];
  const pageTargets = unique([tree.rootId, ...areas, ...subtopics, ...leaves, ...biggest, ...hubs]);
  const treeTargets = unique([tree.rootId, ...areas, ...subtopics, ...leaves, ...biggest]);
  log(
    `sample: ${treeTargets.length} topics for tree, ${pageTargets.length} for page ` +
      `(${areas.length} areas, ${subtopics.length} subtopics, ${leaves.length} leaves, ${hubs.length} hub topics)`
  );

  const service = new TopicReadService({ getPool: () => pool });
  const kindOf = new Map<string, string>();
  for (const [kind, list] of [
    ["leaf", leaves],
    ["subtopic", subtopics],
    ["biggest leaf", biggest],
    ["hub topic", hubs],
    ["area", areas],
    ["root", [tree.rootId]]
  ] as const) {
    for (const id of list) kindOf.set(id, kind);
  }
  interface Call {
    label: string;
    run: () => Promise<unknown>;
  }
  const over = (list: string[], run: (id: string) => Promise<unknown>): Call[] =>
    list.map((id) => ({ label: kindOf.get(id) ?? "topic", run: () => run(id) }));
  const calls: Record<string, Call[]> = {
    "topics.tree (children and 5 leaves)": [
      {
        label: "root",
        run: () => service.tree({ parentId: null, includeItems: true })
      },
      ...over(treeTargets, (id) => service.tree({ parentId: id, includeItems: true, itemLimit: 5 }))
    ],
    "topics.page": over(pageTargets, (id) => service.page({ id })),
    "topics.shape (2,000 cells)": [
      {
        label: "tree, depth 5",
        run: () => service.shape({ rootId: null, depth: 5, nodeLimit: 2000 })
      },
      {
        label: "tree, depth 4",
        run: () => service.shape({ rootId: null, depth: 4, nodeLimit: 2000 })
      },
      ...areas.slice(0, 5).map((id) => ({
        label: "branch",
        run: () => service.shape({ rootId: id, depth: 5, nodeLimit: 2000 })
      }))
    ],
    "topics.notes (first page)": [
      ...over(leaves.slice(0, 100), (id) => service.notes({ id })),
      ...over(areas, (id) => service.notes({ id, scope: "subtree", kind: "note" }))
    ],
    "topics.path": over(pageTargets, (id) => service.path({ id })),
    "topics.changeSets.get": [...changeSets, ...largest].map((id) => ({
      label: largest.includes(id) ? "largest" : "recent",
      run: () => service.changeSet({ id })
    })),
    "topics.status": [{ label: "status", run: () => service.status() }]
  };
  const timings: Record<string, Summary> = {};
  const byKind: Record<string, Record<string, Summary>> = {};
  for (const [name, list] of Object.entries(calls)) {
    for (const call of list) await call.run(); // warm-up: caches and plans
    const times: number[] = [];
    const labelled = new Map<string, number[]>();
    for (let round = 0; round < rounds; round += 1) {
      for (const call of list) {
        const start = performance.now();
        await call.run();
        const ms = performance.now() - start;
        times.push(ms);
        labelled.set(call.label, [...(labelled.get(call.label) ?? []), ms]);
      }
    }
    timings[name] = summarize(times);
    byKind[name] = Object.fromEntries(
      [...labelled].map(([label, list]) => [label, summarize(list)])
    );
  }

  // Plans: every statement, with parameters taken from the sample, under the planner's own choices.
  const area = areas[0]!;
  const leaf = leaves[0]!;
  const subtree = (
    await pool.query<{ id: string }>(topicReadSql.subtree, [tree.id, area])
  ).rows.map((row) => row.id);
  const someNotes = await ids(
    pool,
    `select p.note_id as id from topic_placements p where p.topic_id = $1 and p.item_kind = 'note' limit 6`,
    [leaf]
  );
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const relationParams = (topics: string[], treeId: string, perTopic: number): unknown[] => [
    topics,
    topicReadDefaults.relationNotes,
    topicReadDefaults.relationsPerNote,
    treeId,
    topicReadDefaults.relatedLeaves,
    perTopic
  ];
  const statements: Array<[string, string, unknown[]]> = [
    ["children", topicReadSql.children, [tree.id, tree.rootId, null, null, 101]],
    ["nodes (root children)", topicReadSql.nodes, [tree.id, [tree.rootId, ...areas], since]],
    ["nodes (leaf)", topicReadSql.nodes, [tree.id, [leaf], since]],
    ["counts (area)", topicReadSql.counts, [subtree]],
    ["sources (area)", topicReadSql.sources, [subtree, 300, 300, 20]],
    ["direct central notes", topicReadSql.directCentral, [leaf, 6]],
    ["representatives", topicReadSql.representatives, [tree.id, subtopics.slice(0, 6)]],
    ["central notes", topicReadSql.centralNotes, [someNotes, 300, tree.id, 400]],
    ["relations (area)", topicReadSql.relations, relationParams(subtree, tree.id, 5)],
    ["relations (leaf)", topicReadSql.relations, relationParams([leaf], tree.id, 100)],
    ["last change", topicReadSql.lastChange, [tree.id, leaf]],
    ["blocked", topicReadSql.blocked, [tree.id, changeSets.slice(0, 20)]],
    ["changed today", topicReadSql.changedToday, [tree.id, new Date(Date.now() - 864e5), 20]],
    ["pending", topicReadSql.pending, [tree.id, 50]],
    ["topology (shape, ancestry)", topicReadSql.topology, [tree.id]],
    ["violations", topicReadSql.violations, [tree.id, 5000]],
    ["recent placements", topicReadSql.recent, [tree.id, since]],
    ["flagged placements", topicReadSql.flagged, [tree.id]]
  ];
  const guarded = new Set(["topic_placements", "atomic_notes", "atomic_note_relations"]);
  const plans: Array<{
    statement: string;
    ms: number;
    scans: string[];
    sequentialOnGuarded: string[];
  }> = [];
  for (const [name, statement, params] of statements) {
    const result = await pool.query<{
      "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number }>;
    }>(`explain (analyze, format json) ${statement}`, params);
    const plan = result.rows[0]!["QUERY PLAN"][0]!;
    const found = scans(plan.Plan);
    const counted = new Map<string, number>();
    for (const scan of found) {
      const line = `${scan.type} on ${scan.relation}${scan.index ? ` using ${scan.index}` : ""}`;
      counted.set(line, (counted.get(line) ?? 0) + 1);
    }
    plans.push({
      statement: name,
      ms: plan["Execution Time"],
      scans: [...counted].map(([line, n]) => (n > 1 ? `${line} x${n}` : line)).sort(),
      sequentialOnGuarded: [
        ...new Set(
          found
            .filter((scan) => scan.type === "Seq Scan" && guarded.has(scan.relation))
            .map((scan) => scan.relation)
        )
      ]
    });
  }

  const fixed = (value: number) => (Number.isNaN(value) ? "n/a" : value.toFixed(2));
  const barOf = (name: string): number | null =>
    name.startsWith("topics.tree")
      ? bars.tree
      : name.startsWith("topics.page")
        ? bars.page
        : name.startsWith("topics.shape")
          ? bars.shape
          : null;
  const verdicts = Object.entries(timings).map(([name, summary]) => {
    const bar = barOf(name);
    return {
      name,
      ...summary,
      bar,
      passed: bar === null || summary.p95 <= bar
    };
  });
  const seqScans = plans.filter((plan) => plan.sequentialOnGuarded.length > 0);
  const report = {
    origin,
    library,
    rounds,
    bars,
    endpoints: verdicts,
    byKind,
    plans,
    passed: verdicts.every((verdict) => verdict.passed) && seqScans.length === 0,
    wallSeconds: Math.round((Date.now() - startedAt) / 1000)
  };

  console.info(
    [
      `topic reads latency (ms) on ${origin}`,
      `library: ${Object.entries(library)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
      "",
      "| Endpoint | Calls | p50 | p95 | p99 | max | Bar (p95) | |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...verdicts.map(
        (verdict) =>
          `| ${verdict.name} | ${verdict.count} | ${fixed(verdict.p50)} | ${fixed(verdict.p95)} | ${fixed(verdict.p99)} | ${fixed(verdict.max)} | ${verdict.bar ?? "-"} | ${verdict.bar === null ? "" : verdict.passed ? "PASS" : "FAIL"} |`
      ),
      "",
      "By kind of topic (p50 / p95 / max, ms):",
      ...Object.entries(byKind)
        .filter(([, kinds]) => Object.keys(kinds).length > 1)
        .flatMap(([name, kinds]) => [
          `${name}:`,
          ...Object.entries(kinds).map(
            ([label, kind]) =>
              `  - ${label}: ${fixed(kind.p50)} / ${fixed(kind.p95)} / ${fixed(kind.max)} (${kind.count} calls)`
          )
        ]),
      "",
      "Plans (planner's own choices):",
      "| Statement | Execution (ms) | Scans |",
      "| --- | --- | --- |",
      ...plans.map(
        (plan) => `| ${plan.statement} | ${fixed(plan.ms)} | ${plan.scans.join("; ")} |`
      ),
      "",
      seqScans.length === 0
        ? "No sequential scan of topic_placements, atomic_notes or atomic_note_relations: PASS"
        : `Sequential scans of guarded tables: FAIL (${seqScans
            .map((plan) => `${plan.statement}: ${plan.sequentialOnGuarded.join(", ")}`)
            .join("; ")})`
    ].join("\n")
  );
  if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  if (manager) await manager.stop().catch(() => undefined);
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
