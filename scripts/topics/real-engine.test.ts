import { describe, expect, it } from "vitest";

import {
  canonicalStateDump,
  defaultTopicTreeConfig,
  getTopic,
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
import { createRealEngine, createRealEngineFactory, neutralStability } from "./real-engine.js";
import type { RealEngineOptions } from "./real-engine.js";
import { reportedMargins } from "./reference-engine.js";
import type { ReplayEngine } from "./reference-engine.js";
import { rowKeys } from "./replay-metrics.js";
import { syntheticDataset } from "./synthetic-dataset.js";

const dataset = syntheticDataset();
const rows = shuffledOrder(dataset, 5);

function engineOf(
  config: TopicTreeConfig = defaultTopicTreeConfig,
  options: RealEngineOptions = {},
  seed = 11
): ReplayEngine {
  return createRealEngineFactory(options)({
    matrix: dataset.matrix,
    config,
    seed,
    detect: detectCommunitiesLouvain
  });
}

const applied = (counts: Record<string, number | undefined>): number =>
  Object.values(counts).reduce<number>((total, count) => total + (count ?? 0), 0);

// Small leaves overflow their soft maximum (8) as rows arrive, so REBALANCE has soft work.
const crowded = topicTreeConfigWith({
  leaf: { min: 2, target: 5, max: 8 },
  repair: { cooldownInserts: 0 }
});

describe("the real engine", () => {
  it("names itself and its gate, and starts from the reference's Louvain build", () => {
    const engine = engineOf();
    expect(engine.name).toBe("t07-t08/gate-baseline");
    expect(engine.gate).toBe("baseline");
    expect(engineOf(defaultTopicTreeConfig, { gate: "off" }).gate).toBe("off");
    const build = engine.build(rows.slice(0, 300));
    expect(build.rows).toBe(300);
    expect(engine.state.items.size).toBe(300);
    expect(getTopic(engine.state, engine.state.rootId).children.length).toBeGreaterThan(1);
  });

  it("places through PLACE without changing structure, then REBALANCE keeps the tree valid", () => {
    const engine = engineOf();
    engine.build(rows.slice(0, 300));
    const topics = engine.state.topics.size;
    const placed = engine.place(rows.slice(300));
    expect(placed.placed).toBe(rows.length - 300);
    // PLACE never creates a topic; REBALANCE does the structural work.
    expect(engine.state.topics.size).toBe(topics);
    // Idempotent: placed rows are skipped.
    expect(engine.place(rows.slice(300)).placed).toBe(0);
    const gated = reportedMargins.map((margin) => placed.gatedAtMargin[String(margin)] ?? 0);
    expect(gated).toEqual([...gated].sort((a, b) => a - b));
    expect(placed.ambiguous + placed.unadmitted).toBeLessThanOrEqual(placed.placed);
    engine.rebalance({ day: 1 });
    engine.settle();
    const shape = shapeReport(engine.state, defaultTopicTreeConfig, {
      expectedItems: rowKeys(rows)
    });
    expect(shape.reachability).toBe(1);
    expect(shape.violations.hardCount).toBe(0);
  });

  it("fixes a leaf past its hard limit at the day's REBALANCE, whatever the budget", () => {
    const tight = topicTreeConfigWith({
      leaf: { min: 2, target: 6, max: 12, hardMax: 14 },
      repair: { mergeMaxSize: 12 },
      bootstrap: { singleTopicMaxItems: 12 },
      stability: { dailyOperations: 0, dailyMovedShare: 0, dailyMovedMin: 0 }
    });
    const engine = engineOf(tight);
    engine.build(rows.slice(0, 60));
    engine.place(rows.slice(60, 400));
    engine.rebalance({ day: 1 });
    for (const leaf of leafTopics(engine.state)) {
      if (leaf.id === engine.state.rootId) continue;
      expect(leaf.items.length).toBeLessThanOrEqual(tight.leaf.hardMax);
    }
  });

  it("gate off leaves ambiguous items waiting at an ancestor; baseline puts them on a leaf", () => {
    // The synthetic clusters are well apart: a wide margin makes sibling leaves ambiguous.
    const wide = topicTreeConfigWith({ placement: { ambiguityMargin: 0.3 } });
    const off = engineOf(wide, { gate: "off" });
    const baseline = engineOf(wide);
    for (const engine of [off, baseline]) engine.build(rows.slice(0, 300));
    const waitingOff = off.place(rows.slice(300));
    baseline.place(rows.slice(300));
    expect(waitingOff.ambiguous).toBeGreaterThan(0);
    const waiting = (engine: ReplayEngine): number =>
      rows
        .slice(300)
        .filter((row) => primaryPlacement(engine.state, rowItemKey(row))?.needsGate === true)
        .length;
    expect(waiting(off)).toBe(waitingOff.ambiguous);
    expect(waiting(baseline)).toBe(0);
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
    expect(applied(frozen.operations)).toBe(0);

    engine.setFrozen(new Set());
    const thawed = engine.rebalance({ day: 2 });
    expect(thawed.skippedFrozen).toBe(0);
    expect(applied(thawed.operations)).toBeGreaterThan(0);
    expect(thawed.movedItems).toBeGreaterThan(0);
  });

  it("limits soft operations per simulated day and renews the budget the next day", () => {
    const limited = topicTreeConfigWith({ stability: { dailyOperations: 1 } }, crowded);
    const engine = engineOf(limited);
    engine.build(rows.slice(0, 300));
    engine.place(rows.slice(300));
    const first = engine.rebalance({ day: 1 });
    expect(first.skippedBudget).toBeGreaterThan(0);
    const second = engine.rebalance({ day: 2 });
    expect(applied(second.operations)).toBeGreaterThan(0);
    const again = engine.rebalance({ day: 2 });
    expect(applied(again.operations)).toBe(0);
    expect(again.skippedBudget).toBeGreaterThan(0);
  });

  it("rejects soft operations whose churn outweighs their gain as lambda grows", () => {
    const run = (churnWeight: number): number => {
      const engine = engineOf(topicTreeConfigWith({ stability: { churnWeight } }, crowded));
      engine.build(rows.slice(0, 300));
      engine.place(rows.slice(300));
      return engine.rebalance({ day: 1 }).movedItems;
    };
    expect(run(0)).toBeGreaterThan(0);
    expect(run(100)).toBeLessThan(run(0));
  });

  it("audits before every REBALANCE and undoes each REBALANCE change-set exactly on a copy", () => {
    const engine = engineOf(crowded, { undoCheck: true });
    engine.build(rows.slice(0, 300));
    engine.place(rows.slice(300));
    const dump = canonicalStateDump(engine.state);
    const result = engine.rebalance({ day: 1 });
    expect(applied(result.operations)).toBeGreaterThan(0);
    // The check runs on a copy: the live tree keeps the REBALANCE.
    expect(canonicalStateDump(engine.state)).not.toBe(dump);
    const checks = engine.engineAudit?.();
    expect(checks?.audits).toBe(1);
    expect(checks?.undoChecked).toBe(1);
    expect(checks?.undoExact).toBe(1);
  });

  it("shares one base build between engines through the build cache", () => {
    const buildCache: NonNullable<RealEngineOptions["buildCache"]> = new Map();
    const first = engineOf(defaultTopicTreeConfig, { buildCache });
    first.build(rows.slice(0, 300));
    first.place(rows.slice(300, 340));
    const other = engineOf(
      topicTreeConfigWith({ stability: { churnWeight: 3 }, repair: { cooldownInserts: 99 } }),
      { buildCache }
    );
    other.build(rows.slice(0, 300));
    expect(buildCache.size).toBe(1);
    // The second engine got its own copy, untouched by the first one's placements.
    expect(other.state.items.size).toBe(300);
    expect(other.state).not.toBe(first.state);
    // A builder setting changes the key.
    engineOf(topicTreeConfigWith({ leaf: { max: 28 } }), { buildCache }).build(rows.slice(0, 300));
    expect(buildCache.size).toBe(2);
  });

  it("is deterministic for the same seed and input order", () => {
    const run = (): string => {
      const engine = createRealEngine({
        matrix: dataset.matrix,
        config: crowded,
        seed: 3,
        detect: detectCommunitiesLouvain
      });
      engine.build(rows.slice(0, 250));
      engine.place(rows.slice(250, 330));
      engine.rebalance({ day: 1 });
      engine.place(rows.slice(330));
      engine.rebalance({ day: 2 });
      return canonicalStateDump(engine.state);
    };
    expect(run()).toBe(run());
  });
});

describe("neutralStability", () => {
  it("lifts the daily budgets and keeps lambda and everything else", () => {
    const neutral = neutralStability(defaultTopicTreeConfig);
    expect(neutral.stability.churnWeight).toBe(defaultTopicTreeConfig.stability.churnWeight);
    expect(neutral.stability.dailyMovedShare).toBe(1);
    expect(neutral.stability.dailyOperations).toBeGreaterThanOrEqual(100_000);
    expect(neutral.repair).toEqual(defaultTopicTreeConfig.repair);
    expect(neutral.leaf).toEqual(defaultTopicTreeConfig.leaf);
  });
});
