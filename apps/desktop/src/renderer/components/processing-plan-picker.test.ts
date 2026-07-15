import { describe, expect, it } from "vitest";
import { ProcessingPlanRequestSchema, resolveProcessingPlan } from "@app/domain";

import { defaultProcessingPlan, toProcessingPlanRequest } from "./ProcessingPlanPicker";

describe("processing plan picker", () => {
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
