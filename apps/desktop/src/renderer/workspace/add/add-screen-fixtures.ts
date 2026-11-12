import type { ScreenFixtureSet } from "../surfaces";

/**
 * What the Add surfaces' screen modules answer from the fake `window.app`: whether a model that can
 * write is ready (the mode default follows it). Only the screen modules import this file.
 */

const profileId = "00000000-0000-4000-8000-0000000000a1";
const providerId = "00000000-0000-4000-8000-0000000000b1";
const writerTasks = ["summarization", "atomic-note-generation", "knowledge-graph-generation"];

export function writerFixtures(ready: boolean): ScreenFixtureSet {
  return {
    "ai.listProfiles": ready
      ? [
          {
            id: profileId,
            isDefault: true,
            status: "active",
            providerConfigId: providerId,
            localModelId: null,
            modelId: "writer",
            capabilities: [
              "summarization",
              "atomic-note-generation",
              "knowledge-graph-generation",
              "structured-output"
            ]
          }
        ]
      : [],
    "ai.listProfileTasks": ready ? writerTasks.map((task) => ({ profileId, task })) : [],
    "ai.listTaskRoutes": [],
    "ai.listProviders": [{ id: providerId, secretConfigured: true }],
    "localModels.statuses": []
  };
}
