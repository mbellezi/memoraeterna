import { defaultTopicTreeConfig } from "@app/domain/topic-tree";
import type { ItemKey } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import { analyzeTopicTree, auditTargets, TopicAuditError } from "./audit-core.js";
import type { AuditInput, AuditPlacement, AuditTopic, TopicAuditReport } from "./audit-core.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const topicId = (n: number): string => uuid(n);
const note = (n: number): ItemKey => `note:${uuid(10_000 + n)}`;
const source = (n: number): ItemKey => `source:${uuid(20_000 + n)}`;

function topic(n: number, parent: number | null, extra: Partial<AuditTopic> = {}): AuditTopic {
  return {
    id: topicId(n),
    parentId: parent === null ? null : topicId(parent),
    role: parent === null ? "root" : "topic",
    title: `Topic ${n}`,
    management: "ai",
    position: n,
    retiredAt: null,
    redirectTo: null,
    ...extra
  };
}

function place(item: ItemKey, at: number, extra: Partial<AuditPlacement> = {}): AuditPlacement {
  return {
    item,
    topicId: topicId(at),
    rank: 0,
    management: "ai",
    needsGate: false,
    needsSplitCheck: false,
    needsVector: false,
    ...extra
  };
}

const retiredAt = "2026-10-01T00:00:00.000Z";
const fixedNow = () => "2026-10-15T12:00:00.000Z";

/** A small tree: n topics below the root, `per` notes in each leaf. */
function wide(children: number, per: number, first = 2): { input: AuditInput; notes: ItemKey[] } {
  const topics = [topic(1, null)];
  const placements: AuditPlacement[] = [];
  const notes: ItemKey[] = [];
  for (let child = 0; child < children; child += 1) {
    topics.push(topic(first + child, 1));
    for (let k = 0; k < per; k += 1) {
      const item = note(child * 1000 + k);
      notes.push(item);
      placements.push(place(item, first + child));
    }
  }
  return {
    notes,
    input: {
      tree: { id: uuid(900), status: "active", generation: 7, consistent: true },
      config: defaultTopicTreeConfig,
      topics,
      placements,
      expectedItems: notes,
      areasActive: false,
      undo: { days: 7, automatic: 0, undone: 0 }
    }
  };
}

const audit = (input: AuditInput, limit?: number): TopicAuditReport =>
  analyzeTopicTree(input, { now: fixedNow, ...(limit === undefined ? {} : { limit }) });

const hardReasons = (report: TopicAuditReport) =>
  report.details.violations.shown
    .filter((v) => v.severity === "hard" && !v.awaitingApproval)
    .map((v) => `${v.code} ${v.reason} ${v.topicId ?? v.item}`);

describe("a sound tree", () => {
  it("passes E1 with full reachability and no findings", () => {
    const { input } = wide(4, 4);
    const { summary, details } = audit(input);
    expect(summary.e1).toEqual({ passes: true, failures: [] });
    expect(summary.items).toMatchObject({
      expected: 16,
      notes: 16,
      sources: 0,
      reachable: 16,
      reachability: 1,
      placedNotCurrent: 0
    });
    expect(summary.orphans).toEqual({
      unreachableTopics: 0,
      placementsOnRetiredTopics: 0,
      placementsOnUnreachableTopics: 0,
      itemsWithoutPrimary: 0
    });
    expect(summary.violations).toEqual({ hard: 0, soft: 0, awaitingApproval: 0, byReason: [] });
    expect(details.violations).toEqual({ total: 0, shown: [] });
    expect(summary.topics).toEqual({ live: 5, retired: 0, internal: 1, leaves: 4, maxDepth: 1 });
    expect(summary.shape.itemDepth).toMatchObject({ count: 16, mean: 1, max: 1 });
    expect(summary.shape.rootFanOut).toBe(4);
    expect(summary.shape.rootInBand).toBe(true);
    expect(summary.shape.leafSize).toMatchObject({ count: 4, mean: 4, inRange: 1 });
    expect(summary.tree).toEqual({
      status: "active",
      generation: 7,
      consistent: true,
      areasActive: false
    });
  });

  it("is deterministic whatever the order of the rows", () => {
    const { input } = wide(5, 3);
    const reversed: AuditInput = {
      ...input,
      topics: [...input.topics].reverse(),
      placements: [...input.placements].reverse(),
      expectedItems: [...input.expectedItems].reverse()
    };
    expect(JSON.stringify(audit(reversed))).toBe(JSON.stringify(audit(input)));
  });

  it("reports an empty library as reachable with nothing to measure", () => {
    const { summary } = audit(wide(0, 0).input);
    expect(summary.items.reachability).toBeNull();
    expect(summary.shape.itemDepth).toBeNull();
    expect(summary.unsorted.share).toBeNull();
    expect(summary.e1.passes).toBe(true);
  });

  it("refuses a tree without a live root", () => {
    const { input } = wide(2, 3);
    expect(() =>
      audit({ ...input, topics: input.topics.filter((t) => t.role !== "root") })
    ).toThrow(TopicAuditError);
  });
});

