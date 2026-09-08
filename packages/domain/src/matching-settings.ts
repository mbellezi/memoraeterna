import { z } from "zod";

const weight = z.number().min(0).max(1);
const weights = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()
  .refine((values) => Object.values(values).some((value) => typeof value === "number" && value > 0), "At least one weight must be positive");

export const AtomicNoteMatchingSettingsSchema = z.object({
  textCandidateLimit: z.number().int().min(1).max(200).default(30),
  vectorCandidateLimit: z.number().int().min(1).max(200).default(30),
  graphCandidateLimit: z.number().int().min(0).max(200).default(20),
  fusedCandidateLimit: z.number().int().min(1).max(100).default(30),
  minimumGraphOnlyCandidates: z.number().int().min(0).max(100).default(5),
  reciprocalRankConstant: z.number().int().min(1).max(200).default(60),
  withEmbeddingAndGraph: weights({ vector: weight.default(0.45), text: weight.default(0.25), graph: weight.default(0.2), metadata: weight.default(0.1) }).prefault({}),
  withEmbedding: weights({ vector: weight.default(0.55), text: weight.default(0.3), metadata: weight.default(0.15) }).prefault({}),
  withGraph: weights({ text: weight.default(0.55), graph: weight.default(0.3), metadata: weight.default(0.15) }).prefault({}),
  textAndMetadata: weights({ text: weight.default(0.7), metadata: weight.default(0.3) }).prefault({}),
  rerankerWeight: weight.default(0.4),
  minRerankScore: weight.default(0.65),
  requireReranking: z.boolean().default(true),
  includeWeakTypes: z.boolean().default(false),
  maxRelationsPerNote: z.number().int().min(1).max(100).default(10),
  maxRerankOutputTokens: z.number().int().min(512).max(16384).default(4096)
}).strict();
export type AtomicNoteMatchingSettings = z.infer<typeof AtomicNoteMatchingSettingsSchema>;
export const defaultAtomicNoteMatchingSettings = AtomicNoteMatchingSettingsSchema.parse({});

export const CanonicalMatchingSettingsSchema = z.object({
  relationTypeCandidateLimit: z.number().int().min(1).max(20).default(3),
  entityCandidateLimit: z.number().int().min(1).max(20).default(3),
  confirmationBatchSize: z.number().int().min(1).max(12).default(12),
  confirmationMaxCharacters: z.number().int().min(2000).max(24000).default(12000)
}).strict();
export type CanonicalMatchingSettings = z.infer<typeof CanonicalMatchingSettingsSchema>;
export const defaultCanonicalMatchingSettings = CanonicalMatchingSettingsSchema.parse({});
