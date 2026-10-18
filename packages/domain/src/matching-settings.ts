import { z } from "zod";

/**
 * The note-matching settings that still decide something. Since relations v2 (F3 D17, D46) the
 * candidate lists, the decider's calibration and the bands live in typed configuration
 * (`relations-config.ts`); the one value a person still sets is the generative decider's output
 * budget. The settings that used to shape the old blended score and its shortlist left stored
 * settings through the matching settings v2 migration (`matching-settings-migration.ts`).
 */
export const AtomicNoteMatchingSettingsSchema = z
  .object({
    maxRerankOutputTokens: z.number().int().min(512).max(16384).default(4096)
  })
  .strict();
export type AtomicNoteMatchingSettings = z.infer<typeof AtomicNoteMatchingSettingsSchema>;
export const defaultAtomicNoteMatchingSettings = AtomicNoteMatchingSettingsSchema.parse({});

export const CanonicalMatchingSettingsSchema = z
  .object({
    relationTypeCandidateLimit: z.number().int().min(1).max(20).default(3),
    entityCandidateLimit: z.number().int().min(1).max(20).default(3),
    confirmationBatchSize: z.number().int().min(1).max(12).default(12),
    confirmationMaxCharacters: z.number().int().min(2000).max(24000).default(12000)
  })
  .strict();
export type CanonicalMatchingSettings = z.infer<typeof CanonicalMatchingSettingsSchema>;
export const defaultCanonicalMatchingSettings = CanonicalMatchingSettingsSchema.parse({});
