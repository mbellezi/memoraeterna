import { describe, expect, it } from "vitest";
import { AtomicNoteMatchingSettingsSchema, CanonicalMatchingSettingsSchema } from "./matching-settings.js";

describe("advanced matching settings", () => {
  it("loads bounded conservative defaults for existing installations", () => {
    expect(AtomicNoteMatchingSettingsSchema.parse({})).toMatchObject({ requireReranking: true, includeWeakTypes: false, fusedCandidateLimit: 30, minRerankScore: 0.65 });
    expect(CanonicalMatchingSettingsSchema.parse({})).toMatchObject({ entityCandidateLimit: 3, confirmationBatchSize: 12 });
  });
  it("rejects unbounded requests, unknown fields and zero-weight groups", () => {
    for (const input of [{ fusedCandidateLimit: 101 }, { maxRerankOutputTokens: -1 }, { unknown: true }, { textAndMetadata: { text: 0, metadata: 0 } }]) {
      expect(AtomicNoteMatchingSettingsSchema.safeParse(input).success).toBe(false);
    }
    expect(CanonicalMatchingSettingsSchema.safeParse({ confirmationBatchSize: 13 }).success).toBe(false);
  });
});
