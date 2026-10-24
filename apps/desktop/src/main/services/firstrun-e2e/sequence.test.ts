import { aiClassIds } from "@app/domain";
import { describe, expect, it } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { channelClass } from "../topics-e2e/ipc-counters.js";
import { firstRunClassTests, hybridSetupSequence, invokedSetupChannels } from "./sequence.js";
import { SequencedIpc } from "./sequenced-ipc.js";

describe("the IPC sequence of the first run in Hybrid", () => {
  it("is the onboarding's second step in order: languages, writer, models, preset, tests", () => {
    const steps = hybridSetupSequence("codex").map((call) => call.step);
    expect(steps).toEqual([
      "languages",
      "writer",
      "writer",
      "writer",
      "writer",
      "models",
      "models",
      "preset",
      "tests",
      "tests",
      "tests",
      "tests",
      "tests"
    ]);
    expect(invokedSetupChannels("codex")).toEqual([
      ipcChannels.appSettingsUpdate,
      ipcChannels.aiProvidersSave,
      ipcChannels.aiProfilesCreate,
      ipcChannels.aiProfilesUpdate,
      ipcChannels.localModelsList,
      ipcChannels.localModelsDownload,
      ipcChannels.aiApplyPreset,
      ...firstRunClassTests.map(() => ipcChannels.aiTestClassRoute)
    ]);
  });

  it("signs in to the writer before anything else of the mode, and applies the preset before its tests", () => {
    const channels = hybridSetupSequence("codex").map((call) => call.channel);
    const index = (channel: string) => channels.indexOf(channel);
    expect(index(ipcChannels.aiProvidersSave)).toBeLessThan(index(ipcChannels.localModelsDownload));
    expect(index(ipcChannels.localModelsDownload)).toBeLessThan(index(ipcChannels.aiApplyPreset));
    expect(index(ipcChannels.aiApplyPreset)).toBeLessThan(index(ipcChannels.aiTestClassRoute));
  });

  it("marks the browser sign-in as the one call the harness substitutes, and only for Codex", () => {
    const codex = hybridSetupSequence("codex");
    const connect = codex.find((call) => call.channel === ipcChannels.aiOpenAiCodexConnect);
    expect(connect).toMatchObject({ step: "writer", substitutedByHarness: true });
    expect(codex.filter((call) => call.substitutedByHarness)).toHaveLength(1);
    expect(invokedSetupChannels("codex")).not.toContain(ipcChannels.aiOpenAiCodexConnect);
    const remote = hybridSetupSequence("remote");
    expect(remote.some((call) => call.channel === ipcChannels.aiOpenAiCodexConnect)).toBe(false);
    expect(remote.some((call) => call.substitutedByHarness)).toBe(false);
  });

  it("tests every class that has a route when the preset is applied, which is all but decide", () => {
    expect([...firstRunClassTests]).toEqual([
      "embed",
      "write-fast",
      "write-quality",
      "answer",
      "judge"
    ]);
    const expected = [...aiClassIds.filter((id) => id !== "decide"), "judge"].toSorted();
    expect([...firstRunClassTests].toSorted()).toEqual(expected);
  });

  it("sits in the setup phase of the counters: every call but the languages is a Settings call", () => {
    const classes = invokedSetupChannels("codex").map((channel) => channelClass(channel));
    expect(classes.every((klass) => klass === "settings")).toBe(true);
  });
});

describe("the ordered IPC recorder", () => {
  it("keeps the order of the calls by phase, on top of the counters", async () => {
    const ipc = new SequencedIpc();
    ipc.main.handle("app:ai:profiles:create", async () => "created");
    ipc.main.handle("app:topics:status", async () => "status");
    ipc.phase("setup");
    await ipc.invoke("app:ai:profiles:create");
    ipc.phase("user");
    await ipc.invoke("app:topics:status");
    await ipc.invoke("app:topics:status");
    expect(ipc.channels("setup")).toEqual(["app:ai:profiles:create"]);
    expect(ipc.channels("user")).toEqual(["app:topics:status", "app:topics:status"]);
    expect(ipc.log.map((call) => call.phase)).toEqual(["setup", "user", "user"]);
    expect(ipc.calls("setup", "settings")).toBe(1);
    expect(ipc.calls("user", "settings")).toBe(0);
    await expect(ipc.invoke("app:nowhere")).rejects.toThrow("No handler");
  });
});
