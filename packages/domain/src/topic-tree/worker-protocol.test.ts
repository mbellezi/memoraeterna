import { describe, expect, it } from "vitest";

import { defaultTopicTreeConfig } from "./config.js";
import { createRng } from "./rng.js";
import { createMatrix, normalizeRows } from "./vectors.js";
import {
  checkTopicClusteringResult,
  firstInvalidClusteringRow,
  TopicClusteringError,
  TopicClusteringRequestSchema,
  TopicClusteringRequestShapeSchema,
  TopicClusteringResultSchema,
  topicClusteringRowOrder,
  topicClusteringTimeoutMs
} from "./worker-protocol.js";
import type { TopicClusteringRequest, TopicClusteringResult } from "./worker-protocol.js";
import { shapeReport } from "./metrics.js";
import { createTopicTreeState } from "./state.js";

function unitVectors(rows: number, dimensions: number, seed = 5): Float32Array {
  const matrix = createMatrix(rows, dimensions);
  const rng = createRng(seed);
  for (let index = 0; index < matrix.data.length; index += 1) matrix.data[index] = rng.gaussian();
  normalizeRows(matrix);
  return matrix.data;
}

function request(overrides: Partial<TopicClusteringRequest> = {}): TopicClusteringRequest {
  return {
    kind: "build",
    rows: 6,
    dimensions: 256,
    vectors: unitVectors(6, 256),
    config: defaultTopicTreeConfig,
    seed: 20261014,
    ...overrides
  };
}

