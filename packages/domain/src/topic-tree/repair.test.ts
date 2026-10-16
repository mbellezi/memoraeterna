import { describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import {
  StructureEventSchema,
  applyEvents,
  createTopicTreeEditor,
  invertEvents
} from "./events.js";
import type { TopicTreeEditor } from "./events.js";
import { fixtureDay, fixtureNow, productTree, topicsByKind } from "./fixtures/trees.js";
import type { ProductTree } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import type { ItemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import { refreshTopics } from "./operations.js";
import { treeQuality } from "./quality.js";
import {
  churnWeightOf,
  hardViolationTopics,
  rebalanceTree,
  scopeHardViolations
} from "./repair.js";
import type { RebalanceInput, RebalanceResult } from "./repair.js";
import { createRng } from "./rng.js";
import type { Rng } from "./rng.js";
import { setFrozenTopics } from "./stability.js";
import {
  canonicalStateDump,
  cloneTopicTreeState,
  depthOf,
  getTopic,
  heightOf,
  isLive,
  liveTopicIds,
  pathOf,
  placementRecord,
  placementsOf,
  walkTopics
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree, statsDump } from "./stats.js";

// The mechanics are tested at the stability start values; the defaults the E3 calibration chose
// (lambda 6, a 931-insert cooldown) leave most soft operations to the hard limits on these small
// trees. config.test.ts asserts the calibrated defaults.
const config = topicTreeConfigWith({
  stability: { churnWeight: 1, dailyMovedShare: 0.02 },
  repair: { cooldownInserts: 25, cooldownShare: 0 },
  audit: { misParentMargin: 0.05 }
});
const data = gaussianClusters({
  groups: 4,
  clustersPerGroup: 3,
  pointsPerCluster: 20,
  dim: 24,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 21
});

function setupEditor(tree: ProductTree): TopicTreeEditor {
  return createTopicTreeEditor(tree.state, { record: false });
}

function run(
  tree: ProductTree,
  overrides: Partial<RebalanceInput> = {},
  engineConfig: TopicTreeConfig = config
): RebalanceResult {
  return rebalanceTree({
    state: tree.state,
    vectors: tree.vectors,
    config: engineConfig,
    seed: 7,
    now: fixtureNow,
    day: fixtureDay,
    newTopicId: tree.newTopicId,
    ...overrides
  });
}

/** Moves the items of other leaves into `leafId` until it holds `size` items. */
function growLeaf(tree: ProductTree, leafId: string, size: number): void {
  const { state } = tree;
  const editor = setupEditor(tree);
  // Donors from other branches first, so the grown leaf splits back into distinct topics.
  const parent = getTopic(state, leafId).parentId;
  const donors = topicsByKind(state)
    .leaves.filter((id) => id !== leafId)
    .sort(
      (a, b) =>
        Number(getTopic(state, a).parentId === parent) -
          Number(getTopic(state, b).parentId === parent) ||
        getTopic(state, b).items.length - getTopic(state, a).items.length
    );
  for (const donor of donors) {
    for (const item of [...getTopic(state, donor).items]) {
      if (getTopic(state, leafId).items.length >= size) break;
      if (getTopic(state, donor).items.length <= config.leaf.min) break;
      editor.updatePlacement(item, 0, { topicId: leafId });
    }
  }
  recomputeSubtree(state, tree.vectors);
  expect(getTopic(state, leafId).items.length).toBe(size);
}

/** The top-level leaf with the most items (the fixture has several). */
function topLeaf(state: TopicTreeState): string {
  return getTopic(state, state.rootId)
    .children.filter((id) => getTopic(state, id).children.length === 0)
    .sort((a, b) => getTopic(state, b).items.length - getTopic(state, a).items.length)[0] as string;
}

/** A leaf below the top level (its parent is an Area). */
function innerLeaf(state: TopicTreeState): string {
  return topicsByKind(state).leaves.find((id) => depthOf(state, id) === 2) as string;
}

function contentShape(state: TopicTreeState): string {
  const encode = (id: string): string => {
    const node = getTopic(state, id);
    const hashes = node.items.map((item) => state.items.get(item)?.contentHash).sort();
    return `(${hashes.join(",")}|${node.children.map(encode).sort().join("")})`;
  };
  return encode(state.rootId);
}

describe("REBALANCE: hard violations", () => {
  it("are fixed first, ignoring cooldown, freeze and budgets", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const leaf = innerLeaf(state);
    growLeaf(tree, leaf, config.leaf.hardMax + 5);
    getTopic(state, leaf).control.repairClock = state.clock;
    setFrozenTopics(state, [leaf, getTopic(state, leaf).parentId as string]);
    state.budget = { day: fixtureDay, operations: 10_000, movedItems: 10_000 };
    const result = run(tree, { topics: [leaf] });
    expect(result.applied[0]).toMatchObject({
      trigger: "hard",
      condition: "leaf-above-hard-max",
      kind: "leaf-split"
    });
    expect(getTopic(state, leaf).items.length).toBeLessThanOrEqual(config.leaf.hardMax);
    expect(result.unresolvedHard).toEqual([]);
    expect(checkInvariants(state, config).hard).toBe(0);
  });

  it("splits a leaf downward once its parent holds the limit of repair.sidewaysSplitLimit", () => {
    const split = (limit: "max" | "targetMax") => {
      const engineConfig = topicTreeConfigWith({ repair: { sidewaysSplitLimit: limit } }, config);
      const tree = productTree(data, config, { seed: 7 });
      const { state } = tree;
      const leaf = innerLeaf(state);
      const parent = getTopic(state, leaf).parentId as string;
      const editor = setupEditor(tree);
      // Small new leaves fill the parent up to the top of the target band.
      while (getTopic(state, parent).children.length < config.fanOut.targetMax) {
        const donor = topicsByKind(state).leaves.find(
          (id) => getTopic(state, id).parentId !== parent && getTopic(state, id).items.length >= 8
        );
        if (donor === undefined) throw new Error("no donor leaf left");
        const id = tree.newTopicId();
        editor.createTopic(id, parent);
        for (const item of getTopic(state, donor).items.slice(0, 4)) {
          editor.updatePlacement(item, 0, { topicId: id });
        }
      }
      recomputeSubtree(state, tree.vectors);
      growLeaf(tree, leaf, config.leaf.hardMax + 2);
      const result = run(tree, { topics: [leaf], hardOnly: true }, engineConfig);
      expect(result.applied[0]?.kind).toBe("leaf-split");
      return {
        parentChildren: getTopic(state, parent).children.length,
        leafChildren: getTopic(state, leaf).children.length
      };
    };
    // The default (`max`): the parent has room up to fanOut.max, so the leaf splits sideways.
    expect(split("max").parentChildren).toBeGreaterThan(config.fanOut.targetMax);
    // `targetMax` keeps the parent in the target band: the leaf becomes a topic of its own.
    const downward = split("targetMax");
    expect(downward.parentChildren).toBe(config.fanOut.targetMax);
    expect(downward.leafChildren).toBeGreaterThanOrEqual(config.fanOut.targetMin);
  });

  it("push down a topic above fanOut.hardMax but never the root once Areas exist", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const editor = setupEditor(tree);
    // More than fanOut.hardMax children under the root: new topics with 4 items each.
    while (getTopic(state, state.rootId).children.length <= config.fanOut.hardMax) {
      const donor = topicsByKind(state).leaves.find((id) => getTopic(state, id).items.length >= 8);
      if (donor === undefined) throw new Error("no donor leaf left");
      const id = tree.newTopicId();
      editor.createTopic(id, state.rootId);
      for (const item of getTopic(state, donor).items.slice(0, 4)) {
        editor.updatePlacement(item, 0, { topicId: id });
      }
    }
    recomputeSubtree(state, tree.vectors);
    expect(getTopic(state, state.rootId).children.length).toBeGreaterThan(config.fanOut.hardMax);
    const withAreas = cloneTopicTreeState(state);
    const areas = rebalanceTree({
      state: withAreas,
      vectors: tree.vectors,
      config,
      seed: 7,
      now: fixtureNow,
      day: fixtureDay,
      newTopicId: tree.newTopicId,
      areasActive: true,
      hardOnly: true
    });
    expect(areas.applied).toEqual([]);
    expect(areas.unresolvedHard).toContainEqual({
      topicId: state.rootId,
      condition: "fan-out-above-hard-max"
    });
    const result = run(tree, { hardOnly: true });
    expect(result.applied.map((operation) => operation.kind)).toContain("push-down");
    expect(getTopic(state, state.rootId).children.length).toBeLessThanOrEqual(
      config.fanOut.hardMax
    );
  });
});