describe("planted violations", () => {
  /** Every kind of damage at once, each on its own topic or item. */
  function damaged(): { input: AuditInput; named: Record<string, ItemKey> } {
    const topics: AuditTopic[] = [topic(1, null)];
    const placements: AuditPlacement[] = [];
    const expected: ItemKey[] = [];
    let next = 0;
    const add = (at: number, count: number, extra: Partial<AuditPlacement> = {}): ItemKey[] => {
      const items: ItemKey[] = [];
      for (let k = 0; k < count; k += 1) {
        const item = note((next += 1));
        items.push(item);
        expected.push(item);
        placements.push(place(item, at, extra));
      }
      return items;
    };

    // I3 hard: topic 2 has 17 leaves (above the hard maximum of 16), each a sound 3-note leaf.
    topics.push(topic(2, 1));
    for (let k = 0; k < 17; k += 1) {
      topics.push(topic(100 + k, 2));
      add(100 + k, 3);
    }
    // I4 hard: a leaf of 46 notes (above 45).
    topics.push(topic(3, 1));
    add(3, 46);
    // I6 and I3 soft: a chain of one child; its leaf is sound.
    topics.push(topic(4, 1), topic(5, 4));
    add(5, 3);
    // I4 soft: a one-note leaf.
    topics.push(topic(6, 1));
    add(6, 1);
    // A protected leaf above the hard limit: listed for approval, not a hard violation.
    topics.push(topic(12, 1, { management: "human" }));
    add(12, 46);

    // A retired topic that still carries a primary placement.
    topics.push(topic(7, 1, { retiredAt, redirectTo: topicId(3) }));
    const [onRetired] = add(7, 1);
    // A live topic below a retired one is detached, and so is a pair that are each other's parent.
    topics.push(topic(9, 1, { retiredAt, redirectTo: topicId(3) }), topic(8, 9));
    const [onDetached] = add(8, 1);
    topics.push(topic(10, 11), topic(11, 10));
    // An expected item with no placement, and a placed item that is no longer expected.
    const unplaced = note((next += 1));
    expected.push(unplaced);
    const [stale] = add(6, 1);
    expected.splice(expected.indexOf(stale as ItemKey), 1);

    return {
      named: {
        onRetired: onRetired as ItemKey,
        onDetached: onDetached as ItemKey,
        unplaced,
        stale: stale as ItemKey
      },
      input: {
        tree: { id: uuid(900), status: "active", generation: 3, consistent: true },
        config: defaultTopicTreeConfig,
        topics,
        placements,
        expectedItems: expected,
        areasActive: false,
        undo: { days: 7, automatic: 0, undone: 0 }
      }
    };
  }

  it("reports exactly the planted problems, each once", () => {
    const { input, named } = damaged();
    const { summary, details } = audit(input);

    expect(hardReasons(audit(input, 1000)).sort()).toEqual(
      [
        `I3 fan-out-above-hard-max ${topicId(2)}`,
        `I4 leaf-above-hard-max ${topicId(3)}`,
        `I1 topic-unreachable ${topicId(8)}`,
        `I1 topic-unreachable ${topicId(10)}`,
        `I1 topic-unreachable ${topicId(11)}`,
        `I1 placement-on-retired-topic ${topicId(7)}`,
        `I1 placement-on-unreachable-topic ${topicId(8)}`,
        `I1 item-unplaced ${named.unplaced}`
      ].sort()
    );
    expect(summary.violations.hard).toBe(8);
    expect(summary.violations.soft).toBe(3);
    expect(summary.violations.awaitingApproval).toBe(1);
    expect(summary.violations.byReason).toEqual([
      { code: "I1", severity: "hard", reason: "item-unplaced", awaitingApproval: false, count: 1 },
      {
        code: "I1",
        severity: "hard",
        reason: "placement-on-retired-topic",
        awaitingApproval: false,
        count: 1
      },
      {
        code: "I1",
        severity: "hard",
        reason: "placement-on-unreachable-topic",
        awaitingApproval: false,
        count: 1
      },
      {
        code: "I1",
        severity: "hard",
        reason: "topic-unreachable",
        awaitingApproval: false,
        count: 3
      },
      {
        code: "I3",
        severity: "hard",
        reason: "fan-out-above-hard-max",
        awaitingApproval: false,
        count: 1
      },
      {
        code: "I4",
        severity: "hard",
        reason: "leaf-above-hard-max",
        awaitingApproval: false,
        count: 1
      },
      {
        code: "I3",
        severity: "soft",
        reason: "fan-out-outside-range",
        awaitingApproval: false,
        count: 1
      },
      {
        code: "I4",
        severity: "soft",
        reason: "leaf-size-outside-range",
        awaitingApproval: false,
        count: 1
      },
      { code: "I6", severity: "soft", reason: "single-child", awaitingApproval: false, count: 1 },
      {
        code: "I4",
        severity: "hard",
        reason: "leaf-above-hard-max",
        awaitingApproval: true,
        count: 1
      }
    ]);
    expect(details.violations.shown.filter((v) => v.awaitingApproval)).toEqual([
      {
        code: "I4",
        severity: "hard",
        reason: "leaf-above-hard-max",
        topicId: topicId(12),
        item: null,
        awaitingApproval: true,
        value: 46
      }
    ]);

    expect(summary.orphans).toEqual({
      unreachableTopics: 3,
      placementsOnRetiredTopics: 1,
      placementsOnUnreachableTopics: 1,
      itemsWithoutPrimary: 1
    });
    expect(details.unreachableTopics.shown).toEqual([topicId(10), topicId(11), topicId(8)].sort());
    expect(details.placementsOnRetiredTopics.shown).toEqual([
      { item: named.onRetired, topicId: topicId(7), rank: 0 }
    ]);
    expect(details.placementsOnUnreachableTopics.shown).toEqual([
      { item: named.onDetached, topicId: topicId(8), rank: 0 }
    ]);
    expect(details.itemsWithoutPrimary.shown).toEqual([named.unplaced]);
    expect(details.placedNotCurrent.shown).toEqual([named.stale]);

    // The two items on bad topics and the unplaced one are the only ones not reached.
    expect(summary.items.reachable).toBe(summary.items.expected - 3);
    expect(summary.items.placedNotCurrent).toBe(1);
    expect(summary.e1).toEqual({
      passes: false,
      failures: [
        "reachability",
        "unreachableTopics",
        "placementsOnRetiredTopics",
        "placementsOnUnreachableTopics",
        "itemsWithoutPrimary",
        "hardViolations"
      ]
    });
  });

  it("keeps the totals exact when the lists are cut", () => {
    const { input } = damaged();
    const { details, summary } = audit(input, 2);
    expect(details.violations.total).toBe(
      summary.violations.hard + summary.violations.soft + summary.violations.awaitingApproval
    );
    expect(details.violations.shown).toHaveLength(2);
    expect(details.unreachableTopics.total).toBe(3);
    expect(details.unreachableTopics.shown).toHaveLength(2);
  });

  it("lets a violation on a protected topic wait for approval without failing E1", () => {
    const { input } = wide(3, 3);
    const protectedLeaf = topic(50, 1, { management: "pinned" });
    const items: ItemKey[] = [];
    const placements = [...input.placements];
    for (let k = 0; k < 46; k += 1) {
      items.push(note(90_000 + k));
      placements.push(place(note(90_000 + k), 50));
    }
    const { summary } = audit({
      ...input,
      topics: [...input.topics, protectedLeaf],
      placements,
      expectedItems: [...input.expectedItems, ...items]
    });
    expect(summary.violations).toMatchObject({ hard: 0, awaitingApproval: 1 });
    expect(summary.e1).toEqual({ passes: true, failures: [] });
  });

  it("does not hold the same item twice on one topic, nor two primaries", () => {
    const { input } = wide(3, 3);
    const first = input.placements[0] as AuditPlacement;
    const { details, summary } = audit({
      ...input,
      placements: [...input.placements, { ...first, topicId: topicId(3) }]
    });
    expect(details.violations.shown).toEqual([
      {
        code: "I2",
        severity: "hard",
        reason: "placement-rejected",
        topicId: topicId(3),
        item: first.item,
        awaitingApproval: false,
        value: 0
      }
    ]);
    expect(summary.e1.failures).toEqual(["hardViolations"]);
  });
});

