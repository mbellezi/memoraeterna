import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import {
  NotePageSchema,
  ObjectNeighborhoodSchema,
  noteRelationGroups,
  notePageLimits,
  objectLocateListLimit,
  objectNeighborhoodLimits
} from "@app/domain";
import {
  aiConfigGeneration,
  createAiConfigRepository,
  createNotePageRepository,
  createObjectLocateRepository,
  createObjectNeighborhoodRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";

import { NotePageService } from "../../apps/desktop/src/main/services/note-page-service.ts";
import { promptPinGeneration } from "../../apps/desktop/src/main/services/prompt-runtime.ts";
import {
  createRelationExplanationWriterResolver,
  memoizeRelationExplanationWriter
} from "../../apps/desktop/src/main/services/relation-explanation-writer.ts";
import { SettingsService } from "../../apps/desktop/src/main/services/settings-service.ts";
import { resolveConnection } from "../kpi/connection.js";
import { librarySeedSteps, noteRelationSeedSteps } from "./synthetic-library.js";

/**
 * Latency of `notes.page` (target: p95 <= 50 ms for the repository, the `objects.locate` budget;
 * with `--service`, p95 <= 5 ms for the SERVICE call, F3 T60). Measures the read-only note page
 * repository (the same transaction, statements and Zod validation the desktop service runs)
 * against
 *
 *   --db <connection.json | postgres url>   an existing database, read-only: a restored golden
 *                                           backup (`scripts/db/restore-backup.ts`), or
 *   --seed                                  a throwaway PostgreSQL sidecar migrated from scratch
 *                                           and filled with a synthetic library at scale.
 *
 * The time includes the database round trips on loopback and the result validation, and excludes
 * the Electron IPC hop (about a millisecond). Nothing is written to a `--db` database. The heaviest
 * note's statements are explained; a sequential scan of a large table fails the run.
 */
const usage = `Usage: npx tsx scripts/objects/note-page-benchmark.ts (--db <connection.json | url> | --seed) [options]

  --db <value>         Scratch connection file or postgres:// URL; opened read-only.
  --seed               Seed a throwaway sidecar database with a synthetic library instead.
  --books <n>          (--seed) root books; each has 3 chapters x 2 sections (default 300 = 3,000 sources).
  --notes <n>          (--seed) atomic notes (default 30000), 6 relations each plus 20 hubs of 400.
  --pages <n>          (--seed) legacy wiki pages (default 2000).
  --sample <n>         Random notes measured (default 300), plus hubs and the heaviest evidence.
  --rounds <n>         Passes over the sample after one warm-up pass (default 5).
  --target-ms <n>      p95 target; the exit code is 1 above it (default 50).
  --service            Also measure the desktop SERVICE call (language from the stored settings,
                       the writer of explanations, the repository and the Zod parse): the writer
                       resolved on every read, and as the app wires it (once per AI configuration,
                       prompt and database). With --seed an AI route is seeded so the writer
                       resolves; the exit code is 1 when the wired service's p95 is above
                       --service-target-ms.
  --service-target-ms <n>  p95 target of the wired service call (default 5).
  --neighborhood       Also measure objects.neighborhood (the Note page's relation graph, F3 T60g):
                       depth 1 and depth 2 over every sampled note, the hubs included, and explain
                       its statements. The exit code is 1 when a p95 is above its target.
  --neighborhood-d1-ms <n>  p95 target at depth 1 (default 20).
  --neighborhood-d2-ms <n>  p95 target at depth 2 (default 50).
  --json <file>        Also write the measurements as JSON.
  --help               Show this text.`;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    seed: { type: "boolean" },
    books: { type: "string" },
    notes: { type: "string" },
    pages: { type: "string" },
    sample: { type: "string" },
    rounds: { type: "string" },
    "target-ms": { type: "string" },
    service: { type: "boolean" },
    "service-target-ms": { type: "string" },
    neighborhood: { type: "boolean" },
    "neighborhood-d1-ms": { type: "string" },
    "neighborhood-d2-ms": { type: "string" },
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
const pageTotal = integer(values.pages, 2_000, "pages");
const sampleSize = integer(values.sample, 300, "sample");
const rounds = integer(values.rounds, 5, "rounds");
const targetMs = integer(values["target-ms"], 50, "target-ms");
const serviceTargetMs = integer(values["service-target-ms"], 5, "service-target-ms");
const neighborhoodD1Ms = integer(values["neighborhood-d1-ms"], 20, "neighborhood-d1-ms");
const neighborhoodD2Ms = integer(values["neighborhood-d2-ms"], 50, "neighborhood-d2-ms");

function log(message: string): void {
  console.error(`[note-page-benchmark] ${message}`);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

type SampleKind = "random" | "hub" | "evidence" | "retained";
interface Sample {
  readonly kind: SampleKind;
  readonly id: string;
}

async function ids(client: pg.Pool, sql: string, values: unknown[] = []): Promise<string[]> {
  return (await client.query<{ id: string }>(sql, values)).rows.map((row) => row.id);
}

async function collectSamples(client: pg.Pool): Promise<Sample[]> {
  const seen = new Set<string>();
  const samples: Sample[] = [];
  const add = (kind: SampleKind, list: string[]) =>
    list.forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      samples.push({ kind, id });
    });
  // Hubs first, so a hub drawn at random is still measured as a hub.
  add(
    "hub",
    await ids(
      client,
      `select id from (select source_atomic_note_id as id from atomic_note_relations
                      union all select target_atomic_note_id from atomic_note_relations) r
        group by id order by count(*) desc limit 20`
    )
  );
  add(
    "evidence",
    await ids(
      client,
      "select atomic_note_id as id from atomic_note_source_links group by atomic_note_id order by count(*) desc limit 20"
    )
  );
  add(
    "retained",
    await ids(client, "select distinct note_id as id from atomic_note_evidence limit 20")
  );
  add(
    "random",
    await ids(client, "select id from atomic_notes order by random() limit $1", [sampleSize])
  );
  return samples;
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
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

/**
 * Tables whose sequential scan would make a page read grow with the library. A table this small is
 * read faster in one pass than through an index, so the gate starts at `largeTableRows` rows.
 */
const watchedTables = [
  "atomic_note_relations",
  "atomic_note_source_links",
  "chunks",
  "atomic_notes"
];
const largeTableRows = 10_000;

/** The distribution of a list of timings in milliseconds. */
function summary(list: readonly number[]) {
  const sorted = [...list].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? Number.NaN
  };
}

