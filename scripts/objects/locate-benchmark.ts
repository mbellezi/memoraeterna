import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import {
  ObjectBacklinksResultSchema,
  ObjectLocateResultSchema,
  ObjectResolvedSchema,
  type ObjectAddress
} from "@app/domain";
import {
  createObjectLocateRepository,
  createObjectReadRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";

import { resolveConnection } from "../kpi/connection.js";
import {
  assertScratchProfilePath,
  copyMigrationsToTag,
  profilePaths,
  startProfileServer,
  writeProfileCompletionMarker,
  writeProfileConnectionFile,
  type ProfileServer
} from "../lib/profile-server.js";
import { librarySeedSteps, noteRelationSeedSteps, seedTopicTree } from "./synthetic-library.js";

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
 *                                           With `--keep <abs dir>` the cluster is kept, stopped
 *                                           cleanly, in a profile-shaped folder (T169, SEED30K);
 *                                           `--to-migration <tag>` migrates only up to that tag,
 *                                           or
 *   --profile <abs dir>                     a profile-shaped scratch clone under
 *                                           `.cache/f<N>/scratch/` (for example SEED30K), started
 *                                           through `scripts/lib/profile-server.ts` and measured
 *                                           read-only.
 *
 * The same run measures the rest of the objects read layer (F5 T118, D11) on the same database:
 * `resolveMany(200)` (a batch of 200 addresses over notes, sources, topics, entities and questions,
 * a sixth of them anchored to a passage or span, with and without the topics above each object;
 * bar p95 <= 60 ms on both variants, calibrated) and `objects.backlinks` (one page of
 * 50 for sampled sources and notes, reported, with the heaviest objects among them). The backlinks
 * statements are checked for sequential scans of the large tables.
 *
 * The time includes the database round trip on loopback and the result validation, and excludes the
 * Electron IPC hop (about a millisecond). Nothing is written to a `--db` database. The run also
 * reports how many of the located objects have a topic path, and fails when the database holds an
 * active tree but none of them has one (the placement lookup would be reading nothing), or when a
 * sequential scan of `topic_placements`, `atomic_notes` or `chunks` appears in a sampled plan.
 */
const usage = `Usage: npx tsx scripts/objects/locate-benchmark.ts (--db <connection.json | url> | --seed | --profile <abs dir>) [options]

  --db <value>         Scratch connection file or postgres:// URL; opened read-only.
  --seed               Seed a throwaway sidecar database with DS-S instead.
  --keep <abs dir>     (--seed) keep the cluster, stopped, in a profile-shaped folder under
                       <repo>/.cache/f<N>/scratch/ (database/dev-connection.json, never printed).
  --to-migration <tag> (--seed) migrate only up to this journal tag (default: all).
  --profile <abs dir>  Start a scratch server on a profile-shaped clone under
                       <repo>/.cache/f<N>/scratch/ and measure it read-only.
  --books <n>          (--seed) root books; each has 3 chapters x 2 sections (default 300 = 3,000 sources).
  --notes <n>          (--seed) atomic notes (default 30000).
  --relations <n>      (--seed) also seed n relations per note and 20 hub notes of 400 (default 0, none:
                       SEED30K has no relations; this exercises the relation arm of backlinks).
  --topics <n>         (--seed) topics of the tree, the root included (default 2500).
  --sample <n>         Random sources and notes measured per kind (default 300), plus the heaviest ones.
  --rounds <n>         Passes over the sample after one warm-up pass (default 5).
  --target-ms <n>      p95 target of locate; the exit code is 1 above it (default 50).
  --resolve-target-ms <n>  p95 target of resolveMany(200); the exit code is 1 above it (default 60).
  --batches <n>        resolveMany batches of 200 addresses measured per variant (default 40).
  --json <file>        Also write the measurements as JSON.
  --help               Show this text.`;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    seed: { type: "boolean" },
    keep: { type: "string" },
    "to-migration": { type: "string" },
    profile: { type: "string" },
    books: { type: "string" },
    notes: { type: "string" },
    relations: { type: "string" },
    topics: { type: "string" },
    sample: { type: "string" },
    rounds: { type: "string" },
    "target-ms": { type: "string" },
    "resolve-target-ms": { type: "string" },
    batches: { type: "string" },
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
if ([values.db, values.seed, values.profile].filter(Boolean).length !== 1) {
  console.error(`Pass exactly one of --db, --seed and --profile.\n\n${usage}`);
  process.exit(2);
}
if (
  (values.keep !== undefined ||
    values["to-migration"] !== undefined ||
    values.relations !== undefined) &&
  !values.seed
) {
  console.error(`--keep, --to-migration and --relations need --seed.\n\n${usage}`);
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
const relationsPerNote =
  values.relations === undefined ? 0 : integer(values.relations, 0, "relations");
const topicTotal = integer(values.topics, 2_500, "topics");
const sampleSize = integer(values.sample, 300, "sample");
const rounds = integer(values.rounds, 5, "rounds");
const targetMs = integer(values["target-ms"], 50, "target-ms");
const resolveTargetMs = integer(values["resolve-target-ms"], 60, "resolve-target-ms");
const batchCount = integer(values.batches, 40, "batches");

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

/** Large tables a backlinks page must reach through an index, never by reading them whole. */
const backlinkGuardedRelations = new Set([
  ...guardedRelations,
  "atomic_note_source_links",
  "atomic_note_relations"
]);

async function backlinkSequentialScans(
  client: pg.Pool,
  statement: string,
  id: string
): Promise<string[]> {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `explain (format json) ${statement}`,
    [id, -1, "1970-01-01T00:00:00.000000Z", "00000000-0000-0000-0000-000000000000", 51]
  );
  const found = new Set<string>();
  const walk = (node: PlanNode) => {
    if (
      node["Node Type"] === "Seq Scan" &&
      node["Relation Name"] &&
      backlinkGuardedRelations.has(node["Relation Name"])
    )
      found.add(node["Relation Name"]);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(result.rows[0]!["QUERY PLAN"][0]!.Plan);
  return [...found];
}

/** The addresses a resolveMany batch draws from; an empty pool gives its share to the notes. */
interface BatchPools {
  notes: readonly string[];
  sources: readonly string[];
  topics: readonly string[];
  /** Passage and span addresses of notes and sources: the citation chips' previews. */
  anchored: readonly ObjectAddress[];
  entities: readonly string[];
  questions: readonly string[];
}

/** `count` addresses of a batch the way the workspace asks: mostly notes, then sources, topics, anchored addresses, entities and questions. */
function mixedBatch(pools: BatchPools, count: number, offset: number): ObjectAddress[] {
  const shares: Array<[ObjectAddress["kind"] | "anchored", number]> = [
    ["note", 0.35],
    ["source", 0.2],
    ["topic", 0.15],
    ["anchored", 0.15],
    ["entity", 0.075],
    ["question", 0.075]
  ];
  const pick = <T>(list: readonly T[], index: number): T =>
    list[(offset * 37 + index) % list.length]!;
  const batch: ObjectAddress[] = [];
  let kindIndex = 0;
  for (const [kind, share] of shares) {
    const wanted = kind === "note" ? 0 : Math.floor(count * share);
    for (let index = 0; index < wanted; index += 1, kindIndex += 1) {
      if (kind === "anchored" && pools.anchored.length) batch.push(pick(pools.anchored, index));
      else if (kind === "source" && pools.sources.length)
        batch.push({ kind, id: pick(pools.sources, index) });
      else if (kind === "topic" && pools.topics.length)
        batch.push({ kind, id: pick(pools.topics, index) });
      else if (kind === "entity" && pools.entities.length)
        batch.push({ kind, id: pick(pools.entities, index) });
      else if (kind === "question" && pools.questions.length)
        batch.push({ kind, id: pick(pools.questions, index) });
      else batch.push({ kind: "note", id: pick(pools.notes, kindIndex) });
    }
  }
  for (let index = 0; batch.length < count; index += 1)
    batch.push({ kind: "note", id: pick(pools.notes, 1000 + index) });
  return batch;
}

const startedAt = Date.now();
let manager: PostgresSidecarManager | null = null;
let profileServer: ProfileServer | null = null;
let workDir: string | null = null;
let keptDir: string | null = null;
let keptComplete = false;
let migrationsTemp: string | null = null;
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
  } else if (values.profile) {
    const repoRoot = resolve(import.meta.dirname, "../..");
    profileServer = await startProfileServer(values.profile, { repoRoot });
    connectionString = profileServer.connectionString;
    origin = `scratch profile ${basename(profileServer.profileDir)}`;
    pool = new pg.Pool({
      connectionString,
      max: 1,
      options: "-c default_transaction_read_only=on -c statement_timeout=60000"
    });
  } else {
    const repoRoot = resolve(import.meta.dirname, "../..");
    let dataDir: string;
    let database = "memora_locate_benchmark";
    let user = "memora_locate_benchmark";
    if (values.keep) {
      keptDir = await assertScratchProfilePath(values.keep, repoRoot);
      await mkdir(keptDir, { recursive: true });
      if ((await readdir(keptDir)).length > 0)
        throw new Error(`--keep needs an empty or new folder: ${keptDir}`);
      dataDir = profilePaths(keptDir).dataDir;
      database = "memora_app";
      user = "memora_app";
    } else {
      workDir = await mkdtemp(join(tmpdir(), "memora-locate-benchmark-"));
      dataDir = join(workDir, "data");
    }
    const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
    const password = `benchmark-${randomUUID()}`;
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir,
      database,
      user,
      password,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const started = await manager.start();
    connectionString = started.connectionString;
    origin = keptDir ? `kept scratch profile ${basename(keptDir)}` : "throwaway sidecar";
    pool = new pg.Pool({ connectionString, max: 2 });
    if (keptDir)
      await writeProfileConnectionFile(keptDir, {
        host: started.host,
        port: started.port,
        database: started.database,
        user: started.user,
        password
      });
    let migrationsFolder = resolve(repoRoot, "packages/db/drizzle");
    const toMigration = values["to-migration"];
    if (toMigration) {
      migrationsTemp = await mkdtemp(join(tmpdir(), "memora-locate-migrations-"));
      const kept = await copyMigrationsToTag(migrationsFolder, migrationsTemp, toMigration);
      migrationsFolder = migrationsTemp;
      log(`migrating up to ${toMigration} (${kept} migrations)`);
    } else log("migrating");
    await runMigrations(pool, migrationsFolder);
    log(`seeding ${books * 10} sources and ${noteTotal} notes`);
    const seedClient = await pool.connect();
    try {
      for (const step of [
        ...librarySeedSteps(books, noteTotal),
        ...(relationsPerNote > 0
          ? noteRelationSeedSteps({ relationsPerNote, hubNotes: 20, hubRelations: 400 })
          : [])
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
    if (keptDir) {
      await writeProfileCompletionMarker(keptDir, {
        sources: books * 10,
        notes: noteTotal,
        topics: topicTotal,
        placedItems: seeded.placedItems
      });
      keptComplete = true;
    }
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
  // The rest of the objects read layer: resolveMany(200) and backlinks (F5 T118).
  const objects = createObjectReadRepository(pool);
  const sampleNotes = [...new Set(samples.filter((s) => s.kind === "note").map((s) => s.id))];
  const sampleSources = [...new Set(samples.filter((s) => s.kind === "source").map((s) => s.id))];
  const sampleTopics = await ids(
    pool,
    `select t.id from topics t where t.retired_at is null and t.role <> 'root'
      order by random() limit $1`,
    [sampleSize]
  );
  const resolveBatch = async (batch: ObjectAddress[], path: boolean): Promise<number> => {
    const start = performance.now();
    const resolvedBatch = await objects.resolve(batch, { path });
    for (const summary of resolvedBatch.values()) ObjectResolvedSchema.parse(summary);
    return performance.now() - start;
  };
  // The anchored addresses of D11 and D15: a passage of a source, and the evidence passage (or its
  // span) of a note, as the citation chips and hover cards ask for them.
  const anchored: ObjectAddress[] = [];
  const anchorOf = (
    kind: "note" | "source",
    row: { id: string; chunk: string; span: string | null },
    index: number
  ) =>
    anchored.push({
      kind,
      id: row.id,
      anchor: row.span && index % 2 === 1 ? { span: row.span } : { passage: row.chunk }
    });
  (
    await pool.query<{ id: string; chunk: string; span: string | null }>(
      `select n.id, c.id as chunk, c.source_span_id as span
         from atomic_notes n join chunks c on c.id = n.evidence_chunk_id
        where n.id = any($1::uuid[])`,
      [sampleNotes]
    )
  ).rows.forEach((row, index) => anchorOf("note", row, index));
  (
    await pool.query<{ id: string; chunk: string; span: string | null }>(
      `select s.id, c.id as chunk, c.source_span_id as span
         from source_items s
         join lateral (select k.id, k.source_span_id from chunks k
                        where k.source_item_id = s.id order by k.chunk_index limit 1) c on true
        where s.id = any($1::uuid[])`,
      [sampleSources]
    )
  ).rows.forEach((row, index) => anchorOf("source", row, index));
  const pools: BatchPools = {
    notes: sampleNotes,
    sources: sampleSources,
    topics: sampleTopics,
    anchored,
    entities: await ids(pool, "select id from entities order by random() limit $1", [sampleSize]),
    questions: await ids(pool, "select id from questions order by random() limit $1", [sampleSize])
  };
  const batches = Array.from({ length: batchCount }, (_, index) => mixedBatch(pools, 200, index));
  await resolveBatch(batches[0]!, true); // warm-up
  const resolveTimes = { plain: [] as number[], withPath: [] as number[] };
  for (const batch of batches) resolveTimes.plain.push(await resolveBatch(batch, false));
  for (const batch of batches) resolveTimes.withPath.push(await resolveBatch(batch, true));
  const resolved = {
    batchSize: 200,
    plain: summarize(resolveTimes.plain),
    withPath: summarize(resolveTimes.withPath),
    resolvedInFirstBatch: (await objects.resolve(batches[0]!, { path: false })).size,
    mix: {
      anchored: batches[0]!.filter((address) => address.anchor).length,
      entities: batches[0]!.filter((address) => address.kind === "entity").length,
      questions: batches[0]!.filter((address) => address.kind === "question").length
    }
  };

  const heavySources = await ids(
    pool,
    `select source_item_id as id from atomic_note_source_links group by source_item_id
      order by count(*) desc limit 20`
  );
  const heavyNotes = await ids(
    pool,
    `select n.id from (select source_atomic_note_id as id, count(*) as c from atomic_note_relations
                        group by source_atomic_note_id order by count(*) desc limit 20) n`
  );
  const backlinkSamples: ObjectAddress[] = [
    ...[...new Set([...sampleSources, ...heavySources])].map((id): ObjectAddress => ({
      kind: "source",
      id
    })),
    ...[...new Set([...sampleNotes, ...heavyNotes])].map((id): ObjectAddress => ({
      kind: "note",
      id
    }))
  ];
  const backlinkTimes = { source: [] as number[], note: [] as number[] };
  let backlinkItems = 0;
  for (let round = 0; round < rounds + 1; round += 1) {
    for (const target of backlinkSamples) {
      const start = performance.now();
      const page = await objects.backlinks({ target, limit: 50 });
      ObjectBacklinksResultSchema.parse({ items: page.items });
      const elapsed = performance.now() - start;
      if (round === 0) continue; // warm-up
      backlinkItems += page.items.length;
      backlinkTimes[target.kind === "source" ? "source" : "note"].push(elapsed);
    }
  }
  const backlinkScans = new Map<string, number>();
  for (const kind of ["source", "note"] as const) {
    const statement = objects.statements.backlinks(kind);
    if (!statement) continue;
    for (const sample of backlinkSamples.filter((s) => s.kind === kind).slice(0, 40)) {
      for (const relation of await backlinkSequentialScans(pool, statement, sample.id)) {
        const line = `${kind}: ${relation}`;
        backlinkScans.set(line, (backlinkScans.get(line) ?? 0) + 1);
      }
    }
  }
  const backlinkCalls = backlinkTimes.source.length + backlinkTimes.note.length;
  const backlinks = {
    pageSize: 50,
    source: summarize(backlinkTimes.source),
    note: summarize(backlinkTimes.note),
    meanItemsPerPage: backlinkCalls > 0 ? backlinkItems / backlinkCalls : 0,
    sequentialScans: Object.fromEntries(backlinkScans)
  };

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
    resolveTargetMs,
    resolveMany: resolved,
    backlinks,
    passed:
      all.p95 <= targetMs &&
      (!hasTree || shape.placed > 0) &&
      sequential.size === 0 &&
      resolved.plain.p95 <= resolveTargetMs &&
      resolved.withPath.p95 <= resolveTargetMs &&
      backlinkScans.size === 0,
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
      `Target p95 <= ${targetMs} ms: ${all.p95 <= targetMs ? "PASS" : "FAIL"} (${fixed(all.p95)} ms)`,
      "",
      `objects.resolveMany(${resolved.batchSize}) latency (ms), ${batchCount} batches of notes, sources, topics, entities and questions, ${resolved.mix.anchored} anchored (${resolved.resolvedInFirstBatch} resolved, ${resolved.mix.entities} entities and ${resolved.mix.questions} questions in the first)`,
      "| Variant | Calls | p50 | p95 | p99 | max |",
      "| --- | --- | --- | --- | --- | --- |",
      row("without path", resolved.plain),
      row("with path", resolved.withPath),
      `Target p95 <= ${resolveTargetMs} ms (without path, the previews' batch): ${resolved.plain.p95 <= resolveTargetMs ? "PASS" : "FAIL"} (${fixed(resolved.plain.p95)} ms)`,
      `Target p95 <= ${resolveTargetMs} ms (with path, the hover cards' and Cmd-K's batch): ${resolved.withPath.p95 <= resolveTargetMs ? "PASS" : "FAIL"} (${fixed(resolved.withPath.p95)} ms)`,
      "",
      `objects.backlinks latency (ms), one page of ${backlinks.pageSize} (mean ${backlinks.meanItemsPerPage.toFixed(1)} items), reported without a bar`,
      "| Kind | Calls | p50 | p95 | p99 | max |",
      "| --- | --- | --- | --- | --- | --- |",
      row("source", backlinks.source),
      row("note", backlinks.note),
      backlinkScans.size === 0
        ? "No sequential scan of a large table in the sampled backlinks plans"
        : `Sequential scans in backlinks plans: ${[...backlinkScans].map(([line, n]) => `${line} (${n})`).join(", ")}`,
      "",
      `Overall: ${report.passed ? "PASS" : "FAIL"}`,
      `Slowest call: ${report.slowestPlan.kind}, ${fixed(report.slowestPlan.ms)} ms; scans in its plan:`,
      ...report.slowestPlan.scans.map((line) => `  - ${line}`)
    ].join("\n")
  );
  if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  if (manager) await manager.stop().catch(() => undefined);
  if (profileServer) await profileServer.stop().catch(() => undefined);
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (migrationsTemp) await rm(migrationsTemp, { recursive: true, force: true });
  if (keptDir && keptComplete) log(`kept the stopped cluster at ${keptDir}`);
  else if (keptDir)
    log(`the run did not finish: ${keptDir} is incomplete and --profile refuses it; remove it`);
}
