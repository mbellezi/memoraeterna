import { z } from "zod";

import { LanguageCodeSchema } from "./language.js";
import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  OptionalMetadataSchema,
  Sha256Schema,
  StableIdSchema
} from "./primitives.js";

export const SourceItemTypes = [
  "PersonalNote",
  "DailyNote",
  "WebArticle",
  "Book",
  "BookChapter",
  "PeriodicalIssue",
  "AcademicPaper",
  "DocumentSection",
  "StandaloneArticle",
  "Video",
  "GenericDocument"
] as const;

export const SourceItemTypeSchema = z.enum(SourceItemTypes);

export type SourceItemType = z.infer<typeof SourceItemTypeSchema>;

export const SourceOriginSchema = z.enum([
  "manual",
  "file_upload",
  "web_capture",
  "obsidian",
  "youtube",
  "transcript",
  "ocr",
  "api_import"
]);

export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

export const SourceItemSchema = z
  .object({
    id: StableIdSchema,
    type: SourceItemTypeSchema,
    title: NonEmptyStringSchema,
    subtitle: NonEmptyStringSchema.optional(),
    sourceOrigin: SourceOriginSchema,
    originalUri: z.string().url().optional(),
    contentHash: Sha256Schema.optional(),
    language: LanguageCodeSchema.optional(),
    summary: z.string().optional(),
    summaryGeneratedAt: IsoDateTimeSchema.optional(),
    bibliographicWorkId: StableIdSchema.optional(),
    bibliographicInstanceId: StableIdSchema.optional(),
    parentSourceItemId: StableIdSchema.optional(),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type SourceItem = z.infer<typeof SourceItemSchema>;
