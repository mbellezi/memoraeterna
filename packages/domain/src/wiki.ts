import { WikiAutomaticContentSchema, SectionAssessmentSchema } from './automatic-wiki.js';
import { SourceItemTypeSchema } from "./source-item.js";
import { z } from "zod";

export const WikiPageKindSchema = z.enum(["topic", "entity", "collection", "synthesis"]);
export const WikiSectionSchema = z.object({
  sectionRevisionId:z.string().uuid().optional(), assessment:SectionAssessmentSchema.optional(),
  id: z.string().uuid(), title: z.string().trim().max(300),
  kind: z.enum(["prose", "question", "comparison"]).default("prose"),
  markdown: z.string().max(100_000),
  provenance: z.enum(["personal", "attributed", "generated"]).default("personal"),
  protected: z.boolean().default(true),
  evidenceReview: z.enum(["verified", "needs_review"]).default("verified"),
  evidenceIds: z.array(z.string().uuid()).max(100).default([])
}).strict();
export const WikiEvidenceSchema = z.object({
  id: z.string().uuid(), sourceItemId: z.string().uuid(), documentId: z.string().uuid(),
  chunkId: z.string().uuid(), sourceSpanId: z.string().uuid().nullable(),
  contentHash: z.string(), excerpt: z.string(), sourceTitle: z.string(),
  documentCreatedAt: z.string(), locator: z.string().nullable(), current: z.boolean()
}).strict();
export const WikiPageContentSchema = z.object({
  automatic:WikiAutomaticContentSchema.optional(),
  title: z.string().trim().min(1).max(300), kind: WikiPageKindSchema,
  aliases: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  parentId: z.string().uuid().nullable().default(null),
  position: z.number().int().min(0).max(1_000_000).default(0),
  collectionIds: z.array(z.string().uuid()).max(100).default([]),
  entityId: z.string().uuid().nullable().default(null),
  pinned: z.boolean().default(false), archived: z.boolean().default(false),
  review: z.enum(["draft", "reviewed"]).default("draft"),
  sections: z.array(WikiSectionSchema).max(100).default([])
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sections.map((s) => s.id)).size !== value.sections.length)
    ctx.addIssue({ code: "custom", message: "Duplicate section identity", path: ["sections"] });
});
export const WikiPageSchema = WikiPageContentSchema.safeExtend({
  id: z.string().uuid(), revisionId: z.string().uuid(), revisionNumber: z.number().int(),
  updatedAt: z.string(), evidence: z.array(WikiEvidenceSchema),
  impacts: z.array(z.object({id:z.string().uuid(),sectionId:z.string().uuid(),kind:z.string(),inputId:z.string().uuid(),reason:z.string(),changedAt:z.string()})).default([]),
  breadcrumbs: z.array(z.object({ id: z.string().uuid(), title: z.string() }))
});
export const WikiSaveInputSchema = z.object({
  version:z.literal(2).optional(),
  id: z.string().uuid().optional(), expectedRevisionId: z.string().uuid().nullable(),
  content: WikiPageContentSchema, evidenceChunkIds: z.array(z.string().uuid()).max(500).default([])
}).strict();
export const WikiQuerySchema = z.object({
  text: z.string().max(1000).default(""),
  sourceIds: z.array(z.string().uuid()).max(100).default([]),
  includeDescendants: z.boolean().default(true), pageId: z.string().uuid().nullable().default(null),
  kind: z.enum(["all", "page", "source", "chunk", "atomic_note", "entity", "entity_relation", "source_relation"]).default("all"),
  reviewedOnly: z.boolean().default(false), currentOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).max(1_000_000).default(0)
}).strict();
export const WikiResultSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["page", "source", "chunk", "atomic_note", "entity", "entity_relation", "source_relation"]),
  title: z.string(), excerpt: z.string(), sourceItemId: z.string().uuid().nullable(),
  targetSourceItemId: z.string().uuid().nullable().default(null), review: z.string().nullable(), current: z.boolean(),
  sourceType: SourceItemTypeSchema.nullable().default(null), catalogOnly: z.boolean().default(false),
  breadcrumb: z.string(), exact: z.boolean()
});
export const WikiResultsSchema = z.object({ items: z.array(WikiResultSchema), hasMore: z.boolean() });
export const WikiPageListSchema = z.array(z.object(WikiPageSchema.shape).omit({ evidence: true, breadcrumbs: true, sections: true }));
export const WikiHistorySchema = z.array(z.object({
  id: z.string().uuid(), number: z.number().int(), createdAt: z.string(), origin: z.string(), content: WikiPageContentSchema
}));
export type WikiPage = z.infer<typeof WikiPageSchema>;
export type WikiPageContent = z.infer<typeof WikiPageContentSchema>;
export type WikiSaveInput = z.infer<typeof WikiSaveInputSchema>;
export type WikiQuery = z.infer<typeof WikiQuerySchema>;
export type WikiResult = z.infer<typeof WikiResultSchema>;
export type WikiEvidence = z.infer<typeof WikiEvidenceSchema>;
export const WikiLinkedTargetInputSchema=z.object({pageId:z.string().uuid(),kind:z.enum(['page','source','atomic_note','entity']),id:z.string().uuid()}).strict();
export const WikiLinkedTargetSchema=z.object({kind:z.enum(['page','source','atomic_note','entity']),id:z.string().uuid(),title:z.string(),markdown:z.string(),sourceItemId:z.string().uuid().nullable(),evidence:z.array(WikiEvidenceSchema)}).strict();
