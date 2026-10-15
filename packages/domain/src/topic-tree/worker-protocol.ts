// The protocol of the topic clustering worker (spec 3.4): the request main sends, the partition the
// worker returns and the error codes of the pair. The worker is pure compute with no database and
// no credentials; main loads the vectors, transfers one Float32Array and validates the result.
//
// Row identity. Rows are numbered 0..rows-1 in content-key order (content hash, then item key,
// D22), so a replay with fresh UUIDs but the same content sends the same matrix. Item keys never
// cross the boundary: the caller keeps `topicClusteringRowOrder` and maps rows back. Group
// members and result items are row numbers.
//
// Kinds. `build` clusters every row with the Louvain builder (the root is the Areas level);
// `rebuild` is the same computation and is the only kind besides `split-subtree` that takes
// frozen groups; `split-subtree` splits the rows of one topic as an inner topic (the root target
// of Areas is off; the caller lowers `depth.cap` by the depth of the topic); `knn-recall`
// measures the approximate kNN against an exact scan and returns no tree.
//
// Groups. A seed group (chapter seeding) is built as a subtree of its own, one level below the
// root, and the rows in no group are clustered among themselves; the forced shape repair that
// follows may gather several seed subtrees under a new intermediate topic when the root would
// exceed its fan-out. A frozen group is a human or pinned subtree kept whole: it is not touched
// by the build and appears as one protected leaf node, attached under the AI-managed topic whose
// centroid is closest; `frozenNodes[i]` names the node of group `i`, and the caller re-attaches
// its existing subtree there.
import { z } from "zod";

import { TopicTreeConfigSchema } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import { compareContentKeys } from "./ids.js";
import type { ContentKeyed, ItemKey } from "./ids.js";
import { ShapeReportSchema } from "./metrics.js";

export const topicClusteringKinds = ["build", "rebuild", "split-subtree", "knn-recall"] as const;
export type TopicClusteringKind = (typeof topicClusteringKinds)[number];

export const topicClusteringErrorCodes = [
  "topic_clustering_invalid_input",
  "topic_clustering_timeout",
  "topic_clustering_canceled",
  "topic_clustering_failed"
] as const;
export type TopicClusteringErrorCode = (typeof topicClusteringErrorCodes)[number];

/** A clustering failure. `code` travels across the worker boundary (a worker error's `code`). */
export class TopicClusteringError extends Error {
  override readonly name = "TopicClusteringError";
  readonly code: TopicClusteringErrorCode;

