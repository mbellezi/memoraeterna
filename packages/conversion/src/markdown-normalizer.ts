import { createHash } from "node:crypto";

import type { ConversionBlock } from "./types.js";

export function normalizeMarkdown(markdown: string): string {
  const normalized = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return normalized.length === 0 ? "" : `${normalized}\n`;
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createTextBlocks(markdown: string): ConversionBlock[] {
  const blocks: ConversionBlock[] = [];
  const expression = /(?:^|\n)([^\n](?:.|\n)*?)(?=\n{2,}|$)/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = expression.exec(markdown)) !== null) {
    const text = match[1]?.trim() ?? "";
    if (!text) continue;
    const markdownStart = markdown.indexOf(text, match.index);
    blocks.push({
      id: `block-${index}`,
      type: text.startsWith("#") ? "heading" : "paragraph",
      text,
      markdownStart,
      markdownEnd: markdownStart + text.length
    });
    index += 1;
  }
  return blocks;
}
