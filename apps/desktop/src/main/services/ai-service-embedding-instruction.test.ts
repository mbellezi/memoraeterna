import { describe, expect, it } from "vitest";

import { withEmbeddingInputInstruction } from "./ai-service.js";

describe("embedding input instructions", () => {
  it("adds the retrieval instruction only to Qwen3 queries", () => {
    const query = withEmbeddingInputInstruction(
      "Dean Radin",
      "Qwen/Qwen3-Embedding-0.6B-GGUF",
      "Qwen/Qwen3-Embedding-0.6B-GGUF",
      "query"
    );

    expect(query).toContain("Instruct: Retrieve sources");
    expect(query).toContain("Query: Dean Radin");
    expect(withEmbeddingInputInstruction(
      "Dean Radin",
      "Qwen/Qwen3-Embedding-0.6B-GGUF",
      null,
      "document"
    )).toBe("Dean Radin");
  });

  it("does not apply a Qwen-specific format to other embedding models", () => {
    expect(withEmbeddingInputInstruction("Dean Radin", "bge-m3", null, "query"))
      .toBe("Dean Radin");
  });
});