  constructor(code: TopicClusteringErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export const topicClusteringMaxRows = 200_000;
export const topicClusteringMaxNodes = 50_000;
export const topicClusteringMaxSeedGroups = 64;
export const topicClusteringMaxFrozenGroups = 10_000;
/** Largest |1 - |row|| of a row of the matrix (the same tolerance as the replay stores). */
export const topicClusteringUnitTolerance = 1e-3;
/** Neighbours compared by the `knn-recall` kind (recall@10). */
export const topicClusteringRecallK = 10;
/** Rows whose exact neighbours the `knn-recall` kind scans for. */
export const topicClusteringRecallQueries = 200;

const rowIndex = z.number().int().min(0);

const TopicClusteringRequestObject = z
  .object({
    kind: z.enum(topicClusteringKinds),
    rows: z.number().int().min(1).max(topicClusteringMaxRows),
    dimensions: z.union([z.literal(256), z.literal(768), z.literal(1024)]),
    /** rows * dimensions values: unit rows in content-key order, transferred (not copied). */
    vectors: z.instanceof(Float32Array),
    /** Chapter seeding: each group is one child subtree of the root (build and rebuild). */
    seedGroups: z.array(z.array(rowIndex).min(1)).max(topicClusteringMaxSeedGroups).optional(),
    /** Human and pinned subtrees kept whole (rebuild and split-subtree). */
    frozenGroups: z.array(z.array(rowIndex).min(1)).max(topicClusteringMaxFrozenGroups).optional(),
    config: TopicTreeConfigSchema,
    seed: z.number().int()
  })
  .strict();

type RequestFields = z.output<typeof TopicClusteringRequestObject>;

/** The first row that is not finite or not of unit length, or null when the matrix is sound. */
export function firstInvalidClusteringRow(
  vectors: Float32Array,
  rows: number,
  dimensions: number,
  tolerance = topicClusteringUnitTolerance
): { row: number; reason: "not-finite" | "not-unit" } | null {
  for (let row = 0; row < rows; row += 1) {
    let sum = 0;
    for (let k = row * dimensions, end = k + dimensions; k < end; k += 1) {
      const value = vectors[k] as number;
      sum += value * value;
    }
    if (!Number.isFinite(sum)) return { row, reason: "not-finite" };
    if (Math.abs(1 - Math.sqrt(sum)) > tolerance) return { row, reason: "not-unit" };
  }
  return null;
}

/** Cheap structure checks: sizes, kind rules and the groups (no scan of the vectors). */
function checkStructure(request: RequestFields, context: z.RefinementCtx): void {
  const fail = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const expected = request.rows * request.dimensions;
  if (request.vectors.length !== expected) {
    fail(
      ["vectors"],
      `vectors holds ${request.vectors.length} values, rows x dimensions is ${expected}`
    );
  }
  if (request.frozenGroups && (request.kind === "build" || request.kind === "knn-recall")) {
    fail(["frozenGroups"], `frozen groups do not apply to a ${request.kind}`);
  }
  if (request.seedGroups && request.kind !== "build" && request.kind !== "rebuild") {
    fail(["seedGroups"], `seed groups do not apply to a ${request.kind}`);
  }
  const claimed = new Uint8Array(request.rows);
  for (const name of ["seedGroups", "frozenGroups"] as const) {
    request[name]?.forEach((group, groupIndex) => {
      for (const [at, row] of group.entries()) {
        if (row >= request.rows) {
          fail([name, groupIndex, at], `row ${row} is outside the ${request.rows} rows`);
          return;
        }
        if (claimed[row] === 1) {
          fail([name, groupIndex, at], `row ${row} is in more than one group`);
          return;
        }
        claimed[row] = 1;
      }
    });
  }
}

/** Scans the matrix: every value finite, every row of unit length. */
function checkVectors(request: RequestFields, context: z.RefinementCtx): void {
  if (request.vectors.length !== request.rows * request.dimensions) return;
  const invalid = firstInvalidClusteringRow(request.vectors, request.rows, request.dimensions);
  if (invalid) {
    context.addIssue({
      code: "custom",
      path: ["vectors"],
      message:
        invalid.reason === "not-finite"
          ? `row ${invalid.row} holds a value that is not finite`
          : `row ${invalid.row} is not of unit length`
    });
  }
}

/**
 * The request without the scan of the vectors, for main: it checks sizes and groups in constant
 * time per group and leaves the O(rows x dimensions) scan to the worker, off the event loop.
 */
export const TopicClusteringRequestShapeSchema =
  TopicClusteringRequestObject.superRefine(checkStructure);

/** The full request, as the worker validates it. */
export const TopicClusteringRequestSchema =
  TopicClusteringRequestShapeSchema.superRefine(checkVectors);
export type TopicClusteringRequest = z.output<typeof TopicClusteringRequestSchema>;

const NodeSchema = z
  .object({
    /** Pre-order index of the topic; the root is 0 and a parent's key is below its children's. */
    key: z.number().int().min(0),
    parent: z.number().int().min(0).nullable(),
    /** Rows whose primary topic this is. */
    items: z.array(rowIndex)
  })
  .strict();
export type TopicClusteringNode = z.output<typeof NodeSchema>;

export const TopicClusteringResultSchema = z
  .object({
    nodes: z.array(NodeSchema).max(topicClusteringMaxNodes),
    metrics: ShapeReportSchema,
    timings: z
      .object({
        knnMs: z.number().min(0),
        communitiesMs: z.number().min(0),
        repairMs: z.number().min(0)
      })
      .strict(),
    knn: z
      .object({
        exact: z.boolean(),
        recallAt10: z.number().min(0).max(1).optional()
      })
      .strict(),
    /** Node of each frozen group, in request order. */
    frozenNodes: z.array(z.number().int().min(0)).max(topicClusteringMaxFrozenGroups).optional()
  })
  .strict();
export type TopicClusteringResult = z.output<typeof TopicClusteringResultSchema>;

/** Worker timeout: base + perRow x rows, both from the typed configuration (`build`). */
export function topicClusteringTimeoutMs(
  rows: number,
  build: Pick<TopicTreeConfig["build"], "workerTimeoutBaseMs" | "workerTimeoutPerRowMs">
): number {
  return Math.ceil(build.workerTimeoutBaseMs + build.workerTimeoutPerRowMs * rows);
}

/**
 * Checks a result against its request: a tree kind returns one root and every row exactly once;
 * every frozen group is one leaf holding exactly its rows; `knn-recall` returns no tree.
 */
export function checkTopicClusteringResult(
  result: TopicClusteringResult,
  request: Pick<TopicClusteringRequest, "kind" | "rows" | "frozenGroups">
): void {
  const fail: (message: string) => never = (message) => {
    throw new TopicClusteringError(
      "topic_clustering_failed",
      `Invalid clustering result: ${message}`
    );
  };
  if (request.kind === "knn-recall") {
    if (result.nodes.length > 0) fail("a recall measurement returned a tree");
    if (result.knn.recallAt10 === undefined) fail("the recall is missing");
    return;
  }
  const byKey = new Map<number, TopicClusteringNode>();
  for (const node of result.nodes) {
    if (byKey.has(node.key)) fail(`topic ${node.key} appears twice`);
    byKey.set(node.key, node);
  }
  const parents = new Set<number>();
  let roots = 0;
  let rootKey = 0;
  const seen = new Uint8Array(request.rows);
  let counted = 0;
  for (const node of result.nodes) {
    if (node.parent === null) {
      roots += 1;
      rootKey = node.key;
    } else {
      if (node.parent >= node.key) fail(`topic ${node.key} does not follow its parent`);
      if (!byKey.has(node.parent)) fail(`topic ${node.key} has an unknown parent`);
      parents.add(node.parent);
    }
    for (const row of node.items) {
      if (row >= request.rows) fail(`row ${row} is outside the ${request.rows} rows`);
      if (seen[row] === 1) fail(`row ${row} is placed twice`);
      seen[row] = 1;
      counted += 1;
    }
  }
  if (roots !== 1) fail(`${roots} roots`);
  if (rootKey !== 0) fail("the root is not topic 0");
  if (counted !== request.rows) fail(`${counted} of ${request.rows} rows are placed`);
  const groups = request.frozenGroups ?? [];
  const frozenNodes = result.frozenNodes ?? [];
  if (frozenNodes.length !== groups.length) fail("a frozen group has no node");
  groups.forEach((group, index) => {
    const node = byKey.get(frozenNodes[index] as number);
    if (!node) return fail(`frozen group ${index} names an unknown topic`);
    if (parents.has(node.key)) fail(`frozen group ${index} is not a leaf`);
    const rows = new Set(node.items);
    if (rows.size !== group.length || !group.every((row) => rows.has(row))) {
      fail(`frozen group ${index} was split`);
    }
  });
}

/** Rows in content-key order and the way back from an item key. */
export interface TopicClusteringRowOrder {
  /** Item key of each row. */
  readonly keys: readonly ItemKey[];
  /** Row of an item key; throws for a key that is not in the order. */
  rowOf(key: ItemKey): number;
  /** Rows of groups given as item keys, in the order given. */
  rowsOf(groups: readonly (readonly ItemKey[])[]): number[][];
}

/**
 * The row order of a request: content hash, then item key (D22), whatever the order the items
 * arrived in. The same content with fresh UUIDs gives the same matrix, so the same tree.
 */
export function topicClusteringRowOrder(items: readonly ContentKeyed[]): TopicClusteringRowOrder {
  const keys = [...items].sort(compareContentKeys).map((item) => item.key);
  const rows = new Map<ItemKey, number>();
  keys.forEach((key, row) => {
    if (rows.has(key)) {
      throw new TopicClusteringError("topic_clustering_invalid_input", `Duplicate item ${key}`);
    }
    rows.set(key, row);
  });
  const rowOf = (key: ItemKey): number => {
    const row = rows.get(key);
    if (row === undefined) {
      throw new TopicClusteringError("topic_clustering_invalid_input", `Unknown item ${key}`);
    }
    return row;
  };
  return { keys, rowOf, rowsOf: (groups) => groups.map((group) => group.map(rowOf)) };
}
