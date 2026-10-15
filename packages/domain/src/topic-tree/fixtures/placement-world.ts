// A small seeded world for the PLACE, human-operation and undo tests (T07): clustered 8-d unit
// vectors, notes grouped under root sources (one source has no vector), a shape configuration
// small enough for a few dozen items to make a tree of depth 2-3, and a base tree built by the
// T03 forced repair pass from the notes at the root. Topic IDs and item keys are UUID-shaped.
// Not exported from the package.
import { repairAll } from "../build.js";
import type { ShapeContext } from "../build.js";
import { topicTreeConfigWith } from "../config.js";
import type { TopicTreeConfig } from "../config.js";
import { createTopicTreeEditor } from "../events.js";
import type { TopicTreeEditor } from "../events.js";
import { itemKey } from "../ids.js";
import type { ItemKey } from "../ids.js";
import { createRng, deriveSeed } from "../rng.js";
import { createTopicTreeState, placementRecord, registerItem } from "../state.js";
import type { TopicTreeState } from "../state.js";
import { recomputeSubtree } from "../stats.js";
import { createMatrix, keyedVectors } from "../vectors.js";
import type { ItemVectorSource } from "../vectors.js";
import { gaussianClusters } from "./synthetic.js";

export const uuidOf = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const worldNow = "2026-10-15T12:00:00.000Z";

/** Shape limits scaled down so that ~30 items make a tree of depth 2-3. */
export const worldConfig: TopicTreeConfig = topicTreeConfigWith({
  fanOut: { min: 2, max: 4, targetMin: 2, targetMax: 3, hardMax: 6, rootTarget: 3 },
  leaf: { min: 2, max: 6, target: 4, hardMax: 12, minForTargetFanOut: 2 },
  depth: { target: 3, cap: 5 },
  areas: { min: 2, max: 4, target: 3 },
  bootstrap: { singleTopicMaxItems: 10 },
  repair: { mergeMaxSize: 10, directItemsSplitAt: 4 },
  placement: { ambiguityMargin: 0.03 },
  secondary: { maxScoreGap: 0.12 }
});

export interface World {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  config: TopicTreeConfig;
  /** Every registered item: notes, then sources. */
  items: ItemKey[];
  notes: ItemKey[];
  sources: ItemKey[];
  /** A source with no vector (it waits with needs_vector). */
  vectorless: ItemKey;
  /** Notes and sources the base build did not place. */
  pending: ItemKey[];
  newTopicId: () => string;
}

export interface WorldOptions {
  seed: number;
  /** Share of notes placed by the base build (default 0.6). */
  placedShare?: number;
  config?: TopicTreeConfig;
}

/** Notes per root source. */
const notesPerSource = 6;

/** A shape context (T03 operations) over a world's state. */
export function shapeContext(
  world: Pick<World, "state" | "vectors" | "config" | "newTopicId">,
  editor: TopicTreeEditor,
  seed: number
): ShapeContext {
  return {
    state: world.state,
    vectors: world.vectors,
    config: world.config,
    seed,
    editor,
    newTopicId: world.newTopicId,
    now: worldNow
  };
}

export function createWorld(options: WorldOptions): World {
  const config = options.config ?? worldConfig;
  const data = gaussianClusters({
    groups: 3,
    clustersPerGroup: 3,
    pointsPerCluster: 6,
    dim: 8,
    groupSpread: 0.8,
    pointNoise: 0.45,
    seed: options.seed
  });
  const noteCount = data.matrix.count;
  const dim = data.matrix.dim;
  const notes = Array.from({ length: noteCount }, (_, index) => itemKey("note", uuidOf(index + 1)));
  const sources = Array.from({ length: noteCount / notesPerSource }, (_, index) =>
    itemKey("source", uuidOf(10_000 + index))
  );
  // Notes are assigned to sources in a shuffled order, so a source mixes clusters.
  const order = createRng(deriveSeed(options.seed, "sources")).shuffle(
    Array.from({ length: noteCount }, (_, index) => index)
  );
  const sourceOf = (note: number): number => Math.floor((order[note] as number) / notesPerSource);

  // Every source but the last gets the normalized sum of its notes' vectors.
  const withVector = sources.slice(0, -1);
  const matrix = createMatrix(noteCount + withVector.length, dim);
  matrix.data.set(data.matrix.data);
  for (let note = 0; note < noteCount; note += 1) {
    const source = sourceOf(note);
    if (source >= withVector.length) continue;
    for (let k = 0; k < dim; k += 1) {
      const at = (noteCount + source) * dim + k;
      matrix.data[at] = (matrix.data[at] as number) + (data.matrix.data[note * dim + k] as number);
    }
  }
  for (let source = 0; source < withVector.length; source += 1) {
    const offset = (noteCount + source) * dim;
    let length = 0;
    for (let k = 0; k < dim; k += 1) length += (matrix.data[offset + k] as number) ** 2;
    for (let k = 0; k < dim; k += 1) {
      matrix.data[offset + k] = (matrix.data[offset + k] as number) / Math.sqrt(length);
    }
  }
  const vectors = keyedVectors(matrix, [...notes, ...withVector]);

  const state = createTopicTreeState({ dim, rootId: uuidOf(1_000_000) });
  const hashRng = createRng(deriveSeed(options.seed, "content-hash"));
  const hash = (): string =>
    hashRng
      .int(1 << 30)
      .toString(16)
      .padStart(8, "0");
  notes.forEach((key, index) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: hash(),
      rootSource: sources[sourceOf(index)] as ItemKey
    })
  );
  for (const key of sources) {
    registerItem(state, { key, kind: "source", contentHash: hash(), rootSource: null });
  }

  let next = 1;
  const newTopicId = (): string => uuidOf(1_000_000 + next++);
  const placedCount = Math.round(noteCount * (options.placedShare ?? 0.6));
  const shuffled = createRng(deriveSeed(options.seed, "placed")).shuffle([...notes]);
  const editor = createTopicTreeEditor(state, { record: false });
  for (const key of shuffled.slice(0, placedCount)) {
    editor.placeItem(key, placementRecord(state.rootId, { decidedBy: "build" }));
  }
  recomputeSubtree(state, vectors);
  repairAll(shapeContext({ state, vectors, config, newTopicId }, editor, options.seed), {
    force: true
  });
  recomputeSubtree(state, vectors);
  return {
    state,
    vectors,
    config,
    items: [...notes, ...sources],
    notes,
    sources,
    vectorless: sources[sources.length - 1] as ItemKey,
    pending: [...shuffled.slice(placedCount), ...sources],
    newTopicId
  };
}
