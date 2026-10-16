import { describe, expect, it } from "vitest";

import {
  createTopicTreeState,
  defaultTopicTreeConfig,
  insertPlacement,
  insertTopic,
  placementRecord,
  registerItem,
  rowContentHash,
  rowItemKey,
  topicRecord,
  topicTreeConfigWith
} from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { agreement, fixtureReading, sourceGrowthRun, sourcesInOrder } from "./growth-quality.js";
import { smallSyntheticOptions, syntheticDataset } from "./synthetic-dataset.js";

// 12 sources of 20 notes in 3 domains.
const dataset = syntheticDataset({
  ...smallSyntheticOptions,
  groups: 3,
  clustersPerGroup: 4,
  pointsPerCluster: 20,
  dim: 16
});

describe("the growth-quality measure", () => {
  it("groups the rows by root source in import order", () => {
    const sources = sourcesInOrder(dataset);
    expect(sources).toHaveLength(12);
    expect(sources[0]?.rows).toEqual(Array.from({ length: 20 }, (_, row) => row));
    expect(sources.flatMap((source) => source.rows)).toHaveLength(dataset.rows.length);
  });

  it("grows a library source by source and compares it with a fresh build", () => {
    const config = topicTreeConfigWith({ stability: { freshHours: 24 } });
    for (const calendar of ["session", "daily"] as const) {
      const reading = sourceGrowthRun(dataset, {
        calendar,
        seed: 7,
        config,
        detect: detectCommunitiesLouvain,
        renameDrifts: [0.3, 0.5]
      });
      expect(reading.rows).toBe(dataset.rows.length);
      expect(reading.coldStartAt).toBe(20);
      expect(reading.grown.reachability).toBe(1);
      expect(reading.grown.hardViolations).toBe(0);
      expect(reading.fresh.reachability).toBe(1);
      // Doubling rebuilds keep a growing library close to its fresh build.
      expect(reading.rebuilds.some((rebuild) => rebuild.trigger === "doubling")).toBe(true);
      expect(reading.agreement.leafPurity).toBeGreaterThan(0.8);
      expect(reading.truth.grown?.leafDomainPurity).toBeGreaterThan(0.9);
      expect(reading.naming.named).toBeGreaterThan(0);
      expect(Object.keys(reading.naming.peakDayCalls)).toEqual(["0.3", "0.5"]);
      expect(reading.fixture).toBeNull();
    }
  }, 60_000);

  it("is deterministic", () => {
    const run = () =>
      sourceGrowthRun(dataset, {
        calendar: "daily",
        seed: 9,
        config: defaultTopicTreeConfig,
        detect: detectCommunitiesLouvain
      });
    const { ms: _first, ...first } = run();
    const { ms: _second, ...second } = run();
    void _first;
    void _second;
    expect(second).toEqual(first);
  }, 60_000);

  it("reads agreement and the fixture check from majority leaves", () => {
    // Root -> P -> {L1, L2}, root -> L3. Sources a and b share L1; c is in L2 (a sibling of
    // L1 under P); d is alone in L3.
    const state = createTopicTreeState({ dim: 4, rootId: "0" });
    for (const [id, parent] of [
      ["P", "0"],
      ["L1", "P"],
      ["L2", "P"],
      ["L3", "0"]
    ] as const) {
      insertTopic(state, topicRecord(id, parent));
    }
    const sources = [
      { id: "a", rows: [0, 1], leaf: "L1" },
      { id: "b", rows: [2, 3], leaf: "L1" },
      { id: "c", rows: [4, 5], leaf: "L2" },
      { id: "d", rows: [6, 7], leaf: "L3" }
    ];
    for (const source of sources) {
      for (const row of source.rows) {
        const key = rowItemKey(row);
        registerItem(state, {
          key,
          kind: "note",
          contentHash: rowContentHash(row),
          rootSource: null
        });
        insertPlacement(state, key, placementRecord(source.leaf));
      }
    }
    const reading = fixtureReading(
      state,
      {
        expected: [
          ["a", "b"],
          ["a", "c"]
        ],
        forbidden: [
          ["a", "d"],
          ["c", "d"]
        ]
      },
      sources
    );
    expect(reading.expected).toEqual({
      pairs: 2,
      sameLeaf: 0.5,
      sameLeafOrSibling: 1,
      notePairsSameLeaf: 0.5
    });
    expect(reading.forbidden.sameLeafOrSibling).toBe(0);
    expect(reading.passes).toBe(true);
    const keys = Array.from({ length: 8 }, (_, row) => rowItemKey(row));
    expect(agreement(state, state, keys)).toEqual({
      leafNmi: 1,
      depth1Nmi: 1,
      leafPurity: 1,
      freshPurity: 1
    });
  });
});