describe("hard violations in a scope", () => {
  it("lists oversized leaves, duplicate sibling titles and secondaries on the primary path", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    expect(scopeHardViolations(state, config, state.rootId).size).toBe(0);
    const leaf = innerLeaf(state);
    growLeaf(tree, leaf, config.leaf.hardMax + 1);
    const editor = setupEditor(tree);
    const [first, second] = getTopic(state, state.rootId).children as [string, string];
    editor.renameTopic(first, { title: "Física", nameState: "named", nameSource: "llm" });
    editor.renameTopic(second, { title: "fisica", nameState: "named", nameSource: "llm" });
    const item = getTopic(state, leaf).items[0] as ItemKey;
    editor.placeItem(item, placementRecord(getTopic(state, leaf).parentId as string, { rank: 1 }));
    const keys = scopeHardViolations(state, config, state.rootId);
    expect(keys).toEqual(
      new Set([
        `I4:${leaf}`,
        `I7:${second}`,
        `I2:${item}:${getTopic(state, leaf).parentId as string}`
      ])
    );
    // A scope sees only its own subtree.
    expect(scopeHardViolations(state, config, second).size).toBe(0);
  });

  it("lists every topic with a hard condition, which a REBALANCE over them repairs", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    expect(hardViolationTopics(state, config)).toEqual([]);
    const leaf = innerLeaf(state);
    growLeaf(tree, leaf, config.leaf.hardMax + 1);
    const parent = getTopic(state, leaf).parentId as string;
    const other = topicsByKind(state).leaves.find((id) => getTopic(state, id).parentId !== parent)!;
    const item = getTopic(state, other).items[0] as ItemKey;
    setupEditor(tree).placeItem(
      item,
      placementRecord(getTopic(state, other).parentId as string, { rank: 1 })
    );
    expect(hardViolationTopics(state, config)).toEqual([leaf, other].sort());
    // No mark names them (only the root is dirty): the scan's topics are enough to repair both.
    const result = run(tree, { topics: [state.rootId, ...hardViolationTopics(state, config)] });
    expect(result.unresolvedHard).toEqual([]);
    expect(hardViolationTopics(state, config)).toEqual([]);
    expect(checkInvariants(state, config).hard).toBe(0);
  });
});

