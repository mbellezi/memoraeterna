import { describe, expect, it } from "vitest";

import {
  buildLouvain,
  defaultTopicTreeConfig,
  partitionOf,
  shapeReport,
  topicTreeConfigWith
} from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import {
  ParityReportSchema,
  check,
  configHash,
  partitionHash,
  partitionHashOfNodes,
  reportName,
  summarizeShape
} from "./report-data.js";
import { parityRun } from "./replay.js";
import { syntheticDataset } from "./synthetic-dataset.js";

const dataset = syntheticDataset();
const rows = Array.from({ length: dataset.rows.length }, (_, row) => row);

describe("check", () => {
  it("passes inside inclusive bounds and rounds them", () => {
    expect(check("a", 3.64, { min: 3.64, max: 3.74 }).pass).toBe(true);
    expect(check("a", 3.7400000001, { max: 3.74 }).pass).toBe(true);
    expect(check("a", 3.75, { max: 3.74 }).pass).toBe(false);
    expect(check("a", 0.99, { min: 1 }).pass).toBe(false);
    expect(check("a", 5, {})).toMatchObject({ min: null, max: null, pass: true });
    expect(check("a", 1, { min: 3.69 - 0.05, max: 3.69 + 0.05 })).toMatchObject({
      min: 3.64,
      max: 3.74
    });
  });
});

describe("hashes", () => {
  it("hashes the configuration canonically and tells configurations apart", () => {
    expect(configHash(defaultTopicTreeConfig)).toMatch(/^[0-9a-f]{64}$/u);
    expect(configHash(defaultTopicTreeConfig)).toBe(configHash(topicTreeConfigWith({})));
    expect(configHash(defaultTopicTreeConfig)).not.toBe(
      configHash(topicTreeConfigWith({ knn: { nprobe: 16 } }))
    );
  });

  it("gives a worker's partition the same hash as the in-memory tree (T13's check)", () => {
    const result = buildLouvain(dataset.matrix, rows, {
      seed: 20261014,
      config: defaultTopicTreeConfig,
      detectCommunities: detectCommunitiesLouvain
    });
    const nodes = partitionOf(result.state);
    expect(partitionHashOfNodes(nodes)).toBe(partitionHash(result.state));
    // The key order and the item order inside a node do not matter; the structure does.
    const shuffled = [...nodes]
      .reverse()
      .map((node) => ({ ...node, items: [...node.items].reverse() }));
    expect(partitionHashOfNodes(shuffled)).toBe(partitionHash(result.state));
    const moved = nodes.map((node) => ({ ...node, items: [...node.items] }));
    const donor = moved.find((node) => node.items.length > 1);
    const receiver = moved.find((node) => node !== donor && node.items.length > 0);
    receiver?.items.push(donor?.items.pop() as number);
    expect(partitionHashOfNodes(moved)).not.toBe(partitionHash(result.state));
    expect(() => partitionHashOfNodes([])).toThrow(RangeError);
  });
});

describe("reports", () => {
  it("names a report by kind, dataset and seed and keeps file names safe", () => {
    const { report } = parityRun({
      dataset,
      config: defaultTopicTreeConfig,
      seed: 3,
      detect: detectCommunitiesLouvain,
      createEngine: () => {
        throw new Error("not used");
      }
    });
    expect(reportName(report)).toBe("parity-synthetic-3");
    expect(reportName(report, "a b/c")).toBe("parity-synthetic-3-a_b_c");
  });

  it("summarizes a shape report into the trimmed form", () => {
    const result = buildLouvain(dataset.matrix, rows, {
      seed: 1,
      config: defaultTopicTreeConfig,
      detectCommunities: detectCommunitiesLouvain
    });
    const shape = shapeReport(result.state, defaultTopicTreeConfig);
    const summary = summarizeShape(shape, 4);
    expect(summary).toMatchObject({
      items: rows.length,
      rootChildren: 4,
      reachability: 1,
      hardViolations: 0
    });
    expect(summary.depthMean).toBeCloseTo(shape.itemDepth.mean, 3);
  });

  it("rejects unknown fields and malformed hashes", () => {
    const { report } = parityRun({
      dataset,
      config: defaultTopicTreeConfig,
      seed: 3,
      detect: detectCommunitiesLouvain,
      createEngine: () => {
        throw new Error("not used");
      }
    });
    expect(ParityReportSchema.safeParse(report).success).toBe(true);
    expect(ParityReportSchema.safeParse({ ...report, surprise: 1 }).success).toBe(false);
    expect(ParityReportSchema.safeParse({ ...report, configHash: "abc" }).success).toBe(false);
    expect(
      ParityReportSchema.safeParse({ ...report, shape: { ...report.shape, reachability: 2 } })
        .success
    ).toBe(false);
  });
});
