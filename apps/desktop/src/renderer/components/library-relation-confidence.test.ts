import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { relationConfidenceLabel } from "./LibraryView";

// The relation tab of a source (F3 D42): a relations v2 row says its band as a word, a kept one
// says so, and only a legacy row keeps the percentage of its stored score.
const t = createTranslator("en");
const relation = (
  overrides: Partial<Parameters<typeof relationConfidenceLabel>[0]> = {}
): Parameters<typeof relationConfidenceLabel>[0] => ({
  band: null,
  calibration: null,
  state: "applied",
  finalScore: 0.82,
  ...overrides
});

describe("the confidence a relation of a source shows", () => {
  it("keeps the stored percentage for a legacy row, which has no band", () => {
    expect(relationConfidenceLabel(relation(), t)).toBe("82%");
    expect(relationConfidenceLabel(relation({ finalScore: 0.5 }), t)).toBe("50%");
  });

  it("says a band word for a version 2 row, never a percentage", () => {
    expect(relationConfidenceLabel(relation({ band: "apply", calibration: "frozen" }), t)).toBe(
      "Strong"
    );
    expect(
      relationConfidenceLabel(
        relation({ band: "suggest", calibration: "provisional", state: "suggested" }),
        t
      )
    ).toBe("Possible");
    expect(
      relationConfidenceLabel(
        relation({ band: "suggest", calibration: "uncalibrated", state: "suggested" }),
        t
      )
    ).toBe("Not calibrated");
    expect(relationConfidenceLabel(relation({ band: "apply", finalScore: 0.97 }), t)).not.toMatch(
      /%/
    );
  });

  it("says kept for a relation the owner kept, whatever its band", () => {
    expect(relationConfidenceLabel(relation({ band: "suggest", state: "kept" }), t)).toBe("Kept");
    expect(relationConfidenceLabel(relation({ state: "kept" }), t)).toBe("Kept");
  });

  it("is written in every language", () => {
    for (const code of supportedLanguageCodes) {
      const translate = createTranslator(code);
      for (const input of [
        relation({ band: "apply" }),
        relation({ band: "suggest", state: "suggested" }),
        relation({ band: "suggest", calibration: "uncalibrated", state: "suggested" }),
        relation({ state: "kept" })
      ]) {
        const label = relationConfidenceLabel(input, translate);
        expect(label, code).not.toBe("");
        expect(label, code).not.toContain("notePage.");
        expect(label, code).not.toContain("[[missing");
      }
    }
  });
});