describe("REBALANCE: acceptance", () => {
  it("applies a soft split when dQ - lambda * churn > 0 and rejects it for a large lambda", () => {
    const tree = productTree(data, config, { seed: 7 });
    const leaf = innerLeaf(tree.state);
    growLeaf(tree, leaf, config.leaf.max + 4);
    const before = canonicalStateDump(tree.state);
    const strict = topicTreeConfigWith({ stability: { churnWeight: 50 } }, config);
    const rejected = run(tree, { topics: [leaf] }, strict);
    expect(rejected.applied).toEqual([]);
    expect(rejected.skipped).toContainEqual(
      expect.objectContaining({ topicId: leaf, condition: "leaf-above-max", reason: "rejected" })
    );
    expect(canonicalStateDump(tree.state)).toBe(before);
    const accepted = run(tree, { topics: [leaf] });
    const split = accepted.applied[0];
    expect(split).toMatchObject({ trigger: "soft", kind: "leaf-split" });
    expect(split?.netGain).toBeGreaterThan(0);
    expect(split?.netGain).toBeCloseTo(
      (split?.deltaQuality ?? 0) - config.stability.churnWeight * (split?.churn.weighted ?? 0),
      9
    );
  });

  it("weights recently opened items up in churn", () => {
    const tree = productTree(data, config, { seed: 7 });
    const leaf = innerLeaf(tree.state);
    growLeaf(tree, leaf, config.leaf.max + 2);
    const recent = new Set<ItemKey>(getTopic(tree.state, leaf).items);
    const result = run(tree, { topics: [leaf], recentItems: recent });
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("rejected");
  });

  it("merges near-duplicate sibling leaves and tiny leaves, keeping hard invariants", () => {
    const tree = productTree(data, config, { seed: 7 });
    const before = treeQuality(tree.state, tree.vectors, config);
    expect(before.duplicates).toBeGreaterThan(0);
    const result = run(tree, { force: true });
    const kinds = new Set(result.applied.map((operation) => operation.kind));
    expect(kinds.has("sibling-merge")).toBe(true);
    const after = treeQuality(tree.state, tree.vectors, config);
    expect(after.total).toBeGreaterThan(before.total);
    expect(after.duplicates).toBe(0);
    expect(checkInvariants(tree.state, config).hard).toBe(0);
  });
});

