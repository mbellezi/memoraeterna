import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { defaultPromptPin, withPromptPin } from "./prompt-runtime.js";

const config = vi.hoisted(() => ({ getDefaultTask: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  createAiConfigRepository: () => config
}));

const {
  createRelationExplanationWriterResolver,
  memoizeRelationExplanationWriter,
  relationExplanationPromptRevision
} = await import("./relation-explanation-writer.js");

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

describe("the provider in the identity of the prompt", () => {
  const revision = (
    provider?: string,
    edit?: (pin: ReturnType<typeof defaultPromptPin>) => void
  ) => {
    const pin = defaultPromptPin();
    edit?.(pin);
    return withPromptPin(pin, () => relationExplanationPromptRevision(provider));
  };

  it("includes the instruction the AI service adds to a Codex call, and only for Codex", () => {
    const plain = revision();
    const codex = revision("openai-codex");
    expect(codex).toMatch(/^[a-f0-9]{64}$/);
    expect(codex).not.toBe(plain);
    // An owner edit to the Codex instruction changes what the Codex writer sees, so the key.
    const edit = (pin: ReturnType<typeof defaultPromptPin>) => {
      const entry = pin.entries.find(
        (candidate) => candidate.id === "shared.codex_adapter_instruction"
      )!;
      entry.fields = Object.fromEntries(
        Object.entries(entry.fields).map(([field, text]) => [field, `${text} Be brief.`])
      );
    };
    expect(revision("openai-codex", edit)).not.toBe(codex);
    // Another provider does not read it.
    expect(revision("openai-compatible", edit)).toBe(revision("openai-compatible"));
    expect(revision("local-mlx", edit)).toBe(revision("local-mlx"));
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

describe("the writer a Note page asks for on every read", () => {
  const writerA = { promptRevision: "prompt-3", model: "model-a" };
  const writerB = { promptRevision: "prompt-3", model: "model-b" };
  const pool = {};

  function setup() {
    const state = { pool: pool as object | null, configuration: 1, prompts: 1 };
    let current: typeof writerA | null = writerA;
    const resolve = vi.fn(async () => current);
    const memoized = memoizeRelationExplanationWriter(resolve, () => ({ ...state }));
    return {
      state,
      resolve,
      memoized,
      writes: (next: typeof writerA | null) => {
        current = next;
      }
    };
  }

  it("is resolved once while the configuration, the prompts and the database stay as they are", async () => {
    const { memoized, resolve } = setup();
    for (let read = 0; read < 50; read += 1) expect(await memoized()).toEqual(writerA);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("is resolved again when the AI configuration changes, so another route is another writer", async () => {
    const { memoized, resolve, state, writes } = setup();
    expect(await memoized()).toEqual(writerA);
    writes(writerB);
    // Nothing changed yet: the page still judges by the writer it knows.
    expect(await memoized()).toEqual(writerA);
    state.configuration += 1;
    expect(await memoized()).toEqual(writerB);
    expect(resolve).toHaveBeenCalledTimes(2);
    writes(null);
    state.configuration += 1;
    expect(await memoized()).toBeNull();
  });

  it("is resolved again when the owner edits a prompt or another database opens", async () => {
    const { memoized, resolve, state } = setup();
    await memoized();
    state.prompts += 1;
    await memoized();
    expect(resolve).toHaveBeenCalledTimes(2);
    state.pool = {};
    await memoized();
    expect(resolve).toHaveBeenCalledTimes(3);
    // Back to a database it knew is still another resolution: nothing is kept per database.
    state.pool = pool;
    await memoized();
    expect(resolve).toHaveBeenCalledTimes(4);
    state.pool = null;
    await memoized();
    await memoized();
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("shares one resolution between reads that overlap, and keeps no failure", async () => {
    const { memoized, resolve } = setup();
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    resolve.mockImplementationOnce(async () => {
      await gate;
      return writerA;
    });
    const reads = [memoized(), memoized(), memoized()];
    release();
    expect(await Promise.all(reads)).toEqual([writerA, writerA, writerA]);
    expect(resolve).toHaveBeenCalledTimes(1);

    const failing = setup();
    failing.resolve.mockRejectedValueOnce(new Error("route unavailable"));
    await expect(failing.memoized()).rejects.toThrow("route unavailable");
    // The next read tries again.
    expect(await failing.memoized()).toEqual(writerA);
    expect(failing.resolve).toHaveBeenCalledTimes(2);
  });
});
