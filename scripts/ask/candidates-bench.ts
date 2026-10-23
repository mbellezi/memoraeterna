import { writeFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import pg from "pg";

import { consultationCandidatesSql, consultationPlan } from "@app/db";

import { resolveConnection } from "../kpi/connection.js";
import { compareCandidates, largestSignalDifference, summarize } from "./bench-lib.js";
import type { CandidateRow, Distribution } from "./bench-lib.js";
import { buildCombos } from "./combos.js";
import type { AskCombo, ComboSet } from "./combos.js";
import { legacyCandidatesSql } from "./legacy-candidates.js";

/**
 * The measurement of the Ask candidates statement before and after migration 0064 (F4 T79, C3;
 * D22). Against a scratch database (never a profile in place: clone it first, see below):
 *
 *   --phase compare   runs every combination once with the statement as it was before 0064 and the
 *                     one that reads the stored text vectors, and compares the two result lists:
 *                     the same passages in the same order, every signal within 1e-9, the same total.
 *   --phase time      runs the statement chosen by --statement for every combination: one untimed
 *                     warm-up run, then --runs timed runs, each in its own read-only transaction
 *                     with a statement timeout as the product's `budgetedQueries` does. Reports
 *                     p50/p95/p99/max of the runs, overall and per set, and the p95 of the median
 *                     of each combination.
 *   --phase explain   EXPLAIN (ANALYZE, VERBOSE, BUFFERS) of the statement for the widest
 *                     combinations of each set: sequential scans, the indexes used, and whether
 *                     any `to_tsvector(` still parses the text of a passage or a note.
 *
 * Statements: \`legacy\` is the one of the code before 0064 (needs no stored column), \`stored\`
 * the product's (needs a database at 0064 or later). The combinations are rebuilt from the library
 * (\`combos.ts\`): the same library and --seed give the same ones.
 */
const usage = `Usage: npx tsx scripts/ask/candidates-bench.ts --db <connection.json | postgres url> --phase compare|time|explain [options]

  --db <value>           Scratch connection file or postgres:// URL of a clone, never a profile in place.
  --phase <name>         compare, time or explain.
  --statement <name>     legacy or stored (time, explain; default stored).
  --set <name>           wide, narrow or all (default all).
  --wide <n>             Combinations of the wide set (default 250).
  --narrow <n>           Combinations of the narrow set (default 1020).
  --seed <n>             Seed of the combinations (default 20261023).
  --runs <n>             Timed runs per combination (default 5, after one warm-up run).
  --max-timed <n>        Time at most this many combinations of each set (default: all).
  --explain-count <n>    Combinations explained per set (default 3).
  --json <file>          Write the measurements as JSON.
  --label <text>         Name of the run in the report.
  --help                 Show this text.

Scratch clone of a measurement profile (APFS, nothing copied), the way T79 ran it:
  npx tsx scripts/ask/scratch-cluster.ts start --from .cache/profiles/env-soak24/database --to .cache/f4/scratch/<name> --port 61641
  npm run db:ask-text:verify -- --db .cache/f4/scratch/<name>/scratch-connection.json --before-only   # the state before 0064
  ... --phase time --statement legacy ...; npm run db:ask-text:verify -- --db ... (applies 0064 step by step, timed);
  ... --phase compare; --phase time --statement stored; --phase explain --statement stored
  npx tsx scripts/ask/scratch-cluster.ts stop --to .cache/f4/scratch/<name>`;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    phase: { type: "string" },
    statement: { type: "string" },
    set: { type: "string" },
    wide: { type: "string" },
    narrow: { type: "string" },
    seed: { type: "string" },
    runs: { type: "string" },
    "max-timed": { type: "string" },
    "explain-count": { type: "string" },
    json: { type: "string" },
    label: { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true,
  allowPositionals: false
});
if (values.help) {
  console.info(usage);
  process.exit(0);
}
const fail = (message: string): never => {
  console.error(`${message}\n\n${usage}`);
  return process.exit(2);
};
const integer = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fail(`--${name} must be a whole number.`);
  return parsed;
};
if (!values.db) fail("--db is required.");
const phase = values.phase;
if (phase !== "compare" && phase !== "time" && phase !== "explain")
  fail("--phase must be compare, time or explain.");
