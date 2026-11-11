// An Atlas dataset: the notes that have both a stored vector and a primary placement, with their
// level-1 branch as an integer label (-1 for a note on the root). Pure assembly; the readers of the
// replay store and of a clone are in sources.ts.
import { createMatrix } from "@app/domain/topic-tree";
import type { EmbeddingMatrix } from "@app/domain/topic-tree";

import type { LevelOneBranch } from "./branches.js";

export interface AtlasDataset {
  name: string;
  /** The golden-small data (8 topics, 160 notes) is too small to carry the decision alone. */
  weak: boolean;
  ids: string[];
  /** Unit rows aligned with `ids`. */
  matrix: EmbeddingMatrix;
  /** Level-1 branch index per row, -1 when the note sits on the root. */
  labels: Int32Array;
  branches: { index: number; topicId: string; title: string; members: number }[];
  counts: {
    /** Notes with a vector, before the join. */
    withVector: number;
    /** Notes with a vector and no primary placement in the tree (left out). */
    unplaced: number;
    /** Points on the map. */
    points: number;
    /** Points with no level-1 branch (placed on the root). */
    onRoot: number;
  };
}

export interface StoreNote {
  id: string;
  contentHash: string;
}

export interface CloneNote {
  id: string;
  contentHash: string;
}

export interface NoteMatch {
  /** The clone's note id for each store row (same order), or null when none matches. */
  cloneIds: (string | null)[];
  byId: number;
  byContentHash: number;
  unmatched: number;
  /** Store rows whose content hash several clone notes share (not matched by hash). */
  ambiguous: number;
}

/**
 * Pairs the replay store's notes with a clone's notes. A clone rebuilt from the same sources can hold
 * the same notes under new ids (a re-run of the same import): the store row then pairs by id when the
 * id exists, otherwise by the content hash of the note's embedding text, when exactly one clone note
 * carries it. A clone note is paired at most once.
 */
export function matchStoreNotes(
  store: readonly StoreNote[],
  clone: readonly CloneNote[]
): NoteMatch {
  const cloneIds = new Set(clone.map((note) => note.id.toLowerCase()));
  const byHash = new Map<string, string[]>();
  for (const note of clone) {
    const list = byHash.get(note.contentHash) ?? [];
    list.push(note.id.toLowerCase());
    byHash.set(note.contentHash, list);
  }
  const used = new Set<string>();
  const out: (string | null)[] = store.map(() => null);
  let byId = 0;
  let byContentHash = 0;
  let ambiguous = 0;
  store.forEach((note, index) => {
    const id = note.id.toLowerCase();
    if (cloneIds.has(id) && !used.has(id)) {
      out[index] = id;
      used.add(id);
      byId += 1;
    }
  });
  store.forEach((note, index) => {
    if (out[index] !== null) return;
    const candidates = (byHash.get(note.contentHash) ?? []).filter((id) => !used.has(id));
    if (candidates.length === 1) {
      out[index] = candidates[0]!;
      used.add(candidates[0]!);
      byContentHash += 1;
    } else if (candidates.length > 1) ambiguous += 1;
  });
  return {
    cloneIds: out,
    byId,
    byContentHash,
    unmatched: out.filter((id) => id === null).length,
    ambiguous
  };
}

export interface AssembleInput {
  name: string;
  weak: boolean;
  /** Note ids aligned with the rows of `matrix`. */
  noteIds: readonly string[];
  matrix: EmbeddingMatrix;
  /** From `primaryBranchOfNotes`: the level-1 topic id of each placed note, or null. */
  primaryBranch: ReadonlyMap<string, string | null>;
  branches: readonly LevelOneBranch[];
}

export function assembleDataset(input: AssembleInput): AtlasDataset {
  const { matrix, noteIds } = input;
  if (noteIds.length !== matrix.count)
    throw new Error("The note ids do not match the vector rows.");
  const kept: number[] = [];
  for (let row = 0; row < noteIds.length; row += 1)
    if (input.primaryBranch.has(noteIds[row]!.toLowerCase())) kept.push(row);
  const branchIndex = new Map(
    input.branches.map((branch, index) => [branch.topicId, index] as const)
  );
  const out = createMatrix(kept.length, matrix.dim);
  const ids: string[] = [];
  const labels = new Int32Array(kept.length);
  kept.forEach((row, position) => {
    out.data.set(
      matrix.data.subarray(row * matrix.dim, (row + 1) * matrix.dim),
      position * matrix.dim
    );
    ids.push(noteIds[row]!);
    const topicId = input.primaryBranch.get(noteIds[row]!.toLowerCase());
    labels[position] =
      topicId === null || topicId === undefined ? -1 : (branchIndex.get(topicId) ?? -1);
  });
  const members = new Map<number, number>();
  for (const label of labels) members.set(label, (members.get(label) ?? 0) + 1);
  return {
    name: input.name,
    weak: input.weak,
    ids,
    matrix: out,
    labels,
    branches: input.branches
      .map((branch, index) => ({ index, ...branch, members: members.get(index) ?? 0 }))
      .filter((branch) => branch.members > 0),
    counts: {
      withVector: noteIds.length,
      unplaced: noteIds.length - kept.length,
      points: kept.length,
      onRoot: members.get(-1) ?? 0
    }
  };
}
