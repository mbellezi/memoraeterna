import { describe, expect, it } from "vitest";

import {
  defaultIdentityGrouping,
  defaultKnowledgeGraphBatching,
  identityGroupFor,
  identityGroupingSchema,
  knowledgeGraphBatchFor,
  knowledgeGraphBatchingSchema,
  maxIdentityGroupRows,
  pinnedKnowledgeGraphBatch
} from "./knowledge-graph-batching.js";
import { defaultCanonicalMatchingSettings } from "./matching-settings.js";

describe("identity groups by writer locality (F4 D20, Q4)", () => {
  it("holds 24 rows / 24,000 characters for remote writers and 12 / 12,000 for local ones", () => {
    expect(defaultIdentityGrouping).toEqual({
      remote: { maxRows: 24, maxCharacters: 24_000 },
      local: { maxRows: 12, maxCharacters: 12_000 }
    });
    expect(maxIdentityGroupRows).toBe(24);
  });

  it("leaves remote groups at 24 / 24,000 whatever is stored, a stored 12 included", () => {
    for (const stored of [
      defaultCanonicalMatchingSettings,
      { confirmationBatchSize: 12, confirmationMaxCharacters: 12_000 },
      { confirmationBatchSize: 3, confirmationMaxCharacters: 2_000 }
    ])
      expect(identityGroupFor("remote", stored)).toEqual({ maxRows: 24, maxCharacters: 24_000 });
  });

  it("sizes local and unknown writers by the stored values, never above 12 / 12,000", () => {
    for (const locality of ["local", null] as const) {
      expect(identityGroupFor(locality, defaultCanonicalMatchingSettings)).toEqual({
        maxRows: 12,
        maxCharacters: 12_000
      });
      expect(
        identityGroupFor(locality, { confirmationBatchSize: 12, confirmationMaxCharacters: 24_000 })
      ).toEqual({ maxRows: 12, maxCharacters: 12_000 });
      expect(
        identityGroupFor(locality, { confirmationBatchSize: 8, confirmationMaxCharacters: 6_000 })
      ).toEqual({ maxRows: 8, maxCharacters: 6_000 });
    }
  });

  it("validates a grouping: no group above the confirmation contract's 24 rows", () => {
    expect(() =>
      identityGroupingSchema.parse({
        remote: { maxRows: 25, maxCharacters: 24_000 },
        local: defaultIdentityGrouping.local
      })
    ).toThrow();
    expect(() =>
      identityGroupingSchema.parse({
        remote: defaultIdentityGrouping.remote,
        local: { maxRows: 12, maxCharacters: 30_000 }
      })
    ).toThrow();
  });
});

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
