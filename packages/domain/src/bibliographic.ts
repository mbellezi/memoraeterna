import { z } from "zod";

import { LanguageCodeSchema } from "./language.js";
import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  OptionalMetadataSchema,
  StableIdSchema
} from "./primitives.js";

export const BibliographicWorkTypeSchema = z.enum([
  "book",
  "chapter",
  "article",
  "web_page",
  "video",
  "publication",
  "generic_work"
]);

export type BibliographicWorkType = z.infer<
  typeof BibliographicWorkTypeSchema
>;

export const BibliographicWorkSchema = z
  .object({
    id: StableIdSchema,
    type: BibliographicWorkTypeSchema,
    title: NonEmptyStringSchema,
    subtitle: NonEmptyStringSchema.optional(),
    canonicalTitle: NonEmptyStringSchema.optional(),
    language: LanguageCodeSchema.optional(),
    identifiers: z.record(z.string(), z.string()).default({}),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type BibliographicWork = z.infer<typeof BibliographicWorkSchema>;

export const BibliographicInstanceTypeSchema = z.enum([
  "edition",
  "chapter",
  "volume",
  "issue",
  "file",
  "web_page",
  "video",
  "generic_instance"
]);

export type BibliographicInstanceType = z.infer<
  typeof BibliographicInstanceTypeSchema
>;

export const BibliographicInstanceSchema = z
  .object({
    id: StableIdSchema,
    workId: StableIdSchema,
    type: BibliographicInstanceTypeSchema,
    edition: z.string().min(1).optional(),
    volume: z.string().min(1).optional(),
    issue: z.string().min(1).optional(),
    publicationDate: z.string().min(1).optional(),
    publisher: z.string().min(1).optional(),
    isbn: z.string().min(1).optional(),
    issn: z.string().min(1).optional(),
    doi: z.string().min(1).optional(),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type BibliographicInstance = z.infer<
  typeof BibliographicInstanceSchema
>;
