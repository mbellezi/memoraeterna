import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildLouvain,
  canonicalPartition,
  createRng,
  defaultSyntheticOptions,
  defaultTopicTreeConfig,
  gaussianClusters
} from "@app/domain/topic-tree";
import type { CommunityGraph } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "./topic-communities.js";

/** Two triangles joined by one weak edge, plus an isolated node. */
function twoTriangles(): CommunityGraph {
  return {
    nodeCount: 7,
    sources: Int32Array.from([0, 0, 1, 3, 3, 4, 2]),
    targets: Int32Array.from([1, 2, 2, 4, 5, 5, 3]),
    weights: Float64Array.from([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.05])
  };
}

describe("detectCommunitiesLouvain", () => {
  it("separates dense groups and leaves an isolated node alone", () => {
    const labels = detectCommunitiesLouvain(twoTriangles(), {
      resolution: 1,
      rng: createRng(7).next
    });
    expect(labels).toHaveLength(7);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[1]).toBe(labels[2]);
    expect(labels[3]).toBe(labels[4]);
    expect(labels[4]).toBe(labels[5]);
    expect(labels[0]).not.toBe(labels[3]);
    expect([labels[6]]).not.toContain(labels[0]);
    expect([labels[6]]).not.toContain(labels[3]);
  });

  it("is deterministic for a fixed rng seed", () => {
    const run = () =>
      Array.from(
        detectCommunitiesLouvain(twoTriangles(), { resolution: 1, rng: createRng(3).next })
      );
    expect(run()).toEqual(run());
  });

  it("builds the exact Spike B tree through buildLouvain (pinned canonical partition)", () => {
    const data = gaussianClusters(defaultSyntheticOptions);
    const rows = Array.from({ length: data.matrix.count }, (_, row) => row);
    const result = buildLouvain(data.matrix, rows, {
      seed: 20261014,
      config: defaultTopicTreeConfig,
      detectCommunities: detectCommunitiesLouvain
    });
    // The same hash topic-tree-engine.test.ts pins for the Spike B builder on this data.
    expect(createHash("sha256").update(canonicalPartition(result.state)).digest("hex")).toBe(
      "faaebc13487d2d53bc90a086de1e9bbff7b820c2119bde97a1472479e3b61552"
    );
  });
});