function issues(input: unknown, schema: typeof TopicClusteringRequestSchema): string[] {
  const parsed = schema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("the clustering request", () => {
  it("accepts a sound request and fills the configuration defaults", () => {
    const parsed = TopicClusteringRequestSchema.parse({ ...request(), config: {} });
    expect(parsed.config).toEqual(defaultTopicTreeConfig);
    expect(parsed.vectors).toBeInstanceOf(Float32Array);
  });

  it("rejects vectors whose byte length is not rows x dimensions", () => {
    expect(
      issues(request({ vectors: new Float32Array(6 * 256 - 1) }), TopicClusteringRequestSchema)
    ).toEqual(["vectors holds 1535 values, rows x dimensions is 1536"]);
    expect(
      issues(request({ vectors: new Float32Array(6 * 256 + 256) }), TopicClusteringRequestSchema)
    ).toHaveLength(1);
    // The cheap schema stops at sizes and groups and never reads the values.
    expect(
      issues(request({ vectors: new Float32Array(10) }), TopicClusteringRequestShapeSchema)
    ).toHaveLength(1);
  });

  it("rejects a value that is not finite and names its row", () => {
    const vectors = unitVectors(6, 256);
    vectors[4 * 256 + 17] = Number.NaN;
    expect(issues(request({ vectors }), TopicClusteringRequestSchema)).toEqual([
      "row 4 holds a value that is not finite"
    ]);
    vectors[4 * 256 + 17] = Number.POSITIVE_INFINITY;
    expect(issues(request({ vectors }), TopicClusteringRequestSchema)).toEqual([
      "row 4 holds a value that is not finite"
    ]);
    expect(firstInvalidClusteringRow(vectors, 6, 256)).toEqual({ row: 4, reason: "not-finite" });
  });

  it("rejects rows that are not of unit length, zero rows included", () => {
    const scaled = unitVectors(6, 256);
    for (let k = 0; k < 256; k += 1) scaled[2 * 256 + k] = (scaled[2 * 256 + k] as number) * 1.01;
    expect(issues(request({ vectors: scaled }), TopicClusteringRequestSchema)).toEqual([
      "row 2 is not of unit length"
    ]);
    const zero = unitVectors(6, 256);
    zero.fill(0, 5 * 256, 6 * 256);
    expect(firstInvalidClusteringRow(zero, 6, 256)).toEqual({ row: 5, reason: "not-unit" });
    // Float32 rounding of a normalized row is far inside the tolerance.
    expect(firstInvalidClusteringRow(unitVectors(50, 256), 50, 256)).toBeNull();
  });

  it("allows only the dimensions of the embedding spaces and unknown keys are refused", () => {
    expect(
      issues(
        request({ dimensions: 512 as 256, vectors: unitVectors(6, 512) }),
        TopicClusteringRequestSchema
      )
    ).not.toHaveLength(0);
    for (const dimensions of [256, 768, 1024] as const) {
      expect(
        TopicClusteringRequestSchema.safeParse(
          request({ dimensions, vectors: unitVectors(6, dimensions) })
        ).success
      ).toBe(true);
    }
    expect(
      TopicClusteringRequestSchema.safeParse({ ...request(), weights: new Float32Array(6) }).success
    ).toBe(false);
    expect(TopicClusteringRequestSchema.safeParse({ ...request(), rows: 0 }).success).toBe(false);
    expect(TopicClusteringRequestSchema.safeParse({ ...request(), rows: 200_001 }).success).toBe(
      false
    );
    expect(TopicClusteringRequestSchema.safeParse({ ...request(), seed: 1.5 }).success).toBe(false);
  });

  it("checks the groups: range, overlap, empty groups and the kind that takes them", () => {
    const rebuild = { kind: "rebuild" as const };
    expect(
      TopicClusteringRequestSchema.safeParse(
        request({ ...rebuild, frozenGroups: [[0, 1], [2]], seedGroups: [[3, 4]] })
      ).success
    ).toBe(true);
    expect(
      issues(request({ ...rebuild, frozenGroups: [[0, 6]] }), TopicClusteringRequestSchema)
    ).toEqual(["row 6 is outside the 6 rows"]);
    expect(
      issues(
        request({
          ...rebuild,
          frozenGroups: [
            [0, 1],
            [1, 2]
          ]
        }),
        TopicClusteringRequestSchema
      )
    ).toEqual(["row 1 is in more than one group"]);
    expect(
      issues(request({ ...rebuild, frozenGroups: [[0, 0]] }), TopicClusteringRequestSchema)
    ).toEqual(["row 0 is in more than one group"]);
    expect(
      issues(
        request({ ...rebuild, frozenGroups: [[0]], seedGroups: [[0, 1]] }),
        TopicClusteringRequestSchema
      )
    ).toEqual(["row 0 is in more than one group"]);
    expect(
      TopicClusteringRequestSchema.safeParse(request({ ...rebuild, frozenGroups: [[]] })).success
    ).toBe(false);
    expect(issues(request({ frozenGroups: [[0]] }), TopicClusteringRequestSchema)).toEqual([
      "frozen groups do not apply to a build"
    ]);
    expect(
      issues(request({ kind: "knn-recall", frozenGroups: [[0]] }), TopicClusteringRequestSchema)
    ).toEqual(["frozen groups do not apply to a knn-recall"]);
    expect(
      issues(request({ kind: "split-subtree", seedGroups: [[0]] }), TopicClusteringRequestSchema)
    ).toEqual(["seed groups do not apply to a split-subtree"]);
    expect(
      TopicClusteringRequestSchema.safeParse(
        request({ kind: "split-subtree", frozenGroups: [[0]] })
      ).success
    ).toBe(true);
  });
});

describe("the worker timeout", () => {
  it("is 30 s plus 5 ms per row by default and follows the typed configuration", () => {
    expect(topicClusteringTimeoutMs(0, defaultTopicTreeConfig.build)).toBe(30_000);
    expect(topicClusteringTimeoutMs(18_632, defaultTopicTreeConfig.build)).toBe(123_160);
    expect(
      topicClusteringTimeoutMs(1000, { workerTimeoutBaseMs: 10_000, workerTimeoutPerRowMs: 2.5 })
    ).toBe(12_500);
  });
});

function partitionResult(nodes: TopicClusteringResult["nodes"]): TopicClusteringResult {
  const empty = createTopicTreeState({ dim: 256, rootId: "0" });
  return {
    nodes,
    metrics: shapeReport(empty, defaultTopicTreeConfig, { expectedItems: [] }),
    timings: { knnMs: 1, communitiesMs: 2, repairMs: 3 },
    knn: { exact: true }
  };
}

describe("the clustering result", () => {
  const nodes = [
    { key: 0, parent: null, items: [0] },
    { key: 1, parent: 0, items: [1, 2] },
    { key: 2, parent: 0, items: [3, 4, 5] }
  ];

  it("is strict and bounded", () => {
    expect(TopicClusteringResultSchema.safeParse(partitionResult(nodes)).success).toBe(true);
    expect(
      TopicClusteringResultSchema.safeParse({ ...partitionResult(nodes), extra: 1 }).success
    ).toBe(false);
    expect(
      TopicClusteringResultSchema.safeParse(
        partitionResult([{ key: 0, parent: null, items: [-1] }])
      ).success
    ).toBe(false);
    expect(
      TopicClusteringResultSchema.safeParse(
        partitionResult(
          Array.from({ length: 50_001 }, (_, key) => ({
            key,
            parent: key === 0 ? null : 0,
            items: []
          }))
        )
      ).success
    ).toBe(false);
  });

  it("must place every row exactly once under one root", () => {
    const check = (list: TopicClusteringResult["nodes"], frozen?: number[][]) =>
      checkTopicClusteringResult(partitionResult(list), {
        kind: "build",
        rows: 6,
        ...(frozen ? { frozenGroups: frozen } : {})
      });
    expect(() => check(nodes)).not.toThrow();
    expect(() => check([nodes[0]!, nodes[1]!])).toThrow(/3 of 6 rows/);
    expect(() => check([nodes[0]!, nodes[1]!, { key: 2, parent: 0, items: [2, 3, 4, 5] }])).toThrow(
      /row 2 is placed twice/
    );
    expect(() => check([nodes[0]!, { key: 1, parent: 0, items: [1, 2, 3, 4, 9] }])).toThrow(
      /row 9/
    );
    expect(() => check([])).toThrow(/0 roots/);
    expect(() => check([nodes[1]!, nodes[2]!])).toThrow(/unknown parent/);
    expect(() => check([nodes[0]!, { key: 1, parent: null, items: [1, 2, 3, 4, 5] }])).toThrow(
      /2 roots/
    );
    expect(() => check([nodes[0]!, { key: 1, parent: 5, items: [1, 2, 3, 4, 5] }])).toThrow(
      /does not follow its parent/
    );
    expect(() => check([nodes[0]!, { key: 1, parent: 7, items: [1, 2, 3, 4, 5] }])).toThrow(
      /does not follow/
    );
    expect(() => check([nodes[0]!, { key: 3, parent: 2, items: [1, 2, 3, 4, 5] }])).toThrow(
      /unknown parent/
    );
    try {
      check([nodes[0]!, nodes[1]!]);
    } catch (error) {
      expect(error).toBeInstanceOf(TopicClusteringError);
      expect((error as TopicClusteringError).code).toBe("topic_clustering_failed");
    }
  });

  it("keeps a frozen group whole in one leaf, and a recall run returns no tree", () => {
    const withFrozen = (frozenNodes: number[], list = nodes) =>
      checkTopicClusteringResult(
        { ...partitionResult(list), frozenNodes },
        {
          kind: "rebuild",
          rows: 6,
          frozenGroups: [[3, 4, 5]]
        }
      );
    expect(() => withFrozen([2])).not.toThrow();
    expect(() => withFrozen([1])).toThrow(/frozen group 0 was split/);
    expect(() => withFrozen([9])).toThrow(/unknown topic/);
    expect(() => withFrozen([0])).toThrow(/not a leaf|was split/);
    expect(() =>
      checkTopicClusteringResult(partitionResult(nodes), {
        kind: "rebuild",
        rows: 6,
        frozenGroups: [[3, 4, 5]]
      })
    ).toThrow(/has no node/);
    const recall = { ...partitionResult([]), knn: { exact: false, recallAt10: 0.93 } };
    expect(() => checkTopicClusteringResult(recall, { kind: "knn-recall", rows: 6 })).not.toThrow();
    expect(() =>
      checkTopicClusteringResult(partitionResult(nodes), { kind: "knn-recall", rows: 6 })
    ).toThrow(/returned a tree/);
  });
});

describe("the row order", () => {
  const items = [
    { key: "note:00000000-0000-4000-8000-0000000000a3", contentHash: "bbb" },
    { key: "note:00000000-0000-4000-8000-0000000000a1", contentHash: "ccc" },
    { key: "note:00000000-0000-4000-8000-0000000000a2", contentHash: "aaa" },
    { key: "note:00000000-0000-4000-8000-0000000000a0", contentHash: "bbb" }
  ];

  it("follows content hash, then item key, whatever the arrival order", () => {
    const order = topicClusteringRowOrder(items);
    expect(order.keys).toEqual([items[2]!.key, items[3]!.key, items[0]!.key, items[1]!.key]);
    for (let shuffle = 0; shuffle < 5; shuffle += 1) {
      const shuffled = createRng(shuffle).shuffle([...items]);
      expect(topicClusteringRowOrder(shuffled).keys).toEqual(order.keys);
    }
    expect(order.rowOf(items[0]!.key)).toBe(2);
    expect(order.rowsOf([[items[1]!.key, items[2]!.key], [items[3]!.key]])).toEqual([[3, 0], [1]]);
  });

  it("gives the same rows to the same content under fresh UUIDs", () => {
    const hashes = ["h4", "h1", "h3", "h2"];
    const named = (prefix: string) =>
      hashes.map((contentHash, index) => ({
        key: `note:00000000-0000-4000-8000-00000000${prefix}${index}`,
        contentHash
      }));
    const byHash = (list: ReturnType<typeof named>) =>
      topicClusteringRowOrder(list).keys.map(
        (key) => list.find((item) => item.key === key)?.contentHash
      );
    expect(byHash(named("aa"))).toEqual(byHash(named("bb")));
    expect(byHash(named("aa"))).toEqual(["h1", "h2", "h3", "h4"]);
  });

  it("refuses a duplicate or an unknown item with the invalid-input code", () => {
    expect(() => topicClusteringRowOrder([items[0]!, items[0]!])).toThrow(/Duplicate item/);
    const order = topicClusteringRowOrder(items);
    try {
      order.rowOf("note:00000000-0000-4000-8000-0000000000ff");
      expect.unreachable();
    } catch (error) {
      expect((error as TopicClusteringError).code).toBe("topic_clustering_invalid_input");
    }
  });
});
