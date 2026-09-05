import { z } from "zod";

import { SourceItemTypeSchema } from "./source-item.js";
import { GraphEntityTypeSchema } from "./graph.js";
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

export const ChunkSearchResultSchema = SearchEvidenceSchema.extend({
  kind: z.literal("chunk")
}).strict();

export type ChunkSearchResult = z.infer<typeof ChunkSearchResultSchema>;

export const AtomicNoteSearchResultSchema = z
  .object({
    kind: z.literal("atomic_note"),
    noteId: StableIdSchema,
    sourceItemId: StableIdSchema,
    sourceTitle: z.string().min(1),
    sourceType: SourceItemTypeSchema,
    breadcrumbs: z.array(z.object({ id: StableIdSchema, title: z.string().min(1) }).strict()).default([]),
    title: z.string().min(1),
    ideaStatement: z.string().min(1),
    excerpt: z.string(),
    status: z.enum(["pending_review", "approved", "archived"]),
    textScore: z.number().min(0).max(1),
    vectorScore: z.number().min(0).max(1),
    graphScore: z.number().min(0).max(1),
    finalScore: z.number().min(0).max(1)
  })
  .strict();

export type AtomicNoteSearchResult = z.infer<typeof AtomicNoteSearchResultSchema>;

const GraphSearchContextSchema = z.object({
  sourceItemId: StableIdSchema,
  sourceTitle: z.string().min(1),
  sourceType: SourceItemTypeSchema,
  breadcrumbs: z.array(z.object({ id: StableIdSchema, title: z.string().min(1) }).strict()).default([]),
  excerpt: z.string(),
  graphScore: z.number().min(0).max(1),
  finalScore: z.number().min(0).max(1)
});

export const GraphEntitySearchResultSchema = GraphSearchContextSchema.extend({
  kind: z.literal("entity"),
  entityId: StableIdSchema,
  entityType: GraphEntityTypeSchema,
  canonicalName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  description: z.string().nullable()
}).strict();

export const GraphRelationSearchResultSchema = GraphSearchContextSchema.extend({
  kind: z.literal("relation"),
  relationId: StableIdSchema,
  subjectEntityId: StableIdSchema,
  subjectName: z.string().min(1),
  predicate: z.string().min(1),
  objectEntityId: StableIdSchema,
  objectName: z.string().min(1)
}).strict();

export const SearchResultSchema = z.discriminatedUnion("kind", [
  ChunkSearchResultSchema,
  AtomicNoteSearchResultSchema,
  GraphEntitySearchResultSchema,
  GraphRelationSearchResultSchema
]);

export type SearchResultItem = z.infer<typeof SearchResultSchema>;