describe("REBALANCE: protection", () => {
  it("returns a proposal instead of splitting, merging or moving protected topics", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const leaf = innerLeaf(state);
    growLeaf(tree, leaf, config.leaf.max + 6);
    setupEditor(tree).manageTopic(leaf, "pinned");
    const before = canonicalStateDump(state);
    const result = run(tree, { topics: [leaf] });
    expect(result.applied).toEqual([]);
    expect(canonicalStateDump(state)).toBe(before);
    const proposal = result.proposals[0];
    expect(proposal).toMatchObject({
      reason: "protected",
      condition: "leaf-above-max",
      key: `leaf-above-max:${leaf}`
    });
    // The proposal applies exactly to the state it was computed on.
    const copy = cloneTopicTreeState(state);
    applyEvents(copy, proposal?.events ?? []);
    expect(getTopic(copy, leaf).items.length).toBeLessThanOrEqual(config.leaf.max);
  });

  it("never renames, retires or moves a protected topic automatically", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const editor = setupEditor(tree);
    const protectedIds = topicsByKind(state).leaves.slice(0, 6);
    growLeaf(tree, protectedIds[0] as string, config.leaf.max + 5);
    protectedIds.forEach((id, index) =>
      editor.manageTopic(id, index % 2 === 0 ? "pinned" : "human")
    );
    const records = protectedIds.map((id) => JSON.stringify(getTopic(state, id).parentId));
    const items = protectedIds.map((id) => [...getTopic(state, id).items].join());
    const result = run(tree, { force: true });
    for (const operation of result.applied) {
      for (const event of operation.events) {
        if ("item" in event) {
          expect(protectedIds).not.toContain(event.before?.topicId);
          expect(protectedIds).not.toContain(event.after?.topicId);
        } else {
          expect(protectedIds).not.toContain(event.topicId);
        }
      }
    }
    protectedIds.forEach((id, index) => {
      expect(isLive(getTopic(state, id))).toBe(true);
      expect(JSON.stringify(getTopic(state, id).parentId)).toBe(records[index]);
      expect([...getTopic(state, id).items].join()).toBe(items[index]);
    });
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals.every((proposal) => proposal.reason === "protected")).toBe(true);
  });

  it("makes Area-level operations proposals once Areas exist (D12)", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const leaf = topLeaf(state);
    growLeaf(tree, leaf, config.leaf.max + 6);
    const clone = cloneTopicTreeState(state);
    const result = rebalanceTree({
      state: clone,
      vectors: tree.vectors,
      config,
      seed: 7,
      now: fixtureNow,
      day: fixtureDay,
      newTopicId: tree.newTopicId,
      topics: [leaf],
      areasActive: true
    });
    expect(result.applied).toEqual([]);
    expect(result.proposals[0]).toMatchObject({ reason: "area-level", kind: "leaf-split" });
    const applied = run(tree, { topics: [leaf] });
    expect(applied.applied[0]?.kind).toBe("leaf-split");
  });
});

