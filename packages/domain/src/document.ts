import { z } from "zod";

import { LanguageCodeSchema } from "./language.js";
import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  OptionalMetadataSchema,
  Sha256Schema,
  StableIdSchema
} from "./primitives.js";
import { SourceItemTypeSchema } from "./source-item.js";

export const DocumentConversionStatusSchema = z.enum([
  "pending",
  "converted",
  "failed",
  "requires_ocr",
  "unsupported"
]);

export type DocumentConversionStatus = z.infer<
  typeof DocumentConversionStatusSchema
>;

export const DocumentSchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema,
    sourceType: SourceItemTypeSchema,
    title: NonEmptyStringSchema,
    originalUri: z.string().url().optional(),
    contentHash: Sha256Schema.optional(),
    language: LanguageCodeSchema.optional(),
    markdownContent: z.string(),
    markdownHash: Sha256Schema,
    conversionStatus: DocumentConversionStatusSchema,
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type Document = z.infer<typeof DocumentSchema>;

export const DocumentAssetRoleSchema = z.enum([
  "original",
  "converted",
  "cover",
  "thumbnail",
  "transcript",
  "attachment",
  "derived"
]);

export type DocumentAssetRole = z.infer<typeof DocumentAssetRoleSchema>;

export const StorageBaseSchema = z.enum([
  "app_internal",
  "uploaded_files",
  "obsidian_vault",
  "external"
]);

export type StorageBase = z.infer<typeof StorageBaseSchema>;

export const DocumentAssetSchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema,
    documentId: StableIdSchema.optional(),
    filePath: z.string().min(1).optional(),
    storageBase: StorageBaseSchema,
    relativePath: z.string().min(1),
    originalFileName: z.string().min(1),
    sha256: Sha256Schema,
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    role: DocumentAssetRoleSchema,
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type DocumentAsset = z.infer<typeof DocumentAssetSchema>;

export const SourceSpanSchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema,
    documentId: StableIdSchema,
    chunkId: StableIdSchema.optional(),
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
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    selector: z.string().min(1).optional(),
    createdAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((span, context) => {
    if (span.endOffset < span.startOffset) {
      context.addIssue({
        code: "custom",
        message: "endOffset must be greater than or equal to startOffset",
        path: ["endOffset"]
      });
    }
  });

export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export const ChunkSchema = z
  .object({
    id: StableIdSchema,
    sourceItemId: StableIdSchema,
    documentId: StableIdSchema,
    sourceSpanId: StableIdSchema.optional(),
    text: NonEmptyStringSchema,
    tokenCount: z.number().int().nonnegative(),
    chunkIndex: z.number().int().nonnegative(),
    language: LanguageCodeSchema.optional(),
    metadata: OptionalMetadataSchema,
    createdAt: IsoDateTimeSchema
  })
  .strict();

export type Chunk = z.infer<typeof ChunkSchema>;