describe("the shape readings", () => {
  it("holds the root to the Areas band once Areas exist (D12)", () => {
    const { input } = wide(14, 3);
    const without = audit(input).summary;
    expect(without.shape.rootInBand).toBe(false);
    expect(without.violations.byReason).toEqual([
      {
        code: "I3",
        severity: "soft",
        reason: "fan-out-outside-range",
        awaitingApproval: false,
        count: 1
      }
    ]);
    const withAreas = audit({ ...input, areasActive: true }).summary;
    expect(withAreas.shape.rootInBand).toBe(true);
    expect(withAreas.violations.byReason).toEqual([]);
    expect(withAreas.tree.areasActive).toBe(true);
  });

  it("reads depth and fan-out below the root, apart from the root", () => {
    // root -> A (5 leaves of 3) and B (2 leaves of 3): internal non-root fan-outs 5 and 2.
    const topics = [topic(1, null), topic(2, 1), topic(3, 1)];
    const placements: AuditPlacement[] = [];
    const expected: ItemKey[] = [];
    let at = 10;
    for (const [parent, leaves] of [
      [2, 5],
      [3, 2]
    ] as const) {
      for (let k = 0; k < leaves; k += 1) {
        topics.push(topic(at, parent));
        for (let j = 0; j < 3; j += 1) {
          const item = note(at * 10 + j);
          expected.push(item);
          placements.push(place(item, at));
        }
        at += 1;
      }
    }
    const { input } = wide(0, 0);
    const { summary } = audit({ ...input, topics, placements, expectedItems: expected });
    expect(summary.shape.fanOut).toMatchObject({ count: 2, mean: 3.5, max: 5, inTarget: 0.5 });
    expect(summary.shape.rootFanOut).toBe(2);
    expect(summary.shape.itemDepth).toMatchObject({ count: 21, mean: 2, max: 2 });
    expect(summary.topics).toMatchObject({ internal: 3, leaves: 7, maxDepth: 2 });
    expect(summary.e2).toEqual({
      meanDepthWithin: true,
      fanOutInTargetWithin: false,
      noSingleChild: true
    });
    expect(auditTargets.meanDepth).toBe(4.5);
  });
});