/**
 * Seeds an AI route for the writer of explanations, so the writer resolves to a model and its
 * prompt identity is computed (a library with no route never reaches that hash).
 */
async function seedWriterRoute(client: pg.Pool): Promise<void> {
  const config = createAiConfigRepository(client);
  const provider = await config.upsertProvider({
    provider: "openai-codex",
    displayName: "Benchmark writer",
    metadata: { modelId: "benchmark-writer" }
  });
  const profile = await config.createProfile({ name: "Benchmark", isDefault: true });
  await config.updateProfile({
    id: profile.id,
    providerConfigId: provider.id,
    modelId: "benchmark-writer",
    runtime: "remote",
    capabilities: ["text-generation"]
  });
  await config.setProfileTask({ profileId: profile.id, task: "text-generation" });
}

/**
 * The service call as the desktop app runs it, in three shapes: without a writer, with the writer
 * resolved on every read, and wired as the app does (resolved again only when the AI
 * configuration, the prompts or the database change).
 */
async function measureService(
  client: pg.Pool,
  samples: readonly Sample[],
  workDirectory: string,
  canWrite: boolean
) {
  const settings = canWrite
    ? new SettingsService(workDirectory, { getDatabasePool: () => client, requireDatabase: true })
    : null;
  // The language is read from the stored settings on every page, as the app does.
  if (settings) await settings.getApp();
  const language = async () => (settings ? (await settings.getApp()).contentLanguage : "en");
  if (canWrite) await seedWriterRoute(client);
  const getPool = () => client as never;
  const resolver = createRelationExplanationWriterResolver(getPool);
  const writer = await resolver();
  const memoized = memoizeRelationExplanationWriter(resolver, () => ({
    pool: client,
    configuration: aiConfigGeneration(),
    prompts: promptPinGeneration()
  }));
  const variants = {
    noWriter: new NotePageService(getPool, language),
    perRead: new NotePageService(getPool, language, resolver),
    wired: new NotePageService(getPool, language, memoized)
  };
  const resolveCosts: number[] = [];
  for (let round = 0; round < 200; round += 1) {
    const start = performance.now();
    await resolver();
    resolveCosts.push(performance.now() - start);
  }
  const results: Record<string, number[]> = { noWriter: [], perRead: [], wired: [] };
  for (const [name, service] of Object.entries(variants)) {
    for (const sample of samples) await service.page({ noteId: sample.id }); // warm-up
    for (let round = 0; round < rounds; round += 1)
      for (const sample of samples) {
        const start = performance.now();
        await service.page({ noteId: sample.id });
        results[name]!.push(performance.now() - start);
      }
  }
  return {
    writerResolved: writer !== null,
    languageFromSettings: settings !== null,
    resolveWriter: summary(resolveCosts),
    noWriter: summary(results.noWriter!),
    perRead: summary(results.perRead!),
    wired: summary(results.wired!)
  };
}

