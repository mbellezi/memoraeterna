import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cloneTopicTreeState,
  createTopicTreeEditor,
  defaultTopicTreeConfig,
  primaryPathDiff,
  primaryPlacement,
  rowItemKey,
  topicTreeConfigWith
} from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { arrivalOrders, growthKinds, sourceDaySchedule } from "./datasets.js";
import { writeReplayStore } from "./export-vectors.js";
import { createReferenceEngine } from "./reference-engine.js";
import { ReplayReportSchema, readReport, writeReport } from "./report-data.js";
import {
  aggregateGrowth,
  aggregateWeekly,
  auditRun,
  growthRun,
  knnRun,
  main,
  parityChecks,
  parityRun,
  spikeBParity,
  weeklyRun
} from "./replay.js";
import type { ReplayRun } from "./replay.js";
import { auditState, churnSince, pathSnapshot, rowKeys } from "./replay-metrics.js";
import { syntheticDataset } from "./synthetic-dataset.js";

const dataset = syntheticDataset();
const rows = Array.from({ length: dataset.rows.length }, (_, row) => row);

function runOf(overrides: Partial<ReplayRun> = {}): ReplayRun {
  return {
    dataset,
    config: defaultTopicTreeConfig,
    seed: 9,
    detect: detectCommunitiesLouvain,
    createEngine: createReferenceEngine,
    now: () => "2026-10-15T12:00:00.000Z",
    ...overrides
  };
}

describe("parityRun", () => {
  it("builds a valid, repeatable Louvain tree and a schema-valid report", () => {
    const { report, state } = parityRun(runOf({ seed: 20261014 }), { repeat: true });
    expect(ReplayReportSchema.parse(report)).toEqual(report);
    expect(report.shape.items).toBe(rows.length);
    expect(report.shape.reachability).toBe(1);
    expect(report.shape.hardViolations).toBe(0);
    expect(report.shape.rootChildren).toBeGreaterThanOrEqual(2);
    expect(report.deterministic).toBe(true);
    expect(report.partitionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.knnExact).toBe(true);
    expect(report.truth?.leafDomainPurity).toBeGreaterThan(0.8);
    expect(report.passes).toBe(true);
    expect(report.seedRole).toBe("evaluation");
    expect(state.items.size).toBe(rows.length);
    // The same seed repeats the same tree and the same hash.
    expect(parityRun(runOf({ seed: 20261014 })).report.partitionHash).toBe(report.partitionHash);
    expect(parityRun(runOf({ seed: 1 })).report.partitionHash).not.toBe(report.partitionHash);
  });

  it("builds on a given set of rows", () => {
    const { report } = parityRun(runOf(), { rows: rows.slice(0, 200) });
    expect(report.shape.items).toBe(200);
  });
});

describe("parityChecks", () => {
  const measured = {
    depthMean: 3.69,
    fanOutInTarget: 0.85,
    leafDomainPurity: 0.92,
    reachability: 1,
    hardViolations: 0,
    buildSeconds: 36
  };

  it("holds only the generic bounds for datasets and seeds Spike B did not measure", () => {
    expect(parityChecks("owner", 20261014, true, measured)).toHaveLength(2);
    expect(parityChecks("corpus-notitle", 7, true, measured)).toHaveLength(2);
    expect(parityChecks("corpus-notitle", 20261014, false, measured)).toHaveLength(2);
  });

  it("holds corpus-notitle at seed 20261014 to the Spike B numbers and tolerances", () => {
    const checks = parityChecks("corpus-notitle", 20261014, true, measured);
    expect(checks.map((entry) => entry.name)).toEqual([
      "reachability",
      "hard violations",
      "depth mean (Spike B)",
      "fan-out 4-9 share (Spike B)",
      "leaf domain purity (Spike B)",
      "build seconds"
    ]);
    expect(checks.every((entry) => entry.pass)).toBe(true);
    const off = parityChecks("corpus-notitle", 20261014, true, { ...measured, depthMean: 3.8 });
    expect(off.find((entry) => entry.name.startsWith("depth"))?.pass).toBe(false);
    const slow = parityChecks("corpus-notitle", 20261014, true, { ...measured, buildSeconds: 51 });
    expect(slow.at(-1)?.pass).toBe(false);
    expect(spikeBParity.maxBuildSeconds).toBe(50);
  });
});

