import { describe, expect, it } from "vitest";

import { matrixFromRows } from "@app/domain/topic-tree";
import { createRng, exactKnnGraph } from "@app/domain/topic-tree";

import { levelOneBranches, primaryBranchOfNotes } from "./branches.js";
import type { BranchTopic } from "./branches.js";
import { assembleDataset, matchStoreNotes } from "./dataset.js";
import { runUmap, umapNeighbourTable } from "./umap.js";
import { procrustesDisparity } from "./procrustes.js";
import { sharedLabelShare, nearestNeighbours2d } from "./metrics.js";

const topic = (
  id: string,
  parentId: string | null,
  title: string | null,
  role = "topic",
  retiredAt: string | null = null
): BranchTopic => ({
  id,
  parentId,
  role,
  title,
  retiredAt
});
const tree: BranchTopic[] = [
  topic("root", null, null, "root"),
  topic("b-sleep", "root", "Sleep"),
  topic("b-memory", "root", "Memory"),
  topic("b-old", "root", "Old", "topic", "2026-01-01"),
  topic("sleep-rem", "b-sleep", "REM"),
  topic("sleep-rem-deep", "sleep-rem", "Deep REM"),
  topic("memory-recall", "b-memory", "Recall")
];

describe("level-1 branches", () => {
  it("lists the live children of the root by title", () => {
    expect(levelOneBranches(tree)).toEqual([
      { topicId: "b-memory", title: "Memory" },
      { topicId: "b-sleep", title: "Sleep" }
    ]);
    expect(levelOneBranches([])).toEqual([]);
  });

  it("resolves the primary placement of a note to its level-1 branch at any depth", () => {
    const branches = primaryBranchOfNotes(tree, [
      { itemKind: "note", itemId: "N1", topicId: "sleep-rem-deep", rank: 0 },
      { itemKind: "note", itemId: "n2", topicId: "b-memory", rank: 0 },
      { itemKind: "note", itemId: "n3", topicId: "root", rank: 0 },
      { itemKind: "note", itemId: "n4", topicId: "memory-recall", rank: 1 },
      { itemKind: "source", itemId: "s1", topicId: "b-sleep", rank: 0 }
    ]);
    expect(Object.fromEntries(branches)).toEqual({ n1: "b-sleep", n2: "b-memory", n3: null });
  });
});

describe("dataset assembly", () => {
  it("keeps the notes with a vector and a primary placement, labelled by branch", () => {
    const matrix = matrixFromRows([
      [1, 0],
      [0, 1],
      [1, 1],
      [-1, 1]
    ]);
    const dataset = assembleDataset({
      name: "t",
      weak: false,
      noteIds: ["N1", "n2", "n3", "n4"],
      matrix,
      primaryBranch: new Map<string, string | null>([
        ["n1", "b-sleep"],
        ["n2", "b-memory"],
        ["n3", null]
      ]),
      branches: levelOneBranches(tree)
    });
    expect(dataset.ids).toEqual(["N1", "n2", "n3"]);
    expect(Array.from(dataset.labels)).toEqual([1, 0, -1]);
    expect(dataset.counts).toEqual({ withVector: 4, unplaced: 1, points: 3, onRoot: 1 });
    expect(dataset.branches.map((b) => [b.title, b.members])).toEqual([
      ["Memory", 1],
      ["Sleep", 1]
    ]);
    expect(dataset.matrix.count).toBe(3);
  });

  it("refuses ids that do not match the rows", () => {
    expect(() =>
      assembleDataset({
        name: "t",
        weak: false,
        noteIds: ["a"],
        matrix: matrixFromRows([
          [1, 0],
          [0, 1]
        ]),
        primaryBranch: new Map(),
        branches: []
      })
    ).toThrow();
  });
});

describe("pairing the replay store's notes with a clone's", () => {
  it("pairs by id first, then by a content hash that exactly one clone note carries", () => {
    const match = matchStoreNotes(
      [
        { id: "A", contentHash: "h1" },
        { id: "b", contentHash: "h2" },
        { id: "c", contentHash: "h3" },
        { id: "d", contentHash: "h4" },
        { id: "e", contentHash: "h-none" }
      ],
      [
        { id: "a", contentHash: "other" },
        { id: "x2", contentHash: "h2" },
        { id: "x3a", contentHash: "h3" },
        { id: "x3b", contentHash: "h3" },
        { id: "x4", contentHash: "h4" }
      ]
    );
    expect(match.cloneIds).toEqual(["a", "x2", null, "x4", null]);
    expect(match).toMatchObject({ byId: 1, byContentHash: 2, unmatched: 2, ambiguous: 1 });
  });

  it("never pairs two store notes with one clone note", () => {
    const match = matchStoreNotes(
      [
        { id: "a", contentHash: "h" },
        { id: "b", contentHash: "h" }
      ],
      [{ id: "z", contentHash: "h" }]
    );
    expect(match.cloneIds.filter((id) => id !== null)).toHaveLength(1);
  });
});

describe("UMAP over a precomputed neighbour table", () => {
  /** Three well separated clusters in 12 dimensions. */
  function clusters() {
    const rng = createRng(21);
    const rows: number[][] = [];
    const labels: number[] = [];
    for (let cluster = 0; cluster < 3; cluster += 1)
      for (let member = 0; member < 40; member += 1) {
        const row = Array.from({ length: 12 }, () => 0.15 * rng.gaussian());
        row[cluster * 4] = (row[cluster * 4] as number) + 1;
        rows.push(row);
        labels.push(cluster);
      }
    return { matrix: matrixFromRows(rows), labels: Int32Array.from(labels) };
  }

  it("builds umap-js's table: the point first at distance 0, then its neighbours", () => {
    const { matrix } = clusters();
    const graph = exactKnnGraph(
      matrix,
      Array.from({ length: matrix.count }, (_, i) => i),
      15
    );
    const table = umapNeighbourTable(graph, 15);
    expect(table.indices[5]![0]).toBe(5);
    expect(table.distances[5]![0]).toBe(0);
    expect(table.indices[5]).toHaveLength(15);
    expect(table.distances[5]!.every((d, i) => i === 0 || d >= table.distances[5]![i - 1]!)).toBe(
      true
    );
  });

  it("separates synthetic clusters into contiguous regions, and two seeds agree up to a rotation", () => {
    const { matrix, labels } = clusters();
    const graph = exactKnnGraph(
      matrix,
      Array.from({ length: matrix.count }, (_, i) => i),
      15
    );
    const first = runUmap(graph, 1);
    const second = runUmap(graph, 2);
    expect(first.points).toHaveLength(matrix.count * 2);
    const contiguity = sharedLabelShare(nearestNeighbours2d(first.points, 10), labels, 10).overall;
    expect(contiguity).toBeGreaterThan(0.95);
    expect(procrustesDisparity(first.points, second.points)).toBeLessThan(0.2);
  }, 60_000);
});
