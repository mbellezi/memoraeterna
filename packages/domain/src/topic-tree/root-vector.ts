// The vector of a root source (D8, plan 4.1 Statistics): the centrality-weighted mean of its
// current notes, unit(sum of max(0, v . m)^2 * v), where m starts as the plain mean direction and
// each of `items.rootVectorRefinementPasses` passes (1 by default) recomputes the weights against
// the previous result. The fallback is the source's stored `source-composite-centroid-v2` vector;
// with neither, the source waits in Unsorted with `needs_vector`. Sums run in Float64 in the given
// (content-key) order, so the result is bit-stable for the same notes (D22).
//
// A placed root is re-placed only when its vector's cosine to the vector it was last placed with
// drops below `items.sourceReplaceCosine`, so a source does not wander as its notes trickle in.
import type { TopicTreeConfig } from "./config.js";
import { compareContentKeys } from "./ids.js";
import type { ContentKeyed, ItemKey } from "./ids.js";
import type { TopicTreeState } from "./state.js";
import { addVec, dot, unit } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

export type RootVectorBasis = "notes" | "composite" | "none";

export interface RootVector {
  /** Unit vector, or null when the source has neither note vectors nor a composite vector. */
  vector: Float32Array | null;
  basis: RootVectorBasis;
  /** Note vectors that went into it. */
  notes: number;
}

function assertDimensions(vectors: readonly Float32Array[], dim: number): void {
  for (const vector of vectors) {
    if (vector.length !== dim) {
      throw new RangeError(`Note vector has ${vector.length} dimensions, expected ${dim}`);
    }
  }
}

/**
 * The centrality-weighted mean direction of unit note vectors given in content-key order, or null
 * when there are none (or they sum to zero).
 */
export function weightedRootVector(
  noteVectors: readonly Float32Array[],
  passes: number
): Float32Array | null {
  const first = noteVectors[0];
  if (first === undefined) return null;
  const dim = first.length;
  assertDimensions(noteVectors, dim);
  const sum = new Float64Array(dim);
  for (const vector of noteVectors) addVec(sum, vector);
  let mean = unit(sum);
  if (!mean.some((value) => value !== 0)) return null;
  for (let pass = 0; pass < passes; pass += 1) {
    const weighted = new Float64Array(dim);
    let total = 0;
    for (const vector of noteVectors) {
      const centrality = Math.max(0, dot(vector, mean));
      const weight = centrality * centrality;
      if (weight === 0) continue;
      addVec(weighted, vector, weight);
      total += weight;
    }
    if (total === 0) break;
    const next = unit(weighted);
    if (!next.some((value) => value !== 0)) break;
    mean = next;
  }
  return mean;
}

/**
 * A root source's vector: from its current notes (content-key order), else its stored composite
 * vector, else none.
 */
export function rootSourceVector(
  input: { noteVectors: readonly Float32Array[]; composite: Float32Array | null },
  config: TopicTreeConfig
): RootVector {
  const fromNotes = weightedRootVector(input.noteVectors, config.items.rootVectorRefinementPasses);
  if (fromNotes !== null) {
    return { vector: fromNotes, basis: "notes", notes: input.noteVectors.length };
  }
  if (input.composite !== null && input.composite.some((value) => value !== 0)) {
    return { vector: unit(input.composite), basis: "composite", notes: 0 };
  }
  return { vector: null, basis: "none", notes: 0 };
}

/** The registered notes of every root source, each list in content-key order. */
export function notesByRootSource(state: TopicTreeState): Map<ItemKey, ItemKey[]> {
  const output = new Map<ItemKey, ItemKey[]>();
  for (const entry of state.items.values()) {
    if (entry.kind !== "note" || entry.rootSource === null) continue;
    const list = output.get(entry.rootSource) ?? [];
    list.push(entry.key);
    output.set(entry.rootSource, list);
  }
  for (const list of output.values()) {
    list.sort((a, b) =>
      compareContentKeys(state.items.get(a) as ContentKeyed, state.items.get(b) as ContentKeyed)
    );
  }
  return output;
}

/**
 * A root source's vector from the state: its registered notes that have a current vector in
 * `vectors` (content-key order), else `composite`.
 */
export function rootSourceVectorFromState(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  source: ItemKey,
  composite: Float32Array | null,
  config: TopicTreeConfig,
  notes: readonly ItemKey[] = notesByRootSource(state).get(source) ?? []
): RootVector {
  const noteVectors: Float32Array[] = [];
  for (const note of notes) {
    const row = vectors.rowOf(note);
    if (row === undefined) continue;
    noteVectors.push(
      vectors.matrix.data.subarray(row * vectors.matrix.dim, (row + 1) * vectors.matrix.dim)
    );
  }
  return rootSourceVector({ noteVectors, composite }, config);
}

/**
 * Whether a placed root moved enough to be decided again: no vector it was placed with is known,
 * or the cosine between the two dropped below `items.sourceReplaceCosine`.
 */
export function rootNeedsReplacement(
  lastPlaced: Float32Array | null,
  current: Float32Array,
  config: TopicTreeConfig
): boolean {
  if (lastPlaced === null) return true;
  if (lastPlaced.length !== current.length) return true;
  return dot(lastPlaced, current) < config.items.sourceReplaceCosine;
}
