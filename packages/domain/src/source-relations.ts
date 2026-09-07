import { z } from "zod";
import { AtomicNoteRelationStatusSchema, AtomicNoteRelationTypeSchema } from "./knowledge.js";

export const SourceRelationSettingsSchema = z.object({
  maxCandidates: z.number().int().min(1).max(200).default(40),
  maxPairs: z.number().int().min(1).max(50).default(8),
  maxRelations: z.number().int().min(1).max(200).default(10),
  maxRelationsPerPair: z.number().int().min(1).max(20).default(4),
  maxInputTokens: z.number().int().min(2_000).max(200_000).default(20_000),
  minImportance: z.number().min(0).max(1).default(0.75),
  minConfidence: z.number().min(0).max(1).default(0.8),
  includeWeakTypes: z.boolean().default(false)
}).strict();
export type SourceRelationSettings = z.infer<typeof SourceRelationSettingsSchema>;
export const defaultSourceRelationSettings = SourceRelationSettingsSchema.parse({});

export const SourceRelationEvidenceSchema = z.object({
  id: z.string().uuid(),
  origin: z.enum(["atomic_notes", "source_analysis"]),
  sourceChunkId: z.string().uuid(),
  targetChunkId: z.string().uuid(),
  sourceSpanId: z.string().uuid().nullable(),
  targetSpanId: z.string().uuid().nullable(),
  sourceExcerpt: z.string(),
  targetExcerpt: z.string(),
  sourceNoteId: z.string().uuid().nullable(),
  targetNoteId: z.string().uuid().nullable(),
  noteRelationId: z.string().uuid().nullable(),
  current: z.boolean()
}).strict();

export const SourceRelationViewSchema = z.object({
  id: z.string().uuid(),
  sourceItemId: z.string().uuid(),
  targetSourceItemId: z.string().uuid(),
  sourceTitle: z.string(),
  targetTitle: z.string(),
  relationType: AtomicNoteRelationTypeSchema,
  sourceIdea: z.string(),
  targetIdea: z.string(),
  explanation: z.string(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  status: AtomicNoteRelationStatusSchema,
  current: z.boolean(),
  evidence: z.array(SourceRelationEvidenceSchema).max(100),
  updatedAt: z.string().datetime()
}).strict();
export type SourceRelationView = z.infer<typeof SourceRelationViewSchema>;

export const SourceRelationsPageSchema = z.object({
  relations: z.array(SourceRelationViewSchema).max(100),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative()
}).strict();
export const SourceRelationReviewInputSchema = z.object({
  id: z.string().uuid(),
  status: AtomicNoteRelationStatusSchema,
  expectedUpdatedAt: z.string().datetime()
}).strict();
