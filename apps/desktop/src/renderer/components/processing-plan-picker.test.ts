import { describe, expect, it } from "vitest";
import { ProcessingPlanRequestSchema, resolveProcessingPlan } from "@app/domain";

import { defaultProcessingPlan, toProcessingPlanRequest, processingPlanReady } from "./ProcessingPlanPicker";

describe("processing plan picker", () => {
  it('admits automatic Wiki processing without a manual title or renderer-selected policy', () => {
    const plan = defaultProcessingPlan('full_knowledge');
    expect(resolveProcessingPlan(plan).effectiveStages).toContain('organizeKnowledge');
    expect(plan.organization).toBeUndefined();
    expect(processingPlanReady(plan)).toBe(true);
    expect(resolveProcessingPlan(defaultProcessingPlan('import_only')).effectiveStages).not.toContain('organizeKnowledge');
  });
  it("keeps resolved-only fields out of renderer state and IPC requests", () => {
    const resolved = resolveProcessingPlan({
      ...defaultProcessingPlan(),
      preset: "custom",
      requestedStages: ["atomicNotes"]
    });

    expect(toProcessingPlanRequest(resolved)).toEqual({
      preset: "custom",
      requestedStages: ["atomicNotes"],
      scope: "source_only",
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    });
    expect(() => ProcessingPlanRequestSchema.parse(toProcessingPlanRequest(resolved))).not.toThrow();
  });
});
