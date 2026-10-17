import { describe, expect, it } from "vitest";

import {
  aiClassIds,
  aiPresetIds,
  aiWriteClassIds,
  generativeDecideOperations,
  largeLocalWriterMinimumMemoryBytes,
  machineRunsMlx,
  planAiPreset,
  presetCatalogIds,
  type AiPresetId,
  type PresetMachine
} from "./ai-presets.js";
import { noteDeciderModes } from "./relations-config.js";

const gib = 1024 ** 3;
const mac = (memoryGiB: number): PresetMachine => ({
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: memoryGiB * gib
});
const intel: PresetMachine = { platform: "darwin", arch: "x64", totalMemoryBytes: 32 * gib };
const windows: PresetMachine = { platform: "win32", arch: "x64", totalMemoryBytes: 16 * gib };

function plan(preset: AiPresetId, machine: PresetMachine) {
  const result = planAiPreset(preset, machine);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.plan;
}

describe("the AI presets", () => {
  it("names the five classes, the three presets and the three note decider modes", () => {
    expect(aiClassIds).toEqual(["embed", "decide", "write-fast", "write-quality", "answer"]);
    expect(aiPresetIds).toEqual(["local", "hybrid", "cloud"]);
    expect(noteDeciderModes).toEqual(["ranker", "ranker-else-generative", "generative"]);
    expect(generativeDecideOperations).toEqual([
      "note_matching_reranking",
      "note_matching_reranking_repair",
      "source_relation_matching",
      "relation_escalation"
    ]);
  });

  it("detects MLX only on macOS arm64", () => {
    expect(machineRunsMlx(mac(16))).toBe(true);
    expect(machineRunsMlx(intel)).toBe(false);
    expect(machineRunsMlx(windows)).toBe(false);
  });

  it("refuses Local off Apple silicon and leaves Hybrid and Cloud available", () => {
    for (const machine of [intel, windows]) {
      expect(planAiPreset("local", machine)).toEqual({
        ok: false,
        reason: "local_requires_apple_silicon"
      });
      expect(planAiPreset("hybrid", machine).ok).toBe(true);
      expect(planAiPreset("cloud", machine).ok).toBe(true);
    }
    expect(planAiPreset("local", mac(8)).ok).toBe(true);
  });

  it("plans one local writer for every write class, sized by memory (C6)", () => {
    const large = plan("local", mac(24));
    const small = plan("local", mac(16));
    for (const classId of aiWriteClassIds) {
      expect(large.classes[classId]).toEqual({
        kind: "local-model",
        catalogId: presetCatalogIds.writerLarge
      });
      expect(small.classes[classId]).toEqual({
        kind: "local-model",
        catalogId: presetCatalogIds.writerSmall
      });
    }
    expect(large.generativeDecide).toEqual(large.classes["write-fast"]);
    expect(small.generativeDecide).toEqual(small.classes["write-fast"]);
    expect(
      plan("local", { ...mac(24), totalMemoryBytes: largeLocalWriterMinimumMemoryBytes - 1 })
    ).toMatchObject({ classes: { answer: { catalogId: presetCatalogIds.writerSmall } } });
  });

  it("plans the local embedder, the MLX ranker and the ranker-only decider mode for Local", () => {
    expect(plan("local", mac(16))).toMatchObject({
      preset: "local",
      classes: {
        embed: { kind: "local-model", catalogId: presetCatalogIds.embedding },
        decide: { kind: "local-model", catalogId: presetCatalogIds.rankerMlx }
      },
      deciderMode: "ranker"
    });
  });

  it("plans Hybrid with local embedding and ranking and the remote writer for the rest", () => {
    const hybrid = plan("hybrid", mac(16));
    expect(hybrid.classes.embed).toEqual({
      kind: "local-model",
      catalogId: presetCatalogIds.embedding
    });
    expect(hybrid.classes.decide).toEqual({
      kind: "local-model",
      catalogId: presetCatalogIds.rankerMlx
    });
    for (const classId of aiWriteClassIds)
      expect(hybrid.classes[classId]).toEqual({ kind: "remote-writer" });
    expect(hybrid.generativeDecide).toEqual({ kind: "remote-writer" });
    expect(hybrid.deciderMode).toBe("ranker");
  });

  it("uses the GGUF ranker where MLX does not run", () => {
    expect(plan("hybrid", intel).classes.decide).toEqual({
      kind: "local-model",
      catalogId: presetCatalogIds.rankerGguf
    });
  });

  it("plans Cloud with the provider's embedding, the installed ranker and the generative fallback", () => {
    const cloud = plan("cloud", mac(16));
    expect(cloud.classes.embed).toEqual({
      kind: "provider-embedding",
      fallbackCatalogId: presetCatalogIds.embedding
    });
    expect(cloud.classes.decide).toEqual({ kind: "installed-ranker" });
    expect(cloud.generativeDecide).toEqual({ kind: "remote-writer" });
    expect(cloud.deciderMode).toBe("ranker-else-generative");
  });

  it("never plans a generative model on class:decide in any preset", () => {
    for (const preset of aiPresetIds)
      for (const machine of [mac(8), mac(64), intel, windows]) {
        const result = planAiPreset(preset, machine);
        if (!result.ok) continue;
        const decide = result.plan.classes.decide;
        expect(["local-model", "installed-ranker"]).toContain(decide.kind);
        if (decide.kind === "local-model")
          expect([presetCatalogIds.rankerMlx, presetCatalogIds.rankerGguf]).toContain(
            decide.catalogId
          );
      }
  });

  it("plans the generative decider for every preset on every machine it runs on", () => {
    for (const preset of aiPresetIds)
      for (const machine of [mac(8), mac(64), intel, windows]) {
        const result = planAiPreset(preset, machine);
        if (!result.ok) continue;
        expect(result.plan.generativeDecide).toBeDefined();
        expect(["local-model", "remote-writer"]).toContain(result.plan.generativeDecide.kind);
      }
  });
});
