import { describe, expect, it } from "vitest";
import { decisionsDailyCapMaxUsd, RelationsConfigSchema } from "@app/domain";

import { decisionsDevOptions } from "./decisions-dev-options.js";

const env = {
  MEMORA_RELATIONS_DECISIONS: "on",
  MEMORA_RELATIONS_DECISIONS_KEY_FILE: "/tmp/decisions-key",
  MEMORA_RELATIONS_DECISIONS_CAP_USD: "2.5"
};

describe("the DEV knobs of the Decisions decider", () => {
  it("are read in a DEV run", () => {
    expect(decisionsDevOptions(env, false)).toEqual({
      devDecisions: true,
      devDecisionsKeyFile: "/tmp/decisions-key",
      devDecisionsCapUsd: 2.5
    });
    expect(decisionsDevOptions({}, false)).toEqual({ devDecisions: false });
    expect(decisionsDevOptions({ MEMORA_RELATIONS_DECISIONS: "yes" }, false)).toEqual({
      devDecisions: false
    });
  });

  it("are ignored in a packaged build, whatever the environment says", () => {
    expect(decisionsDevOptions(env, true)).toEqual({ devDecisions: false });
  });

  it("never take a cap above the schema's maximum, nor a figure that is not a cap", () => {
    const cap = (value: string) =>
      decisionsDevOptions({ MEMORA_RELATIONS_DECISIONS_CAP_USD: value }, false).devDecisionsCapUsd;
    expect(cap("Infinity")).toBe(decisionsDailyCapMaxUsd);
    expect(cap("1e9")).toBe(decisionsDailyCapMaxUsd);
    expect(cap("0.25")).toBe(0.25);
    for (const ignored of ["0", "-1", "-Infinity", "NaN", "abc", ""])
      expect(cap(ignored), ignored).toBeUndefined();
    // The maximum is the typed config's own: the cap a run names always parses as a cap.
    expect(() =>
      RelationsConfigSchema.parse({ decisions: { dailyCapUsd: cap("Infinity") } })
    ).not.toThrow();
  });
});
