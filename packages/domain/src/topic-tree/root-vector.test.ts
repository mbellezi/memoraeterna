import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig, topicTreeConfigWith } from "./config.js";
import { uuidOf } from "./fixtures/placement-world.js";
import { itemKey } from "./ids.js";
import { createRng } from "./rng.js";
import {
  notesByRootSource,
  rootNeedsReplacement,
  rootSourceVector,
  rootSourceVectorFromState,
  weightedRootVector
} from "./root-vector.js";
import { createTopicTreeState, registerItem } from "./state.js";
import { dot, keyedVectors, matrixFromRows, norm, unit } from "./vectors.js";

const config = defaultTopicTreeConfig;

function vec(...values: number[]): Float32Array {
  return unit(Float32Array.from(values));
}

function randomUnit(rng: ReturnType<typeof createRng>, dim: number): Float32Array {
  return unit(Float32Array.from({ length: dim }, () => rng.gaussian()));
}

describe("root source vector (D8)", () => {
  it("is the plain mean direction with no refinement pass", () => {
    const notes = [vec(1, 0, 0), vec(0, 1, 0)];
    const vector = weightedRootVector(notes, 0) as Float32Array;
    expect(Array.from(vector)).toEqual(Array.from(vec(1, 1, 0)));
  });

  it("weights notes by their squared centrality: an outlier pulls less than in the mean", () => {
    const core = [vec(1, 0.1, 0), vec(1, -0.1, 0), vec(1, 0, 0.1)];
    const outlier = vec(0, 1, 0);
    const notes = [...core, outlier];
    const mean = weightedRootVector(notes, 0) as Float32Array;
    const weighted = weightedRootVector(notes, 1) as Float32Array;
    const center = vec(1, 0, 0);
    expect(dot(weighted, center)).toBeGreaterThan(dot(mean, center));
    expect(norm(weighted)).toBeCloseTo(1, 6);
    // The formula by hand: unit(sum max(0, v.m)^2 v) with m the mean direction.
    const expected = new Float64Array(3);
    for (const note of notes) {
      const weight = Math.max(0, dot(note, mean)) ** 2;
      for (let k = 0; k < 3; k += 1)
        expected[k] = (expected[k] as number) + weight * (note[k] as number);
    }
    const reference = unit(expected);
    for (let k = 0; k < 3; k += 1) expect(weighted[k]).toBeCloseTo(reference[k] as number, 6);
  });

  it("ignores notes facing away from the mean and keeps one note as it is", () => {
    const single = vec(0.3, 0.4, 0.5);
    expect(Array.from(weightedRootVector([single], 1) as Float32Array)).toEqual(Array.from(single));
    const notes = [vec(1, 0, 0), vec(1, 0.2, 0), vec(-1, 0, 0.01)];
    const vector = weightedRootVector(notes, 1) as Float32Array;
    expect(dot(vector, vec(1, 0.1, 0))).toBeGreaterThan(0.99);
  });

  it("is bit-stable for the same notes in the same order", () => {
    const rng = createRng(7);
    const notes = Array.from({ length: 40 }, () => randomUnit(rng, 64));
    const first = weightedRootVector(notes, config.items.rootVectorRefinementPasses);
    const second = weightedRootVector(
      notes.map((note) => note.slice()),
      config.items.rootVectorRefinementPasses
    );
    expect(Buffer.from((first as Float32Array).buffer)).toEqual(
      Buffer.from((second as Float32Array).buffer)
    );
  });

  it("falls back to the composite vector, then to none (needs_vector)", () => {
    const composite = Float32Array.from([0, 3, 4]);
    expect(rootSourceVector({ noteVectors: [vec(1, 0, 0)], composite }, config)).toMatchObject({
      basis: "notes",
      notes: 1
    });
    const fallback = rootSourceVector({ noteVectors: [], composite }, config);
    expect(fallback.basis).toBe("composite");
    expect(Array.from(fallback.vector as Float32Array)).toEqual(Array.from(vec(0, 3, 4)));
    expect(rootSourceVector({ noteVectors: [], composite: null }, config)).toEqual({
      vector: null,
      basis: "none",
      notes: 0
    });
    expect(
      rootSourceVector({ noteVectors: [], composite: new Float32Array(3) }, config).basis
    ).toBe("none");
    expect(() => weightedRootVector([vec(1, 0), vec(1, 0, 0)], 1)).toThrow(/dimensions/);
  });

  it("collects a source's notes from the state in content-key order", () => {
    const state = createTopicTreeState({ dim: 3, rootId: uuidOf(0) });
    const source = itemKey("source", uuidOf(50));
    const other = itemKey("source", uuidOf(51));
    const notes = [3, 1, 2].map((n) => itemKey("note", uuidOf(n)));
    notes.forEach((key, index) =>
      registerItem(state, {
        key,
        kind: "note",
        contentHash: ["c", "a", "b"][index] as string,
        rootSource: source
      })
    );
    registerItem(state, { key: other, kind: "source", contentHash: "z", rootSource: null });
    registerItem(state, {
      key: itemKey("note", uuidOf(9)),
      kind: "note",
      contentHash: "d",
      rootSource: other
    });
    expect(notesByRootSource(state).get(source)).toEqual([notes[1], notes[2], notes[0]]);
    // The note without a vector is left out; the others make the vector.
    const vectors = keyedVectors(matrixFromRows([vec(1, 0, 0), vec(0, 1, 0)]), [
      notes[1] as string,
      notes[2] as string
    ]);
    const result = rootSourceVectorFromState(state, vectors, source, null, config);
    expect(result).toMatchObject({ basis: "notes", notes: 2 });
    expect(dot(result.vector as Float32Array, vec(1, 1, 0))).toBeCloseTo(1, 6);
  });

  it("re-places a root only when its vector moved below sourceReplaceCosine", () => {
    const base = vec(1, 0, 0);
    expect(rootNeedsReplacement(null, base, config)).toBe(true);
    expect(rootNeedsReplacement(base, vec(1, 0.1, 0), config)).toBe(false);
    expect(rootNeedsReplacement(base, vec(1, 0.3, 0), config)).toBe(true);
    const loose = topicTreeConfigWith({ items: { sourceReplaceCosine: 0.9 } });
    expect(rootNeedsReplacement(base, vec(1, 0.3, 0), loose)).toBe(false);
    expect(rootNeedsReplacement(vec(1, 0), base, config)).toBe(true);
  });
});
