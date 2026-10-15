import { describe, expect, it } from "vitest";

import { majority, percentile, summarizeSplit } from "./gate-proof-core.js";
import type { GatedNote } from "./gate-proof-core.js";

const note = (overrides: Partial<GatedNote>): GatedNote => ({
  domain: "biology",
  bestDomain: "biology",
  chosenDomain: "biology",
  topDomain: "biology",
  rankMs: 100,
  truncated: 0,
  ...overrides
});

describe("gate proof measurements", () => {
  it("takes nearest-rank percentiles", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([1, 2], 100)).toBe(2);
  });

  it("reports gate precision against the margin-only baseline", () => {
    const summary = summarizeSplit({
      holdout: 10,
      auto: 4,
      autoCorrect: 3,
      unadmitted: 2,
      gatedTotal: 5,
      gated: [
        note({}),
        note({ bestDomain: "physics", topDomain: "physics" }),
        note({ chosenDomain: "physics", bestDomain: "physics" }),
        note({ chosenDomain: null, bestDomain: "physics", rankMs: null }),
        note({ chosenDomain: null, truncated: 2 })
      ]
    });
    expect(summary).toMatchObject({
      holdout: 10,
      gatedShare: 0.5,
      unadmittedShare: 0.2,
      autoPrecision: 0.75,
      gate: {
        gated: 5,
        accepted: 3,
        none: 2,
        noneShare: 0.4,
        precision: 0.6667,
        baselinePrecision: 0.4,
        baselinePrecisionOnAccepted: 0.3333,
        noneAvoidedError: 0.5,
        rankerTop1Precision: 0.8,
        correctShare: 0.4,
        baselineCorrectShare: 0.4,
        truncatedDocuments: 2
      },
      latency: { calls: 4, p50Ms: 100, p95Ms: 100 }
    });
    expect(
      summarizeSplit({
        holdout: 0,
        auto: 0,
        autoCorrect: 0,
        unadmitted: 0,
        gatedTotal: 0,
        gated: []
      })
    ).toMatchObject({ gatedShare: null, gate: { precision: null }, latency: { calls: 0 } });
  });

  it("counts the gated share over every gated note, not only the ranked ones", () => {
    const summary = summarizeSplit({
      holdout: 100,
      auto: 60,
      autoCorrect: 60,
      unadmitted: 10,
      gatedTotal: 30,
      gated: [note({})]
    });
    expect(summary.gatedShare).toBe(0.3);
    expect(summary.gate.gated).toBe(1);
  });

  it("names the majority, ties in code-unit order", () => {
    expect(majority([])).toBeNull();
    expect(majority(["b", "a", "b"])).toBe("b");
    expect(majority(["b", "a"])).toBe("a");
  });
});
