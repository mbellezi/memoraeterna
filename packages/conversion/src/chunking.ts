import { randomUUID } from "node:crypto";

import { sha256 } from "./markdown-normalizer.js";
import type { ConversionBlock } from "./types.js";

export interface MarkdownChunk {
  id: string;
  sourceSpanId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  contentHash: string;
  startOffset: number;
  endOffset: number;
  page?: number;
  sourceBlockId?: string;
  boundingBox?: ConversionBlock["boundingBox"];
  selector?: string;
}

export interface ChunkMarkdownOptions {
  targetCharacters?: number;
  maxCharacters?: number;
}

export function chunkMarkdown(
  markdown: string,
  blocks: ConversionBlock[] = [],
  options: ChunkMarkdownOptions = {}
): MarkdownChunk[] {
  const target = options.targetCharacters ?? 1_600;
  const maximum = options.maxCharacters ?? 2_400;
  const sections = splitSections(markdown, maximum);
  const chunks: MarkdownChunk[] = [];
  let pending: typeof sections = [];
  let size = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const startOffset = pending[0]?.start ?? 0;
    const endOffset = pending.at(-1)?.end ?? startOffset;
    const content = markdown.slice(startOffset, endOffset).trim();
    if (!content) return;
    const sourceBlock = blocks.find((block) => block.markdownStart <= startOffset && block.markdownEnd >= startOffset);
    chunks.push({
      id: randomUUID(),
      sourceSpanId: randomUUID(),
      chunkIndex: chunks.length,
      content,
      tokenCount: Math.ceil(content.length / 4),
      contentHash: sha256(content),
      startOffset,
      endOffset,
      ...(sourceBlock?.page ? { page: sourceBlock.page } : {}),
      ...(sourceBlock ? { sourceBlockId: sourceBlock.id, selector: `/blocks/${blocks.indexOf(sourceBlock)}` } : {}),
      ...(sourceBlock?.boundingBox ? { boundingBox: sourceBlock.boundingBox } : {})
    });
    pending = [];
    size = 0;
  };
  for (const section of sections) {
    if (size > 0 && size + section.text.length > target) flush();
    pending.push(section);
    size += section.text.length;
  }
  flush();
  return chunks;
}

function splitSections(markdown: string, maximum: number): Array<{ text: string; start: number; end: number }> {
  const parts: Array<{ text: string; start: number; end: number }> = [];
  const boundary = /(?=^#{1,6}\s)|\n{2,}/gm;
  let start = 0;
  for (const match of markdown.matchAll(boundary)) {
    const index = match.index;
    if (index > start) addSizedPart(markdown, start, index, maximum, parts);
    start = index;
  }
  if (start < markdown.length) addSizedPart(markdown, start, markdown.length, maximum, parts);
  return parts;
}

function addSizedPart(
  markdown: string,
  start: number,
  end: number,
  maximum: number,
  output: Array<{ text: string; start: number; end: number }>
): void {
  let cursor = start;
  while (cursor < end) {
    const candidateEnd = Math.min(end, cursor + maximum);
    const splitAt = candidateEnd < end ? Math.max(cursor + 1, markdown.lastIndexOf(" ", candidateEnd)) : candidateEnd;
    output.push({ text: markdown.slice(cursor, splitAt), start: cursor, end: splitAt });
    cursor = splitAt;
  }
}
