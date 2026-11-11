import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import pg from "pg";

import { createPgPool, currentNoteSql, omniSearchStatement, runMigrations } from "@app/db";

import { SearchOmniService } from "../../apps/desktop/src/main/services/search-omni-service.js";
import { omniArms } from "../../packages/db/src/objectSearchArms.js";
import { startProfileServer, type ProfileServer } from "../lib/profile-server.js";
import {
  analyzePlan,
  expectedQuickP95Ms,
  latencyReport,
  seqScanRowLimit,
  summarizeExplain,
  type PlanNode,
  type TimedQuery
} from "./omni-bench-lib.js";
import {
  buildQuerySet,
  omniQueriesPerKind,
  omniQuerySeed,
  type OmniQueryKind,
  type TitleSample
} from "./omni-queries.js";

/**
 * The Cmd-K benchmark and EXPLAIN gate (F5 T128, bar X3(a), spec 3.4 and 5.2). Starts a PostgreSQL
 * server on a scratch clone of a profile through `scripts/lib/profile-server.ts` (never
 * `.cache/profiles/*`, never the default userData), builds the deterministic query set from the
 * clone's own titles (seed 20261111, 50 per kind, prefixes of 2-12 characters) and
 *
 *   - times `search.omni` in quick mode through the desktop service (statement, validation and
 *     result schema; the Electron IPC hop of about a millisecond excluded): one untimed warm-up pass,
 *     then `--runs` timed passes over the whole set; p50 and p95 overall, per kind and per query
 *     length, and the p95 of the per-query medians;
 *   - runs EXPLAIN on the statement of every query and fails (exit 1) when a plan reads a table of
 *     10,000 rows or more with a sequential scan or an arm does not use its index (the arms and
 *     indexes are those of `objectSearchArms.ts`, which migration 0067 and `db:search-indexes:verify`
 *     use); EXPLAIN ANALYZE of the slowest queries is recorded for the report.
 *
 * Writes `.cache/f5/bench/omni-<profile>-<timestamp>.json`. The p95 is reported against the
 * calibrated 60 ms expectation, never failed on it. Read-only: the one write is `--migrate`, which
 * applies the pending migrations to the scratch clone (a clone cut from a profile at an older head
 * has no 0066 or 0067 and is refused without it).
 */
