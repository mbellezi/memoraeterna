import { describe, expect, it } from "vitest";

import {
  defaultKnowledgeGraphBatching,
  knowledgeGraphBatchFor,
  knowledgeGraphBatchingSchema,
  pinnedKnowledgeGraphBatch
} from "./knowledge-graph-batching.js";

describe("knowledge-graph batches by writer locality (F3 D36)", () => {
  it("holds the values X7 confirmed: 3,500 characters with 12/12 caps on both sides (Q8)", () => {
    expect(defaultKnowledgeGraphBatching).toEqual({
      remote: { maxInputCharacters: 3_500, maxEntities: 12, maxRelations: 12 },
      local: { maxInputCharacters: 3_500, maxEntities: 12, maxRelations: 12 }
    });
    expect(pinnedKnowledgeGraphBatch).toEqual(defaultKnowledgeGraphBatching.local);
  });

  it("chooses the batch by locality", () => {
    expect(knowledgeGraphBatchFor("remote", { pinned: false })).toBe(
      defaultKnowledgeGraphBatching.remote
    );
    expect(knowledgeGraphBatchFor("local", { pinned: false })).toBe(
      defaultKnowledgeGraphBatching.local
    );
  });

  it("takes the small batch when nothing is known about the writer", () => {
    expect(knowledgeGraphBatchFor(null, { pinned: false })).toBe(
      defaultKnowledgeGraphBatching.local
    );
  });

  it("pins every writer to the recorded batch, a remote one included", () => {
    for (const locality of ["remote", "local", null] as const)
      expect(knowledgeGraphBatchFor(locality, { pinned: true })).toBe(pinnedKnowledgeGraphBatch);
  });

  it("validates a configuration", () => {
    expect(() =>
      knowledgeGraphBatchingSchema.parse({
        remote: { maxInputCharacters: 500, maxEntities: 24, maxRelations: 24 },
        local: defaultKnowledgeGraphBatching.local
      })
    ).toThrow();
    expect(() =>
      knowledgeGraphBatchingSchema.parse({ remote: defaultKnowledgeGraphBatching.remote })
    ).toThrow();
  });
});