describe("Unsorted (D27)", () => {
  /** root: n1, n2, and s1 waiting for a vector; A (internal): n3 waiting for the gate, n4 ordinary; B, C leaves. */
  function sorted() {
    const topics = [topic(1, null), topic(2, 1), topic(3, 2), topic(4, 2)];
    const placements = [
      place(note(1), 1),
      place(note(2), 1),
      place(source(1), 1, { needsVector: true }),
      place(note(3), 2, { needsGate: true }),
      place(note(4), 2),
      place(note(5), 3, { needsGate: true }),
      place(note(6), 4)
    ];
    const { input } = wide(0, 0);
    return {
      ...input,
      topics,
      placements,
      expectedItems: placements.map((p) => p.item)
    } satisfies AuditInput;
  }

  it("counts the root's direct items and items waiting at a topic, and sets vectors apart", () => {
    const { summary } = audit(sorted());
    expect(summary.unsorted).toMatchObject({
      rootItems: 2,
      waitingAtAncestor: 1,
      share: 3 / 7,
      meetsTarget: null
    });
    expect(summary.needsVector).toEqual({ notes: 0, sources: 1 });
    expect(summary.items).toMatchObject({ notes: 6, sources: 1 });
  });

  it("leaves out placed items that are no longer current", () => {
    const input = sorted();
    const { summary } = audit({ ...input, placements: [...input.placements, place(note(99), 1)] });
    expect(summary.unsorted).toMatchObject({ rootItems: 2, waitingAtAncestor: 1 });
    expect(summary.items.placedNotCurrent).toBe(1);
  });

  it("applies the target only from the minimum number of items", () => {
    const build = (atRoot: number) => {
      const { input } = wide(4, 15);
      const placements = [...input.placements];
      for (let k = 0; k < atRoot; k += 1) placements.push(place(note(70_000 + k), 1));
      const extra = Array.from({ length: atRoot }, (_, k) => note(70_000 + k));
      return audit({
        ...input,
        placements,
        expectedItems: [...input.expectedItems, ...extra]
      }).summary.unsorted;
    };
    // 60 items in the leaves plus the root's: 1 of 61 is 1.6%, 2 of 62 is 3.2% (target 2%).
    expect(build(1)).toMatchObject({ rootItems: 1, meetsTarget: true });
    expect(build(2)).toMatchObject({ rootItems: 2, meetsTarget: false });
  });
});

describe("the undo rate", () => {
  const rate = (automatic: number, undone: number) =>
    audit({ ...wide(3, 3).input, undo: { days: 7, automatic, undone } }).summary.undo;

  it("is the undone share of the automatic change-sets in the window", () => {
    expect(rate(20, 1)).toEqual({
      windowDays: 7,
      automatic: 20,
      undone: 1,
      rate: 0.05,
      target: 0.05,
      meetsTarget: true
    });
    expect(rate(20, 2)).toMatchObject({ rate: 0.1, meetsTarget: false });
  });

  it("stays unknown when nothing automatic happened", () => {
    expect(rate(0, 0)).toMatchObject({ rate: null, meetsTarget: null });
  });
});