const usage = `Usage: npm run bench:omni -- --profile <abs scratch dir> [options]

  --profile <abs dir>  Profile-shaped clone under <repo>/.cache/f<N>/scratch/ (for example
                       .cache/f5/scratch/bench/env-c); started and stopped by this script.
  --runs <n>           Timed passes over the query set after one warm-up pass (default 5).
  --per-kind <n>       Titles drawn per kind (default ${omniQueriesPerKind}).
  --seed <n>           Seed of the draw (default ${omniQuerySeed}).
  --migrate            Apply the pending migrations to the clone first (default: refuse a lagging head).
  --out-dir <dir>      Where the JSON goes (default <repo>/.cache/f5/bench).
  --help               Show this text.`;

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    runs: { type: "string" },
    "per-kind": { type: "string" },
    seed: { type: "string" },
    migrate: { type: "boolean" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true,
  allowPositionals: false
});
if (values.help) {
  console.info(usage);
  process.exit(0);
}
if (!values.profile) {
  console.error(`--profile is required.\n\n${usage}`);
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
const runs = integer(values.runs, 5, "runs");
const perKind = integer(values["per-kind"], omniQueriesPerKind, "per-kind");
const seed = integer(values.seed, omniQuerySeed, "seed");

const repoRoot = resolve(import.meta.dirname, "../..");
const log = (message: string) => console.error(`[bench:omni] ${message}`);

/** The titles each kind's query set draws from: what omni's statement makes visible. */
const titleSql: Record<OmniQueryKind, string> = {
  source: "select id::text as id, title from source_items where title is not null",
  topic: `select t.id::text as id, t.title from topics t
    where t.title is not null and t.retired_at is null
      and coalesce((select tt.status = 'active' from topic_trees tt where tt.id = t.tree_id), false)`,
  note: `select n.id::text as id, n.title from atomic_notes n
    where n.title is not null and ${currentNoteSql("n")}`,
  entity: "select id::text as id, canonical_name as title from entities",
  question: "select id::text as id, left(text, 200) as title from questions"
};

/** Rows of every table of the public schema: the planner's estimate, exact where it has none. */
async function tableRowCounts(
  pool: pg.Pool,
  exactTables: readonly string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const estimated = await pool.query<{ name: string; rows: string }>(
    `select c.relname as name, c.reltuples::bigint::text as rows from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`
  );
  const exact = new Set(exactTables);
  for (const { name, rows } of estimated.rows) {
    const estimate = Number(rows);
    if (estimate < 0 || exact.has(name)) {
      const result = await pool.query<{ rows: string }>(
        `select count(*)::text as rows from "${name}"`
      );
      counts.set(name, Number(result.rows[0]!.rows));
    } else counts.set(name, estimate);
  }
  return counts;
}

async function migrationHeads(pool: pg.Pool): Promise<{ applied: number; journal: number }> {
  const journal = JSON.parse(
    await readFile(resolve(repoRoot, "packages/db/drizzle/meta/_journal.json"), "utf8")
  ) as { entries: unknown[] };
  const applied = await pool.query<{ rows: string }>(
    "select count(*)::text as rows from drizzle.__drizzle_migrations"
  );
  return { applied: Number(applied.rows[0]!.rows), journal: journal.entries.length };
}

let server: ProfileServer | null = null;
let pool: pg.Pool | null = null;
let exitCode = 0;
try {
  // A clone cut from a profile has no `seed-complete.json` (only a seeding run writes one); the
  // checks below (head, titles) stand in for it.
  server = await startProfileServer(values.profile, { repoRoot, allowIncomplete: true });
  const profileName = basename(server.profileDir);
  log(`server started on scratch profile ${profileName}`);

  if (values.migrate) {
    const writer = createPgPool({ connectionString: server.connectionString, max: 1 });
    try {
      const before = await migrationHeads(writer);
      log(`migrating (${before.applied} of ${before.journal} applied)`);
      await runMigrations(writer, resolve(repoRoot, "packages/db/drizzle"));
    } finally {
      await writer.end();
    }
  }
  pool = new pg.Pool({
    connectionString: server.connectionString,
    max: 1,
    options: "-c default_transaction_read_only=on -c statement_timeout=60000"
  });
  // An idle connection the server closes must not crash the run: the next query reconnects.
  pool.on("error", (error) => log(`idle connection error: ${error.message}`));
  const heads = await migrationHeads(pool);
  if (heads.applied < heads.journal)
    throw new Error(
      `The clone has ${heads.applied} of ${heads.journal} migrations (the omni indexes need 0067). ` +
        `Run once with --migrate, then time it.`
    );

  const quickArms = omniArms.filter((arm) => arm.quick);
  const rowCounts = await tableRowCounts(pool, [
    ...new Set([...quickArms.map((arm) => arm.table), "topic_trees"])
  ]);

  const titles: Partial<Record<OmniQueryKind, TitleSample[]>> = {};
  const candidates: Record<string, number> = {};
  for (const [kind, sql] of Object.entries(titleSql) as [OmniQueryKind, string][]) {
    const result = await pool.query<TitleSample>(sql);
    titles[kind] = result.rows;
    candidates[kind] = result.rows.length;
  }
  const querySet = buildQuerySet(titles, { seed, perKind });
  if (querySet.length === 0) throw new Error("The clone has no titles to build a query set from.");
  const perKindCounts = Object.fromEntries(
    Object.keys(titleSql).map((kind) => [kind, querySet.filter((q) => q.kind === kind).length])
  );
  log(`query set: ${querySet.length} queries ${JSON.stringify(perKindCounts)}, seed ${seed}`);

  // 1. Latency through the service: one warm-up pass, then `runs` timed passes.
  const service = new SearchOmniService(() => pool, null);
  const ask = async (query: string) => {
    const started = performance.now();
    await service.omni({ query, mode: "quick", limit: 20, requestId: randomUUID() });
    return performance.now() - started;
  };
  for (const { query } of querySet) await ask(query);
  const timed: TimedQuery[] = querySet.map((query) => ({ query, runsMs: [] }));
  const load = loadavg();
  for (let pass = 0; pass < runs; pass += 1)
    for (const item of timed) item.runsMs.push(await ask(item.query.query));
  const latency = latencyReport(timed);
  log(
    `quick p50 ${latency.all.p50.toFixed(1)} ms, p95 ${latency.all.p95.toFixed(1)} ms over ` +
      `${latency.all.count} runs (expected <= ${expectedQuickP95Ms} ms, calibrated)`
  );

  // 2. EXPLAIN of every query's statement; ANALYZE for the slowest.
  const plan = async (text: string, values: unknown[], analyze: boolean) => {
    const result = await pool!.query<{
      "QUERY PLAN": { Plan: PlanNode; "Execution Time"?: number }[];
    }>(`explain (${analyze ? "analyze, buffers, " : ""}format json) ${text}`, values);
    return result.rows[0]!["QUERY PLAN"][0]!;
  };
  const analyses = [];
  for (const { query } of querySet) {
    const statement = omniSearchStatement({ query, mode: "quick", limit: 20 });
    const { Plan } = await plan(statement.text, statement.values, false);
    analyses.push({ query, analysis: analyzePlan(Plan, rowCounts, quickArms) });
  }
  const explain = summarizeExplain(analyses);
  const analyzed = [];
  for (const slow of latency.slowest) {
    const statement = omniSearchStatement({ query: slow.query, mode: "quick", limit: 20 });
    const { Plan, "Execution Time": executionMs } = await plan(
      statement.text,
      statement.values,
      true
    );
    const analysis = analyzePlan(Plan, rowCounts, quickArms);
    analyzed.push({ ...slow, executionMs, seqScans: analysis.seqScans, indexes: analysis.indexes });
  }
  for (const arm of explain.arms)
    log(
      `${arm.arm.padEnd(10)} ${arm.table.padEnd(12)} ${arm.rows.toLocaleString("en-US").padStart(9)} rows  ` +
        `index ${arm.counts.index}, small table ${arm.counts["small-table"]}, ` +
        `seq scan ${arm.counts["seq-scan"]}, index unused ${arm.counts["index-unused"]}`
    );
  if (!explain.passed) {
    exitCode = 1;
    for (const failure of explain.failures)
      log(
        `EXPLAIN gate FAILED: ${failure.reason} (${failure.queries} queries, e.g. ${failure.examples
          .slice(0, 5)
          .map((example) => `"${example}"`)
          .join(", ")})`
      );
  } else log(`EXPLAIN gate passed on ${explain.explained} queries (limit ${seqScanRowLimit} rows)`);

  const outDir = values["out-dir"] ? resolve(values["out-dir"]) : join(repoRoot, ".cache/f5/bench");
  await mkdir(outDir, { recursive: true });
  const outFile = join(
    outDir,
    `omni-${profileName}-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`
  );
  await writeFile(
    outFile,
    `${JSON.stringify(
      {
        bench: "omni",
        bar: "X3(a)",
        profile: profileName,
        at: new Date().toISOString(),
        node: process.version,
        cpus: cpus().length,
        loadAverageAtStart: load.map((value) => Number(value.toFixed(2))),
        migrations: heads,
        seed,
        perKind,
        runs,
        mode: "quick",
        candidates,
        queries: { total: querySet.length, perKind: perKindCounts },
        tableRows: Object.fromEntries(
          [...new Set(quickArms.map((arm) => arm.table))].map((table) => [
            table,
            rowCounts.get(table) ?? 0
          ])
        ),
        latencyMs: {
          ...latency,
          expectedP95Ms: expectedQuickP95Ms,
          withinExpected: latency.all.p95 <= expectedQuickP95Ms
        },
        explain: { ...explain, seqScanRowLimit, analyzed },
        querySet: querySet.map(({ kind, id, query }) => ({ kind, id, query }))
      },
      null,
      2
    )}\n`
  );
  log(`wrote ${outFile}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await pool?.end().catch(() => undefined);
  await server?.stop().catch((error: unknown) => {
    console.error(
      `could not stop the scratch server: ${error instanceof Error ? error.message : error}`
    );
    exitCode = 1;
  });
}
process.exit(exitCode);
