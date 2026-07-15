import { z } from "zod";

import { SourceItemTypeSchema } from "./source-item.js";
import { StableIdSchema } from "./primitives.js";

export const SearchModeSchema = z.enum(["text", "vector", "hybrid"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const SearchQuerySchema = z
  .object({
    text: z.string().trim().min(1),
    mode: SearchModeSchema.default("hybrid"),
    sourceTypes: z.array(SourceItemTypeSchema).default([]),
    limit: z.number().int().min(1).max(100).default(20),
    embedding: z.array(z.number().finite()).optional()
  })
  .strict();

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchEvidenceSchema = z
  .object({
    sourceItemId: StableIdSchema,
    sourceTitle: z.string().min(1),
    sourceType: SourceItemTypeSchema,
    breadcrumbs: z.array(z.object({ id: StableIdSchema, title: z.string().min(1) }).strict()).default([]),
    documentId: StableIdSchema,
    chunkId: StableIdSchema,
    sourceSpanId: StableIdSchema.optional(),
    excerpt: z.string(),
    page: z.number().int().positive().optional(),
    sourceBlockId: z.string().min(1).optional(),
    boundingBox: z
      .object({
        left: z.number(),
        top: z.number(),
        right: z.number(),
        bottom: z.number()
      })
      .strict()
      .optional(),
    selector: z.string().optional(),
    textScore: z.number().min(0).max(1),
    vectorScore: z.number().min(0).max(1),
    graphScore: z.number().min(0).max(1),
    finalScore: z.number().min(0).max(1)
  })
  .strict();

export type SearchEvidence = z.infer<typeof SearchEvidenceSchema>;
