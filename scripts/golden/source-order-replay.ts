/**
 * The source-order replay of design E (F3 S1, D27): over recorded judge verdicts, the source layer
 * is rebuilt for many random arrival orders of the roots, with the matcher's own discovery
 * (`selectDiscoveryPairs` of `@app/domain`). Per order: promotion links the root pairs that typed
 * applied note relations join; discovery judges each new root against its nearest unlinked earlier
 * root and its reverse neighbours; an accepted verdict links the pair. The report counts the
 * expected and forbidden root pairs the layer links in each order, the calls per source, and the
 * pairs some order reaches that no recording judged (to be judged once, live).
 *
 *   npx tsx scripts/golden/source-order-replay.ts --input <replay-input.json> [--orders 2000]
 *     [--neighbours 1] [--min-expected 27] [--json <out.json>] [--out <report.md>]
 *
 * Pure: no database and no model; order i is the mulberry32 shuffle of seed i (1..orders).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  compareDiscoveryCandidates,
  selectDiscoveryPairs,
  type DiscoveryCandidate,
  type DiscoveryPair
} from "@app/domain";

const pairSchema = z.tuple([z.string().min(1), z.string().min(1)]);
export const replayInputSchema = z
  .object({
    format: z.literal("memora-source-order-replay-input"),
    version: z.literal(1),
    /** Roots with their composite vectors (one space) and whether they have current notes. */
    roots: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string(),
            vector: z.array(z.number().finite()).min(1),
            hasNotes: z.boolean()
          })
          .strict()
      )
      .min(1),
    /** Root pairs promotion links (a typed applied note relation joins them). */
    promoted: z.array(pairSchema),
    /** Recorded judge verdicts per unordered root pair: accepted means a relation passed the floors. */
    verdicts: z.array(z.object({ pair: pairSchema, accepted: z.boolean() }).strict()),
    expected: z.array(pairSchema),
    forbidden: z.array(pairSchema)
  })
  .strict();
export type ReplayInput = z.infer<typeof replayInputSchema>;

export interface OrderOutcome {
  seed: number;
  expected: number;
  forbidden: number;
  calls: number;
  /** Pairs this order judged that no recording judged (counted as not accepted). */
  unjudged: string[];
  /** Pairs discovery selected that the `pairGate` kept from being judged (none without a gate). */
  skipped: string[];
  /** Arrivals that had at least one pair to judge: the calls of a judge that takes a root in one call. */
  batches: number;
}

/** What a gate sees of one pair discovery selected for the arriving root (T71, option 2 of F4). */
export interface SelectedPairContext {
  rootId: string;
  candidateId: string;
  reason: DiscoveryPair["reason"];
  cosine: number;
  /** 1 or 2 when the candidate is among the arriving root's nearest unlinked roots, else null. */
  nearestRank: number | null;
  /** Cosine of the arriving root's nearest unlinked candidate; null without one. */
  nearestCosine: number | null;
  /** Cosine of the candidate and the root discovery stored as its nearest; null without one. */
  candidateNearestCosine: number | null;
}

/** Whether a selected pair is judged; a pair a gate refuses costs no call and is never linked. */
export type PairGate = (context: SelectedPairContext) => boolean;

