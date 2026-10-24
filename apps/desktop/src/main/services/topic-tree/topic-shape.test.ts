import { defaultKnowledgeControls } from "@app/domain";
import { defaultTopicTreeConfig, topicTreeConfigForPreset } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import { structuralConfigHash } from "./topic-tree-service.js";

// Behaviour-neutral at the default (F4 D1, D13): wiring the tree shape control must not make an
// existing tree look as if its configuration changed.
describe("the tree shape control and the tree's structural configuration", () => {
  it("builds the default shape, Balanced, with the engine's own configuration hash", () => {
    expect(defaultKnowledgeControls.treeShape).toBe("balanced");
    expect(structuralConfigHash(topicTreeConfigForPreset(defaultKnowledgeControls.treeShape))).toBe(
      structuralConfigHash(defaultTopicTreeConfig)
    );
  });

  it("gives each other shape a configuration of its own, so a change is a rebuild", () => {
    const hashes = (["broad", "balanced", "deep"] as const).map((shape) =>
      structuralConfigHash(topicTreeConfigForPreset(shape))
    );
    expect(new Set(hashes).size).toBe(3);
  });
});
