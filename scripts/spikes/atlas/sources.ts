// Readers of the two data sources of the Atlas spike (F5 D21). Both are read only.
//
//  - golden-small: vectors from the replay store `<dir>/<name>.{f32,index.jsonl,meta.json}` (the
//    store records the tree it was exported from, `treeId`, and that tree's `generation`); the
//    placements come from an `env-g` clone: that tree when the clone still holds it, otherwise the
//    clone's active tree (same embedding space). The clone's generation is recorded and compared
//    with the store's. A clone rebuilt from the same sources holds the same notes under new ids, so
//    the store's notes are paired with the clone's by id, then by the content hash of the embedding
//    text (`matchStoreNotes`), and the store vector is compared with the clone's own.
//  - ENV-C: the vectors and the placements of the clone's active tree, read through the topic
//    service's own load repository (the tree's embedding space, one Float32 matrix).
import { basename, dirname } from "node:path";

import type pg from "pg";

import { createTopicTreeLoadRepository } from "@app/db";
import { createMatrix, dotAt } from "@app/domain/topic-tree";

import { levelOneBranches, primaryBranchOfNotes } from "./branches.js";
import { assembleDataset, matchStoreNotes } from "./dataset.js";
import type { AtlasDataset } from "./dataset.js";
import { readReplayStore } from "../../topics/export-vectors.js";

export interface TreeFacts {
  treeId: string;
  /**
   * The tree the replay store was exported from (golden-small only). The clone may no longer hold it:
   * then the placements are those of the clone's active tree, which has the same embedding space.
   */
  storeTreeId: string | null;
  treeIdMatchesStore: boolean | null;
  /** The clone's tree generation now. */
  cloneGeneration: number;
  /** The generation the replay store was exported at; null for a dataset read from the clone alone. */
  storeGeneration: number | null;
  generationDiffers: boolean;
  topics: number;
  levelOneTopics: number;
  placements: number;
  spaceKey: string;
  dimensions: number;
}

export interface PairingFacts {
  storeNotes: number;
  byId: number;
  byContentHash: number;
  unmatched: number;
  ambiguous: number;
  /** Cosine between each paired note's store vector and the clone's stored vector (1 = the same). */
  meanCosineToCloneVector: number;
  minCosineToCloneVector: number;
}