describe("growthRun", () => {
  it.each(growthKinds)("%s: inserts the tail and settles to a valid tree", (kind) => {
    const { report, state } = growthRun(runOf(), { kind, share: 0.2 });
    expect(ReplayReportSchema.parse(report)).toEqual(report);
    expect(report.base + report.inserted).toBe(rows.length);
    expect(report.settled.shape.items).toBe(rows.length);
    expect(report.settled.shape.reachability).toBe(1);
    expect(report.settled.shape.hardViolations).toBe(0);
    expect(report.churn).toBeGreaterThanOrEqual(0);
    expect(report.churn).toBeLessThanOrEqual(1);
    expect(report.unadmittedRate).toBeGreaterThanOrEqual(0);
    expect(Object.keys(report.gatedAtMargin)).toEqual(["0.01", "0.02", "0.03", "0.05"]);
    expect(report.checks.map((entry) => entry.name)).toContain("E2 mean depth");
    expect(state.items.size).toBe(rows.length);
  });
});

describe("weeklyRun", () => {
  it.each(arrivalOrders)("%s: eight weeks of arrivals keep every item reachable", (order) => {
    const { report, state } = weeklyRun(runOf(), { order, maxWeeklyChurn: 1 });
    expect(ReplayReportSchema.parse(report)).toEqual(report);
    expect(report.weeks).toHaveLength(8);
    expect(report.schedule.baseRows).toBe(Math.round(rows.length * 0.6));
    const arrived = report.weeks.reduce((total, week) => total + week.arrivals, 0);
    expect(report.schedule.baseRows + arrived).toBe(rows.length);
    report.weeks.forEach((week, index) => {
      expect(week.week).toBe(index + 1);
      expect(week.itemsAtEnd).toBe(week.itemsAtStart + week.arrivals);
      expect(week.churn).toBeGreaterThanOrEqual(0);
      expect(week.churn).toBeLessThanOrEqual(1);
      expect(week.hardViolations).toBe(0);
      if (index > 0) expect(week.itemsAtStart).toBe(report.weeks[index - 1]?.itemsAtEnd ?? 0);
    });
    expect(report.maxChurn).toBe(Math.max(...report.weeks.map((week) => week.churn)));
    expect(report.final.shape.reachability).toBe(1);
    expect(report.passes).toBe(true);
    expect(auditRun(runOf(), state, rows).passes).toBe(true);
  });

  it("replays one source per day when given a source calendar (ENV-G and ENV-F)", () => {
    const schedule = sourceDaySchedule(dataset, { baseShare: 0.5 });
    const { report } = weeklyRun(runOf(), { order: "chronological", schedule, maxWeeklyChurn: 1 });
    expect(report.weeks).toHaveLength(2);
    expect(report.schedule.baseRows).toBe(schedule.base.length);
    expect(report.weeks.reduce((total, week) => total + week.arrivals, 0)).toBe(
      rows.length - schedule.base.length
    );
    expect(report.final.shape.items).toBe(rows.length);
    expect(report.passes).toBe(true);
  });

  it("is deterministic for a fixed seed (everything but wall time)", () => {
    const strip = (report: ReturnType<typeof weeklyRun>["report"]) => ({
      ...report,
      base: { ...report.base, timings: undefined },
      weeks: report.weeks.map((week) => ({ ...week, ms: 0 }))
    });
    const first = weeklyRun(runOf(), { order: "shuffled" }).report;
    const second = weeklyRun(runOf(), { order: "shuffled" }).report;
    expect(strip(second)).toEqual(strip(first));
  });

  it("fails the E3 check when the weekly churn exceeds the bar", () => {
    const { report } = weeklyRun(runOf(), { order: "domain", maxWeeklyChurn: -1 });
    expect(report.passes).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "E3 maximum weekly churn", pass: false });
  });

  describe("stability controls (the reference engine)", () => {
    // Small leaves overflow their soft maximum often, so REBALANCE has soft work to do.
    const config = topicTreeConfigWith({
      leaf: { min: 2, target: 5, max: 8 },
      repair: { cooldownInserts: 0 }
    });

    it("applies soft operations by default", () => {
      const { report } = weeklyRun(runOf({ config }), {
        order: "shuffled",
        freezeTopics: 0,
        maxWeeklyChurn: 1
      });
      const operations = report.weeks.reduce(
        (total, week) => total + Object.values(week.operations).reduce((n, count) => n + count, 0),
        0
      );
      expect(operations).toBeGreaterThan(0);
      expect(report.weeks.reduce((total, week) => total + week.skippedFrozen, 0)).toBe(0);
      expect(report.weeks.reduce((total, week) => total + week.skippedBudget, 0)).toBe(0);
    });

    it("skips soft operations on frozen topics", () => {
      const { report } = weeklyRun(runOf({ config }), {
        order: "shuffled",
        freezeTopics: 1000,
        maxWeeklyChurn: 1
      });
      expect(report.weeks.reduce((total, week) => total + week.skippedFrozen, 0)).toBeGreaterThan(
        0
      );
      expect(report.final.shape.hardViolations).toBe(0);
    });

    it("stops soft operations when the daily budget is spent", () => {
      const spent = topicTreeConfigWith({ stability: { dailyOperations: 0 } }, config);
      const { report } = weeklyRun(runOf({ config: spent }), {
        order: "shuffled",
        freezeTopics: 0,
        maxWeeklyChurn: 1
      });
      expect(report.weeks.reduce((total, week) => total + week.skippedBudget, 0)).toBeGreaterThan(
        0
      );
      const operations = report.weeks.reduce(
        (total, week) => total + Object.values(week.operations).reduce((n, count) => n + count, 0),
        0
      );
      const free = weeklyRun(runOf({ config }), {
        order: "shuffled",
        freezeTopics: 0,
        maxWeeklyChurn: 1
      });
      const freeOperations = free.report.weeks.reduce(
        (total, week) => total + Object.values(week.operations).reduce((n, count) => n + count, 0),
        0
      );
      expect(operations).toBeLessThan(freeOperations);
    });
  });
});

