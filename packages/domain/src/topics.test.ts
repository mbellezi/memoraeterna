import { describe, expect, it } from "vitest";

import * as topics from "./topics.js";

describe("topic vocabulary", () => {
  it("has no switch, shadow tree or topic modes (D2)", () => {
    expect(topics.topicTreeStatuses).toEqual(["active", "retired"]);
    expect(topics.TopicTreeStatusSchema.safeParse("shadow").success).toBe(false);
    expect(topics.topicChangeSetOrigins).not.toContain("switch");
    expect(topics.TopicChangeSetOriginSchema.safeParse("switch").success).toBe(false);
    expect(topics.topicsPhases).toEqual(["building", "active"]);
    for (const phase of ["legacy", "ready_to_switch", "switching"]) {
      expect(topics.TopicsPhaseSchema.safeParse(phase).success).toBe(false);
    }
    expect(Object.keys(topics)).not.toContain("topicGateModes");
    expect(Object.keys(topics)).not.toContain("TopicGateModeSchema");
  });
});
