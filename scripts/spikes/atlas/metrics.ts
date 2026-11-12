// Pure metrics of the Atlas spike (F5 D21): neighbour purity in the vector space, contiguity in the
// 2-D map, connected components of the 2-D neighbour graph and the share two maps agree (Procrustes
// lives in procrustes.ts). No I/O: every function takes arrays and returns numbers.

/** A neighbour table: row i holds `stride` neighbour indices (-1 when fewer exist), nearest first. */
export interface NeighbourTable {
  neighbors: Int32Array;
  stride: number;
}

/** Brute-force 2-D k nearest neighbours (Euclidean; ties keep the lower index). */
export function nearestNeighbours2d(points: Float64Array, k: number): NeighbourTable {
  const n = points.length / 2;
  const neighbors = new Int32Array(n * k).fill(-1);
  const distances = new Float64Array(n * k).fill(Infinity);
  for (let i = 0; i < n; i += 1) {
    const x = points[2 * i] as number;
    const y = points[2 * i + 1] as number;
    const base = i * k;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const dx = (points[2 * j] as number) - x;
      const dy = (points[2 * j + 1] as number) - y;
      const distance = dx * dx + dy * dy;
      if (distance >= (distances[base + k - 1] as number)) continue;
      let position = k - 1;
      while (position > 0 && (distances[base + position - 1] as number) > distance) {
        distances[base + position] = distances[base + position - 1] as number;
        neighbors[base + position] = neighbors[base + position - 1] as number;
        position -= 1;
      }
      distances[base + position] = distance;
      neighbors[base + position] = j;
    }
  }
  return { neighbors, stride: k };
}

export interface LabelShare {
  label: number;
  members: number;
  /** Mean over the label's members of the share of their neighbours that carry the label. */
  share: number;
}

export interface SharedLabelReport {
  /** Mean over every measured member (a note-weighted mean). */
  overall: number;
  /** Mean of the branch means over the branches with at least `macroMinMembers` members. */
  macro: number;
  /** The lowest branch mean among those branches. */
  lowest: number;
  measured: number;
  byLabel: LabelShare[];
}

/**
 * The share of each measured member's first `use` neighbours that carry its label. `labels[i]` is -1
 * for a point that is on the map but is not a measured member; such a point is a neighbour that
 * never matches. Used for kNN purity (vector-space table) and contiguity (2-D table) alike.
 */
export function sharedLabelShare(
  table: NeighbourTable,
  labels: Int32Array,
  use: number,
  macroMinMembers = 5
): SharedLabelReport {
  const n = labels.length;
  const sums = new Map<number, { members: number; sum: number }>();
  let total = 0;
  let measured = 0;
  for (let i = 0; i < n; i += 1) {
    const label = labels[i] as number;
    if (label < 0) continue;
    let same = 0;
    let seen = 0;
    for (let slot = 0; slot < use; slot += 1) {
      const neighbour = table.neighbors[i * table.stride + slot] as number;
      if (neighbour < 0) continue;
      seen += 1;
      if (labels[neighbour] === label) same += 1;
    }
    const share = seen === 0 ? 0 : same / seen;
    total += share;
    measured += 1;
    const entry = sums.get(label) ?? { members: 0, sum: 0 };
    entry.members += 1;
    entry.sum += share;
    sums.set(label, entry);
  }
  const byLabel = [...sums.entries()]
    .map(([label, entry]) => ({ label, members: entry.members, share: entry.sum / entry.members }))
    .sort((a, b) => b.members - a.members || a.label - b.label);
  const large = byLabel.filter((entry) => entry.members >= macroMinMembers);
  return {
    overall: measured === 0 ? Number.NaN : total / measured,
    macro:
      large.length === 0 ? Number.NaN : large.reduce((sum, e) => sum + e.share, 0) / large.length,
    lowest: large.length === 0 ? Number.NaN : Math.min(...large.map((entry) => entry.share)),
    measured,
    byLabel
  };
}

/**
 * The share two points of the same label would reach by chance: the sum over labels of the squared
 * label frequency among the measured members. The reference line for purity and contiguity.
 */
export function chanceShare(labels: Int32Array): number {
  const counts = new Map<number, number>();
  let total = 0;
  for (const label of labels) {
    if (label < 0) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return Number.NaN;
  let sum = 0;
  for (const count of counts.values()) sum += (count / total) ** 2;
  return sum;
}

export interface ComponentShare {
  label: number;
  members: number;
  /** Connected components of the label's members in the (symmetrised) 2-D neighbour graph. */
  components: number;
  /** The share of the label's members that sit in its largest component. */
  largestShare: number;
}

/**
 * Connected components of each branch in the 2-D kNN graph: an edge joins two members of the same
 * branch when either lists the other among its first `use` neighbours. One component with a share
 * near 1 means the branch is drawn as one region; many components mean it is scattered.
 */
export function branchComponents(
  table: NeighbourTable,
  labels: Int32Array,
  use: number
): ComponentShare[] {
  const n = labels.length;
  const parent = new Int32Array(n).map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    let current = index;
    while (parent[current] !== root) {
      const next = parent[current] as number;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  for (let i = 0; i < n; i += 1) {
    const label = labels[i] as number;
    if (label < 0) continue;
    for (let slot = 0; slot < use; slot += 1) {
      const neighbour = table.neighbors[i * table.stride + slot] as number;
      if (neighbour < 0 || labels[neighbour] !== label) continue;
      const a = find(i);
      const b = find(neighbour);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const sizes = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i += 1) {
    const label = labels[i] as number;
    if (label < 0) continue;
    const roots = sizes.get(label) ?? new Map<number, number>();
    const root = find(i);
    roots.set(root, (roots.get(root) ?? 0) + 1);
    sizes.set(label, roots);
  }
  return [...sizes.entries()]
    .map(([label, roots]) => {
      const counts = [...roots.values()];
      const members = counts.reduce((sum, count) => sum + count, 0);
      return {
        label,
        members,
        components: counts.length,
        largestShare: Math.max(...counts) / members
      };
    })
    .sort((a, b) => b.members - a.members || a.label - b.label);
}