describe("aggregates over seeds (E2 and E3 medians)", () => {
  const growth = (seed: number) => growthRun(runOf({ seed }), { kind: "items" }).report;
  const weekly = (seed: number) =>
    weeklyRun(runOf({ seed }), { order: "shuffled", maxWeeklyChurn: 1 }).report;

  it("judges E2 on the median and the per-seed floor", () => {
    const reports = [growth(1), growth(2), growth(3)];
    const checks = aggregateGrowth(reports);
    expect(checks.map((entry) => entry.name)).toEqual([
      "E2 median of mean depths",
      "E2 median fan-out 4-9 share",
      "E2 lowest fan-out 4-9 share",
      "E2 single-child chains"
    ]);
    const withShape = (fanOut: number, depth = 3) =>
      reports.map((report) => ({
        ...report,
        settled: {
          ...report.settled,
          shape: { ...report.settled.shape, fanOutInTarget: fanOut, depthMean: depth }
        }
      }));
    // One seed at 78% is fine when the median holds; one under 75% is not.
    const mixed = withShape(0.85);
    mixed[0] = withShape(0.78)[0] as (typeof mixed)[number];
    expect(aggregateGrowth(mixed).every((entry) => entry.pass)).toBe(true);
    mixed[0] = withShape(0.7)[0] as (typeof mixed)[number];
    expect(aggregateGrowth(mixed).find((entry) => entry.name.includes("lowest"))?.pass).toBe(false);
    // A median under 80% fails; so does a mean depth over 4.5.
    expect(
      aggregateGrowth(withShape(0.79)).find((entry) => entry.name.includes("median fan-out"))?.pass
    ).toBe(false);
    expect(aggregateGrowth(withShape(0.85, 4.6))[0]?.pass).toBe(false);
  });

  it("judges E3 on the maximum weekly churn at the median seed", () => {
    const reports = [weekly(1), weekly(2), weekly(3)];
    const maxima = reports.map((report) => report.maxChurn).sort((a, b) => a - b);
    const [only] = aggregateWeekly(reports, 1);
    expect(only?.value).toBeCloseTo(maxima[1] as number, 6);
    expect(only?.pass).toBe(true);
    const edge = aggregateWeekly(reports, (maxima[1] as number) - 1e-3)[0];
    expect(edge?.pass).toBe(false);
  });
});

