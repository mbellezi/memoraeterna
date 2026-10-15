import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLouvain,
  canonicalPartition,
  checkTopicClusteringResult,
  createRng,
  gaussianClusters,
  topicClusteringRowOrder,
  TopicClusteringError,
  TopicClusteringRequestSchema,
  TopicClusteringResultSchema,
  rowItemKey
} from "@app/domain/topic-tree";
import type { TopicClusteringRequest, TopicClusteringResult } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "./topic-communities.js";
import { clusterTopics, runTopicClustering } from "./topic-clustering.worker.js";
import { workerErrorMessage } from "./worker-contracts.js";

// Wrappers that call through, so a test can read the configuration a build received or make the
// community detector fail once.
vi.mock("@app/domain/topic-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/domain/topic-tree")>();
  return { ...actual, buildLouvain: vi.fn(actual.buildLouvain) };
});
vi.mock("./topic-communities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./topic-communities.js")>();
  return { ...actual, detectCommunitiesLouvain: vi.fn(actual.detectCommunitiesLouvain) };
});

/** 4 groups x 3 clusters x 40 points: 480 unit rows of 256 dimensions. */
const data = gaussianClusters({
  groups: 4,
  clustersPerGroup: 3,
  pointsPerCluster: 40,
  dim: 256,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 7
});
const seed = 20261014;

function request(extra: Record<string, unknown> = {}): TopicClusteringRequest {
  return TopicClusteringRequestSchema.parse({
    kind: "build",
    rows: data.matrix.count,
    dimensions: 256,
    vectors: data.matrix.data.slice(),
    config: {},
    seed,
    ...extra
  });
}

const rowsWhere = (labels: Int32Array, label: number): number[] =>
  Array.from(labels, (value, row) => (value === label ? row : -1)).filter((row) => row >= 0);

/** ID-free form of a result: sorted item keys and sorted child forms, like `canonicalPartition`. */
function canonical(
  result: TopicClusteringResult,
  options: { label?: (row: number) => string } = {}
): string {
  const label = options.label ?? ((row: number) => rowItemKey(row));
  const children = new Map<number, number[]>();
  for (const node of result.nodes) {
    if (node.parent !== null) {
      children.set(node.parent, [...(children.get(node.parent) ?? []), node.key]);
    }
  }
  const byKey = new Map(result.nodes.map((node) => [node.key, node]));
  const encode = (key: number): string => {
    const items = (byKey.get(key)?.items ?? []).map(label).sort();
    const below = (children.get(key) ?? []).map(encode).sort();
    return `(${items.join(",")}|${below.join("")})`;
  };
  return encode(0);
}

/** The root child that holds each row. */
function areaOf(result: TopicClusteringResult): Map<number, number> {
  const parent = new Map(result.nodes.map((node) => [node.key, node.parent]));
  const area = new Map<number, number>();
  for (const node of result.nodes) {
    let key = node.key;
    while (parent.get(key) !== 0 && parent.get(key) !== null) key = parent.get(key) as number;
    for (const row of node.items) area.set(row, key);
  }
  return area;
}

afterEach(() => {
  vi.mocked(buildLouvain).mockClear();
  vi.mocked(detectCommunitiesLouvain).mockClear();
});

