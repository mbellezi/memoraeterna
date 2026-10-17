import { describe, expect, it } from "vitest";

import {
  assignPartitions,
  buildRematchPlan,
  parseRematchKnob,
  RematchFence,
  releaseOrder,
  type RematchRoot
} from "./relations-rematch-plan.js";

// 60 roots like the fixture's: 40 tuning and 20 held-out, the raw manifest interleaving 14 of the
// held-out ones among the tuning ones (spec 5.3).
const fixtureRoots = (): RematchRoot[] => {
  const heldOutAt = new Set([
    2, 5, 9, 13, 18, 22, 27, 31, 36, 41, 46, 50, 54, 57, 58, 59, 55, 56, 52, 53
  ]);
  return Array.from({ length: 60 }, (_, index) => ({
    id: `root-${index}`,
    title: `Root ${index}`,
    partition: heldOutAt.has(index) ? "holdout" : "tuning",
    records: [{ id: `record-${index}`, title: `Record ${index}`, notes: 2 }],
    notes: 2
  }));
};
const ids = (roots: readonly RematchRoot[]) => roots.map((root) => root.id);
const arrival = (seed: number | "manifest") =>
  seed === "manifest"
    ? ({ kind: "arrival", order: { kind: "manifest" } } as const)
    : ({ kind: "arrival", order: { kind: "seeded", seed } } as const);

describe("the re-match knob", () => {
  it("reads burst, the manifest order and a seed", () => {
    expect(parseRematchKnob("burst")).toEqual({ kind: "burst" });
    expect(parseRematchKnob(" arrival:manifest ")).toEqual(arrival("manifest"));
    expect(parseRematchKnob("arrival:S0")).toEqual(arrival("manifest"));
    expect(parseRematchKnob("arrival:20261031")).toEqual(arrival(20261031));
    expect(parseRematchKnob("arrival:4294967295")).toEqual(arrival(4294967295));
  });

  it("refuses anything else", () => {
    for (const value of [
      "",
      "arrival",
      "arrival:",
      "arrival:0",
      "arrival:-3",
      "arrival:1.5",
      "arrival:4294967296",
      "arrival:abc",
      "bursts",
      "serial"
    ])
      expect(() => parseRematchKnob(value), value).toThrow("MEMORA_RELATIONS_REMATCH");
  });
});

describe("the release order", () => {
  it("S0 releases the tuning roots in manifest order, then the held-out roots in manifest order", () => {
    const roots = fixtureRoots();
    const order = releaseOrder(roots, arrival("manifest"));
    expect(order).toHaveLength(60);
    const tuning = roots.filter((root) => root.partition === "tuning");
    const heldOut = roots.filter((root) => root.partition === "holdout");
    expect(tuning).toHaveLength(40);
    expect(ids(order)).toEqual([...ids(tuning), ...ids(heldOut)]);
  });

  it("S1 and S2 shuffle each partition with a seed, tuning roots first, held-out roots last", () => {
    const roots = fixtureRoots();
    const s0 = releaseOrder(roots, arrival("manifest"));
    const s1 = releaseOrder(roots, arrival(20261031));
    const s2 = releaseOrder(roots, arrival(20261032));
    for (const order of [s1, s2]) {
      expect(order).toHaveLength(60);
      expect(new Set(ids(order)).size).toBe(60);
      expect(order.slice(0, 40).every((root) => root.partition === "tuning")).toBe(true);
      expect(order.slice(40).every((root) => root.partition === "holdout")).toBe(true);
      // Each partition holds exactly the roots of S0's, in another order.
      expect(new Set(ids(order.slice(0, 40)))).toEqual(new Set(ids(s0.slice(0, 40))));
      expect(ids(order)).not.toEqual(ids(s0));
    }
    expect(ids(s1)).not.toEqual(ids(s2));
  });

  it("is a function of the seed alone", () => {
    const roots = fixtureRoots();
    expect(ids(releaseOrder(roots, arrival(20261031)))).toEqual(
      ids(releaseOrder([...roots], arrival(20261031)))
    );
    // The input is not reordered in place.
    expect(ids(roots)).toEqual(ids(fixtureRoots()));
  });

  it("keeps a library with no partitions in one group, in manifest order or shuffled", () => {
    const roots = fixtureRoots().map((root) => ({ ...root, partition: null }));
    expect(ids(releaseOrder(roots, arrival("manifest")))).toEqual(ids(roots));
    const shuffled = releaseOrder(roots, arrival(7));
    expect(new Set(ids(shuffled))).toEqual(new Set(ids(roots)));
    expect(ids(shuffled)).not.toEqual(ids(roots));
  });

  it("puts any other partition after the held-out roots and roots with none last", () => {
    const base = fixtureRoots().slice(0, 4);
    const roots: RematchRoot[] = [
      { ...base[0]!, partition: null },
      { ...base[1]!, partition: "extra" },
      { ...base[2]!, partition: "holdout" },
      { ...base[3]!, partition: "tuning" }
    ];
    expect(ids(releaseOrder(roots, arrival("manifest")))).toEqual([
      "root-3",
      "root-2",
      "root-1",
      "root-0"
    ]);
  });
});