describe("REBALANCE: stability controls", () => {
  it("holds the daily operation budget and starts again the next day", () => {
    const tree = productTree(data, config, { seed: 7 });
    const oneADay = topicTreeConfigWith({ stability: { dailyOperations: 1 } }, config);
    const first = run(tree, {}, oneADay);
    expect(first.applied).toHaveLength(1);
    expect(first.skipped.some((skip) => skip.reason === "budget")).toBe(true);
    expect(tree.state.budget).toMatchObject({ day: fixtureDay, operations: 1 });
    const again = run(tree, {}, oneADay);
    expect(again.applied).toEqual([]);
    const nextDay = run(tree, { day: "2026-10-16" }, oneADay);
    expect(nextDay.applied).toHaveLength(1);
  });

  it("holds the daily move budget", () => {
    const tree = productTree(data, config, { seed: 7 });
    const tight = topicTreeConfigWith(
      { stability: { dailyMovedShare: 0, dailyMovedMin: 2 } },
      config
    );
    const result = run(tree, {}, tight);
    const moved = result.applied.reduce(
      (total, operation) => total + operation.churn.items.length,
      0
    );
    expect(moved).toBeLessThanOrEqual(2);
    expect(result.skipped.some((skip) => skip.reason === "budget")).toBe(true);
  });

  it("moves fresh items for free: no churn and no move budget, opened items never fresh", () => {
    const tree = productTree(data, config, { seed: 7 });
    const leaf = innerLeaf(tree.state);
    growLeaf(tree, leaf, config.leaf.max + 4);
    const strict = topicTreeConfigWith(
      { stability: { churnWeight: 50, dailyMovedShare: 0, dailyMovedMin: 0 } },
      config
    );
    const before = canonicalStateDump(tree.state);
    const established = run(tree, { topics: [leaf] }, strict);
    expect(established.applied).toEqual([]);
    expect(canonicalStateDump(tree.state)).toBe(before);
    const members = new Set<ItemKey>(getTopic(tree.state, leaf).items);
    // Opened (recent) items are never fresh: the split is still refused.
    const opened = run(tree, { topics: [leaf], freshItems: members, recentItems: members }, strict);
    expect(opened.applied).toEqual([]);
    const fresh = run(tree, { topics: [leaf], freshItems: members }, strict);
    const split = fresh.applied[0];
    expect(split).toMatchObject({ trigger: "soft", kind: "leaf-split" });
    expect(split?.churn.weighted).toBe(0);
    expect(split?.churn.fresh).toBe(split?.churn.items.length);
    expect(fresh.churn.items).toBeGreaterThan(0);
    expect(fresh.churn.budgeted).toBe(0);
    expect(tree.state.budget.movedItems).toBe(0);
  });

  it("waits out the cooldown, leaves frozen topics alone, and `force` lifts both", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const leaf = innerLeaf(state);
    growLeaf(tree, leaf, config.leaf.max + 4);
    getTopic(state, leaf).control.repairClock = 0;
    state.clock = config.repair.cooldownInserts - 1;
    const cooling = run(tree, { topics: [leaf] });
    expect(cooling.applied).toEqual([]);
    expect(cooling.skipped[0]?.reason).toBe("cooldown");
    state.clock = config.repair.cooldownInserts;
    setFrozenTopics(state, [getTopic(state, leaf).parentId as string]);
    const frozen = run(tree, { topics: [leaf] });
    expect(frozen.applied).toEqual([]);
    expect(frozen.skipped[0]?.reason).toBe("frozen");
    const forced = run(tree, { topics: [leaf], force: true });
    expect(forced.applied[0]?.kind).toBe("leaf-split");
    // The split topic now cools down.
    expect(getTopic(state, leaf).control.repairClock).toBe(state.clock);
  });
});