describe("churn", () => {
  it("equals the domain primary-path diff when no topic is resolved through a redirect", () => {
    const run = runOf();
    const engine = run.createEngine({
      matrix: dataset.matrix,
      config: run.config,
      seed: run.seed,
      detect: run.detect
    });
    const base = rows.slice(0, 400);
    engine.build(base);
    const before = cloneTopicTreeState(engine.state);
    const snapshot = pathSnapshot(engine.state, base);
    engine.place(rows.slice(400), { localRepair: true });
    engine.settle();
    const measured = churnSince(snapshot, engine.state);
    const diff = primaryPathDiff(before, engine.state);
    expect(measured.items).toBe(base.length);
    expect(measured.changed).toBe(diff.changed.length);
    expect(measured.churn).toBeCloseTo(diff.churn, 12);
    expect(measured.changedAfterRedirects).toBeLessThanOrEqual(measured.changed);
  });

  it("counts a merge as churn but not a rename or an untouched path", () => {
    const run = runOf();
    const engine = run.createEngine({
      matrix: dataset.matrix,
      config: run.config,
      seed: run.seed,
      detect: run.detect
    });
    engine.build(rows);
    const snapshot = pathSnapshot(engine.state, rows);
    expect(churnSince(snapshot, engine.state)).toMatchObject({ changed: 0, churn: 0 });
    // Move one leaf's items to a sibling and retire the leaf with a redirect (a merge).
    const state = engine.state;
    const leaf = [...state.topics.values()].find(
      (node) => node.children.length === 0 && node.parentId !== null && node.items.length > 0
    );
    const sibling = [...state.topics.values()].find(
      (node) =>
        node.id !== leaf?.id && node.parentId === leaf?.parentId && node.children.length === 0
    );
    expect(leaf && sibling).toBeTruthy();
    const editor = createTopicTreeEditor(state, { record: false });
    const moved = [...(leaf?.items ?? [])];
    for (const item of moved) editor.updatePlacement(item, 0, { topicId: sibling?.id as string });
    editor.retireTopic(leaf?.id as string, sibling?.id as string, "2026-01-02T00:00:00.000Z");
    const merged = churnSince(snapshot, state);
    expect(merged.changed).toBe(moved.length);
    expect(merged.changedAfterRedirects).toBe(0);
    // A rename touches no path.
    editor.renameTopic(sibling?.id as string, {
      title: "Renamed",
      nameState: "named",
      nameSource: "human",
      nameLanguage: "en"
    });
    expect(churnSince(snapshot, state).changed).toBe(moved.length);
  });
});

describe("auditState (E1)", () => {
  it("passes a built tree and names every kind of orphan", () => {
    const run = runOf();
    const engine = run.createEngine({
      matrix: dataset.matrix,
      config: run.config,
      seed: run.seed,
      detect: run.detect
    });
    engine.build(rows);
    const clean = auditState(engine.state, run.config, rows);
    expect(clean).toMatchObject({
      expectedItems: rows.length,
      reachable: rows.length,
      reachability: 1,
      orphans: { unreachableTopics: 0, placementsOnRetiredTopics: 0, itemsWithoutPrimary: 0 },
      hardViolationCount: 0,
      passes: true
    });

    const state = cloneTopicTreeState(engine.state);
    const editor = createTopicTreeEditor(state, { record: false });
    editor.unplaceItem(rowItemKey(0), 0);
    const missing = auditState(state, run.config, rows);
    expect(missing.orphans.itemsWithoutPrimary).toBe(1);
    expect(missing.reachability).toBeLessThan(1);
    expect(missing.passes).toBe(false);

    const retired = cloneTopicTreeState(engine.state);
    const leaf = [...retired.topics.values()].find(
      (node) => node.children.length === 0 && node.parentId !== null && node.items.length > 0
    );
    // The editor refuses to retire a topic that still holds items, so mark it directly.
    const doomed = retired.topics.get(leaf?.id as string);
    if (doomed) doomed.retiredAt = "2026-01-02T00:00:00.000Z";
    const onRetired = auditState(retired, run.config, rows);
    expect(onRetired.orphans.placementsOnRetiredTopics).toBeGreaterThan(0);
    expect(onRetired.passes).toBe(false);
    expect(primaryPlacement(retired, rowItemKey(0))).toBeDefined();
    expect(rowKeys([1, 2])).toEqual(["row:1", "row:2"]);
  });
});

