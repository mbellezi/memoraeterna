import { describe, expect, it } from "vitest";

import {
  defaultTopicTreeConfig,
  getTopic,
  isLeaf,
  leafTopics,
  primaryPlacement,
  rowItemKey,
  shapeReport,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { shuffledOrder } from "./datasets.js";
import { createReferenceEngine, reportedMargins } from "./reference-engine.js";
import type { ReplayEngine } from "./reference-engine.js";
import { rowKeys } from "./replay-metrics.js";
import { syntheticDataset } from "./synthetic-dataset.js";

const dataset = syntheticDataset();
const rows = shuffledOrder(dataset, 5); // arrivals from every cluster, as a real library sees

function engineOf(config: TopicTreeConfig = defaultTopicTreeConfig, seed = 11): ReplayEngine {
  return createReferenceEngine({
    matrix: dataset.matrix,
    config,
    seed,
    detect: detectCommunitiesLouvain
  });
}

// Small leaves overflow their soft maximum (8) as rows arrive, so REBALANCE has soft work.
const crowded = topicTreeConfigWith({
  leaf: { min: 2, target: 5, max: 8 },
  repair: { cooldownInserts: 0, cooldownShare: 0 }
});

describe("the reference engine", () => {
  it("builds, reports its timings and keeps the tree valid after placements", () => {
    const engine = engineOf();
    const build = engine.build(rows.slice(0, 400));
    expect(build.rows).toBe(400);
    expect(build.totalMs).toBeGreaterThan(0);
    expect(build.knnMs + build.communitiesMs + build.repairMs).toBeLessThanOrEqual(
      build.totalMs + 1
    );
    const placed = engine.place(rows.slice(400));
    expect(placed.placed).toBe(rows.length - 400);
    // PLACE is idempotent: placed rows are skipped.
    expect(engine.place(rows.slice(400)).placed).toBe(0);
    engine.rebalance({ day: 1 });
    engine.settle();
    const shape = shapeReport(engine.state, defaultTopicTreeConfig, {
      expectedItems: rowKeys(rows)
    });
    expect(shape.reachability).toBe(1);
    expect(shape.violations.hardCount).toBe(0);
  });

  it("counts gated placements per margin monotonically and unadmitted ones apart", () => {
    const engine = engineOf();
    engine.build(rows.slice(0, 300));
    const placed = engine.place(rows.slice(300));
    const gated = reportedMargins.map((margin) => placed.gatedAtMargin[String(margin)] ?? 0);
    expect(gated).toEqual([...gated].sort((a, b) => a - b));
    expect(gated.every((count) => count <= placed.placed)).toBe(true);
    expect(placed.ambiguous + placed.unadmitted).toBeLessThanOrEqual(placed.placed);
  });

  it("splits a leaf past its hard limit at once, before any REBALANCE", () => {
    const tight = topicTreeConfigWith({
      leaf: { min: 2, target: 6, max: 12, hardMax: 14 },
      repair: { mergeMaxSize: 12 },
      bootstrap: { singleTopicMaxItems: 12 }
    });
    const engine = engineOf(tight);
    // A tiny base, then a pile of rows into it: leaves would pass 14 without the hard split.
    engine.build(rows.slice(0, 30));
    engine.place(rows.slice(30, 400));
    for (const leaf of leafTopics(engine.state)) {
      expect(leaf.items.length).toBeLessThanOrEqual(tight.leaf.hardMax);
    }
  });

  it("repairs after every insert with localRepair (Spike B growth runs)", () => {
    const engine = engineOf(crowded);
    engine.build(rows.slice(0, 300));
    const placed = engine.place(rows.slice(300), { localRepair: true });
    expect(
      Object.values(placed.operations).reduce((total, count) => total + (count ?? 0), 0)
    ).toBeGreaterThan(0);
    for (const leaf of leafTopics(engine.state)) {
      expect(leaf.items.length).toBeLessThanOrEqual(crowded.leaf.hardMax);
    }
  });

  it("defers soft operations on frozen topics to the next REBALANCE instead of dropping them", () => {
    const engine = engineOf(crowded);
    engine.build(rows.slice(0, 300));
    engine.place(rows.slice(300));
    const everything = new Set<string>();
    walkTopics(engine.state, (node) => {
      everything.add(node.id);
    });
    engine.setFrozen(everything);
    const frozen = engine.rebalance({ day: 1 });
    expect(frozen.skippedFrozen).toBeGreaterThan(0);
    expect(Object.keys(frozen.operations)).toEqual([]);
    for (const id of everything) {
      expect(getTopic(engine.state, id).control.frozen).toBe(true);
    }

    engine.setFrozen(new Set());
    const thawed = engine.rebalance({ day: 2 });
    expect(thawed.skippedFrozen).toBe(0);
    expect(
      Object.values(thawed.operations).reduce((total, count) => total + (count ?? 0), 0)
    ).toBeGreaterThan(0);
    expect(thawed.movedItems).toBeGreaterThan(0);
  });

  it("limits soft operations per simulated day and renews the budget the next day", () => {
    const limited = topicTreeConfigWith({ stability: { dailyOperations: 1 } }, crowded);
    const engine = engineOf(limited);
    engine.build(rows.slice(0, 300));
    engine.place(rows.slice(300));
    const first = engine.rebalance({ day: 1 });
    const applied = (counts: Record<string, number | undefined>): number =>
      Object.values(counts).reduce<number>((total, count) => total + (count ?? 0), 0);
    expect(applied(first.operations)).toBeGreaterThan(0);
    // The first operation can cascade (an operation queues what it touched), but each is bounded
    // by the budget check: once one soft operation is spent, the rest are deferred.
    expect(first.skippedBudget).toBeGreaterThan(0);
    const second = engine.rebalance({ day: 2 });
    expect(applied(second.operations)).toBeGreaterThan(0);
    // Same day again: the budget is still spent.
    const again = engine.rebalance({ day: 2 });
    expect(applied(again.operations)).toBe(0);
  });

  it("places only the rows it is given", () => {
    const engine = engineOf();
    engine.build(rows.slice(0, 200));
    const [given, other] = [rows[250] as number, rows[251] as number];
    expect(primaryPlacement(engine.state, rowItemKey(given))).toBeUndefined();
    engine.place([given]);
    expect(primaryPlacement(engine.state, rowItemKey(given))).toBeDefined();
    expect(primaryPlacement(engine.state, rowItemKey(other))).toBeUndefined();
    expect(isLeaf(getTopic(engine.state, engine.state.rootId))).toBe(false);
  });
});