describe("REBALANCE: mis-parent audit and direct items", () => {
  it("re-parents a planted mis-parented topic through acceptance (a proposal with Areas)", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const areas = getTopic(state, state.rootId).children.filter(
      (id) => getTopic(state, id).children.length >= 3
    );
    const [home, away] = areas as [string, string];
    const planted = getTopic(state, home).children[0] as string;
    setupEditor(tree).moveTopic(planted, away);
    recomputeSubtree(state, tree.vectors);
    const withAreas = rebalanceTree({
      state: cloneTopicTreeState(state),
      vectors: tree.vectors,
      config,
      seed: 7,
      now: fixtureNow,
      day: fixtureDay,
      newTopicId: tree.newTopicId,
      topics: [planted],
      areasActive: true
    });
    expect(withAreas.proposals[0]).toMatchObject({ reason: "area-level", kind: "reparent" });
    // Before the tree's first Areas grouping (and inside it), Area-level operations are automatic.
    const beforeGrouping = rebalanceTree({
      state: cloneTopicTreeState(state),
      vectors: tree.vectors,
      config,
      seed: 7,
      now: fixtureNow,
      day: fixtureDay,
      newTopicId: tree.newTopicId,
      topics: [planted],
      areasActive: true,
      areaLevelReview: false,
      force: true
    });
    expect(beforeGrouping.proposals).toEqual([]);
    expect(beforeGrouping.applied[0]).toMatchObject({ kind: "reparent" });
    // The re-parent moves a whole subtree: on a 240-item library it exceeds the per-operation
    // share (repair.softMoveShare), so it waits for the budget; an explicit settle applies it.
    const waiting = run(tree, { topics: [planted] });
    expect(waiting.skipped[0]).toMatchObject({ kind: "reparent", reason: "budget" });
    const result = run(tree, { topics: [planted], force: true });
    expect(result.applied[0]).toMatchObject({ kind: "reparent", condition: "mis-parented" });
    expect(getTopic(state, planted).parentId).toBe(home);
  });

  it("weighs a mis-parent correction's churn once, so it passes at the calibrated lambda", () => {
    // The calibrated lambda (4; gate A chose 6) exceeds what Q prices a mis-parent at
    // (items x (1 + gain)): counted lambda times, no re-parent could ever pass.
    const calibrated = topicTreeConfigWith({ audit: { misParentMargin: 0.05 } });
    expect(calibrated.stability.churnWeight).toBe(4);
    expect(churnWeightOf("mis-parented", calibrated)).toBeCloseTo(1 / 4, 12);
    expect(churnWeightOf("leaf-above-max", calibrated)).toBe(1);
    const tree = productTree(data, calibrated, { seed: 7 });
    const { state } = tree;
    const areas = getTopic(state, state.rootId).children.filter(
      (id) => getTopic(state, id).children.length >= 3
    );
    const [home, away] = areas as [string, string];
    const planted = getTopic(state, home).children[0] as string;
    setupEditor(tree).moveTopic(planted, away);
    recomputeSubtree(state, tree.vectors);
    const onlyReparents = run(
      tree,
      { topics: [planted, home, away], force: true, conditions: new Set(["mis-parented"]) },
      calibrated
    );
    expect(onlyReparents.applied.map((operation) => operation.condition)).toEqual(["mis-parented"]);
    expect(onlyReparents.applied[0]?.netGain).toBeGreaterThan(0);
    expect(getTopic(state, planted).parentId).toBe(home);
  });

  it("absorbs movable direct items into new leaves and leaves gated items waiting", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const area = getTopic(state, state.rootId).children.find(
      (id) => getTopic(state, id).children.length >= 3
    ) as string;
    const editor = setupEditor(tree);
    // A whole leaf's items pile up as direct items of its parent (a coherent new group).
    const donor = getTopic(state, area)
      .children.filter((id) => getTopic(state, id).items.length >= 12)
      .at(0) as string;
    const moved = [...getTopic(state, donor).items];
    for (const item of moved) editor.updatePlacement(item, 0, { topicId: area });
    const gated = moved[0] as ItemKey;
    editor.updatePlacement(gated, 0, { needsGate: true });
    const splitCheck = moved[1] as ItemKey;
    editor.updatePlacement(splitCheck, 0, { needsSplitCheck: true });
    recomputeSubtree(state, tree.vectors);
    const result = run(tree, { topics: [area], force: true });
    expect(result.applied.map((operation) => operation.kind)).toContain("absorb-direct");
    expect(placementsOf(state, gated)[0]?.topicId).toBe(area);
    const checked = placementsOf(state, splitCheck)[0];
    expect(checked?.topicId).not.toBe(area);
    expect(checked?.needsSplitCheck).toBe(false);
    expect(checked?.movedFromTopicId).toBe(area);
  });

  it("groups no-decider fallback items into a new leaf and keeps their mark (decision 19)", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    const area = getTopic(state, state.rootId).children.find(
      (id) => getTopic(state, id).children.length >= 3
    ) as string;
    const editor = setupEditor(tree);
    const donor = getTopic(state, area)
      .children.filter((id) => getTopic(state, id).items.length >= 12)
      .at(0) as string;
    // A new topic's notes met no ranker: each is the gate's "none" at the area (fallback-none).
    const fallback = [...getTopic(state, donor).items];
    for (const item of fallback) {
      editor.updatePlacement(item, 0, {
        topicId: area,
        decidedBy: "fallback-none",
        needsSplitCheck: true
      });
    }
    recomputeSubtree(state, tree.vectors);
    const result = run(tree, { topics: [area], force: true });
    expect(result.applied.map((operation) => operation.kind)).toContain("absorb-direct");
    const homes = new Set(fallback.map((item) => placementsOf(state, item)[0]?.topicId));
    expect(homes.has(area)).toBe(false);
    for (const item of fallback) {
      const primary = placementsOf(state, item)[0]!;
      expect(getTopic(state, primary.topicId).children).toEqual([]);
      // Grouped and shown in their leaf, still owed a ranker decision.
      expect(primary).toMatchObject({ decidedBy: "fallback-none", needsSplitCheck: false });
    }
  });

  it("re-admits direct items below the topic when PLACE finds them a place", () => {
    const tree = productTree(data, config, { seed: 7 });
    const { state } = tree;
    // Full leaves, so that their items' return touches no near-duplicate sibling pair.
    const full = (id: string): string[] =>
      getTopic(state, id).children.filter((child) => getTopic(state, child).items.length >= 20);
    const area = getTopic(state, state.rootId).children.find(
      (id) => full(id).length >= 3
    ) as string;
    const editor = setupEditor(tree);
    const home = new Map<ItemKey, string>();
    for (const leaf of full(area).slice(0, 3)) {
      for (const item of getTopic(state, leaf).items.slice(0, 3)) {
        home.set(item, leaf);
        editor.updatePlacement(item, 0, { topicId: area });
      }
    }
    recomputeSubtree(state, tree.vectors);
    const result = run(tree, {
      topics: [area],
      readmit: (item) => home.get(item) ?? null
    });
    expect(result.applied[0]?.kind).toBe("absorb-direct");
    expect(result.applied[0]?.created).toEqual([]);
    for (const [item, leaf] of home) expect(placementsOf(state, item)[0]?.topicId).toBe(leaf);
  });
});

