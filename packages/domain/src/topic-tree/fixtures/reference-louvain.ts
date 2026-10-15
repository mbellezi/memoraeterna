// A small deterministic Louvain (Blondel et al.) used by the domain tests, which cannot import
// graphology. The product detector is graphology-communities-louvain in the desktop worker
// (apps/desktop, T09); this one only has to find sensible modularity communities for the
// synthetic self-check data. Not exported from the package.
import type { CommunityGraph, DetectCommunities } from "../build.js";

interface LevelGraph {
  /** Neighbour -> weight per node (no self entries). */
  adjacency: Map<number, number>[];
  /** Internal (self-loop) weight per node. */
  selfLoops: number[];
}

function levelFromEdges(graph: CommunityGraph): LevelGraph {
  const adjacency = Array.from({ length: graph.nodeCount }, () => new Map<number, number>());
  for (let e = 0; e < graph.sources.length; e += 1) {
    const a = graph.sources[e] as number;
    const b = graph.targets[e] as number;
    const w = graph.weights[e] as number;
    adjacency[a]?.set(b, (adjacency[a]?.get(b) ?? 0) + w);
    adjacency[b]?.set(a, (adjacency[b]?.get(a) ?? 0) + w);
  }
  return { adjacency, selfLoops: new Array<number>(graph.nodeCount).fill(0) };
}

/** One local-moving phase; returns the community of each level node and whether anything moved. */
function moveNodes(
  level: LevelGraph,
  resolution: number,
  rng: () => number
): { community: number[]; moved: boolean } {
  const n = level.adjacency.length;
  const degree = level.adjacency.map((neighbours, i) => {
    let total = 2 * (level.selfLoops[i] as number);
    for (const w of neighbours.values()) total += w;
    return total;
  });
  const twoM = degree.reduce((total, value) => total + value, 0);
  const community = Array.from({ length: n }, (_, i) => i);
  const totals = [...degree];
  let movedAny = false;
  if (twoM === 0) return { community, moved: false };
  for (let sweep = 0; sweep < 100; sweep += 1) {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    let moved = false;
    for (const node of order) {
      const k = degree[node] as number;
      const weights = new Map<number, number>();
      for (const [neighbour, w] of level.adjacency[node] ?? []) {
        const c = community[neighbour] as number;
        weights.set(c, (weights.get(c) ?? 0) + w);
      }
      const own = community[node] as number;
      totals[own] = (totals[own] as number) - k;
      let best = own;
      let bestGain = (weights.get(own) ?? 0) - (resolution * (totals[own] as number) * k) / twoM;
      for (const [c, w] of weights) {
        const gain = w - (resolution * (totals[c] as number) * k) / twoM;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      totals[best] = (totals[best] as number) + k;
      community[node] = best;
      if (best !== own) moved = true;
    }
    if (!moved) break;
    movedAny = true;
  }
  return { community, moved: movedAny };
}

function aggregate(
  level: LevelGraph,
  community: number[]
): { level: LevelGraph; renumber: number[] } {
  const ids = new Map<number, number>();
  const renumber = community.map((c) => {
    if (!ids.has(c)) ids.set(c, ids.size);
    return ids.get(c) as number;
  });
  const adjacency = Array.from({ length: ids.size }, () => new Map<number, number>());
  const selfLoops = new Array<number>(ids.size).fill(0);
  level.adjacency.forEach((neighbours, i) => {
    const ci = renumber[i] as number;
    selfLoops[ci] = (selfLoops[ci] as number) + (level.selfLoops[i] as number);
    for (const [j, w] of neighbours) {
      const cj = renumber[j] as number;
      if (ci === cj) {
        if (i < j) selfLoops[ci] = (selfLoops[ci] as number) + w;
      } else {
        adjacency[ci]?.set(cj, (adjacency[ci]?.get(cj) ?? 0) + w);
      }
    }
  });
  return { level: { adjacency, selfLoops }, renumber };
}

export const referenceLouvain: DetectCommunities = (graph, { resolution, rng }) => {
  let level = levelFromEdges(graph);
  const assignment = Array.from({ length: graph.nodeCount }, (_, i) => i);
  for (let pass = 0; pass < 32; pass += 1) {
    const { community, moved } = moveNodes(level, resolution, rng);
    if (!moved) break;
    const next = aggregate(level, community);
    for (let i = 0; i < assignment.length; i += 1) {
      assignment[i] = next.renumber[assignment[i] as number] as number;
    }
    level = next.level;
  }
  return Int32Array.from(assignment);
};
