import { z } from "zod";

export const conversionProfileSchema = z.enum(["standard", "ocr"]);
export type ConversionProfile = z.infer<typeof conversionProfileSchema>;

export const conversionProgressStageSchema = z.enum([
  "loading_engine",
  "converting_document",
  "processing_pages",
  "serializing"
]);

export const conversionProgressSchema = z.object({
  stage: conversionProgressStageSchema,
  progress: z.number().min(0).max(1),
  completedPages: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().positive().optional()
}).strict().superRefine((event, context) => {
  if (event.completedPages !== undefined && event.totalPages !== undefined
      && event.completedPages > event.totalPages) {
    context.addIssue({
      code: "custom",
      message: "Completed pages cannot exceed total pages.",
      path: ["completedPages"]
    });
  }
});

export type ConversionProgress = z.infer<typeof conversionProgressSchema>;
export type ConversionProgressListener = (event: ConversionProgress) => void;

export const boundingBoxSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number()
}).strict();

export const conversionBlockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  text: z.string(),
  page: z.number().int().positive().optional(),
  boundingBox: boundingBoxSchema.optional(),
  sourceCharspan: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  markdownStart: z.number().int().nonnegative(),
  markdownEnd: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  parentRef: z.string().optional(),
  childrenRefs: z.array(z.string()).optional(),
  readingOrder: z.number().int().nonnegative().optional()
}).strict();

export const doclingStructureSchema = z.object({
  body: z.array(z.record(z.string(), z.unknown())).default([]),
  groups: z.array(z.record(z.string(), z.unknown())).default([]),
  pageCount: z.number().int().nonnegative().optional()
}).strict();

export const convertedAssetSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
  role: z.enum(["image", "attachment", "derived"])
}).strict();

export const conversionWarningSchema = z.object({
  code: z.string().min(1),
  messageKey: z.string().min(1),
  detail: z.string().optional(),
  recoverable: z.boolean().default(true)
}).strict();

export const markdownConversionResultSchema = z.object({
  status: z.enum(["converted", "requires_ocr"]),
  markdown: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  blocks: z.array(conversionBlockSchema).default([]),
  assets: z.array(convertedAssetSchema).default([]),
  engine: z.string().min(1),
  engineVersion: z.string().min(1),
  profile: conversionProfileSchema,
  options: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(conversionWarningSchema).default([]),
  quality: z.object({
    confidence: z.number().min(0).max(1).optional(),
    textCoverage: z.number().min(0).max(1).optional()
  }).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  documentStructure: doclingStructureSchema.optional(),
  rawStructuredResult: z.unknown().optional()
}).strict();

export type ConversionBlock = z.infer<typeof conversionBlockSchema>;
export type ConversionWarning = z.infer<typeof conversionWarningSchema>;
export type MarkdownConversionResult = z.infer<typeof markdownConversionResultSchema>;

export interface ConversionInput {
  data: Uint8Array;
  sourcePath?: string;
  fileName?: string;
  mimeType?: string;
  sourceUrl?: string;
  profile?: ConversionProfile;
  privacyMode?: "offline" | "allow_remote";
  quality?: "fast" | "balanced" | "high";
}

export interface Converter {
  convert(
    input: ConversionInput,
    signal?: AbortSignal,
    onProgress?: ConversionProgressListener
  ): Promise<MarkdownConversionResult>;
}