describe("the plan of a run", () => {
  const library = (): RematchRoot[] => [
    ...fixtureRoots().slice(0, 5),
    { id: "empty", title: "No notes", partition: "tuning", records: [], notes: 0 }
  ];

  it("releases every root with notes and sets the rest aside", () => {
    const plan = buildRematchPlan(library(), arrival("manifest"));
    expect(plan.order).toHaveLength(5);
    expect(plan.others).toEqual([]);
    expect(plan.withoutNotes.map((root) => root.id)).toEqual(["empty"]);
  });

  it("releases the listed roots in the list's order and leaves the others as background", () => {
    const plan = buildRematchPlan(library(), arrival("manifest"), ["Root 2", "root-1"]);
    // Root 2 is held out in the fixture, and tuning roots always come first.
    expect(ids(plan.order)).toEqual(["root-1", "root-2"]);
    expect(ids(plan.others)).toEqual(["root-0", "root-3", "root-4"]);
  });

  it("refuses an unknown root, a root named twice and a title shared by two roots", () => {
    expect(() => buildRematchPlan(library(), arrival("manifest"), ["Nowhere"])).toThrow("Nowhere");
    expect(() => buildRematchPlan(library(), arrival("manifest"), ["root-1", "Root 1"])).toThrow(
      "twice"
    );
    const twins = [...library(), { ...fixtureRoots()[9]!, id: "twin", title: "Root 1" }];
    expect(() => buildRematchPlan(twins, arrival("manifest"), ["Root 1"])).toThrow(
      "names two roots"
    );
    expect(ids(buildRematchPlan(twins, arrival("manifest"), ["twin"]).order)).toEqual(["twin"]);
  });

  it("refuses a run with nothing to release", () => {
    expect(() => buildRematchPlan([], arrival("manifest"))).toThrow("no root to release");
    expect(() =>
      buildRematchPlan([{ id: "e", title: "E", partition: null, records: [], notes: 0 }], {
        kind: "burst"
      })
    ).toThrow("no root to release");
  });

  it("orders a burst by the manifest", () => {
    const plan = buildRematchPlan(fixtureRoots(), { kind: "burst" });
    expect(ids(plan.order)).toEqual(ids(releaseOrder(fixtureRoots(), arrival("manifest"))));
  });

  it("takes the partitions of a fixture mapping by title and refuses a root it lacks", () => {
    const bare = fixtureRoots()
      .slice(0, 3)
      .map((root) => ({
        id: root.id,
        title: root.title,
        records: root.records,
        notes: root.notes
      }));
    const assigned = assignPartitions(
      bare,
      new Map([
        ["Root 0", "tuning"],
        ["Root 1", "holdout"],
        ["Root 2", "tuning"]
      ])
    );
    expect(assigned.map((root) => root.partition)).toEqual(["tuning", "holdout", "tuning"]);
    expect(() => assignPartitions(bare, new Map([["Root 0", "tuning"]]))).toThrow(
      "2 library roots are not in the fixture mapping"
    );
  });
});

describe("the visibility fence", () => {
  it("shows nothing until a root is released, then that root and every earlier one", () => {
    const fence = new RematchFence();
    expect(fence.retrievalFence()).toEqual({ rootSourceItemIds: [] });
    fence.release("a");
    fence.release("b");
    fence.release("a");
    expect(fence.retrievalFence()).toEqual({ rootSourceItemIds: ["a", "b"] });
    expect(fence.isVisible("a")).toBe(true);
    expect(fence.isVisible("c")).toBe(false);
  });

  it("starts with the background visible and a burst with every root", () => {
    const background = new RematchFence(["x", "y"]);
    background.release("a");
    expect(background.visibleRootIds()).toEqual(["x", "y", "a"]);
    const burst = new RematchFence(["a", "b", "c"]);
    expect(burst.isVisible("c")).toBe(true);
    burst.release("b");
    expect(burst.visibleRootIds()).toEqual(["a", "b", "c"]);
  });

  it("hands out snapshots: a later release does not change a fence already given", () => {
    const fence = new RematchFence();
    fence.release("a");
    const given = fence.retrievalFence();
    fence.release("b");
    expect(given.rootSourceItemIds).toEqual(["a"]);
    expect(fence.retrievalFence().rootSourceItemIds).toEqual(["a", "b"]);
  });
});
