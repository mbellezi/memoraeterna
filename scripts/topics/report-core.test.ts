import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "@app/domain/topic-tree";

import { tryReadReplayStore } from "./export-vectors.js";
import {
  buildComparison,
  buildProfileReport,
  ComparisonDocumentSchema,
  contentKeyOrder,
  defaultReportOptions,
  devLegacyRecord,
  exportTree,
  gatingFailures,
  parseExportDocument,
  ProfileReportSchema
} from "./report-core.js";
import type { ProfileInput, TruthSource } from "./report-core.js";
import { writeFixtureExport } from "./report-fixture.js";

// 6 groups x 4 clusters x 30 notes, one root source per cluster.
const notes = 720;
const roots = 24;
const items = notes + roots;

let cache = "";
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), "memora-report-core-"));
});
afterAll(async () => {
  await rm(cache, { recursive: true, force: true });
});

async function load(name: string, withVectors = true): Promise<ProfileInput> {
  const document = parseExportDocument(
    JSON.parse(await readFile(join(cache, "topics", "exports", name, "export.json"), "utf8"))
  );
  const store = withVectors
    ? await tryReadReplayStore(join(cache, "topics", "vectors"), name, { normalize: true })
    : null;
  return { document, store };
}

// A truth source for the synthetic groups: the article titles carry the cluster, domains follow
// the dataset's own grouping (6 groups x 4 clusters).
const truth: TruthSource = {
  name: "fixture",
  domainOf: (_language, title) => {
    const cluster = Number(title.replace("Article article-", ""));
    return Number.isInteger(cluster) ? `domain-${Math.floor(cluster / 4)}` : undefined;
  }
};

