// Latency of `relations.branch` (F5 T133, D19: Map › Grafo; p95 <= 150 ms expected, calibrated).
//
//   npm run bench:branch -- --profile <abs dir>   a profile-shaped scratch clone under
//                                                 `.cache/f<N>/scratch/` (ENV-C, golden-small),
//                                                 started through `scripts/lib/profile-server.ts`
//   npm run bench:branch -- --db <connection.json | postgres url>   an existing database
//
// Both are read only (`default_transaction_read_only`). Each call is the desktop handler's work
// without the IPC hop: the repository's two statements in one snapshot plus the answer's Zod
// validation (`readRelationsBranch`). Scopes: the tree root, every level-1 topic and a seeded
// sample of level-2 and level-3 topics; the heaviest root sources and a seeded sample of the rest.
// The colour depth cycles 1, 2, 3 over the scopes; the limits are the defaults (400 notes, 80 per
// topic, 2,000 relations). One warm-up pass, then `--rounds` passes. The executed plans of three
// scopes (the median level-1 and level-2 topics and the heaviest source) are checked for sequential
// scans of the large tables; a failure there is the cue for the `root_source_id` lever (D27). The
// root's plan is not checked: its scope is every placed note, so reading a table whole is its job.
// The target holds per scope kind, so the root's few calls are never hidden in the pooled p95.
// Exit code 1 when a kind's p95 is above `--target-ms` or a checked plan reads a large table whole.
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import { createRelationBranchRepository } from "@app/db";

import {
  readRelationsBranch,
  type RelationsBranchReader
} from "../../apps/desktop/src/main/services/relations-branch-ipc.js";
import { resolveConnection } from "../kpi/connection.js";
import { startProfileServer, type ProfileServer } from "../lib/profile-server.js";