// ---------------------------------------------------------------------------
// Properties

/**
 * Random disorder: piled, emptied and moved leaves, direct items, topic moves (depth <= cap) and
 * crowded fan-outs.
 */
function perturb(tree: ProductTree, rng: Rng, steps: number): void {
  const { state } = tree;
  const editor = setupEditor(tree);
  const pick = <T>(values: readonly T[]): T | undefined =>
    values.length > 0 ? values[rng.int(values.length)] : undefined;
  for (let step = 0; step < steps; step += 1) {
    const { leaves, internal } = topicsByKind(state);
    switch (rng.int(7)) {
      case 6: {
        // Crowd an internal topic with small new leaves (fan-out above the band, or hard).
        const parent = pick(internal);
        if (!parent || depthOf(state, parent) + 1 > config.depth.cap) break;
        for (let count = 6 + rng.int(10); count > 0; count -= 1) {
          const donor = topicsByKind(state).leaves.find(
            (id) => getTopic(state, id).items.length >= 10 && !pathOf(state, id).includes(parent)
          );
          if (!donor) break;
          const leaf = tree.newTopicId();
          editor.createTopic(leaf, parent);
          for (const item of getTopic(state, donor).items.slice(0, 4)) {
            editor.updatePlacement(item, 0, { topicId: leaf });
          }
        }
        break;
      }
      case 0: {
        const from = pick(leaves);
        const to = pick(leaves);
        if (!from || !to || from === to) break;
        const count = 1 + rng.int(18);
        for (const item of getTopic(state, from).items.slice(0, count)) {
          editor.updatePlacement(item, 0, { topicId: to });
        }
        break;
      }
      case 1: {
        const parent = pick([state.rootId, ...internal]) as string;
        if (depthOf(state, parent) + 1 > config.depth.cap) break;
        editor.createTopic(tree.newTopicId(), parent);
        break;
      }
      case 2: {
        const id = pick([...leaves, ...internal]);
        const target = pick([state.rootId, ...internal]);
        if (!id || !target || pathOf(state, target).includes(id)) break;
        if (getTopic(state, id).parentId === target) break;
        if (depthOf(state, target) + 1 + heightOf(state, id) > config.depth.cap) break;
        editor.moveTopic(id, target);
        break;
      }
      case 3: {
        const from = pick(leaves);
        const to = pick([state.rootId, ...internal]);
        if (!from || !to) break;
        for (const item of getTopic(state, from).items.slice(0, 1 + rng.int(6))) {
          editor.updatePlacement(item, 0, { topicId: to, needsGate: rng.next() < 0.2 });
        }
        break;
      }
      case 4: {
        const parent = pick(internal);
        if (!parent || depthOf(state, parent) + 1 + heightOf(state, parent) > config.depth.cap) {
          break;
        }
        const children = getTopic(state, parent).children.slice(0, 2 + rng.int(3));
        const holder = tree.newTopicId();
        editor.createTopic(holder, parent);
        for (const child of children) editor.moveTopic(child, holder);
        break;
      }
      default: {
        const to = pick(leaves);
        if (!to) break;
        for (const from of leaves.slice(0, 3)) {
          if (from === to) continue;
          for (const item of getTopic(state, from).items.slice(0, 20)) {
            editor.updatePlacement(item, 0, { topicId: to });
          }
        }
        break;
      }
    }
  }
  recomputeSubtree(state, tree.vectors);
}

