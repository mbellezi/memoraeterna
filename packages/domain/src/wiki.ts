import { SourceItemTypeSchema } from "./source-item.js";
import { z } from "zod";

/**
 * The source search behind the scope pickers (Ask and Obsidian): the sources a person may limit a
 * request to, found by title, subtitle, URI or metadata. The legacy wiki pages it once listed are
 * gone, and so is every other result kind.
 */
export const WikiQuerySchema = z
  .object({
    text: z.string().max(1000).default(""),
    sourceIds: z.array(z.string().uuid()).max(100).default([]),
    includeDescendants: z.boolean().default(true),
    kind: z.literal("source").default("source"),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(1_000_000).default(0)
  })
  .strict();
export const WikiResultSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("source"),
  title: z.string(),
  excerpt: z.string(),
  sourceItemId: z.string().uuid(),
  sourceType: SourceItemTypeSchema,
  catalogOnly: z.boolean(),
  breadcrumb: z.string(),
  exact: z.boolean()
});
export const WikiResultsSchema = z.object({
  items: z.array(WikiResultSchema),
  hasMore: z.boolean()
});
export type WikiQuery = z.infer<typeof WikiQuerySchema>;
export type WikiResult = z.infer<typeof WikiResultSchema>;
