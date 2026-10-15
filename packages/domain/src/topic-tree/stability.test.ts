import { describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { fixtureDay, productTree } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import {
  changeSetRisk,
  consumeDailyBudget,
  dailyBudget,
  eventChurn,
  eventsTopics,
  isCoolingDown,
  localDay,
  recentlyOpenedTopics,
  setFrozenTopics
} from "./stability.js";
import { getTopic, liveTopicIds } from "./state.js";
import { defaultTopicTreeConfig } from "./config.js";

const config = defaultTopicTreeConfig;
const data = gaussianClusters({
  groups: 3,
  clustersPerGroup: 2,
  pointsPerCluster: 20,
  dim: 16,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 5
});

describe("local day and daily budgets", () => {
  it("reads the calendar day in the user's time zone", () => {
    expect(localDay("2026-10-15T02:30:00.000Z", "America/Sao_Paulo")).toBe("2026-10-14");
    expect(localDay("2026-10-15T02:30:00.000Z", "UTC")).toBe("2026-10-15");
    expect(() => localDay("not a date", "UTC")).toThrow(RangeError);
  });

  it("counts operations and moved items per day and starts each day from zero", () => {
    const tree = productTree(data, config, { seed: 1 });
    const limited = topicTreeConfigWith({
      stability: { dailyOperations: 2, dailyMovedShare: 0.1, dailyMovedMin: 5 }
    });
    const fresh = dailyBudget(tree.state, limited, fixtureDay);
    expect(fresh).toMatchObject({ maxOperations: 2, maxMovedItems: 12, operationsLeft: 2 });
    consumeDailyBudget(tree.state, fixtureDay, 7);
    consumeDailyBudget(tree.state, fixtureDay, 4);
    expect(dailyBudget(tree.state, limited, fixtureDay)).toMatchObject({
      operationsLeft: 0,
      movedItemsLeft: 1
    });
    expect(dailyBudget(tree.state, limited, "2026-10-16")).toMatchObject({
      operationsLeft: 2,
      movedItemsLeft: 12
    });
    consumeDailyBudget(tree.state, "2026-10-16", 1);
    expect(tree.state.budget).toEqual({ day: "2026-10-16", operations: 1, movedItems: 1 });
    // The minimum applies to small libraries.
    expect(dailyBudget(tree.state, limited, "2026-10-17", 10).maxMovedItems).toBe(5);
  });
});

describe("cooldown and freeze", () => {
  it("cools a topic down for repair.cooldownInserts inserts after a repair", () => {
    const tree = productTree(data, config, { seed: 1 });
    const id = liveTopicIds(tree.state)[1] as string;
    expect(isCoolingDown(tree.state, config, id)).toBe(false);
    getTopic(tree.state, id).control.repairClock = 10;
    tree.state.clock = 10 + config.repair.cooldownInserts - 1;
    expect(isCoolingDown(tree.state, config, id)).toBe(true);
    tree.state.clock += 1;
    expect(isCoolingDown(tree.state, config, id)).toBe(false);
  });

  it("freezes topics opened within stability.freezeHours", () => {
    const opens = [
      { topicId: "a", at: "2026-10-15T11:00:00.000Z" },
      { topicId: "b", at: "2026-10-14T11:59:00.000Z" },
      { topicId: "c", at: "2026-10-14T12:00:00.000Z" }
    ];
    expect([...recentlyOpenedTopics(opens, "2026-10-15T12:00:00.000Z", config)].sort()).toEqual([
      "a",
      "c"
    ]);
    const tree = productTree(data, config, { seed: 1 });
    const [first, second] = liveTopicIds(tree.state).slice(1) as [string, string];
    setFrozenTopics(tree.state, [first, "unknown"]);
    expect(getTopic(tree.state, first).control.frozen).toBe(true);
    setFrozenTopics(tree.state, [second]);
    expect(getTopic(tree.state, first).control.frozen).toBe(false);
    expect(getTopic(tree.state, second).control.frozen).toBe(true);
  });
});

describe("churn of structure events", () => {
  it("counts items whose primary path changed: moves and merges, not renames", () => {
    const tree = productTree(data, config, { seed: 1 });
    const { state } = tree;
    const root = getTopic(state, state.rootId);
    const [a, b] = root.children as [string, string];
    const editor = createTopicTreeEditor(state);
    const leafA = getTopic(state, a).children[0] ?? a;
    const item = getTopic(state, leafA).items[0] as string;
    editor.renameTopic(a, { title: "Renamed", nameState: "named", nameSource: "llm" });
    expect(eventChurn(state, editor.events, config).items).toEqual([]);
    editor.updatePlacement(item, 0, { topicId: b });
    const moved = eventChurn(state, editor.events, config);
    expect(moved.items).toEqual([item]);
    expect(moved.weighted).toBe(1);
    // A topic move re-paths its whole subtree; recently opened items weigh more.
    const recent = new Set([getTopic(state, b).items[0] ?? item]);
    const before = editor.events.length;
    const holder = tree.newTopicId();
    editor.createTopic(holder, state.rootId);
    editor.moveTopic(b, holder);
    const subtree = eventChurn(state, editor.events.slice(before), config, recent);
    expect(subtree.items.length).toBe(getTopic(state, b).stats.n + 1);
    expect(subtree.recent).toBe(1);
    expect(subtree.weighted).toBe(subtree.items.length - 1 + config.stability.recentChurnWeight);
    // Moving it back within the same events is no churn.
    editor.moveTopic(b, state.rootId);
    expect(eventChurn(state, editor.events.slice(before), config).items).toEqual([]);
    expect(eventsTopics(editor.events.slice(before))).toEqual(new Set([holder, state.rootId, b]));
  });

  it("does not count first placements or removals", () => {
    const tree = productTree(data, config, { seed: 1 });
    const { state } = tree;
    const editor = createTopicTreeEditor(state);
    const item = getTopic(state, liveTopicIds(state)[2] as string).items[0];
    if (item === undefined) throw new Error("fixture has no item");
    editor.unplaceItem(item, 0);
    expect(eventChurn(state, editor.events, config).items).toEqual([]);
  });

  it("maps moved shares to change-set risk", () => {
    expect(changeSetRisk(0.01, config)).toBe("low");
    expect(changeSetRisk(0.1, config)).toBe("medium");
    expect(changeSetRisk(0.5, config)).toBe("high");
  });
});