describe("building a tree", () => {
  it("returns the tree of the in-process builder and passes its own checks", () => {
    const input = request();
    const result = clusterTopics(input);
    const reference = buildLouvain(
      data.matrix,
      Array.from({ length: input.rows }, (_, i) => i),
      {
        seed,
        config: input.config,
        detectCommunities: detectCommunitiesLouvain
      }
    );
    expect(canonical(result)).toBe(canonicalPartition(reference.state));
    expect(TopicClusteringResultSchema.parse(result)).toEqual(result);
    expect(() => checkTopicClusteringResult(result, input)).not.toThrow();
    expect(result.metrics).toMatchObject({
      items: 480,
      reachability: 1,
      violations: { hardCount: 0 }
    });
    expect(result.knn).toEqual({ exact: true });
    expect(result.frozenNodes).toBeUndefined();
    expect(result.timings.knnMs).toBeGreaterThanOrEqual(0);
    expect(result.nodes[0]).toMatchObject({ key: 0, parent: null });
  });

  it("is repeatable and does not depend on the object identity of the request", () => {
    const first = clusterTopics(request());
    const second = clusterTopics(request());
    expect(canonical(second)).toBe(canonical(first));
    expect(second.nodes).toEqual(first.nodes);
  });

  it("splits a subtree as an inner topic and a seed group one level lower", () => {
    clusterTopics(request());
    expect(vi.mocked(buildLouvain).mock.calls[0]?.[2].config?.fanOut.rootTarget).toBe(9);
    clusterTopics(request({ kind: "split-subtree" }));
    const inner = vi.mocked(buildLouvain).mock.calls[1]?.[2].config;
    expect(inner?.fanOut.rootTarget).toBe(0);
    expect(inner?.depth.cap).toBe(7);
    clusterTopics(request({ seedGroups: [rowsWhere(data.groups, 0)] }));
    const calls = vi.mocked(buildLouvain).mock.calls.slice(2);
    expect(calls).toHaveLength(2);
    const configOf = (rows: number) => calls.find((call) => call[1].length === rows)?.[2].config;
    // The seed group (120 rows) is a subtree one level down; the other 360 rows keep the root rule.
    expect(configOf(120)?.fanOut.rootTarget).toBe(0);
    expect(configOf(120)?.depth).toMatchObject({ cap: 6, target: 5 });
    expect(configOf(360)?.fanOut.rootTarget).toBe(9);
    expect(configOf(360)?.depth.cap).toBe(7);
  });

  it("builds the rows of a subtree on their own", () => {
    const rows = rowsWhere(data.groups, 2);
    const matrix = new Float32Array(rows.length * 256);
    rows.forEach((row, index) =>
      matrix.set(data.matrix.data.subarray(row * 256, (row + 1) * 256), index * 256)
    );
    const input = request({ kind: "split-subtree", rows: rows.length, vectors: matrix });
    const result = clusterTopics(input);
    expect(() => checkTopicClusteringResult(result, input)).not.toThrow();
    expect(result.metrics.items).toBe(120);
    expect(result.nodes.length).toBeGreaterThan(3);
  });

  it("clusters the same content to the same tree whatever the order it arrived in", () => {
    // Content hashes unrelated to the order of the matrix, two sets of UUIDs, shuffled arrivals.
    const hashOf = (row: number): string => `c${String((row * 7919) % 480).padStart(4, "0")}`;
    const run = (uuidSet: string, arrivalSeed: number) => {
      const items = Array.from({ length: 480 }, (_, row) => ({
        row,
        key: `note:00000000-0000-4000-8000-${uuidSet}${String(row).padStart(8, "0")}`,
        contentHash: hashOf(row)
      }));
      const shuffled = createRng(arrivalSeed).shuffle(items.slice());
      const order = topicClusteringRowOrder(shuffled);
      const byKey = new Map(items.map((item) => [item.key, item]));
      const vectors = new Float32Array(480 * 256);
      order.keys.forEach((key, position) => {
        const source = (byKey.get(key)?.row ?? 0) * 256;
        vectors.set(data.matrix.data.subarray(source, source + 256), position * 256);
      });
      const hashes = order.keys.map((key) => byKey.get(key)?.contentHash ?? "");
      return canonical(clusterTopics(request({ vectors })), {
        label: (row) => hashes[row] as string
      });
    };
    const reference = run("0000", 1);
    expect(run("1111", 2)).toBe(reference);
    expect(run("2222", 3)).toBe(reference);
    // A matrix in a different row order is a different input and may give a different tree.
    expect(reference).toContain("c0000");
  });
});