export interface LoadedDataset {
  dataset: AtlasDataset;
  tree: TreeFacts;
  source: string;
  /** Placed notes with no usable vector in the tree's space (clone datasets only; they are left out). */
  placedWithoutVector: number;
  /** How the replay store's notes were paired with the clone's (golden-small only). */
  pairing?: PairingFacts;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function readGoldenSmall(pool: pg.Pool, storeBase: string): Promise<LoadedDataset> {
  const store = await readReplayStore(dirname(storeBase), basename(storeBase), { normalize: true });
  const treeId = typeof store.meta.treeId === "string" ? store.meta.treeId : null;
  if (!treeId) throw new Error("The replay store does not name the tree it was exported from.");
  const repository = createTopicTreeLoadRepository(pool);
  let skeleton = await repository.loadSkeleton(treeId);
  if (!skeleton) {
    // The clone's tree moved on (a rebuild activated a new tree). The store's vectors are in the same
    // embedding space as the active tree's, so the active tree's placements are used and the
    // difference is reported.
    const activeId = await repository.activeTreeId();
    skeleton = activeId ? await repository.loadSkeleton(activeId) : null;
    if (!skeleton) throw new Error("The env-g clone has no topic tree to take placements from.");
    if (
      typeof store.meta.spaceKey === "string" &&
      store.meta.spaceKey !== skeleton.tree.space.spaceKey
    )
      throw new Error(
        "The clone's active tree is in another embedding space than the replay store."
      );
  }
  const primaryBranch = primaryBranchOfNotes(skeleton.topics, skeleton.placements);
  // The clone's own vectors give each placed note its content hash, which pairs the store's notes
  // with the clone's when the clone was rebuilt under new note ids.
  const cloneVectors = await repository.loadItemVectors(
    skeleton.tree.space,
    [...primaryBranch.keys()].map((id) => ({ kind: "note" as const, id }))
  );
  const cloneNotes = cloneVectors.keys.map((key, row) => ({
    id: key.slice("note:".length),
    contentHash: cloneVectors.contentHashes[row]!
  }));
  const noteRows = store.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === "note");
  const match = matchStoreNotes(
    noteRows.map(({ row }) => ({ id: row.id, contentHash: row.contentHash })),
    cloneNotes
  );
  const cloneRowOf = new Map(cloneNotes.map((note, row) => [note.id, row] as const));
  const matched: { index: number; cloneId: string }[] = [];
  noteRows.forEach(({ index }, position) => {
    const cloneId = match.cloneIds[position];
    if (cloneId) matched.push({ index, cloneId });
  });
  const dim = store.matrix.dim;
  const matrix = createMatrix(matched.length, dim);
  let agreementSum = 0;
  let agreementMin = Infinity;
  matched.forEach(({ index, cloneId }, position) => {
    matrix.data.set(store.matrix.data.subarray(index * dim, (index + 1) * dim), position * dim);
    const cloneRow = cloneRowOf.get(cloneId)!;
    const agreement = dotAt(
      store.matrix.data,
      index * dim,
      cloneVectors.matrix.data,
      cloneRow * dim,
      dim
    );
    agreementSum += agreement;
    agreementMin = Math.min(agreementMin, agreement);
  });
  const storeGeneration = numberOrNull(store.meta.generation);
  const branches = levelOneBranches(skeleton.topics);
  const dataset = assembleDataset({
    name: "golden-small",
    weak: true,
    noteIds: matched.map((entry) => entry.cloneId),
    matrix,
    primaryBranch,
    branches
  });
  return {
    dataset,
    source: `replay store ${basename(storeBase)} (vectors) + clone tree ${skeleton.tree.id} (placements)`,
    placedWithoutVector: cloneVectors.missing.length + cloneVectors.stale.length,
    pairing: {
      storeNotes: noteRows.length,
      byId: match.byId,
      byContentHash: match.byContentHash,
      unmatched: match.unmatched,
      ambiguous: match.ambiguous,
      meanCosineToCloneVector: matched.length === 0 ? Number.NaN : agreementSum / matched.length,
      minCosineToCloneVector: matched.length === 0 ? Number.NaN : agreementMin
    },
    tree: {
      treeId: skeleton.tree.id,
      storeTreeId: treeId,
      treeIdMatchesStore: skeleton.tree.id === treeId,
      cloneGeneration: skeleton.tree.generation,
      storeGeneration,
      generationDiffers: storeGeneration !== null && storeGeneration !== skeleton.tree.generation,
      topics: skeleton.topics.length,
      levelOneTopics: branches.length,
      placements: skeleton.placements.length,
      spaceKey: skeleton.tree.space.spaceKey,
      dimensions: skeleton.tree.space.dimensions
    }
  };
}

export async function readCloneDataset(pool: pg.Pool, name: string): Promise<LoadedDataset> {
  const repository = createTopicTreeLoadRepository(pool);
  const treeId = await repository.activeTreeId();
  if (!treeId) throw new Error("The clone has no active topic tree.");
  const skeleton = await repository.loadSkeleton(treeId);
  if (!skeleton) throw new Error("The clone's active topic tree could not be read.");
  const primaryBranch = primaryBranchOfNotes(skeleton.topics, skeleton.placements);
  const noteIds = [...primaryBranch.keys()].sort();
  const loaded = await repository.loadItemVectors(
    skeleton.tree.space,
    noteIds.map((id) => ({ kind: "note" as const, id }))
  );
  const withVector = loaded.keys.map((key) => key.slice("note:".length));
  const branches = levelOneBranches(skeleton.topics);
  const dataset = assembleDataset({
    name,
    weak: false,
    noteIds: withVector,
    matrix: loaded.matrix,
    primaryBranch,
    branches
  });
  return {
    dataset,
    source: `clone active tree ${treeId} (stored vectors and placements)`,
    placedWithoutVector: loaded.missing.length + loaded.stale.length,
    tree: {
      treeId,
      storeTreeId: null,
      treeIdMatchesStore: null,
      cloneGeneration: skeleton.tree.generation,
      storeGeneration: null,
      generationDiffers: false,
      topics: skeleton.topics.length,
      levelOneTopics: branches.length,
      placements: skeleton.placements.length,
      spaceKey: skeleton.tree.space.spaceKey,
      dimensions: skeleton.tree.space.dimensions
    }
  };
}