export interface ReplayReport {
  format: "memora-source-order-replay";
  version: 1;
  orders: number;
  neighbours: number;
  roots: number;
  expectedTotal: number;
  forbiddenTotal: number;
  minExpected: number;
  expected: { min: number; max: number; mean: number; ordersAtLeastMin: number; share: number };
  forbidden: { max: number; ordersWithAny: number };
  callsPerSource: { mean: number; max: number };
  /** Every pair some order judged with no recorded verdict, with how many orders reached it. */
  unjudged: Array<{ pair: [string, string]; orders: number }>;
  /** Pass: 0 forbidden in every order and at least `minExpected` in 95% of orders (S1). */
  pass: boolean;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Deterministic generator (mulberry32), the spikes' convention. */
export function seededRandom(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher-Yates shuffle of the root IDs by seed. */
export function shuffledOrder(ids: readonly string[], seed: number): string[] {
  const random = seededRandom(seed);
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! * a[i]!;
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** The source layer of one arrival order. */
export function replayOrder(
  input: ReplayInput,
  order: readonly string[],
  options: {
    neighbours: number;
    seed?: number;
    pairGate?: PairGate;
    /** A shared cosine memo (`replaySourceOrders` passes one); defaults to computing each time. */
    cosineOf?: (a: string, b: string) => number;
  }
): OrderOutcome {
  const roots = new Map(input.roots.map((root) => [root.id, root]));
  const promoted = new Set(input.promoted.map(([a, b]) => pairKey(a, b)));
  const verdicts = new Map(
    input.verdicts.map((verdict) => [pairKey(...verdict.pair), verdict.accepted])
  );
  const linked = new Set<string>();
  const state = new Map<string, { nearestRootId: string | null; nearestCosine: number | null }>();
  const arrived: string[] = [];
  const unjudged = new Set<string>();
  const skipped = new Set<string>();
  const cosineOf =
    options.cosineOf ??
    ((a: string, b: string) => cosine(roots.get(a)!.vector, roots.get(b)!.vector));
  let calls = 0;
  let batches = 0;
  for (const rootId of order) {
    const root = roots.get(rootId);
    if (!root) continue;
    // Promotion: the root's note relations to roots already here link them with no call.
    for (const other of arrived)
      if (promoted.has(pairKey(rootId, other))) linked.add(pairKey(rootId, other));
    const candidates: DiscoveryCandidate[] = arrived
      .filter((other) => roots.get(other)!.hasNotes)
      .map((other) => {
        const known = state.get(other) ?? { nearestRootId: null, nearestCosine: null };
        const otherRoot = roots.get(other)!;
        return {
          rootId: other,
          title: otherRoot.title,
          cosine: cosineOf(rootId, other),
          linked: linked.has(pairKey(rootId, other)),
          nearestRootId: known.nearestRootId,
          nearestCosine: known.nearestCosine,
          nearestRootCosine: known.nearestRootId ? cosineOf(other, known.nearestRootId) : null
        };
      });
    const ranked = options.pairGate
      ? candidates.filter((candidate) => !candidate.linked).toSorted(compareDiscoveryCandidates)
      : [];
    const selection = selectDiscoveryPairs({ rootId, candidates, neighbours: options.neighbours });
    state.set(rootId, selection.state);
    for (const update of selection.reverse)
      state.set(update.rootId, {
        nearestRootId: update.nearestRootId,
        nearestCosine: update.nearestCosine
      });
    let judgedHere = 0;
    for (const pair of selection.pairs) {
      const key = pairKey(rootId, pair.rootId);
      if (options.pairGate) {
        const position = ranked.findIndex((candidate) => candidate.rootId === pair.rootId);
        const candidate = candidates.find((item) => item.rootId === pair.rootId)!;
        const keep = options.pairGate({
          rootId,
          candidateId: pair.rootId,
          reason: pair.reason,
          cosine: pair.cosine,
          nearestRank: position >= 0 && position < 2 ? position + 1 : null,
          nearestCosine: ranked[0]?.cosine ?? null,
          candidateNearestCosine: candidate.nearestRootCosine
        });
        if (!keep) {
          skipped.add(key);
          continue;
        }
      }
      calls += 1;
      judgedHere += 1;
      const verdict = verdicts.get(key);
      if (verdict === undefined) unjudged.add(key);
      else if (verdict) linked.add(key);
    }
    if (judgedHere) batches += 1;
    arrived.push(rootId);
  }
  const count = (pairs: ReadonlyArray<readonly [string, string]>) =>
    pairs.filter(([a, b]) => linked.has(pairKey(a, b))).length;
  return {
    seed: options.seed ?? 0,
    expected: count(input.expected),
    forbidden: count(input.forbidden),
    calls,
    unjudged: [...unjudged].sort(),
    skipped: [...skipped].sort(),
    batches
  };
}

/** The per-order outcomes of `orders` seeded orders (seeds 1..orders), sharing one cosine memo. */
export function replayOutcomes(
  input: ReplayInput,
  options: { orders: number; neighbours: number; pairGate?: PairGate }
): OrderOutcome[] {
  const ids = input.roots.map((root) => root.id).sort();
  const vectors = new Map(input.roots.map((root) => [root.id, root.vector]));
  const memo = new Map<string, number>();
  const cosineOf = (a: string, b: string) => {
    const key = pairKey(a, b);
    let value = memo.get(key);
    if (value === undefined) {
      value = cosine(vectors.get(a)!, vectors.get(b)!);
      memo.set(key, value);
    }
    return value;
  };
  const outcomes: OrderOutcome[] = [];
  for (let seed = 1; seed <= options.orders; seed++)
    outcomes.push(
      replayOrder(input, shuffledOrder(ids, seed), {
        neighbours: options.neighbours,
        seed,
        cosineOf,
        ...(options.pairGate ? { pairGate: options.pairGate } : {})
      })
    );
  return outcomes;
}

/** S1's order replay: `orders` seeded orders (seeds 1..orders). */
export function replaySourceOrders(
  input: ReplayInput,
  options: { orders: number; neighbours: number; minExpected: number; pairGate?: PairGate }
): ReplayReport {
  const ids = input.roots.map((root) => root.id).sort();
  const outcomes = replayOutcomes(input, options);
  const expected = outcomes.map((outcome) => outcome.expected);
  const atLeast = expected.filter((value) => value >= options.minExpected).length;
  const forbiddenMax = Math.max(0, ...outcomes.map((outcome) => outcome.forbidden));
  const unjudged = new Map<string, number>();
  for (const outcome of outcomes)
    for (const key of outcome.unjudged) unjudged.set(key, (unjudged.get(key) ?? 0) + 1);
  const share = outcomes.length ? atLeast / outcomes.length : 0;
  const callsPerSource = outcomes.map((outcome) => outcome.calls / Math.max(1, ids.length));
  return {
    format: "memora-source-order-replay",
    version: 1,
    orders: outcomes.length,
    neighbours: options.neighbours,
    roots: ids.length,
    expectedTotal: input.expected.length,
    forbiddenTotal: input.forbidden.length,
    minExpected: options.minExpected,
    expected: {
      min: Math.min(...expected),
      max: Math.max(...expected),
      mean: expected.reduce((sum, value) => sum + value, 0) / Math.max(1, expected.length),
      ordersAtLeastMin: atLeast,
      share
    },
    forbidden: {
      max: forbiddenMax,
      ordersWithAny: outcomes.filter((outcome) => outcome.forbidden > 0).length
    },
    callsPerSource: {
      mean:
        callsPerSource.reduce((sum, value) => sum + value, 0) / Math.max(1, callsPerSource.length),
      max: Math.max(0, ...callsPerSource)
    },
    unjudged: [...unjudged.entries()]
      .map(([key, orders]) => ({ pair: key.split("|") as [string, string], orders }))
      .sort((a, b) => b.orders - a.orders || (a.pair.join() < b.pair.join() ? -1 : 1)),
    pass: forbiddenMax === 0 && share >= 0.95
  };
}

export function renderReplayMarkdown(report: ReplayReport): string {
  return [
    `# Source-order replay (design E, ${report.neighbours} neighbour${report.neighbours === 1 ? "" : "s"})`,
    "",
    `${report.orders} orders over ${report.roots} roots (seeds 1..${report.orders}).`,
    "",
    "| Measure | Value |",
    "| --- | ---: |",
    `| Expected linked, min / mean / max (of ${report.expectedTotal}) | ${report.expected.min} / ${report.expected.mean.toFixed(2)} / ${report.expected.max} |`,
    `| Orders with at least ${report.minExpected} expected | ${report.expected.ordersAtLeastMin} (${(report.expected.share * 100).toFixed(1)}%) |`,
    `| Forbidden linked, max (of ${report.forbiddenTotal}) | ${report.forbidden.max} |`,
    `| Orders with a forbidden pair | ${report.forbidden.ordersWithAny} |`,
    `| Judge calls per source, mean / max | ${report.callsPerSource.mean.toFixed(2)} / ${report.callsPerSource.max.toFixed(2)} |`,
    `| Pairs reached with no recorded verdict | ${report.unjudged.length} |`,
    "",
    `S1 order replay: ${report.pass ? "PASS" : "FAIL"} (0 forbidden in every order and at least ${report.minExpected} expected in 95% of orders).`,
    ...(report.unjudged.length
      ? [
          "",
          "Pairs to judge once, live (orders reaching them):",
          "",
          ...report.unjudged.map((item) => `- ${item.pair[0]} / ${item.pair[1]}: ${item.orders}`)
        ]
      : []),
    ""
  ].join("\n");
}

export const sourceOrderReplayUsage = `Source-order replay of design E (F3 S1).

  --input <file>          A memora-source-order-replay-input JSON file.
  --orders <n>            Seeded orders (default 2000).
  --neighbours <1|2>      Discovery neighbours (default 1).
  --min-expected <n>      Expected pairs an order must link (default 27).
  --json <file>           Also write the report as JSON.
  --out <file.md>         Write the Markdown report here (default: print it).
  --help                  Show this text.`;

export async function runSourceOrderReplay(argv: readonly string[]): Promise<string | null> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      input: { type: "string" },
      orders: { type: "string" },
      neighbours: { type: "string" },
      "min-expected": { type: "string" },
      json: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return sourceOrderReplayUsage;
  if (!values.input) throw new Error("--input is required.");
  const input = replayInputSchema.parse(JSON.parse(await readFile(resolve(values.input), "utf8")));
  const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      throw new Error(`Expected an integer from ${min} to ${max}, got ${value}.`);
    return parsed;
  };
  const report = replaySourceOrders(input, {
    orders: integer(values.orders, 2000, 1, 100_000),
    neighbours: integer(values.neighbours, 1, 1, 2),
    minExpected: integer(values["min-expected"], 27, 0, 100_000)
  });
  const write = async (path: string, content: string) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (values.json) await write(values.json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderReplayMarkdown(report);
  if (values.out) {
    await write(values.out, markdown);
    return null;
  }
  return markdown;
}

if (import.meta.main) {
  try {
    const output = await runSourceOrderReplay(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(
      `[source-order-replay] ${error instanceof Error ? error.message : String(error)}`
    );
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
