import { z } from "zod";

import { conversionProgressSchema, markdownConversionResultSchema } from "./types.js";

export const DOCLING_PROTOCOL_VERSION = 3 as const;

export const doclingRequestSchema = z.object({
  protocolVersion: z.literal(DOCLING_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  command: z.literal("convert"),
  inputPath: z.string().min(1),
  profile: z.enum(["standard", "ocr"]),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  maxInputBytes: z.number().int().positive().optional(),
  options: z.record(z.string(), z.unknown()).default({})
}).strict();

export const doclingProgressSchema = conversionProgressSchema.extend({
  protocolVersion: z.literal(DOCLING_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  type: z.literal("progress")
}).strict();

export const doclingResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocolVersion: z.literal(DOCLING_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: markdownConversionResultSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(DOCLING_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1),
      messageKey: z.string().min(1),
      detail: z.string().optional(),
      recoverable: z.boolean()
    }).strict()
  }).strict()
]);

export type DoclingRequest = z.infer<typeof doclingRequestSchema>;
export type DoclingProgress = z.infer<typeof doclingProgressSchema>;
export type DoclingResponse = z.infer<typeof doclingResponseSchema>;