const usage = `Usage: npm run bench:branch -- (--profile <abs dir> | --db <connection.json | url>) [options]

  --profile <abs dir>  Start a scratch server on a profile-shaped clone under
                       <repo>/.cache/f<N>/scratch/ and measure it read-only.
  --db <value>         Scratch connection file or postgres:// URL; opened read-only.
  --topics <n>         Topic scopes measured: the root, every level-1 topic, then level 2 and 3
                       drawn by the seed (default 60).
  --sources <n>        Source scopes: half the heaviest root sources, half drawn (default 20).
  --rounds <n>         Passes over the scopes after one warm-up pass (default 5).
  --seed <n>           Seed of the sample (default 20261111).
  --target-ms <n>      p95 target of every scope kind; the exit code is 1 above it (default 150).
  --json <file>        Also write the measurements as JSON.
  --help               Show this text.`;

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    db: { type: "string" },
    topics: { type: "string" },
    sources: { type: "string" },
    rounds: { type: "string" },
    seed: { type: "string" },
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
if ([values.db, values.profile].filter(Boolean).length !== 1) {
  console.error(`Pass exactly one of --profile and --db.\n\n${usage}`);
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
const topicCount = integer(values.topics, 60, "topics");
const sourceCount = integer(values.sources, 20, "sources");
const rounds = integer(values.rounds, 5, "rounds");
const seed = integer(values.seed, 20_261_111, "seed");
const targetMs = integer(values["target-ms"], 150, "target-ms");

function log(message: string): void {
  console.error(`[branch-bench] ${message}`);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

/** Mulberry32: a small seeded generator, so a run draws the same scopes every time. */
function generator(start: number): () => number {
  let state = start >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function draw<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [pool[index], pool[other]] = [pool[other]!, pool[index]!];
  }
  return pool.slice(0, Math.max(0, count));
}

type Kind = "root" | "level 1" | "level 2" | "level 3" | "source";

interface Scope {
  kind: Kind;
  scope: { topicId: string } | { sourceId: string };
  /** Notes in the scope: the subtree's primary placements, or the root source's notes. */
  notes: number;
}

interface TopicRow {
  id: string;
  parentId: string | null;
  role: string;
  notes: number;
}

/** The live topics of the active tree with their own primary notes; subtree sizes are summed here. */
const topicsSql = `
select t.id, t.parent_id as "parentId", t.role,
       (select count(*)::int from topic_placements p
         where p.topic_id = t.id and p.item_kind = 'note' and p.rank = 0) as notes
  from topics t
 where t.retired_at is null
   and t.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')`;

/** Root sources with the notes created from them or from the sources below them. */
const sourcesSql = `
with recursive below(id, root_id, depth) as (
  select s.id, s.id, 0 from source_items s where s.parent_source_item_id is null
  union all
  select c.id, below.root_id, below.depth + 1
    from below join source_items c on c.parent_source_item_id = below.id
   where below.depth < 8
)
select below.root_id as id, count(n.id)::int as notes
  from below left join atomic_notes n on n.created_from_source_item_id = below.id
 group by below.root_id
having count(n.id) > 0
 order by notes desc, below.root_id`;

async function chooseScopes(pool: pg.Pool): Promise<Scope[]> {
  const random = generator(seed);
  const topics = (await pool.query<TopicRow>(topicsSql)).rows;
  const children = new Map<string, TopicRow[]>();
  for (const topic of topics)
    if (topic.parentId)
      children.set(topic.parentId, [...(children.get(topic.parentId) ?? []), topic]);
  const subtree = new Map<string, number>();
  const sizeOf = (topic: TopicRow): number => {
    const known = subtree.get(topic.id);
    if (known !== undefined) return known;
    const size =
      topic.notes + (children.get(topic.id) ?? []).reduce((sum, child) => sum + sizeOf(child), 0);
    subtree.set(topic.id, size);
    return size;
  };
  const root = topics.find((topic) => topic.role === "root");
  const scopes: Scope[] = [];
  const topicScope = (kind: Kind, topic: TopicRow): Scope => ({
    kind,
    scope: { topicId: topic.id },
    notes: sizeOf(topic)
  });
  if (root) {
    const levelOne = children.get(root.id) ?? [];
    const levelTwo = levelOne.flatMap((topic) => children.get(topic.id) ?? []);
    const levelThree = levelTwo.flatMap((topic) => children.get(topic.id) ?? []);
    scopes.push(topicScope("root", root));
    const firstLevel = draw(levelOne, topicCount - 1, random);
    scopes.push(...firstLevel.map((topic) => topicScope("level 1", topic)));
    const left = Math.max(0, topicCount - 1 - firstLevel.length);
    const second = draw(levelTwo, Math.ceil(left / 2), random);
    scopes.push(...second.map((topic) => topicScope("level 2", topic)));
    scopes.push(
      ...draw(levelThree, left - second.length, random).map((topic) => topicScope("level 3", topic))
    );
  }
  const sources = (await pool.query<{ id: string; notes: number }>(sourcesSql)).rows;
  const heaviest = sources.slice(0, Math.ceil(sourceCount / 2));
  const drawn = draw(sources.slice(heaviest.length), sourceCount - heaviest.length, random);
  scopes.push(
    ...[...heaviest, ...drawn].map((source): Scope => ({
      kind: "source",
      scope: { sourceId: source.id },
      notes: source.notes
    }))
  );
  return scopes;
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

/** Tables a branch must reach through an index, never by reading them whole. */
const guardedRelations = new Set([
  "atomic_note_relations",
  "atomic_notes",
  "topic_placements",
  "chunks",
  "documents"
]);

function sequentialRelations(node: PlanNode, found: Set<string> = new Set()): Set<string> {
  if (
    node["Node Type"].endsWith("Seq Scan") &&
    node["Relation Name"] &&
    guardedRelations.has(node["Relation Name"])
  )
    found.add(node["Relation Name"]);
  for (const child of node.Plans ?? []) sequentialRelations(child, found);
  return found;
}

const planRoot = (plan: unknown): PlanNode => (plan as Array<{ Plan: PlanNode }>)[0]!.Plan;

interface Call {
  kind: Kind;
  scope: string;
  colourDepth: 1 | 2 | 3;
  ms: number;
  nodes: number;
  edges: number;
  truncated: boolean;
}

interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function stats(times: readonly number[]): Stats {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? Number.NaN
  };
}

const fixed = (value: number) => (Number.isNaN(value) ? "-" : value.toFixed(1));

/** Applied migrations against the journal: a clone behind it must be migrated before timing. */
async function migrationsBehind(pool: pg.Pool): Promise<number> {
  const journal = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../../packages/db/drizzle/meta/_journal.json"),
      "utf8"
    )
  ) as { entries: unknown[] };
  const applied = await pool.query<{ n: number }>(
    "select count(*)::int as n from drizzle.__drizzle_migrations"
  );
  return journal.entries.length - applied.rows[0]!.n;
}

