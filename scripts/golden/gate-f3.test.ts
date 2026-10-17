import { describe, expect, it } from "vitest";

import {
  aggregateGate,
  defaultGateOptions,
  gateExitCode,
  gateSampleSchema,
  renderGateMarkdown,
  resealSample,
  summarizeSample,
  type GateSample
} from "./gate-f3.ts";
import type { HeldOutAccess } from "./freeze-guard.ts";
import { evaluationOf, type SampleSpec } from "./test-world.ts";

const open: HeldOutAccess = {
  open: true,
  frozen: {
    configHash: "sha256:0123456789abcdef",
    calibrationIdentity: "x",
    parity: {},
    inputHashes: {},
    frozenAt: "2026-10-30T12:00:00Z"
  }
};
const sealed: HeldOutAccess = { open: false, reason: "no frozen.json" };

const sample = (label: string, spec: SampleSpec, access: HeldOutAccess = open): GateSample =>
  summarizeSample(label, evaluationOf(spec), access, { database: "test", generatedAt: null });

describe("summarizeSample", () => {
  it("counts shown relations and applied-only relations beside them, per partition and layer", () => {
    const summary = sample("S0", {
      shown: 27,
      suggested: 3,
      forbidden: 1,
      sourceLinked: 10,
      tuningSourceLinked: 4
    });
    const held = summary.partitions.holdout!;
    expect(held.shown.expected).toMatchObject({ found: 27, total: 28, evaluable: 28 });
    expect(held.shown.forbidden).toMatchObject({ linked: 1, total: 35 });
    expect(held.applied.expected.found).toBe(24); // 3 of the 27 are suggestions only
    expect(held.applied.forbidden.linked).toBe(1);
    expect(held.sources.expected.found).toBe(10);
    expect(held.either.expected.found).toBe(27);
    expect(summary.partitions.tuning.sources.expected).toMatchObject({ found: 4, total: 26 });
    expect(summary.heldOut).toBe("open");
    expect(gateSampleSchema.parse(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
  });

  it("reads the source report: replay count, AI and wall seconds, calls and promoted against judged", () => {
    const summary = sample("S0", {
      shown: 0,
      sourceLinked: 4,
      sourceCalls: 20,
      sourceReplayed: 5,
      sourceSeconds: 2
    });
    expect(summary.source).toMatchObject({ roots: 10, calls: 20, replayed: 5 });
    expect(summary.source.callsPerRoot).toBe(2);
    expect(summary.source.aiSecondsPerRoot).toBeCloseTo(2, 6);
    expect(summary.source.wallSecondsPerRoot).toBe(2);
    expect(summary.source.relations).toEqual({ promoted: 2, judged: 2, unknown: 0 });
    expect(summary.callsPerChapter?.generative.perChapter).toBe(60);
  });

  it("leaves the held-out numbers out of a sample made without the freeze record", () => {
    const summary = sample("S0", { shown: 27 }, sealed);
    expect(summary.heldOut).toBe("sealed");
    expect(summary.partitions.holdout).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("27");
    expect(summary.warnings.join(" ")).toContain("held-out sealed until the freeze");
    // A stored open sample read after the record was removed is sealed again.
    const resealed = resealSample(sample("S1", { shown: 28 }), "no frozen.json");
    expect(resealed.partitions.holdout).toBeNull();
    expect(resealed.heldOut).toBe("sealed");
    expect(resealSample(summary, "x")).toBe(summary);
  });
});

describe("aggregateGate: X1 over several samples", () => {
  const four = (counts: [number, number, number, number], forbidden = 0) =>
    counts.map((shown, index) =>
      sample(["S0", "S1", "S2", "B1"][index]!, { shown, forbidden: index === 3 ? forbidden : 0 })
    );

  it("passes on a mean of 27.0, no sample below 26 and no forbidden pair", () => {
    const report = aggregateGate(four([28, 27, 27, 26]));
    expect(report.series.heldOutShownExpected).toMatchObject({ mean: 27, min: 26, max: 28 });
    expect(report.series.heldOutShownExpected.values.map((entry) => entry.value)).toEqual([
      28, 27, 27, 26
    ]);
    expect(report.verdicts.x1Expected.pass).toBe(true);
    expect(report.verdicts.x1Forbidden.pass).toBe(true);
    expect(report.verdicts.tuningForbidden.pass).toBe(true);
  });

  it("fails on a sample below 26 even when the mean is high", () => {
    const report = aggregateGate(four([28, 28, 28, 25]));
    expect(report.series.heldOutShownExpected.mean).toBe(27.25);
    expect(report.verdicts.x1Expected.pass).toBe(false);
  });

  it("fails on a mean under 27.0 although no sample is below 26", () => {
    const report = aggregateGate(four([27, 27, 26, 26]));
    expect(report.series.heldOutShownExpected.mean).toBe(26.5);
    expect(report.verdicts.x1Expected.pass).toBe(false);
  });

  it("fails when any sample links a forbidden held-out pair", () => {
    const report = aggregateGate(four([28, 28, 28, 28], 1));
    expect(report.verdicts.x1Expected.pass).toBe(true);
    expect(report.verdicts.x1Forbidden.pass).toBe(false);
    expect(report.pass).toBe(false);
    expect(gateExitCode(report.pass)).toBe(1);
  });

  it("is undecided with fewer samples than decision D2 asks for", () => {
    const report = aggregateGate(four([28, 28, 28, 28]).slice(0, 2));
    expect(report.verdicts.x1Expected).toEqual({ pass: null, note: "2 of 4 samples" });
    expect(
      aggregateGate(four([28, 28, 28, 28]).slice(0, 2), { ...defaultGateOptions, minSamples: 2 })
        .verdicts.x1Expected.pass
    ).toBe(true);
  });

  it("is undecided, and prints no held-out number, while the held-out partition is sealed", () => {
    const samples = ["S0", "S1", "S2", "B1"].map((label) => sample(label, { shown: 28 }, sealed));
    const report = aggregateGate(samples);
    expect(report.series.heldOutShownExpected.mean).toBeNull();
    expect(report.verdicts.x1Expected).toMatchObject({ pass: null });
    expect(report.verdicts.x1Forbidden.pass).toBeNull();
    // Tuning is still read.
    expect(report.verdicts.tuningForbidden.pass).toBe(true);
    expect(report.pass).toBeNull();
    expect(gateExitCode(report.pass)).toBe(2);
    const markdown = renderGateMarkdown(report);
    expect(markdown).toContain("S0 sealed");
    expect(markdown).toContain("not decided");
    expect(markdown).toContain("held-out sealed until the freeze (decision D3)");
  });

  it("reports applied-only counts beside the shown ones", () => {
    const samples = [0, 1, 2, 3].map((index) =>
      sample(`S${index}`, { shown: 28, suggested: 2 + index })
    );
    const report = aggregateGate(samples);
    expect(report.series.heldOutAppliedExpected.values.map((entry) => entry.value)).toEqual([
      26, 25, 24, 23
    ]);
    expect(report.series.heldOutShownExpected.min).toBe(28);
  });
});

describe("aggregateGate: S1 source matching", () => {
  const good = {
    shown: 28,
    sourceLinked: 28,
    tuningSourceLinked: 26,
    sourceCalls: 20,
    sourceSeconds: 4
  };
  const live = (spec: Partial<SampleSpec> = {}) => [
    sample("S0", { ...good, ...spec }),
    sample("S1", good),
    sample("S2", {
      shown: 28,
      sourceLinked: 28,
      tuningSourceLinked: 26,
      sourceCalls: 20,
      sourceReplayed: 20
    })
  ];
  const options = { ...defaultGateOptions, minSamples: 3, liveJudge: ["S0", "S1"] };

  it("passes on quality and on time and replay checks of the live-judge samples only", () => {
    const report = aggregateGate(live(), options);
    expect(report.verdicts.s1Quality.pass).toBe(true);
    // S2 replayed every source call, but it is not a live-judge sample.
    expect(report.verdicts.s1Time.pass).toBe(true);
    expect(report.pass).toBe(true);
    expect(renderGateMarkdown(report)).toContain("| All | | | | pass |");
  });

  it("fails when a live-judge sample replayed a source call, or took too long, or called too often", () => {
    expect(aggregateGate(live({ sourceReplayed: 1 }), options).verdicts.s1Time.pass).toBe(false);
    expect(aggregateGate(live({ sourceSeconds: 8 }), options).verdicts.s1Time.pass).toBe(false);
    expect(aggregateGate(live({ sourceCalls: 40 }), options).verdicts.s1Time.pass).toBe(false);
  });

  it("fails when the source layer links a forbidden pair or too few expected pairs", () => {
    expect(aggregateGate(live({ sourceLinked: 26 }), options).verdicts.s1Quality.pass).toBe(false);
    expect(aggregateGate(live({ tuningSourceLinked: 24 }), options).verdicts.s1Quality.pass).toBe(
      false
    );
  });

  it("names no live-judge sample, then the time check is undecided", () => {
    const report = aggregateGate(live(), { ...options, liveJudge: [] });
    expect(report.verdicts.s1Time.pass).toBeNull();
    expect(report.verdicts.s1Time.note).toContain("--live-judge");
  });

  it("reports held-out bridges against the soft ceiling without failing on them", () => {
    const report = aggregateGate(live(), options);
    expect(renderGateMarkdown(report)).toContain("soft ceiling 8");
  });
});
