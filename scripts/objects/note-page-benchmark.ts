import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import { NotePageSchema, notePageLimits, objectLocateListLimit } from "@app/domain";
import {
  createNotePageRepository,
  createObjectLocateRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";

import { resolveConnection } from "../kpi/connection.js";
import { librarySeedSteps, noteRelationSeedSteps } from "./synthetic-library.js";

/**
 * Latency of `notes.page` (target: p95 <= 50 ms, the `objects.locate` budget). Measures the
 * read-only note page repository (the same transaction, statements and Zod validation the desktop
 * service runs) against
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
      relationLimit: notePageLimits.relationPage
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
      notePageLimits.excerptCharacters
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
    passed: all.p95 <= targetMs && seqScans.length === 0,
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