describe("knnRun", () => {
  it("recommends the configured nprobe when it reaches the target, else the smallest that does", () => {
    const small = topicTreeConfigWith({ knn: { nprobe: 1 } });
    const report = knnRun(runOf({ config: small }), {
      samples: [400],
      nprobes: [1, 2, 1000],
      queries: 30,
      fullNprobes: [1, 1000],
      target: 0.999
    });
    expect(ReplayReportSchema.parse(report)).toEqual(report);
    expect(report.configuredNprobe).toBe(1);
    const points = report.subsets[0]?.points ?? [];
    const reaching = points.filter((point) => point.recall >= 0.999).map((point) => point.nprobe);
    expect(reaching).toContain(1000);
    expect(report.subsets[0]?.smallestPassing).toBe(Math.min(...reaching));
    // nprobe 1 (configured) misses the target on the sample, so the smallest passing one is adopted.
    expect(points[0]?.recall).toBeLessThan(0.999);
    expect(report.passes).toBe(false);
    expect(report.recommendedNprobe).toBe(Math.min(...reaching));
    const generous = knnRun(runOf({ config: small }), {
      samples: [400],
      nprobes: [1],
      queries: 0,
      target: 0
    });
    expect(generous.passes).toBe(true);
    expect(generous.recommendedNprobe).toBe(1);
  });

  it("skips samples larger than the dataset", () => {
    const report = knnRun(runOf(), { samples: [99999], nprobes: [8], queries: 0 });
    expect(report.subsets).toEqual([]);
    expect(report.passes).toBe(false);
  });
});

