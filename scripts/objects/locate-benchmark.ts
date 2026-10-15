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

/**
 * Latency of `objects.locate` (F1b exit: p95 <= 50 ms). Measures the read-only locate repository
 * (the same statement and Zod validation the desktop service runs) against
 *
 *   --db <connection.json | postgres url>   an existing database, read-only: a restored golden
 *                                           backup (`scripts/db/restore-backup.ts`), or
 *   --seed                                  a throwaway PostgreSQL sidecar migrated from scratch
 *                                           and filled with a synthetic library at scale.
 *
 * The time includes the database round trip on loopback and the result validation, and excludes the
 * Electron IPC hop (about a millisecond). Nothing is written to a `--db` database.
 */
const usage = `Usage: npx tsx scripts/objects/locate-benchmark.ts (--db <connection.json | url> | --seed) [options]

  --db <value>         Scratch connection file or postgres:// URL; opened read-only.
  --seed               Seed a throwaway sidecar database with a synthetic library instead.
  --books <n>          (--seed) root books; each has 3 chapters x 2 sections (default 300 = 3,000 sources).
  --notes <n>          (--seed) atomic notes (default 30000).
  --pages <n>          (--seed) legacy wiki pages with memberships, dependencies and evidence (default 2000).
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
  console.error(`[locate-benchmark] ${message}`);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

const seedSteps = (booksCount: number, notesCount: number, pagesCount: number): string[] => [
  // Library: books > chapters > sections.
  `create temp table t_book as select i, gen_random_uuid() as id from generate_series(1, ${booksCount}) i`,
  `create temp table t_chapter as select b.i, c, gen_random_uuid() as id, b.id as parent from t_book b, generate_series(1, 3) c`,
  `create temp table t_section as select c.i, c.c, s, gen_random_uuid() as id, c.id as parent,
          row_number() over (order by c.i, c.c, s) as rn from t_chapter c, generate_series(1, 2) s`,
  `insert into source_items (id, type, title, parent_source_item_id)
   select id, 'Book'::source_item_type, 'Book ' || i, null::uuid from t_book
   union all select id, 'BookChapter', 'Book ' || i || ' chapter ' || c, parent from t_chapter
   union all select id, 'DocumentSection', 'Book ' || i || ' chapter ' || c || ' section ' || s, parent from t_section`,
  `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
   select gen_random_uuid(), id, 'Document', 'seed', md5(id::text) from t_section`,
  `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
   select gen_random_uuid(), d.id, d.source_item_id, g, 'Passage ' || g, md5(d.id::text || g)
     from documents d, generate_series(0, 7) g`,
  `create temp table t_chunk as select row_number() over (order by source_item_id, chunk_index) as rn,
          id, source_item_id, chunk_index from chunks`,
  // Notes: 10% knowledge-owned and linked to a second source.
  `create temp table t_note as
     select gen_random_uuid() as id, g, s.id as source_id, k.id as chunk_id
       from generate_series(1, ${notesCount}) g
       join t_section s on s.rn = 1 + (g % (select count(*) from t_section))
       join t_chunk k on k.source_item_id = s.id and k.chunk_index = g % 8`,
  `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
      ownership, created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
      generation_runtime, generation_prompt_version, generation_key)
   select id, 'Note ' || g, 'Body ' || g, 'Idea ' || g, 'active', 'current',
          case when g % 10 = 0 then 'knowledge' else 'source' end,
          source_id, chunk_id, 'seed', 'seed', 'local', 'seed', id::text from t_note`,
  `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id)
   select id, source_id, chunk_id from t_note`,
  `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id)
   select n.id, k.source_item_id, k.id from t_note n
     join t_chunk k on k.rn = 1 + ((n.g * 31) % (select count(*) from t_chunk))
    where n.g % 10 = 0 on conflict do nothing`,
  `create temp table t_note_rank as select row_number() over (order by g) as rn, id from t_note`,
  `create temp table t_source_rank as
     select row_number() over (order by id) as rn, id from source_items`,
  // Legacy wiki: pages with a revision, a TOC group, memberships, dependencies and evidence.
  `create temp table t_page as
     select g, gen_random_uuid() as id, gen_random_uuid() as revision, gen_random_uuid() as grp
       from generate_series(1, ${pagesCount}) g`,
  `insert into wiki_pages (id, title, kind, archived, current_revision_id)
   select id, 'Page ' || g, case when g % 10 = 1 then 'entity' when g % 10 = 2 then 'synthesis' else 'topic' end,
          g % 50 = 0, revision from t_page`,
  `insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash)
   select revision, id, 1, 'seed', '{}'::jsonb, revision::text from t_page`,
  `insert into wiki_toc_groups (id, page_id, revision_id, snapshot)
   select grp, id, revision, '{}'::jsonb from t_page`,
  // Every third target is one of five hot sources, so some sources are heavily referenced.
  `create temp table t_target as
     select p.g, j, p.id as page, p.revision, p.grp,
            case when j % 2 = 0 then 'source' else 'atomic_note' end as kind,
            case when j % 2 = 0
              then (select id from t_source_rank where rn =
                      case when j % 3 = 0 then 1 + (p.g % 5)
                           else 1 + ((p.g * 131 + j * 7919) % (select count(*) from t_source_rank)) end)
              else (select id from t_note_rank where rn = 1 + ((p.g * 151 + j * 104729) % (select count(*) from t_note_rank)))
            end as target
       from t_page p, generate_series(1, 15) j`,
  `insert into wiki_memberships (id, page_id, group_id, target_kind, target_id, position, snapshot)
   select gen_random_uuid(), page, grp, kind, target, j, '{}'::jsonb from t_target`,
  `insert into wiki_dependencies (revision_id, section_id, kind, input_id, fingerprint, snapshot)
   select revision, gen_random_uuid(), kind, target, 'seed', '{}'::jsonb from t_target
    where (g + j) % 3 <> 0 on conflict do nothing`,
  `insert into wiki_evidence (page_id, source_item_id, document_id, chunk_id, snapshot)
   select p.id, k.source_item_id, d.id, k.id, '{}'::jsonb
     from t_page p cross join generate_series(1, 10) j
     join t_chunk k on k.rn = 1 + ((p.g * 977 + j * 13) % (select count(*) from t_chunk))
     join documents d on d.source_item_id = k.source_item_id
    on conflict do nothing`,
  `analyze`
];

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
  // The heaviest objects: most memberships, most evidence rows and most linked notes.
  add(
    sources,
    await ids(
      client,
      "select target_id as id from wiki_memberships where target_kind = 'source' group by target_id order by count(*) desc limit 20"
    )
  );
  add(
    sources,
    await ids(
      client,
      "select source_item_id as id from wiki_evidence group by source_item_id order by count(*) desc limit 20"
    )
  );
  add(
    sources,
    await ids(
      client,
      "select source_item_id as id from atomic_note_source_links group by source_item_id order by count(*) desc limit 20"
    )
  );
  add(
    notes,
    await ids(
      client,
      "select target_id as id from wiki_memberships where target_kind = 'atomic_note' group by target_id order by count(*) desc limit 20"
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
    log(`seeding ${books * 10} sources, ${noteTotal} notes, ${pageTotal} legacy pages`);
    const seedClient = await pool.connect();
    try {
      for (const step of seedSteps(books, noteTotal, pageTotal)) await seedClient.query(step);
    } finally {
      seedClient.release();
    }
  }

  const library = (
    await pool.query<Record<string, string>>(
      `select (select count(*) from source_items)::text as sources,
              (select count(*) from chunks)::text as chunks,
              (select count(*) from atomic_notes)::text as notes,
              (select count(*) from wiki_pages)::text as pages,
              (select count(*) from wiki_memberships)::text as memberships,
              (select count(*) from wiki_evidence)::text as evidence`
    )
  ).rows[0]!;
  log(`library: ${JSON.stringify(library)}`);

  const repository = createObjectLocateRepository(pool);
  const samples = await collectSamples(pool);
  if (samples.length === 0) throw new Error("The database holds no source or note to measure.");
  const measure = async (sample: Sample): Promise<number> => {
    const start = performance.now();
    const result =
      sample.kind === "source"
        ? await repository.locateSource(sample.id)
        : await repository.locateNote(sample.id);
    ObjectLocateResultSchema.parse(result);
    return performance.now() - start;
  };

  for (const sample of samples) await measure(sample); // warm-up: caches and plans
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
    passed: all.p95 <= targetMs,
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
