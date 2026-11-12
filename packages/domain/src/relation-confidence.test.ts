import { describe, expect, it } from "vitest";

import {
  confidenceBand,
  relationConfidenceBands,
  relationRoutingCases,
  routesToInbox
} from "./relation-confidence.js";

describe("relation confidence", () => {
  it("keeps the bands as typed configuration at 0.6 and 0.85", () => {
    expect(relationConfidenceBands).toEqual({ high: 0.85, medium: 0.6 });
  });

  it("words a probability by its band, the bounds belonging to the higher band", () => {
    expect(confidenceBand(0.85)).toBe("high");
    expect(confidenceBand(0.91)).toBe("high");
    expect(confidenceBand(1)).toBe("high");
    expect(confidenceBand(0.8499)).toBe("medium");
    expect(confidenceBand(0.64)).toBe("medium");
    expect(confidenceBand(0.6)).toBe("medium");
    expect(confidenceBand(0.5999)).toBe("low");
    expect(confidenceBand(0)).toBe("low");
  });

  it("reads no probability as unknown, never as a number", () => {
    expect(confidenceBand(null)).toBe("unknown");
    expect(confidenceBand(undefined)).toBe("unknown");
    expect(confidenceBand(Number.NaN)).toBe("unknown");
  });

  it("routes a suggestion to the Inbox for each stance at 0.64, 0.91 and null", () => {
    for (const stance of ["supports", "extends", "related"]) {
      expect(routesToInbox({ stance, probability: 0.64 })).toBe(true);
      expect(routesToInbox({ stance, probability: 0.91 })).toBe(false);
      expect(routesToInbox({ stance, probability: null })).toBe(true);
    }
    for (const probability of [0.64, 0.91, null])
      expect(routesToInbox({ stance: "contradicts", probability })).toBe(true);
  });

  it("agrees with the shared case table", () => {
    for (const row of relationRoutingCases)
      expect(routesToInbox({ stance: row.stance, probability: row.probability })).toBe(row.routes);
  });
});