describe("reports and the command line", () => {
  let dir: string;
  let vectors: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "replay-cli-"));
    vectors = join(dir, "vectors");
    await writeReplayStore(vectors, "synthetic", {
      meta: dataset.meta,
      rows: dataset.rows,
      matrix: dataset.matrix
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads back a report of every kind, JSON and Markdown", async () => {
    const run = runOf();
    const parity = parityRun(run, { repeat: true });
    const growth = growthRun(run, { kind: "items" });
    const weekly = weeklyRun(run, { order: "shuffled", maxWeeklyChurn: 1 });
    const audit = auditRun(run, parity.state, parity.rows);
    const knn = knnRun(run, { samples: [300], nprobes: [4], queries: 20, target: 0.5 });
    const out = join(dir, "reports");
    for (const report of [parity.report, growth.report, weekly.report, audit, knn]) {
      const path = await writeReport(out, report, "t");
      expect(await readReport(path)).toEqual(report);
      expect(await readFile(path.replace(/\.json$/u, ".md"), "utf8")).toContain(
        `# ${report.kind} on synthetic`
      );
    }
    expect((await readdir(out)).sort()).toEqual([
      "audit-synthetic-9-t.json",
      "audit-synthetic-9-t.md",
      "growth-synthetic-9-t.json",
      "growth-synthetic-9-t.md",
      "knn-recall-synthetic-9-t.json",
      "knn-recall-synthetic-9-t.md",
      "parity-synthetic-9-t.json",
      "parity-synthetic-9-t.md",
      "weekly-replay-synthetic-9-t.json",
      "weekly-replay-synthetic-9-t.md"
    ]);
    await expect(
      writeReport(out, { ...parity.report, configHash: "short" }, "bad")
    ).rejects.toThrow();
  });

  it("runs each command end to end on a store in --vectors-dir", async () => {
    const out = join(dir, "out");
    const base = ["--dataset", "synthetic", "--vectors-dir", vectors, "--out", out, "--seed", "9"];
    expect(await main(["list", "--vectors-dir", vectors])).toBe(0);
    expect(await main(["parity", ...base, "--repeat", "--audit"])).toBe(0);
    expect(await main(["growth", ...base, "--arrival", "domains", "--audit"])).toBe(0);
    expect(
      await main(["weekly", ...base, "--arrival", "shuffled", "--max-churn", "1", "--audit"])
    ).toBe(0);
    expect(await main(["weekly", ...base, "--arrival", "domain", "--max-churn=-1"])).toBe(1);
    expect(
      await main([
        "knn",
        ...base,
        "--sample",
        "300",
        "--nprobe",
        "1,1000",
        "--queries",
        "20",
        "--full-nprobe",
        "1000",
        "--target",
        "0.9"
      ])
    ).toBe(1); // the configured nprobe (8) is not among those measured, so it cannot pass
    expect(
      await main([
        "knn",
        ...base,
        "--sample",
        "300",
        "--nprobe",
        "8",
        "--queries",
        "0",
        "--target",
        "0"
      ])
    ).toBe(0);
    const names = (await readdir(out)).filter((name) => name.endsWith(".json")).sort();
    expect(names).toEqual(
      [
        "audit-synthetic-9-domains.json",
        "audit-synthetic-9-parity.json",
        "audit-synthetic-9-shuffled.json",
        "growth-synthetic-9-domains.json",
        "knn-recall-synthetic-9.json",
        "parity-synthetic-9.json",
        "weekly-replay-synthetic-9-domain.json",
        "weekly-replay-synthetic-9-shuffled.json"
      ].sort()
    );
  });

  it("refuses the other role's seeds, unknown commands and arrivals, and prints usage", async () => {
    await expect(
      main([
        "parity",
        "--dataset",
        "synthetic",
        "--vectors-dir",
        vectors,
        "--role",
        "calibration",
        "--seed",
        "20261014"
      ])
    ).rejects.toThrow(/reserved for evaluation/u);
    expect(await main(["bogus"])).toBe(2);
    expect(await main([])).toBe(2);
    expect(
      await main([
        "weekly",
        "--dataset",
        "synthetic",
        "--vectors-dir",
        vectors,
        "--arrival",
        "sideways"
      ])
    ).toBe(2);
    expect(
      await main(["parity", "--dataset", "synthetic", "--vectors-dir", vectors, "--role", "x"])
    ).toBe(2);
  });

  it("judges several seeds on the median: only E1 fails a run by itself", async () => {
    const out = join(dir, "multi");
    const base = ["--dataset", "synthetic", "--vectors-dir", vectors, "--out", out];
    expect(
      await main([
        "weekly",
        ...base,
        "--seeds",
        "1,2,3",
        "--arrival",
        "shuffled",
        "--max-churn",
        "1"
      ])
    ).toBe(0);
    // An impossible bar fails every run on its own, but the exit code follows the median alone.
    expect(
      await main(["weekly", ...base, "--seeds", "1,2,3", "--arrival", "shuffled", "--max-churn=-1"])
    ).toBe(1);
    expect((await readdir(out)).filter((name) => name.endsWith(".json"))).toHaveLength(3);
  });

  it("takes a seeded sample with --limit and the seed sets with --seeds", async () => {
    const out = join(dir, "limited");
    expect(
      await main([
        "parity",
        "--dataset",
        "synthetic",
        "--vectors-dir",
        vectors,
        "--out",
        out,
        "--seeds",
        "calibration",
        "--role",
        "calibration",
        "--limit",
        "200"
      ])
    ).toBe(0);
    const names = (await readdir(out)).filter((name) => name.endsWith(".json")).sort();
    expect(names).toHaveLength(6);
    for (const name of names) expect(name).toMatch(/^parity-synthetic-\d+-n200\.json$/u);
    const report = await readReport(join(out, names[0] as string));
    expect(report.dataset.rows).toBe(200);
    expect(report.seedRole).toBe("calibration");
  });
});
