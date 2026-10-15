// The topic tree engine as the desktop main process sees it: imported through the
// `@app/domain/topic-tree` subpath (the built package), driven by graphology's Louvain, the
// product community detector. The build must equal Spike B's builder exactly (pinned below).
import { createHash } from "node:crypto";

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { describe, expect, it } from "vitest";

import {
  buildLouvain,
  canonicalPartition,
  defaultSyntheticOptions,
  defaultTopicTreeConfig,
  gaussianClusters,
  leafLabels,
  nmi,
  rowItemKey,
  shapeReport
} from "@app/domain/topic-tree";
import type { DetectCommunities } from "@app/domain/topic-tree";

const config = defaultTopicTreeConfig;
const seed = 20261014;

/** Louvain on graphology: nodes in index order, edges in array order, seeded rng only. */
const graphologyLouvain: DetectCommunities = (graph, { resolution, rng }) => {
  const g = new Graph({ type: "undirected", allowSelfLoops: false });
  for (let node = 0; node < graph.nodeCount; node += 1) g.addNode(String(node));
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    g.addEdge(String(graph.sources[edge]), String(graph.targets[edge]), {
      weight: graph.weights[edge]
    });
  }
  const mapping = louvain(g, { resolution, getEdgeWeight: "weight", rng });
  return Int32Array.from(
    { length: graph.nodeCount },
    (_, node) => mapping[String(node)] ?? -1 - node
  );
};

describe("@app/domain/topic-tree in the desktop main process", () => {
  const data = gaussianClusters(defaultSyntheticOptions);
  const rows = Array.from({ length: data.matrix.count }, (_, row) => row);
  const keys = rows.map(rowItemKey);

  it("builds the Spike B Louvain tree exactly, with valid shape and recovered clusters", () => {
    const result = buildLouvain(data.matrix, rows, {
      seed,
      config,
      detectCommunities: graphologyLouvain
    });
    // SHA-256 of the canonical tree that scripts/spikes/topic-tree/builders.ts builds for the
    // same data, seed and configuration (measured when the engine was ported, T03).
    expect(createHash("sha256").update(canonicalPartition(result.state)).digest("hex")).toBe(
      "faaebc13487d2d53bc90a086de1e9bbff7b820c2119bde97a1472479e3b61552"
    );
    const shape = shapeReport(result.state, config, { expectedItems: keys });
    expect(shape.reachability).toBe(1);
    expect(shape.violations.hard).toEqual([]);
    expect(shape.fanOut.inRange).toBe(1);
    expect(shape.leafSize.inRange).toBe(1);
    expect(shape.leafDepth.max).toBeLessThanOrEqual(config.depth.target);
    expect(shape.singleChildTopics).toBe(0);
    expect(nmi(leafLabels(result.state, keys), data.clusters)).toBeGreaterThanOrEqual(0.8);
    const again = buildLouvain(data.matrix, rows, {
      seed,
      config,
      detectCommunities: graphologyLouvain
    });
    expect(canonicalPartition(again.state)).toBe(canonicalPartition(result.state));
  });

  it("keeps 9 Areas when the root has more communities than fanOut.max (legacy grouping: 2)", () => {
    const wide = gaussianClusters({
      ...defaultSyntheticOptions,
      groups: 13,
      clustersPerGroup: 1,
      pointsPerCluster: 60,
      seed: 11
    });
    const wideRows = Array.from({ length: wide.matrix.count }, (_, row) => row);
    const fixed = buildLouvain(wide.matrix, wideRows, {
      seed,
      config,
      detectCommunities: graphologyLouvain
    });
    const legacy = buildLouvain(wide.matrix, wideRows, {
      seed,
      config,
      detectCommunities: graphologyLouvain,
      rootGrouping: "legacy"
    });
    expect(fixed.diagnostics).toMatchObject({
      rootCommunities: 13,
      rootChildren: 9,
      rootSuperGrouped: true
    });
    expect(legacy.diagnostics).toMatchObject({ rootCommunities: 13, rootChildren: 2 });
    expect(shapeReport(fixed.state, config).violations.hard).toEqual([]);
  });
});
