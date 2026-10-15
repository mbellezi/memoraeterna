// Product-like trees for the REBALANCE, audit and rebuild tests: a batch build over seeded
// synthetic clusters re-keyed to UUID topics and `note:<uuid>` items, with exact statistics.
// Not exported from the package.
import { buildTopDown } from "../build.js";
import type { ShapeContext } from "../build.js";
import type { TopicTreeConfig } from "../config.js";
import { createTopicTreeEditor } from "../events.js";
import { itemKey } from "../ids.js";
import type { ItemKey } from "../ids.js";
import {
  createTopicTreeState,
  getTopic,
  placementRecord,
  registerItem,
  walkTopics
} from "../state.js";
import type { TopicTreeState } from "../state.js";
import { recomputeSubtree } from "../stats.js";
import { keyedVectors } from "../vectors.js";
import type { EmbeddingMatrix, ItemVectorSource } from "../vectors.js";
import type { SyntheticData } from "./synthetic.js";

export const fixtureNow = "2026-10-15T12:00:00.000Z";
export const fixtureDay = "2026-10-15";

export function fixtureUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export interface ProductTree {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  /** Item key of matrix row i. */
  keys: ItemKey[];
  /** Fresh topic UUIDs (never reused). */
  newTopicId: () => string;
  /** A shape context with a recording editor, "moved from" hints on. */
  context: (seed?: number) => ShapeContext;
}

/** Item keys and a fresh UUID state with every row registered as a note (nothing placed). */
export function productState(
  matrix: EmbeddingMatrix,
  offset = 0
): { state: TopicTreeState; keys: ItemKey[]; vectors: ItemVectorSource; next: () => string } {
  let counter = 1;
  const next = (): string => fixtureUuid(offset + counter++);
  const state = createTopicTreeState({ dim: matrix.dim, rootId: fixtureUuid(offset) });
  const keys = Array.from({ length: matrix.count }, (_, row) =>
    itemKey("note", fixtureUuid(offset + 10_000_000 + row))
  );
  keys.forEach((key, row) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: `content-${String((row * 7919) % 99991).padStart(6, "0")}-${row}`,
      rootSource: null
    })
  );
  return { state, keys, vectors: keyedVectors(matrix, keys), next };
}

/**
 * A top-down batch build of `data` copied onto UUID topics and note keys (pre-order), with exact
 * statistics; `offset` changes every UUID.
 */
export function productTree(
  data: SyntheticData,
  config: TopicTreeConfig,
  options: { seed: number; offset?: number; rows?: readonly number[] }
): ProductTree {
  const rows = options.rows ?? Array.from({ length: data.matrix.count }, (_, row) => row);
  const built = buildTopDown(data.matrix, rows, { seed: options.seed, config }).state;
  const { state, keys, vectors, next } = productState(data.matrix, options.offset ?? 0);
  const setup = createTopicTreeEditor(state, { record: false });
  const idOf = new Map<string, string>([[built.rootId, state.rootId]]);
  walkTopics(built, (node) => {
    if (node.parentId !== null) {
      const id = next();
      idOf.set(node.id, id);
      setup.createTopic(id, idOf.get(node.parentId) as string);
    }
    const target = idOf.get(node.id) as string;
    for (const item of node.items) {
      const row = Number(item.slice("row:".length));
      setup.placeItem(keys[row] as ItemKey, placementRecord(target, { decidedBy: "build" }));
    }
  });
  recomputeSubtree(state, vectors);
  return {
    state,
    vectors,
    keys,
    newTopicId: next,
    context: (seed = options.seed) => ({
      state,
      vectors,
      config,
      seed,
      editor: createTopicTreeEditor(state),
      newTopicId: next,
      now: fixtureNow,
      markMoves: true
    })
  };
}

/** Live leaves and internal topics of a tree (root excluded), in pre-order. */
export function topicsByKind(state: TopicTreeState): { leaves: string[]; internal: string[] } {
  const leaves: string[] = [];
  const internal: string[] = [];
  walkTopics(state, (node) => {
    if (node.id === state.rootId) return;
    (getTopic(state, node.id).children.length === 0 ? leaves : internal).push(node.id);
  });
  return { leaves, internal };
}