describe("REBALANCE properties (seeded)", () => {
  it("fixes every hard violation, keeps the invariants and emits exactly invertible events", () => {
    let applied = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = createRng(seed);
      const tree = productTree(data, config, { seed: 7, offset: seed * 1_000 });
      perturb(tree, rng, 12);
      const before = canonicalStateDump(tree.state);
      const beforeStats = statsDump(tree.state);
      const replay = cloneTopicTreeState(tree.state);
      const result = run(tree, { force: seed % 2 === 0 });
      applied += result.applied.length;
      expect(result.exhausted).toBe(false);
      expect(result.unresolvedHard).toEqual([]);
      const report = checkInvariants(tree.state, config);
      expect(report.violations.filter((violation) => violation.severity === "hard")).toEqual([]);
      for (const event of result.events) expect(StructureEventSchema.parse(event)).toEqual(event);
      // Each applied operation's dQ (measured on its scope) equals the whole tree's dQ.
      for (const operation of result.applied) {
        kinds.add(operation.kind);
        const wholeBefore = treeQuality(replay, tree.vectors, config).total;
        const { touchedTopics } = applyEvents(replay, operation.events);
        refreshTopics(replay, tree.vectors, touchedTopics);
        const wholeAfter = treeQuality(replay, tree.vectors, config).total;
        expect(wholeAfter - wholeBefore).toBeCloseTo(operation.deltaQuality, 6);
      }
      expect(canonicalStateDump(replay)).toBe(canonicalStateDump(tree.state));
      // Undo of the whole change-set is exact; the recompute is bit-equal.
      applyEvents(tree.state, invertEvents(result.events));
      expect(canonicalStateDump(tree.state)).toBe(before);
      recomputeSubtree(tree.state, tree.vectors);
      expect(statsDump(tree.state)).toBe(beforeStats);
    }
    expect(applied).toBeGreaterThan(40);
    for (const kind of ["leaf-split", "sibling-merge", "internal-split", "push-down", "reparent"]) {
      expect(kinds).toContain(kind);
    }
  });

  it("is deterministic and depends on content, not on topic or item UUIDs (D22)", () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const first = productTree(data, config, { seed: 7, offset: 0 });
      const second = productTree(data, config, { seed: 7, offset: 77_000_000 });
      perturb(first, createRng(seed), 10);
      perturb(second, createRng(seed), 10);
      expect(contentShape(second.state)).toBe(contentShape(first.state));
      const a = run(first, { force: true });
      const b = run(second, { force: true });
      expect(b.applied.map((operation) => operation.kind)).toEqual(
        a.applied.map((operation) => operation.kind)
      );
      expect(contentShape(second.state)).toBe(contentShape(first.state));
      expect(liveTopicIds(first.state)).not.toEqual(liveTopicIds(second.state));
    }
  });

  it("settles: a second pass right after a forced one changes nothing", () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const tree = productTree(data, config, { seed: 7 });
      perturb(tree, createRng(seed * 31), 12);
      run(tree, { force: true });
      const settled = canonicalStateDump(tree.state);
      const again = run(tree, { force: true });
      expect(again.applied).toEqual([]);
      expect(canonicalStateDump(tree.state)).toBe(settled);
      walkTopics(tree.state, (node) => {
        if (node.id !== tree.state.rootId && node.children.length === 0) {
          expect(node.items.length).toBeLessThanOrEqual(config.leaf.hardMax);
        }
      });
    }
  });
});
