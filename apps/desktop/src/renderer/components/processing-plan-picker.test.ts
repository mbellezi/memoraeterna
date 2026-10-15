import { describe, expect, it } from "vitest";
import { ProcessingPlanRequestSchema, resolveProcessingPlan } from "@app/domain";

import {
  defaultProcessingPlan,
  toProcessingPlanRequest,
  processingPlanReady
} from "./ProcessingPlanPicker";

describe("processing plan picker", () => {
  it("offers full knowledge without the retired legacy wiki stage (F2 D14)", () => {
    const plan = defaultProcessingPlan("full_knowledge");
    expect(resolveProcessingPlan(plan).effectiveStages).not.toContain("organizeKnowledge");
    expect(plan).not.toHaveProperty("organization");
    expect(plan).not.toHaveProperty("integrateWiki");
    expect(processingPlanReady(plan)).toBe(true);
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
    expect(() =>
      ProcessingPlanRequestSchema.parse(toProcessingPlanRequest(resolved))
    ).not.toThrow();
  });
});
