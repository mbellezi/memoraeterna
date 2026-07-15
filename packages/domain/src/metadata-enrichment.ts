import { z } from "zod";

import { CreatorSchema, SourceDescriptorProvenanceSchema } from "./source-descriptor.js";
import { SourceItemTypeSchema } from "./source-item.js";

export const MetadataEnrichmentProviderSchema = z.enum(["open-library", "google-books", "crossref"]);

export const MetadataEnrichmentQuerySchema = z.object({
  sourceType: SourceItemTypeSchema,
  isbn: z.string().trim().min(1).optional(),
  doi: z.string().trim().min(1).optional(),
  title: z.string().trim().min(2).max(1000).optional(),
  author: z.string().trim().min(2).max(500).optional()
}).strict().refine((query) => query.isbn !== undefined || query.doi !== undefined || query.title !== undefined, {
  message: "ISBN, DOI or title is required."
});

export const EnrichmentCandidateSchema = z.object({
  id: z.string().min(1),
  provider: MetadataEnrichmentProviderSchema,
  title: z.string().trim().min(1),
  creators: z.array(CreatorSchema).default([]),
  edition: z.string().trim().min(1).optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  coverUrl: z.string().url().optional(),
  coverPreviewDataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i).optional(),
  values: z.record(z.string(), z.unknown()).default({}),
  provenance: SourceDescriptorProvenanceSchema
}).strict();

export type MetadataEnrichmentQuery = z.infer<typeof MetadataEnrichmentQuerySchema>;
export type EnrichmentCandidate = z.infer<typeof EnrichmentCandidateSchema>;
