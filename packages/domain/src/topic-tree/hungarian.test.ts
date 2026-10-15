import { describe, expect, it } from "vitest";

import { AssignmentError, maxWeightMatching, solveAssignment } from "./hungarian.js";
import type { WeightedEdge } from "./hungarian.js";
import { createRng } from "./rng.js";

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const output: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let position = 0; position <= rest.length; position += 1) {
      output.push([...rest.slice(0, position), n - 1, ...rest.slice(position)]);
    }
  }
  return output;
}

const allPermutations8 = permutations(8);

function bruteForceMin(costs: number[][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const permutation of allPermutations8) {
    let total = 0;
    for (let row = 0; row < 8; row += 1)
      total += costs[row]?.[permutation[row] as number] as number;
    best = Math.min(best, total);
  }
  return best;
}

/** Brute-force maximum-weight matching (subsets of edges) for small sparse graphs. */
function bruteForceMatching(edges: WeightedEdge[]): number {
  let best = 0;
  const search = (index: number, left: Set<number>, right: Set<number>, total: number): void => {
    best = Math.max(best, total);
    for (let next = index; next < edges.length; next += 1) {
      const edge = edges[next] as WeightedEdge;
      if (left.has(edge.left) || right.has(edge.right)) continue;
      left.add(edge.left);
      right.add(edge.right);
      search(next + 1, left, right, total + edge.weight);
      left.delete(edge.left);
      right.delete(edge.right);
    }
  };
  search(0, new Set(), new Set(), 0);
  return best;
}

describe("Hungarian assignment", () => {
  it("equals brute force on random 8x8 matrices (integer and real costs)", () => {
    const rng = createRng(20261014);
    for (let trial = 0; trial < 60; trial += 1) {
      const integer = trial % 2 === 0;
      const costs = Array.from({ length: 8 }, () =>
        Array.from({ length: 8 }, () => (integer ? rng.int(20) - 5 : rng.next() * 10 - 3))
      );
      const result = solveAssignment(costs);
      expect(result.cost).toBeCloseTo(bruteForceMin(costs), 9);
      expect([...result.rowToColumn].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      result.rowToColumn.forEach((column, row) => expect(result.columnToRow[column]).toBe(row));
    }
  });

  it("assigns every row of a wide matrix and every column of a tall one", () => {
    const rng = createRng(3);
    const wide = Array.from({ length: 3 }, () => Array.from({ length: 6 }, () => rng.next()));
    const wideResult = solveAssignment(wide);
    expect([...wideResult.rowToColumn].every((column) => column >= 0)).toBe(true);
    expect([...wideResult.columnToRow].filter((row) => row >= 0)).toHaveLength(3);
    // Brute force over the 6*5*4 injections.
    let best = Number.POSITIVE_INFINITY;
    for (let a = 0; a < 6; a += 1)
      for (let b = 0; b < 6; b += 1)
        for (let c = 0; c < 6; c += 1) {
          if (a === b || b === c || a === c) continue;
          best = Math.min(
            best,
            (wide[0]?.[a] as number) + (wide[1]?.[b] as number) + (wide[2]?.[c] as number)
          );
        }
    expect(wideResult.cost).toBeCloseTo(best, 12);
    const tall = wide[0]?.map((_, column) =>
      wide.map((row) => row[column] as number)
    ) as number[][];
    const tallResult = solveAssignment(tall);
    expect(tallResult.cost).toBeCloseTo(best, 12);
    expect([...tallResult.columnToRow].every((row) => row >= 0)).toBe(true);
  });

  it("rejects ragged and non-finite matrices", () => {
    expect(() => solveAssignment([[1, 2], [3]])).toThrow(AssignmentError);
    expect(() => solveAssignment([[1, Number.NaN]])).toThrow(AssignmentError);
    expect(solveAssignment([]).cost).toBe(0);
  });
});

describe("sparse maximum-weight matching", () => {
  function randomEdges(seed: number, left: number, right: number, count: number): WeightedEdge[] {
    const rng = createRng(seed);
    return Array.from({ length: count }, () => ({
      left: rng.int(left),
      right: rng.int(right),
      weight: Math.round(rng.next() * 100) / 100
    }));
  }

  it("is exact per component and equals brute force on small graphs", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const edges = randomEdges(seed, 6, 7, 11);
      const matching = maxWeightMatching(6, 7, edges, { exactMaxNodes: 300 });
      expect(matching.exact).toBe(true);
      // Duplicate edges keep their heavier weight in both solvers.
      const unique = new Map<string, WeightedEdge>();
      for (const edge of edges) {
        const key = `${edge.left}:${edge.right}`;
        const existing = unique.get(key);
        if (!existing || existing.weight < edge.weight) unique.set(key, edge);
      }
      expect(matching.weight).toBeCloseTo(
        bruteForceMatching([...unique.values()].filter((edge) => edge.weight > 0)),
        9
      );
      matching.leftToRight.forEach((right, left) => {
        if (right >= 0) expect(matching.rightToLeft[right]).toBe(left);
      });
    }
  });

  it("falls back to greedy above the exact limit, heaviest edge first", () => {
    const edges: WeightedEdge[] = [
      { left: 0, right: 0, weight: 0.9 },
      { left: 0, right: 1, weight: 0.8 },
      { left: 1, right: 0, weight: 0.85 }
    ];
    const greedy = maxWeightMatching(2, 2, edges, { exactMaxNodes: 1 });
    expect(greedy.exact).toBe(false);
    expect(greedy.greedyComponents).toBe(1);
    expect([...greedy.leftToRight]).toEqual([0, -1]);
    expect(greedy.weight).toBeCloseTo(0.9, 12);
    const exact = maxWeightMatching(2, 2, edges, { exactMaxNodes: 2 });
    expect([...exact.leftToRight]).toEqual([1, 0]);
    expect(exact.weight).toBeCloseTo(1.65, 12);
  });

  it("ignores non-positive edges and rejects out-of-range ones", () => {
    const matching = maxWeightMatching(2, 2, [{ left: 0, right: 0, weight: 0 }], {
      exactMaxNodes: 10
    });
    expect([...matching.leftToRight]).toEqual([-1, -1]);
    expect(matching.components).toBe(0);
    expect(() =>
      maxWeightMatching(1, 1, [{ left: 0, right: 2, weight: 1 }], { exactMaxNodes: 10 })
    ).toThrow(AssignmentError);
  });
});
