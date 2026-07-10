import { z } from "zod";

import { markdownConversionResultSchema } from "./types.js";

export const doclingRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  command: z.literal("convert"),
  inputPath: z.string().min(1),
  profile: z.enum(["standard", "ocr"]),
  options: z.record(z.string(), z.unknown()).default({})
}).strict();

export const doclingResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: markdownConversionResultSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
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
export type DoclingResponse = z.infer<typeof doclingResponseSchema>;
