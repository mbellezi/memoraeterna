import { describe, expect, it } from "vitest";

import { buildTopDown } from "./build.js";
import { defaultTopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import { rowItemKey } from "./ids.js";
import {
  ShapeReportSchema,
  churn,
  cutLabels,
  distribution,
  leafLabels,
  nmi,
  primaryPathDiff,
  primaryPaths,
  purity,
  sampledSilhouette,
  shapeReport
} from "./metrics.js";
import {
  cloneTopicTreeState,
  getTopic,
  leafTopics,
  placementRecord,
  primaryPlacement
} from "./state.js";

const config = defaultTopicTreeConfig;
const data = gaussianClusters({
  groups: 4,
  clustersPerGroup: 3,
  pointsPerCluster: 20,
  dim: 24,
  groupSpread: 0.8,
  pointNoise: 0.5,
  seed: 21
});
const rows = Array.from({ length: data.matrix.count }, (_, index) => index);
const keys = rows.map(rowItemKey);

describe("shape and stability metrics", () => {
  it("reports a JSON-safe shape that the worker schema accepts", () => {
    const { state } = buildTopDown(data.matrix, rows, { seed: 3, config });
    const report = shapeReport(state, config, { expectedItems: keys });
    expect(ShapeReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(report.reachability).toBe(1);
    expect(report.items).toBe(rows.length);
    expect(report.leaves).toBe(leafTopics(state).length);
    expect(report.unsortedShare).toBe(0);
    expect(report.violations.hardCount).toBe(0);
  });

  it("counts Unsorted per D27: root items and gated items at ancestors, not ordinary direct items", () => {
    const { state } = buildTopDown(data.matrix, rows, { seed: 3, config });
    const editor = createTopicTreeEditor(state, { record: false });
    const internal = getTopic(state, state.rootId).children.find(
      (id) => getTopic(state, id).children.length > 0
    ) as string;
    const [a, b, c] = keys as [string, string, string];
    editor.updatePlacement(a, 0, { topicId: state.rootId });
    editor.updatePlacement(b, 0, { topicId: internal, needsGate: true });
    editor.updatePlacement(c, 0, { topicId: internal });
    const report = shapeReport(state, config, { expectedItems: keys });
    expect(report.unsortedShare).toBeCloseTo(2 / keys.length, 12);
    expect(report.directItemsOnInternal).toBe(3);
  });

  it("measures primary-path churn and diffs", () => {
    const { state } = buildTopDown(data.matrix, rows, { seed: 3, config });
    const before = cloneTopicTreeState(state);
    const pathsBefore = primaryPaths(state, keys);
    const editor = createTopicTreeEditor(state, { record: false });
    const [moved, removed] = keys as [string, string];
    const target = leafTopics(state).find(
      (leaf) => leaf.id !== primaryPlacement(state, moved)?.topicId
    )?.id as string;
    editor.updatePlacement(moved, 0, { topicId: target });
    editor.unplaceItem(removed, 0);
    expect(churn(pathsBefore, primaryPaths(state, keys))).toBeCloseTo(2 / keys.length, 12);
    const diff = primaryPathDiff(before, state);
    expect(diff.changed).toEqual([moved]);
    expect(diff.removed).toEqual([removed]);
    expect(diff.added).toEqual([]);
    editor.placeItem(removed, placementRecord(target));
    expect(primaryPathDiff(before, state).changed).toEqual([moved, removed]);
    expect(() => churn(["a"], [])).toThrow();
  });

  it("scores partitions against labels", () => {
    expect(nmi([0, 0, 1, 1], [5, 5, 7, 7])).toBeCloseTo(1, 12);
    expect(nmi([0, 1, 0, 1], [5, 5, 7, 7])).toBeCloseTo(0, 12);
    expect(purity([0, 0, 0, 1], [1, 1, 2, 2])).toBe(0.75);
    const { state, vectors } = buildTopDown(data.matrix, rows, { seed: 3, config });
    expect(nmi(leafLabels(state, keys), data.clusters)).toBeGreaterThan(0.8);
    expect(nmi(cutLabels(state, keys, 4), data.groups)).toBeGreaterThan(0.5);
    expect(sampledSilhouette(state, vectors, { seed: 1 })).toBeGreaterThan(0);
    expect(distribution([3, 1, 2])).toMatchObject({ count: 3, min: 1, max: 3, mean: 2, p50: 2 });
  });
});
