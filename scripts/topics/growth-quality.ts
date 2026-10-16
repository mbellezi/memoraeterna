// The growth-quality measure of T29b (registered in the T29b evidence before any run): a library
// grown source by source, in manifest order, against a fresh build of the same items.
//
// The replay follows the product (the real engine, real-engine.ts): rows wait in Unsorted until
// the cold start (bootstrap.minItems clusterable notes, then the small-library rule or Louvain);
// afterwards each source is one PLACE, the rebuild triggers are checked after it (as the service
// does after every PLACE), then one REBALANCE; naming is simulated (naming-sim.ts). Two calendars:
// `session` puts every source on one day (the in-app record runs of ENV-G and ENV-F, D23
// per-source arrival: every item is fresh), `daily` puts one source on each simulated day (the
// E1/E3 confirmation protocol: only the day's source is fresh).
//
// Readings against the fresh build (the product's cold start of all the rows, same seed):
// - agreement: leaf NMI and depth-1 NMI (as `topics:report` compares an export with a fresh
//   build), leaf purity of the grown tree against the fresh leaves (a grown leaf that mixes what
//   the fresh build separates scores low) and the reverse (a fresh leaf scattered over grown ones);
// - the fixture sanity check (ENV-F, spec section 8): expected root pairs share a leaf or sibling
//   leaves (same non-root parent) more often than forbidden pairs, read from each root's majority
//   leaf, beside the share of their note pairs that share a leaf.
import {
  defaultTopicTreeConfig,
  getTopic,
  leafLabels,
  nmi,
  primaryPlacement,
  purity,
  rowItemKey,
  shapeReport
} from "@app/domain/topic-tree";
import type {
  DetectCommunities,
  ItemKey,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { chronologicalOrder } from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { NamingSimulator } from "./naming-sim.js";
import { RealEngine } from "./real-engine.js";
import type { RealEngineOptions } from "./real-engine.js";
import type { OperationCounts, ReplayGate } from "./reference-engine.js";
import { configHash, summarizeShape } from "./report-data.js";
import type { ShapeSummary, TruthSummary } from "./report-data.js";
import { depthLabels, rowKeys, truthSummary } from "./replay-metrics.js";

export const growthCalendars = ["session", "daily"] as const;
export type GrowthCalendar = (typeof growthCalendars)[number];

/** A root source of the dataset with its rows in import order. */
export interface SourceRows {
  id: string;
  rows: number[];
}

/** The dataset's root sources in import (manifest) order. */
export function sourcesInOrder(dataset: Pick<ReplayDataset, "rows">): SourceRows[] {
  const sources: SourceRows[] = [];
  const index = new Map<string, number>();
  for (const row of chronologicalOrder(dataset)) {
    const id = dataset.rows[row]!.rootSourceId;
    let at = index.get(id);
    if (at === undefined) {
      at = sources.length;
      index.set(id, at);
      sources.push({ id, rows: [] });
    }
    sources[at]!.rows.push(row);
  }
  return sources;
}

/** Expected and forbidden root pairs of a fixture, by root source ID. */
export interface FixturePairs {
  expected: [string, string][];
  forbidden: [string, string][];
}

export interface PairReading {
  pairs: number;
  /** Both roots' majority leaves are the same topic. */
  sameLeaf: number;
  /** ... or sibling leaves under the same non-root parent. */
  sameLeafOrSibling: number;
  /** Mean over pairs of the share of their note pairs that share a leaf. */
  notePairsSameLeaf: number;
}

export interface FixtureReading {
  expected: PairReading;
  forbidden: PairReading;
  /** Expected pairs share a leaf or are siblings more often than forbidden pairs. */
  passes: boolean;
}

export interface Agreement {
  leafNmi: number;
  depth1Nmi: number;
  /** Purity of the grown leaves against the fresh leaves. */
  leafPurity: number;
  /** Purity of the fresh leaves against the grown leaves. */
  freshPurity: number;
}

export interface SourceGrowthReading {
  dataset: string;
  calendar: GrowthCalendar;
  seed: number;
  configHash: string;
  gate: ReplayGate;
  sources: number;
  rows: number;
  coldStartAt: number;
  rebuilds: { trigger: string; movedItems: number; atRows: number }[];
  operations: OperationCounts;
  naming: {
    named: number;
    renamed: Record<string, number>;
    calls: Record<string, number>;
    /** The most model calls of one simulated day. */
    peakDayCalls: Record<string, number>;
  };
  grown: ShapeSummary;
  fresh: ShapeSummary;
  agreement: Agreement;
  /** Against the dataset's own labels, where it has domains (DS-C). */
  truth: { grown: TruthSummary | null; fresh: TruthSummary | null };
  fixture: { grown: FixtureReading; fresh: FixtureReading } | null;
  ms: number;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

/** The majority primary leaf of each root's rows (ties: the smaller topic ID). */
function majorityLeaves(
  state: TopicTreeState,
  sources: readonly SourceRows[]
): Map<string, string> {
  const output = new Map<string, string>();
  for (const source of sources) {
    const counts = new Map<string, number>();
    for (const row of source.rows) {
      const topicId = primaryPlacement(state, rowItemKey(row))?.topicId;
      if (topicId !== undefined) counts.set(topicId, (counts.get(topicId) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [topicId, count] of counts) {
      const top = best === null ? 0 : (counts.get(best) as number);
      if (count > top || (count === top && best !== null && topicId < best)) best = topicId;
    }
    if (best !== null) output.set(source.id, best);
  }
  return output;
}

function pairReading(
  state: TopicTreeState,
  pairs: readonly [string, string][],
  sources: readonly SourceRows[]
): PairReading {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const majority = majorityLeaves(state, sources);
  let counted = 0;
  let sameLeaf = 0;
  let near = 0;
  let notePairs = 0;
  for (const [a, b] of pairs) {
    const left = byId.get(a);
    const right = byId.get(b);
    const leafA = majority.get(a);
    const leafB = majority.get(b);
    if (!left || !right || leafA === undefined || leafB === undefined) continue;
    counted += 1;
    const parentA = getTopic(state, leafA).parentId;
    const parentB = getTopic(state, leafB).parentId;
    if (leafA === leafB) sameLeaf += 1;
    if (leafA === leafB || (parentA === parentB && parentA !== state.rootId)) near += 1;
    let shared = 0;
    for (const x of left.rows) {
      const tx = primaryPlacement(state, rowItemKey(x))?.topicId;
      for (const y of right.rows) {
        if (tx !== undefined && tx === primaryPlacement(state, rowItemKey(y))?.topicId) shared += 1;
      }
    }
    notePairs += shared / (left.rows.length * right.rows.length);
  }
  const share = (count: number): number => (counted > 0 ? round(count / counted) : 0);
  return {
    pairs: counted,
    sameLeaf: share(sameLeaf),
    sameLeafOrSibling: share(near),
    notePairsSameLeaf: share(notePairs)
  };
}

/** The fixture sanity check of spec section 8 on one tree. */
export function fixtureReading(
  state: TopicTreeState,
  pairs: FixturePairs,
  sources: readonly SourceRows[]
): FixtureReading {
  const expected = pairReading(state, pairs.expected, sources);
  const forbidden = pairReading(state, pairs.forbidden, sources);
  return {
    expected,
    forbidden,
    passes: expected.sameLeafOrSibling > forbidden.sameLeafOrSibling
  };
}

/** Agreement of a grown tree with a fresh build over the same rows. */
export function agreement(
  grown: TopicTreeState,
  fresh: TopicTreeState,
  keys: readonly ItemKey[]
): Agreement {
  const grownLeaves = leafLabels(grown, keys);
  const freshLeaves = leafLabels(fresh, keys);
  return {
    leafNmi: round(nmi(grownLeaves, freshLeaves)),
    depth1Nmi: round(nmi(depthLabels(grown, keys, 1), depthLabels(fresh, keys, 1))),
    leafPurity: round(purity(grownLeaves, freshLeaves)),
    freshPurity: round(purity(freshLeaves, grownLeaves))
  };
}

export interface SourceGrowthOptions {
  calendar: GrowthCalendar;
  seed: number;
  config?: TopicTreeConfig;
  detect: DetectCommunities;
  gate?: ReplayGate;
  /** `naming.renameDrift` values simulated side by side (default: the configured one). */
  renameDrifts?: readonly number[];
  pairs?: FixturePairs;
  engine?: Omit<RealEngineOptions, "gate" | "areasActive">;
}

function shapeOf(state: TopicTreeState, config: TopicTreeConfig, rows: readonly number[]) {
  return summarizeShape(
    shapeReport(state, config, { expectedItems: rowKeys(rows) }),
    getTopic(state, state.rootId).children.length
  );
}

/** Grows the dataset source by source and compares the result with a fresh build. */
export function sourceGrowthRun(
  dataset: ReplayDataset,
  options: SourceGrowthOptions
): SourceGrowthReading {
  const started = performance.now();
  const config = options.config ?? defaultTopicTreeConfig;
  const gate = options.gate ?? "baseline";
  const input = { matrix: dataset.matrix, config, seed: options.seed, detect: options.detect };
  const engine = new RealEngine(input, {
    ...options.engine,
    gate,
    areasActive: "dynamic"
  });
  const thresholds = [...(options.renameDrifts ?? [config.naming.renameDrift])];
  const naming = new NamingSimulator(thresholds, config.naming.maxTopicsPerCall);
  const sources = sourcesInOrder(dataset);
  const operations: OperationCounts = {};
  const add = (from: OperationCounts): void => {
    for (const [kind, count] of Object.entries(from)) {
      const name = kind as keyof OperationCounts;
      operations[name] = (operations[name] ?? 0) + (count ?? 0);
    }
  };
  const rebuilds: SourceGrowthReading["rebuilds"] = [];
  const dayCalls = new Map<number, Map<string, number>>();
  const countCalls = (day: number, calls: Record<string, number>): void => {
    const today = dayCalls.get(day) ?? new Map<string, number>();
    for (const [threshold, count] of Object.entries(calls)) {
      today.set(threshold, (today.get(threshold) ?? 0) + count);
    }
    dayCalls.set(day, today);
  };
  const waiting: number[] = [];
  let coldStartAt = 0;
  let placed = 0;
  sources.forEach((source, index) => {
    const day = options.calendar === "daily" ? index + 1 : 1;
    if (coldStartAt === 0) {
      waiting.push(...source.rows);
      if (waiting.length < config.bootstrap.minItems) return;
      engine.coldStart(waiting, day);
      coldStartAt = waiting.length;
      placed = waiting.length;
      countCalls(day, naming.step(engine.state).calls);
      return;
    }
    engine.place(source.rows, { day });
    placed += source.rows.length;
    const rebuilt = engine.evaluateRebuild({ day });
    if (rebuilt) rebuilds.push({ ...rebuilt, atRows: placed });
    add(engine.rebalance({ day }).operations);
    countCalls(day, naming.step(engine.state).calls);
  });
  const rows = sources.flatMap((source) => source.rows).sort((a, b) => a - b);
  const week = naming.takeWeek(engine.state);
  const fresh = new RealEngine(input, { gate, areasActive: "dynamic" });
  fresh.coldStart(rows, 1);
  const keys = rowKeys(rows);
  const peakDayCalls: Record<string, number> = {};
  for (const threshold of thresholds) {
    const name = String(threshold);
    peakDayCalls[name] = Math.max(0, ...[...dayCalls.values()].map((day) => day.get(name) ?? 0));
  }
  return {
    dataset: dataset.name,
    calendar: options.calendar,
    seed: options.seed,
    configHash: configHash(config),
    gate,
    sources: sources.length,
    rows: rows.length,
    coldStartAt,
    rebuilds,
    operations,
    naming: { named: week.named, renamed: week.renamed, calls: week.calls, peakDayCalls },
    grown: shapeOf(engine.state, config, rows),
    fresh: shapeOf(fresh.state, config, rows),
    agreement: agreement(engine.state, fresh.state, keys),
    truth: {
      grown: truthSummary(engine.state, dataset, rows),
      fresh: truthSummary(fresh.state, dataset, rows)
    },
    fixture: options.pairs
      ? {
          grown: fixtureReading(engine.state, options.pairs, sources),
          fresh: fixtureReading(fresh.state, options.pairs, sources)
        }
      : null,
    ms: round(performance.now() - started, 1)
  };
}