describe("frozen groups", () => {
  const whole = rowsWhere(data.clusters, 0);
  const partial = rowsWhere(data.clusters, 7).slice(0, 7);

  it("stay whole as protected leaves and the rest is the in-process build", () => {
    const input = request({ kind: "rebuild", frozenGroups: [whole, partial] });
    const result = clusterTopics(input);
    expect(() => checkTopicClusteringResult(result, input)).not.toThrow();
    const frozen = result.frozenNodes as number[];
    expect(frozen).toHaveLength(2);
    const byKey = new Map(result.nodes.map((node) => [node.key, node]));
    expect([...(byKey.get(frozen[0] as number)?.items ?? [])].sort((a, b) => a - b)).toEqual(whole);
    expect([...(byKey.get(frozen[1] as number)?.items ?? [])].sort((a, b) => a - b)).toEqual(
      partial
    );
    // The frozen rows appear nowhere else, and the other rows are the tree of the free rows.
    const free = Array.from({ length: 480 }, (_, row) => row).filter(
      (row) => !whole.includes(row) && !partial.includes(row)
    );
    const reference = buildLouvain(data.matrix, free, {
      seed,
      config: input.config,
      detectCommunities: detectCommunitiesLouvain
    });
    expect(
      canonical({ ...result, nodes: result.nodes.filter((node) => !frozen.includes(node.key)) })
    ).toBe(canonicalPartition(reference.state));
    // A protected leaf above the leaf limit awaits approval; it is not a hard violation.
    expect(result.metrics.violations).toMatchObject({ hardCount: 0, awaitingApproval: 1 });
    expect(result.metrics.reachability).toBe(1);
  });

  it("attach under the closest topic of the free tree", () => {
    const result = clusterTopics(request({ kind: "rebuild", frozenGroups: [whole, partial] }));
    const parent = new Map(result.nodes.map((node) => [node.key, node.parent]));
    const byKey = new Map(result.nodes.map((node) => [node.key, node]));
    const [first, second] = result.frozenNodes as [number, number];
    const siblingRows = (key: number): number[] =>
      result.nodes
        .filter((node) => node.parent === parent.get(key) && node.key !== key)
        .flatMap((node) => node.items);
    // Cluster 0 belongs to group 0: its neighbours are leaves of group 0.
    expect(new Set(siblingRows(first).map((row) => data.groups[row]))).toEqual(new Set([0]));
    // The 7 rows of cluster 7 sit beside the other rows of cluster 7.
    expect(new Set(siblingRows(second).map((row) => data.clusters[row]))).toEqual(new Set([7]));
    expect(byKey.get(second)?.items).toHaveLength(7);
  });

  it("work for a subtree split and come back in request order, repeatably", () => {
    const input = () => request({ kind: "split-subtree", frozenGroups: [partial, whole] });
    const result = clusterTopics(input());
    const byKey = new Map(result.nodes.map((node) => [node.key, node]));
    expect(byKey.get((result.frozenNodes as number[])[0] as number)?.items).toHaveLength(7);
    expect(byKey.get((result.frozenNodes as number[])[1] as number)?.items).toHaveLength(40);
    const again = clusterTopics(input());
    expect(again.nodes).toEqual(result.nodes);
    expect(again.frozenNodes).toEqual(result.frozenNodes);
  });

  it("make a tree of their own when every row is frozen, groups attached to the root", () => {
    const groups = [0, 1, 2].map((group) => rowsWhere(data.groups, group));
    const rest = rowsWhere(data.groups, 3);
    const result = clusterTopics(request({ kind: "rebuild", frozenGroups: [...groups, rest] }));
    expect(result.nodes).toHaveLength(5);
    expect(result.nodes.slice(1).every((node) => node.parent === 0)).toBe(true);
    expect(result.nodes[0]?.items).toEqual([]);
    expect(vi.mocked(buildLouvain)).not.toHaveBeenCalled();
    expect(result.metrics.violations.hardCount).toBe(0);
  });

  it("keep a small free tree as direct items beside the frozen groups", () => {
    const rows = Array.from({ length: 480 }, (_, row) => row);
    const free = rows.slice(0, 10);
    const result = clusterTopics(request({ kind: "rebuild", frozenGroups: [rows.slice(10)] }));
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]?.items).toEqual(free);
    expect(result.nodes[1]).toMatchObject({ parent: 0, items: rows.slice(10) });
  });
});

