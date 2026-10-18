import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { defaultPromptPin, withPromptPin } from "./prompt-runtime.js";

const config = vi.hoisted(() => ({ getDefaultTask: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  createAiConfigRepository: () => config
}));

const { createRelationExplanationWriterResolver, relationExplanationPromptRevision } =
  await import("./relation-explanation-writer.js");

const selection = {
  provider: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null
};

describe("the identity of the prompt an explanation is written with", () => {
  it("is stable, and changes when the owner edits the prompt or the shipped revision changes", () => {
    const shipped = withPromptPin(defaultPromptPin(), relationExplanationPromptRevision);
    expect(shipped).toMatch(/^[a-f0-9]{64}$/);
    expect(withPromptPin(defaultPromptPin(), relationExplanationPromptRevision)).toBe(shipped);
    const edited = defaultPromptPin();
    const entry = edited.entries.find((candidate) => candidate.id === "relations.explain")!;
    entry.fields = { ...entry.fields, body: `${entry.fields.body} Be brief.` };
    expect(withPromptPin(edited, relationExplanationPromptRevision)).not.toBe(shipped);
    // Another revision of the same text is another prompt: an owner's revision replaces the shipped one.
    const revised = defaultPromptPin();
    revised.entries.find((candidate) => candidate.id === "relations.explain")!.revisions = [
      { id: "relations.explain", revisionId: "2a8d3c7e-0000-4000-8000-000000000001" }
    ];
    expect(withPromptPin(revised, relationExplanationPromptRevision)).not.toBe(shipped);
    // The repair prompt is part of what writes an explanation.
    const repaired = defaultPromptPin();
    const repair = repaired.entries.find(
      (candidate) => candidate.id === "relations.explain.repair"
    )!;
    repair.fields = { ...repair.fields, body: `${repair.fields.body} Again.` };
    expect(withPromptPin(repaired, relationExplanationPromptRevision)).not.toBe(shipped);
  });
});

describe("who writes an explanation now", () => {
  const pool = {} as PgPool;

  it("is the model of the operation's route, then the write-fast class, then the text route", async () => {
    config.getDefaultTask.mockResolvedValue(selection);
    const writer = await createRelationExplanationWriterResolver(() => pool)();
    expect(config.getDefaultTask).toHaveBeenCalledWith("text-generation", undefined, [
      "op:relation_explanation",
      "class:write-fast",
      "text-generation"
    ]);
    expect(JSON.parse(writer!.model)).toEqual([
      "openai-codex",
      "gpt-test",
      "remote",
      null,
      null,
      null
    ]);
    expect(writer!.promptRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tells a local model by its artifact, and another model apart", async () => {
    config.getDefaultTask.mockResolvedValue({
      ...selection,
      provider: "local-mlx",
      runtime: "local",
      repository: "mlx-community/Qwen3-4B",
      revision: "abc",
      quantization: "4bit"
    });
    const local = await createRelationExplanationWriterResolver(() => pool)();
    config.getDefaultTask.mockResolvedValue({ ...selection, modelId: "gpt-other" });
    const other = await createRelationExplanationWriterResolver(() => pool)();
    expect(JSON.parse(local!.model)).toContain("mlx-community/Qwen3-4B");
    expect(other!.model).not.toBe(local!.model);
  });

  it("is null without a writer model or without a database", async () => {
    config.getDefaultTask.mockResolvedValue(null);
    expect(await createRelationExplanationWriterResolver(() => pool)()).toBeNull();
    expect(await createRelationExplanationWriterResolver(() => null)()).toBeNull();
  });
});