/**
 * objects.neighborhood as the desktop service runs it (the repository and the Zod parse) at depth 1
 * and depth 2 for every sampled note, hubs of 400 relations included. The statements of the first
 * hub's depth-2 answer are explained.
 */
async function measureNeighborhood(client: pg.Pool, samples: readonly Sample[]) {
  const repository = createObjectNeighborhoodRepository(client);
  const read = async (objectId: string, depth: 1 | 2) => {
    const start = performance.now();
    const answer = ObjectNeighborhoodSchema.nullable().parse(
      await repository.read({ objectId, depth, limit: objectNeighborhoodLimits.nodes })
    );
    return { ms: performance.now() - start, answer };
  };
  const shapes = { nodes: 0, edges: 0, suggested: 0, truncated: 0, reads: 0 };
  const result: Record<"d1" | "d2", Map<SampleKind, number[]>> = {
    d1: new Map(),
    d2: new Map()
  };
  for (const depth of [1, 2] as const) for (const sample of samples) await read(sample.id, depth); // warm-up
  for (let round = 0; round < rounds; round += 1)
    for (const depth of [1, 2] as const)
      for (const sample of samples) {
        const { ms, answer } = await read(sample.id, depth);
        const bucket = result[depth === 1 ? "d1" : "d2"];
        bucket.set(sample.kind, [...(bucket.get(sample.kind) ?? []), ms]);
        if (depth === 2 && round === 0 && answer) {
          shapes.reads += 1;
          shapes.nodes += answer.nodes.length;
          shapes.edges += answer.edges.length;
          shapes.suggested += answer.edges.filter((edge) => edge.state === "suggested").length;
          shapes.truncated += answer.truncated ? 1 : 0;
        }
      }
  const hub = samples.find((sample) => sample.kind === "hub") ?? samples[0]!;
  const heaviest = (await read(hub.id, 2)).answer!;
  const depthOne = heaviest.nodes.filter((node) => node.depth === 1).map((node) => node.id);
  const plans = {
    neighbourhoodNeighbours: await plan(client, repository.statements.neighbours, [
      hub.id,
      objectNeighborhoodLimits.nodes - 1
    ]),
    neighbourhoodSecondRing: await plan(client, repository.statements.secondRing, [
      hub.id,
      depthOne.slice(0, objectNeighborhoodLimits.seeds),
      objectNeighborhoodLimits.seedPool,
      objectNeighborhoodLimits.perSeed
    ]),
    neighbourhoodEdges: await plan(client, repository.statements.edges, [
      heaviest.nodes.map((node) => node.id)
    ])
  };
  const flat = (bucket: Map<SampleKind, number[]>) => [...bucket.values()].flat();
  return {
    d1: { overall: summary(flat(result.d1)), byKind: summarizeKinds(result.d1) },
    d2: { overall: summary(flat(result.d2)), byKind: summarizeKinds(result.d2) },
    // What a depth-2 answer holds on the first round, over the sampled notes.
    shapes: {
      reads: shapes.reads,
      meanNodes: shapes.reads ? shapes.nodes / shapes.reads : 0,
      meanEdges: shapes.reads ? shapes.edges / shapes.reads : 0,
      suggestedEdges: shapes.suggested,
      truncatedAnswers: shapes.truncated
    },
    hubAnswer: { nodes: heaviest.nodes.length, edges: heaviest.edges.length },
    plans
  };
}

