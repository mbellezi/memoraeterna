import { describe, expect, it } from "vitest";

import { changeSetConfig } from "../change-sets.js";
import { topicTreeConfigWith } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { fixtureDay, productTree } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import {
  changeSetRisk,
  consumeDailyBudget,
  cooldownInsertsFor,
  dailyBudget,
  eventChurn,
  eventsTopics,
  freshItemsOf,
  freshWindowStart,
  isCoolingDown,
  localDay,
  placedItemCount,
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

  it("scales the cooldown with the library: max(cooldownInserts, cooldownShare x items)", () => {
    const scaled = topicTreeConfigWith({ repair: { cooldownInserts: 25, cooldownShare: 0.05 } });
    expect(cooldownInsertsFor(scaled, 170)).toBe(25);
    expect(cooldownInsertsFor(scaled, 18_632)).toBe(932);
    expect(cooldownInsertsFor(topicTreeConfigWith({ repair: { cooldownShare: 0 } }), 18_632)).toBe(
      defaultTopicTreeConfig.repair.cooldownInserts
    );
    const tree = productTree(data, scaled, { seed: 1 });
    const id = liveTopicIds(tree.state)[1] as string;
    getTopic(tree.state, id).control.repairClock = 0;
    tree.state.clock = 24;
    expect(isCoolingDown(tree.state, scaled, id)).toBe(true);
    tree.state.clock = 25;
    expect(isCoolingDown(tree.state, scaled, id)).toBe(false);
    // The same topic in a library of 1,000 placed items waits 50 inserts.
    expect(isCoolingDown(tree.state, scaled, id, 1000)).toBe(true);
    expect(placedItemCount(tree.state)).toBe(data.matrix.count);
  });

  it("keeps fresh items: placed within stability.freshHours, outside opened topics", () => {
    expect(freshWindowStart("2026-10-15T12:00:00.000Z", config)).toBe(
      config.stability.freshHours > 0
        ? new Date(
            Date.parse("2026-10-15T12:00:00.000Z") - config.stability.freshHours * 3.6e6
          ).toISOString()
        : null
    );
    const day = topicTreeConfigWith({ stability: { freshHours: 24 } });
    expect(freshWindowStart("2026-10-15T12:00:00.000Z", day)).toBe("2026-10-14T12:00:00.000Z");
    expect(
      freshWindowStart(
        "2026-10-15T12:00:00.000Z",
        topicTreeConfigWith({
          stability: { freshHours: 0 }
        })
      )
    ).toBeNull();
    expect([...freshItemsOf(["note:a", "note:b", "note:c"], new Set(["note:b"]))]).toEqual([
      "note:a",
      "note:c"
    ]);
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
    // Fresh items move for free; a recently opened item is never fresh.
    const freshly = eventChurn(
      state,
      editor.events.slice(before),
      config,
      recent,
      new Set(subtree.items)
    );
    expect(freshly.items).toEqual(subtree.items);
    expect(freshly.fresh).toBe(subtree.items.length - 1);
    expect(freshly.weighted).toBe(config.stability.recentChurnWeight);
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
    // A bare share and the same share as a fact read alike (existing callers keep their risk).
    for (const share of [0, 0.05, 0.06, 0.25, 0.26, 1])
      expect(changeSetRisk({ movedShare: share }, config)).toBe(changeSetRisk(share, config));
  });

  it("reviews the always-reviewed set of D11 whatever the moved share", () => {
    for (const facts of [
      { protectedContent: true },
      { areaLevel: true },
      { treeShape: true },
      { divergence: "rewrite" as const },
      { mergedItems: changeSetConfig.risk.mergeItemsHigh + 1 },
      { rebuild: true, movedShare: changeSetConfig.risk.rebuildMovedShareHigh + 0.01 }
    ])
      expect(changeSetRisk(facts, config), JSON.stringify(facts)).toBe("high");
    // A merge at the bar and a rebuild at its bar are not high by themselves.
    expect(changeSetRisk({ mergedItems: changeSetConfig.risk.mergeItemsHigh }, config)).toBe("low");
    expect(
      changeSetRisk(
        { rebuild: true, movedShare: changeSetConfig.risk.rebuildMovedShareHigh },
        config
      )
    ).toBe("medium");
    // A rebuild is judged against its own bar, below the general one.
    expect(changeSetRisk({ movedShare: 0.22 }, config)).toBe("medium");
    expect(changeSetRisk({ rebuild: true, movedShare: 0.22 }, config)).toBe("high");
  });

  it("marks Divergences kept side by side and renames of recently opened topics medium", () => {
    expect(changeSetRisk({ divergence: "sideBySide" }, config)).toBe("medium");
    expect(changeSetRisk({ divergence: "none" }, config)).toBe("low");
    expect(changeSetRisk({ renamesRecentlyOpened: true }, config)).toBe("medium");
    expect(changeSetRisk({}, config)).toBe("low");
    // The thresholds come from typed configuration.
    expect(
      changeSetRisk({ mergedItems: 5 }, config, { ...changeSetConfig.risk, mergeItemsHigh: 4 })
    ).toBe("high");
  });
});