describe("a tree that is a fresh build", () => {
  let input: ProfileInput;
  beforeAll(async () => {
    await writeFixtureExport({
      name: "env-fresh",
      cacheDirectory: cache,
      mode: "fresh",
      changeSetOrigins: { build: 1, naming: 4 },
      dailyMetrics: 9,
      gateDecisions: 6
    });
    input = { ...(await load("env-fresh")), truth, legacy: devLegacyRecord };
  });

  it("is the same partition as the offline build of its export (E1 to E5 measured)", () => {
    const report = buildProfileReport(input, defaultReportOptions);
    expect(ProfileReportSchema.parse(report)).toEqual(report);
    expect(report.fresh).not.toBeNull();
    expect(report.fresh!.identical).toBe(true);
    expect(report.fresh!.app.partitionHash).toBe(report.fresh!.fresh.partitionHash);
    expect(report.fresh!.agreement).toEqual({ leafNmi: 1, depth1Nmi: 1, depth2Nmi: 1, cutNmi: 1 });
    expect(report.fresh!.unplaced).toBe(0);
    expect(report.fresh!.rows).toBe(notes);
    expect(report.fresh!.laterChangeSets).toEqual({});
    expect(report.fresh!.seed).toBe(20261014);
    expect(report.caveats).toEqual([]);
    // Same shape on both sides.
    expect(report.fresh!.app.shape).toEqual(report.fresh!.fresh.shape);
  });

  it("measures the exit criteria with a verdict each", () => {
    const report = buildProfileReport(input, defaultReportOptions);
    const check = (name: RegExp) => report.targets.find((entry) => name.test(entry.name))!;
    expect(check(/^Reachability/u)).toMatchObject({
      id: "E1",
      value: 1,
      status: "pass",
      gating: true
    });
    expect(check(/^Orphans/u)).toMatchObject({ value: 0, status: "pass" });
    expect(check(/^Hard violations/u)).toMatchObject({ value: 0, status: "pass" });
    expect(check(/^Mean depth/u).status).toBe("pass");
    expect(check(/^Internal topics with 4-9/u).id).toBe("E2");
    // Nine daily rows: the worst seven-day window holds the six-change day.
    expect(check(/seven-day/u)).toMatchObject({ id: "E3", gating: false });
    expect(check(/seven-day/u).value).toBeCloseTo((6 + 6) / items, 3);
    expect(check(/^Undone share/u)).toMatchObject({ value: 0, status: "pass", gating: false });
    // The items clear the 50-item floor of the Unsorted share.
    expect(check(/^Unsorted/u)).toMatchObject({ id: "D27", status: "pass" });
    expect(gatingFailures([report])).toEqual([]);
  });

  it("reports the shape, levels, naming, placements and change-sets of the export", () => {
    const report = buildProfileReport(input, defaultReportOptions);
    expect(report.shape).toMatchObject({ items, reachability: 1, hardViolations: 0 });
    expect(report.levels[0]).toMatchObject({ depth: 0, topics: 1 });
    expect(report.levels.reduce((total, level) => total + level.notes, 0)).toBe(notes);
    expect(report.naming.topics).toBe(report.shape.topics - 1);
    expect(report.naming.named).toBe(report.naming.topics);
    expect(report.naming.bySource.llm).toBeGreaterThan(0);
    expect(report.placements.primaryNotes).toBe(notes);
    expect(report.placements.atRoot).toBe(0);
    expect(report.placements.byDecision.build).toBe(notes);
    expect(report.changeSets).toMatchObject({ total: 5, byOrigin: { build: 1, naming: 4 } });
    expect(report.changeSets.perDay.reduce((total, day) => total + day.total, 0)).toBe(5);
    expect(report.churn.days).toHaveLength(9);
    expect(report.library).toMatchObject({ notes, vectorRows: notes, notesWithoutVector: 0 });
    expect(report.legacy?.pages).toBe(9);
  });

  it('counts the gate\'s decisions, its "none" answers and where the items ended up', () => {
    const { gate } = buildProfileReport(input, defaultReportOptions);
    // Six accepted choices, one "none", one choice of the root (an ancestor of every topic).
    expect(gate).toMatchObject({
      decisions: 8,
      accepted: 7,
      none: 1,
      byDecider: { "ranker-fixture": 8 },
      candidatesMean: 2
    });
    // Seven accepted decisions: the six sit where they were put, the one at the root contains all.
    expect(gate.stillInChosen).toBe(1);
  });

  it("samples topics by stratum with central members that are the closest to the centroid", () => {
    const report = buildProfileReport(input, { ...defaultReportOptions, sample: 9 });
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples.length).toBeLessThanOrEqual(9);
    expect(new Set(report.samples.map((sample) => sample.topicId)).size).toBe(
      report.samples.length
    );
    for (const sample of report.samples) {
      expect(sample.members).toHaveLength(Math.min(5, sample.notes));
      expect(sample.members.map((member) => member.cosine)).toEqual(
        [...sample.members.map((member) => member.cosine)].sort((a, b) => b - a)
      );
      expect(sample.notes).toBeGreaterThanOrEqual(5);
      expect(sample.members[0]!.source).toMatch(/^Article article-/u);
      expect(sample.depth).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(report.samples.map((sample) => sample.stratum)).size).toBeGreaterThanOrEqual(2);
    // The same seed draws the same topics; another seed may not.
    const again = buildProfileReport(input, { ...defaultReportOptions, sample: 9 });
    expect(again.samples.map((s) => s.topicId)).toEqual(report.samples.map((s) => s.topicId));
    const other = buildProfileReport(input, { ...defaultReportOptions, sample: 9, seed: 3 });
    expect(other.samples.map((s) => s.topicId)).not.toEqual(report.samples.map((s) => s.topicId));
  });

  it("joins ground truth when the labels reach the notes, and says what it joined", () => {
    const report = buildProfileReport(input, defaultReportOptions);
    expect(report.truth).toMatchObject({ source: "fixture", coverage: 1 });
    expect(report.truth!.app!.leafDomainPurity).toBeGreaterThan(0.8);
    // The tree is the fresh build: the same agreement with the labels.
    expect(report.truth!.fresh).toEqual(report.truth!.app);
    // A source that matches nothing is ignored.
    const none = buildProfileReport(
      { ...input, truth: { name: "none", domainOf: () => undefined } },
      defaultReportOptions
    );
    expect(none.truth).toBeNull();
  });

  it("can skip the fresh build", () => {
    const report = buildProfileReport(input, { ...defaultReportOptions, fresh: false });
    expect(report.fresh).toBeNull();
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.caveats.join(" ")).toMatch(/--no-fresh/u);
  });
});