function summarizeKinds(buckets: Map<SampleKind, number[]>) {
  return Object.fromEntries([...buckets].map(([kind, list]) => [kind, summary(list)]));
}

async function plan(client: pg.Pool, statement: string, parameters: unknown[]): Promise<string[]> {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `explain (analyze, format json) ${statement}`,
    parameters
  );
  const counts = new Map<string, number>();
  for (const line of scans(result.rows[0]!["QUERY PLAN"][0]!.Plan))
    counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, count]) => (count > 1 ? `${line} x${count}` : line)).sort();
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
      max: 1,
      options: "-c default_transaction_read_only=on -c statement_timeout=60000"
    });
  } else {
    workDir = await mkdtemp(join(tmpdir(), "memora-note-page-benchmark-"));
    const repoRoot = resolve(import.meta.dirname, "../..");
    const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_note_page_benchmark",
      user: "memora_note_page_benchmark",
      password: `benchmark-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const started = await manager.start();
    origin = "throwaway sidecar";
    pool = new pg.Pool({ connectionString: started.connectionString, max: 2 });
    log("migrating");
    await runMigrations(pool, resolve(repoRoot, "packages/db/drizzle"));
    log(`seeding ${books * 10} sources, ${noteTotal} notes, ${pageTotal} legacy pages, relations`);
    const seedClient = await pool.connect();
    try {
      for (const step of [
        ...librarySeedSteps(books, noteTotal, pageTotal),
        ...noteRelationSeedSteps({ relationsPerNote: 6, hubNotes: 20, hubRelations: 400 })
      ])
        await seedClient.query(step);
    } finally {
      seedClient.release();
    }
  }

  const library = (
    await pool.query<Record<string, string>>(
      `select (select count(*) from source_items)::text as sources,
              (select count(*) from chunks)::text as chunks,
              (select count(*) from atomic_notes)::text as notes,
              (select count(*) from atomic_note_relations)::text as relations,
              (select count(*) from atomic_note_source_links)::text as "evidenceLinks",
              (select count(*) from atomic_note_evidence)::text as "retainedEvidence"`
    )
  ).rows[0]!;
  log(`library: ${JSON.stringify(library)}`);

  const repository = createNotePageRepository(pool);
  const samples = await collectSamples(pool);
  if (samples.length === 0) throw new Error("The database holds no note to measure.");
  const measure = async (sample: Sample): Promise<number> => {
    const start = performance.now();
    const page = await repository.readPage(sample.id, {
      relationLimit: notePageLimits.relationPage,
      contentLanguage: "en"
    });
    NotePageSchema.parse(page);
    return performance.now() - start;
  };

  for (const sample of samples) await measure(sample); // warm-up: caches and plans
  const byKind = new Map<SampleKind, number[]>();
  const slowest = { ms: 0, sample: samples[0]! };
  for (let round = 0; round < rounds; round += 1) {
    for (const sample of samples) {
      const ms = await measure(sample);
      byKind.set(sample.kind, [...(byKind.get(sample.kind) ?? []), ms]);
      if (ms > slowest.ms) {
        slowest.ms = ms;
        slowest.sample = sample;
      }
    }
  }
  const summarize = summary;
  const all = summarize([...byKind.values()].flat());

  // The heaviest note (the first hub, else the slowest sample) explains every statement it runs.
  const heaviest = samples.find((sample) => sample.kind === "hub")?.id ?? slowest.sample.id;
  const plans = {
    note: await plan(pool, repository.statements.note, [heaviest, notePageLimits.successors]),
    evidence: await plan(pool, repository.statements.evidence, [
      heaviest,
      notePageLimits.evidence,
      31
    ]),
    relations: await plan(pool, repository.statements.relations, [
      heaviest,
      notePageLimits.relationPage,
      0,
      notePageLimits.excerptCharacters,
      [...noteRelationGroups],
      notePageLimits.groupPage
    ]),
    placement: await plan(pool, createObjectLocateRepository(pool).statements.note, [
      heaviest,
      objectLocateListLimit,
      30
    ])
  };
  const largeTables = (
    await pool.query<{ name: string }>(
      "select relname as name from pg_class where relname = any($1::text[]) and reltuples >= $2",
      [watchedTables, largeTableRows]
    )
  ).rows.map((row) => row.name);
  const seqScans = Object.entries(plans).flatMap(([name, lines]) =>
    lines
      .filter((line) => largeTables.some((table) => line.startsWith(`Seq Scan on ${table}`)))
      .map((line) => `${name}: ${line}`)
  );
  const service = values.service
    ? await measureService(pool, samples, workDir ?? tmpdir(), Boolean(values.seed))
    : null;
  const neighborhood = values.neighborhood ? await measureNeighborhood(pool, samples) : null;
  const neighborhoodSeqScans = neighborhood
    ? Object.entries(neighborhood.plans).flatMap(([name, lines]) =>
        lines
          .filter((line) => largeTables.some((table) => line.startsWith(`Seq Scan on ${table}`)))
          .map((line) => `${name}: ${line}`)
      )
    : [];
  const report = {
    origin,
    library,
    sampledNotes: Object.fromEntries(
      [...byKind].map(([kind, list]) => [kind, list.length / rounds])
    ),
    rounds,
    targetMs,
    byKind: Object.fromEntries([...byKind].map(([kind, list]) => [kind, summarize(list)])),
    overall: all,
    largeTables,
    seqScans,
    service,
    serviceTargetMs: service ? serviceTargetMs : null,
    neighborhood,
    neighborhoodTargetsMs: neighborhood
      ? { depth1: neighborhoodD1Ms, depth2: neighborhoodD2Ms }
      : null,
    passed:
      all.p95 <= targetMs &&
      seqScans.length === 0 &&
      neighborhoodSeqScans.length === 0 &&
      (service === null || (service.wired.p95 <= serviceTargetMs && service.writerResolved)) &&
      (neighborhood === null ||
        (neighborhood.d1.overall.p95 <= neighborhoodD1Ms &&
          neighborhood.d2.overall.p95 <= neighborhoodD2Ms)),
    slowest: { kind: slowest.sample.kind, ms: slowest.ms },
    heaviestPlans: plans,
    wallSeconds: Math.round((Date.now() - startedAt) / 1000)
  };

  const fixed = (value: number) => (Number.isNaN(value) ? "n/a" : value.toFixed(2));
  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.count} | ${fixed(s.p50)} | ${fixed(s.p95)} | ${fixed(s.p99)} | ${fixed(s.max)} |`;
  console.info(
    [
      `notes.page latency (ms) on ${origin}`,
      `library: ${Object.entries(library)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
      "",
      "| Notes | Calls | p50 | p95 | p99 | max |",
      "| --- | --- | --- | --- | --- | --- |",
      ...[...byKind].map(([kind, list]) => row(kind, summarize(list))),
      row("all", all),
      "",
      `Target p95 <= ${targetMs} ms: ${all.p95 <= targetMs ? "PASS" : "FAIL"} (${fixed(all.p95)} ms)`,
      ...(service
        ? [
            "",
            `notes.page SERVICE call (language from ${service.languageFromSettings ? "the stored settings" : "a stub"}, writer ${service.writerResolved ? "resolved" : "NOT resolved: no AI route"})`,
            "| Variant | Calls | p50 | p95 | p99 | max |",
            "| --- | --- | --- | --- | --- | --- |",
            row("no writer", service.noWriter),
            row("writer resolved on every read", service.perRead),
            row("wired (memoized per configuration)", service.wired),
            `resolving the writer once: p50 ${fixed(service.resolveWriter.p50)} ms, p95 ${fixed(service.resolveWriter.p95)} ms`,
            `Service target p95 <= ${serviceTargetMs} ms: ${service.wired.p95 <= serviceTargetMs && service.writerResolved ? "PASS" : "FAIL"} (${fixed(service.wired.p95)} ms)`
          ]
        : []),
      ...(neighborhood
        ? [
            "",
            `objects.neighborhood (R30), at most ${objectNeighborhoodLimits.nodes} nodes; a depth-2 answer holds ${fixed(neighborhood.shapes.meanNodes)} nodes and ${fixed(neighborhood.shapes.meanEdges)} edges on average (${neighborhood.shapes.suggestedEdges} suggested edges, ${neighborhood.shapes.truncatedAnswers} of ${neighborhood.shapes.reads} truncated); the first hub's: ${neighborhood.hubAnswer.nodes} nodes, ${neighborhood.hubAnswer.edges} edges`,
            "| Depth | Calls | p50 | p95 | p99 | max |",
            "| --- | --- | --- | --- | --- | --- |",
            row("1", neighborhood.d1.overall),
            ...Object.entries(neighborhood.d1.byKind).map(([kind, s]) => row(`1 ${kind}`, s)),
            row("2", neighborhood.d2.overall),
            ...Object.entries(neighborhood.d2.byKind).map(([kind, s]) => row(`2 ${kind}`, s)),
            `Depth 1 target p95 <= ${neighborhoodD1Ms} ms: ${neighborhood.d1.overall.p95 <= neighborhoodD1Ms ? "PASS" : "FAIL"} (${fixed(neighborhood.d1.overall.p95)} ms)`,
            `Depth 2 target p95 <= ${neighborhoodD2Ms} ms: ${neighborhood.d2.overall.p95 <= neighborhoodD2Ms ? "PASS" : "FAIL"} (${fixed(neighborhood.d2.overall.p95)} ms)`,
            `Sequential scans of large tables in the neighbourhood plans: ${neighborhoodSeqScans.length ? neighborhoodSeqScans.join("; ") : "none"}`,
            ...Object.entries(neighborhood.plans).flatMap(([name, lines]) =>
              lines.map((line) => `  - ${name}: ${line}`)
            )
          ]
        : []),
      `Sequential scans of large tables (${largeTables.join(", ") || "none this large"}) in the heaviest note's plans: ${seqScans.length ? seqScans.join("; ") : "none"}`,
      `Slowest call: ${report.slowest.kind} note, ${fixed(report.slowest.ms)} ms; scans of the heaviest note:`,
      ...Object.entries(plans).flatMap(([name, lines]) =>
        lines.map((line) => `  - ${name}: ${line}`)
      )
    ].join("\n")
  );
  if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  if (manager) await manager.stop().catch(() => undefined);
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
