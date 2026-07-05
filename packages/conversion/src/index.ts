import { createHash } from "node:crypto";

import { z } from "zod";

export const conversionWarningSchema = z.object({
  code: z.string().min(1),
  messageKey: z.string().min(1),
  detail: z.string().optional()
});
export type ConversionWarning = z.infer<typeof conversionWarningSchema>;

export const markdownConversionResultSchema = z.object({
  markdown: z.string(),
  contentHash: z.string().min(64),
  engine: z.string().min(1),
  engineVersion: z.string().min(1),
  warnings: z.array(conversionWarningSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type MarkdownConversionResult = z.infer<typeof markdownConversionResultSchema>;

export function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().concat("\n");
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
