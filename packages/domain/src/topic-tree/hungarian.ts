// Assignment solvers for the ID-preserving rebuild (rebuild-map.ts, plan 4.1 "Shadow rebuild").
//
// `solveAssignment` is the Hungarian algorithm (Kuhn-Munkres with potentials, O(n^2 m)) for a
// dense rectangular cost matrix. `maxWeightMatching` matches the two sides of a sparse weighted
// bipartite graph: each connected component is solved exactly when both of its sides have at
// most `exactMaxNodes` nodes, and greedily (heaviest edge first) above that. Every result is a
// function of the input order only: callers pass nodes in content-key order (D22), and ties go to
// the lower index.

export interface Assignment {
  /** Column of each row, or -1 when the row is unassigned (more rows than columns). */
  rowToColumn: Int32Array;
  /** Row of each column, or -1 when the column is unassigned (more columns than rows). */
  columnToRow: Int32Array;
  /** Sum of the costs of the assigned pairs. */
  cost: number;
}

export class AssignmentError extends Error {
  override readonly name = "AssignmentError";
}

function checkCosts(costs: readonly (readonly number[])[]): { rows: number; columns: number } {
  const rows = costs.length;
  const columns = costs[0]?.length ?? 0;
  for (const [index, row] of costs.entries()) {
    if (row.length !== columns) {
      throw new AssignmentError(`Row ${index} has ${row.length} columns, expected ${columns}`);
    }
    for (const value of row) {
      if (!Number.isFinite(value)) throw new AssignmentError(`Row ${index} has a non-finite cost`);
    }
  }
  return { rows, columns };
}

/**
 * Minimum-cost assignment of a rows x columns cost matrix: every row is assigned when
 * rows <= columns, every column otherwise. Costs must be finite (negative values are allowed).
 */
