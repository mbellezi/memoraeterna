// The product community detector of the topic tree builders: Louvain on graphology
// (graphology-communities-louvain), injected into `buildLouvain` so `@app/domain/topic-tree`
// itself stays free of graphology (section 3.4). The clustering worker (T13) and the replay
// scripts (`scripts/topics/*`) both import this module.
//
// Determinism contract (the Spike B builder, bit for bit): nodes are added in index order, edges
// in array order, and the only randomness is the seeded `rng` the builder hands over.
import Graph from "graphology";
import louvain from "graphology-communities-louvain";

import type { CommunityGraph, DetectCommunities } from "@app/domain/topic-tree";

/**
 * Community label per node of `graph`. Nodes Louvain leaves out (isolated ones) get a distinct
 * negative label, so each stays its own community.
 */
export const detectCommunitiesLouvain: DetectCommunities = (
  graph: CommunityGraph,
  { resolution, rng }
) => {
  const topology = new Graph({ type: "undirected", allowSelfLoops: false });
  for (let node = 0; node < graph.nodeCount; node += 1) topology.addNode(String(node));
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    topology.addEdge(String(graph.sources[edge]), String(graph.targets[edge]), {
      weight: graph.weights[edge]
    });
  }
  const mapping = louvain(topology, { resolution, getEdgeWeight: "weight", rng });
  return Int32Array.from(
    { length: graph.nodeCount },
    (_, node) => mapping[String(node)] ?? -1 - node
  );
};