describe("seed groups", () => {
  it("build one subtree per group under the root and cluster the other rows apart", () => {
    const seeds = [0, 1, 2].map((group) => rowsWhere(data.groups, group));
    const input = request({ seedGroups: seeds });
    const result = clusterTopics(input);
    expect(() => checkTopicClusteringResult(result, input)).not.toThrow();
    const area = areaOf(result);
    seeds.forEach((rows, index) => {
      expect(new Set(rows.map((row) => area.get(row))).size).toBe(1);
      for (const other of seeds.slice(index + 1)) {
        expect(area.get(rows[0] as number)).not.toBe(area.get(other[0] as number));
      }
    });
    // The rows of the fourth group are in no seed area.
    const seeded = new Set(seeds.map((rows) => area.get(rows[0] as number)));
    for (const row of rowsWhere(data.groups, 3)) expect(seeded.has(area.get(row))).toBe(false);
    expect(result.metrics).toMatchObject({ reachability: 1, violations: { hardCount: 0 } });
    expect(canonical(clusterTopics(request({ seedGroups: seeds })))).toBe(canonical(result));
  });

  it("work together with frozen groups", () => {
    const seeds = [rowsWhere(data.groups, 0)];
    const frozen = [rowsWhere(data.clusters, 11)];
    const input = request({ kind: "rebuild", seedGroups: seeds, frozenGroups: frozen });
    const result = clusterTopics(input);
    expect(() => checkTopicClusteringResult(result, input)).not.toThrow();
    expect(result.metrics.violations.hardCount).toBe(0);
  });
});

describe("measuring the kNN recall", () => {
  it("is exact and returns no tree up to the exact limit", () => {
    const result = clusterTopics(request({ kind: "knn-recall" }));
    expect(result.nodes).toEqual([]);
    expect(result.knn).toEqual({ exact: true, recallAt10: 1 });
    expect(result.metrics.items).toBe(0);
  });

  it("compares the approximate graph with exact scans above it", () => {
    const input = request({ kind: "knn-recall", config: { knn: { exactLimit: 100, nprobe: 8 } } });
    const result = clusterTopics(input);
    expect(result.knn.exact).toBe(false);
    expect(result.knn.recallAt10).toBeGreaterThanOrEqual(0.9);
    expect(() => checkTopicClusteringResult(result, input)).not.toThrow();
    const narrow = clusterTopics(
      request({ kind: "knn-recall", config: { knn: { exactLimit: 100, nprobe: 1 } } })
    );
    expect(narrow.knn.recallAt10 as number).toBeLessThanOrEqual(result.knn.recallAt10 as number);
  });
});

describe("the worker entry", () => {
  it("returns a result that passes the schema", async () => {
    const result = await runTopicClustering({ ...request() });
    expect(TopicClusteringResultSchema.safeParse(result).success).toBe(true);
  });

  it("refuses a malformed payload with the invalid-input code before any work", async () => {
    const vectors = data.matrix.data.slice();
    vectors[3 * 256] = Number.NaN;
    const failure = await runTopicClustering({ ...request(), vectors }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(TopicClusteringError);
    expect(failure).toMatchObject({ code: "topic_clustering_invalid_input" });
    expect((failure as Error).message).toContain("row 3 holds a value that is not finite");
    expect(workerErrorMessage(failure)).toMatchObject({
      kind: "error",
      code: "topic_clustering_invalid_input"
    });
    await expect(runTopicClustering({ kind: "build" })).rejects.toMatchObject({
      code: "topic_clustering_invalid_input"
    });
    await expect(
      runTopicClustering({ ...request(), kind: "build", frozenGroups: [[0]] })
    ).rejects.toMatchObject({ code: "topic_clustering_invalid_input" });
    expect(vi.mocked(buildLouvain)).not.toHaveBeenCalled();
  });

  it("tags an unexpected failure with the failed code and keeps the cause", async () => {
    const boom = new Error("detector exploded");
    vi.mocked(detectCommunitiesLouvain).mockImplementationOnce(() => {
      throw boom;
    });
    const failure = await runTopicClustering({ ...request() }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "topic_clustering_failed",
      message: "detector exploded",
      cause: boom
    });
    expect(workerErrorMessage(failure)).toEqual({
      kind: "error",
      error: "detector exploded",
      code: "topic_clustering_failed"
    });
  });
});
