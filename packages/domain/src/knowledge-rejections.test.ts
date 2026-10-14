import { expect, it } from "vitest";
import { isNonReviewableValidation } from "./knowledge-rejections.js";
const rejected = {
  error: "organization.errors.evidence",
  callPending: false,
  repairs: 1,
  validationIssues: [
    { path: "targets.0.sections.0.markdown", message: "The original does not identify students." }
  ],
  supportAssessment: { verdict: { supported: false } }
};
it("recognizes a settled validation rejection only after its repair allowance is spent", () => {
  expect(isNonReviewableValidation(rejected, { repairs: 1 })).toBe(true);
  expect(isNonReviewableValidation({ ...rejected, repairs: 0 }, { repairs: 1 })).toBe(false);
  expect(
    isNonReviewableValidation(
      { ...rejected, error: "organization.errors.invalid", supportAssessment: null },
      { repairs: 1 }
    )
  ).toBe(true);
  expect(
    isNonReviewableValidation(
      { ...rejected, validationIssues: [], supportAssessment: null },
      { repairs: 1 }
    )
  ).toBe(false);
});
it.each([
  "organization.errors.uncertain",
  "organization.errors.canceled",
  "organization.errors.model",
  "organization.errors.deadline",
  "maintenance.errors.budget",
  "organization.errors.failed"
])("does not teach a content lesson from %s", (error) => {
  expect(isNonReviewableValidation({ ...rejected, error }, { repairs: 1 })).toBe(false);
});
it("preserves uncertain provider ownership even with a prior negative verdict", () => {
  expect(isNonReviewableValidation({ ...rejected, callPending: true }, { repairs: 1 })).toBe(false);
});
