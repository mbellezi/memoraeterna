import { describe, expect, it } from "vitest";

import {
  canonicalStateDump,
  createTopicTreeEditor,
  defaultTopicTreeConfig,
  getTopic,
  leafTopics,
  primaryPlacement,
  recomputeSubtree,
  rowItemKey,
  shapeReport,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { shuffledOrder } from "./datasets.js";
import {
  RealEngine,
  createRealEngine,
  createRealEngineFactory,
  neutralStability
} from "./real-engine.js";
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
  repair: { cooldownInserts: 0, cooldownShare: 0 }
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

describe("the real engine: fresh items, cold start and rebuild triggers (T29b)", () => {
  const engineWith = (config: TopicTreeConfig, options: RealEngineOptions = {}): RealEngine =>
    new RealEngine(
      { matrix: dataset.matrix, config, seed: 11, detect: detectCommunitiesLouvain },
      options
    );

  it("moves the day's arrivals for free with stability.freshHours, never older ones", () => {
    const strict = topicTreeConfigWith({ stability: { churnWeight: 100 } }, crowded);
    const run = (freshHours: number, day: number): number => {
      const engine = engineWith(topicTreeConfigWith({ stability: { freshHours } }, strict));
      // A library that arrived on day 1: the cold start and every placement are that day's.
      engine.coldStart(rows.slice(0, 300), 1);
      engine.place(rows.slice(300), { day: 1 });
      return engine.rebalance({ day }).movedItems;
    };
    // A heavy lambda refuses the soft splits of established items...
    const established = run(0, 1);
    // ...but the day's arrivals are fresh: moving them is no churn.
    expect(run(24, 1)).toBeGreaterThan(established);
    // A day later they are established again.
    expect(run(24, 2)).toBe(established);
  });

  it("starts small libraries with the small-library rule and larger ones with Louvain", () => {
    const small = engineWith(defaultTopicTreeConfig);
    small.coldStart(rows.slice(0, 20));
    const topics = getTopic(small.state, small.state.rootId).children;
    expect(topics.length).toBeGreaterThanOrEqual(1);
    expect(topics.length).toBeLessThanOrEqual(defaultTopicTreeConfig.bootstrap.maxInitialSplit);
    expect(small.state.placements.size).toBe(20);
    const large = engineWith(defaultTopicTreeConfig);
    expect(large.coldStart(rows.slice(0, 200)).rows).toBe(200);
    expect(large.state.placements.size).toBe(200);
  });

  it("rebuilds a young library that doubled, and holds a mature one's large rebuild", () => {
    const engine = engineWith(defaultTopicTreeConfig, { areasActive: "dynamic" });
    engine.coldStart(rows.slice(0, 40), 1);
    expect(engine.evaluateRebuild({ day: 1 })).toBeNull();
    engine.place(rows.slice(40, 90), { day: 2 });
    const rebuilt = engine.evaluateRebuild({ day: 2 });
    expect(rebuilt?.trigger).toBe("doubling");
    expect(rebuilt?.movedItems).toBeGreaterThan(0);
    const shape = shapeReport(engine.state, defaultTopicTreeConfig, {
      expectedItems: rowKeys(rows.slice(0, 90))
    });
    expect(shape.reachability).toBe(1);
    expect(shape.violations.hardCount).toBe(0);
    // The baseline moved with the rebuild: nothing triggers again at once.
    expect(engine.evaluateRebuild({ day: 2 })).toBeNull();
    // Past rebuild.doublingMaxItems the library is not young: a trigger rebuild that moves
    // established items waits for review, and holds every later one.
    const mature = topicTreeConfigWith({
      rebuild: { doublingMaxItems: 10, qualityDrop: 0, reviewChurnShare: 0 }
    });
    const old = engineWith(mature);
    old.coldStart(rows.slice(0, 300), 1);
    old.place(rows.slice(300), { day: 5 });
    expect(old.evaluateRebuild({ day: 9 })).toEqual({
      trigger: "quality-drop:review",
      movedItems: 0
    });
    expect(old.evaluateRebuild({ day: 10 })).toBeNull();
  });

  it("rejects a trigger rebuild that would leave the tree worse, and moves the baseline", () => {
    const engine = engineWith(defaultTopicTreeConfig, { areasActive: "dynamic" });
    engine.coldStart(rows.slice(0, 100), 1);
    engine.place(rows.slice(100, 200), { day: 2 });
    // Every leaf of the grown tree is cut into pairs: far more coherent leaves than any rebuild
    // at leaf.target makes, so the doubling rebuild would lower the coherence of what is placed.
    const editor = createTopicTreeEditor(engine.state, { record: false });
    let next = 1_000_000;
    for (const node of leafTopics(engine.state)) {
      if (node.parentId === null) continue;
      const items = [...node.items];
      for (let at = 2; at + 1 < items.length; at += 2) {
        const pair = String(next++);
        editor.createTopic(pair, node.parentId);
        for (const item of items.slice(at, at + 2)) {
          editor.updatePlacement(item, 0, { topicId: pair });
        }
      }
    }
    recomputeSubtree(engine.state, engine.vectors);
    const before = canonicalStateDump(engine.state);
    const rejected = engine.evaluateRebuild({ day: 2 });
    expect(rejected).toMatchObject({ trigger: "doubling:rejected", movedItems: 0 });
    expect(rejected?.rejectedBy).toContain("coherence");
    expect(canonicalStateDump(engine.state)).toBe(before);
    // The baseline is the tree left in place: the same trigger does not fire again.
    expect(engine.evaluateRebuild({ day: 3 })).toBeNull();
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