const statementName = values.statement ?? "stored";
if (statementName !== "legacy" && statementName !== "stored")
  fail("--statement must be legacy or stored.");
const setName = values.set ?? "all";
if (setName !== "wide" && setName !== "narrow" && setName !== "all")
  fail("--set must be wide, narrow or all.");
const options = {
  wide: setName === "narrow" ? 0 : integer(values.wide, 250, "wide"),
  narrow: setName === "wide" ? 0 : integer(values.narrow, 1020, "narrow"),
  seed: integer(values.seed, 20_261_023, "seed"),
  runs: integer(values.runs, 5, "runs"),
  maxTimed:
    values["max-timed"] === undefined ? Infinity : integer(values["max-timed"], 0, "max-timed"),
  explainCount: integer(values["explain-count"], 3, "explain-count")
};
const sql = (name: string): string =>
  name === "legacy" ? legacyCandidatesSql : consultationCandidatesSql;

const connection = await resolveConnection(values.db!);
const client = new pg.Client({ connectionString: connection.connectionString });
await client.connect();

/** One statement as the product runs it: its own read-only transaction with a statement timeout. */
async function run(
  statement: string,
  combo: AskCombo
): Promise<{ rows: CandidateRow[]; ms: number }> {
  await client.query("begin read only; set local statement_timeout = 120000");
  try {
    const started = performance.now();
    const result = await client.query(statement, [
      combo.sourceIds,
      combo.question,
      combo.reviewedOnly,
      [],
      combo.topicId
    ]);
    const ms = performance.now() - started;
    await client.query("commit");
    return { rows: result.rows, ms };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function hasStoredVectors(): Promise<boolean> {
  const found = await client.query(
    `select count(*)::int as n from information_schema.columns
      where (table_name = 'chunks' and column_name = 'search_tsv')
         or (table_name = 'atomic_notes' and column_name = 'ask_tsv')`
  );
  return found.rows[0].n === 2;
}

const stored = await hasStoredVectors();
if ((phase === "compare" || statementName === "stored") && !stored) {
  await client.end();
  fail("This database has no stored text vectors (migration 0064): apply it first.");
}

const counts = (
  await client.query(
    `select (select count(*) from chunks)::int as chunks, (select count(*) from source_items)::int as sources,
          (select count(*) from atomic_notes)::int as notes, (select count(*) from entities)::int as entities,
          (select count(*) from topics)::int as topics,
          (select max(created_at)::text from drizzle.__drizzle_migrations) as "lastMigrationAt",
          (select count(*) from drizzle.__drizzle_migrations)::int as migrations`
  )
).rows[0];
const combos = await buildCombos(client, options);
const scopeChunks = new Map<string, number>();
{
  const sizes = await client.query(
    `select source_item_id as id, count(*)::int as n from chunks group by source_item_id`
  );
  const bySource = new Map(sizes.rows.map((row) => [row.id as string, row.n as number]));
  for (const combo of combos)
    scopeChunks.set(
      combo.id,
      combo.sourceIds.reduce((sum, id) => sum + (bySource.get(id) ?? 0), 0)
    );
}
const report: Record<string, unknown> = {
  label: values.label ?? connection.label ?? null,
  phase,
  statement: phase === "compare" ? "legacy vs stored" : statementName,
  seed: options.seed,
  database: counts,
  combos: {
    total: combos.length,
    bySet: Object.fromEntries(
      (["wide", "narrow"] as ComboSet[]).map((set) => [
        set,
        combos.filter((combo) => combo.set === set).length
      ])
    ),
    chunksInScope: Object.fromEntries(
      (["wide", "narrow"] as ComboSet[]).map((set) => [
        set,
        summarize(
          combos.filter((combo) => combo.set === set).map((combo) => scopeChunks.get(combo.id)!)
        )
      ])
    )
  },
  machine: {
    cpus: cpus().length,
    loadAverageAtStart: loadavg().map((load) => Number(load.toFixed(2)))
  }
};

if (phase === "compare") {
  let identical = 0;
  let largest = 0;
  const mismatches: unknown[] = [];
  let rowsCompared = 0;
  for (const combo of combos) {
    const before = await run(legacyCandidatesSql, combo);
    const after = await run(consultationCandidatesSql, combo);
    const differences = compareCandidates(before.rows, after.rows);
    rowsCompared += before.rows.length;
    largest = Math.max(largest, largestSignalDifference(before.rows, after.rows));
    if (differences.length === 0) identical += 1;
    else if (mismatches.length < 10)
      mismatches.push({
        combo: combo.id,
        question: combo.question,
        differences: differences.slice(0, 5)
      });
  }
  Object.assign(report, {
    compared: combos.length,
    identical,
    different: combos.length - identical,
    rowsCompared,
    largestSignalDifference: largest,
    mismatches
  });
} else if (phase === "time") {
  const timed: Record<string, number[]> = { all: [] };
  const medians: Record<string, number[]> = { all: [] };
  const perSetCount: Record<string, number> = {};
  for (const combo of combos) {
    perSetCount[combo.set] = (perSetCount[combo.set] ?? 0) + 1;
    if (perSetCount[combo.set]! > options.maxTimed) continue;
    await run(sql(statementName), combo);
    const runs: number[] = [];
    for (let attempt = 0; attempt < options.runs; attempt += 1)
      runs.push((await run(sql(statementName), combo)).ms);
    const median = runs.toSorted((a, b) => a - b)[Math.floor(runs.length / 2)]!;
    for (const key of ["all", combo.set]) {
      (timed[key] ??= []).push(...runs);
      (medians[key] ??= []).push(median);
    }
  }
  const distribution = (values: number[]): Distribution => summarize(values);
  Object.assign(report, {
    runsPerCombination: options.runs,
    runsMs: Object.fromEntries(
      Object.entries(timed).map(([key, runs]) => [key, distribution(runs)])
    ),
    medianPerCombinationMs: Object.fromEntries(
      Object.entries(medians).map(([key, runs]) => [key, distribution(runs)])
    )
  });
} else {
  const plans: unknown[] = [];
  for (const set of ["wide", "narrow"] as ComboSet[]) {
    const widest = combos
      .filter((combo) => combo.set === set)
      .toSorted((a, b) => scopeChunks.get(b.id)! - scopeChunks.get(a.id)!)
      .slice(0, options.explainCount);
    for (const combo of widest) {
      await client.query("begin read only; set local statement_timeout = 300000");
      let root: consultationPlan.PlanNode;
      try {
        const explained = await client.query(
          `explain (analyze, verbose, buffers, format json) ${sql(statementName)}`,
          [combo.sourceIds, combo.question, combo.reviewedOnly, [], combo.topicId]
        );
        root = (
          explained.rows[0]["QUERY PLAN"] as {
            Plan: consultationPlan.PlanNode;
            "Execution Time": number;
          }[]
        )[0]!.Plan;
        plans.push({
          combo: combo.id,
          set,
          question: combo.question,
          chunksInScope: scopeChunks.get(combo.id),
          reviewedOnly: combo.reviewedOnly,
          topic: combo.topicId !== null,
          executionMs: (explained.rows[0]["QUERY PLAN"] as { "Execution Time": number }[])[0]![
            "Execution Time"
          ],
          contentTsvectorCalls: consultationPlan.contentTsvectorCalls(root).length,
          storedVectorReads: consultationPlan.storedVectorReads(root),
          sequentialScans: consultationPlan
            .planNodes(root)
            .filter(({ node }) => node["Node Type"] === "Seq Scan")
            .map(({ node }) => `${node["Relation Name"]} ${node.Alias}`),
          indexesUsed: [
            ...new Set(
              consultationPlan
                .planNodes(root)
                .map(({ node }) => node["Index Name"])
                .filter((name): name is string => typeof name === "string")
            )
          ],
          plan: root
        });
      } finally {
        await client.query("rollback").catch(() => undefined);
      }
    }
  }
  Object.assign(report, { plans });
}

await client.end();
const summary = JSON.stringify(report, (key, value) => (key === "plan" ? undefined : value), 2);
console.info(summary);
if (values.json) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);
if (phase === "compare" && (report.different as number) > 0) process.exit(1);
