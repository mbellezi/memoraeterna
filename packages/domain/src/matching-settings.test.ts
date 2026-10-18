import { describe, expect, it } from "vitest";
import {
  AtomicNoteMatchingSettingsSchema,
  CanonicalMatchingSettingsSchema
} from "./matching-settings.js";
import { retiredNoteMatchingSettingKeys } from "./matching-settings-migration.js";

describe("advanced matching settings", () => {
  it("loads bounded conservative defaults for existing installations", () => {
    expect(AtomicNoteMatchingSettingsSchema.parse({})).toEqual({ maxRerankOutputTokens: 4096 });
    expect(CanonicalMatchingSettingsSchema.parse({})).toMatchObject({
      entityCandidateLimit: 3,
      confirmationBatchSize: 12
    });
  });
  it("rejects unbounded requests and unknown fields", () => {
    for (const input of [
      { maxRerankOutputTokens: -1 },
      { maxRerankOutputTokens: 16385 },
      { unknown: true }
    ]) {
      expect(AtomicNoteMatchingSettingsSchema.safeParse(input).success).toBe(false);
    }
    expect(CanonicalMatchingSettingsSchema.safeParse({ confirmationBatchSize: 13 }).success).toBe(
      false
    );
  });
  it("refuses every note setting that stopped deciding anything, so a stale writer fails loudly", () => {
    for (const key of retiredNoteMatchingSettingKeys) {
      expect(AtomicNoteMatchingSettingsSchema.safeParse({ [key]: 1 }).success, key).toBe(false);
    }
  });
});