const startedAt = Date.now();
let profileServer: ProfileServer | null = null;
let pool: pg.Pool | null = null;
let exitCode: number;
try {
  let origin: string;
  let connectionString: string;
  if (values.db) {
    const connection = await resolveConnection(values.db);
    connectionString = connection.connectionString;
    origin = `${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`;
  } else {
    const repoRoot = resolve(import.meta.dirname, "../..");
    profileServer = await startProfileServer(values.profile!, { repoRoot });
    connectionString = profileServer.connectionString;
    origin = `scratch profile ${basename(profileServer.profileDir)}`;
  }
  pool = new pg.Pool({
    connectionString,
    max: 1,
    options: "-c default_transaction_read_only=on -c statement_timeout=60000"
  });
  const behind = await migrationsBehind(pool);
  if (behind > 0)
    throw new Error(
      `The database is ${behind} migration(s) behind the journal: migrate the clone once before timing it.`
    );
  const repository = createRelationBranchRepository(pool);
  const read: RelationsBranchReader = (request) => repository.read(request);
  const scopes = await chooseScopes(pool);
  if (scopes.length === 0) throw new Error("The database has no active topic tree and no source.");
  log(`${origin}: ${scopes.length} scopes, ${rounds} rounds after a warm-up pass`);

  const depthOf = (index: number) => ((index % 3) + 1) as 1 | 2 | 3;
  const calls: Call[] = [];
  for (let round = 0; round <= rounds; round += 1) {
    for (const [index, scope] of scopes.entries()) {
      const colourDepth = depthOf(index);
      const started = performance.now();
      const answer = await readRelationsBranch(read, { scope: scope.scope, colourDepth });
      const ms = performance.now() - started;
      if (!answer) throw new Error(`A sampled scope was not found: ${JSON.stringify(scope.scope)}`);
      if (round > 0)
        calls.push({
          kind: scope.kind,
          scope: Object.values(scope.scope)[0]!,
          colourDepth,
          ms,
          nodes: answer.nodes.length,
          edges: answer.edges.length,
          truncated: answer.truncated
        });
    }
  }

  const median = (kind: Kind) => {
    const list = scopes.filter((scope) => scope.kind === kind).sort((a, b) => a.notes - b.notes);
    return list[Math.floor((list.length - 1) / 2)];
  };
  const heaviestSource = scopes
    .filter((scope) => scope.kind === "source")
    .sort((a, b) => b.notes - a.notes)[0];
  const checked = [median("level 1"), median("level 2"), heaviestSource].filter(
    (scope): scope is Scope => scope !== undefined
  );
  const plans: { kind: Kind; scope: string; notes: number; sequential: string[] }[] = [];
  for (const scope of checked) {
    const explained = await repository.explain({
      scope: scope.scope,
      colourDepth: 1,
      noteLimit: 400,
      perTopicLimit: 80,
      relationLimit: 2000
    });
    if (!explained) continue;
    const sequential = new Set([
      ...sequentialRelations(planRoot(explained.topics)),
      ...sequentialRelations(planRoot(explained.graph))
    ]);
    plans.push({
      kind: scope.kind,
      scope: Object.values(scope.scope)[0]!,
      notes: scope.notes,
      sequential: [...sequential].sort()
    });
  }

  const all = stats(calls.map((call) => call.ms));
  const kinds: Kind[] = ["root", "level 1", "level 2", "level 3", "source"];
  const byKind = Object.fromEntries(
    kinds.map((kind) => [kind, stats(calls.filter((call) => call.kind === kind).map((c) => c.ms))])
  ) as Record<Kind, Stats>;
  const explainPass = plans.every((plan) => plan.sequential.length === 0);
  const measured = kinds.filter((kind) => byKind[kind].count > 0);
  const slowest = measured.reduce((x, y) => (byKind[y].p95 > byKind[x].p95 ? y : x));
  const latencyPass = measured.every((kind) => byKind[kind].p95 <= targetMs);
  const pass = latencyPass && explainPass;
  exitCode = pass ? 0 : 1;
  const row = (name: string, s: Stats) =>
    `| ${name} | ${s.count} | ${fixed(s.p50)} | ${fixed(s.p95)} | ${fixed(s.p99)} | ${fixed(s.max)} |`;
  const truncatedShare = calls.filter((call) => call.truncated).length / Math.max(1, calls.length);
  console.info(
    [
      `# relations.branch benchmark (${origin})`,
      "",
      `Scopes ${scopes.length} (seed ${seed}), rounds ${rounds}; colour depth cycles 1-3; limits 400 / 80 / 2,000.`,
      "",
      "| Scope | Calls | p50 | p95 | p99 | max |",
      "| --- | --- | --- | --- | --- | --- |",
      ...measured.map((kind) => row(kind, byKind[kind])),
      row("all", all),
      "",
      `Largest scope: ${Math.max(...scopes.map((scope) => scope.notes))} notes; truncated answers: ${(truncatedShare * 100).toFixed(0)}%; ` +
        `largest answer: ${Math.max(...calls.map((call) => call.nodes))} nodes, ${Math.max(...calls.map((call) => call.edges))} edges.`,
      `Target p95 <= ${targetMs} ms per scope kind (calibrated): ${latencyPass ? "PASS" : "FAIL"} ` +
        `(slowest: ${slowest} ${fixed(byKind[slowest].p95)} ms; ` +
        `over: ${measured.filter((kind) => byKind[kind].p95 > targetMs).join(", ") || "none"})`,
      "",
      "| Plan checked | Notes | Sequential scans of large tables |",
      "| --- | --- | --- |",
      ...plans.map(
        (plan) =>
          `| ${plan.kind} ${plan.scope.slice(0, 8)} | ${plan.notes} | ${plan.sequential.join(", ") || "none"} |`
      ),
      `EXPLAIN: ${explainPass ? "PASS" : "FAIL (consider the root_source_id lever, D27)"}`
    ].join("\n")
  );
  if (values.json)
    await writeFile(
      values.json,
      `${JSON.stringify({ origin, seed, rounds, targetMs, latencyPass, slowest, all, byKind, plans, calls }, null, 2)}\n`
    );
  log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  await pool?.end().catch(() => undefined);
  await profileServer?.stop().catch(() => undefined);
}
process.exit(exitCode);