export function solveAssignment(costs: readonly (readonly number[])[]): Assignment {
  const { rows, columns } = checkCosts(costs);
  const transpose = rows > columns;
  const n = transpose ? columns : rows;
  const m = transpose ? rows : columns;
  const cost = (i: number, j: number): number =>
    (transpose ? costs[j]?.[i] : costs[i]?.[j]) as number;

  // 1-indexed potentials; p[j] = row matched to column j (0 = none), way[j] = previous column.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Number.POSITIVE_INFINITY);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0] as number;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const current = cost(i0 - 1, j - 1) - (u[i0] as number) - (v[j] as number);
        if (current < (minv[j] as number)) {
          minv[j] = current;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          const row = p[j] as number;
          u[row] = (u[row] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToColumn = new Int32Array(rows).fill(-1);
  const columnToRow = new Int32Array(columns).fill(-1);
  let total = 0;
  for (let j = 1; j <= m; j += 1) {
    const i = p[j] as number;
    if (i === 0) continue;
    const row = transpose ? j - 1 : i - 1;
    const column = transpose ? i - 1 : j - 1;
    rowToColumn[row] = column;
    columnToRow[column] = row;
    total += costs[row]?.[column] as number;
  }
  return { rowToColumn, columnToRow, cost: total };
}

export interface WeightedEdge {
  left: number;
  right: number;
  /** Positive weight (an edge with weight <= 0 is never worth matching and is ignored). */
  weight: number;
}

export interface Matching {
  /** Right node of each left node, or -1. */
  leftToRight: Int32Array;
  /** Left node of each right node, or -1. */
  rightToLeft: Int32Array;
  /** Sum of the matched edge weights. */
  weight: number;
  /** True when every component was solved exactly. */
  exact: boolean;
  /** Connected components with at least one edge, and how many were solved greedily. */
  components: number;
  greedyComponents: number;
}

class UnionFind {
  private readonly parent: Int32Array;
  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, index) => index);
  }
  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    let current = node;
    while (this.parent[current] !== root) {
      const next = this.parent[current] as number;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

function compareEdges(a: WeightedEdge, b: WeightedEdge): number {
  return b.weight - a.weight || a.left - b.left || a.right - b.right;
}

/**
 * Maximum-weight matching of a sparse bipartite graph (left 0..leftCount-1, right
 * 0..rightCount-1). Components whose sides both have at most `exactMaxNodes` nodes are solved
 * exactly with the Hungarian algorithm; larger ones greedily, heaviest edge first.
 */
export function maxWeightMatching(
  leftCount: number,
  rightCount: number,
  edges: readonly WeightedEdge[],
  options: { exactMaxNodes: number }
): Matching {
  const leftToRight = new Int32Array(leftCount).fill(-1);
  const rightToLeft = new Int32Array(rightCount).fill(-1);
  const usable: WeightedEdge[] = [];
  const seen = new Map<number, WeightedEdge>();
  for (const edge of edges) {
    if (
      !Number.isInteger(edge.left) ||
      !Number.isInteger(edge.right) ||
      edge.left < 0 ||
      edge.left >= leftCount ||
      edge.right < 0 ||
      edge.right >= rightCount
    ) {
      throw new AssignmentError(`Edge ${edge.left}-${edge.right} is out of range`);
    }
    if (!Number.isFinite(edge.weight)) throw new AssignmentError("Edge weights must be finite");
    if (edge.weight <= 0) continue;
    const key = edge.left * rightCount + edge.right;
    const existing = seen.get(key);
    if (existing === undefined) {
      const copy = { ...edge };
      seen.set(key, copy);
      usable.push(copy);
    } else if (edge.weight > existing.weight) {
      existing.weight = edge.weight;
    }
  }

  // Components over left nodes 0..L-1 and right nodes L..L+R-1.
  const sets = new UnionFind(leftCount + rightCount);
  for (const edge of usable) sets.union(edge.left, leftCount + edge.right);
  const byComponent = new Map<number, WeightedEdge[]>();
  for (const edge of usable) {
    const root = sets.find(edge.left);
    const list = byComponent.get(root) ?? [];
    list.push(edge);
    byComponent.set(root, list);
  }

  let weight = 0;
  let greedyComponents = 0;
  const roots = [...byComponent.keys()].sort((a, b) => a - b);
  for (const root of roots) {
    const componentEdges = byComponent.get(root) as WeightedEdge[];
    const lefts = [...new Set(componentEdges.map((edge) => edge.left))].sort((a, b) => a - b);
    const rights = [...new Set(componentEdges.map((edge) => edge.right))].sort((a, b) => a - b);
    if (Math.max(lefts.length, rights.length) <= options.exactMaxNodes) {
      const leftIndex = new Map(lefts.map((node, index) => [node, index]));
      const rightIndex = new Map(rights.map((node, index) => [node, index]));
      // Maximize weight = minimize -weight; a missing edge costs 0 (equivalent to unmatched).
      const costs = lefts.map(() => new Array<number>(rights.length).fill(0));
      for (const edge of componentEdges) {
        const row = costs[leftIndex.get(edge.left) as number] as number[];
        row[rightIndex.get(edge.right) as number] = -edge.weight;
      }
      const assignment = solveAssignment(costs);
      const weightOf = new Map(
        componentEdges.map((edge) => [edge.left * rightCount + edge.right, edge.weight])
      );
      assignment.rowToColumn.forEach((column, row) => {
        if (column < 0) return;
        const left = lefts[row] as number;
        const right = rights[column] as number;
        const edgeWeight = weightOf.get(left * rightCount + right);
        if (edgeWeight === undefined) return;
        leftToRight[left] = right;
        rightToLeft[right] = left;
        weight += edgeWeight;
      });
    } else {
      greedyComponents += 1;
      for (const edge of [...componentEdges].sort(compareEdges)) {
        if (leftToRight[edge.left] !== -1 || rightToLeft[edge.right] !== -1) continue;
        leftToRight[edge.left] = edge.right;
        rightToLeft[edge.right] = edge.left;
        weight += edge.weight;
      }
    }
  }
  return {
    leftToRight,
    rightToLeft,
    weight,
    exact: greedyComponents === 0,
    components: roots.length,
    greedyComponents
  };
}
