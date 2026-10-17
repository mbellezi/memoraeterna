import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import {
  PostgresSidecarManager,
  createSourceRelationRepository,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";

import { bookPairSeedSteps } from "../objects/synthetic-library.js";

/**
 * S1's SQL bar on large roots (F3 R19, D27): on a throwaway PostgreSQL sidecar seeded with two book
 * roots of 500 chunks each (`synthetic-library.ts`, `bookPairSeedSteps`), it times the SQL one
 * source's design E matching runs against such a neighbour, in rounds after one warm-up: promotion,
 * the composite vector and the discovery plan, both root fingerprints, the pair's note-relation
 * fingerprints and notes, the saved relations and `pairChunks`, the evidence selection with its
 * lexical, vector and concept cross joins over the two roots' chunks. It reports p50 and p95 per
 * step and per source, and EXPLAIN (ANALYZE, BUFFERS) of every statement `pairChunks` sends. The
 * exit code is 1 when the per-source p95 exceeds the target (300 ms): then D27's fallback (the
 * note-relation chunks plus bounded exact vector pairs) replaces the cross joins.
 *
 *   npx tsx scripts/relations/source-pair-sql.ts [--chunks 500] [--rounds 20] [--json <file>]
 */
const usage = `Usage: npx tsx scripts/relations/source-pair-sql.ts [options]

  --chunks <n>        Chunks per root (default 500).
  --chapters <n>      Chapters per root (default 10).
  --rounds <n>        Timed rounds after one warm-up (default 20).
  --dimensions <n>    Embedding dimensions: 256, 768 or 1024 (default 768).
  --evidence <n>      Evidence chunks per source, pairChunks' limit (default 2, recommended-v2).
  --target-ms <n>     p95 per-source SQL target (default 300).
  --json <file>       Also write the measurements as JSON.
  --plans <file>      Also write the EXPLAIN plans of pairChunks' statements as text.
  --help              Show this text.`;

const { values } = parseArgs({
  options: {
    chunks: { type: "string" },
    chapters: { type: "string" },
    rounds: { type: "string" },
    dimensions: { type: "string" },
    evidence: { type: "string" },
    "target-ms": { type: "string" },
    json: { type: "string" },
    plans: { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true,
  allowPositionals: false
});
if (values.help) {
  console.info(usage);
  process.exit(0);
}
const integer = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`--${name} must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
};
const options = {
  chunks: integer(values.chunks, 500, "chunks"),
  chapters: integer(values.chapters, 10, "chapters"),
  rounds: integer(values.rounds, 20, "rounds"),
  dimensions: integer(values.dimensions, 768, "dimensions") as 256 | 768 | 1024,
  evidence: integer(values.evidence, 2, "evidence"),
  targetMs: integer(values["target-ms"], 300, "target-ms")
};
if (![256, 768, 1024].includes(options.dimensions)) {
  console.error("--dimensions must be 256, 768 or 1024.");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "../..");
const log = (message: string) => console.error(`[source-pair-sql] ${message}`);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
};

const workDir = await mkdtemp(join(tmpdir(), "memora-source-pair-sql-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: repoRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_source_pair_sql",
  user: "memora_source_pair_sql",
  password: `source-pair-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
let pool: pg.Pool | undefined;
let exitCode = 0;
try {
  const started = await manager.start();
  pool = new pg.Pool({ connectionString: started.connectionString, max: 4 });
  log("migrating");
  await runMigrations(pool, resolve(repoRoot, "packages/db/drizzle"), {
    seedFolder: resolve(repoRoot, "packages/db/seed")
  });
  log(`seeding two roots of ${options.chunks} chunks`);
  const seedClient = await pool.connect();
  let roots: [string, string];
  try {
    for (const step of bookPairSeedSteps({
      chunksPerRoot: options.chunks,
      chapters: options.chapters,
      chunksPerNote: 5,
      noteRelations: 30,
      entities: 50,
      dimensions: options.dimensions
    })) {
      const start = performance.now();
      await seedClient.query(step);
      log(
        `seed step ${(performance.now() - start).toFixed(0)} ms: ${step.slice(0, 60).replace(/\s+/gu, " ")}`
      );
    }
    const rows = (await seedClient.query<{ id: string }>("select id from t_pair_root order by r"))
      .rows;
    roots = [rows[0]!.id, rows[1]!.id];
  } finally {
    seedClient.release();
  }
  const [left, right] = roots;
  const repository = createSourceRelationRepository(pool);
  const timings = new Map<string, number[]>();
  const time = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    if (!timings.has(name)) log(`first ${name}`);
    const result = await work();
    timings.set(name, [...(timings.get(name) ?? []), performance.now() - start]);
    return result;
  };
  // The first root has matched before: the second's discovery sees it.
  const leftVector = await repository.discoveryVector(left);
  if (!leftVector) throw new Error("The seeded root has no composite vector.");
  await repository.planDiscovery({
    rootId: left,
    vector: leftVector,
    fingerprint: await repository.fingerprint(left),
    neighbours: 1
  });
  const perSource: number[] = [];
  for (let round = 0; round <= options.rounds; round++) {
    const start = performance.now();
    await time("promoteFromNotes", () => repository.promoteFromNotes(right));
    const vector = await time("discoveryVector", () => repository.discoveryVector(right));
    const fingerprint = await time("fingerprint (new root)", () => repository.fingerprint(right));
    await time("planDiscovery", () =>
      repository.planDiscovery({ rootId: right, vector: vector!, fingerprint, neighbours: 1 })
    );
    await time("fingerprint (neighbour)", () => repository.fingerprint(left));
    await time("pairNoteFingerprints", () => repository.pairNoteFingerprints(right, left));
    const notes = await time("pairNotes", () => repository.pairNotes(right, left, 4));
    await time("pairChunks", () =>
      repository.pairChunks(
        right,
        left,
        notes.flatMap((note) => [note.sourceChunkId, note.targetChunkId]),
        options.evidence
      )
    );
    await time("existing", () => repository.existing(right, left));
    const elapsed = performance.now() - start;
    if (round === 0) {
      // The warm-up round is not measured.
      for (const [name, list] of timings) timings.set(name, list.slice(1));
      continue;
    }
    perSource.push(elapsed);
  }
  // EXPLAIN every statement pairChunks sends, with its own parameters.
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const recording = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query")
        return async (text: string, values: unknown[] = []) => {
          statements.push({ text, values });
          return target.query(text, values);
        };
      return Reflect.get(target, property, receiver);
    }
  }) as pg.Pool;
  await createSourceRelationRepository(recording).pairChunks(right, left, [], options.evidence);
  const plans: Array<{ statement: number; executionMs: number; plan: string }> = [];
  for (const [index, statement] of statements.entries()) {
    const explained = await pool.query(
      `explain (analyze, buffers, format text) ${statement.text}`,
      statement.values
    );
    const plan = explained.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    const executionMs = Number(/Execution Time: ([\d.]+) ms/u.exec(plan)?.[1] ?? Number.NaN);
    plans.push({ statement: index + 1, executionMs, plan });
  }
  const steps = Object.fromEntries(
    [...timings.entries()].map(([name, list]) => [
      name,
      { p50: percentile(list, 0.5), p95: percentile(list, 0.95) }
    ])
  );
  const summary = {
    chunksPerRoot: options.chunks,
    chapters: options.chapters,
    dimensions: options.dimensions,
    rounds: options.rounds,
    evidenceChunks: options.evidence,
    perSource: { p50: percentile(perSource, 0.5), p95: percentile(perSource, 0.95) },
    steps,
    pairChunksStatements: plans.map(({ statement, executionMs }) => ({ statement, executionMs })),
    targetMs: options.targetMs,
    pass: percentile(perSource, 0.95) <= options.targetMs
  };
  console.info(
    [
      `# Design E SQL per source on two roots of ${options.chunks} chunks (${options.dimensions} dimensions)`,
      "",
      "| Step | p50 ms | p95 ms |",
      "| --- | ---: | ---: |",
      ...Object.entries(steps).map(
        ([name, value]) => `| ${name} | ${value.p50.toFixed(1)} | ${value.p95.toFixed(1)} |`
      ),
      `| **per source** | ${summary.perSource.p50.toFixed(1)} | ${summary.perSource.p95.toFixed(1)} |`,
      "",
      `pairChunks statements (EXPLAIN ANALYZE execution ms): ${plans
        .map((plan) => `#${plan.statement} ${plan.executionMs.toFixed(1)}`)
        .join(", ")}`,
      "",
      `S1 SQL bar (p95 per source <= ${options.targetMs} ms): ${summary.pass ? "PASS" : "FAIL"}`
    ].join("\n")
  );
  if (values.json) await writeFile(resolve(values.json), `${JSON.stringify(summary, null, 2)}\n`);
  if (values.plans)
    await writeFile(
      resolve(values.plans),
      plans.map((plan) => `-- statement ${plan.statement}\n${plan.plan}\n`).join("\n")
    );
  if (!summary.pass) exitCode = 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  if (pool) await pool.end();
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
