import { describe, expect, it } from "vitest";
import { relationsConfig } from "@app/domain";

import { kthVectorCosine, reverseGuardIds } from "./relation-matcher.js";

// Order independence without the batch barrier (F3 D19, spec 3.10): every note judges its fused
// top K among the notes before it, plus the earlier notes of its vector window whose stored K-th
// cosine it reaches (the reverse guard). Over random arrival orders of synthetic vectors, no pair
// that batch mode judges (every note seeing every other) is lost while the earlier note lies in
// the later one's vector window (top guardFactor x K).
const { fusedK: k, vectorK, guardFactor } = relationsConfig.retrieval;

/** A seeded generator (mulberry32): the same orders on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Unit vectors around a few centres, so neighbourhoods overlap the way a library's do. */
function library(size: number, dimensions: number, next: () => number): number[][] {
  const centres = Array.from({ length: 5 }, () =>
    Array.from({ length: dimensions }, () => next() * 2 - 1)
  );
  return Array.from({ length: size }, (_, index) => {
    const centre = centres[index % centres.length]!;
    const vector = centre.map((value) => value + (next() * 2 - 1) * 0.9);
    const norm = Math.hypot(...vector);
    return vector.map((value) => value / norm);
  });
}

const cosine = (left: number[], right: number[]) =>
  left.reduce((sum, value, index) => sum + value * right[index]!, 0);

const pairKey = (left: number, right: number) =>
  left < right ? `${left}:${right}` : `${right}:${left}`;

/** The notes of `among` nearest to `note`, best first (ties by index, like the SQL's by ID). */
function nearest(vectors: number[][], note: number, among: readonly number[], limit: number) {
  return among
    .filter((other) => other !== note)
    .map((other) => ({ id: other, cosine: cosine(vectors[note]!, vectors[other]!) }))
    .sort((left, right) => right.cosine - left.cosine || left.id - right.id)
    .slice(0, limit);
}

/** Batch mode: every note judges its top K among all the others. */
function batchPairs(vectors: number[][]): Set<string> {
  const all = vectors.map((_, index) => index);
  const pairs = new Set<string>();
  for (const note of all)
    for (const other of nearest(vectors, note, all, k)) pairs.add(pairKey(note, other.id));
  return pairs;
}

/**
 * Arrival mode in `order`: what each note judges, and the batch pairs within the later note's
 * vector window that were never judged.
 */
function arrival(
  vectors: number[][],
  order: readonly number[],
  batch: ReadonlySet<string>,
  guard: boolean
): { judged: Set<string>; missedInWindow: number } {
  const states = new Map<string, { kthCosine: number | null }>();
  const judged = new Set<string>();
  const windows = new Map<number, Set<number>>();
  for (const [position, note] of order.entries()) {
    const earlier = order.slice(0, position);
    const vectorList = nearest(vectors, note, earlier, vectorK);
    const fused = vectorList.slice(0, k);
    const window = vectorList.slice(0, guardFactor * k);
    windows.set(note, new Set(window.map((candidate) => candidate.id)));
    const guarded = guard
      ? reverseGuardIds(
          window.map((candidate) => ({ id: String(candidate.id), cosine: candidate.cosine })),
          new Set(fused.map((candidate) => String(candidate.id))),
          states
        ).map(Number)
      : [];
    for (const other of [...fused.map((candidate) => candidate.id), ...guarded])
      judged.add(pairKey(note, other));
    states.set(String(note), {
      kthCosine: kthVectorCosine(
        vectorList.map((candidate) => candidate.cosine),
        k
      )
    });
  }
  const arrivedAt = new Map(order.map((note, position) => [note, position]));
  let missedInWindow = 0;
  for (const key of batch) {
    if (judged.has(key)) continue;
    const [left, right] = key.split(":").map(Number) as [number, number];
    const [earlier, later] =
      arrivedAt.get(left)! < arrivedAt.get(right)! ? [left, right] : [right, left];
    if (windows.get(later)!.has(earlier)) missedInWindow += 1;
  }
  return { judged, missedInWindow };
}

describe("the reverse guard over random arrival orders (D19)", () => {
  it("loses no batch-mode pair within the later note's top 2K, in any order", () => {
    const next = random(52);
    const vectors = library(80, 8, next);
    const batch = batchPairs(vectors);
    let unguardedMisses = 0;
    for (let sample = 0; sample < 60; sample += 1) {
      const order = vectors.map((_, index) => index);
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [order[index], order[swap]] = [order[swap]!, order[index]!];
      }
      const guarded = arrival(vectors, order, batch, true);
      expect(guarded.missedInWindow).toBe(0);
      unguardedMisses += arrival(vectors, order, batch, false).missedInWindow;
    }
    // Without the guard an early note never sees the notes after it: pairs are lost.
    expect(unguardedMisses).toBeGreaterThan(0);
  });

  it("opens the guard of a note decided with fewer than K candidates to every later note", () => {
    expect(kthVectorCosine([0.9, 0.8], 3)).toBeNull();
    expect(kthVectorCosine([0.9, 0.8, 0.7], 3)).toBe(0.7);
    const states = new Map<string, { kthCosine: number | null }>([
      ["open", { kthCosine: null }],
      ["near", { kthCosine: 0.5 }],
      ["far", { kthCosine: 0.95 }]
    ]);
    const window = [
      { id: "fused", cosine: 0.99 },
      { id: "far", cosine: 0.9 },
      { id: "near", cosine: 0.6 },
      { id: "open", cosine: 0.1 },
      { id: "undecided", cosine: 0.8 }
    ];
    // Only decided notes join, and only where this note reaches their own K-th cosine.
    expect(reverseGuardIds(window, new Set(["fused"]), states)).toEqual(["near", "open"]);
  });
});
