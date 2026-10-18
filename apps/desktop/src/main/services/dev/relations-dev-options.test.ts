import { relationsConfig } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  helperBatchKnob,
  helperBatchOverride,
  relationsConfigForRun
} from "./relations-dev-options.js";

describe("the DEV helper batch override (T63's B1)", () => {
  it("is absent unless the knob is set, and ignored in a packaged build", () => {
    expect(helperBatchOverride({}, false)).toBeNull();
    expect(helperBatchOverride({ [helperBatchKnob]: "  " }, false)).toBeNull();
    expect(helperBatchOverride({ [helperBatchKnob]: "1" }, true)).toBeNull();
    expect(relationsConfigForRun({}, false)).toBeUndefined();
    expect(relationsConfigForRun({ [helperBatchKnob]: "1" }, true)).toBeUndefined();
  });

  it("reads a whole number from 1 to 64", () => {
    expect(helperBatchOverride({ [helperBatchKnob]: "1" }, false)).toBe(1);
    expect(helperBatchOverride({ [helperBatchKnob]: "16" }, false)).toBe(16);
    expect(helperBatchOverride({ [helperBatchKnob]: "64" }, false)).toBe(64);
  });

  it("refuses anything else, so a run never measures the wrong batch", () => {
    for (const value of ["0", "65", "-1", "1.5", "abc", "016", "100"])
      expect(() => helperBatchOverride({ [helperBatchKnob]: value }, false)).toThrow(
        /whole number from 1 to 64/u
      );
  });

  it("changes only the helper batch of the shipped configuration", () => {
    const config = relationsConfigForRun({ [helperBatchKnob]: "1" }, false)!;
    expect(config.decide.helperBatchSize).toBe(1);
    expect(relationsConfig.decide.helperBatchSize).toBe(16);
    expect({ ...config, decide: { ...config.decide, helperBatchSize: 16 } }).toEqual(
      relationsConfig
    );
    expect(config.calibrations).toBe(relationsConfig.calibrations);
  });
});