describe("a tree that grew incrementally", () => {
  it("differs from the fresh build, and says by how much", async () => {
    await writeFixtureExport({
      name: "env-grown",
      cacheDirectory: cache,
      mode: "incremental",
      changeSetOrigins: { build: 1, place: 12, rebalance: 2 }
    });
    const report = buildProfileReport(await load("env-grown"), defaultReportOptions);
    expect(report.fresh!.identical).toBe(false);
    expect(report.fresh!.laterChangeSets).toEqual({ place: 12, rebalance: 2 });
    expect(report.fresh!.agreement.leafNmi).toBeGreaterThan(0.5);
    expect(report.fresh!.agreement.leafNmi).toBeLessThan(1);
    expect(report.fresh!.unplaced).toBe(0);
    // Later change-sets explain the difference: no warning about the build's inputs.
    expect(report.caveats).toEqual([]);
    expect(report.shape.items).toBe(items);
    // Fewer than seven daily rows: E3 cannot be judged from this export.
    const e3 = report.targets.find((entry) => entry.id === "E3")!;
    expect(e3).toMatchObject({ status: "na", value: null });
    expect(e3.note).toMatch(/seven are needed/u);
  });

  it("flags a tree that only has its build yet differs from the fresh build", async () => {
    await writeFixtureExport({
      name: "env-suspect",
      cacheDirectory: cache,
      mode: "incremental",
      changeSetOrigins: { build: 1 }
    });
    const report = buildProfileReport(await load("env-suspect"), defaultReportOptions);
    expect(report.fresh!.identical).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/same seed, configuration and content-key order/u);
  });
});

describe("exports without vectors and failing trees", () => {
  it("reports what it can without a replay store", async () => {
    await writeFixtureExport({
      name: "env-novec",
      cacheDirectory: cache,
      mode: "fresh",
      withVectors: false
    });
    const report = buildProfileReport(await load("env-novec", false), defaultReportOptions);
    expect(report.fresh).toBeNull();
    expect(report.samples).toEqual([]);
    expect(report.library.vectorRows).toBeNull();
    expect(report.caveats.join(" ")).toMatch(/Exported without vectors/u);
    expect(report.targets.find((entry) => entry.id === "E1")!.status).toBe("pass");
  });

  it("fails a gating check that the audit does not meet", async () => {
    // A configuration with a narrow fan-out target makes the tree miss E2's fan-out bar.
    const config = topicTreeConfigWith({
      fanOut: { min: 2, max: 12, targetMin: 11, targetMax: 12, hardMax: 16, rootTarget: 8 }
    });
    await writeFixtureExport({ name: "env-narrow", cacheDirectory: cache, mode: "fresh", config });
    const report = buildProfileReport(await load("env-narrow"), defaultReportOptions);
    const comparison = buildComparison([report], () => new Date("2026-10-15T12:00:00.000Z"));
    expect(ComparisonDocumentSchema.parse(comparison)).toEqual(comparison);
    expect(comparison.createdAt).toBe("2026-10-15T12:00:00.000Z");
    expect(gatingFailures([report]).join("\n")).toMatch(/env-narrow: E2 Internal topics with 4-9/u);
  });
});

describe("inputs", () => {
  it("refuses a file that is not a topic export", () => {
    expect(() => parseExportDocument({ format: "something-else" })).toThrow(/Not a topics:export/u);
    expect(() => parseExportDocument(null)).toThrow(/Not a topics:export/u);
  });

  it("orders rows by content hash, then by item key", () => {
    const rows = [
      { id: "b", contentHash: "2" },
      { id: "a", contentHash: "2" },
      { id: "c", contentHash: "1" }
    ];
    expect(contentKeyOrder({ rows } as never)).toEqual([2, 1, 0]);
  });

  it("reads the live tree of an export with its depths", async () => {
    await writeFixtureExport({ name: "env-tree", cacheDirectory: cache, mode: "fresh" });
    const tree = exportTree((await load("env-tree", false)).document);
    expect(tree.unreachable).toBe(0);
    expect(tree.nodes.get(tree.rootId)!.depth).toBe(0);
    expect(Math.max(...[...tree.nodes.values()].map((node) => node.depth))).toBeGreaterThanOrEqual(
      2
    );
  });
});
