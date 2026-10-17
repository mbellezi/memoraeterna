import { describe, expect, it, vi } from "vitest";

import { JobSupervisor, type JobSupervisorOptions } from "./job-supervisor.js";
import type { EmbeddingBatchGenerator } from "./embedding-stage.js";

const context = {
  jobId: "job",
  ingestionRunId: "run",
  sourceItemId: "source",
  documentId: "document",
  stage: "embedding",
  embeddingInputType: "document" as const
};
const identity = { provider: "local-gguf", model: "embed", runtime: "local", spaceKey: "space" };

/** The generator the embedding stage of a supervisor with these options would use. */
function generatorOf(options: Partial<JobSupervisorOptions>): EmbeddingBatchGenerator | null {
  const supervisor = new JobSupervisor({ getPool: () => null, ...options });
  return (
    supervisor as unknown as { embeddingBatchGenerator(): EmbeddingBatchGenerator | null }
  ).embeddingBatchGenerator();
}

describe("how the job supervisor embeds a batch of chunks (F3 D37)", () => {
  it("has no generator without an embedding model wired", () => {
    expect(generatorOf({})).toBeNull();
  });

  it("sends the whole batch to the batch generator, with the chunk ids", async () => {
    const many = vi.fn<NonNullable<JobSupervisorOptions["generateEmbeddings"]>>(async (texts) => ({
      ...identity,
      embeddings: texts.map((text) => [text.length])
    }));
    const single = vi.fn();
    const generate = generatorOf({ generateEmbeddings: many, generateEmbedding: single })!;
    const batch = await generate(["a", "bb"], new AbortController().signal, {
      ...context,
      chunkIds: ["c1", "c2"]
    });
    expect(batch).toMatchObject({ embeddings: [[1], [2]], spaceKey: "space" });
    expect(many).toHaveBeenCalledOnce();
    expect(many.mock.calls[0]![2]).toMatchObject({ chunkIds: ["c1", "c2"], stage: "embedding" });
    expect(single).not.toHaveBeenCalled();
  });

  it("falls back to one call per text for a supervisor wired with the single form", async () => {
    const single = vi.fn<NonNullable<JobSupervisorOptions["generateEmbedding"]>>(async (text) => ({
      ...identity,
      embedding: [text.length]
    }));
    const generate = generatorOf({ generateEmbedding: single })!;
    const batch = await generate(["a", "bb", "ccc"], new AbortController().signal, {
      ...context,
      chunkIds: ["c1", "c2", "c3"]
    });
    expect(batch).toMatchObject({ embeddings: [[1], [2], [3]], model: "embed" });
    expect(single.mock.calls.map(([text, , call]) => [text, call?.chunkId])).toEqual([
      ["a", "c1"],
      ["bb", "c2"],
      ["ccc", "c3"]
    ]);
    // The batch's chunk ids are not part of a single call's context.
    expect(single.mock.calls[0]![2]).not.toHaveProperty("chunkIds");
  });

  it("reports no model when a single call finds none, and refuses a space that changed", async () => {
    const none = generatorOf({ generateEmbedding: async () => null })!;
    expect(await none(["a"], new AbortController().signal, context)).toBeNull();
    let calls = 0;
    const moving = generatorOf({
      generateEmbedding: async () => ({
        ...identity,
        embedding: [1],
        spaceKey: calls++ === 0 ? "space-a" : "space-b"
      })
    })!;
    await expect(moving(["a", "b"], new AbortController().signal, context)).rejects.toThrow(
      "errors.sourceRelations.configurationChanged"
    );
  });
});
